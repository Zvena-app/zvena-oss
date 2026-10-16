import { syncWorkspaceDesign, syncWorkspaceDesignLater } from "@/lib/design-sync";
import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { deleteTeam, designConfigured } from "@/lib/penpot";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { sql } from "@/lib/store";
import { createWorkspace, deleteWorkspace, LimitError, renameWorkspace, workspacesOf } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// Workspaces of the signed-in person.
// GET                    → { workspaces }
// POST   { name }        → { workspace }          (anyone signed in)
// PATCH  ?ws= { name }   → { ok }                 (owner)
// DELETE ?ws=            → { ok }                 (owner; not the personal one)

async function body(req: Request): Promise<Record<string, unknown>> {
  const p = await readJsonCapped(req, 4_000);
  return p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  return json({ workspaces: workspacesOf(me.user.id) });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const { name } = await body(req);
  if (typeof name !== "string" || !name.trim()) return fail(400, "name required");
  try {
    const ws = createWorkspace(me.user.id, name);
    syncWorkspaceDesignLater(ws.id);
    return json({ workspace: ws });
  } catch (e) {
    if (e instanceof LimitError) return fail(409, `limit:${e.what}`);
    throw e;
  }
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
  const { name } = await body(req);
  if (typeof name !== "string" || !name.trim()) return fail(400, "name required");
  renameWorkspace(ws as string, name);
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
  if (!access(me.user.id, ws, "manage")) return fail(403, "forbidden");
  const row = sql("SELECT personal, penpot_team_id FROM workspaces WHERE id = ?").get(ws) as { personal: number; penpot_team_id: string | null } | undefined;
  if (!row || row.personal) return fail(400, "the personal workspace cannot be deleted");
  // Design first: if it is down, nothing is deleted and the owner can retry.
  if (row.penpot_team_id && designConfigured()) {
    try {
      await syncWorkspaceDesign(ws as string);
      await deleteTeam(row.penpot_team_id);
    } catch {
      return fail(503, "design unavailable");
    }
  }
  deleteWorkspace(me.user.id, ws as string);
  return json({ ok: true });
}
