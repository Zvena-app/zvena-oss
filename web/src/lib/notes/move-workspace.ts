// Server-only: moving a page to another workspace (Notion's "Move to" → a
// workspace). The page and everything under it (sub-pages, databases and
// their rows, synced blocks) are written to the destination — into the
// mover's Private there — through pushNotes like any other write, then
// deleted in the source (devices drop them). Files the moved pages show are
// recorded for the destination's owner (its quota pays from now on), and the
// page's published link, forms, history and live document state follow it.
// Ids are kept unless the destination already has one of them.

import { payerOf, quotaLeft, recordFile } from "../storage";
import { audit, sql, tx } from "../store";
import { roleIn } from "../workspaces";
import { AccessResolver, atLeast, roleLevel, subtreeOf } from "./access";
import { newNoteId, remapNote, sanitizeNote } from "./model";
import { pushNotes } from "./server-store";
import type { Note } from "./types";

const FILE_REF_RE = /\/api\/notes\/file\/([a-f0-9]{40}\.[a-z0-9]{1,5})/g;
const MAX_NOTES = 5000;

export type MoveResult = { ok: true; id: string; moved: number } | { ok: false; status: number; error: string };

export async function movePageToWorkspace(from: string, to: string, noteId: string, userId: string, author: string): Promise<MoveResult> {
  if (from === to) return { ok: false, status: 400, error: "same workspace" };
  const src = new AccessResolver(from, userId);
  // Moving changes who can read the page: full access, as for a move between sections.
  if (src.level(noteId) !== "full") return { ok: false, status: 403, error: "forbidden" };
  // The destination: someone who can add pages there (they land in the mover's Private).
  if (!atLeast(roleLevel(roleIn(userId, to)), "edit")) return { ok: false, status: 403, error: "forbidden" };
  const ids = subtreeOf(from, [noteId]);
  if (ids.length > MAX_NOTES) return { ok: false, status: 413, error: "too many pages" };
  const notes: Note[] = [];
  for (const id of ids) {
    const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(from, id) as { json: string | null } | undefined;
    if (!r?.json) continue;
    // Every page that goes must be the mover's to delete here.
    if (!atLeast(src.level(id), "edit")) return { ok: false, status: 403, error: "not all pages can be moved" };
    let n: Note | null = null;
    try {
      n = sanitizeNote(JSON.parse(r.json));
    } catch {
      n = null;
    }
    if (!n) continue;
    // A database with column permissions goes only with someone who sees every column (they own it over there).
    if (n.kind === "database" && n.db?.properties.some((p) => p.perms) && src.level(id) !== "full") return { ok: false, status: 403, error: "not all pages can be moved" };
    notes.push(n);
  }
  if (!notes.some((n) => n.id === noteId)) return { ok: false, status: 404, error: "not found" };
  // Ids stay, unless one is taken in the destination (then all are new, links inside follow).
  const taken = notes.some((n) => sql("SELECT 1 FROM notes WHERE ws = ? AND id = ?").get(to, n.id));
  const map = new Map(notes.map((n) => [n.id, taken ? newNoteId() : n.id]));
  const moved = notes.map((n) => {
    const c = taken ? remapNote(structuredClone(n), map) : structuredClone(n);
    c.id = map.get(n.id) as string;
    c.parentId = n.id === noteId ? null : n.parentId ? (map.get(n.parentId) ?? n.parentId) : null;
    if (n.id === noteId) {
      c.space = "private";
      delete c.inline;
      c.trashedAt = null;
    }
    delete c.access;
    // A published link follows only when the ids do (it names the page).
    if (taken) delete c.share;
    c.favorite = false;
    return c;
  });
  // Quota: the destination's owner pays for the pages and the files they show.
  const destPayer = payerOf(to);
  const srcPayer = payerOf(from);
  if (!destPayer) return { ok: false, status: 404, error: "no destination" };
  const names = new Set<string>();
  let bytes = 0;
  for (const n of moved) {
    const json = JSON.stringify(n);
    bytes += Buffer.byteLength(json);
    for (const m of json.matchAll(FILE_REF_RE)) names.add(m[1]);
  }
  const files = [...names].map((name) => {
    const own = sql("SELECT 1 FROM files WHERE name = ? AND owner_kind = 'user' AND owner_id = ?").get(name, destPayer);
    const row = sql("SELECT bytes FROM files WHERE name = ? ORDER BY owner_id = ? DESC LIMIT 1").get(name, srcPayer ?? "") as { bytes: number } | undefined;
    return { name, bytes: Number(row?.bytes ?? 0), own: Boolean(own) };
  });
  const fileBytes = files.filter((f) => !f.own).reduce((a, f) => a + f.bytes, 0);
  const left = await quotaLeft(destPayer);
  if (bytes + fileBytes > left) return { ok: false, status: 507, error: "quota" };

  const res = pushNotes(
    to,
    moved.map((n) => ({ id: n.id, note: n })),
    { by: userId, quotaLeft: Infinity, author, access: { userId } }
  );
  if (res.rejected.length) {
    // All or nothing: what did arrive goes again.
    if (res.saved.length) pushNotes(to, res.saved.map((id) => ({ id, deleted: true as const })), { by: userId, quotaLeft: Infinity });
    return { ok: false, status: 409, error: res.rejected[0].reason };
  }
  for (const f of files) if (!f.own && f.bytes > 0) recordFile({ kind: "user", id: destPayer }, f.name, f.bytes);
  const kept = !taken;
  tx(() => {
    for (const n of notes) {
      const id = n.id;
      if (kept) {
        // The page's link, forms, history and live state go with it.
        sql("UPDATE note_shares SET ws = ? WHERE ws = ? AND note_id = ?").run(to, from, id);
        sql("UPDATE note_forms SET ws = ? WHERE ws = ? AND db_id = ?").run(to, from, id);
        sql("UPDATE note_versions SET ws = ? WHERE ws = ? AND note_id = ?").run(to, from, id);
        sql("UPDATE note_events SET ws = ? WHERE ws = ? AND note_id = ?").run(to, from, id);
        sql("UPDATE note_ydocs SET ws = ? WHERE ws = ? AND note_id = ?").run(to, from, id);
        sql("UPDATE note_favorites SET ws = ? WHERE ws = ? AND note_id = ? AND user_id = ?").run(to, from, id, userId);
      } else {
        sql("DELETE FROM note_shares WHERE ws = ? AND note_id = ?").run(from, id);
        sql("DELETE FROM note_forms WHERE ws = ? AND db_id = ?").run(from, id);
      }
      // Shares in the source workspace mean nothing in the other one.
      for (const t of ["note_access", "note_grants", "note_group_grants", "note_access_requests", "note_favorites", "note_views"]) sql(`DELETE FROM ${t} WHERE ws = ? AND note_id = ?`).run(from, id);
    }
  });
  // Gone from the source: its devices drop the pages.
  pushNotes(from, notes.map((n) => ({ id: n.id, deleted: true as const })), { by: userId, quotaLeft: Infinity });
  audit(userId, "page.move.workspace", from, { to, pages: notes.length });
  return { ok: true, id: map.get(noteId) as string, moved: notes.length };
}
