// Server-only: each person's favorite pages in a workspace (Notion's
// Favorites are personal). Pages stay shared; only the star is someone's.

import { sql, tx } from "../store";
import { NOTE_ID_RE } from "./types";

const MAX_FAVORITES = 500;

/**
 * The person's favorites, oldest first. The first read in a workspace takes
 * over the stars that older versions kept on the pages themselves — for the
 * workspace owner only (those stars were the owner's in a personal space).
 */
export function favoritesOf(ws: string, userId: string, isOwner: boolean): string[] {
  const key = `fav-migrated:${ws}:${userId}`;
  if (isOwner && !sql("SELECT 1 FROM kv WHERE k = ?").get(key)) {
    tx(() => {
      const rows = sql("SELECT id, json FROM notes WHERE ws = ? AND deleted = 0 AND json LIKE '%\"favorite\":true%'").all(ws) as { id: string; json: string | null }[];
      const now = Date.now();
      for (const r of rows) {
        try {
          if ((JSON.parse(r.json ?? "null") as { favorite?: unknown } | null)?.favorite === true) {
            sql("INSERT INTO note_favorites (ws, user_id, note_id, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(ws, userId, r.id, now);
          }
        } catch {
          // A broken row has no star to keep.
        }
      }
      sql("INSERT INTO kv (k, v) VALUES (?, '1') ON CONFLICT(k) DO NOTHING").run(key);
    });
  }
  return (sql("SELECT note_id FROM note_favorites WHERE ws = ? AND user_id = ? ORDER BY at").all(ws, userId) as { note_id: string }[]).map((r) => r.note_id);
}

export function setFavorite(ws: string, userId: string, noteId: string, on: boolean, now = Date.now()): boolean {
  if (!NOTE_ID_RE.test(noteId)) return false;
  if (!on) {
    sql("DELETE FROM note_favorites WHERE ws = ? AND user_id = ? AND note_id = ?").run(ws, userId, noteId);
    return true;
  }
  const n = sql("SELECT COUNT(*) AS n FROM note_favorites WHERE ws = ? AND user_id = ?").get(ws, userId) as { n: number };
  if (Number(n.n) >= MAX_FAVORITES) return false;
  sql("INSERT INTO note_favorites (ws, user_id, note_id, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(ws, userId, noteId, now);
  return true;
}
