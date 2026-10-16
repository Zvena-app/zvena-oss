import { syncWorkspaceDesignLater } from "@/lib/design-sync";
import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { transferOwnership } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// POST ?ws= { userId } — the owner hands the workspace to another member (who becomes owner; the old owner an editor).
export async function POST(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "manage")) return fail(403, "forbidden");
  const p = await readJsonCapped(req, 2_000);
  const userId = p.ok ? (p.value as { userId?: unknown }).userId : undefined;
  if (typeof userId !== "string" || !transferOwnership(me.user.id, ws as string, userId)) return fail(400, "bad request");
  syncWorkspaceDesignLater(ws as string);
  return json({ ok: true });
}
