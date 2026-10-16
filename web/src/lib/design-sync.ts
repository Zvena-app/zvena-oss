// Keeps a workspace's Penpot team in step with its members and roles.
// Called when Design opens and after every membership change (best effort:
// a failure is retried the next time Design opens).

import { getUser } from "./auth";
import { designConfigured, designLogin, ensureProfile, syncTeam } from "./penpot";
import { sql } from "./store";
import { membersOf, setPenpotTeam } from "./workspaces";

export async function syncWorkspaceDesign(wsId: string): Promise<string | null> {
  if (!designConfigured()) return null;
  const ws = sql("SELECT id, name, owner_id, personal, penpot_team_id FROM workspaces WHERE id = ?").get(wsId) as
    | { id: string; name: string; owner_id: string; personal: number; penpot_team_id: string | null }
    | undefined;
  if (!ws) return null;
  const members = membersOf(wsId);
  // Every member needs a Design profile before it can be put in the team.
  for (const m of members) {
    const u = getUser(m.userId);
    if (u) await ensureProfile(u);
  }
  let teamId = ws.penpot_team_id;
  if (!teamId && ws.personal) {
    // The personal workspace uses the profile's own default team.
    const owner = getUser(ws.owner_id);
    if (!owner) return null;
    teamId = (await ensureProfile(owner)).defaultTeamId;
  }
  const res = await syncTeam({
    teamId,
    name: ws.name,
    members: members.map((m) => ({ email: designLogin(m.userId), fullname: m.name, role: m.role })),
  });
  if (res.teamId !== ws.penpot_team_id) setPenpotTeam(wsId, res.teamId);
  return res.teamId;
}

/** Fire-and-forget variant for request handlers. */
export function syncWorkspaceDesignLater(wsId: string): void {
  void syncWorkspaceDesign(wsId).catch(() => {
    // Retried when Design opens next.
  });
}
