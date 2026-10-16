import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { identitiesOf, nameFromEmail, signInWith } from "@/lib/auth";
import { consumeCode, consumeLink, createEmailSignIn, maskEmail, normalizeEmail, peekLink, peekRef, sendSignInLetter, signInLetter } from "@/lib/email-signin";
import { sql } from "@/lib/store";
import { TEST_DIR } from "./env";

const V = "2026-10-13";

// --- Accounts: one person, several ways in ------------------------------------

test("a verified e-mail links single sign-on and the e-mail link into one account", () => {
  const g = signInWith({ provider: "sso", subject: "ws-1:u-1", name: "Ada Lovelace", email: "Ada@Example.com", emailVerified: true }, V);
  assert.ok(g.ok && g.isNew);
  const id = g.ok ? g.user.id : "";
  assert.equal(g.ok && g.user.email, "ada@example.com");
  const e = signInWith({ provider: "email", subject: "ada@example.com", name: "", email: "ada@example.com", emailVerified: true }, V);
  assert.ok(e.ok && !e.isNew && e.user.id === id);
  assert.deepEqual(identitiesOf(id).map((i) => i.provider).sort(), ["email", "sso"]);
  // The name the person had stays.
  assert.equal(e.ok && e.user.name, "Ada Lovelace");
});

test("an unverified e-mail is neither stored nor used to join an account", () => {
  const a = signInWith({ provider: "email", subject: "bob@example.com", name: "Bob", email: "bob@example.com", emailVerified: true }, V);
  const b = signInWith({ provider: "sso", subject: "ws-2:u-77", name: "mallory", email: "bob@example.com", emailVerified: false }, V);
  assert.ok(a.ok && b.ok && b.isNew && a.user.id !== b.user.id);
  assert.equal(b.ok && b.user.email, undefined);
});

test("a blocked account stays blocked through a newly linked method", () => {
  const a = signInWith({ provider: "sso", subject: "ws-3:u-3", name: "Eve", email: "eve@example.com", emailVerified: true }, V);
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

test("the sign-in letter: link, code, escaping; without SMTP it lands in the outbox", async () => {
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
