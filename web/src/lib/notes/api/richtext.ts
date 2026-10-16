// Server-only: BlockNote inline content ↔ Notion's rich_text arrays
// (text with annotations and links, mentions of pages, dates and people,
// inline equations).

import { safeUrl } from "../model";
import { NOTE_COLORS } from "../types";
import { toUuid } from "./space";

export interface Annotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

export interface RichText {
  type: "text" | "mention" | "equation";
  text?: { content: string; link: { url: string } | null };
  mention?: { type: "page"; page: { id: string } } | { type: "database"; database: { id: string } } | { type: "date"; date: { start: string; end: string | null; time_zone: null } } | { type: "user"; user: { object: "user"; id: string } };
  equation?: { expression: string };
  annotations: Annotations;
  plain_text: string;
  href: string | null;
}

interface Inline {
  type?: string;
  text?: string;
  href?: string;
  content?: unknown;
  styles?: Record<string, unknown>;
  props?: Record<string, unknown>;
}

export interface Lookup {
  title(id: string): string | null;
  isDatabase(id: string): boolean;
  personName(id: string): string | null;
  /** The app URL of a page (for hrefs). */
  pageUrl(id: string): string;
}

const COLORS = new Set<string>(NOTE_COLORS);
const MAX_TEXT = 2000;

function annotations(styles: Record<string, unknown> | undefined): Annotations {
  const st = styles ?? {};
  const text = typeof st.textColor === "string" && COLORS.has(st.textColor) && st.textColor !== "default" ? st.textColor : "";
  const bg = typeof st.backgroundColor === "string" && COLORS.has(st.backgroundColor) && st.backgroundColor !== "default" ? st.backgroundColor : "";
  return {
    bold: st.bold === true,
    italic: st.italic === true,
    strikethrough: st.strike === true,
    underline: st.underline === true,
    code: st.code === true,
    color: text || (bg ? `${bg}_background` : "default"),
  };
}

const PLAIN: Annotations = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" };

/** Long text is cut into pieces of 2000 characters, as Notion requires. */
function chunks(s: string): string[] {
  if (s.length <= MAX_TEXT) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += MAX_TEXT) out.push(s.slice(i, i + MAX_TEXT));
  return out;
}

/** Inline content of a block → rich_text. */
export function toRichText(content: unknown, lookup: Lookup, link: string | null = null): RichText[] {
  if (typeof content === "string") content = [{ type: "text", text: content, styles: {} }];
  if (!Array.isArray(content)) return [];
  const out: RichText[] = [];
  for (const raw of content) {
    const n = raw as Inline;
    if (!n || typeof n !== "object") continue;
    if (n.type === "link") {
      const href = typeof n.href === "string" ? n.href : null;
      out.push(...toRichText(n.content, lookup, href));
      continue;
    }
    if (n.type === "mention") {
      const p = n.props ?? {};
      if (typeof p.userId === "string" && p.userId) {
        const name = lookup.personName(p.userId) ?? "Unknown";
        out.push({ type: "mention", mention: { type: "user", user: { object: "user", id: toUuid(p.userId) } }, annotations: PLAIN, plain_text: `@${name}`, href: null });
      } else if (typeof p.date === "string" && p.date) {
        out.push({ type: "mention", mention: { type: "date", date: { start: p.date, end: null, time_zone: null } }, annotations: PLAIN, plain_text: p.date, href: null });
      } else if (typeof p.noteId === "string" && p.noteId) {
        const title = lookup.title(p.noteId);
        if (title === null) continue;
        const id = toUuid(p.noteId);
        out.push({
          type: "mention",
          mention: lookup.isDatabase(p.noteId) ? { type: "database", database: { id } } : { type: "page", page: { id } },
          annotations: PLAIN,
          plain_text: title || "Untitled",
          href: lookup.pageUrl(p.noteId),
        });
      }
      continue;
    }
    if (n.type === "inlineEquation") {
      const expression = String(n.props?.latex ?? "");
      out.push({ type: "equation", equation: { expression }, annotations: PLAIN, plain_text: expression, href: null });
      continue;
    }
    if (n.type !== "text") {
      out.push(...toRichText(n.content, lookup, link));
      continue;
    }
    const text = typeof n.text === "string" ? n.text : "";
    if (!text) continue;
    const a = annotations(n.styles);
    for (const part of chunks(text)) out.push({ type: "text", text: { content: part, link: link ? { url: link } : null }, annotations: a, plain_text: part, href: link });
  }
  return out;
}

export function plainText(rt: readonly RichText[]): string {
  return rt.map((r) => r.plain_text).join("");
}

/** "2026-10-14", "2026-10-14T09:30" — the date and local time as written (offsets are not converted). */
export function cleanDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(v.trim());
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return m[2] ? `${m[1]}T${m[2]}` : m[1];
}

function stylesOf(a: unknown): Record<string, unknown> {
  const r = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
  const st: Record<string, unknown> = {};
  if (r.bold === true) st.bold = true;
  if (r.italic === true) st.italic = true;
  if (r.strikethrough === true) st.strike = true;
  if (r.underline === true) st.underline = true;
  if (r.code === true) st.code = true;
  if (typeof r.color === "string" && r.color !== "default") {
    const bg = /^([a-z]+)_background$/.exec(r.color);
    if (bg && COLORS.has(bg[1])) st.backgroundColor = bg[1];
    else if (COLORS.has(r.color)) st.textColor = r.color;
  }
  return st;
}

/** Strips dashes from a Notion UUID (our note ids are 32 hex characters). */
export function noteIdOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v) ? v.replace(/-/g, "").toLowerCase() : v;
  return /^[A-Za-z0-9_-]{6,64}$/.test(s) ? s : null;
}

export class InputError extends Error {}

/** rich_text from a request → BlockNote inline content (unsafe links are dropped, text is kept). */
export function fromRichText(v: unknown, max = 100): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new InputError("rich_text should be an array");
  if (v.length > max) throw new InputError(`rich_text has more than ${max} items`);
  const out: unknown[] = [];
  for (const raw of v) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const styles = stylesOf(r.annotations);
    const type = typeof r.type === "string" ? r.type : r.text ? "text" : r.mention ? "mention" : r.equation ? "equation" : "";
    if (type === "text") {
      const t = (typeof r.text === "object" && r.text !== null ? r.text : {}) as Record<string, unknown>;
      const content = typeof t.content === "string" ? t.content : "";
      if (content.length > MAX_TEXT) throw new InputError("text.content is longer than 2000 characters");
      if (!content) continue;
      const url = typeof t.link === "object" && t.link !== null ? (t.link as Record<string, unknown>).url : undefined;
      const node = { type: "text", text: content, styles };
      if (typeof url === "string" && url && safeUrl(url)) out.push({ type: "link", href: url, content: [node] });
      else out.push(node);
    } else if (type === "mention") {
      const m = (typeof r.mention === "object" && r.mention !== null ? r.mention : {}) as Record<string, unknown>;
      const page = (m.page ?? m.database) as Record<string, unknown> | undefined;
      const date = m.date as Record<string, unknown> | undefined;
      const user = m.user as Record<string, unknown> | undefined;
      if (page) {
        const id = noteIdOf(page.id);
        if (!id) throw new InputError("mention.page.id is not a valid id");
        out.push({ type: "mention", props: { noteId: id, date: "", remind: "" } });
      } else if (date) {
        const start = cleanDate(date.start);
        if (!start) throw new InputError("mention.date.start is not a valid date");
        out.push({ type: "mention", props: { noteId: "", date: start, remind: "" } });
      } else if (user) {
        const id = noteIdOf(user.id);
        if (!id) throw new InputError("mention.user.id is not a valid id");
        out.push({ type: "mention", props: { noteId: "", date: "", remind: "", userId: id } });
      }
    } else if (type === "equation") {
      const e = (typeof r.equation === "object" && r.equation !== null ? r.equation : {}) as Record<string, unknown>;
      const expression = typeof e.expression === "string" ? e.expression.slice(0, 2000) : "";
      if (expression) out.push({ type: "inlineEquation", props: { latex: expression } });
    }
  }
  return out;
}

/** Plain text of a rich_text request value (titles, text properties). */
export function richPlain(v: unknown): string {
  const inline = fromRichText(v);
  const walk = (list: unknown[]): string =>
    list
      .map((x) => {
        const n = x as Inline;
        if (n.type === "text") return n.text ?? "";
        if (n.type === "link") return walk(Array.isArray(n.content) ? n.content : []);
        return "";
      })
      .join("");
  return walk(inline);
}
