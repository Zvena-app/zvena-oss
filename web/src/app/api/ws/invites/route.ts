import { config } from "@/lib/config";
import { canInvite } from "@/lib/enterprise/security";
import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { sql } from "@/lib/store";
import { createInvite, INVITE_ROLES, revokeInvite } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// Invite links of a shared workspace (owner; editors too when Settings → Security allows members to invite).
// POST   ?ws= { role, days?, maxUses? } → { url, invite }   (the link is shown once)
// DELETE ?ws= { id }                    → { ok }

async function body(req: Request): Promise<Record<string, unknown>> {
  const p = await readJsonCapped(req, 2_000);
  return p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "ws-invite");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!canInvite(me.user.id, ws)) return fail(403, "forbidden");
  const personal = sql("SELECT personal FROM workspaces WHERE id = ?").get(ws) as { personal: number } | undefined;
  if (!personal || personal.personal) return fail(400, "personal workspaces cannot be shared");
  const { role, days, maxUses } = await body(req);
  if (!(INVITE_ROLES as readonly unknown[]).includes(role)) return fail(400, "bad role");
  const { token, invite } = createInvite(me.user.id, ws as string, role as (typeof INVITE_ROLES)[number], {
    days: typeof days === "number" ? days : undefined,
    maxUses: typeof maxUses === "number" ? maxUses : undefined,
  });
  return json({ url: `${config.appUrl}/join/${token}`, invite });
}

export async function DELETE(req: Request) {
  const rl = rateLimited(req, "ws-invite");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "manage")) return fail(403, "forbidden");
  const { id } = await body(req);
  if (typeof id !== "string") return fail(400, "bad request");
  return json({ ok: revokeInvite(me.user.id, ws as string, id) });
}
