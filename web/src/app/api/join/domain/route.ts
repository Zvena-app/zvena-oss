import { syncWorkspaceDesignLater } from "@/lib/design-sync";
import { joinableWorkspaces, joinByDomain } from "@/lib/enterprise/join";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { LimitError } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// Workspaces open to the person's e-mail domain ("Allowed e-mail domains").
// GET            → { workspaces: [{ id, name, members, domain }] }
// POST { ws }    → { wsId, role }   joins with the role the owner chose

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  return json({ workspaces: joinableWorkspaces(me.user.id) });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "ws-invite");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const p = await readJsonCapped(req, 1_000);
  const ws = p.ok ? (p.value as { ws?: unknown }).ws : undefined;
  if (typeof ws !== "string" || !/^[A-Za-z0-9_-]{8,40}$/.test(ws)) return fail(400, "bad request");
  try {
    const r = joinByDomain(me.user.id, ws);
    if (!r) return fail(403, "not open to your domain");
    syncWorkspaceDesignLater(r.wsId);
    return json(r);
  } catch (e) {
    if (e instanceof LimitError) return fail(409, `limit:${e.what}`);
    throw e;
  }
}
