import { crossSite, currentUser, fail, json } from "@/lib/http";
import { addGroupMember, createGroup, deleteGroup, GroupError, groupBriefs, groupOf, groupsOf, removeGroupMember, renameGroup } from "@/lib/notes/groups";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { roleIn } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// Groups of a workspace's members (Notion: Settings → Members → Groups).
// GET  ?ws=                                    → { groups: [{ id, name, members }] }   members: names for the share picker;
//                                                 the owner also gets each group's member ids (`list`)
// POST ?ws= { op: "create", name }             → { group }   (workspace owner)
// POST ?ws= { op: "rename", id, name }         → { ok }
// POST ?ws= { op: "delete", id }               → { ok }
// POST ?ws= { op: "add" | "remove", id, userId } → { ok }

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws") ?? "";
  const role = roleIn(me.user.id, ws);
  // Guests do not see the workspace's groups.
  if (!role) return fail(403, "forbidden");
  return json({ groups: groupBriefs(ws), ...(role === "owner" ? { list: groupsOf(ws) } : {}) });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws") ?? "";
  if (roleIn(me.user.id, ws) !== "owner") return fail(403, "forbidden");
  const p = await readJsonCapped(req, 4_000);
  const b = p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
  try {
    if (b.op === "create" && typeof b.name === "string") return json({ group: createGroup(ws, me.user.id, b.name) });
    const id = typeof b.id === "string" ? b.id : "";
    if (!groupOf(ws, id)) return fail(404, "not found");
    if (b.op === "rename" && typeof b.name === "string") renameGroup(ws, id, me.user.id, b.name);
    else if (b.op === "delete") deleteGroup(ws, id, me.user.id);
    else if (b.op === "add" && typeof b.userId === "string") addGroupMember(ws, id, me.user.id, b.userId);
    else if (b.op === "remove" && typeof b.userId === "string") removeGroupMember(ws, id, me.user.id, b.userId);
    else return fail(400, "bad request");
    return json({ ok: true });
  } catch (e) {
    if (e instanceof GroupError) return fail(409, e.message);
    return fail(503, "unavailable");
  }
}
