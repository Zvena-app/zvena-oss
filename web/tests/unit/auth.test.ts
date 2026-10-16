import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getUser, issueSession, readSession, recordConsent, sessionCookieName, signInWith, destroySession, safeEqual } from "@/lib/auth";
import { safeNext } from "@/lib/oauth";
import { sql } from "@/lib/store";

const cookie = (token: string) => `${sessionCookieName()}=${token}`;

test("a new account needs the separate consent; the consent version is stored", () => {
  const p = { provider: "dev" as const, subject: "anna", name: "Анна" };
  const no = signInWith(p, null);
  assert.equal(no.ok, false);
  assert.equal(!no.ok && no.error, "consent-required");
  const yes = signInWith(p, "2026-10-13");
  assert.ok(yes.ok && yes.isNew);
  assert.ok(yes.ok && yes.user.consentOk);
  assert.match(yes.ok ? yes.user.id : "", /^[0-9a-f]{24}$/);
});

test("a returning person signs in without ticking again", () => {
  const r = signInWith({ provider: "dev", subject: "anna", name: "Анна" }, null);
  assert.ok(r.ok && !r.isNew);
});

test("after the documents change, sign-in asks for the consent again", () => {
  const first = signInWith({ provider: "dev", subject: "boris", name: "Борис" }, "2026-10-13");
  assert.ok(first.ok);
  const id = first.ok ? first.user.id : "";
  sql("UPDATE users SET consent_version = '2025-01-01' WHERE id = ?").run(id);
  assert.equal(getUser(id)?.consentOk, false);
  const again = signInWith({ provider: "dev", subject: "boris", name: "Борис" }, null);
  assert.equal(!again.ok && again.error, "consent-required");
  recordConsent(id);
  assert.equal(getUser(id)?.consentOk, true);
});

test("a blocked account cannot sign in or use a session", () => {
  const r = signInWith({ provider: "dev", subject: "spam", name: "Спам" }, "2026-10-13");
  assert.ok(r.ok);
  const id = r.ok ? r.user.id : "";
  const token = issueSession(id);
  assert.equal(readSession(cookie(token))?.id, id);
  sql("UPDATE users SET blocked_at = ? WHERE id = ?").run(Date.now(), id);
  assert.equal(readSession(cookie(token)), null);
  const again = signInWith({ provider: "dev", subject: "spam", name: "Спам" }, "2026-10-13");
  assert.equal(!again.ok && again.error, "blocked");
});

test("sessions: only the HMAC is stored, garbage and ended sessions read as nobody", () => {
  const r = signInWith({ provider: "dev", subject: "vera", name: "Вера" }, "2026-10-13");
  const id = r.ok ? r.user.id : "";
  const token = issueSession(id);
  assert.equal(sql("SELECT COUNT(*) AS n FROM sessions WHERE sid = ?").get(token)?.n, 0);
  assert.equal(readSession(cookie(token))?.id, id);
  assert.equal(readSession(cookie("x".repeat(48))), null);
  assert.equal(readSession(cookie("../../etc/passwd")), null);
  destroySession(cookie(token));
  assert.equal(readSession(cookie(token)), null);
});

test("return paths stay on this site", () => {
  assert.equal(safeNext("/docs?ws=abc#x"), "/docs?ws=abc#x");
  for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "", null, undefined, "/" + "a".repeat(2001)]) {
    assert.equal(safeNext(bad as string), "/home", String(bad));
  }
});

test("safeEqual compares in constant time and by length", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
});
