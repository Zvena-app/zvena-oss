import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteAccount } from "@/lib/account";
import { signInWith } from "@/lib/auth";
import { recentDocs } from "@/lib/docs-summary";
import { blankNote, defaultView, lostRoots } from "@/lib/notes/model";
import { openNoteForm, pullNotes, pushNotes, readNoteForm, submitNoteForm, validShareSnapshot } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { readBodyCapped, readJsonCapped } from "@/lib/safe-json";
import { recordFile } from "@/lib/storage";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace, workspacesOf } from "@/lib/workspaces";

const push = (ws: string, notes: Note[], opts: Partial<Parameters<typeof pushNotes>[2]> = {}) =>
  pushNotes(ws, notes.map((n) => ({ id: n.id, note: n })), { by: "u1", quotaLeft: Infinity, ...opts });

// Runs first in this process: the stamp counter starts from what is stored.
test("stamps continue above the stored maximum (a clock set back after a restart)", () => {
  const future = Date.now() + 10 * 86_400_000;
  sql("INSERT INTO notes (ws, id, stamp, deleted, bytes, json) VALUES ('ws-clock', 'old-note', ?, 1, 0, NULL)").run(future);
  const res = push("ws-clock", [blankNote({ kind: "page", title: "after restart" })]);
  assert.ok(res.stamp > future);
  assert.equal(pullNotes("ws-clock", future).notes.length, 1);
});

test("sync: pull pages through the cursor, deletions leave tombstones", () => {
  const ws = "ws-sync";
  const notes = Array.from({ length: 5 }, (_, i) => blankNote({ kind: "page", title: `p${i}` }));
  const res = push(ws, notes);
  assert.equal(res.saved.length, 5);
  const all = pullNotes(ws, 0);
  assert.deepEqual(all.notes.map((n) => n.title), ["p0", "p1", "p2", "p3", "p4"]);
  assert.equal(all.more, false);
  pushNotes(ws, [{ id: notes[0].id, deleted: true }], { by: "u1", quotaLeft: Infinity });
  const after = pullNotes(ws, all.cursor);
  assert.deepEqual(after.deleted, [notes[0].id]);
  assert.equal(after.notes.length, 0);
});

test("sync: a commenter changes only comments, and only their own", () => {
  const ws = "ws-comment";
  const page = blankNote({ kind: "page", title: "Plan" });
  push(ws, [{ ...page, comments: [{ id: "c0", text: "first", at: 1, author: "Борис" }] }], { author: "Борис" });
  const asGalya = (n: Note) => push(ws, [n], { commentsOnly: true, author: "Галя" });
  const stored = () => pullNotes(ws, 0).notes.find((n) => n.id === page.id) as Note;
  // A new comment is signed with the commenter's own name; other edits of the page are ignored.
  const res = asGalya({ ...page, title: "Hacked", comments: [{ id: "c0", text: "first", at: 1, author: "Борис" }, { id: "c1", text: "ok?", at: 2, author: "Борис" }] });
  assert.deepEqual(res.saved, [page.id]);
  assert.equal(stored().title, "Plan");
  assert.deepEqual(stored().comments?.map((c) => [c.id, c.author]), [["c0", "Борис"], ["c1", "Галя"]]);
  // Someone else's comment cannot be rewritten or dropped; resolving and an own reaction can.
  const own = stored().comments?.find((c) => c.id === "c1") as NonNullable<Note["comments"]>[number];
  asGalya({ ...stored(), comments: [{ id: "c0", text: "rewritten", at: 1, author: "Борис", resolved: true, reactions: { "👍": ["Галя", "Борис"] } }, own] });
  const c0 = stored().comments?.find((c) => c.id === "c0");
  assert.equal(c0?.text, "first");
  assert.equal(c0?.resolved, true);
  assert.deepEqual(c0?.reactions, { "👍": ["Галя"] });
  assert.ok(stored().comments?.some((c) => c.id === "c1"));
  // Dropping a comment of someone else is undone; dropping one's own deletes it.
  asGalya({ ...stored(), comments: [own] });
  assert.ok(stored().comments?.some((c) => c.id === "c0"));
  // A commenter cannot create or delete pages.
  assert.equal(asGalya(blankNote({ kind: "page" })).rejected[0]?.reason, "read only");
  assert.equal(pushNotes(ws, [{ id: page.id, deleted: true }], { by: "g", quotaLeft: Infinity, commentsOnly: true, author: "Галя" }).rejected[0]?.reason, "read only");
  // An editor may remove someone else's comment, not rewrite it.
  push(ws, [{ ...stored(), comments: [{ id: "c1", text: "edited by Boris", at: 2, author: "Галя" }] }], { author: "Борис" });
  assert.deepEqual(stored().comments?.map((c) => [c.id, c.text, c.author]), [["c1", "ok?", "Галя"]]);
});

test("sync: quota and size limits reject per note", () => {
  const ws = "ws-quota";
  const small = blankNote({ kind: "page", title: "small" });
  const big = blankNote({ kind: "page", title: "big", content: [{ type: "paragraph", content: "x".repeat(5000) }] });
  const res = push(ws, [small, big], { quotaLeft: 3000 });
  assert.deepEqual(res.saved, [small.id]);
  assert.equal(res.rejected[0]?.id, big.id);
  assert.equal(res.rejected[0]?.reason, "quota");
});

function formDb(ws: string, parentId: string | null = null): { db: Note; viewId: string; formId: string; titleProp: string } {
  const db = blankNote({ kind: "database", title: "Заявки", parentId });
  const view = defaultView("form", "Form");
  db.db = { properties: [{ id: "title", name: "Имя", type: "title" }], views: [view] };
  const formId = openNoteForm(ws, db.id, view.id);
  view.form = { questions: [{ prop: "title", required: true }], shareId: formId };
  push(ws, [db]);
  return { db, viewId: view.id, formId, titleProp: "title" };
}

test("forms: a response becomes a row; a form inside a trashed page is closed", () => {
  const ws = "ws-form";
  const { db, formId } = formDb(ws);
  assert.equal(readNoteForm(formId)?.questions.length, 1);
  assert.equal(submitNoteForm(formId, {}).ok, false);
  const res = submitNoteForm(formId, { title: "Пётр" });
  assert.equal(res.ok, true);
  const row = pullNotes(ws, 0).notes.find((n) => n.parentId === db.id);
  assert.equal(row?.title, "Пётр");

  const page = blankNote({ kind: "page", title: "Old project", trashedAt: Date.now() });
  push(ws, [page]);
  const nested = formDb(ws, page.id);
  assert.equal(readNoteForm(nested.formId), null);
  assert.equal(submitNoteForm(nested.formId, { title: "x" }).ok, false);
});

test("public copies keep no comments, share keys or form links", () => {
  const page = blankNote({ kind: "page", title: "Pub", comments: [{ id: "c", text: "secret", at: 1, author: "A" }], share: { id: "s".repeat(16), key: "k", at: 1 } });
  const db = blankNote({ kind: "database", title: "DB", parentId: page.id });
  const view = defaultView("form", "Form");
  view.form = { questions: [], shareId: "abcdefghij12" };
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [view] };
  const snap = validShareSnapshot({ notes: [page, db], rootId: page.id });
  assert.ok(snap);
  const root = snap.notes.find((n) => n.id === page.id);
  assert.equal(root?.comments, undefined);
  assert.equal(root?.share, undefined);
  assert.equal(snap.notes.find((n) => n.id === db.id)?.db?.views[0].form?.shareId, undefined);
});

test("Home lists pages, not rows of an older database or pages in the trash", () => {
  const ws = "ws-home";
  const db = blankNote({ kind: "database", title: "Tasks", updatedAt: 1 });
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [] };
  push(ws, [db]);
  // The database falls out of the 400 most recent notes.
  sql("UPDATE notes SET client_at = 0 WHERE ws = ? AND id = ?").run(ws, db.id);
  const trashed = blankNote({ kind: "page", title: "Trashed", trashedAt: Date.now() });
  const child = blankNote({ kind: "page", title: "Child of trashed", parentId: trashed.id });
  const row = blankNote({ kind: "page", title: "Row", parentId: db.id });
  const page = blankNote({ kind: "page", title: "Visible" });
  const fillers = Array.from({ length: 401 }, (_, i) => blankNote({ kind: "page", title: `f${i}`, updatedAt: 10 + i, parentId: trashed.id }));
  for (let i = 0; i < fillers.length; i += 80) push(ws, fillers.slice(i, i + 80));
  push(ws, [trashed, child, row, page]);
  const titles = recentDocs(ws, 50).map((d) => d.title);
  assert.ok(titles.includes("Visible"));
  assert.ok(!titles.includes("Row"));
  assert.ok(!titles.includes("Trashed"));
  assert.ok(!titles.includes("Child of trashed"));
});

function chunked(parts: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
  return new Request("http://localhost/x", { method: "POST", body, duplex: "half" } as RequestInit & { duplex: "half" });
}

test("request bodies are cut off at the cap while streaming (no Content-Length)", async () => {
  const kb = new Uint8Array(1024).fill(97);
  assert.deepEqual(await readBodyCapped(chunked([kb, kb, kb]), 2048), { ok: false, status: 413 });
  const ok = await readBodyCapped(chunked([kb, kb]), 2048);
  assert.equal(ok.ok && ok.bytes.byteLength, 2048);
  const json = await readJsonCapped(chunked([new TextEncoder().encode('{"a":"Привет"}')]), 100);
  assert.equal(json.ok && (json.value as { a: string }).a, "Привет");
  assert.deepEqual(await readJsonCapped(chunked([new TextEncoder().encode("{bad")]), 100), { ok: false, status: 400 });
});

test("an owner deletes the account: the team keeps its workspace and its files", async () => {
  const user = (name: string) => {
    const r = signInWith({ provider: "dev", subject: `files-${name}`, name }, "2026-10-13");
    assert.ok(r.ok);
    return r.user.id;
  };
  const owner = user("Owner");
  const member = user("Member");
  const ws = createWorkspace(owner, "Team");
  assert.ok(acceptInvite(member, createInvite(owner, ws.id, "editor").token));
  const dir = process.env.ZVENA_FILES_DIR as string;
  mkdirSync(dir, { recursive: true });
  const shown = `${"a".repeat(40)}.png`;
  const unused = `${"b".repeat(40)}.png`;
  for (const name of [shown, unused]) {
    writeFileSync(join(dir, name), "x");
    recordFile({ kind: "user", id: owner }, name, 1);
  }
  push(ws.id, [blankNote({ kind: "page", title: "Brand", content: [{ type: "image", props: { url: `/api/notes/file/${shown}` } }] })]);
  await deleteAccount(owner);
  assert.equal(workspacesOf(member).find((w) => w.id === ws.id)?.role, "owner");
  assert.equal(existsSync(join(dir, shown)), true);
  assert.equal(existsSync(join(dir, unused)), false);
  assert.equal(sql("SELECT COUNT(*) AS n FROM files WHERE name = ? AND owner_id = ?").get(shown, member)?.n, 1);
});

test("pages cut off from the tree by edits on two devices are found again", () => {
  const n = (id: string, parentId: string | null, extra: Partial<Note> = {}) => blankNote({ kind: "page", id, parentId, title: id, ...extra });
  const notes = [
    n("root01", null),
    n("child1", "root01"),
    n("orphan", "gone00"),
    n("under0", "orphan"),
    n("cycleA", "cycleB"),
    n("cycleB", "cycleA"),
    n("intoAB", "cycleA"),
    n("trash0", null, { trashedAt: 1 }),
    n("intrsh", "trash0"),
  ];
  const byId = new Map(notes.map((x) => [x.id, x]));
  assert.deepEqual(lostRoots(notes, byId).map((x) => x.id).sort(), ["cycleA", "orphan"]);
});

test("favorites are each person's own; the owner keeps the stars older pages carried", async () => {
  const { favoritesOf, setFavorite } = await import("@/lib/notes/favorites");
  const ws = "ws-favs";
  const starred = blankNote({ kind: "page", title: "Starred before", favorite: true });
  push(ws, [starred]);
  assert.deepEqual(favoritesOf(ws, "owner-1", true), [starred.id]);
  assert.deepEqual(favoritesOf(ws, "member-1", false), []);
  assert.equal(setFavorite(ws, "member-1", starred.id, true), true);
  assert.deepEqual(favoritesOf(ws, "member-1", false), [starred.id]);
  setFavorite(ws, "owner-1", starred.id, false);
  assert.deepEqual(favoritesOf(ws, "owner-1", true), []);
  assert.deepEqual(favoritesOf(ws, "member-1", false), [starred.id]);
});

test("reminders reach the Inbox once, at the 9:00 of whoever set them", async () => {
  const { recordReminders, sendDueReminders, setTimeZone } = await import("@/lib/notes/reminders-server");
  const { zonedTime } = await import("@/lib/notes/reminders");
  assert.equal(zonedTime(Date.UTC(2026, 9, 20, 9, 0), "Asia/Tokyo"), Date.UTC(2026, 9, 20, 0, 0));
  assert.equal(zonedTime(Date.UTC(2026, 2, 29, 9, 0), "Europe/Berlin"), Date.UTC(2026, 2, 29, 7, 0));
  const ws = "ws-remind";
  const who = "userTokyo1";
  setTimeZone(who, "Asia/Tokyo");
  const page = blankNote({ kind: "page", title: "Отчёт", content: [{ type: "paragraph", content: [{ type: "text", text: "Сдать отчёт " }, { type: "mention", props: { noteId: "", date: "2026-10-20", remind: "day" } }] }] });
  push(ws, [page]);
  recordReminders(ws, [{ id: page.id, before: null, after: page }], who);
  const at = Date.UTC(2026, 9, 20, 0, 0);
  assert.equal(sendDueReminders(at - 1000), 0);
  assert.equal(sendDueReminders(at + 1000), 1);
  assert.equal(sendDueReminders(at + 2000), 0);
  // Moved to the trash before it is due: it stays quiet.
  const other = blankNote({ kind: "page", title: "Old", trashedAt: Date.now(), content: page.content });
  push(ws, [other]);
  recordReminders(ws, [{ id: other.id, before: null, after: { ...other, trashedAt: null } }], who);
  assert.equal(sendDueReminders(at + 3000), 0);
});

test("stamps stay unique across separately loaded copies of the module (Next bundles routes apart)", () => {
  const path = require.resolve("@/lib/notes/stamp");
  const a = require(path) as typeof import("@/lib/notes/stamp");
  delete require.cache[path];
  const b = require(path) as typeof import("@/lib/notes/stamp");
  assert.notEqual(a, b);
  const seen: number[] = [];
  for (let i = 0; i < 50; i++) seen.push(a.nextStamp(), b.nextStamp());
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `stamp ${i} not increasing`);
});

test("two people edit different cells of one row: both changes stay (per-property merge)", () => {
  const ws = "ws-fields";
  const row = blankNote({ kind: "page", title: "Task", props: { status: "todo", owner: ["u1"], due: { start: "2026-10-20" } } });
  push(ws, [row]);
  const fromServer = () => pullNotes(ws, 0).notes.find((n) => n.id === row.id) as Note;
  // Anna changes the status, Boris (from the same old copy) the due date.
  const anna = { ...row, props: { ...row.props, status: "done" }, updatedAt: row.updatedAt + 10 };
  const boris = { ...row, props: { ...row.props, due: { start: "2026-10-27" } }, updatedAt: row.updatedAt + 20 };
  pushNotes(ws, [{ id: row.id, note: anna, fields: ["props.status"] }], { by: "annaAAAA", quotaLeft: Infinity });
  pushNotes(ws, [{ id: row.id, note: boris, fields: ["props.due"] }], { by: "borisBBB", quotaLeft: Infinity });
  assert.equal(fromServer().props?.status, "done");
  assert.deepEqual(fromServer().props?.due, { start: "2026-10-27" });
  // A whole-note push (an old device) still replaces the note.
  pushNotes(ws, [{ id: row.id, note: { ...row, title: "Old copy", updatedAt: row.updatedAt + 30 } }], { by: "annaAAAA", quotaLeft: Infinity });
  assert.equal(fromServer().props?.status, "todo");
  assert.equal(fromServer().title, "Old copy");
});

test("fields: what a patch changes, and a copy around unsent fields", async () => {
  const { cleanFields, patchFields, withFields } = await import("@/lib/notes/fields");
  const n = blankNote({ kind: "page", title: "A", props: { a: 1, b: 2 } });
  assert.deepEqual(patchFields(n, { title: "B", props: { a: 1, b: 3, c: 4 }, updatedAt: 5 }), ["title", "props.b", "props.c"]);
  assert.equal(cleanFields(["title", "bogus"]), null);
  assert.equal(cleanFields(["*"]), null);
  assert.deepEqual(cleanFields(["props.x", "icon", "icon"]), ["props.x", "icon"]);
  const server = { ...n, title: "Server", props: { a: 9, b: 2 } };
  const local = { ...n, props: { a: 1, b: 7 } };
  const merged = withFields(server, local, ["props.b"]);
  assert.equal(merged.title, "Server");
  assert.deepEqual(merged.props, { a: 9, b: 7 });
});
