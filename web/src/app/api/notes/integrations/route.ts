import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { createIntegration, IntegrationForbiddenError, IntegrationLimitError, integrationView, listIntegrations, revokeIntegration, rotateSecret, updateIntegration } from "@/lib/notes/api/integrations";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { docsPresence } from "@/lib/notes/access";

export const dynamic = "force-dynamic";

// Integrations of a workspace (Notion's "Develop or manage integrations").
// GET    ?ws=                                   → { integrations }  (members: names and icons; capabilities and webhooks only for
//                                                   the integration's maker and the workspace's owner)
// POST   ?ws= { name, icon, caps }              → { integration, secret }        (editors; the secret is shown once)
// PATCH  ?ws= { id, name?, icon?, caps?, webhook?: { url, events } | null, rotate?: true }   (its maker or the owner)
//                                               → { integration, secret?, webhookSecret? }
// DELETE ?ws= { id }                            → { ok }  (its maker or the owner; revokes: the token stops working, connections go)

async function body(req: Request): Promise<Record<string, unknown>> {
  const p = await readJsonCapped(req, 10_000);
  return p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  const role = access(me.user.id, ws, "read");
  // A guest sees the pages shared with them, not the workspace's connections (their names show as "Integration").
  if (!role) return docsPresence(me.user.id, ws) ? json({ integrations: [] }) : fail(403, "forbidden");
  const list = listIntegrations(ws as string);
  return json({ integrations: list.map((i) => integrationView(me.user.id, ws as string, i)) });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "edit")) return fail(403, "forbidden");
  const b = await body(req);
  try {
    return json(createIntegration(me.user.id, ws as string, { name: b.name, icon: b.icon, caps: b.caps }));
  } catch (e) {
    if (e instanceof IntegrationLimitError) return fail(409, "too many integrations");
    return fail(503, "unavailable");
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
  if (!access(me.user.id, ws, "edit")) return fail(403, "forbidden");
  const b = await body(req);
  if (typeof b.id !== "string") return fail(400, "bad request");
  try {
    const webhook = b.webhook === null ? null : typeof b.webhook === "object" ? (b.webhook as { url?: unknown; events?: unknown }) : undefined;
    const out = updateIntegration(me.user.id, ws as string, b.id, { name: b.name, icon: b.icon, caps: b.caps, ...(webhook !== undefined ? { webhook } : {}) });
    if (!out) return fail(404, "not found");
    const secret = b.rotate === true ? rotateSecret(me.user.id, ws as string, b.id) : null;
    return json({ ...out, ...(secret ? { secret } : {}) });
  } catch (e) {
    if (e instanceof IntegrationForbiddenError) return fail(403, "forbidden");
    if (e instanceof Error && e.message === "bad webhook url") return fail(400, "webhook url must be https");
    return fail(503, "unavailable");
  }
}

export async function DELETE(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "edit")) return fail(403, "forbidden");
  const b = await body(req);
  if (typeof b.id !== "string") return fail(400, "bad request");
  try {
    return json({ ok: revokeIntegration(me.user.id, ws as string, b.id) });
  } catch (e) {
    if (e instanceof IntegrationForbiddenError) return fail(403, "forbidden");
    throw e;
  }
}
