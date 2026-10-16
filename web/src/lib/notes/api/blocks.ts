// Server-only: BlockNote blocks ↔ Notion block objects.
//
// Our page body is BlockNote JSON; Notion's API speaks blocks with a `type`
// and a same-named payload. Sub-pages and databases are blocks of their
// parent page (child_page / child_database share the page's id). Blocks have
// no timestamps of their own: they carry their page's.

import { randomUUID } from "node:crypto";
import { safeUrl, sanitizeBlocks } from "../model";
import { NOTE_COLORS, type Note } from "../types";
import { fromRichText, InputError, noteIdOf, toRichText, type Lookup, type RichText } from "./richtext";
import { toUuid, type RawBlock } from "./space";

export interface BlockContext extends Lookup {
  /** The page whose body is being read (child_page vs link_to_page). */
  pageId: string;
  /** Absolute URL of our own files ("/api/notes/file/…" → https://…). */
  absolute(url: string): string;
  /** A note by id (synced block content, child pages' content). */
  note(id: string): Note | null;
  /** Who created / edited the page (for created_by / last_edited_by). */
  user(id: string | undefined): { object: "user"; id: string };
}

export interface NotionBlock {
  object: "block";
  id: string;
  parent: { type: "page_id"; page_id: string } | { type: "block_id"; block_id: string } | { type: "database_id"; database_id: string };
  created_time: string;
  last_edited_time: string;
  created_by: { object: "user"; id: string };
  last_edited_by: { object: "user"; id: string };
  has_children: boolean;
  archived: boolean;
  in_trash: boolean;
  type: string;
  [payload: string]: unknown;
}

const COLORS = new Set<string>(NOTE_COLORS);

function colorOf(props: Record<string, unknown> | undefined, bgKey = "backgroundColor"): string {
  const p = props ?? {};
  const text = typeof p.textColor === "string" && COLORS.has(p.textColor) && p.textColor !== "default" ? p.textColor : "";
  const bg = typeof p[bgKey] === "string" && COLORS.has(p[bgKey] as string) && p[bgKey] !== "default" ? (p[bgKey] as string) : "";
  return bg ? `${bg}_background` : text || "default";
}

function propsOfColor(color: unknown): Record<string, string> {
  if (typeof color !== "string" || color === "default") return {};
  const bg = /^([a-z]+)_background$/.exec(color);
  if (bg && COLORS.has(bg[1])) return { backgroundColor: bg[1] };
  return COLORS.has(color) ? { textColor: color } : {};
}

const LANG_OUT: Record<string, string> = { text: "plain text", js: "javascript", ts: "typescript", sh: "shell", bash: "bash", py: "python", md: "markdown", yml: "yaml", "c++": "c++", cs: "c#" };
const LANG_IN: Record<string, string> = { "plain text": "text", javascript: "javascript", typescript: "typescript", shell: "shell", "c#": "csharp" };

function fileObject(url: string, ctx: BlockContext, caption: RichText[] = [], name?: string): Record<string, unknown> {
  const own = url.startsWith("/");
  const abs = own ? ctx.absolute(url) : url;
  return { caption, type: own ? "file" : "external", ...(own ? { file: { url: abs, expiry_time: null } } : { external: { url: abs } }), ...(name ? { name } : {}) };
}

function plainOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : plainOf((x as { content?: unknown })?.content))).join("");
}

interface Shaped {
  type: string;
  payload: Record<string, unknown>;
  children: RawBlock[];
  /** Children are another page's blocks (synced) — listed but not part of this page. */
  childrenOf?: string;
  id?: string;
}

/** The Notion type and payload of one of our blocks. */
function shape(b: RawBlock, ctx: BlockContext): Shaped {
  const p = b.props ?? {};
  const rich = () => toRichText(b.content, ctx);
  const kids = Array.isArray(b.children) ? b.children : [];
  switch (b.type) {
    case "paragraph":
      return { type: "paragraph", payload: { rich_text: rich(), color: colorOf(p) }, children: kids };
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(p.level) || 1));
      return { type: `heading_${level}`, payload: { rich_text: rich(), color: colorOf(p), is_toggleable: p.isToggleable === true }, children: kids };
    }
    case "bulletListItem":
      return { type: "bulleted_list_item", payload: { rich_text: rich(), color: colorOf(p) }, children: kids };
    case "numberedListItem":
      return { type: "numbered_list_item", payload: { rich_text: rich(), color: colorOf(p) }, children: kids };
    case "checkListItem":
      return { type: "to_do", payload: { rich_text: rich(), checked: p.checked === true, color: colorOf(p) }, children: kids };
    case "toggleListItem":
      return { type: "toggle", payload: { rich_text: rich(), color: colorOf(p) }, children: kids };
    case "quote":
      return { type: "quote", payload: { rich_text: rich(), color: colorOf(p) }, children: kids };
    case "callout": {
      const icon = typeof p.icon === "string" && p.icon && !p.icon.startsWith("icon:") && !p.icon.startsWith("/") ? { type: "emoji", emoji: p.icon } : null;
      return { type: "callout", payload: { rich_text: rich(), icon, color: colorOf(p, "color") }, children: kids };
    }
    case "codeBlock": {
      const lang = String(p.language || "text");
      return { type: "code", payload: { rich_text: toRichText([{ type: "text", text: plainOf(b.content), styles: {} }], ctx), caption: [], language: LANG_OUT[lang] ?? lang }, children: [] };
    }
    case "mermaid":
      return { type: "code", payload: { rich_text: toRichText([{ type: "text", text: String(p.code ?? ""), styles: {} }], ctx), caption: [], language: "mermaid" }, children: [] };
    case "divider":
      return { type: "divider", payload: {}, children: [] };
    case "equation":
      return { type: "equation", payload: { expression: String(p.latex ?? "") }, children: [] };
    case "image":
    case "video":
    case "audio":
    case "file":
    case "pdf": {
      const url = String(p.url ?? "");
      const caption = toRichText(typeof p.caption === "string" && p.caption ? [{ type: "text", text: p.caption, styles: {} }] : [], ctx);
      const isPdf = b.type === "pdf" || (b.type === "file" && /\.pdf($|[?#])/i.test(url));
      const type = isPdf ? "pdf" : b.type === "file" ? "file" : (b.type as string);
      return { type, payload: url ? fileObject(url, ctx, caption, type === "file" && typeof p.name === "string" && p.name ? p.name : undefined) : { caption, type: "external", external: { url: "" } }, children: [] };
    }
    case "bookmark":
      return { type: "bookmark", payload: { caption: [], url: String(p.url ?? "") }, children: [] };
    case "embed":
      return { type: "embed", payload: { caption: [], url: String(p.url ?? "") }, children: [] };
    case "table": {
      const t = (b.content ?? {}) as { rows?: { cells?: unknown[] }[]; headerRows?: number; headerCols?: number };
      const rows = Array.isArray(t.rows) ? t.rows : [];
      const width = Math.max(0, ...rows.map((r) => (Array.isArray(r.cells) ? r.cells.length : 0)));
      const rowBlocks: RawBlock[] = rows.map((r, i) => ({ id: `${b.id ?? "table"}-row-${i}`, type: "__table_row", content: r.cells ?? [] }));
      return { type: "table", payload: { table_width: width, has_column_header: Number(t.headerRows ?? 0) > 0, has_row_header: Number(t.headerCols ?? 0) > 0 }, children: rowBlocks };
    }
    case "__table_row": {
      const cells = (Array.isArray(b.content) ? b.content : []).map((c) => toRichText(typeof c === "object" && c !== null && "content" in (c as object) ? (c as { content: unknown }).content : c, ctx));
      return { type: "table_row", payload: { cells }, children: [] };
    }
    case "columnList":
    // Notion's API has no tabs: a Tabs block reads as columns, one per tab, so its content is all there.
    case "tabs":
      return { type: "column_list", payload: {}, children: kids };
    case "tab":
      return { type: "column", payload: {}, children: kids };
    case "column":
      return { type: "column", payload: { ...(typeof p.width === "number" && p.width !== 1 ? { width_ratio: p.width } : {}) }, children: kids };
    case "page":
    case "database": {
      const id = String(p.noteId ?? "");
      const n = ctx.note(id);
      const title = n ? n.title : null;
      if (!n || title === null) return { type: "unsupported", payload: {}, children: [] };
      if (n.parentId !== ctx.pageId) return { type: "link_to_page", payload: n.kind === "database" ? { type: "database_id", database_id: toUuid(n.id) } : { type: "page_id", page_id: toUuid(n.id) }, children: [] };
      return { type: n.kind === "database" ? "child_database" : "child_page", payload: { title }, children: [], id: n.id };
    }
    case "synced": {
      const src = ctx.note(String(p.noteId ?? ""));
      return { type: "synced_block", payload: { synced_from: src ? { type: "block_id", block_id: toUuid(src.id) } : null }, children: src && Array.isArray(src.content) ? (src.content as RawBlock[]) : [], childrenOf: src?.id };
    }
    case "toc":
      return { type: "table_of_contents", payload: { color: "default" }, children: [] };
    case "breadcrumb":
      return { type: "breadcrumb", payload: {}, children: [] };
    default:
      return { type: "unsupported", payload: {}, children: [] };
  }
}

/**
 * A page's blocks as the API reads them: what the page says, not what is
 * suggested — suggested blocks and inserted text left out, text suggested
 * for removal kept (without its mark), discussion marks dropped. Writes go
 * to the stored blocks; only what is read is this.
 */
export function readableBlocks(blocks: unknown): RawBlock[] {
  return sanitizeBlocks(blocks) as RawBlock[];
}

/** One of our blocks as a Notion block object. */
export function toNotionBlock(raw: RawBlock, page: Note, parentBlockId: string | null, ctx: BlockContext): NotionBlock {
  const b = (readableBlocks([raw])[0] as RawBlock | undefined) ?? { ...raw, content: [], children: [] };
  const s = shape(b, ctx);
  const id = toUuid(s.id ?? String(b.id ?? ""));
  let hasChildren = s.children.length > 0;
  if (s.type === "child_page" || s.type === "child_database") {
    const child = s.id ? ctx.note(s.id) : null;
    hasChildren = s.type === "child_page" ? Boolean(child?.content.length) : false;
  }
  return {
    object: "block",
    id,
    parent: parentBlockId ? { type: "block_id", block_id: toUuid(parentBlockId) } : { type: "page_id", page_id: toUuid(page.id) },
    created_time: new Date(page.createdAt).toISOString(),
    last_edited_time: new Date(page.updatedAt).toISOString(),
    created_by: ctx.user(page.createdBy),
    last_edited_by: ctx.user(page.editedBy ?? page.createdBy),
    has_children: hasChildren,
    archived: false,
    in_trash: false,
    type: s.type,
    [s.type]: s.payload,
  };
}

/** The blocks under a block (a table's rows, a list item's nested items, a synced block's content). */
export function childBlocks(b: RawBlock, ctx: BlockContext): { blocks: RawBlock[]; page: Note | null } {
  const s = shape(b, ctx);
  return { blocks: readableBlocks(s.children), page: s.childrenOf ? ctx.note(s.childrenOf) : null };
}

// ---------------------------------------------------------------------------
// From requests

/** Notion's limits for one request: 100 blocks a level, 2 levels of nesting. */
const MAX_BLOCKS = 100;
const MAX_DEPTH = 2;

function text(payload: Record<string, unknown>): unknown[] {
  return fromRichText(payload.rich_text);
}

function urlOf(payload: Record<string, unknown>, type: string): string {
  const ext = payload.external as Record<string, unknown> | undefined;
  const url = typeof ext?.url === "string" ? ext.url : typeof payload.url === "string" ? payload.url : "";
  if (!url || !/^https:\/\//i.test(url) || !safeUrl(url)) throw new InputError(`${type}: an https external url is required`);
  return url.slice(0, 2000);
}

/**
 * Block objects from a request → new BlockNote blocks (fresh ids). Sub-pages
 * and databases are created with POST /pages and /databases, not here.
 * `canLink` says whether a page may be linked (link_to_page, mentions).
 */
export function fromNotionBlocks(v: unknown, canLink: (noteId: string) => boolean, depth = 0): RawBlock[] {
  if (!Array.isArray(v)) throw new InputError("children should be an array of blocks");
  if (v.length > MAX_BLOCKS) throw new InputError(`at most ${MAX_BLOCKS} blocks per request`);
  const out: RawBlock[] = [];
  for (const raw of v) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const type = typeof r.type === "string" ? r.type : Object.keys(r).find((k) => k !== "object" && typeof r[k] === "object") ?? "";
    const payload = (typeof r[type] === "object" && r[type] !== null ? r[type] : {}) as Record<string, unknown>;
    const nested = () => {
      if (payload.children === undefined) return [];
      if (depth + 1 >= MAX_DEPTH) throw new InputError("blocks may be nested 2 levels deep in one request");
      return fromNotionBlocks(payload.children, canLink, depth + 1);
    };
    const id = randomUUID();
    const colored = (props: Record<string, unknown> = {}) => ({ ...props, ...propsOfColor(payload.color) });
    let block: RawBlock;
    switch (type) {
      case "paragraph":
        block = { id, type: "paragraph", props: colored(), content: text(payload), children: nested() };
        break;
      case "heading_1":
      case "heading_2":
      case "heading_3":
        block = { id, type: "heading", props: colored({ level: Number(type.slice(-1)), isToggleable: payload.is_toggleable === true }), content: text(payload), children: payload.is_toggleable === true ? nested() : [] };
        break;
      case "bulleted_list_item":
        block = { id, type: "bulletListItem", props: colored(), content: text(payload), children: nested() };
        break;
      case "numbered_list_item":
        block = { id, type: "numberedListItem", props: colored(), content: text(payload), children: nested() };
        break;
      case "to_do":
        block = { id, type: "checkListItem", props: colored({ checked: payload.checked === true }), content: text(payload), children: nested() };
        break;
      case "toggle":
        block = { id, type: "toggleListItem", props: colored(), content: text(payload), children: nested() };
        break;
      case "quote":
        block = { id, type: "quote", props: colored(), content: text(payload), children: nested() };
        break;
      case "callout": {
        const icon = payload.icon as Record<string, unknown> | undefined;
        const emoji = typeof icon?.emoji === "string" ? icon.emoji.slice(0, 16) : "💡";
        const bg = typeof payload.color === "string" ? /^([a-z]+)_background$/.exec(payload.color)?.[1] : undefined;
        block = { id, type: "callout", props: { icon: emoji, color: bg && COLORS.has(bg) ? bg : "default" }, content: text(payload), children: nested() };
        break;
      }
      case "code": {
        const lang = typeof payload.language === "string" ? payload.language.toLowerCase().slice(0, 40) : "plain text";
        const code = (fromRichText(payload.rich_text) as { type?: string; text?: string; content?: { text?: string }[] }[]).map((n) => n.text ?? n.content?.map((c) => c.text ?? "").join("") ?? "").join("");
        block = lang === "mermaid" ? { id, type: "mermaid", props: { code } } : { id, type: "codeBlock", props: { language: LANG_IN[lang] ?? lang }, content: code ? [{ type: "text", text: code, styles: {} }] : [] };
        break;
      }
      case "divider":
        block = { id, type: "divider", props: {} };
        break;
      case "equation":
        block = { id, type: "equation", props: { latex: typeof payload.expression === "string" ? payload.expression.slice(0, 4000) : "" } };
        break;
      case "image":
      case "video":
      case "audio":
      case "file":
      case "pdf": {
        const url = urlOf(payload, type);
        const caption = (fromRichText(payload.caption) as { text?: string }[]).map((n) => n.text ?? "").join("").slice(0, 2000);
        block = { id, type: type === "pdf" ? "file" : type, props: { url, ...(caption ? { caption } : {}), ...(typeof payload.name === "string" ? { name: payload.name.slice(0, 200) } : {}) } };
        break;
      }
      case "bookmark":
        block = { id, type: "bookmark", props: { url: urlOf(payload, type) } };
        break;
      case "embed":
        block = { id, type: "embed", props: { url: urlOf(payload, type) } };
        break;
      case "table": {
        const width = Math.min(50, Math.max(1, Number(payload.table_width) || 1));
        const rows = Array.isArray(payload.children) ? payload.children : [];
        if (rows.length > MAX_BLOCKS) throw new InputError(`at most ${MAX_BLOCKS} table rows per request`);
        const cells = rows.map((row) => {
          const rr = (row as Record<string, unknown>)?.table_row as Record<string, unknown> | undefined;
          const list = Array.isArray(rr?.cells) ? rr.cells : [];
          return { cells: Array.from({ length: width }, (_, i) => fromRichText(list[i] ?? [])) };
        });
        block = { id, type: "table", props: {}, content: { type: "tableContent", columnWidths: Array(width).fill(undefined), ...(payload.has_column_header === true ? { headerRows: 1 } : {}), ...(payload.has_row_header === true ? { headerCols: 1 } : {}), rows: cells } };
        break;
      }
      case "column_list": {
        const cols = fromNotionBlocks(payload.children ?? [], canLink, depth + 1);
        if (cols.length < 2 || cols.some((c) => c.type !== "column")) throw new InputError("column_list needs at least two column children");
        block = { id, type: "columnList", props: {}, children: cols };
        break;
      }
      case "column":
        block = { id, type: "column", props: { width: typeof payload.width_ratio === "number" && payload.width_ratio > 0 ? payload.width_ratio : 1 }, children: depth + 1 >= MAX_DEPTH + 1 ? [] : fromNotionBlocks(payload.children ?? [], canLink, depth + 1) };
        break;
      case "link_to_page": {
        const target = noteIdOf(payload.page_id ?? payload.database_id);
        if (!target || !canLink(target)) throw new InputError("link_to_page: the page is not shared with this integration");
        block = { id, type: "page", props: { noteId: target } };
        break;
      }
      case "table_of_contents":
        block = { id, type: "toc", props: {} };
        break;
      case "breadcrumb":
        block = { id, type: "breadcrumb", props: {} };
        break;
      case "child_page":
      case "child_database":
        throw new InputError(`${type} blocks are created with POST /v1/${type === "child_page" ? "pages" : "databases"}`);
      default:
        throw new InputError(`block type "${type || "?"}" is not supported`);
    }
    // Mentions of pages the integration cannot see are dropped.
    if (Array.isArray(block.content)) block.content = (block.content as { type?: string; props?: { noteId?: string } }[]).filter((n) => n.type !== "mention" || !n.props?.noteId || canLink(n.props.noteId));
    out.push(block);
  }
  return out;
}

/** Applies a PATCH /blocks/{id} payload to one of our blocks (same type only). */
export function updateBlock(b: RawBlock, body: Record<string, unknown>, canLink: (noteId: string) => boolean): void {
  const probe = toNotionTypeOf(b);
  const payload = body[probe];
  if (payload === undefined) return;
  if (typeof payload !== "object" || payload === null) throw new InputError(`${probe} should be an object`);
  const p = payload as Record<string, unknown>;
  const props = { ...(b.props ?? {}) };
  if (p.rich_text !== undefined && probe !== "code") {
    b.content = (fromRichText(p.rich_text) as { type?: string; props?: { noteId?: string } }[]).filter((n) => n.type !== "mention" || !n.props?.noteId || canLink(n.props.noteId));
  }
  if (p.color !== undefined) {
    delete props.textColor;
    delete props.backgroundColor;
    Object.assign(props, propsOfColor(p.color));
  }
  if (probe === "to_do" && typeof p.checked === "boolean") props.checked = p.checked;
  if (probe.startsWith("heading_") && typeof p.is_toggleable === "boolean") props.isToggleable = p.is_toggleable;
  if (probe === "code") {
    if (p.rich_text !== undefined) {
      const code = (fromRichText(p.rich_text) as { text?: string }[]).map((n) => n.text ?? "").join("");
      if (b.type === "mermaid") props.code = code;
      else b.content = code ? [{ type: "text", text: code, styles: {} }] : [];
    }
    if (typeof p.language === "string" && b.type === "codeBlock") props.language = LANG_IN[p.language.toLowerCase()] ?? p.language.toLowerCase().slice(0, 40);
  }
  if (probe === "equation" && typeof p.expression === "string") props.latex = p.expression.slice(0, 4000);
  if (["image", "video", "audio", "file", "pdf", "bookmark", "embed"].includes(probe) && (p.external !== undefined || p.url !== undefined)) props.url = urlOf(p, probe);
  if (probe === "callout" && typeof (p.icon as Record<string, unknown> | undefined)?.emoji === "string") props.icon = String((p.icon as Record<string, unknown>).emoji).slice(0, 16);
  b.props = props;
}

/** The Notion type name of one of our blocks (without rendering it). */
export function toNotionTypeOf(b: RawBlock): string {
  switch (b.type) {
    case "heading":
      return `heading_${Math.min(3, Math.max(1, Number(b.props?.level) || 1))}`;
    case "bulletListItem":
      return "bulleted_list_item";
    case "numberedListItem":
      return "numbered_list_item";
    case "checkListItem":
      return "to_do";
    case "toggleListItem":
      return "toggle";
    case "codeBlock":
    case "mermaid":
      return "code";
    case "columnList":
    case "tabs":
      return "column_list";
    case "tab":
      return "column";
    case "toc":
      return "table_of_contents";
    case "synced":
      return "synced_block";
    default:
      return String(b.type ?? "unsupported");
  }
}
