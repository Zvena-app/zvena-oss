// Links between objects of any product. Server-only.
//
// Most links are derived: the indexer reads what a page or an issue points at
// (mentions, pasted links, live blocks, relations) and `setDerived` makes the
// table say exactly that, per part of the object. A person can also link two
// objects by hand ("manual"), and turning one thing into another leaves a
// "converted" link; the indexer never touches those two.
//
// Every change pokes the workspace's pulse with type "links" for each object
// whose links or backlinks changed, so open "Related" panels refresh.

import { emit } from "../pulse/bus";
import { restricted } from "./visibility";
import { sql, tx } from "../store";
import { parseRefKey } from "./refs";
import { ecoDb } from "./schema";
import type { LinkVia } from "./types";

export type DerivedVia = Extract<LinkVia, "mention" | "link" | "embed" | "relation">;

export interface LinkRow {
  src: string;
  part: string;
  dst: string;
  via: LinkVia;
  createdBy: string | null;
  createdAt: number;
}

interface Row {
  src: string;
  part: string;
  dst: string;
  via: LinkVia;
  created_by: string | null;
  created_at: number;
}

const toLink = (r: Row): LinkRow => ({ src: r.src, part: r.part, dst: r.dst, via: r.via, createdBy: r.created_by, createdAt: r.created_at });

const MAX_PER_PART = 2000;

function poke(ws: string, keys: Iterable<string>, by?: string, origin?: string): void {
  const all = [...new Set(keys)];
  // A private team's issue or project is announced on its own, so the live stream can
  // send it to that team only without holding back everyone else's refresh.
  const own = all.filter((k) => restricted(ws, k));
  const refs = all.filter((k) => !own.includes(k));
  for (const k of own) emit(ws, { type: "links", ref: k, by, origin });
  for (let i = 0; i < refs.length; i += 50) {
    const chunk = refs.slice(i, i + 50);
    emit(ws, { type: "links", ...(chunk.length === 1 ? { ref: chunk[0] } : { refs: chunk }), by, origin });
  }
}

/**
 * Makes the derived links of one part of `src` exactly `targets` (deduped,
 * self-links dropped). Returns the keys whose links changed (src included
 * when anything changed), already announced on the pulse.
 */
export function setDerived(ws: string, src: string, part: string, targets: { dst: string; via: DerivedVia }[], by: string | null = null, quiet = false): string[] {
  ecoDb();
  const want = new Map<string, { dst: string; via: DerivedVia }>();
  for (const t of targets) {
    if (t.dst === src || !parseRefKey(t.dst)) continue;
    want.set(`${t.dst}|${t.via}`, t);
    if (want.size >= MAX_PER_PART) break;
  }
  const changed = new Set<string>();
  tx(() => {
    const have = sql("SELECT dst, via FROM eco_links WHERE ws_id = ? AND src = ? AND part = ? AND via NOT IN ('manual', 'converted')").all(ws, src, part) as { dst: string; via: DerivedVia }[];
    const now = Date.now();
    for (const h of have) {
      if (want.delete(`${h.dst}|${h.via}`)) continue;
      sql("DELETE FROM eco_links WHERE ws_id = ? AND src = ? AND part = ? AND dst = ? AND via = ?").run(ws, src, part, h.dst, h.via);
      changed.add(h.dst);
    }
    for (const t of want.values()) {
      sql("INSERT OR IGNORE INTO eco_links (ws_id, src, part, dst, via, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ws, src, part, t.dst, t.via, by, now);
      changed.add(t.dst);
    }
  });
  if (changed.size) {
    changed.add(src);
    if (!quiet) poke(ws, changed, by ?? undefined);
  }
  return [...changed];
}

/** Removes the derived links of the parts of `src` not in `keep` (comments that are gone). */
export function dropParts(ws: string, src: string, keep: readonly string[]): string[] {
  ecoDb();
  const parts = (sql("SELECT DISTINCT part FROM eco_links WHERE ws_id = ? AND src = ? AND via NOT IN ('manual', 'converted')").all(ws, src) as { part: string }[]).map((r) => r.part);
  const out = new Set<string>();
  for (const p of parts) if (!keep.includes(p)) for (const k of setDerived(ws, src, p, [])) out.add(k);
  return [...out];
}

/** A link a person made, or one left by turning one object into another. */
export function addLink(ws: string, src: string, dst: string, via: "manual" | "converted", by: string, origin?: string): boolean {
  ecoDb();
  if (src === dst || !parseRefKey(src) || !parseRefKey(dst)) return false;
  const r = sql("INSERT OR IGNORE INTO eco_links (ws_id, src, part, dst, via, created_by, created_at) VALUES (?, ?, '', ?, ?, ?, ?)").run(ws, src, dst, via, by, Date.now());
  if (Number(r.changes) > 0) poke(ws, [src, dst], by, origin);
  return Number(r.changes) > 0;
}

/** Removes a manual link, whichever way it was made. */
export function removeManual(ws: string, a: string, b: string, by: string, origin?: string): boolean {
  ecoDb();
  // A design file stands for its frames too (its panel shows their links).
  const sides = (k: string) => {
    const { exact, prefix } = keysFor(k);
    return prefix ? [exact, ...(sql("SELECT DISTINCT src AS k FROM eco_links WHERE ws_id = ? AND src > ? AND src < ? UNION SELECT DISTINCT dst FROM eco_links WHERE ws_id = ? AND dst > ? AND dst < ?").all(ws, prefix, rangeEnd(prefix), ws, prefix, rangeEnd(prefix)) as { k: string }[]).map((r) => r.k)] : [exact];
  };
  let n = 0;
  for (const x of sides(a)) for (const y of sides(b)) n += Number(sql("DELETE FROM eco_links WHERE ws_id = ? AND via = 'manual' AND ((src = ? AND dst = ?) OR (src = ? AND dst = ?))").run(ws, x, y, y, x).changes);
  if (n > 0) poke(ws, [a, b], by, origin);
  return n > 0;
}

/**
 * An object is gone for good: what it pointed at, and the links people made
 * to it, go too. Links other objects derive from their own text stay: the
 * text still says it, and cards of missing objects are simply not shown.
 */
export function dropObject(ws: string, key: string, by: string | null = null): void {
  ecoDb();
  const touched = new Set<string>();
  tx(() => {
    for (const r of sql("SELECT dst FROM eco_links WHERE ws_id = ? AND src = ?").all(ws, key) as { dst: string }[]) touched.add(r.dst);
    for (const r of sql("SELECT src FROM eco_links WHERE ws_id = ? AND dst = ? AND via IN ('manual', 'converted')").all(ws, key) as { src: string }[]) touched.add(r.src);
    sql("DELETE FROM eco_links WHERE ws_id = ? AND src = ?").run(ws, key);
    sql("DELETE FROM eco_links WHERE ws_id = ? AND dst = ? AND via IN ('manual', 'converted')").run(ws, key);
  });
  if (touched.size) poke(ws, [...touched, key], by ?? undefined);
}

/** A design file's key covers its frames: links to a frame count for the file. */
function keysFor(key: string): { exact: string; prefix: string | null } {
  const r = parseRefKey(key);
  return { exact: key, prefix: r?.kind === "design" && !r.frame ? `${key}/` : null };
}

/** The end of the range of keys that start with `prefix` ("…/" → "…0": "0" follows "/"). */
const rangeEnd = (prefix: string) => `${prefix.slice(0, -1)}0`;
/** A design file and its frames: one index range ["design:F", "design:F0"). */
const fileRange = (key: string): [string, string] => [key, `${key}0`];

/** What `key` points at (all parts), newest first. */
export function linksOf(ws: string, key: string, limit = 500): LinkRow[] {
  ecoDb();
  const { exact, prefix } = keysFor(key);
  const rows = prefix
    ? (sql("SELECT src, part, dst, via, created_by, created_at FROM eco_links WHERE ws_id = ? AND src >= ? AND src < ? ORDER BY created_at DESC LIMIT ?").all(ws, ...fileRange(exact), limit) as unknown as Row[])
    : (sql("SELECT src, part, dst, via, created_by, created_at FROM eco_links WHERE ws_id = ? AND src = ? ORDER BY created_at DESC LIMIT ?").all(ws, exact, limit) as unknown as Row[]);
  return rows.map(toLink);
}

/** What points at `key`, newest first. */
export function backlinksOf(ws: string, key: string, limit = 500): LinkRow[] {
  ecoDb();
  const { exact, prefix } = keysFor(key);
  const rows = prefix
    ? (sql("SELECT src, part, dst, via, created_by, created_at FROM eco_links WHERE ws_id = ? AND dst >= ? AND dst < ? ORDER BY created_at DESC LIMIT ?").all(ws, ...fileRange(exact), limit) as unknown as Row[])
    : (sql("SELECT src, part, dst, via, created_by, created_at FROM eco_links WHERE ws_id = ? AND dst = ? ORDER BY created_at DESC LIMIT ?").all(ws, exact, limit) as unknown as Row[]);
  return rows.map(toLink);
}
