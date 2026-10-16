import { config } from "@/lib/config";
import { body, ownerOnly } from "@/lib/enterprise/http";
import { createScimToken, revokeScimToken, scimTokensOf } from "@/lib/enterprise/scim";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Settings → Identity → SCIM provisioning (owner of a shared workspace).
// GET    ?ws=            → { base, tokens }
// POST   ?ws= { name }   → { token, info }   (the token is shown this once)
// DELETE ?ws= { id }     → { ok }

export async function GET(req: Request) {
  const g = await ownerOnly(req, { shared: true });
  if (g instanceof Response) return g;
  return json({ base: `${config.appUrl}/scim/v2`, tokens: scimTokensOf(g.ws) });
}

export async function POST(req: Request) {
  const g = await ownerOnly(req, { shared: true, scope: "ent-scim" });
  if (g instanceof Response) return g;
  const b = await body(req, 2_000);
  try {
    return json(createScimToken(g.ws, g.user.id, typeof b.name === "string" ? b.name : ""));
  } catch {
    return fail(409, "too many tokens");
  }
}

export async function DELETE(req: Request) {
  const g = await ownerOnly(req, { shared: true, scope: "ent-scim" });
  if (g instanceof Response) return g;
  const b = await body(req, 2_000);
  if (typeof b.id !== "string") return fail(400, "bad request");
  return json({ ok: revokeScimToken(g.ws, g.user.id, b.id) });
}
