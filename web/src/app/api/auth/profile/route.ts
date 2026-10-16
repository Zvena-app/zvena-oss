import { renameUser } from "@/lib/auth";
import { syncWorkspaceDesignLater } from "@/lib/design-sync";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { workspacesOf } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// PATCH /api/auth/profile { name } — the display name (also shown in Design).
export async function PATCH(req: Request) {
  const rl = rateLimited(req, "auth-account");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const parsed = await readJsonCapped(req, 4_000);
  const name = parsed.ok ? (parsed.value as { name?: unknown }).name : undefined;
  if (typeof name !== "string" || !name.trim()) return fail(400, "bad request");
  renameUser(me.user.id, name);
  for (const w of workspacesOf(me.user.id)) syncWorkspaceDesignLater(w.id);
  return json({ ok: true });
}
