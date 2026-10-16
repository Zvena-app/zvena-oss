// Server-only: teamspaces (Notion) — groups of a workspace's top-level pages
// with their own members. Open: every member sees the pages (members of the
// teamspace edit them by role, others view and may join); closed: listed to
// everyone, pages for its members only; private: invisible to non-members.
// A teamspace's top-level pages carry space "ts:<id>" (lib/notes/access.ts).

import { randomBytes } from "node:crypto";
import { audit, sql, tx } from "../store";
import { roleIn } from "../workspaces";
import { changeAccess } from "./access";
import { archivedTeamspaces, dropTeamspaceArchive } from "./teamspace-archive";

export type TeamspacePrivacy = "open" | "closed" | "private";

export interface Teamspace {
  id: string;
  name: string;
  icon: string;
  privacy: TeamspacePrivacy;
  createdAt: number;
  /** The person's role in it (null: not a member). */
  role: "owner" | "member" | null;
  members: number;
  /** Archived (Notion): out of the sidebar, its pages where they were (lib/notes/teamspace-archive.ts). */
  archived?: boolean;
}

export interface TeamspaceMember {
  userId: string;
  role: "owner" | "member";
}

export const isPrivacy = (v: unknown): v is TeamspacePrivacy => v === "open" || v === "closed" || v === "private";

export class TeamspaceError extends Error {}

/** The teamspaces the person sees in the sidebar and in "Browse teamspaces". */
export function teamspacesOf(ws: string, userId: string): Teamspace[] {
  const owner = roleIn(userId, ws) === "owner";
  const rows = sql(
    `SELECT t.id, t.name, t.icon, t.privacy, t.created_at,
       COALESCE(m.role, CASE WHEN EXISTS (SELECT 1 FROM teamspace_groups tg JOIN ws_group_members gm ON gm.group_id = tg.group_id WHERE tg.ts_id = t.id AND gm.user_id = ?) THEN 'member' END) AS role,
       (SELECT COUNT(*) FROM teamspace_members x WHERE x.ts_id = t.id) AS members
     FROM teamspaces t LEFT JOIN teamspace_members m ON m.ts_id = t.id AND m.user_id = ?
     WHERE t.ws = ? ORDER BY t.created_at`
  ).all(userId, userId, ws) as { id: string; name: string; icon: string; privacy: TeamspacePrivacy; created_at: number; role: "owner" | "member" | null; members: number }[];
  const archived = archivedTeamspaces(ws);
  return rows
    .filter((r) => owner || r.role || r.privacy !== "private")
    .map((r) => ({ id: r.id, name: r.name, icon: r.icon, privacy: r.privacy, createdAt: r.created_at, role: r.role ?? null, members: Number(r.members), ...(archived.has(r.id) ? { archived: true } : {}) }));
}

export function teamspaceOf(ws: string, id: string): { id: string; privacy: TeamspacePrivacy; name: string } | null {
  return (sql("SELECT id, privacy, name FROM teamspaces WHERE ws = ? AND id = ?").get(ws, id) as { id: string; privacy: TeamspacePrivacy; name: string } | undefined) ?? null;
}

export function teamspaceMembers(ws: string, id: string): TeamspaceMember[] {
  return (
    sql("SELECT m.user_id, m.role FROM teamspace_members m JOIN teamspaces t ON t.id = m.ts_id WHERE t.ws = ? AND m.ts_id = ? ORDER BY m.role DESC, m.created_at").all(ws, id) as {
      user_id: string;
      role: "owner" | "member";
    }[]
  ).map((r) => ({ userId: r.user_id, role: r.role }));
}

/** The workspace owner or an owner of the teamspace. */
export function canManageTeamspace(ws: string, id: string, userId: string): boolean {
  if (roleIn(userId, ws) === "owner") return true;
  const r = sql("SELECT role FROM teamspace_members WHERE ts_id = ? AND user_id = ?").get(id, userId) as { role: string } | undefined;
  return r?.role === "owner" && Boolean(teamspaceOf(ws, id));
}

function rootsOf(ws: string, id: string): string[] {
  return (sql("SELECT id FROM notes WHERE ws = ? AND parent_id IS NULL AND space = ? AND deleted = 0").all(ws, `ts:${id}`) as { id: string }[]).map((r) => r.id);
}

export function createTeamspace(ws: string, userId: string, input: { name: string; icon?: string; privacy?: TeamspacePrivacy }): Teamspace {
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new TeamspaceError("name required");
  const count = sql("SELECT COUNT(*) AS n FROM teamspaces WHERE ws = ?").get(ws) as { n: number };
  if (Number(count.n) >= 200) throw new TeamspaceError("too many teamspaces");
  const id = randomBytes(12).toString("base64url");
  const now = Date.now();
  const privacy = input.privacy ?? "open";
  const icon = (input.icon ?? "").slice(0, 64);
  tx(() => {
    sql("INSERT INTO teamspaces (id, ws, name, icon, privacy, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, ws, name, icon, privacy, userId, now);
    sql("INSERT INTO teamspace_members (ts_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, userId, now);
  });
  audit(userId, "teamspace.create", ws);
  return { id, name, icon, privacy, createdAt: now, role: "owner", members: 1 };
}

export function updateTeamspace(ws: string, id: string, actor: string, patch: { name?: string; icon?: string; privacy?: TeamspacePrivacy }): void {
  const cur = teamspaceOf(ws, id);
  if (!cur) throw new TeamspaceError("not found");
  const apply = () => {
    if (patch.name !== undefined && patch.name.trim()) sql("UPDATE teamspaces SET name = ? WHERE id = ?").run(patch.name.trim().slice(0, 100), id);
    if (patch.icon !== undefined) sql("UPDATE teamspaces SET icon = ? WHERE id = ?").run(patch.icon.slice(0, 64), id);
    if (patch.privacy && patch.privacy !== cur.privacy) sql("UPDATE teamspaces SET privacy = ? WHERE id = ?").run(patch.privacy, id);
  };
  // Privacy decides who reads the teamspace's pages.
  if (patch.privacy && patch.privacy !== cur.privacy) changeAccess(ws, rootsOf(ws, id), apply);
  else apply();
  audit(actor, "teamspace.update", ws);
}

/** Only an empty teamspace goes (its pages would lose their place). */
export function deleteTeamspace(ws: string, id: string, actor: string): void {
  if (!teamspaceOf(ws, id)) throw new TeamspaceError("not found");
  if (rootsOf(ws, id).length) throw new TeamspaceError("not empty");
  sql("DELETE FROM teamspaces WHERE ws = ? AND id = ?").run(ws, id);
  dropTeamspaceArchive(ws, id);
  audit(actor, "teamspace.delete", ws);
}

export function addTeamspaceMember(ws: string, id: string, actor: string, userId: string, role: "owner" | "member" = "member"): void {
  if (!teamspaceOf(ws, id)) throw new TeamspaceError("not found");
  // Teamspaces hold workspace members only (guests get pages, not teamspaces).
  if (!roleIn(userId, ws)) throw new TeamspaceError("not a member");
  changeAccess(ws, rootsOf(ws, id), () => {
    sql("INSERT INTO teamspace_members (ts_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(ts_id, user_id) DO UPDATE SET role = excluded.role").run(id, userId, role, Date.now());
  });
  audit(actor, "teamspace.member", ws, { role });
}

export function removeTeamspaceMember(ws: string, id: string, actor: string, userId: string): void {
  if (!teamspaceOf(ws, id)) throw new TeamspaceError("not found");
  const owners = teamspaceMembers(ws, id).filter((m) => m.role === "owner");
  if (owners.length === 1 && owners[0].userId === userId) throw new TeamspaceError("last owner");
  changeAccess(ws, rootsOf(ws, id), () => {
    sql("DELETE FROM teamspace_members WHERE ts_id = ? AND user_id = ?").run(id, userId);
  });
  audit(actor, actor === userId ? "teamspace.leave" : "teamspace.remove", ws);
}

/** Groups placed in a teamspace: their members are its members (by their workspace role). */
export function teamspaceGroups(ws: string, id: string): { groupId: string; name: string }[] {
  return (
    sql("SELECT tg.group_id, g.name FROM teamspace_groups tg JOIN ws_groups g ON g.id = tg.group_id JOIN teamspaces t ON t.id = tg.ts_id WHERE t.ws = ? AND tg.ts_id = ? ORDER BY tg.created_at").all(ws, id) as {
      group_id: string;
      name: string;
    }[]
  ).map((r) => ({ groupId: r.group_id, name: r.name }));
}

export function addTeamspaceGroup(ws: string, id: string, actor: string, groupId: string): void {
  if (!teamspaceOf(ws, id)) throw new TeamspaceError("not found");
  if (!sql("SELECT 1 FROM ws_groups WHERE ws = ? AND id = ?").get(ws, groupId)) throw new TeamspaceError("no such group");
  changeAccess(ws, rootsOf(ws, id), () => {
    sql("INSERT INTO teamspace_groups (ts_id, group_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(id, groupId, Date.now());
  });
  audit(actor, "teamspace.group", ws);
}

export function removeTeamspaceGroup(ws: string, id: string, actor: string, groupId: string): void {
  if (!teamspaceOf(ws, id)) throw new TeamspaceError("not found");
  changeAccess(ws, rootsOf(ws, id), () => {
    sql("DELETE FROM teamspace_groups WHERE ts_id = ? AND group_id = ?").run(id, groupId);
  });
  audit(actor, "teamspace.group.remove", ws);
}

/** Anyone in the workspace may join an open teamspace. */
export function joinTeamspace(ws: string, id: string, userId: string): void {
  const ts = teamspaceOf(ws, id);
  if (!ts) throw new TeamspaceError("not found");
  if (ts.privacy !== "open" && roleIn(userId, ws) !== "owner") throw new TeamspaceError("closed");
  addTeamspaceMember(ws, id, userId, userId, "member");
}
