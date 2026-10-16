import { syncWorkspaceDesignLater } from "@/lib/design-sync";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { acceptInvite, LimitError } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// POST { token } — joins the workspace of an invite link → { wsId, role }.
export async function POST(req: Request) {
  const rl = rateLimited(req, "ws-invite");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const p = await readJsonCapped(req, 2_000);
  const token = p.ok ? (p.value as { token?: unknown }).token : undefined;
  if (typeof token !== "string") return fail(400, "bad request");
  try {
    const r = acceptInvite(me.user.id, token);
    if (!r) return fail(410, "invalid");
    syncWorkspaceDesignLater(r.wsId);
    return json(r);
  } catch (e) {
    if (e instanceof LimitError) return fail(409, `limit:${e.what}`);
    throw e;
  }
}
