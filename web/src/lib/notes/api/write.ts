// Server-only: every API write goes through pushNotes like a device's sync
// (by "integration:<id>"), so other devices, notifications, links, history
// and automations see it, and the workspace owner's quota applies.

import { payerOf, quotaLeft } from "../../storage";
import { sql } from "../../store";
import "../reactions";
import { orderBetween, sanitizeNote } from "../model";
import { pushNotes } from "../server-store";
import type { Note } from "../types";
import type { ApiCtx } from "./respond";
import { ApiError } from "./respond";

/** Saves notes (and deletions forever); the space sees the stored versions afterwards. */
export async function save(ctx: ApiCtx, notes: Note[], deleted: string[] = []): Promise<void> {
  const ws = ctx.integration.ws;
  const payer = payerOf(ws);
  const left = payer ? await quotaLeft(payer) : 0;
  const now = Date.now();
  const items: { id: string; deleted?: boolean; note?: Note }[] = deleted.map((id) => ({ id, deleted: true }));
  // Never past the person who connected the page: edit access on what changes (or, for a new note, its parent).
  const space0 = ctx.space();
  const writable = (n: { id: string; parentId?: string | null }) => (space0.notes.has(n.id) ? space0.canWrite(n.id) : Boolean(n.parentId && space0.canWrite(n.parentId)));
  for (const id of deleted) if (!writable({ id })) throw new ApiError(403, "restricted_resource", "The integration may not change this page.");
  for (const n of notes) if (!writable(n)) throw new ApiError(403, "restricted_resource", "The integration may not change this page.");
  for (const n of notes) {
    const clean = sanitizeNote({ ...n, updatedAt: Math.max(now, n.updatedAt) });
    if (!clean) throw new ApiError(400, "validation_error", "The page is not valid.");
    items.push({ id: clean.id, note: clean });
  }
  const res = pushNotes(ws, items, { by: `integration:${ctx.integration.id}`, quotaLeft: left, author: ctx.integration.name, columnsFor: `integration:${ctx.integration.id}` });
  const bad = res.rejected[0];
  if (bad) {
    if (bad.reason === "quota") throw new ApiError(400, "validation_error", "The workspace's storage is full.");
    if (bad.reason === "too large") throw new ApiError(400, "validation_error", "The page would be larger than the size limit.");
    throw new ApiError(409, "conflict_error", "The change could not be saved; try again.");
  }
  const space = ctx.space();
  for (const id of deleted) space.notes.delete(id);
  for (const id of res.saved) {
    const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
    if (!r?.json) continue;
    try {
      space.notes.set(id, JSON.parse(r.json) as Note);
    } catch {
      // Stays as it was.
    }
  }
}

/** Siblings' order after the last one (a new sub-page or row goes at the end). */
export function orderAtEnd(siblings: readonly Note[]): number {
  const last = siblings.reduce((m, n) => (n.order > m ? n.order : m), Number.NEGATIVE_INFINITY);
  return Number.isFinite(last) ? orderBetween(last, undefined) : Date.now();
}
