// Login CSRF: a Google/GitHub callback (code + state) finishes a sign-in only
// in the browser that started it; an e-mail link carries guest files only
// into the browser that asked for the letter.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { POST as verifyEmail } from "@/app/api/auth/email/verify/route";
import { createEmailSignIn } from "@/lib/email-signin";
import { consumeState, OAUTH_COOKIE, startOAuth } from "@/lib/oauth";
import { GUEST_COOKIE } from "@/lib/storage";
import { sql } from "@/lib/store";

const opts = { consent: "2026-10-13", next: "/docs", guest: null };
const stateOf = (url: string) => new URL(url).searchParams.get("state") as string;
const cookieValue = (cookie: string) => cookie.split(";")[0].slice(OAUTH_COOKIE.length + 1);

test("OAuth: the start sets an HttpOnly cookie for the callback path holding the state", () => {
  for (const p of ["google", "github"] as const) {
    const s = startOAuth(p, opts);
    const state = stateOf(s.url);
    assert.match(state, /^[A-Za-z0-9_-]{20,64}$/);
    assert.equal(cookieValue(s.cookie), state);
    assert.match(s.cookie, /; Path=\/api\/auth\/callback;/);
    assert.match(s.cookie, /; HttpOnly;/);
    assert.match(s.cookie, /; SameSite=Lax/);
    assert.match(s.cookie, /; Max-Age=600$/);
  }
});

test("OAuth: the callback finishes only in the browser that started, once", () => {
  const s = startOAuth("google", opts);
  const state = stateOf(s.url);
  const st = consumeState(state, "google", cookieValue(s.cookie));
  assert.ok(st);
  assert.equal(st?.next, "/docs");
  // Replaying the same callback URL finds nothing.
  assert.equal(consumeState(state, "google", cookieValue(s.cookie)), null);
});

test("OAuth: a captured callback URL does not sign in another browser, and is spent", () => {
  const attacker = startOAuth("github", opts);
  const state = stateOf(attacker.url);
  // The victim's browser: no cookie, or the cookie of its own sign-in.
  assert.equal(consumeState(state, "github", null), null);
  const victim = startOAuth("github", opts);
  assert.equal(consumeState(state, "github", cookieValue(victim.cookie)), null);
  // The refused state is gone: the attacker cannot use it afterwards either.
  assert.equal(consumeState(state, "github", state), null);
  // The victim's own sign-in still works.
  assert.ok(consumeState(stateOf(victim.url), "github", cookieValue(victim.cookie)));
});

test("OAuth: a state of the other provider is refused", () => {
  const s = startOAuth("google", opts);
  const state = stateOf(s.url);
  assert.equal(consumeState(state, "github", state), null);
});

// --- E-mail links and guest files -------------------------------------------------------

function guestWithFile(): string {
  const g = randomBytes(16).toString("hex");
  const now = Date.now();
  sql("INSERT OR IGNORE INTO guests (id, created_at, last_seen_at) VALUES (?, ?, ?)").run(g, now, now);
  sql("INSERT INTO files (name, owner_kind, owner_id, bytes, created_at, last_seen_at) VALUES (?, 'guest', ?, 10, ?, ?)").run(`f-${g}`, g, now, now);
  return g;
}

function verify(token: string, guest: string | null): Promise<Response> {
  const body = new URLSearchParams({ token });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:3100", host: "localhost:3100", "sec-fetch-site": "same-origin" };
  if (guest) headers.cookie = `${GUEST_COOKIE}=${guest}`;
  return verifyEmail(new Request("http://localhost:3100/api/auth/email/verify", { method: "POST", body, headers }));
}

const guestFiles = (g: string) => Number((sql("SELECT COUNT(*) AS n FROM files WHERE owner_kind = 'guest' AND owner_id = ?").get(g) as { n: number }).n);

test("e-mail link: guest files move only in the browser that asked for the letter", async () => {
  // Someone else asks for a letter to the victim's address from their own guest browser.
  const attacker = guestWithFile();
  const a = createEmailSignIn("victim-guest@example.com", { next: "/home", guest: attacker });
  assert.ok(a.ok);
  const res = await verify(a.ok ? a.token : "", null);
  assert.equal(res.status, 303);
  assert.equal(guestFiles(attacker), 1, "the other browser's guest files stay where they were");

  // The person's own browser: its guest files come along.
  const mine = guestWithFile();
  const b = createEmailSignIn("owner-guest@example.com", { next: "/home", guest: mine });
  assert.ok(b.ok);
  const res2 = await verify(b.ok ? b.token : "", mine);
  assert.equal(res2.status, 303);
  assert.equal(guestFiles(mine), 0, "this browser's guest files moved into the account");
});
