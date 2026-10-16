// Workspaces (teams): one shared space for Documents and Design.
//
// Every account gets a personal workspace at sign-up. Shared workspaces have
// members with roles; the same roles apply to documents (here) and designs
// (the workspace's Penpot team, kept in step by src/lib/penpot.ts):
//
//   owner     — everything, incl. members, invite links, deleting the workspace
//   editor    — creates and edits documents and designs
//   commenter — reads and comments
//   viewer    — reads only
//
// People join through invite links (a random token; only its HMAC is stored).

import { randomBytes } from "node:crypto";
import { mac } from "./auth";
import { config } from "./config";
import { dropWorkspaceIntegrations } from "./notes/api/integrations";
import { dropFollows } from "./notes/follows";
import { dropTeamspaceArchive } from "./notes/teamspace-archive";
import { audit, newId, sql, tx } from "./store";
import { accessChanged } from "./notes/access-events";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];
export const INVITE_ROLES: readonly Exclude<Role, "owner">[] = ["editor", "commenter", "viewer"];

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  personal: boolean;
  penpotTeamId: string | null;
  createdAt: number;
  role: Role;
  members: number;
}

export interface Member {
  userId: string;
  name: string;
  role: Role;
  since: number;
  avatar?: string;
}

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export const can = {
  read: (r: Role | null) => r !== null,
  comment: (r: Role | null) => r === "owner" || r === "editor" || r === "commenter",
  edit: (r: Role | null) => r === "owner" || r === "editor",
  manage: (r: Role | null) => r === "owner",
};

interface WsRow {
  id: string;
  name: string;
  owner_id: string;
  personal: number;
  penpot_team_id: string | null;
  created_at: number;
  role: Role;
  members: number;
}

function toWs(r: WsRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    personal: r.personal === 1,
    penpotTeamId: r.penpot_team_id,
    createdAt: r.created_at,
    role: r.role,
    members: Number(r.members),
  };
}

const WS_SELECT = `SELECT w.id, w.name, w.owner_id, w.personal, w.penpot_team_id, w.created_at, m.role,
  (SELECT COUNT(*) FROM members x WHERE x.ws_id = w.id) AS members
  FROM workspaces w JOIN members m ON m.ws_id = w.id AND m.user_id = ?`;

/** The person's workspaces: personal first, then by creation. */
export function workspacesOf(userId: string): Workspace[] {
  return (sql(`${WS_SELECT} ORDER BY w.personal DESC, w.created_at ASC`).all(userId) as unknown as WsRow[]).map(toWs);
}

export function workspaceFor(userId: string, wsId: string): Workspace | null {
  const r = sql(`${WS_SELECT} WHERE w.id = ?`).get(userId, wsId) as WsRow | undefined;
  return r ? toWs(r) : null;
}

export function roleIn(userId: string, wsId: string): Role | null {
  const r = sql("SELECT role FROM members WHERE ws_id = ? AND user_id = ?").get(wsId, userId) as { role: Role } | undefined;
  return r?.role ?? null;
}

/** The personal workspace (created on first need). */
export function personalWorkspace(userId: string, name: string): Workspace {
  const row = sql("SELECT id FROM workspaces WHERE owner_id = ? AND personal = 1").get(userId) as { id: string } | undefined;
  if (row) return workspaceFor(userId, row.id) as Workspace;
  return createWorkspace(userId, name, true);
}

export function createWorkspace(userId: string, name: string, personal = false): Workspace {
  const clean = name.trim().slice(0, 80) || "Workspace";
  return tx(() => {
    if (!personal && config.maxWorkspaces > 0) {
      const n = sql("SELECT COUNT(*) AS n FROM workspaces WHERE owner_id = ? AND personal = 0").get(userId) as { n: number };
      if (Number(n.n) >= config.maxWorkspaces) throw new LimitError("workspaces");
    }
    const id = newId(12);
    const now = Date.now();
    sql("INSERT INTO workspaces (id, name, owner_id, personal, created_at) VALUES (?, ?, ?, ?, ?)").run(id, clean, userId, personal ? 1 : 0, now);
    sql("INSERT INTO members (ws_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, userId, now);
    audit(userId, "workspace.create", id);
    return workspaceFor(userId, id) as Workspace;
  });
}

export class LimitError extends Error {
  constructor(public what: "workspaces" | "members" | "storage" | "editors") {
    super(`limit: ${what}`);
  }
}

export function renameWorkspace(wsId: string, name: string): void {
  const clean = name.trim().slice(0, 80);
  if (clean) sql("UPDATE workspaces SET name = ? WHERE id = ?").run(clean, wsId);
}

/** The workspace whose Design team is `teamId`, if the person is a member. */
export function workspaceOfTeam(userId: string, teamId: string | null | undefined): string | null {
  if (!teamId || !/^[0-9a-f-]{36}$/.test(teamId)) return null;
  const r = sql("SELECT w.id FROM workspaces w JOIN members m ON m.ws_id = w.id AND m.user_id = ? WHERE w.penpot_team_id = ?").get(userId, teamId) as { id: string } | undefined;
  return r?.id ?? null;
}

export function setPenpotTeam(wsId: string, teamId: string): void {
  sql("UPDATE workspaces SET penpot_team_id = ? WHERE id = ?").run(teamId, wsId);
}

export function membersOf(wsId: string): Member[] {
  return (
    sql(
      "SELECT m.user_id, u.name, u.avatar, m.role, m.created_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.ws_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'commenter' THEN 2 ELSE 3 END, m.created_at"
    ).all(wsId) as { user_id: string; name: string; avatar: string | null; role: Role; created_at: number }[]
  ).map((r) => ({ userId: r.user_id, name: r.name, role: r.role, since: r.created_at, ...(r.avatar && /^https:\/\//.test(r.avatar) ? { avatar: r.avatar } : {}) }));
}

/** Changes a member's role (not the owner's; ownership moves with transferOwnership). */
export function setRole(actor: string, wsId: string, userId: string, role: Exclude<Role, "owner">): boolean {
  const cur = roleIn(userId, wsId);
  if (!cur || cur === "owner") return false;
  sql("UPDATE members SET role = ? WHERE ws_id = ? AND user_id = ?").run(role, wsId, userId);
  audit(actor, "member.role", wsId, { user: userId, role });
  accessChanged(wsId);
  return true;
}

export function removeMember(actor: string, wsId: string, userId: string): boolean {
  const cur = roleIn(userId, wsId);
  if (!cur || cur === "owner") return false;
  tx(() => {
    sql("DELETE FROM members WHERE ws_id = ? AND user_id = ?").run(wsId, userId);
    // Page shares and teamspaces go with the membership (no way back in as a "guest").
    sql("DELETE FROM note_grants WHERE ws = ? AND user_id = ?").run(wsId, userId);
    sql("DELETE FROM note_revoked WHERE ws = ? AND user_id = ?").run(wsId, userId);
    sql("DELETE FROM teamspace_members WHERE user_id = ? AND ts_id IN (SELECT id FROM teamspaces WHERE ws = ?)").run(userId, wsId);
    // …and so do the workspace's groups.
    sql("DELETE FROM ws_group_members WHERE user_id = ? AND group_id IN (SELECT id FROM ws_groups WHERE ws = ?)").run(userId, wsId);
  });
  audit(actor, actor === userId ? "member.leave" : "member.remove", wsId, { user: userId });
  accessChanged(wsId);
  return true;
}

export function transferOwnership(actor: string, wsId: string, to: string): boolean {
  return tx(() => {
    const ws = sql("SELECT owner_id, personal FROM workspaces WHERE id = ?").get(wsId) as { owner_id: string; personal: number } | undefined;
    if (!ws || ws.personal || ws.owner_id !== actor || !roleIn(to, wsId)) return false;
    sql("UPDATE members SET role = 'editor' WHERE ws_id = ? AND user_id = ?").run(wsId, actor);
    sql("UPDATE members SET role = 'owner' WHERE ws_id = ? AND user_id = ?").run(wsId, to);
    sql("UPDATE workspaces SET owner_id = ? WHERE id = ?").run(to, wsId);
    audit(actor, "workspace.transfer", wsId, { to });
    return true;
  });
}

/** Deletes the workspace with its documents, public links and forms (designs: the caller deletes the Penpot team). */
export function deleteWorkspace(actor: string, wsId: string): void {
  tx(() => {
    sql("DELETE FROM notes WHERE ws = ?").run(wsId);
    sql("DELETE FROM note_shares WHERE ws = ?").run(wsId);
    sql("DELETE FROM note_forms WHERE ws = ?").run(wsId);
    sql("DELETE FROM presence WHERE ws = ?").run(wsId);
    sql("DELETE FROM note_favorites WHERE ws = ?").run(wsId);
    // Page history, its events and page views go with the documents.
    sql("DELETE FROM note_versions WHERE ws = ?").run(wsId);
    sql("DELETE FROM note_events WHERE ws = ?").run(wsId);
    sql("DELETE FROM note_views WHERE ws = ?").run(wsId);
    dropWorkspaceIntegrations(wsId);
    dropFollows(wsId);
    dropTeamspaceArchive(wsId);
    sql("DELETE FROM custom_emoji WHERE ws = ?").run(wsId);
    sql("DELETE FROM note_ydocs WHERE ws = ?").run(wsId);
    for (const t of ["note_access", "note_grants", "note_revoked", "page_invites", "note_group_grants", "note_access_requests", "note_verify_notices", "ws_groups"]) sql(`DELETE FROM ${t} WHERE ws = ?`).run(wsId);
    sql("DELETE FROM teamspaces WHERE ws = ?").run(wsId);
    sql("DELETE FROM workspaces WHERE id = ?").run(wsId);
  });
  audit(actor, "workspace.delete", wsId);
}

// --- Invite links -------------------------------------------------------------

export interface Invite {
  id: string;
  role: Exclude<Role, "owner">;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

/** A new invite link token (shown once; only its HMAC is stored). */
export function createInvite(actor: string, wsId: string, role: Exclude<Role, "owner">, opts: { days?: number; maxUses?: number } = {}): { token: string; invite: Invite } {
  const token = randomBytes(18).toString("base64url");
  const id = mac("invite", token);
  const now = Date.now();
  const days = Math.min(Math.max(opts.days ?? config.inviteDays, 1), 90);
  const maxUses = Math.min(Math.max(opts.maxUses ?? 50, 1), 1000);
  sql("INSERT INTO invites (id, ws_id, role, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, wsId, role, actor, now, now + days * 86_400_000, maxUses);
  audit(actor, "invite.create", wsId, { role });
  return { token, invite: { id, role, createdAt: now, expiresAt: now + days * 86_400_000, maxUses, uses: 0 } };
}

export function invitesOf(wsId: string): Invite[] {
  return (
    sql("SELECT id, role, created_at, expires_at, max_uses, uses FROM invites WHERE ws_id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses ORDER BY created_at DESC").all(
      wsId,
      Date.now()
    ) as { id: string; role: Exclude<Role, "owner">; created_at: number; expires_at: number; max_uses: number; uses: number }[]
  ).map((r) => ({ id: r.id, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at, maxUses: r.max_uses, uses: r.uses }));
}

export function revokeInvite(actor: string, wsId: string, inviteId: string): boolean {
  const ok = Number(sql("UPDATE invites SET revoked_at = ? WHERE id = ? AND ws_id = ? AND revoked_at IS NULL").run(Date.now(), inviteId, wsId).changes) > 0;
  if (ok) audit(actor, "invite.revoke", wsId);
  return ok;
}

export interface InvitePreview {
  wsId: string;
  wsName: string;
  role: Exclude<Role, "owner">;
  members: number;
}

function liveInvite(token: string): { id: string; ws_id: string; role: Exclude<Role, "owner"> } | null {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  const r = sql("SELECT id, ws_id, role FROM invites WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses").get(mac("invite", token), Date.now()) as
    | { id: string; ws_id: string; role: Exclude<Role, "owner"> }
    | undefined;
  return r ?? null;
}

export function previewInvite(token: string): InvitePreview | null {
  const inv = liveInvite(token);
  if (!inv) return null;
  const ws = sql("SELECT name, (SELECT COUNT(*) FROM members WHERE ws_id = ?) AS n FROM workspaces WHERE id = ?").get(inv.ws_id, inv.ws_id) as { name: string; n: number } | undefined;
  return ws ? { wsId: inv.ws_id, wsName: ws.name, role: inv.role, members: Number(ws.n) } : null;
}

/** Joins the workspace (an existing member keeps the higher of the two roles). */
export function acceptInvite(userId: string, token: string): { wsId: string; role: Role } | null {
  return tx(() => {
    const inv = liveInvite(token);
    if (!inv) return null;
    const cur = roleIn(userId, inv.ws_id);
    if (cur) {
      const rank = (r: Role) => ROLES.indexOf(r);
      if (rank(inv.role) < rank(cur)) sql("UPDATE members SET role = ? WHERE ws_id = ? AND user_id = ?").run(inv.role, inv.ws_id, userId);
      return { wsId: inv.ws_id, role: rank(inv.role) < rank(cur) ? inv.role : cur };
    }
    if (config.maxMembers > 0) {
      const n = sql("SELECT COUNT(*) AS n FROM members WHERE ws_id = ?").get(inv.ws_id) as { n: number };
      if (Number(n.n) >= config.maxMembers) throw new LimitError("members");
    }
    sql("INSERT INTO members (ws_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(inv.ws_id, userId, inv.role, Date.now());
    sql("UPDATE invites SET uses = uses + 1 WHERE id = ?").run(inv.id);
    audit(userId, "invite.accept", inv.ws_id, { role: inv.role });
    return { wsId: inv.ws_id, role: inv.role };
  });
}
