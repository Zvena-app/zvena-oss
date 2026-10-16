// Workspace search (Quick find, ⌘P): title and text matches, ranked like
// Notion's "Best matches", with its filters (titles only, created by, in a
// page, date edited) and sorts. Runs on this device's copy, so it works offline.

import { blocksText, inlineText } from "./model";
import type { Note } from "./types";

const textCache = new Map<string, { at: number; text: string }>();
function noteText(n: Note): string {
  const hit = textCache.get(n.id);
  if (hit && hit.at === n.updatedAt) return hit.text;
  const text = blocksText(n.content, 0, 60_000);
  textCache.set(n.id, { at: n.updatedAt, text });
  return text;
}

export interface SearchOpts {
  /** Match titles only (Notion's "Only search titles"). */
  titleOnly?: boolean;
  /** Only notes in this set (a page and everything under it). */
  within?: ReadonlySet<string>;
  /** Only notes created by these people (user ids; note.createdBy). */
  createdBy?: ReadonlySet<string>;
  /** Only notes edited at or after this time… */
  since?: number;
  /** …and before this one (a custom range). */
  until?: number;
  /** The preset shown on the date chip (1, 7, 30 days); absent with a custom range. */
  days?: number;
  sort?: "best" | "edited" | "editedOld" | "created";
}

export interface SearchHit {
  note: Note;
  snippet: string;
  score: number;
  /** The block the text matched in (opening the hit scrolls there). */
  block?: string;
}

/** The first block (nested ones too) whose text holds `word`. */
export function blockWith(blocks: unknown, word: string, depth = 0): string | undefined {
  if (!Array.isArray(blocks) || depth > 40 || !word) return undefined;
  for (const raw of blocks) {
    const b = raw as { id?: unknown; content?: unknown; children?: unknown };
    if (!b || typeof b !== "object") continue;
    if (typeof b.id === "string" && inlineText(b.content).toLowerCase().includes(word)) return b.id;
    const inner = blockWith(b.children, word, depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

/** The query's words, lower case (what highlighting and matching use). */
export function queryWords(q: string): string[] {
  return [...new Set(q.trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

/** Where the words occur in `text` ([start, end) ranges, merged, in order). */
export function matchRanges(text: string, words: readonly string[]): [number, number][] {
  const lower = text.toLowerCase();
  const out: [number, number][] = [];
  for (const w of words) {
    if (!w) continue;
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) out.push([i, i + w.length]);
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

const startsWord = (text: string, i: number) => i === 0 || /[\s\-–—_/.,:;()«»"'[\]]/.test(text[i - 1]);

export function searchNotes(list: readonly Note[], q: string, isTrashed: (id: string) => boolean, opts: SearchOpts = {}, now = Date.now()): SearchHit[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const words = queryWords(query);
  const out: SearchHit[] = [];
  for (const n of list) {
    if (n.template || n.synced || isTrashed(n.id)) continue;
    if (opts.within && !opts.within.has(n.id)) continue;
    if (opts.createdBy && !(n.createdBy && opts.createdBy.has(n.createdBy))) continue;
    if (opts.since && n.updatedAt < opts.since) continue;
    if (opts.until && n.updatedAt >= opts.until) continue;
    const title = n.title.toLowerCase();
    const body = opts.titleOnly ? "" : noteText(n);
    const lower = body.toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      const ti = title.indexOf(w);
      const bi = ti >= 0 ? -1 : lower.indexOf(w);
      if (ti < 0 && bi < 0) {
        all = false;
        break;
      }
      // A word in the title counts most, more so at the start of a word.
      if (ti >= 0) score += startsWord(title, ti) ? 12 : 8;
      else score += startsWord(lower, bi) ? 3 : 2;
    }
    if (!all) continue;
    if (title === query) score += 30;
    else if (title.startsWith(query)) score += 15;
    else if (words.length > 1 && title.includes(query)) score += 10;
    else if (words.length > 1 && lower.includes(query)) score += 4;
    // Pages and databases rank above rows; recent edits a little higher.
    if (n.kind === "database") score += 2;
    score += Math.max(0, 5 - (now - n.updatedAt) / (7 * 86_400_000));
    let snippet = "";
    const first = matchRanges(body, words)[0];
    if (first) {
      const start = Math.max(0, first[0] - 40);
      snippet = (start > 0 ? "…" : "") + body.slice(start, first[0] + 120).replace(/\s+/g, " ");
    }
    // A match in the text (not the title): its block, to scroll to.
    const inBody = words.find((w) => !title.includes(w));
    const block = !opts.titleOnly && inBody ? blockWith(n.content, inBody) : undefined;
    out.push({ note: n, snippet, score, ...(block ? { block } : {}) });
  }
  const order: Record<NonNullable<SearchOpts["sort"]>, (a: SearchHit, b: SearchHit) => number> = {
    best: (a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt,
    edited: (a, b) => b.note.updatedAt - a.note.updatedAt,
    editedOld: (a, b) => a.note.updatedAt - b.note.updatedAt,
    created: (a, b) => b.note.createdAt - a.note.createdAt,
  };
  return out.sort(order[opts.sort ?? "best"]).slice(0, 50);
}

// Recent searches (Notion shows them when the box is empty): per browser.
const RECENT_KEY = "zvena-search-recent";
const RECENT_MAX = 6;

export function recentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(q: string): void {
  const s = q.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!s) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([s, ...recentSearches().filter((x) => x.toLowerCase() !== s.toLowerCase())].slice(0, RECENT_MAX)));
  } catch {
    // Private mode: nothing is remembered.
  }
}

export function clearSearches(): void {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // ignore
  }
}
