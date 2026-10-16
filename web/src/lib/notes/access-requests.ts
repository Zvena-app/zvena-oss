// Server-only: "Request access" (Notion). Someone who opens a link to a page
// they cannot read may ask for access; everyone with full access to the
// page hears about it in their Inbox and approves (with a level) or declines
// in the Share menu. Approving is an ordinary grant (a member, or a guest for
// someone outside the workspace).

import { notify } from "../eco/inbox";
import { audit, sql } from "../store";
import { AccessResolver, atLeast, grant, principals } from "./access";
import type { AccessLevel } from "./types";
import "../../i18n/server-catalogs";
import { userLocale } from "../user-locale";
import { notesT } from "./i18n";

const MAX_NOTIFIED = 20;

type Notifier = typeof notify;
let send: Notifier = notify;
/** Tests listen to what would reach the Inbox. */
export function setRequestNotifierForTests(fn: Notifier): Notifier {
  const prev = send;
  send = fn;
  return prev;
}
const MAX_PENDING_PER_PAGE = 200;

export interface AccessRequest {
  userId: string;
  name: string;
  at: number;
}

function titleOf(ws: string, noteId: string): string {
  const r = sql("SELECT json_extract(json, '$.title') AS t FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, noteId) as { t: string | null } | undefined;
  return String(r?.t ?? "").slice(0, 280);
}

/** The people with full access to a page (who may approve). */
export function approversOf(ws: string, noteId: string): string[] {
  return principals(ws).filter((u) => new AccessResolver(ws, u).level(noteId) === "full");
}

/**
 * Asks for access. "has": the person can already read the page; "requested":
 * the request stands (asking again only refreshes it). A page that does not
 * exist answers "requested" too, so links tell nothing about what exists.
 */
export function requestAccess(ws: string, noteId: string, userId: string, now = Date.now()): "has" | "requested" {
  const exists = Boolean(sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, noteId));
  if (!exists) return "requested";
  if (new AccessResolver(ws, userId).level(noteId) !== null) return "has";
  const had = sql("SELECT at FROM note_access_requests WHERE ws = ? AND note_id = ? AND user_id = ?").get(ws, noteId, userId) as { at: number } | undefined;
  if (!had) {
    const n = sql("SELECT COUNT(*) AS n FROM note_access_requests WHERE ws = ? AND note_id = ?").get(ws, noteId) as { n: number };
    if (Number(n.n) >= MAX_PENDING_PER_PAGE) return "requested";
  }
  sql("INSERT INTO note_access_requests (ws, note_id, user_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(ws, note_id, user_id) DO UPDATE SET at = excluded.at").run(ws, noteId, userId, now);
  // A repeated request within a day does not ring again.
  if (!had || now - had.at > 86_400_000) {
    for (const u of approversOf(ws, noteId).slice(0, MAX_NOTIFIED)) send(u, { ws, kind: "invite", ref: `note:${noteId}`, by: userId, text: notesT(userLocale(u), "access.inboxRequested") });
  }
  audit(userId, "page.access.request", ws);
  return "requested";
}

export function requestsOf(ws: string, noteId: string): AccessRequest[] {
  return (
    sql("SELECT r.user_id, r.at, u.name FROM note_access_requests r JOIN users u ON u.id = r.user_id WHERE r.ws = ? AND r.note_id = ? ORDER BY r.at, r.rowid").all(ws, noteId) as {
      user_id: string;
      at: number;
      name: string;
    }[]
  ).map((r) => ({ userId: r.user_id, name: r.name, at: Number(r.at) }));
}

/** Approves (with a level) or declines a request; the requester hears of an approval. */
export function answerRequest(ws: string, noteId: string, userId: string, actor: string, level: AccessLevel | null): boolean {
  const had = sql("DELETE FROM note_access_requests WHERE ws = ? AND note_id = ? AND user_id = ?").run(ws, noteId, userId);
  if (Number(had.changes) === 0) return false;
  if (level) {
    if (!atLeast(new AccessResolver(ws, userId).level(noteId), level)) grant(ws, noteId, userId, level, actor);
    send(userId, { ws, kind: "invite", ref: `note:${noteId}`, by: actor, text: titleOf(ws, noteId) });
    audit(actor, "page.access.approve", ws, { level });
  } else audit(actor, "page.access.decline", ws);
  return true;
}
