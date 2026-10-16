import { syncWorkspaceDesignLater } from "@/lib/design-sync";
import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { INVITE_ROLES, invitesOf, membersOf, removeMember, setRole } from "@/lib/workspaces";
import { docsPresence, peopleSeenByGuest } from "@/lib/notes/access";
import { sql } from "@/lib/store";

export const dynamic = "force-dynamic";

// Members of a workspace.
// GET    ?ws=                    → { members, invites? }   (members; owners also get the invite links)
// PATCH  ?ws= { userId, role }   → { ok }                  (owner: editor | commenter | viewer)
// DELETE ?ws= { userId }         → { ok }                  (owner removes; anyone but the owner leaves)

async function body(req: Request): Promise<Record<string, unknown>> {
  const p = await readJsonCapped(req, 4_000);
  return p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  const role = access(me.user.id, ws, "read");
  if (!role) {
    // A guest (pages shared with them) sees the names of the people on those pages only.
    if (!docsPresence(me.user.id, ws)?.guest) return fail(403, "forbidden");
    const names = peopleSeenByGuest(ws as string, me.user.id)
      .map((id) => ({ userId: id, name: (sql("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | undefined)?.name }))
      .filter((m): m is { userId: string; name: string } => typeof m.name === "string");
    return json({ members: names });
  }
  return json({ members: membersOf(ws as string), ...(role === "owner" ? { invites: invitesOf(ws as string) } : {}) });
}

export async function PATCH(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "manage")) return fail(403, "forbidden");
  const { userId, role } = await body(req);
  if (typeof userId !== "string" || !(INVITE_ROLES as readonly unknown[]).includes(role)) return fail(400, "bad request");
  if (!setRole(me.user.id, ws as string, userId, role as (typeof INVITE_ROLES)[number])) return fail(400, "not a member");
  syncWorkspaceDesignLater(ws as string);
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  const { userId } = await body(req);
  if (typeof userId !== "string") return fail(400, "bad request");
  const self = userId === me.user.id;
  if (!access(me.user.id, ws, self ? "read" : "manage")) return fail(403, "forbidden");
  if (!removeMember(me.user.id, ws as string, userId)) return fail(400, "cannot remove");
  syncWorkspaceDesignLater(ws as string);
  return json({ ok: true });
}
