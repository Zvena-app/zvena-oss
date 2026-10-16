// Server-only: groups of a workspace's members (Notion: Settings → Members →
// Groups). The workspace owner manages them; pages (note_group_grants) and
// teamspaces (teamspace_groups) can be shared with a group, and every member
// of the group gets that access (lib/notes/access.ts). Changing who is in a
// group, or deleting it, settles access on everything shared with it, so
// devices pull what they gained and drop what they lost.

import { randomBytes } from "node:crypto";
import { audit, sql } from "../store";
import { roleIn } from "../workspaces";
import { changeAccess } from "./access";

export interface WsGroup {
  id: string;
  name: string;
  members: string[];
  createdAt: number;
}

export class GroupError extends Error {}

const MAX_GROUPS = 200;
const MAX_MEMBERS = 1000;
export const GROUP_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

export function groupsOf(ws: string): WsGroup[] {
  const groups = sql("SELECT id, name, created_at FROM ws_groups WHERE ws = ? ORDER BY name COLLATE NOCASE").all(ws) as { id: string; name: string; created_at: number }[];
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.created_at,
    members: (sql("SELECT user_id FROM ws_group_members WHERE group_id = ? ORDER BY created_at").all(g.id) as { user_id: string }[]).map((r) => r.user_id),
  }));
}

export function groupOf(ws: string, id: string): { id: string; name: string } | null {
  if (!GROUP_ID_RE.test(id)) return null;
  return (sql("SELECT id, name FROM ws_groups WHERE ws = ? AND id = ?").get(ws, id) as { id: string; name: string } | undefined) ?? null;
}

/** Everything whose access depends on the group: pages shared with it and the top-level pages of its teamspaces. */
export function groupRoots(ws: string, groupId: string): string[] {
  const pages = (sql("SELECT note_id FROM note_group_grants WHERE ws = ? AND group_id = ?").all(ws, groupId) as { note_id: string }[]).map((r) => r.note_id);
  const spaces = (sql("SELECT ts_id FROM teamspace_groups WHERE group_id = ?").all(groupId) as { ts_id: string }[]).map((r) => `ts:${r.ts_id}`);
  const tops = spaces.length
    ? (sql(`SELECT id FROM notes WHERE ws = ? AND parent_id IS NULL AND deleted = 0 AND space IN (${spaces.map(() => "?").join(", ")})`).all(ws, ...spaces) as { id: string }[]).map((r) => r.id)
    : [];
  return [...new Set([...pages, ...tops])];
}

export function createGroup(ws: string, actor: string, name: string): WsGroup {
  const clean = name.trim().slice(0, 100);
  if (!clean) throw new GroupError("name required");
  const n = sql("SELECT COUNT(*) AS n FROM ws_groups WHERE ws = ?").get(ws) as { n: number };
  if (Number(n.n) >= MAX_GROUPS) throw new GroupError("too many groups");
  const id = randomBytes(12).toString("base64url");
  const now = Date.now();
  sql("INSERT INTO ws_groups (id, ws, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, ws, clean, actor, now);
  audit(actor, "group.create", ws);
  return { id, name: clean, members: [], createdAt: now };
}

export function renameGroup(ws: string, id: string, actor: string, name: string): void {
  const clean = name.trim().slice(0, 100);
  if (!clean || !groupOf(ws, id)) throw new GroupError("not found");
  sql("UPDATE ws_groups SET name = ? WHERE id = ?").run(clean, id);
  audit(actor, "group.rename", ws);
}

export function deleteGroup(ws: string, id: string, actor: string): void {
  if (!groupOf(ws, id)) throw new GroupError("not found");
  changeAccess(ws, groupRoots(ws, id), () => {
    sql("DELETE FROM note_group_grants WHERE group_id = ?").run(id);
    sql("DELETE FROM teamspace_groups WHERE group_id = ?").run(id);
    sql("DELETE FROM ws_group_members WHERE group_id = ?").run(id);
    sql("DELETE FROM ws_groups WHERE id = ?").run(id);
  });
  audit(actor, "group.delete", ws);
}

export function addGroupMember(ws: string, id: string, actor: string, userId: string): void {
  if (!groupOf(ws, id)) throw new GroupError("not found");
  // Groups hold workspace members only (guests get pages, not groups).
  if (!roleIn(userId, ws)) throw new GroupError("not a member");
  const n = sql("SELECT COUNT(*) AS n FROM ws_group_members WHERE group_id = ?").get(id) as { n: number };
  if (Number(n.n) >= MAX_MEMBERS) throw new GroupError("too many members");
  changeAccess(ws, groupRoots(ws, id), () => {
    sql("INSERT INTO ws_group_members (group_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(id, userId, Date.now());
  });
  audit(actor, "group.member.add", ws);
}

export function removeGroupMember(ws: string, id: string, actor: string, userId: string): void {
  if (!groupOf(ws, id)) throw new GroupError("not found");
  changeAccess(ws, groupRoots(ws, id), () => {
    sql("DELETE FROM ws_group_members WHERE group_id = ? AND user_id = ?").run(id, userId);
  });
  audit(actor, "group.member.remove", ws);
}

/** A member leaving the workspace leaves its groups too (call inside the change that settles access). */
export function dropFromGroups(ws: string, userId: string): void {
  sql("DELETE FROM ws_group_members WHERE user_id = ? AND group_id IN (SELECT id FROM ws_groups WHERE ws = ?)").run(userId, ws);
}

/** The groups a person is in. */
export function groupIdsOf(ws: string, userId: string): string[] {
  return (sql("SELECT m.group_id FROM ws_group_members m JOIN ws_groups g ON g.id = m.group_id WHERE g.ws = ? AND m.user_id = ?").all(ws, userId) as { group_id: string }[]).map((r) => r.group_id);
}

/** Every group of the workspace with ids only (pickers on the client). */
export function groupBriefs(ws: string): { id: string; name: string; members: number }[] {
  return (
    sql("SELECT g.id, g.name, (SELECT COUNT(*) FROM ws_group_members m WHERE m.group_id = g.id) AS n FROM ws_groups g WHERE g.ws = ? ORDER BY g.name COLLATE NOCASE").all(ws) as {
      id: string;
      name: string;
      n: number;
    }[]
  ).map((g) => ({ id: g.id, name: g.name, members: Number(g.n) }));
}
