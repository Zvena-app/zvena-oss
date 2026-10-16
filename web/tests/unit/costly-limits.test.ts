import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { perPersonRate } from "@/lib/byte-budget";
import { config } from "@/lib/config";
import { createEmailSignIn } from "@/lib/email-signin";
import { sitesCnameTarget } from "@/lib/enterprise/domains";
import { sendMail, takeMailBudget } from "@/lib/mail";
import { getTile, setMapsFetch, takeTileBudget, TileBudgetSpent, warnMapsContact } from "@/lib/maps";
import { invitePageByEmail, letter } from "@/lib/notes/invite-mail";
import { checkRate, clientIp, ipKey } from "@/lib/rate-limit";
import { readFormCapped } from "@/lib/safe-json";
import { sql } from "@/lib/store";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `costly-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let out: T;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}

// --- Page invitations ---------------------------------------------------------------

test("page invitations: a fixed subject, and no live links from the inviter's name or the page title", () => {
  const l = letter("en", "Support www.paypal-secure.example", "Verify your account at https://evil.example/login now", "https://zvena.test/share/abc", false);
  assert.equal(l.subject, "You were invited to a page in zvena");
  assert.ok(!/https:\/\/evil|www\.paypal|paypal-secure\.example/.test(l.text), l.text);
  assert.match(l.text, /https:\/\/zvena\.test\/share\/abc/, "our own link stays");
  assert.match(l.text, /Verify your account at/);
  for (const locale of ["ru", "es", "fr", "de", "zh", "ar"]) assert.ok(!letter(locale, "Eve http://x.example", "T", "u", true).subject.includes("Eve"), locale);
});

test("page invitations: new accounts send fewer a day, and the whole server has a daily cap", async () => {
  const fresh = person("Fresh");
  const now = Date.now();
  for (let i = 0; i < 10; i++) sql("INSERT INTO audit (at, actor, action) VALUES (?, ?, 'page.invite.mail')").run(now - 1000, fresh);
  await assert.rejects(invitePageByEmail("ws-x", "note-x", fresh, "a@example.org", "view", "en", now), /daily limit/);
  // An older account with the same count is still below its cap (it fails later, on the missing page — not on the limit).
  const old = person("Old");
  sql("UPDATE users SET created_at = ? WHERE id = ?").run(now - 30 * 86_400_000, old);
  for (let i = 0; i < 10; i++) sql("INSERT INTO audit (at, actor, action) VALUES (?, ?, 'page.invite.mail')").run(now - 1000, old);
  try {
    await invitePageByEmail("ws-x", "note-x", old, "a@example.org", "view", "en", now);
  } catch (e) {
    assert.ok(!/daily limit/.test((e as Error).message));
  }
  // The server's cap counts everyone's letters.
  await withEnv({ ZVENA_INVITE_MAIL_PER_DAY: "15" }, () => assert.rejects(invitePageByEmail("ws-x", "note-x", old, "a@example.org", "view", "en", now), /daily limit/));
});

// --- Rate limits by network ---------------------------------------------------------------

test("rate limits: IPv6 counts by /64, IPv4-mapped as IPv4, Cloudflare's IPv6 edges are recognised", () => {
  assert.equal(ipKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:0db8:0001:0002:ffff:eeee:dddd:cccc"), "2001:db8:1:2::/64");
  assert.equal(ipKey("[2001:db8:1:2::9]"), "2001:db8:1:2::/64");
  assert.equal(ipKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  assert.equal(ipKey("not-an-ip"), "not-an-ip");
  assert.equal(ipKey("1:2:3:4:5:6:7:8:9"), "1:2:3:4:5:6:7:8:9");
  const req = (h: Record<string, string>) => new Request("http://localhost:3100/x", { headers: h });
  // A Cloudflare IPv6 edge as the peer: the visitor's address is CF-Connecting-IP.
  assert.equal(clientIp(req({ "x-real-ip": "2606:4700:10::6814:1", "cf-connecting-ip": "198.51.100.4" })), "198.51.100.4");
  assert.equal(clientIp(req({ "x-real-ip": "2001:db8::5", "cf-connecting-ip": "198.51.100.4" })), "2001:db8::5", "anyone else cannot claim an address");
  // Rotating addresses inside one /64 shares one bucket.
  const scope = `t-${Date.now()}`;
  let ok = 0;
  for (let i = 1; i <= 10; i++) if (checkRate(req({ "x-real-ip": `2001:db8:aa:bb::${i.toString(16)}` }), scope, 5).ok) ok++;
  assert.equal(ok, 5);
  assert.ok(checkRate(req({ "x-real-ip": "2001:db8:aa:cc::1" }), scope, 5).ok, "another /64 is someone else");
});

test("per-person rate: a minute window per person", () => {
  const now = 1_000_000_000;
  for (let i = 0; i < 3; i++) assert.ok(perPersonRate("t", "p1", 3, now + i));
  assert.equal(perPersonRate("t", "p1", 3, now + 10), false);
  assert.ok(perPersonRate("t", "p2", 3, now + 10));
  assert.ok(perPersonRate("t", "p1", 3, now + 61_000));
});

// --- Sign-in letters ---------------------------------------------------------------

test("sign-in letters: 5 an hour and 12 a day per address, however the rows of the letters go", () => {
  const email = `victim-${Date.now()}@example.org`;
  for (let i = 0; i < 5; i++) assert.ok(createEmailSignIn(email, { next: "/home", guest: null }).ok);
  assert.deepEqual(createEmailSignIn(email, { next: "/home", guest: null }), { ok: false, error: "too-many" });
  // Expired, used up or voided by wrong codes: the letters were still sent.
  sql("DELETE FROM email_signin WHERE email = ?").run(email);
  assert.deepEqual(createEmailSignIn(email.toUpperCase(), { next: "/home", guest: null }), { ok: false, error: "too-many" });
  // An hour later: again, up to the daily cap.
  sql("UPDATE email_signin_sent SET at = at - 3700000").run();
  let sent = 0;
  for (let i = 0; i < 10; i++) if (createEmailSignIn(email, { next: "/home", guest: null }).ok) sent++;
  assert.equal(sent, 5);
  sql("UPDATE email_signin_sent SET at = at - 3700000").run();
  sent = 0;
  for (let i = 0; i < 10; i++) if (createEmailSignIn(email, { next: "/home", guest: null }).ok) sent++;
  assert.equal(sent, 2, "12 a day");
  // Only a keyed hash of the address is kept.
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM email_signin_sent WHERE who LIKE '%@%'").get() as { n: number }).n), 0);
});

// --- The server's mail budget ---------------------------------------------------------------

test("mail budget: one ceiling per hour and per day for the server, sign-in letters keep a reserve", async () => {
  sql("DELETE FROM mail_sent").run();
  await withEnv({ ZVENA_MAIL_PER_HOUR: "10", ZVENA_MAIL_PER_DAY: "1000" }, async () => {
    const now = Date.now();
    let other = 0;
    for (let i = 0; i < 12; i++) if (takeMailBudget(undefined, now)) other++;
    assert.equal(other, 8, "80% for everything but sign-in");
    assert.ok(takeMailBudget("signin", now));
    assert.ok(takeMailBudget("signin", now));
    assert.equal(takeMailBudget("signin", now), false);
    assert.equal(await sendMail({ to: "x@example.org", subject: "s", text: "t" }), "failed");
    // An hour later the hourly budget is back.
    assert.ok(takeMailBudget(undefined, now + 3_601_000));
  });
  sql("DELETE FROM mail_sent").run();
  await withEnv({ ZVENA_MAIL_PER_HOUR: "1000", ZVENA_MAIL_PER_DAY: "5" }, async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) assert.ok(takeMailBudget(undefined, now - i * 3_700_000));
    assert.equal(takeMailBudget(undefined, now), false, "the daily cap spans hours");
    assert.ok(takeMailBudget("signin", now));
  });
  sql("DELETE FROM mail_sent").run();
  assert.equal(await sendMail({ to: "x@example.org", subject: "s", text: "t" }), "outbox");
});

// --- Maps ---------------------------------------------------------------

test("maps: upstream tiles have a per-person and a server budget a day; cached tiles stay free", async () => {
  const day = Date.UTC(2031, 0, 1, 12);
  await withEnv({ ZVENA_MAPS_TILES_PER_USER_DAY: "3", ZVENA_MAPS_TILES_PER_DAY: "5" }, async () => {
    assert.ok(takeTileBudget("u1", day) && takeTileBudget("u1", day) && takeTileBudget("u1", day));
    assert.equal(takeTileBudget("u1", day), false);
    assert.ok(takeTileBudget("u2", day) && takeTileBudget("u2", day));
    assert.equal(takeTileBudget("u3", day), false, "the server's budget");
    assert.ok(takeTileBudget("u1", day + 86_400_000), "a new day");
  });
  let fetched = 0;
  setMapsFetch(async () => {
    fetched++;
    return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  });
  try {
    await withEnv({ ZVENA_MAPS_TILES_PER_USER_DAY: "1", ZVENA_MAPS_TILES_PER_DAY: "100" }, async () => {
      const now = Date.UTC(2031, 5, 1, 12);
      assert.ok(await getTile({ z: 3, x: 1, y: 1 }, now, "mapper"));
      await assert.rejects(getTile({ z: 3, x: 1, y: 2 }, now, "mapper"), (e: unknown) => e instanceof TileBudgetSpent);
      assert.ok(await getTile({ z: 3, x: 1, y: 1 }, now, "mapper"), "a cached tile is served without budget");
      assert.equal(fetched, 1);
    });
  } finally {
    setMapsFetch(null);
  }
});

test("maps: a missing ZVENA_MAPS_CONTACT is said once in the log while OpenStreetMap is the upstream", () => {
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void said.push(m);
  try {
    withEnv({ ZVENA_MAPS_CONTACT: undefined, ZVENA_TILES_URL: undefined, ZVENA_GEOCODER_URL: undefined }, () => {
      const first = warnMapsContact();
      warnMapsContact();
      // Another test may have triggered it already in this process.
      assert.equal(said.length, first ? 1 : 0);
      if (first) assert.match(said[0], /ZVENA_MAPS_CONTACT/);
    });
  } finally {
    console.warn = warn;
  }
});

// --- Request bodies ---------------------------------------------------------------

test("forms on routes without a session are read with a cap", async () => {
  const post = (body: string) => new Request("http://localhost:3100/api/auth/email/start", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const ok = await readFormCapped(post("email=a%40b.co&next=%2Fhome"));
  assert.equal(ok?.get("email"), "a@b.co");
  assert.equal(await readFormCapped(post(`email=${"a".repeat(70_000)}`)), null);
  const { POST } = await import("@/app/api/auth/email/start/route");
  const big = new Request("http://localhost:3100/api/auth/email/start", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:3100", host: "localhost:3100", "x-real-ip": "198.51.100.77" },
    body: `email=${"a".repeat(2_000_000)}`,
  });
  const r = await POST(big);
  assert.ok(r.status >= 300 && r.status < 500, String(r.status));
});

// --- This instance's identity ---------------------------------------------------------------

test("own identity: default addresses and the sites CNAME come from APP_URL, never another install's domain", () => {
  withEnv({ APP_URL: "https://work.example.org", ZVENA_SITES_CNAME: undefined, ZVENA_SUPPORT_EMAIL: undefined, ZVENA_CONTACT_EMAIL: undefined, MAIL_FROM: undefined }, () => {
    assert.equal(sitesCnameTarget(), "sites.work.example.org");
    assert.equal(config.company.email, "admin@work.example.org");
    assert.equal(config.company.supportEmail, "admin@work.example.org", "one inbox unless the operator sets more");
    assert.equal(config.resend.from, "zvena <noreply@work.example.org>");
  });
  withEnv({ APP_URL: "https://zvena.app", ZVENA_SITES_CNAME: undefined, ZVENA_SUPPORT_EMAIL: undefined, ZVENA_CONTACT_EMAIL: undefined, MAIL_FROM: undefined }, () => {
    assert.equal(sitesCnameTarget(), "sites.zvena.app");
    assert.equal(config.company.email, "admin@zvena.app");
  });
  withEnv({ ZVENA_SITES_CNAME: "cname.example.net" }, () => assert.equal(sitesCnameTarget(), "cname.example.net"));
});
