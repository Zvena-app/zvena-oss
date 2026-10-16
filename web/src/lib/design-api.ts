// Server-only helpers for the design routes of Documents: the person must be
// a member of the workspace, and the design must belong to its Design team.

import { access, currentUser, fail } from "./http";
import { designConfigured } from "./penpot";
import { syncWorkspaceDesign } from "./design-sync";
import { sql } from "./store";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function designContext(req: Request): Promise<{ userId: string; ws: string; teamId: string } | Response> {
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "read")) return fail(403, "forbidden");
  if (!designConfigured()) return fail(503, "design off");
  let teamId = (sql("SELECT penpot_team_id FROM workspaces WHERE id = ?").get(ws) as { penpot_team_id: string | null } | undefined)?.penpot_team_id ?? null;
  if (!teamId) {
    try {
      teamId = await syncWorkspaceDesign(ws as string);
    } catch {
      teamId = null;
    }
  }
  if (!teamId) return fail(503, "design unavailable");
  return { userId: me.user.id, ws: ws as string, teamId };
}
