import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { diffBlocks, diffWords, hasChanges } from "@/lib/notes/diff";
import { blankNote } from "@/lib/notes/model";
import "@/lib/notes/reactions";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { analyticsOf, enforceCap, eventsOf, listVersions, pruneHistory, readVersion, recordView, versionsToDrop } from "@/lib/notes/versions";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace, deleteWorkspace } from "@/lib/workspaces";
import { GET as versionsGET } from "@/app/api/notes/versions/route";
import { GET as viewGET, POST as viewPOST } from "@/app/api/notes/view/route";

const DAY = 86_400_000;
const push = (ws: string, notes: Note[], by: string) => pushNotes(ws, notes.map((n) => ({ id: n.id, note: n })), { by, quotaLeft: Infinity });
const para = (text: string, id = "b1") => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
const page = (title: string, text: string, extra: Partial<Note> = {}) => blankNote({ kind: "page", title, content: [para(text)], ...extra });

test("versions: one session per person, a new one for someone else or after the gap, the state before a delete forever", () => {
  const ws = "ws-ver-1";
  const p = page("Plan", "first");
  push(ws, [p], "anna0001");
  assert.equal(listVersions(ws, p.id).length, 1);
  // The same person a moment later: the same version, updated.
  push(ws, [{ ...p, content: [para("second")], updatedAt: p.updatedAt + 1 }], "anna0001");
  let v = listVersions(ws, p.id);
  assert.equal(v.length, 1);
  assert.equal(readVersion(ws, p.id, v[0].id)?.note.content.length, 1);
  assert.match(JSON.stringify(readVersion(ws, p.id, v[0].id)?.note.content), /second/);
  // Someone else: a new version.
  push(ws, [{ ...p, content: [para("third")] }], "boris001");
  assert.equal(listVersions(ws, p.id).length, 2);
  // A favorite or a comment is not an edit.
  push(ws, [{ ...p, content: [para("third")], favorite: true, comments: [{ id: "c1", text: "hi", at: 1, author: "B" }] }], "boris001");
  assert.equal(listVersions(ws, p.id).length, 2);
  // The same person after the 10-minute gap: a new version.
  sql("UPDATE note_versions SET started = started - 11 * 60000 WHERE ws = ? AND note_id = ?").run(ws, p.id);
  push(ws, [{ ...p, content: [para("fourth")] }], "boris001");
  v = listVersions(ws, p.id);
  assert.equal(v.length, 3);
  assert.deepEqual(v.map((x) => x.by), ["boris001", "boris001", "anna0001"]);
  // A move and the trash are events, not versions.
  push(ws, [{ ...p, content: [para("fourth")], parentId: "parent001", trashedAt: Date.now() }], "boris001");
  assert.equal(listVersions(ws, p.id).length, 3);
  assert.deepEqual(eventsOf(ws, p.id).map((e) => e.kind).sort(), ["create", "move", "trash"]);
  // Deleted forever: its last state is kept as a "delete" version.
  pushNotes(ws, [{ id: p.id, deleted: true }], { by: "boris001", quotaLeft: Infinity });
  v = listVersions(ws, p.id);
  assert.equal(v[0].kind, "delete");
  assert.match(JSON.stringify(readVersion(ws, p.id, v[0].id)?.note.content), /fourth/);
});

test("versions: a page older than the history keeps its state before the first edit; blank pages wait", () => {
  const ws = "ws-ver-2";
  const old = page("Old", "before history");
  // Stored before the feature existed: no version rows.
  sql("INSERT INTO notes (ws, id, stamp, deleted, bytes, json) VALUES (?, ?, 1, 0, 10, ?)").run(ws, old.id, JSON.stringify(old));
  push(ws, [{ ...old, content: [para("after")] }], "anna0001");
  const v = listVersions(ws, old.id);
  assert.equal(v.length, 2);
  assert.match(JSON.stringify(readVersion(ws, old.id, v[1].id)?.note.content), /before history/);
  const blank = blankNote({ kind: "page" });
  push(ws, [blank], "anna0001");
  assert.equal(listVersions(ws, blank.id).length, 0);
});

test("versions: thinning keeps the newest, the last 30 days and one a day for a year", () => {
  const now = Date.UTC(2026, 9, 14, 12);
  const rows: { id: number; at: number; kind: string }[] = [];
  let id = 1;
  // Three versions a day for 400 days.
  for (let d = 0; d < 400; d++) for (let h = 0; h < 3; h++) rows.push({ id: id++, at: now - d * DAY - h * 3_600_000, kind: "edit" });
  const opts = { keepNewest: 10, keepDays: 30, maxDays: 365, deletedDays: 30 };
  const drop = new Set(versionsToDrop(rows, now, opts));
  const kept = rows.filter((r) => !drop.has(r.id));
  // 30 days whole (90), then one a day up to day 365 (335).
  assert.equal(kept.filter((r) => now - r.at < 30 * DAY).length, 90);
  assert.equal(kept.filter((r) => now - r.at >= 30 * DAY).length, 335);
  assert.ok(kept.every((r) => now - r.at < 365 * DAY));
  // The newest ones are kept whatever their age.
  const sparse = [{ id: 1, at: now - 900 * DAY, kind: "edit" }];
  assert.deepEqual(versionsToDrop(sparse, now, opts), []);
  // A page deleted forever loses everything after the grace period.
  assert.deepEqual(versionsToDrop([{ id: 2, at: now - 40 * DAY, kind: "delete" }, { id: 1, at: now - 41 * DAY, kind: "edit" }], now, opts).sort(), [1, 2]);
  assert.deepEqual(versionsToDrop([{ id: 2, at: now - 10 * DAY, kind: "delete" }], now, opts), []);
});

test("versions: the workspace cap drops the oldest first, never a page's newest", () => {
  const ws = "ws-ver-3";
  const pages = Array.from({ length: 3 }, (_, i) => page(`P${i}`, "x".repeat(2000)));
  for (const [k, p] of pages.entries()) {
    for (let i = 0; i < 5; i++) {
      push(ws, [{ ...p, content: [para(`${"y".repeat(1000)} ${k} ${i} ${Math.random()}`)] }], `user${i}000`);
    }
  }
  const before = sql("SELECT COUNT(*) AS n, SUM(bytes) AS b FROM note_versions WHERE ws = ?").get(ws) as { n: number; b: number };
  assert.equal(Number(before.n), 15);
  process.env.ZVENA_VERSIONS_WORKSPACE_BYTES = String(Math.floor(Number(before.b) / 3));
  try {
    assert.ok(enforceCap(ws, Date.now(), true) > 0);
  } finally {
    delete process.env.ZVENA_VERSIONS_WORKSPACE_BYTES;
  }
  const after = sql("SELECT COUNT(*) AS n, SUM(bytes) AS b FROM note_versions WHERE ws = ?").get(ws) as { n: number; b: number };
  assert.ok(Number(after.b) <= Math.floor(Number(before.b) / 3) || Number(after.n) === 3);
  for (const p of pages) assert.ok(listVersions(ws, p.id).length >= 1);
});

test("history API: members read it, others are refused; views count once per 30 minutes", async () => {
  const user = (name: string) => {
    const r = signInWith({ provider: "dev", subject: `ver-${name}`, name }, "2026-10-13");
    assert.ok(r.ok);
    return r.user.id;
  };
  const anna = user("Анна");
  const boris = user("Борис");
  const stranger = user("Чужой");
  const ws = createWorkspace(anna, "History");
  assert.ok(acceptInvite(boris, createInvite(anna, ws.id, "viewer").token));
  const p = page("Spec", "text");
  push(ws.id, [p], anna);
  const cookie = (uid: string) => `${sessionCookieName()}=${issueSession(uid)}`;
  const get = (uid: string, q: string) => versionsGET(new Request(`http://localhost/api/notes/versions?${q}`, { headers: { cookie: cookie(uid) } }));
  const list = await get(boris, `ws=${ws.id}&id=${p.id}`);
  assert.equal(list.status, 200);
  const body = (await list.json()) as { versions: { id: number; by: string }[]; names: Record<string, string> };
  assert.equal(body.versions.length, 1);
  assert.equal(body.names[anna], "Анна");
  const one = await get(boris, `ws=${ws.id}&id=${p.id}&v=${body.versions[0].id}`);
  assert.equal(((await one.json()) as { note: Note }).note.title, "Spec");
  assert.equal((await get(stranger, `ws=${ws.id}&id=${p.id}`)).status, 403);
  assert.equal((await get(boris, `ws=${ws.id}&id=${p.id}&v=999999`)).status, 404);

  const view = (uid: string) =>
    viewPOST(new Request(`http://localhost/api/notes/view?ws=${ws.id}`, { method: "POST", headers: { cookie: cookie(uid), host: "localhost:3100", origin: "http://localhost:3100", "content-type": "application/json" }, body: JSON.stringify({ noteId: p.id }) }));
  const r1 = await view(boris);
  assert.equal(r1.status, 200, await r1.clone().text());
  assert.equal(((await r1.json()) as { counted: boolean }).counted, true);
  assert.equal(((await (await view(boris)).json()) as { counted: boolean }).counted, false);
  assert.equal((await view(stranger)).status, 403);
  assert.equal(recordView(ws.id, p.id, anna, Date.now()), true);
  const stats = await viewGET(new Request(`http://localhost/api/notes/view?ws=${ws.id}&id=${p.id}&tz=180`, { headers: { cookie: cookie(anna) } }));
  const a = (await stats.json()) as ReturnType<typeof analyticsOf>;
  assert.equal(a.views, 2);
  assert.equal(a.viewers, 2);
  assert.equal(a.days.length, 28);
  assert.equal(a.days[27], 2);
  assert.deepEqual(a.editors.map((e) => e.name), ["Анна"]);

  // Old views and events go with the daily upkeep; everything goes with the workspace.
  sql("UPDATE note_views SET at = at - 400 * ? WHERE ws = ?").run(DAY, ws.id);
  assert.ok(pruneHistory().views >= 2);
  deleteWorkspace(anna, ws.id);
  assert.equal(listVersions(ws.id, p.id).length, 0);
});

test("diff: words and blocks", () => {
  assert.deepEqual(diffWords("the quick fox", "the slow fox"), [
    { op: "same", text: "the " },
    { op: "del", text: "quick" },
    { op: "add", text: "slow" },
    { op: "same", text: " fox" },
  ]);
  assert.deepEqual(diffWords("", "new"), [{ op: "add", text: "new" }]);
  const before = [para("Intro", "a"), para("Old line", "b"), para("Same", "c")];
  const after = [para("Intro", "a"), para("Same", "c"), para("Brand new", "d")];
  const d = diffBlocks(before, after);
  assert.deepEqual(d.map((x) => [x.status, x.block.text]), [
    ["same", "Intro"],
    ["removed", "Old line"],
    ["same", "Same"],
    ["added", "Brand new"],
  ]);
  const edited = diffBlocks([para("Hello world", "a")], [para("Hello brave world", "a")]);
  assert.equal(edited[0].status, "changed");
  assert.deepEqual(edited[0].words?.filter((w) => w.op !== "same"), [{ op: "add", text: "brave " }]);
  // A checked to-do is a change without new words.
  const todo = (checked: boolean) => [{ id: "t", type: "checkListItem", props: { checked }, content: [{ type: "text", text: "Ship", styles: {} }], children: [] }];
  const t = diffBlocks(todo(false), todo(true));
  assert.equal(t[0].status, "changed");
  assert.equal(t[0].words, undefined);
  // Nested blocks and blocks without ids are matched too.
  const nested = (text: string) => [{ type: "toggleListItem", props: {}, content: [{ type: "text", text: "Toggle", styles: {} }], children: [{ type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] }] }];
  const n = diffBlocks(nested("inside"), nested("inside"));
  assert.equal(hasChanges(n), false);
  assert.equal(n[1].block.depth, 1);
});
