// zvena Documents: suggested edits (Notion's "Suggest edits"). In suggestion
// mode nothing typed changes the page itself: new text carries an insertion
// style ("suggestIns": the suggestion's id), removed text a deletion style
// ("suggestDel"), and a new line is a new block whose id names the
// suggestion (`sg~<id>~<n>`). A suggestion's thread is an inline discussion
// (lib/notes/comment-marks.ts) whose first entry is the suggestion itself
// (a NoteComment with `suggestion`): who made it, and whether an editor
// accepted or rejected it. Replies are ordinary comments of that thread.
//
// People who may only comment are always in suggestion mode. Their change
// to a page is accepted when, with their own open suggestions taken out
// (their inserted text and blocks dropped, their deletion marks removed),
// the page reads exactly as before, and the discussion marks follow the
// rule of comment-marks.ts. Accepting or rejecting changes the page itself,
// so it takes edit access. Pure; the co-editing server applies the same
// rule to Yjs updates (collab.ts) with its own reading of the document.

import { canon, changedThreads, isCommentKey, markThread, threadStarters } from "./comment-marks";
import type { NoteComment } from "./types";

type Obj = Record<string, unknown>;

export const SUGGEST_INS = "suggestIns";
export const SUGGEST_DEL = "suggestDel";
export const SUGGEST_ID_RE = /^[\w-]{1,40}$/;
/** A suggested block's id: `sg~<suggestion>~<n>`. */
export const SUGGEST_BLOCK_RE = /^sg~([\w-]{1,40})~[\w-]{1,24}$/;

/** A style or Yjs attribute of an insertion / a deletion (y-prosemirror may add "--<hash>"). */
export const isInsKey = (k: string) => k === SUGGEST_INS || k.startsWith(`${SUGGEST_INS}--`);
export const isDelKey = (k: string) => k === SUGGEST_DEL || k.startsWith(`${SUGGEST_DEL}--`);

/** The suggestion a block was suggested by (its id), or null. */
export function blockSuggestion(id: unknown): string | null {
  return typeof id === "string" ? (SUGGEST_BLOCK_RE.exec(id)?.[1] ?? null) : null;
}

export function suggestedBlockId(sid: string, n: string): string {
  return `sg~${sid}~${n}`;
}

/** Who may still change a suggestion: its author while it is open (accepted or rejected ones are the page's). */
export interface Ownership {
  /** Who started each thread (the suggestion's author), from the stored comments first. */
  starters: ReadonlyMap<string, string | undefined>;
  /** Suggestions an editor accepted or rejected. */
  decided: ReadonlySet<string>;
  /** Suggestions already on the page before this change. */
  before: ReadonlySet<string>;
  /** Live sessions: who brought in a suggestion whose record has not arrived yet. */
  owners?: ReadonlyMap<string, string>;
}

/** Is `sid` an open suggestion of `userId`'s (or a new one, not on the page before)? */
export function ownsSuggestion(o: Ownership, sid: string, userId: string): boolean {
  if (o.decided.has(sid)) return false;
  if (o.starters.has(sid)) return o.starters.get(sid) === userId;
  if (o.owners?.has(sid)) return o.owners.get(sid) === userId;
  return !o.before.has(sid);
}

/** The suggestions a page's comments know: their authors, and which were decided. */
export function suggestionRecords(...lists: (readonly NoteComment[] | undefined)[]): { starters: Map<string, string | undefined>; decided: Set<string> } {
  const starters = new Map<string, string | undefined>();
  const decided = new Set<string>();
  // The earlier list wins: a thread's author is never taken from a later copy.
  for (const list of lists) for (const [id, who] of threadStarters(list)) if (!starters.has(id)) starters.set(id, who);
  for (const list of lists) for (const c of list ?? []) if (c.thread && c.suggestion?.state) decided.add(c.thread);
  return { starters, decided };
}

/** The entry of each suggestion (the first of its thread that is one). */
export function suggestionEntries(comments: readonly NoteComment[] | undefined): Map<string, NoteComment> {
  const out = new Map<string, NoteComment>();
  for (const c of [...(comments ?? [])].sort((a, b) => a.at - b.at)) if (c.thread && c.suggestion && !out.has(c.thread)) out.set(c.thread, c);
  return out;
}

/**
 * What a suggested block may be: a line of text (the editor makes paragraphs
 * and list items, with default settings). Anything else — an embed, an image,
 * a file, a block with a URL or other settings — is never a suggestion, so a
 * person who may only comment cannot put it on the page.
 */
export const SUGGESTABLE_TYPES: ReadonlySet<string> = new Set(["paragraph", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "heading", "quote"]);
const DEFAULT_PROPS: Readonly<Record<string, readonly unknown[]>> = {
  textColor: ["default"],
  backgroundColor: ["default"],
  textAlignment: ["left"],
  checked: [false, "false"],
  isToggleable: [false, "false"],
  level: [1, 2, 3, 4, "1", "2", "3", "4"],
  start: [undefined, null],
};

/** Settings (block props, or a Yjs node's attributes) all at their defaults; `skip`: keys that are not settings (the id). */
export function defaultSettings(props: unknown, skip: readonly string[] = []): boolean {
  if (props === undefined || props === null) return true;
  if (typeof props !== "object" || Array.isArray(props)) return false;
  for (const [k, v] of Object.entries(props as Obj)) {
    if (skip.includes(k)) continue;
    const ok = DEFAULT_PROPS[k];
    if (!ok || !ok.includes(v)) return false;
  }
  return true;
}

/** A suggested block (sync's JSON) that may be one: a text type, an array of inline content, default settings. */
export function suggestableBlock(b: Obj): boolean {
  return typeof b.type === "string" && SUGGESTABLE_TYPES.has(b.type) && Array.isArray(b.content) && defaultSettings(b.props);
}

/** Blocks with every suggested block that may not be one taken out (defense in depth: such a block never reaches a reader). */
export function dropUnsuggestable(blocks: unknown, depth = 0): unknown {
  if (!Array.isArray(blocks) || depth > 60) return blocks;
  const out: unknown[] = [];
  for (const raw of blocks) {
    const b = raw as Obj | null;
    if (b && typeof b === "object" && blockSuggestion(b.id) && !suggestableBlock(b)) continue;
    out.push(b && typeof b === "object" && Array.isArray(b.children) ? { ...b, children: dropUnsuggestable(b.children, depth + 1) } : raw);
  }
  return out;
}

const isText = (v: unknown): v is { type: "text"; text: string; styles?: Obj } =>
  Boolean(v) && typeof v === "object" && (v as Obj).type === "text" && typeof (v as Obj).text === "string" && Object.keys(v as Obj).every((k) => k === "type" || k === "text" || k === "styles");

/** Every suggestion on a page (marks and suggested blocks). */
export function suggestionIds(blocks: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 60) return out;
  if (Array.isArray(blocks)) {
    for (const x of blocks) suggestionIds(x, out, depth + 1);
    return out;
  }
  if (!blocks || typeof blocks !== "object") return out;
  const o = blocks as Obj;
  const b = blockSuggestion(o.id);
  if (b) out.add(b);
  if (o.styles && typeof o.styles === "object") {
    for (const [k, v] of Object.entries(o.styles as Obj)) {
      if (!isInsKey(k) && !isDelKey(k)) continue;
      const id = markThread(v);
      if (id) out.add(id);
    }
  }
  for (const [k, v] of Object.entries(o)) if (k !== "styles" && v && typeof v === "object") suggestionIds(v, out, depth + 1);
  return out;
}

/**
 * Page blocks with the given suggestions taken out (their inserted text and
 * empty suggested blocks dropped, their deletion marks removed; text runs
 * this splits are joined again), without discussion marks, and how many
 * characters each discussion marks in what is left.
 */
export function withoutSuggestions(blocks: unknown, take: (sid: string) => boolean): { plain: unknown; marked: Map<string, number> } {
  const marked = new Map<string, number>();
  const ownIns = (styles: unknown) => {
    if (!styles || typeof styles !== "object") return false;
    return Object.entries(styles as Obj).some(([k, v]) => {
      if (!isInsKey(k)) return false;
      const id = markThread(v);
      return Boolean(id && take(id));
    });
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 60) return v;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) {
        if (isText(x) && ownIns(x.styles)) continue;
        const y = walk(x, depth + 1);
        // A block suggested by one of these, left with nothing in it: gone.
        if (y && typeof y === "object" && !Array.isArray(y)) {
          const sid = blockSuggestion((y as Obj).id);
          const content = (y as Obj).content;
          const children = (y as Obj).children;
          // Only a line of text with default settings: an embed, an image or a file is never dropped here,
          // so it shows as a change to the page (and a commenter's push with it is refused).
          if (sid && take(sid) && suggestableBlock(y as Obj) && Array.isArray(content) && content.length === 0 && (!Array.isArray(children) || children.length === 0)) continue;
        }
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
          if (isCommentKey(sk)) {
            const id = markThread(sv);
            const text = (v as Obj).text;
            if (id) marked.set(id, (marked.get(id) ?? 0) + (typeof text === "string" ? text.length : 1));
            continue;
          }
          if (isDelKey(sk)) {
            const id = markThread(sv);
            if (id && take(id)) continue;
          }
          styles[sk] = sv;
        }
        o[k] = styles;
      } else o[k] = walk(x, depth + 1);
    }
    return o;
  };
  return { plain: walk(blocks, 0), marked };
}

/**
 * A commenter's page body (Can comment): true when `next` differs from
 * `stored` only by their own open suggestions and by the marks of their own
 * discussions. `comments.stored` are the comments as they were (the authors
 * they name win), `comments.merged` as they are after this push.
 */
export function contributionOnly(stored: unknown, next: unknown, comments: { stored?: readonly NoteComment[]; merged?: readonly NoteComment[] }, userId: string): boolean {
  const { starters, decided } = suggestionRecords(comments.stored, comments.merged);
  const own: Ownership = { starters, decided, before: suggestionIds(stored) };
  const take = (sid: string) => ownsSuggestion(own, sid, userId);
  const a = withoutSuggestions(stored, take);
  const b = withoutSuggestions(next, take);
  if (canon(a.plain) !== canon(b.plain)) return false;
  // Discussion marks: those of one's own threads only (comment-marks.ts), a new thread with its first comment.
  const threads = threadStarters(comments.merged);
  return changedThreads(a.marked, b.marked).every((id) => (threads.has(id) ? threads.get(id) === userId : !b.marked.has(id)));
}

export interface SuggestionPart {
  /** Inserted text (suggested blocks' text on lines of their own). */
  ins: string;
  /** Text suggested for removal. */
  del: string;
}

/** What each suggestion on a page adds and removes, in page order. */
export function suggestionParts(blocks: unknown): Map<string, SuggestionPart> {
  const out = new Map<string, SuggestionPart>();
  const part = (sid: string) => {
    let p = out.get(sid);
    if (!p) out.set(sid, (p = { ins: "", del: "" }));
    return p;
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 60 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Obj;
    const sid = blockSuggestion(o.id);
    if (sid && Array.isArray(o.content)) {
      const p = part(sid);
      if (p.ins) p.ins += "\n";
    }
    if (isText(o)) {
      for (const [k, val] of Object.entries(o.styles ?? {})) {
        const id = markThread(val);
        if (!id) continue;
        if (isInsKey(k)) part(id).ins += o.text;
        else if (isDelKey(k)) part(id).del += o.text;
      }
      return;
    }
    for (const [k, x] of Object.entries(o)) if (k !== "styles") walk(x, depth + 1);
  };
  walk(blocks, 0);
  return out;
}

/** A page with one suggestion accepted or rejected (JSON; the editor does the same on its document). */
export function decideSuggestion(blocks: unknown, sid: string, accept: boolean, newId: () => string): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 60) return v;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) {
        if (isText(x)) {
          const st = (x.styles ?? {}) as Obj;
          const ins = Object.entries(st).some(([k, val]) => isInsKey(k) && markThread(val) === sid);
          const del = Object.entries(st).some(([k, val]) => isDelKey(k) && markThread(val) === sid);
          if ((ins && !accept) || (del && accept)) continue;
          const styles = Object.fromEntries(Object.entries(st).filter(([k, val]) => !((isInsKey(k) || isDelKey(k)) && markThread(val) === sid)));
          const y = { ...x, styles };
          const prev = out[out.length - 1];
          if (isText(prev) && canon(prev.styles ?? {}) === canon(styles)) out[out.length - 1] = { ...prev, text: prev.text + y.text };
          else out.push(y);
          continue;
        }
        if (x && typeof x === "object" && !Array.isArray(x) && blockSuggestion((x as Obj).id) === sid) {
          if (!accept) continue;
          out.push(walk({ ...(x as Obj), id: newId() }, depth + 1));
          continue;
        }
        out.push(walk(x, depth + 1));
      }
      return out;
    }
    if (!v || typeof v !== "object") return v;
    const o: Obj = {};
    for (const [k, x] of Object.entries(v as Obj)) o[k] = k === "styles" ? x : walk(x, depth + 1);
    return o;
  };
  return walk(blocks, 0);
}
