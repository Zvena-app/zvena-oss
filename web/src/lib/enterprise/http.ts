// Server-only: the guard of every enterprise settings route — a signed-in
// workspace owner, a same-origin request for changes, and (for identity:
// domains, SSO, SCIM) a shared workspace, never a personal one.

import type { AuthUser } from "../auth";
import { access, crossSite, currentUser, fail } from "../http";
import { rateLimited } from "../rate-limit";
import { readJsonCapped } from "../safe-json";
import { sql } from "../store";

export interface OwnerCtx {
  user: AuthUser;
  ws: string;
  personal: boolean;
}

export async function ownerOnly(req: Request, opts: { shared?: boolean; scope?: string } = {}): Promise<OwnerCtx | Response> {
  const rl = rateLimited(req, opts.scope ?? "ws", 120);
  if (rl) return rl;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const bad = crossSite(req);
    if (bad) return bad;
  }
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "manage")) return fail(403, "forbidden");
  const row = sql("SELECT personal FROM workspaces WHERE id = ?").get(ws) as { personal: number } | undefined;
  if (!row) return fail(404, "not found");
  if (opts.shared && row.personal) return fail(400, "a personal workspace has no identity settings");
  return { user: me.user, ws: ws as string, personal: row.personal === 1 };
}

export async function body(req: Request, max = 64_000): Promise<Record<string, unknown>> {
  const p = await readJsonCapped(req, max);
  return p.ok && typeof p.value === "object" && p.value !== null && !Array.isArray(p.value) ? (p.value as Record<string, unknown>) : {};
}
