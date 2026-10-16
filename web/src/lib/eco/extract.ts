// What an object points at: the refs inside a Documents page (block JSON) or
// an issue's text (Markdown). The indexer turns them into links and the
// "Related" panel reads those links both ways. Pure.
//
//   mention    @page or @person inside a document, @person in an issue
//   link       any link to a zvena address (pasted URL, bookmark, embed)
//   embed      a live block: a design frame, an issue card
//   relation   a database relation property (rows of another database)

import { refFromUrl, isUuid, type Origins, type RawRef } from "./refs";

export type Via = "mention" | "link" | "embed" | "relation";

export interface Found {
  raw: RawRef;
  via: Via;
}

interface BlockLike {
  type?: unknown;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown;
}

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_FOUND = 2000;

function rawKey(r: RawRef): string {
  switch (r.kind) {
    case "user":
      return `user:${r.id}`;
    case "design":
      return r.frame ? `design:${r.file}/${r.frame}` : `design:${r.file}`;
    case "issue-ident":
      return `issue-ident:${r.ident}`;
    default:
      return `${r.kind}:${r.id}`;
  }
}

class Collector {
  private seen = new Set<string>();
  readonly found: Found[] = [];
  add(raw: RawRef | null, via: Via): void {
    if (!raw || this.found.length >= MAX_FOUND) return;
    const k = `${via}|${rawKey(raw)}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.found.push({ raw, via });
  }
}

function walkInline(content: unknown, origins: Origins, out: Collector, depth = 0): void {
  if (depth > 20) return;
  if (!Array.isArray(content)) {
    // Tables keep their cells under { type: "tableContent", rows: [{ cells }] }.
    const t = content as { type?: string; rows?: { cells?: unknown[] }[] } | null;
    if (t && t.type === "tableContent" && Array.isArray(t.rows)) {
      for (const row of t.rows) for (const c of row?.cells ?? []) walkInline((c as { content?: unknown })?.content ?? c, origins, out, depth + 1);
    }
    return;
  }
  for (const raw of content) {
    const n = raw as { type?: unknown; href?: unknown; props?: Record<string, unknown>; content?: unknown } | null;
    if (!n || typeof n !== "object") continue;
    if (n.type === "link") {
      out.add(refFromUrl(n.href, origins), "link");
      walkInline(n.content, origins, out, depth + 1);
    } else if (n.type === "mention") {
      const id = n.props?.noteId;
      const user = n.props?.userId;
      if (typeof id === "string" && ID_RE.test(id)) out.add({ kind: "note", id }, "mention");
      else if (typeof user === "string" && ID_RE.test(user)) out.add({ kind: "user", id: user }, "mention");
    } else if (n.content) walkInline(n.content, origins, out, depth + 1);
  }
}

function walkBlocks(blocks: unknown, origins: Origins, out: Collector, depth = 0): void {
  if (!Array.isArray(blocks) || depth > 40) return;
  for (const raw of blocks) {
    const b = raw as BlockLike;
    if (!b || typeof b !== "object") continue;
    const p = b.props ?? {};
    switch (b.type) {
      case "design":
        if (isUuid(p.fileId)) out.add(isUuid(p.frameId) ? { kind: "design", file: p.fileId, frame: p.frameId } : { kind: "design", file: p.fileId }, "embed");
        break;
      case "issue":
        if (typeof p.issueId === "string" && ID_RE.test(p.issueId)) out.add({ kind: "issue", id: p.issueId }, "embed");
        break;
      case "issues":
        // A project's live list of issues: the page is about that project.
        if (typeof p.projectId === "string" && ID_RE.test(p.projectId)) out.add({ kind: "project", id: p.projectId }, "embed");
        break;
      case "bookmark":
      case "embed":
        out.add(refFromUrl(p.url, origins), "link");
        break;
    }
    walkInline(b.content, origins, out);
    walkBlocks(b.children, origins, out, depth + 1);
  }
}

/**
 * The refs of a page or a row: its blocks, and (for a row) the values of the
 * relation properties named in `relationProps` (their values are row ids)
 * and the person properties in `personProps` (user ids).
 * Sub-pages, linked databases and synced blocks are structure, not links.
 */
export function refsInNote(note: { content?: unknown; props?: Record<string, unknown> }, origins: Origins, relationProps: readonly string[] = [], personProps: readonly string[] = []): Found[] {
  const out = new Collector();
  walkBlocks(note.content, origins, out);
  for (const prop of personProps) {
    const v = note.props?.[prop];
    if (!Array.isArray(v)) continue;
    for (const id of v) if (typeof id === "string" && ID_RE.test(id)) out.add({ kind: "user", id }, "relation");
  }
  for (const prop of relationProps) {
    const v = note.props?.[prop];
    if (!Array.isArray(v)) continue;
    for (const id of v) if (typeof id === "string" && ID_RE.test(id)) out.add({ kind: "note", id }, "relation");
  }
  return out.found;
}

// Every pattern below is bounded and has nothing to backtrack into: a text
// crafted to make them slow (thousands of "[@" or "](" with no closing
// bracket) is read in linear time.
/** Projects' mention shortcode: [@ id="<user id>" label="<name>"]. */
const MD_MENTION_RE = /\[@\s([^\]]{0,300})\]/g;
const MENTION_ID_RE = /\bid="([A-Za-z0-9_-]{6,64})"/;
/** A Markdown link's target: "](" then the URL (a title after it is not needed). */
const MD_LINK_RE = /\]\(\s{0,20}<?([^)\s>]{1,2000})/g;
/** At most this much of one text is read for links. */
const MD_MAX = 100_000;
const BARE_URL_RE = /(?:https?:\/\/|\/(?:docs|notes|projects|design|n)\b)[^\s<>()[\]"'`]*/g;

/** The refs in Markdown: @mentions, [text](url), <url> and bare URLs that point at zvena. */
export function refsInMarkdown(md: unknown, origins: Origins): Found[] {
  const out = new Collector();
  if (typeof md !== "string" || !md) return out.found;
  const text = md.length > MD_MAX ? md.slice(0, MD_MAX) : md;
  for (const m of text.matchAll(MD_MENTION_RE)) {
    const id = MENTION_ID_RE.exec(m[1])?.[1];
    if (id) out.add({ kind: "user", id }, "mention");
  }
  for (const m of text.matchAll(MD_LINK_RE)) out.add(refFromUrl(m[1], origins), "link");
  // Bare URLs: what is left once the links' own targets are cut out (their text may be a URL too).
  const rest = text.replace(MD_LINK_RE, "]()");
  for (const m of rest.matchAll(BARE_URL_RE)) out.add(refFromUrl(m[0].replace(/[.,;:!?]+$/, ""), origins), "link");
  return out.found;
}
