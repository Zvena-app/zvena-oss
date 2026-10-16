import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { identitiesOf, nameFromEmail, signInWith } from "@/lib/auth";
import { consumeCode, consumeLink, createEmailSignIn, maskEmail, normalizeEmail, peekLink, peekRef, sendSignInLetter, signInLetter } from "@/lib/email-signin";
import { verifyOneTap } from "@/lib/google";
import { sendMail } from "@/lib/mail";
import { githubProfile, googleProfile } from "@/lib/oauth";
import { sql } from "@/lib/store";
import { TEST_DIR } from "./env";

const V = "2026-10-13";

// --- Accounts: one person, several ways in ------------------------------------

test("a verified e-mail links Google, GitHub and the e-mail link into one account", () => {
  const g = signInWith({ provider: "google", subject: "g-1", name: "Ada Lovelace", email: "Ada@Example.com", emailVerified: true }, V);
  assert.ok(g.ok && g.isNew);
  const id = g.ok ? g.user.id : "";
  assert.equal(g.ok && g.user.email, "ada@example.com");
  const gh = signInWith({ provider: "github", subject: "42", name: "ada", email: "ada@example.com", emailVerified: true }, V);
  assert.ok(gh.ok && !gh.isNew && gh.user.id === id);
  const e = signInWith({ provider: "email", subject: "ada@example.com", name: "", email: "ada@example.com", emailVerified: true }, V);
  assert.ok(e.ok && !e.isNew && e.user.id === id);
  assert.deepEqual(identitiesOf(id).map((i) => i.provider).sort(), ["email", "github", "google"]);
  // The name the person had stays.
  assert.equal(e.ok && e.user.name, "Ada Lovelace");
});

test("an unverified e-mail is neither stored nor used to join an account", () => {
  const a = signInWith({ provider: "google", subject: "g-2", name: "Bob", email: "bob@example.com", emailVerified: true }, V);
  const b = signInWith({ provider: "github", subject: "77", name: "mallory", email: "bob@example.com", emailVerified: false }, V);
  assert.ok(a.ok && b.ok && b.isNew && a.user.id !== b.user.id);
  assert.equal(b.ok && b.user.email, undefined);
});

test("a blocked account stays blocked through a newly linked method", () => {
  const a = signInWith({ provider: "google", subject: "g-3", name: "Eve", email: "eve@example.com", emailVerified: true }, V);
  sql("UPDATE users SET blocked_at = ? WHERE id = ?").run(Date.now(), a.ok ? a.user.id : "");
  const b = signInWith({ provider: "email", subject: "eve@example.com", name: "", email: "eve@example.com", emailVerified: true }, V);
  assert.equal(!b.ok && b.error, "blocked");
});

test("names: from the provider, else from the e-mail, else a default", () => {
  assert.equal(nameFromEmail("anna.smith@example.com"), "Anna Smith");
  assert.equal(nameFromEmail("j_doe+zvena@example.com"), "J Doe Zvena");
  assert.equal(nameFromEmail("12345@example.com"), "");
  const r = signInWith({ provider: "email", subject: "grace.hopper@example.com", name: "", email: "grace.hopper@example.com", emailVerified: true }, V);
  assert.equal(r.ok && r.user.name, "Grace Hopper");
  const n = signInWith({ provider: "email", subject: "777@example.com", name: "", email: "777@example.com", emailVerified: true }, V);
  assert.equal(n.ok && n.user.name, "zvena user");
});

// --- Provider profiles -----------------------------------------------------------

test("Google ID token claims: issuer, audience and expiry are checked", () => {
  const now = Date.now();
  const ok = { iss: "https://accounts.google.com", aud: "cid", sub: "1234567890", email: "a@b.co", email_verified: true, name: "A B", exp: now / 1000 + 600 };
  assert.deepEqual(googleProfile(ok, "cid", now), { provider: "google", subject: "1234567890", name: "A B", email: "a@b.co", emailVerified: true });
  assert.equal(googleProfile({ ...ok, aud: "other" }, "cid", now), null);
  assert.equal(googleProfile({ ...ok, iss: "https://evil.example" }, "cid", now), null);
  assert.equal(googleProfile({ ...ok, exp: now / 1000 - 3600 }, "cid", now), null);
  assert.equal(googleProfile({ ...ok, sub: "" }, "cid", now), null);
  assert.equal(googleProfile({ ...ok, email_verified: false }, "cid", now)?.emailVerified, false);
});

test("GitHub profile: the primary verified e-mail, never a noreply or unverified one", () => {
  const user = { id: 583231, login: "octocat", name: null };
  const p = githubProfile(user, [
    { email: "octo@users.noreply.github.com", verified: true, primary: false },
    { email: "work@example.com", verified: true, primary: false },
    { email: "home@example.com", verified: true, primary: true },
    { email: "fake@example.com", verified: false, primary: false },
  ]);
  assert.deepEqual(p, { provider: "github", subject: "583231", name: "octocat", email: "home@example.com", emailVerified: true });
  assert.deepEqual(githubProfile(user, [{ email: "x@example.com", verified: false, primary: true }]), { provider: "github", subject: "583231", name: "octocat" });
  assert.equal(githubProfile({ login: "nobody" }, []), null);
});

// --- Google One Tap: the token's signature, audience and nonce ---------------------

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

function idToken(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "test-key", typ: "JWT" }, key = privateKey): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const c = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${c}`), key).toString("base64url");
  return `${h}.${c}.${s}`;
}

const now = Date.now();
const claims = { iss: "accounts.google.com", aud: "client-1", sub: "1098765", email: "tap@example.com", email_verified: true, name: "Tap User", iat: now / 1000, exp: now / 1000 + 3600, nonce: "n-123" };

test("One Tap: a token signed by Google's key for our client and nonce is accepted", async () => {
  const p = await verifyOneTap(idToken(claims), "n-123", { clientId: "client-1", keys: [jwk], now });
  assert.equal(p?.subject, "1098765");
  assert.equal(p?.email, "tap@example.com");
});

test("One Tap: wrong nonce, audience, key, signature or algorithm is refused", async () => {
  const opts = { clientId: "client-1", keys: [jwk], now };
  assert.equal(await verifyOneTap(idToken(claims), "other-nonce", opts), null);
  assert.equal(await verifyOneTap(idToken(claims), null, opts), null);
  assert.equal(await verifyOneTap(idToken({ ...claims, aud: "client-2" }), "n-123", opts), null);
  assert.equal(await verifyOneTap(idToken({ ...claims, exp: now / 1000 - 600 }), "n-123", opts), null);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.equal(await verifyOneTap(idToken(claims, undefined, other), "n-123", opts), null);
  assert.equal(await verifyOneTap(idToken(claims, { alg: "RS256", kid: "unknown" }), "n-123", opts), null);
  // A payload swapped under a valid signature.
  const [h, , s] = idToken(claims).split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: "attacker" })).toString("base64url")}.${s}`;
  assert.equal(await verifyOneTap(forged, "n-123", opts), null);
  const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "test-key" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
  assert.equal(await verifyOneTap(none, "n-123", opts), null);
  assert.equal(await verifyOneTap("garbage", "n-123", opts), null);
});

// --- E-mail sign-in -------------------------------------------------------------------

test("e-mail addresses: normalized, odd ones refused, masked for display", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  for (const bad of ["", "no-at", "a@b", "a b@c.d", "<a@b.co>", "a@b.co, c@d.co", 5, null]) assert.equal(normalizeEmail(bad), null, String(bad));
  assert.equal(maskEmail("anna.smith@example.com"), "an•••@example.com");
});

test("e-mail link: works once, and only within its lifetime", () => {
  const r = createEmailSignIn("link@example.com", { next: "/docs", guest: null });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(peekLink(r.token)?.email, "link@example.com");
  assert.equal(peekRef(r.ref)?.email, "link@example.com");
  // Only HMACs are stored.
  assert.equal(sql("SELECT COUNT(*) AS n FROM email_signin WHERE id = ? OR code = ?").get(r.token, r.code)?.n, 0);
  const used = consumeLink(r.token);
  assert.deepEqual(used, { ok: true, email: "link@example.com", next: "/docs", guest: null });
  assert.equal(consumeLink(r.token).ok, false);
  assert.equal(peekLink(r.token), null);
  const old = createEmailSignIn("late@example.com", { next: "/home", guest: null });
  assert.ok(old.ok);
  if (!old.ok) return;
  sql("UPDATE email_signin SET exp = ? WHERE ref = ?").run(Date.now() - 1, old.ref);
  assert.equal(consumeLink(old.token).ok, false);
});

test("e-mail code: wrong codes count, the fifth voids the letter, the right one works once", () => {
  const r = createEmailSignIn("code@example.com", { next: "//evil.example", guest: null });
  assert.ok(r.ok);
  if (!r.ok) return;
  const wrong = r.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) assert.equal((consumeCode(r.ref, wrong) as { error?: string }).error, "wrong-code");
  assert.equal((consumeCode(r.ref, wrong) as { error?: string }).error, "expired");
  assert.equal(consumeCode(r.ref, r.code).ok, false, "voided after five wrong codes");

  const s = createEmailSignIn("code@example.com", { next: "//evil.example", guest: null });
  assert.ok(s.ok);
  if (!s.ok) return;
  const ok = consumeCode(s.ref, ` ${s.code.slice(0, 3)} ${s.code.slice(3)} `);
  assert.deepEqual(ok, { ok: true, email: "code@example.com", next: "/home", guest: null });
  assert.equal(consumeCode(s.ref, s.code).ok, false);
  assert.equal(consumeLink(s.token).ok, false, "the code also used up the link");
});

test("e-mail sign-in: at most five letters an hour per address", () => {
  for (let i = 0; i < 5; i++) assert.ok(createEmailSignIn("busy@example.com", { next: "/home", guest: null }).ok);
  const sixth = createEmailSignIn("BUSY@example.com", { next: "/home", guest: null });
  assert.equal(!sixth.ok && sixth.error, "too-many");
});

test("the sign-in letter: link, code, escaping; without Resend or SMTP it lands in the outbox", async () => {
  const l = signInLetter('x"<script>@example.com', "tok", "123456");
  assert.match(l.subject, /123456/);
  assert.match(l.text, /\/signin\/email\?token=tok/);
  assert.ok(!l.html.includes("<script>"));
  assert.ok(l.html.includes("&lt;script&gt;"));
  mkdirSync(join(TEST_DIR, "outbox"), { recursive: true });
  const before = readdirSync(join(TEST_DIR, "outbox")).length;
  assert.ok(await sendSignInLetter("outbox@example.com", "tok", "654321"));
  const files = readdirSync(join(TEST_DIR, "outbox"));
  assert.equal(files.length, before + 1);
  const eml = files.map((f) => readFileSync(join(TEST_DIR, "outbox", f), "utf8")).find((t) => t.includes("654321"));
  assert.ok(eml?.includes("To: outbox@example.com"));
});

test("with RESEND_API_KEY, letters go through Resend's API", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test_123";
  process.env.MAIL_FROM = "zvena <hello@zvena.app>";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await sendMail({ to: "r@example.com", subject: "Hi", text: "Body", html: "<p>Body</p>" }), "sent");
    assert.equal(seen[0].url, "https://api.resend.com/emails");
    assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer re_test_123");
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), { from: "zvena <hello@zvena.app>", to: ["r@example.com"], subject: "Hi", text: "Body", html: "<p>Body</p>" });
    globalThis.fetch = (async () => new Response("{}", { status: 422 })) as typeof fetch;
    assert.equal(await sendMail({ to: "r@example.com", subject: "Hi", text: "Body" }), "failed");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_FROM;
  }
});
