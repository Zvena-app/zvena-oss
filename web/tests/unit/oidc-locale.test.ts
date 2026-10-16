// zvena as Design's OpenID provider: the language the person chose in zvena
// (the zv_lang cookie) reaches Design as the userinfo "locale" claim, through
// the one-time code and the access token. No choice, no claim.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";

Object.assign(process.env, {
  DESIGN_OIDC_CLIENT_ID: "design-test",
  DESIGN_OIDC_CLIENT_SECRET: "s".repeat(40),
  DESIGN_OIDC_REDIRECT_URIS: "http://localhost:3110/api/auth/oidc/callback",
});

const BASE = "http://localhost:3100";
const REDIRECT = "http://localhost:3110/api/auth/oidc/callback";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `oidc-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return `${sessionCookieName()}=${issueSession(r.ok ? r.user.id : "")}`;
}

async function signInToDesign(cookie: string): Promise<Record<string, unknown>> {
  const { GET: authorize } = await import("@/app/api/oidc/authorize/route");
  const { POST: token } = await import("@/app/api/oidc/token/route");
  const { GET: userinfo } = await import("@/app/api/oidc/userinfo/route");
  const q = new URLSearchParams({ client_id: "design-test", redirect_uri: REDIRECT, response_type: "code", state: "st" });
  const a = await authorize(new Request(`${BASE}/api/oidc/authorize?${q}`, { headers: { cookie } }));
  assert.equal(a.status, 303);
  const code = new URL(a.headers.get("location") ?? "").searchParams.get("code");
  assert.ok(code, "a code comes back");
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: "design-test", client_secret: "s".repeat(40) });
  const t = await token(new Request(`${BASE}/api/oidc/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }));
  assert.equal(t.status, 200);
  const at = ((await t.json()) as { access_token: string }).access_token;
  const u = await userinfo(new Request(`${BASE}/api/oidc/userinfo`, { headers: { authorization: `Bearer ${at}` } }));
  assert.equal(u.status, 200);
  return (await u.json()) as Record<string, unknown>;
}

test("oidc: Design learns the language chosen in zvena (locale claim)", async () => {
  const s = person("Lucía");
  const claims = await signInToDesign(`${s}; zv_lang=es`);
  assert.equal(claims.locale, "es");
  assert.match(String(claims.email), /^u-.+@/, "still only the technical login");
});

test("oidc: no choice or an unknown language → no locale claim", async () => {
  const s = person("Sam");
  assert.equal((await signInToDesign(s)).locale, undefined);
  assert.equal((await signInToDesign(`${s}; zv_lang=xx`)).locale, undefined);
});
