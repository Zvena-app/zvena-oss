import { body, ownerOnly } from "@/lib/enterprise/http";
import { OidcConfigError, OidcError, testOidc } from "@/lib/enterprise/oidc";
import { SamlConfigError } from "@/lib/enterprise/saml";
import { deleteSso, saveSso, ssoOf, SsoError } from "@/lib/enterprise/sso";
import { spInfo, ssoView } from "@/lib/enterprise/sso-view";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Settings → Identity → Single sign-on, SAML 2.0 or OpenID Connect (owner of a shared workspace).
// GET    ?ws=                                             → { sso, sp }
// PUT    ?ws= { kind, provider?, enabled?, enforced?, jit?, jitRole? } → { sso, sp }
//        provider (SAML): { metadata } or { idpEntityId, ssoUrl, cert, allowIdpInitiated? }
//        provider (OIDC): { issuer, clientId, clientSecret }  (an empty secret keeps the stored one)
// POST   ?ws= { op: "test" }                              → { ok } | 502 (OIDC: the discovery document)
// DELETE ?ws=                                             → { ok }
// The client secret never comes back; certificates come back as their subject and expiry.

export async function GET(req: Request) {
  const g = await ownerOnly(req, { shared: true });
  if (g instanceof Response) return g;
  return json({ sso: ssoView(ssoOf(g.ws)), sp: spInfo(g.ws) });
}

export async function PUT(req: Request) {
  const g = await ownerOnly(req, { shared: true, scope: "ent-sso" });
  if (g instanceof Response) return g;
  try {
    return json({ sso: ssoView(saveSso(g.ws, g.user.id, await body(req, 600_000))), sp: spInfo(g.ws) });
  } catch (e) {
    if (e instanceof SamlConfigError || e instanceof OidcConfigError || e instanceof SsoError) return fail(400, e.message);
    throw e;
  }
}

export async function POST(req: Request) {
  const g = await ownerOnly(req, { shared: true, scope: "ent-sso" });
  if (g instanceof Response) return g;
  const b = await body(req, 1_000);
  const c = ssoOf(g.ws);
  if (b.op !== "test" || !c) return fail(400, "bad request");
  if (c.kind !== "oidc" || !c.oidc) return json({ ok: true });
  try {
    await testOidc(g.ws, c.oidc);
    return json({ ok: true });
  } catch (e) {
    return fail(502, e instanceof OidcError ? e.message : "unreachable");
  }
}

export async function DELETE(req: Request) {
  const g = await ownerOnly(req, { shared: true, scope: "ent-sso" });
  if (g instanceof Response) return g;
  return json({ ok: deleteSso(g.ws, g.user.id) });
}
