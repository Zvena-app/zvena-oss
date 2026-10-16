// zvena Documents: inline comments by people who may only comment (Notion's
// "Can comment"). Starting a discussion on some text marks it (a "comment"
// style on the text); such a person's change to a page is accepted when it
// adds or removes nothing but those marks, and only on their own threads.
// Pure; the co-editing server applies the same rule to Yjs updates
// (collab.ts) with its own reading of the document.

import type { NoteComment } from "./types";

type Obj = Record<string, unknown>;

/** A style or Yjs attribute that is an inline-discussion mark ("comment", or y-prosemirror's "comment--<hash>"). */
export const isCommentKey = (k: string) => k === "comment" || k.startsWith("comment--");

/** The thread id a mark carries (BlockNote: the string; y-prosemirror: { stringValue }). */
export function markThread(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as Obj).stringValue === "string") return (v as Obj).stringValue as string;
  return null;
}

/** JSON with sorted keys (the same value always reads the same). */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Obj;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const isText = (v: unknown): v is { type: "text"; text: string; styles?: Obj } =>
  Boolean(v) && typeof v === "object" && (v as Obj).type === "text" && typeof (v as Obj).text === "string" && Object.keys(v as Obj).every((k) => k === "type" || k === "text" || k === "styles");

/**
 * Page blocks without discussion marks (text runs a mark split are joined
 * again), and how many characters each thread marks.
 */
export function withoutMarks(blocks: unknown): { plain: unknown; marked: Map<string, number> } {
  const marked = new Map<string, number>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) {
        const y = walk(x);
        const prev = out[out.length - 1];
        if (isText(y) && isText(prev) && canon(prev.styles ?? {}) === canon(y.styles ?? {})) out[out.length - 1] = { ...prev, text: prev.text + y.text };
        else out.push(y);
      }
      return out;
    }
    if (!v || typeof v !== "object") return v;
    const o: Obj = {};
    for (const [k, x] of Object.entries(v as Obj)) {
      if (k === "styles" && x && typeof x === "object" && !Array.isArray(x)) {
        const styles: Obj = {};
        for (const [sk, sv] of Object.entries(x as Obj)) {
          if (!isCommentKey(sk)) {
            styles[sk] = sv;
            continue;
          }
          const id = markThread(sv);
          const text = (v as Obj).text;
          if (id) marked.set(id, (marked.get(id) ?? 0) + (typeof text === "string" ? text.length : 1));
        }
        o[k] = styles;
      } else o[k] = walk(x);
    }
    return o;
  };
  return { plain: walk(blocks), marked };
}

/** The threads whose marks differ between two readings (characters marked per thread). */
export function changedThreads(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((id) => (a.get(id) ?? 0) !== (b.get(id) ?? 0));
}

/** Who started each inline discussion (the author id of its first comment). */
export function threadStarters(comments: readonly NoteComment[] | undefined): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const c of [...(comments ?? [])].sort((x, y) => x.at - y.at)) if (c.thread && !out.has(c.thread)) out.set(c.thread, c.authorId);
  return out;
}

/**
 * A commenter's page body: `next` when it differs from `stored` only in the
 * marks of their own discussions (`comments` as merged; `newThreads`: a
 * mark may also start a thread whose first comment is still on its way),
 * else false.
 */
export function commentMarksOnly(stored: unknown, next: unknown, comments: readonly NoteComment[] | undefined, userId: string, newThreads = false): boolean {
  const a = withoutMarks(stored);
  const b = withoutMarks(next);
  if (canon(a.plain) !== canon(b.plain)) return false;
  const starters = threadStarters(comments);
  return changedThreads(a.marked, b.marked).every((id) => (starters.has(id) ? starters.get(id) === userId : newThreads || !b.marked.has(id)));
}
