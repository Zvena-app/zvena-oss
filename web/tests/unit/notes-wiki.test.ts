import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { grant } from "@/lib/notes/access";
import { blankNote, sanitizeNote, shortId } from "@/lib/notes/model";
import { pullNotes, pushNotes } from "@/lib/notes/server-store";
import { asWiki, untilAfter, verificationState, verifiedBy } from "@/lib/notes/verification";
import { setVerifyNotifierForTests, verificationUpkeep } from "@/lib/notes/verification-server";
import { valueText, applyView } from "@/lib/notes/db";
import type { Note } from "@/lib/notes/types";
import { signInWith } from "@/lib/auth";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `wiki-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}
/** Owner Olga, editors Anna and Boris. */
function team() {
  const olga = person("Olga");
  const anna = person("Anna");
  const boris = person("Boris");
  const ws = createWorkspace(olga, `Wiki team ${n}`).id;
  for (const u of [anna, boris]) assert.ok(acceptInvite(u, createInvite(olga, ws, "editor").token));
  return { ws, olga, anna, boris };
}
const as = (ws: string, userId: string, notes: Note[]) => pushNotes(ws, notes.map((x) => ({ id: x.id, note: x })), { by: userId, quotaLeft: Infinity, author: userId, access: { userId } });

const DAY = 86_400_000;

function wiki(t: ReturnType<typeof team>) {
  const db = blankNote({ kind: "database", title: "Handbook" });
  db.db = asWiki({ properties: [{ id: "title", name: "Name", type: "title" }], views: [] }, { owner: "Owner", verification: "Verification" }, shortId);
  as(t.ws, t.olga, [db]);
  const owner = db.db.wiki?.owner as string;
  const ver = db.db.wiki?.verification as string;
  const row = blankNote({ kind: "page", title: "Onboarding", parentId: db.id, props: { [owner]: [t.anna] } });
  as(t.ws, t.olga, [row]);
  return { db, row, owner, ver };
}
const get = (ws: string, id: string) => pullNotes(ws, 0).notes.find((n) => n.id === id) as Note;

test("wiki: the sanitizer keeps a verification and the wiki wiring", () => {
  const n = sanitizeNote({ ...blankNote({ kind: "page", title: "x" }), props: { v: { state: "verified", by: "abcdefgh", at: 5, until: "2026-11-01", evil: "<x>" } } });
  assert.deepEqual(n?.props?.v, { state: "verified", by: "abcdefgh", at: 5, until: "2026-11-01" });
  const db = blankNote({ kind: "database", title: "W" });
  db.db = asWiki({ properties: [{ id: "title", name: "Name", type: "title" }], views: [] }, { owner: "Owner", verification: "Verification" }, shortId);
  const back = sanitizeNote(JSON.parse(JSON.stringify(db)));
  assert.deepEqual(back?.db?.wiki, db.db.wiki);
  assert.ok(back?.db?.properties.some((p) => p.type === "verification"));
});

test("wiki: owners and full access verify, as themselves; editors and integrations cannot", () => {
  const t = team();
  const { row, ver } = wiki(t);
  const now = Date.now();
  // Boris (editor, not an owner) cannot verify; Anna (owner, editor) can.
  as(t.ws, t.boris, [{ ...get(t.ws, row.id), props: { ...get(t.ws, row.id).props, [ver]: verifiedBy(t.boris, 30, now) } }]);
  assert.equal(verificationState(get(t.ws, row.id).props?.[ver]), "unverified");
  // Nor in someone else's name.
  as(t.ws, t.anna, [{ ...get(t.ws, row.id), props: { ...get(t.ws, row.id).props, [ver]: verifiedBy(t.olga, 30, now) } }]);
  assert.equal(verificationState(get(t.ws, row.id).props?.[ver]), "unverified");
  // Nor for a day already past.
  as(t.ws, t.anna, [{ ...get(t.ws, row.id), props: { ...get(t.ws, row.id).props, [ver]: verifiedBy(t.anna, "2020-01-01", now) } }]);
  assert.equal(verificationState(get(t.ws, row.id).props?.[ver]), "unverified");
  as(t.ws, t.anna, [{ ...get(t.ws, row.id), props: { ...get(t.ws, row.id).props, [ver]: verifiedBy(t.anna, 30, now) } }]);
  assert.equal(verificationState(get(t.ws, row.id).props?.[ver]), "verified");
  // An editor's other edits land while the verification stays.
  as(t.ws, t.boris, [{ ...get(t.ws, row.id), title: "Onboarding v2", props: { ...get(t.ws, row.id).props, [ver]: { state: "unverified" } } }]);
  assert.equal(get(t.ws, row.id).title, "Onboarding v2");
  assert.equal(verificationState(get(t.ws, row.id).props?.[ver]), "verified");
  // Full access (the workspace owner) may remove it.
  as(t.ws, t.olga, [{ ...get(t.ws, row.id), props: { ...get(t.ws, row.id).props, [ver]: { state: "unverified" } } }]);
  assert.equal(verificationState(get(t.ws, row.id).props?.[ver]), "unverified");
  // An integration's push never changes it.
  const cur = get(t.ws, row.id);
  pushNotes(t.ws, [{ id: row.id, note: { ...cur, props: { ...cur.props, [ver]: verifiedBy(t.olga, null, now) } } }], { by: `integration:${"a".repeat(32)}`, quotaLeft: Infinity, columnsFor: `integration:${"a".repeat(32)}` });
  assert.equal(verificationState(get(t.ws, row.id).props?.[ver]), "unverified");
});

test("wiki: only full access turns a database into a wiki", () => {
  const t = team();
  const db = blankNote({ kind: "database", title: "Tasks" });
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [] };
  as(t.ws, t.olga, [db]);
  grant(t.ws, db.id, t.boris, "edit", t.olga);
  as(t.ws, t.boris, [{ ...get(t.ws, db.id), db: asWiki(get(t.ws, db.id).db!, { owner: "Owner", verification: "Verification" }, shortId) }]);
  const after = get(t.ws, db.id);
  assert.equal(after.db?.wiki, undefined);
  // The properties he added stay (an editor may add properties); the wiki flag does not.
  assert.ok(after.db?.properties.some((p) => p.type === "verification"));
  as(t.ws, t.olga, [{ ...after, db: asWiki(after.db!, { owner: "Owner", verification: "Verification" }, shortId) }]);
  assert.ok(get(t.ws, db.id).db?.wiki?.verification);
});

test("wiki: the daily upkeep expires verifications and tells the owners first", () => {
  const t = team();
  const { db, row, ver } = wiki(t);
  const now = Date.now();
  as(t.ws, t.olga, [{ ...get(t.ws, row.id), props: { ...get(t.ws, row.id).props, [ver]: verifiedBy(t.olga, 3, now) } }]);
  const told: { to: string; text?: string }[] = [];
  const prev = setVerifyNotifierForTests((to, n) => told.push({ to, text: n.text }));
  try {
    assert.deepEqual(verificationUpkeep(now), { expired: 0, warned: 1 });
    assert.equal(told[0].to, t.anna);
    assert.match(String(told[0].text), /expires/);
    // Once per verification.
    assert.equal(verificationUpkeep(now + 60_000).warned, 0);
    const later = now + 5 * DAY;
    assert.equal(verificationUpkeep(later).expired, 1);
    const v = get(t.ws, row.id).props?.[ver];
    assert.equal((v as { state: string }).state, "unverified");
    assert.equal(verificationState(v, untilAfter(0, later)), "expired");
    assert.ok(told.some((x) => /expired/.test(String(x.text))));
    // Filters and text see the state.
    const schema = get(t.ws, db.id).db!;
    const p = schema.properties.find((x) => x.id === ver)!;
    assert.equal(valueText(p, v ?? null, "en"), verificationState(v) === "expired" ? "Expired" : "");
    const view = { id: "v", name: "", type: "table" as const, filters: [{ id: "f", prop: ver, op: "is" as const, value: "verified" }], sorts: [], hidden: [], widths: {} };
    assert.equal(applyView([get(t.ws, row.id)], view, schema).length, 0);
  } finally {
    setVerifyNotifierForTests(prev);
  }
});

test("wiki: a verification lasts through its last day where the verifier is (their time zone)", async () => {
  const { setTimeZone } = await import("@/lib/notes/reminders-server");
  const t = team();
  const { row, ver } = wiki(t);
  // Until today (UTC): at 11:30 UTC it is already tomorrow in Auckland (UTC+12/+13), still today in UTC.
  const d = new Date();
  const today = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 30);
  as(t.ws, t.olga, [{ ...get(t.ws, row.id), props: { ...get(t.ws, row.id).props, [ver]: verifiedBy(t.olga, today) } }]);
  setTimeZone(t.olga, "UTC");
  const prevUtc = setVerifyNotifierForTests(() => {});
  assert.equal(verificationUpkeep(now).expired, 0, "in UTC the day is not over");
  setVerifyNotifierForTests(prevUtc);
  setTimeZone(t.olga, "Pacific/Auckland");
  const prev = setVerifyNotifierForTests(() => {});
  try {
    assert.equal(verificationUpkeep(now).expired, 1, "past its day in Auckland, though not yet in UTC");
  } finally {
    setVerifyNotifierForTests(prev);
  }
});

test("wiki: owners hear of expiring verifications in their own language", async () => {
  const { rememberUserLocale } = await import("@/lib/user-locale");
  const t = team();
  const { row, ver } = wiki(t);
  const now = Date.now();
  as(t.ws, t.olga, [{ ...get(t.ws, row.id), props: { ...get(t.ws, row.id).props, [ver]: verifiedBy(t.olga, 3, now) } }]);
  rememberUserLocale(t.anna, "es");
  const told: string[] = [];
  const prev = setVerifyNotifierForTests((_to, n) => told.push(String(n.text)));
  try {
    verificationUpkeep(now);
    assert.match(told[0], /^La verificación de .+ vence el /);
  } finally {
    setVerifyNotifierForTests(prev);
  }
});
