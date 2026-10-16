// Markdown of issue descriptions and comments: the editor (Tiptap) writes
// CommonMark plus mentions as shortcodes — [@ id="<user id>" label="<name>"].
// The server reads mentions from it (notifications) and turns it into plain
// text (excerpts in the inbox, search snippets). Rendering happens in the
// browser through the editor's schema, which keeps only known nodes, so raw
// HTML or script in the text never becomes markup.

// Character classes exclude the opening delimiter, so no pattern can rescan
// the same text from every position (no quadratic time on hostile input).
const MENTION_RE = /\[@ ([^[\]]{0,300})\]/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

export interface Mention {
  id: string;
  label: string;
}

export function mentionsIn(md: string): Mention[] {
  const out = new Map<string, Mention>();
  for (const m of md.matchAll(MENTION_RE)) {
    if (out.size >= 100) break;
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(ATTR_RE)) attrs[a[1]] = a[2];
    if (attrs.id && /^[A-Za-z0-9_-]{1,64}$/.test(attrs.id)) out.set(attrs.id, { id: attrs.id, label: attrs.label ?? "" });
  }
  return [...out.values()];
}

/** Mentions present in `next` but not in `prev` (only new ones notify). */
export function newMentions(prev: string, next: string): Mention[] {
  const before = new Set(mentionsIn(prev).map((m) => m.id));
  return mentionsIn(next).filter((m) => !before.has(m.id));
}

/** Plain text for excerpts: no markup, mentions as @name, collapsed spaces. */
export function plainText(md: string, max = 280): string {
  const s = md
    .slice(0, Math.max(1000, max * 4))
    .replace(MENTION_RE, (_, attrs: string) => `@${/label="([^"]*)"/.exec(attrs)?.[1] ?? ""}`)
    .replace(/```[^`]*```/g, " ")
    .replace(/!\[[^[\]]*\]\([^()]*\)/g, " ")
    .replace(/\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/<[^<>]+>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Task-list and bullet lines of a description (a source for sub-issues). */
export function listItems(md: string): { text: string; done: boolean }[] {
  const out: { text: string; done: boolean }[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
    if (m) {
      const text = plainText(m[2], 200);
      if (text) out.push({ text, done: m[1] === "x" || m[1] === "X" });
    }
  }
  return out;
}
