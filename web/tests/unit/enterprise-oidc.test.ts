import "./env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { setDnsForTests } from "@/lib/enterprise/dns";
import { addDomain, verifyDomain } from "@/lib/enterprise/domains";
import { cleanOidcSettings, oidcRedirectUri } from "@/lib/enterprise/oidc";
import { finishOidc, saveSso, ssoOf, startSso } from "@/lib/enterprise/sso";
import { sql } from "@/lib/store";
import { createWorkspace, roleIn } from "@/lib/workspaces";
import { MockOidc, type Twist, type Who } from "./oidc-idp";

// The mock provider speaks plain HTTP on 127.0.0.1, which only a test stand may reach.
process.env.ZVENA_STAND = "test";

const V = "2026-10-13";
const txt = new Map<string, string[]>();
setDnsForTests({ txt: async (n) => txt.get(n) ?? [], cname: async () => [] });
const idp = new MockOidc();
before(() => idp.start());
after(() => idp.stop());

function person(name: string, email: string): string {
  const r = signInWith({ provider: "dev", subject: `oidc-${name}`, name, email, emailVerified: true }, V);
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

async function setup(domain: string, jitRole: "editor" | "viewer" = "viewer") {
  const owner = person(`owner-${domain}`, `owner@${domain}`);
  const ws = createWorkspace(owner, `OIDC ${domain}`).id;
  txt.set(domain, [addDomain(ws, owner, domain).record]);
  assert.ok((await verifyDomain(ws, owner, domain)).ok);
  saveSso(ws, owner, { kind: "oidc", provider: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret }, enabled: true, jit: true, jitRole });
  return { owner, ws };
}

async function signIn(ws: string, who: Who, twist: Twist = {}, tamper?: (p: URLSearchParams, bind: string) => [URLSearchParams, string]) {
  const s = await startSso(ws, { next: "/projects", guest: null, consent: V });
  const auth = new URL(s.location as string);
  assert.equal(auth.searchParams.get("redirect_uri"), oidcRedirectUri(ws));
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.ok(auth.searchParams.get("nonce") && auth.searchParams.get("state"));
  const bind = /zv_sso=([^;]+)/.exec(s.cookie)?.[1] ?? "";
  let params = idp.authorize(s.location as string, who, twist);
  let cookie = bind;
  if (tamper) [params, cookie] = tamper(params, bind);
  return finishOidc(ws, params, cookie);
}

test("OIDC: the client secret is sealed, never stored as typed, and kept when left empty", async () => {
  const { ws } = await setup("oidc-one.test");
  const raw = (sql("SELECT json FROM ent_sso WHERE ws = ?").get(ws) as { json: string }).json;
  assert.ok(!raw.includes(idp.clientSecret));
  const kept = cleanOidcSettings(ws, { issuer: idp.issuer, clientId: idp.clientId, clientSecret: "" }, ssoOf(ws)?.oidc ?? null);
  assert.equal(kept.secret, ssoOf(ws)?.oidc?.secret);
  assert.throws(() => cleanOidcSettings(ws, { issuer: "ftp://idp", clientId: "x", clientSecret: "y" }, null));
});

test("OIDC: code + PKCE + nonce sign a new person in, provisioned with the workspace's role", async () => {
  const { ws } = await setup("oidc-two.test", "editor");
  const r = await signIn(ws, { sub: "u-100", email: "nia@oidc-two.test", email_verified: true, name: "Nia North" });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.next, "/projects");
  assert.equal(r.user.email, "nia@oidc-two.test");
  assert.equal(roleIn(r.user.id, ws), "editor");
  // The same person again: the same account, through the sso identity.
  const again = await signIn(ws, { sub: "u-100", email: "nia@oidc-two.test", email_verified: true });
  assert.ok(again.ok && again.user.id === r.user.id && !again.isNew);
});

test("OIDC: a wrong nonce, audience, issuer, an expired or foreign-signed ID token is refused", async () => {
  const { ws } = await setup("oidc-three.test");
  const who = { sub: "u-200", email: "oz@oidc-three.test", email_verified: true };
  const cases: [Twist, RegExp][] = [
    [{ nonce: "not-ours" }, /"nonce"/],
    [{ aud: "someone-else" }, /"aud"/],
    [{ iss: "https://evil.example" }, /"iss"/],
    [{ exp: Math.floor(Date.now() / 1000) - 3600 }, /"exp"/],
    [{ foreignKey: true }, /signature/],
  ];
  for (const [twist, why] of cases) {
    const r = await signIn(ws, who, twist);
    assert.equal(r.ok, false, JSON.stringify(twist));
    const meta = JSON.parse((sql("SELECT meta FROM audit WHERE action = 'sso.reject' AND target = ? ORDER BY rowid DESC LIMIT 1").get(ws) as { meta: string }).meta) as { reason: string };
    assert.match(meta.reason, why);
  }
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM users WHERE email = 'oz@oidc-three.test'").get() as { n: number }).n), 0);
});

test("OIDC: the callback must come back to the browser that started it, once", async () => {
  const { ws } = await setup("oidc-four.test");
  const who = { sub: "u-300", email: "pia@oidc-four.test", email_verified: true };
  const other = await signIn(ws, who, {}, (p) => [p, "another-browser"]);
  assert.equal(!other.ok && other.error, "state");
  // A second use of the same state (a replayed callback URL) finds nothing.
  const s = await startSso(ws, { next: "/home", guest: null, consent: V });
  const bind = /zv_sso=([^;]+)/.exec(s.cookie)?.[1] ?? "";
  const params = idp.authorize(s.location as string, who);
  assert.ok((await finishOidc(ws, params, bind)).ok);
  assert.equal((await finishOidc(ws, params, bind)).ok, false);
  // A state of another workspace is not this workspace's.
  const { ws: ws2 } = await setup("oidc-five.test");
  const s2 = await startSso(ws2, { next: "/home", guest: null, consent: V });
  const p2 = idp.authorize(s2.location as string, who);
  assert.equal((await finishOidc(ws, p2, /zv_sso=([^;]+)/.exec(s2.cookie)?.[1] ?? "")).ok, false);
});

test("OIDC: an address outside the verified domains, or an unverified one, is refused", async () => {
  const { ws } = await setup("oidc-six.test");
  const outside = await signIn(ws, { sub: "u-400", email: "rex@gmail.com", email_verified: true });
  assert.equal(!outside.ok && outside.error, "sso-domain");
  const unverified = await signIn(ws, { sub: "u-401", email: "sam@oidc-six.test", email_verified: false });
  assert.equal(!unverified.ok && unverified.error, "sso-domain");
  // A provider that does not say the address is verified (people register themselves there): no address.
  const silent = await signIn(ws, { sub: "u-402", email: "tia@oidc-six.test" });
  assert.equal(!silent.ok && silent.error, "sso-domain");
  // …nor does a sign-in name stand in for it outside Entra ID.
  const named = await signIn(ws, { sub: "u-403", preferred_username: "uma@oidc-six.test", upn: "uma@oidc-six.test" });
  assert.equal(!named.ok && named.error, "sso-domain");
});

test("OIDC: an Entra ID tenant's issuer, and only that, lets the sign-in name stand in for the address", async () => {
  const { entraTenantIssuer } = await import("@/lib/enterprise/oidc");
  assert.equal(entraTenantIssuer("https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0"), true);
  assert.equal(entraTenantIssuer("https://sts.windows.net/72f988bf-86f1-41af-91ab-2d7cd011db47/"), true);
  assert.equal(entraTenantIssuer("https://login.microsoftonline.com/common/v2.0"), false);
  assert.equal(entraTenantIssuer("https://login.microsoftonline.com/organizations/v2.0"), false);
  assert.equal(entraTenantIssuer("https://login.microsoftonline.com.evil.test/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0"), false);
  assert.equal(entraTenantIssuer("https://idp.example.com"), false);
});
