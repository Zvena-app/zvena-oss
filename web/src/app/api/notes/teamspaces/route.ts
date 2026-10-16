import { crossSite, currentUser, fail, json } from "@/lib/http";
import { atLeast, roleLevel } from "@/lib/notes/access";
import { addTeamspaceGroup, addTeamspaceMember, canManageTeamspace, createTeamspace, deleteTeamspace, isPrivacy, joinTeamspace, removeTeamspaceGroup, removeTeamspaceMember, TeamspaceError, teamspaceGroups, teamspaceMembers, teamspaceOf, teamspacesOf, updateTeamspace } from "@/lib/notes/teamspaces";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { sql } from "@/lib/store";
import { roleIn } from "@/lib/workspaces";
import { setTeamspaceArchived } from "@/lib/notes/teamspace-archive";


export const dynamic = "force-dynamic";

// Teamspaces of a workspace (Notion). Members of the workspace only.
// GET  ?ws=                     → { teamspaces, canCreate }
// GET  ?ws=&id=                 → { members: [{ userId, name, role }], canManage }
// POST ?ws= { op: "create", name, icon?, privacy }          (editors and the owner)
// POST ?ws= { op: "update", id, name?, icon?, privacy? }     (the teamspace's owners, the workspace owner)
// POST ?ws= { op: "delete", id }                             (same; only an empty teamspace)
// POST ?ws= { op: "add", id, userId, role? }                 (same)
// POST ?ws= { op: "remove", id, userId }                     (same, or oneself: leave)
// POST ?ws= { op: "join", id }                               (anyone in the workspace; open teamspaces)

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const u = new URL(req.url);
  const ws = u.searchParams.get("ws") ?? "";
  const role = roleIn(me.user.id, ws);
  if (!role) return fail(403, "forbidden");
  const id = u.searchParams.get("id");
  if (id) {
    const ts = teamspacesOf(ws, me.user.id).find((t) => t.id === id);
    if (!ts) return fail(404, "not found");
    const members = teamspaceMembers(ws, id).map((m) => ({
      ...m,
      name: (sql("SELECT name FROM users WHERE id = ?").get(m.userId) as { name: string } | undefined)?.name ?? "",
    }));
    return json({ members, groups: teamspaceGroups(ws, id), canManage: canManageTeamspace(ws, id, me.user.id) });
  }
  return json({ teamspaces: teamspacesOf(ws, me.user.id), canCreate: atLeast(roleLevel(role), "edit") });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws") ?? "";
  const role = roleIn(me.user.id, ws);
  if (!role) return fail(403, "forbidden");
  const p = await readJsonCapped(req, 4_000);
  const b = p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
  const id = typeof b.id === "string" ? b.id : "";
  try {
    if (b.op === "create") {
      if (!atLeast(roleLevel(role), "edit")) return fail(403, "forbidden");
      if (typeof b.name !== "string" || !b.name.trim()) return fail(400, "name required");
      return json({ teamspace: createTeamspace(ws, me.user.id, { name: b.name, ...(typeof b.icon === "string" ? { icon: b.icon } : {}), ...(isPrivacy(b.privacy) ? { privacy: b.privacy } : {}) }) });
    }
    if (!id || !teamspaceOf(ws, id)) return fail(404, "not found");
    if (b.op === "join") {
      joinTeamspace(ws, id, me.user.id);
      return json({ ok: true });
    }
    if (b.op === "remove" && b.userId === me.user.id) {
      removeTeamspaceMember(ws, id, me.user.id, me.user.id);
      return json({ ok: true });
    }
    if (!canManageTeamspace(ws, id, me.user.id)) return fail(403, "forbidden");
    if (b.op === "update") {
      updateTeamspace(ws, id, me.user.id, {
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.icon === "string" ? { icon: b.icon } : {}),
        ...(isPrivacy(b.privacy) ? { privacy: b.privacy } : {}),
      });
      return json({ ok: true });
    }
    if (b.op === "delete") {
      deleteTeamspace(ws, id, me.user.id);
      return json({ ok: true });
    }
    // Notion's "Archive teamspace": out of everyone's sidebar until a manager restores it.
    if (b.op === "archive" || b.op === "unarchive") {
      setTeamspaceArchived(ws, id, me.user.id, b.op === "archive");
      return json({ ok: true });
    }
    if (b.op === "add" && typeof b.userId === "string") {
      addTeamspaceMember(ws, id, me.user.id, b.userId, b.role === "owner" ? "owner" : "member");
      return json({ ok: true });
    }
    if (b.op === "remove" && typeof b.userId === "string") {
      removeTeamspaceMember(ws, id, me.user.id, b.userId);
      return json({ ok: true });
    }
    // A group as a whole (Notion: add a group to a teamspace).
    if (b.op === "addGroup" && typeof b.groupId === "string") {
      addTeamspaceGroup(ws, id, me.user.id, b.groupId);
      return json({ ok: true });
    }
    if (b.op === "removeGroup" && typeof b.groupId === "string") {
      removeTeamspaceGroup(ws, id, me.user.id, b.groupId);
      return json({ ok: true });
    }
  } catch (e) {
    if (e instanceof TeamspaceError) return fail(409, e.message);
    return fail(503, "unavailable");
  }
  return fail(400, "bad request");
}
