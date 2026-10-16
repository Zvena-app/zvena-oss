import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { addDomain, verifyDomain } from "@/lib/enterprise/domains";
import { setDnsForTests } from "@/lib/enterprise/dns";
import { ssoRequired, ssoStartForEmail } from "@/lib/enterprise/gate";
import { acsUrl, cleanSamlSettings, parseIdpMetadata, spEntityId, spMetadata } from "@/lib/enterprise/saml";
import { finishSaml, saveSso, ssoOf, startSso } from "@/lib/enterprise/sso";
import { sql } from "@/lib/store";
import { createWorkspace, roleIn } from "@/lib/workspaces";
import { b64, EVIL_CERT, EVIL_KEY, IDP_CERT, IDP_ENTITY, IDP_SSO, idpMetadata, samlResponseXml } from "./saml-idp";

const V = "2026-10-13";
const txt = new Map<string, string[]>();
setDnsForTests({ txt: async (n) => txt.get(n) ?? [], cname: async () => [] });

const count = (q: string) => Number((sql(q).get() as { n: number }).n);
/** Why the last SSO answer of the workspace was refused (its audit line). */
const reason = (ws: string) => String((JSON.parse((sql("SELECT meta FROM audit WHERE action = 'sso.reject' AND target = ? ORDER BY rowid DESC LIMIT 1").get(ws) as { meta: string }).meta) as { reason: string }).reason);

function person(name: string, email?: string): string {
  const r = signInWith({ provider: "google", subject: `sso-${name}`, name, ...(email ? { email, emailVerified: true } : {}) }, V);
  assert.ok(r.ok, String(!r.ok && r.error));
  return r.ok ? r.user.id : "";
}

/** A shared workspace with a verified domain and SAML set up from the IdP's metadata. */
async function setup(domain: string, opts: { jit?: boolean; jitRole?: "editor" | "commenter" | "viewer"; enforced?: boolean; allowIdpInitiated?: boolean } = {}) {
  const owner = person(`owner-${domain}`, `owner@${domain}`);
  const ws = createWorkspace(owner, `Team ${domain}`).id;
  const d = addDomain(ws, owner, domain);
  txt.set(domain, ["v=spf1 -all", d.record]);
  assert.ok((await verifyDomain(ws, owner, domain)).ok);
  saveSso(ws, owner, {
    kind: "saml",
    provider: { metadata: idpMetadata(), allowIdpInitiated: opts.allowIdpInitiated === true },
    enabled: true,
    enforced: opts.enforced ?? false,
    jit: opts.jit ?? true,
    jitRole: opts.jitRole ?? "commenter",
  });
  return { owner, ws };
}

/** Starts a sign-in as a browser would: the IdP URL, our RelayState, the request id and the binding cookie. */
async function begin(ws: string) {
  const s = await startSso(ws, { next: "/docs", guest: null, consent: V });
  const url = new URL(s.location as string);
  assert.equal(`${url.origin}${url.pathname}`, IDP_SSO);
  assert.ok(url.searchParams.get("SAMLRequest"));
  const relay = url.searchParams.get("RelayState") as string;
  const row = sql("SELECT request_id FROM ent_sso_state WHERE id = ?").get(relay) as { request_id: string };
  const bind = /zv_sso=([^;]+)/.exec(s.cookie)?.[1] ?? "";
  assert.match(s.cookie, /HttpOnly/);
  return { relay, requestId: row.request_id, bind };
}

test("SAML: IdP metadata gives the entity id, the redirect URL and the signing certificate; SP metadata names our ACS", () => {
  const m = parseIdpMetadata(idpMetadata());
  assert.equal(m.idpEntityId, IDP_ENTITY);
  assert.equal(m.ssoUrl, IDP_SSO);
  assert.equal(m.binding, "redirect");
  assert.equal(m.certs.length, 1);
  assert.throws(() => parseIdpMetadata("<!DOCTYPE x [<!ENTITY a 'b'>]><x/>"));
  assert.throws(() => parseIdpMetadata("not xml"));
  // Fields by hand: an http URL (not on a test stand) and a non-certificate are refused.
  assert.throws(() => cleanSamlSettings({ idpEntityId: "x", ssoUrl: "http://idp.acme.test/sso", cert: IDP_CERT }));
  assert.throws(() => cleanSamlSettings({ idpEntityId: "x", ssoUrl: "https://idp.acme.test/sso", cert: "MIIBnotacert" }));
  assert.equal(cleanSamlSettings({ idpEntityId: "x", ssoUrl: "https://idp.acme.test/sso", cert: IDP_CERT }).certs.length, 1);
  const sp = spMetadata("WS123456");
  assert.ok(sp.includes(`entityID="${spEntityId("WS123456")}"`) && sp.includes(`Location="${acsUrl("WS123456")}"`) && sp.includes('WantAssertionsSigned="true"'));
});

test("SAML: a signed assertion for our request signs a new person in and provisions them just in time", async () => {
  const { ws } = await setup("acme-one.com", { jitRole: "commenter" });
  const { relay, requestId, bind } = await begin(ws);
  const xml = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "ann@acme-one.com", email: "ann@acme-one.com", name: "Ann Example", inResponseTo: requestId });
  const r = await finishSaml(ws, b64(xml), relay, bind);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.user.email, "ann@acme-one.com");
  assert.equal(r.user.name, "Ann Example");
  assert.equal(r.next, "/docs");
  assert.equal(roleIn(r.user.id, ws), "commenter");
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'sso.jit' AND target = ?").get(ws));
  // The request id was used up: the same response a second time is refused (and the state is gone too).
  const again = await finishSaml(ws, b64(xml), relay, bind);
  assert.equal(again.ok, false);
});

test("SAML: a response signed by another key, or altered after signing, is refused", async () => {
  const { ws } = await setup("acme-two.com");
  let b = await begin(ws);
  const forged = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "eve@acme-two.com", email: "eve@acme-two.com", inResponseTo: b.requestId, key: EVIL_KEY, cert: EVIL_CERT });
  assert.equal((await finishSaml(ws, b64(forged), b.relay, b.bind)).ok, false);
  assert.match(reason(ws), /signature/i);
  b = await begin(ws);
  const good = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "bob@acme-two.com", email: "bob@acme-two.com", inResponseTo: b.requestId });
  const tampered = good.replace(/bob@acme-two\.com/g, "boss@acme-two.com");
  assert.equal((await finishSaml(ws, b64(tampered), b.relay, b.bind)).ok, false);
  assert.match(reason(ws), /signature/i);
  b = await begin(ws);
  const unsigned = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "bob@acme-two.com", email: "bob@acme-two.com", inResponseTo: b.requestId, unsigned: true });
  assert.equal((await finishSaml(ws, b64(unsigned), b.relay, b.bind)).ok, false);
  assert.match(reason(ws), /signature/i);
  assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE email IN ('eve@acme-two.com', 'boss@acme-two.com', 'bob@acme-two.com')"), 0);
  // A signature over the whole Response is as good as one over the assertion.
  b = await begin(ws);
  const whole = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "bob@acme-two.com", email: "bob@acme-two.com", inResponseTo: b.requestId, signResponse: true });
  assert.ok((await finishSaml(ws, b64(whole), b.relay, b.bind)).ok);
});

test("SAML: signature wrapping — a forged assertion beside, or around, a signed one — is refused", async () => {
  const { ws } = await setup("acme-wrap.com");
  const b = await begin(ws);
  const signed = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "low@acme-wrap.com", email: "low@acme-wrap.com", inResponseTo: b.requestId });
  const forged = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "boss@acme-wrap.com", email: "boss@acme-wrap.com", inResponseTo: b.requestId, unsigned: true });
  const forgedAssertion = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(forged)?.[0] ?? "";
  // A second (unsigned) assertion before the signed one.
  const two = signed.replace("<saml:Assertion", `${forgedAssertion}<saml:Assertion`);
  assert.equal((await finishSaml(ws, b64(two), b.relay, b.bind)).ok, false);
  assert.match(reason(ws), /multiple assertions|signature/i);
  // The signed assertion tucked inside the forged one's Subject.
  const c = await begin(ws);
  const signed2 = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "low@acme-wrap.com", email: "low@acme-wrap.com", inResponseTo: c.requestId });
  const inner = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(signed2)?.[0] ?? "";
  const wrapped = signed2.replace(inner, forgedAssertion.replace("</saml:Subject>", `<saml:SubjectConfirmationData>${inner}</saml:SubjectConfirmationData></saml:Subject>`));
  const r = await finishSaml(ws, b64(wrapped), c.relay, c.bind);
  assert.equal(r.ok, false);
  assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE email = 'boss@acme-wrap.com'"), 0);
});

test("SAML: wrong audience, wrong destination, wrong issuer and an expired assertion are refused", async () => {
  const { ws } = await setup("acme-three.com");
  const base = { acs: acsUrl(ws), audience: spEntityId(ws), nameId: "cy@acme-three.com", email: "cy@acme-three.com" };
  const cases: [Partial<Parameters<typeof samlResponseXml>[0]>, RegExp][] = [
    [{ audience: "https://other-sp.example/metadata" }, /audience/i],
    [{ destination: "https://evil.example/acs" }, /destination/],
    [{ issuer: "https://idp.other.test/saml" }, /issuer/],
    [{ notOnOrAfter: Date.now() - 120_000, notBefore: Date.now() - 600_000 }, /subject confirmation|expired/i],
    [{ issueInstant: Date.now() - 30 * 60_000 }, /subject confirmation|expired/i],
  ];
  for (const [bad, why] of cases) {
    const b = await begin(ws);
    const r = await finishSaml(ws, b64(samlResponseXml({ ...base, ...bad, inResponseTo: b.requestId })), b.relay, b.bind);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(reason(ws), why);
  }
});

test("SAML: replay, someone else's request and another browser are refused", async () => {
  const { ws } = await setup("acme-four.com");
  const a = await begin(ws);
  const b = await begin(ws);
  const forA = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "di@acme-four.com", email: "di@acme-four.com", inResponseTo: a.requestId });
  // B's browser state with A's response: InResponseTo does not match B's request.
  assert.equal((await finishSaml(ws, b64(forA), b.relay, b.bind)).ok, false);
  assert.equal(reason(ws), "in-response-to");
  // A's state but not A's cookie (a response replayed into another browser).
  const a2 = await begin(ws);
  const forA2 = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "di@acme-four.com", email: "di@acme-four.com", inResponseTo: a2.requestId });
  const stolen = await finishSaml(ws, b64(forA2), a2.relay, "not-the-cookie");
  assert.equal(stolen.ok, false);
  assert.equal(!stolen.ok && stolen.error, "state");
  // No RelayState at all: unsolicited, refused unless the owner allows IdP-initiated sign-in.
  const c = await begin(ws);
  const forC = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "di@acme-four.com", email: "di@acme-four.com", inResponseTo: c.requestId });
  assert.equal((await finishSaml(ws, b64(forC), null, null)).ok, false);
  assert.equal(reason(ws), "unsolicited");
  const ok = await finishSaml(ws, b64(forC), c.relay, c.bind);
  assert.ok(ok.ok);
  // The very same signed assertion again, even with a fresh state: the assertion id is spent.
  const d = await begin(ws);
  assert.equal((await finishSaml(ws, b64(forC), d.relay, d.bind)).ok, false);
});

test("SAML: IdP-initiated sign-in when allowed; each assertion still works only once", async () => {
  const { ws } = await setup("acme-five.com", { allowIdpInitiated: true });
  const xml = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "ed@acme-five.com", email: "ed@acme-five.com", inResponseTo: null });
  // Without a consent shown, a brand-new person is not registered by an unsolicited response…
  const first = await finishSaml(ws, b64(xml), null, null);
  assert.equal(!first.ok && first.error, "consent-required");
  // …an existing one is.
  person("ed", "ed@acme-five.com");
  const xml2 = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "ed@acme-five.com", email: "ed@acme-five.com", inResponseTo: null });
  assert.ok((await finishSaml(ws, b64(xml2), null, null)).ok);
  assert.equal((await finishSaml(ws, b64(xml2), null, null)).ok, false);
  assert.equal(reason(ws), "replay");
});

test("SSO: the provider can only sign in addresses at the workspace's verified domains", async () => {
  const { ws } = await setup("acme-six.com");
  person("victim", "victim@elsewhere.com");
  const b = await begin(ws);
  const xml = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "victim@elsewhere.com", email: "victim@elsewhere.com", inResponseTo: b.requestId });
  const r = await finishSaml(ws, b64(xml), b.relay, b.bind);
  assert.equal(!r.ok && r.error, "sso-domain");
});

test("SSO: without just-in-time provisioning only members get in", async () => {
  const { ws } = await setup("acme-seven.com", { jit: false });
  const b = await begin(ws);
  const xml = samlResponseXml({ acs: acsUrl(ws), audience: spEntityId(ws), nameId: "fay@acme-seven.com", email: "fay@acme-seven.com", inResponseTo: b.requestId });
  const r = await finishSaml(ws, b64(xml), b.relay, b.bind);
  assert.equal(!r.ok && r.error, "sso-not-member");
  assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE email = 'fay@acme-seven.com'"), 0);
});

test("SSO enforcement: Google, e-mail and the test sign-in refuse the domain's people; owners keep a way in", async () => {
  const { ws, owner } = await setup("acme-eight.com", { enforced: true });
  assert.equal(ssoOf(ws)?.enforced, true);
  const google = signInWith({ provider: "google", subject: "g-gus", name: "Gus", email: "gus@acme-eight.com", emailVerified: true }, V);
  assert.equal(!google.ok && google.error, "sso-required");
  const email = signInWith({ provider: "email", subject: "gus@acme-eight.com", name: "", email: "gus@acme-eight.com", emailVerified: true }, V);
  assert.equal(!email.ok && email.error, "sso-required");
  // The e-mail sign-in sends the address to SSO instead of sending a letter…
  assert.match(String(ssoStartForEmail("gus@acme-eight.com", "/docs")), /^\/api\/sso\/start\?email=gus%40acme-eight\.com&next=%2Fdocs$/);
  // …but the owner gets the letter (break-glass) and signs in with Google too.
  assert.equal(ssoStartForEmail("owner@acme-eight.com", "/docs"), null);
  assert.equal(ssoRequired("google", owner, ["owner@acme-eight.com"]), null);
  const back = signInWith({ provider: "google", subject: "sso-owner-acme-eight.com", name: "Owner", email: "owner@acme-eight.com", emailVerified: true }, V);
  assert.ok(back.ok);
  // Another domain is not affected; SSO itself is.
  assert.ok(signInWith({ provider: "google", subject: "g-hal", name: "Hal", email: "hal@other-co.com", emailVerified: true }, V).ok);
  assert.equal(ssoRequired("sso", null, ["gus@acme-eight.com"]), null);
  // A GitHub login without an e-mail, linked to a company account, is still that account.
  const gh = signInWith({ provider: "github", subject: "gh-ivy", name: "Ivy" }, V);
  assert.ok(gh.ok);
  if (gh.ok) {
    sql("UPDATE users SET email = 'ivy@acme-eight.com' WHERE id = ?").run(gh.user.id);
    const again = signInWith({ provider: "github", subject: "gh-ivy", name: "Ivy" }, V);
    assert.equal(!again.ok && again.error, "sso-required");
  }
});

test("SSO: enforcing needs a verified domain", async () => {
  const owner = person("solo", "solo@nodomain.com");
  const ws = createWorkspace(owner, "No domain").id;
  assert.throws(() => saveSso(ws, owner, { kind: "saml", provider: { metadata: idpMetadata() }, enabled: true, enforced: true }), /verify a domain/);
  const c = saveSso(ws, owner, { kind: "saml", provider: { metadata: idpMetadata() }, enabled: true });
  assert.equal(c.enforced, false);
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'sso.update' AND target = ?").get(ws));
});
