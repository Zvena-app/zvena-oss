import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { notify, type InboxNote } from "@/lib/eco/inbox";
import { ecoDb } from "@/lib/eco/schema";
import { docsPrefs, follows, mutedKind, setDocsPrefs, setFollow } from "@/lib/notes/follows";
import { blankNote } from "@/lib/notes/model";
import { setNotifierForTests } from "@/lib/notes/notify-people";
import "@/lib/notes/reactions";
import { blockWith, searchNotes } from "@/lib/notes/search";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { upcomingDates } from "@/lib/notes/upcoming";
import { analyticsOf, recordView } from "@/lib/notes/versions";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace, deleteWorkspace } from "@/lib/workspaces";
import { GET as followGET, POST as followPOST } from "@/app/api/notes/follow/route";
import { GET as tzGET, POST as tzPOST } from "@/app/api/notes/tz/route";
import { POST as teamspacesPOST } from "@/app/api/notes/teamspaces/route";
import { createTeamspace, teamspacesOf } from "@/lib/notes/teamspaces";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `par-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}
const cookie = (uid: string) => `${sessionCookieName()}=${issueSession(uid)}`;
const post = (url: string, uid: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie: cookie(uid), host: "localhost:3100", origin: "http://localhost:3100", "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string, uid: string) => new Request(`http://localhost${url}`, { headers: { cookie: cookie(uid) } });
const para = (text: string, id = "b1", extra: unknown[] = []) => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }, ...extra], children: [] });

test("notification settings: a kind turned off never reaches the Inbox; invitations always do", () => {
  const anna = person("Anna");
  const boris = person("Boris");
  const ws = createWorkspace(anna, `Prefs ${n}`).id;
  assert.ok(acceptInvite(boris, createInvite(anna, ws, "editor").token));
  ecoDb();
  const count = () => Number((sql("SELECT COUNT(*) AS c FROM eco_inbox WHERE user_id = ?").get(boris) as { c: number }).c);
  const note = (kind: InboxNote["kind"], part: string): InboxNote => ({ ws, kind, ref: "note:abcdefgh", by: anna, part, text: "x" });
  notify(boris, note("mention", "p1"));
  assert.equal(count(), 1);
  assert.deepEqual(setDocsPrefs(boris, { notify: { mention: false, suggestion: false, bogus: false } }).muted.sort(), ["mention", "suggestion"]);
  assert.equal(mutedKind(boris, "mention"), true);
  assert.equal(mutedKind(boris, "suggestion_accepted"), true);
  assert.equal(mutedKind(boris, "invite"), false);
  notify(boris, note("mention", "p2"));
  notify(boris, note("suggestion_rejected", "p3"));
  assert.equal(count(), 1);
  notify(boris, note("invite", "p4"));
  notify(boris, note("reply", "p5"));
  assert.equal(count(), 3);
  // Back on.
  setDocsPrefs(boris, { notify: { mention: true } });
  notify(boris, note("mention", "p6"));
  assert.equal(count(), 4);
  assert.deepEqual(docsPrefs(boris), { muted: ["suggestion"], viewHistory: true, emailDigest: true });
});

test("following a page: its edits (one fresh notification) and its comments reach the follower", async () => {
  const sent: { to: string; n: InboxNote }[] = [];
  const prev = setNotifierForTests((to, x) => void sent.push({ to, n: x }));
  try {
    const anna = person("Anna");
    const vera = person("Vera");
    const ws = createWorkspace(anna, `Follow ${n}`).id;
    assert.ok(acceptInvite(vera, createInvite(anna, ws, "viewer").token));
    const page = blankNote({ kind: "page", title: "Plan", content: [para("one")] });
    pushNotes(ws, [{ id: page.id, note: page }], { by: anna, quotaLeft: Infinity, author: "Anna", access: { userId: anna } });
    // Vera follows it through the API (she may read the page; workspace pages are everyone's).
    assert.equal(((await (await followGET(get(`/api/notes/follow?ws=${ws}&id=${page.id}`, vera))).json()) as { following: boolean }).following, false);
    const r = await followPOST(post(`/api/notes/follow?ws=${ws}&id=${page.id}`, vera, { on: true }));
    assert.equal(((await r.json()) as { following: boolean }).following, true);
    assert.equal(follows(ws, page.id, vera), true);
    sent.length = 0;
    pushNotes(ws, [{ id: page.id, note: { ...page, content: [para("two")] } }], { by: anna, quotaLeft: Infinity, author: "Anna", access: { userId: anna } });
    assert.deepEqual(sent.map((x) => [x.to === vera, x.n.kind]), [[true, "page_update"]]);
    sent.length = 0;
    pushNotes(ws, [{ id: page.id, note: { ...page, content: [para("two")], comments: [{ id: "c1", text: "Looks good", at: Date.now(), author: "Anna" }] } }], { by: anna, quotaLeft: Infinity, author: "Anna", access: { userId: anna } });
    assert.deepEqual(sent.map((x) => [x.to === vera, x.n.kind]), [[true, "comment"]]);
    // Her own edits never tell her; unfollowed, nothing comes.
    setFollow(ws, page.id, vera, false);
    sent.length = 0;
    pushNotes(ws, [{ id: page.id, note: { ...page, content: [para("three")] } }], { by: anna, quotaLeft: Infinity, author: "Anna", access: { userId: anna } });
    assert.equal(sent.length, 0);
    // Someone who cannot read a page cannot follow it.
    const stranger = person("Stranger");
    assert.equal((await followPOST(post(`/api/notes/follow?ws=${ws}&id=${page.id}`, stranger, { on: true }))).status, 403);
    // A deleted workspace takes its follows along.
    setFollow(ws, page.id, vera, true);
    deleteWorkspace(anna, ws);
    assert.equal(follows(ws, page.id, vera), false);
  } finally {
    setNotifierForTests(prev);
  }
});

test("page view history off: visits are not recorded, and the person is not listed among viewers", () => {
  const anna = person("Anna");
  const boris = person("Boris");
  const ws = `ws-par-views-${n}`;
  assert.equal(recordView(ws, "pageviews01", boris), true);
  setDocsPrefs(boris, { viewHistory: false });
  assert.equal(recordView(ws, "pageviews02", boris), false);
  assert.equal(recordView(ws, "pageviews02", anna), true);
  assert.deepEqual(analyticsOf(ws, "pageviews01").recentViewers, []);
  assert.deepEqual(analyticsOf(ws, "pageviews02").recentViewers.map((v) => v.id), [anna]);
});

test("time zone: chosen in Settings, the browser's report no longer changes it", async () => {
  const anna = person("Anna");
  const read = async () => (await (await tzGET(get("/api/notes/tz", anna))).json()) as { tz: string; manual: boolean };
  await tzPOST(post("/api/notes/tz", anna, { tz: "Europe/Paris" }));
  assert.deepEqual(await read(), { tz: "Europe/Paris", manual: false });
  await tzPOST(post("/api/notes/tz", anna, { tz: "Asia/Tokyo", manual: true }));
  await tzPOST(post("/api/notes/tz", anna, { tz: "Europe/Paris" }));
  assert.deepEqual(await read(), { tz: "Asia/Tokyo", manual: true });
  await tzPOST(post("/api/notes/tz", anna, { tz: "America/New_York", manual: false }));
  await tzPOST(post("/api/notes/tz", anna, { tz: "Europe/Paris" }));
  assert.deepEqual(await read(), { tz: "Europe/Paris", manual: false });
  assert.equal((await tzPOST(post("/api/notes/tz", anna, { tz: "Mars/Olympus" }))).status, 400);
});

test("Home's upcoming dates: mentions and row dates of the next days, soonest first", () => {
  const mention = (date: string) => ({ type: "mention", props: { noteId: "", date, remind: "" } });
  const a = blankNote({ kind: "page", title: "Trip", content: [para("Flight ", "b1", [mention("2026-10-20T07:30")]), para("Visa ", "b2", [mention("2026-10-17")]), para("Old ", "b3", [mention("2026-10-01")])] });
  const db = blankNote({ kind: "database", title: "Tasks" });
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "due", name: "Due", type: "date" }], views: [] } as unknown as Note["db"];
  const row = blankNote({ kind: "page", parentId: db.id, title: "Ship", props: { due: { start: "2026-10-18" } } as never });
  const trashed = blankNote({ kind: "page", title: "Gone", content: [para("x ", "b9", [mention("2026-10-16")])], trashedAt: Date.now() });
  const list = upcomingDates([a, db, row, trashed], (id) => (id === db.id ? db.db : undefined), "2026-10-15", "2026-10-29", () => false);
  assert.deepEqual(
    list.map((u) => [u.noteId === a.id ? "a" : "row", u.date, u.blockId ?? ""]),
    [
      ["a", "2026-10-17", "b2"],
      ["row", "2026-10-18", ""],
      ["a", "2026-10-20T07:30", "b1"],
    ]
  );
});

test("archived teamspaces: only a manager archives or restores; everyone sees the mark", async () => {
  const anna = person("Anna");
  const boris = person("Boris");
  const ws = createWorkspace(anna, `Ts ${n}`).id;
  assert.ok(acceptInvite(boris, createInvite(anna, ws, "editor").token));
  const ts = createTeamspace(ws, anna, { name: "Design" });
  const call = (uid: string, op: string) => teamspacesPOST(post(`/api/notes/teamspaces?ws=${ws}`, uid, { op, id: ts.id }));
  assert.equal((await call(boris, "archive")).status, 403);
  assert.equal((await call(anna, "archive")).status, 200);
  assert.equal(teamspacesOf(ws, boris).find((x) => x.id === ts.id)?.archived, true);
  assert.equal((await call(anna, "unarchive")).status, 200);
  assert.equal(teamspacesOf(ws, anna).find((x) => x.id === ts.id)?.archived, undefined);
});

test("Quick Find: a match in the text names its block (opening the hit scrolls there)", () => {
  const p = blankNote({ kind: "page", title: "Handbook", content: [para("Intro"), { id: "b2", type: "toggleListItem", props: {}, content: [{ type: "text", text: "Holidays", styles: {} }], children: [para("Vacation policy: 25 days", "b3")] }] });
  assert.equal(blockWith(p.content, "vacation"), "b3");
  const hits = searchNotes([p], "vacation", () => false);
  assert.equal(hits[0]?.block, "b3");
  // A title match needs no block; titles only never looks into the text.
  assert.equal(searchNotes([p], "handbook", () => false)[0]?.block, undefined);
  assert.equal(searchNotes([p], "vacation", () => false, { titleOnly: true }).length, 0);
});
