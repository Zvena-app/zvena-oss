import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import type { InboxNote } from "@/lib/eco/inbox";
import { applyView, groupRowsFor, propValue, valueText } from "@/lib/notes/db";
import { blankNote, defaultView, sanitizeNote } from "@/lib/notes/model";
import { setNotifierForTests } from "@/lib/notes/notify-people";
import { commentMentions, commentParts, commentPlain, ME, setMe, setPeople } from "@/lib/notes/people";
import "@/lib/notes/reactions";
import { pullNotes, pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

const user = (name: string) => {
  const r = signInWith({ provider: "dev", subject: `people-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
};

const anna = user("Анна");
const boris = user("Борис");
const vera = user("Вера");
const stranger = user("Чужой");
const ws = createWorkspace(anna, "Команда").id;
assert.ok(acceptInvite(boris, createInvite(anna, ws, "editor").token));
assert.ok(acceptInvite(vera, createInvite(anna, ws, "commenter").token));

const sent: { to: string; n: InboxNote }[] = [];
setNotifierForTests((to, n) => void sent.push({ to, n }));
const take = () => sent.splice(0, sent.length).map((x) => `${x.n.kind}:${x.to === anna ? "anna" : x.to === boris ? "boris" : x.to === vera ? "vera" : "other"}`).sort();

const push = (by: string, author: string, notes: Note[], commentsOnly = false) =>
  pushNotes(ws, notes.map((n) => ({ id: n.id, note: n })), { by, quotaLeft: Infinity, author, commentsOnly });

const mention = (userId: string, name: string) => ({ type: "mention", props: { noteId: "", date: "", remind: "", userId, name } });

test("an @mention in a page tells the person once; not the author, not a stranger", () => {
  const page = blankNote({ kind: "page", title: "План", content: [{ id: "b1", type: "paragraph", content: [{ type: "text", text: "Посмотри, ", styles: {} }, mention(boris, "Борис"), mention(anna, "Анна"), mention(stranger, "Чужой")] }] });
  push(anna, "Анна", [page]);
  assert.deepEqual(take(), ["mention:boris"]);
  assert.equal(sent.length, 0);
  push(anna, "Анна", [{ ...page, updatedAt: page.updatedAt + 1 }]);
  assert.deepEqual(take(), []);
});

test("old content uploaded for the first time tells no one", () => {
  const old = Date.now() - 86_400_000;
  push(anna, "Анна", [blankNote({ kind: "page", title: "Старое", updatedAt: old, createdAt: old, content: [{ id: "b", type: "paragraph", content: [mention(boris, "Борис")] }] })]);
  assert.deepEqual(take(), []);
});

test("comments: mentions, the page's creator, replies to earlier commenters", () => {
  const page = blankNote({ kind: "page", title: "Обсуждение" });
  push(anna, "Анна", [page]);
  take();
  const c1 = { id: "c1", text: `Вера, глянь <@${vera}>`, at: 1, author: "Борис" };
  push(boris, "Борис", [{ ...page, comments: [c1] }]);
  assert.deepEqual(take(), ["comment:anna", "mention:vera"]);
  const stored = { ...c1, authorId: boris };
  const c2 = { id: "c2", text: "Согласна", at: 2, author: "Вера" };
  push(vera, "Вера", [{ ...page, comments: [stored, c2] }], true);
  assert.deepEqual(take(), ["comment:anna", "reply:boris"]);
});

test("a person added to a Person property is assigned", () => {
  const db = blankNote({ kind: "database", title: "Задачи" });
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "who", name: "Исполнитель", type: "person" }], views: [defaultView("table", "Table")] };
  push(anna, "Анна", [db]);
  const row = blankNote({ kind: "page", parentId: db.id, title: "Сверстать", props: { who: [boris] } });
  push(anna, "Анна", [row]);
  assert.deepEqual(take(), ["assigned:boris"]);
  push(anna, "Анна", [{ ...row, props: { who: [boris, vera] } }]);
  assert.deepEqual(take(), ["assigned:vera"]);
  // Who created and last edited it comes from the server, whatever the device says.
  assert.equal(sanitizeNote({ ...row, createdBy: "<bad id>" })?.createdBy, undefined);
  const res = pushNotes(ws, [{ id: row.id, note: { ...row, props: { who: [boris, vera] }, createdBy: stranger, editedBy: stranger } }], { by: boris, quotaLeft: Infinity, author: "Борис" });
  assert.deepEqual(res.saved, [row.id]);
  const stored = pullNotes(ws, 0).notes.find((n) => n.id === row.id);
  assert.equal(stored?.createdBy, anna);
  assert.equal(stored?.editedBy, boris);
  assert.deepEqual(take(), []);
});

test("people in databases: names, filters with Me, groups", () => {
  setPeople([
    { id: anna, name: "Анна" },
    { id: boris, name: "Борис" },
  ]);
  setMe(boris);
  const prop = { id: "who", name: "Исполнитель", type: "person" as const };
  const schema = { properties: [{ id: "title", name: "Name", type: "title" as const }, prop], views: [] };
  const rows = [
    blankNote({ kind: "page", title: "a", props: { who: [anna] } }),
    blankNote({ kind: "page", title: "b", props: { who: [anna, boris] } }),
    blankNote({ kind: "page", title: "c", props: {} }),
  ];
  assert.equal(valueText(prop, [anna, boris], "ru"), "Анна, Борис");
  const view = { ...defaultView("table", "T"), filters: [{ id: "f", prop: "who", op: "contains" as const, value: ME }] };
  assert.deepEqual(applyView(rows, view, schema).map((r) => r.title), ["b"]);
  const groups = groupRowsFor(rows, prop, { none: "Никто", checked: "", unchecked: "" }, "ru");
  assert.deepEqual(groups.map((g) => [g.label, g.rows.map((r) => r.title).join("")]), [["Никто", "c"], ["Анна", "ab"], ["Борис", "b"]]);
  const created = blankNote({ kind: "page", createdBy: anna, editedBy: "form" });
  assert.deepEqual(propValue(created, { id: "c", name: "c", type: "created_by" }), [anna]);
  assert.equal(valueText({ id: "e", name: "e", type: "last_edited_by" }, propValue(created, { id: "e", name: "e", type: "last_edited_by" }), "ru"), "Форма");
});

test("comment mention tokens never show ids", () => {
  const text = `Привет <@${anna}>, и <@${anna}> <script>`;
  assert.deepEqual(commentMentions(text), [anna]);
  assert.equal(commentPlain(text, () => "Анна"), "Привет @Анна, и @Анна <script>");
  assert.equal(commentParts(text).filter((p) => "userId" in p).length, 2);
});
