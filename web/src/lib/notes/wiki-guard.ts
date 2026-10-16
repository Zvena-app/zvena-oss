// Server-only: what a push may change of a wiki (Notion).
//  - A page's Verification changes only from its owners or someone with
//    full access, as themselves, for today onwards; the rest of the push
//    lands and the value stays as stored. Integrations read it only.
//  - Turning a database into a wiki (or back) takes full access to it.

import type { DbSchema, Note, PropValue } from "./types";
import { canVerify, isVerification, untilAfter } from "./verification";

const DAY = 86_400_000;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface WikiPusher {
  userId: string;
  /** Full access to this (stored) note, or for a new one where it is added. */
  full: (note: Note, isNew: boolean) => boolean;
}

/** May this verification value come from `userId` now? (Their own name, a day not in the past.) */
function honest(v: PropValue | undefined, userId: string, now: number): boolean {
  if (!isVerification(v) || v.state === "unverified") return true;
  if (v.by !== userId) return false;
  if (typeof v.at === "number" && (v.at > now + 5 * 60_000 || v.at < now - DAY)) return false;
  // A day back for time zones west of the server.
  return !v.until || v.until >= untilAfter(-1, now);
}

/**
 * The note as a person (or an integration, `who` null) may write it: a wiki
 * flag or a Verification they may not change stays as stored.
 */
export function guardWiki(stored: Note | null, next: Note, who: WikiPusher | null, schemaOf: (dbId: string) => DbSchema | undefined, now = Date.now()): Note {
  let out = next;
  // The wiki itself: Owner / Verification wiring changes with full access only.
  if (out.db && !same(stored?.db?.wiki, out.db.wiki) && !(who && who.full(stored ?? out, !stored))) {
    const { wiki: _w, ...rest } = out.db;
    void _w;
    out = { ...out, db: stored?.db?.wiki ? { ...rest, wiki: stored.db.wiki } : rest };
  }
  const schema = out.parentId ? schemaOf(out.parentId) : undefined;
  const props = schema?.properties.filter((p) => p.type === "verification") ?? [];
  if (!props.length) return out;
  // Owners as they were (a page moved in from elsewhere, or a new one: as pushed).
  const before = stored && stored.parentId === out.parentId ? stored : null;
  let changed: Record<string, PropValue> | null = null;
  for (const p of props) {
    const was = before?.props?.[p.id];
    const want = out.props?.[p.id];
    if (same(was, want)) continue;
    const ok = who !== null && canVerify(who.userId, who.full(stored ?? out, !stored), before ?? out, schema) && honest(want, who.userId, now);
    if (ok) continue;
    changed ??= { ...(out.props ?? {}) };
    if (was === undefined) delete changed[p.id];
    else changed[p.id] = was;
  }
  return changed ? { ...out, props: changed } : out;
}
