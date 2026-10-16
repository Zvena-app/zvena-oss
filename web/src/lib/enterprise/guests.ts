// Server-only: Settings → Guests (Notion's): the people outside the workspace
// who were given pages of it, what each can open, and removing a guest (their
// access to every page here goes; their devices drop the pages on the next
// sync). Owners only (the routes check). A page the owner may not open
// (someone's Private page) is listed without its title.

import { changeAccess, pageLevel } from "../notes/access";
import { audit, sql } from "../store";

export interface GuestRow {
  id: string;
  name: string;
  email: string;
  pages: { id: string; title: string | null; level: string }[];
}

export function guestsOf(ws: string, viewer: string): GuestRow[] {
  const rows = sql(
    `SELECT g.user_id, g.note_id, g.level, u.name, u.email, json_extract(n.json, '$.title') AS title
       FROM note_grants g
       JOIN users u ON u.id = g.user_id
       LEFT JOIN notes n ON n.ws = g.ws AND n.id = g.note_id AND n.deleted = 0
      WHERE g.ws = ? AND NOT EXISTS (SELECT 1 FROM members m WHERE m.ws_id = g.ws AND m.user_id = g.user_id)
      ORDER BY u.name, g.note_id`
  ).all(ws) as { user_id: string; note_id: string; level: string; name: string; email: string | null; title: string | null }[];
  const out = new Map<string, GuestRow>();
  for (const r of rows) {
    const g = out.get(r.user_id) ?? { id: r.user_id, name: r.name, email: r.email ?? "", pages: [] };
    g.pages.push({ id: r.note_id, title: pageLevel(viewer, ws, r.note_id) ? (r.title ?? "") : null, level: r.level });
    out.set(r.user_id, g);
  }
  return [...out.values()];
}

/** Takes every page of the workspace away from a guest; false when they are no guest here. */
export function removeGuest(ws: string, actor: string, userId: string): boolean {
  if (sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(ws, userId)) return false;
  const pages = (sql("SELECT note_id FROM note_grants WHERE ws = ? AND user_id = ?").all(ws, userId) as { note_id: string }[]).map((r) => r.note_id);
  if (!pages.length) return false;
  changeAccess(ws, pages, () => {
    sql("DELETE FROM note_grants WHERE ws = ? AND user_id = ?").run(ws, userId);
  });
  audit(actor, "guest.remove", ws, { user: userId, pages: pages.length });
  return true;
}
