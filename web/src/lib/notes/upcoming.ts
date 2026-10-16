// zvena Documents: Home's "Upcoming" (Notion's upcoming events): the dates
// of the next days — date mentions in pages and date properties of rows —
// soonest first. Pure.

import type { DbSchema, Note } from "./types";

export interface Upcoming {
  key: string;
  noteId: string;
  /** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm". */
  date: string;
  /** The block mentioning it (its link), when it is a mention. */
  blockId?: string;
  /** The mention's line in words; rows read by their title. */
  text?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/;

function lineText(content: unknown[]): string {
  return (content as { type?: string; text?: string; content?: unknown }[])
    .map((c) => (c?.type === "text" ? (c.text ?? "") : c?.type === "link" && Array.isArray(c.content) ? lineText(c.content) : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Dates from `from` (a day, "YYYY-MM-DD") to `to` (inclusive), soonest first,
 * at most `limit`. `skip`: notes left out (the trash, templates).
 */
export function upcomingDates(notes: Iterable<Note>, schemaOf: (dbId: string) => DbSchema | undefined, from: string, to: string, skip: (n: Note) => boolean, limit = 12): Upcoming[] {
  const out: Upcoming[] = [];
  const inWindow = (d: string) => DATE_RE.test(d) && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const walk = (blocks: unknown, noteId: string, depth: number) => {
    if (!Array.isArray(blocks) || depth > 40) return;
    for (const raw of blocks) {
      const b = raw as { id?: unknown; content?: unknown; children?: unknown };
      if (!b || typeof b !== "object") continue;
      if (Array.isArray(b.content)) {
        for (const c of b.content as { type?: string; props?: Record<string, unknown> }[]) {
          const d = c?.type === "mention" && typeof c.props?.date === "string" ? c.props.date : "";
          if (d && inWindow(d)) out.push({ key: `${noteId}:${String(b.id ?? "")}:${d}`, noteId, date: d.slice(0, 16), ...(typeof b.id === "string" ? { blockId: b.id } : {}), text: lineText(b.content).slice(0, 120) || undefined });
        }
      }
      walk(b.children, noteId, depth + 1);
    }
  };
  for (const n of notes) {
    if (n.trashedAt !== null || n.template || skip(n)) continue;
    walk(n.content, n.id, 0);
    if (!n.props || !n.parentId) continue;
    for (const p of schemaOf(n.parentId)?.properties ?? []) {
      if (p.type !== "date") continue;
      const v = n.props[p.id] as { start?: unknown } | undefined;
      if (v && typeof v.start === "string" && inWindow(v.start)) out.push({ key: `${n.id}:${p.id}:${v.start}`, noteId: n.id, date: v.start.slice(0, 16) });
    }
  }
  const seen = new Set<string>();
  return out
    .filter((u) => !seen.has(u.key) && Boolean(seen.add(u.key)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, limit);
}
