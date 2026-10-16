// Server-only: page invite links (Notion's "Share → invite" for people
// outside the workspace). Whoever opens the link signed in gets the link's
// level on that page and everything under it, as a guest — they see only
// those pages, never the rest of the workspace. Only the HMAC of the token
// is stored, like workspace invite links.

import { randomBytes } from "node:crypto";
import { mac } from "../auth";
import { audit, sql, tx } from "../store";
import { atLeast, grant, levelOf } from "./access";
import { sanitizeNote } from "./model";
import { inTrash } from "./server-store";
import type { AccessLevel, Note } from "./types";

export type InviteLevel = Exclude<AccessLevel, "full">;

export interface PageInvite {
  id: string;
  level: InviteLevel;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

export const isInviteLevel = (v: unknown): v is InviteLevel => v === "edit" || v === "comment" || v === "view";

export function createPageInvite(ws: string, noteId: string, actor: string, level: InviteLevel, opts: { days?: number; maxUses?: number } = {}): { token: string; invite: PageInvite } {
  const token = randomBytes(18).toString("base64url");
  const id = mac("page-invite", token);
  const now = Date.now();
  const days = Math.min(Math.max(Math.round(opts.days ?? 30), 1), 365);
  const maxUses = Math.min(Math.max(Math.round(opts.maxUses ?? 100), 1), 1000);
  const live = sql("SELECT COUNT(*) AS n FROM page_invites WHERE ws = ? AND note_id = ? AND revoked_at IS NULL AND expires_at > ?").get(ws, noteId, now) as { n: number };
  if (Number(live.n) >= 20) throw new Error("too many invites");
  sql("INSERT INTO page_invites (id, ws, note_id, level, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, ws, noteId, level, actor, now, now + days * 86_400_000, maxUses);
  audit(actor, "page.invite.create", ws, { level });
  return { token, invite: { id, level, createdAt: now, expiresAt: now + days * 86_400_000, maxUses, uses: 0 } };
}

export function pageInvitesOf(ws: string, noteId: string): PageInvite[] {
  return (
    sql("SELECT id, level, created_at, expires_at, max_uses, uses FROM page_invites WHERE ws = ? AND note_id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses ORDER BY created_at DESC").all(
      ws,
      noteId,
      Date.now()
    ) as { id: string; level: InviteLevel; created_at: number; expires_at: number; max_uses: number; uses: number }[]
  ).map((r) => ({ id: r.id, level: r.level, createdAt: r.created_at, expiresAt: r.expires_at, maxUses: r.max_uses, uses: r.uses }));
}

export function revokePageInvite(ws: string, noteId: string, id: string, actor: string): boolean {
  const ok = Number(sql("UPDATE page_invites SET revoked_at = ? WHERE id = ? AND ws = ? AND note_id = ? AND revoked_at IS NULL").run(Date.now(), id, ws, noteId).changes) > 0;
  if (ok) audit(actor, "page.invite.revoke", ws);
  return ok;
}

function liveInvite(token: string): { id: string; ws: string; note_id: string; level: InviteLevel } | null {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  const r = sql("SELECT id, ws, note_id, level, created_by FROM page_invites WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses").get(mac("page-invite", token), Date.now()) as
    | { id: string; ws: string; note_id: string; level: InviteLevel; created_by: string }
    | undefined;
  if (!r) return null;
  // A page deleted for good, or in the trash, takes its links with it.
  const row = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(r.ws, r.note_id) as { json: string | null } | undefined;
  let note: Note | null = null;
  try {
    note = sanitizeNote(JSON.parse(row?.json ?? "null"));
  } catch {
    note = null;
  }
  if (!note || inTrash(r.ws, note)) return null;
  // A link is only as good as its creator's say: who lost full access to the page (or left) can no longer open it to others.
  if (levelOf(r.ws, r.created_by, r.note_id) !== "full") return null;
  return { id: r.id, ws: r.ws, note_id: r.note_id, level: r.level };
}

export interface PageInvitePreview {
  ws: string;
  wsName: string;
  noteId: string;
  title: string;
  icon: string;
  level: InviteLevel;
}

export function previewPageInvite(token: string): PageInvitePreview | null {
  const inv = liveInvite(token);
  if (!inv) return null;
  const row = sql("SELECT w.name, json_extract(n.json, '$.title') AS title, json_extract(n.json, '$.icon') AS icon FROM workspaces w JOIN notes n ON n.ws = w.id AND n.id = ? WHERE w.id = ?").get(inv.note_id, inv.ws) as
    | { name: string; title: string | null; icon: string | null }
    | undefined;
  if (!row) return null;
  return { ws: inv.ws, wsName: row.name, noteId: inv.note_id, title: String(row.title ?? "").slice(0, 300), icon: String(row.icon ?? "").slice(0, 64), level: inv.level };
}

/** Opens the page to the person (a level they already have or exceed is kept). */
export function acceptPageInvite(userId: string, token: string): { ws: string; noteId: string; level: AccessLevel } | null {
  return tx(() => {
    const inv = liveInvite(token);
    if (!inv) return null;
    const cur = levelOf(inv.ws, userId, inv.note_id);
    if (!atLeast(cur, inv.level)) grant(inv.ws, inv.note_id, userId, inv.level, `invite:${inv.id.slice(0, 8)}`);
    sql("UPDATE page_invites SET uses = uses + 1 WHERE id = ?").run(inv.id);
    audit(userId, "page.invite.accept", inv.ws, { level: inv.level });
    return { ws: inv.ws, noteId: inv.note_id, level: atLeast(cur, inv.level) ? (cur as AccessLevel) : inv.level };
  });
}
