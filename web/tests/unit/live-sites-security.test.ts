import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { grant, setRestricted } from "@/lib/notes/access";
import { blankNote } from "@/lib/notes/model";
import { pullNotes, pushNotes, readNoteShare } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";
import { POST } from "@/app/api/notes/share/route";

let n = 0;
const person = (name: string) => {
  const r = signInWith({ provider: "dev", subject: `lss-${name}-${++n}`, name }, "2026-10-15");
  assert.ok(r.ok);
  return r.user.id;
};
const publish = (uid: string, ws: string, body: unknown) =>
  POST(new Request(`http://localhost/api/notes/share?ws=${ws}`, { method: "POST", headers: { cookie: `${sessionCookieName()}=${issueSession(uid)}`, host: "localhost:3100", origin: "http://localhost:3100", "content-type": "application/json" }, body: JSON.stringify(body) }));
const para = (text: string) => [{ id: "b1", type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] }];

function setup() {
  const owner = person("Owner");
  const editor = person("Editor");
  const ws = createWorkspace(owner, `Sites ${n}`).id;
  assert.ok(acceptInvite(editor, createInvite(owner, ws, "editor").token));
  const root = blankNote({ kind: "page", title: "Public root", content: para("public text") });
  const open = blankNote({ kind: "page", parentId: root.id, title: "Open child", content: para("open child text") });
  const secret = blankNote({ kind: "page", parentId: root.id, title: "Secret child", content: para("SECRET restricted text") });
  const trashed = blankNote({ kind: "page", parentId: root.id, title: "Trashed child", content: para("trashed text"), trashedAt: Date.now() });
  pushNotes(ws, [root, open, secret, trashed].map((x) => ({ id: x.id, note: x })), { by: owner, quotaLeft: Infinity });
  setRestricted(ws, secret.id, true, owner);
  grant(ws, secret.id, owner, "full", owner);
  return { owner, editor, ws, root, open, secret };
}

test("B1: an editor's push cannot plant or change a page's share; a full-access push can", () => {
  const { owner, editor, ws, root } = setup();
  const planted = { ...root, share: { id: "planted", key: "k".repeat(40), at: 1, index: true }, updatedAt: Date.now() };
  pushNotes(ws, [{ id: root.id, note: planted }], { by: editor, quotaLeft: Infinity, access: { userId: editor } });
  assert.equal(pullNotes(ws, 0).notes.find((x) => x.id === root.id)?.share, undefined, "the editor's share is dropped");
  pushNotes(ws, [{ id: root.id, note: planted }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  assert.equal(pullNotes(ws, 0).notes.find((x) => x.id === root.id)?.share?.id, "planted");
  // …and the editor cannot change or clear it either.
  const cleared = { ...root, updatedAt: Date.now() + 1 } as Note;
  delete cleared.share;
  pushNotes(ws, [{ id: root.id, note: cleared }], { by: editor, quotaLeft: Infinity, access: { userId: editor } });
  assert.equal(pullNotes(ws, 0).notes.find((x) => x.id === root.id)?.share?.id, "planted");
});

test("B1: the public copy is the server's — restricted and trashed children stay out, whatever the device sent; live only refreshes", async () => {
  const { owner, ws, root, secret } = setup();
  // The device sends a forged list (the secret child, made-up text): none of it is used.
  const forged = { ...secret, content: para("forged") };
  assert.equal((await publish(owner, ws, { noteId: root.id, live: true, snapshot: { rootId: root.id } })).status, 409, "live never publishes");
  const r = await publish(owner, ws, { noteId: root.id, snapshot: { rootId: root.id, notes: [root, forged], options: { index: true } } });
  assert.equal(r.status, 200);
  const id = ((await r.json()) as { id: string }).id;
  const copy = JSON.stringify(readNoteShare(id)?.snapshot);
  assert.ok(copy.includes("public text") && copy.includes("open child text"), "the page and its open child");
  assert.ok(!copy.includes("SECRET") && !copy.includes("forged") && !copy.includes("trashed text"), "no restricted, forged or trashed content");
  assert.equal(readNoteShare(id)?.snapshot.options?.index, true);
  // A live refresh keeps the stored settings (the device's are ignored) and is not logged as a publication.
  const before = Number((sql("SELECT COUNT(*) AS c FROM audit WHERE action LIKE 'page.publish%' AND target = ?").get(ws) as { c: number }).c);
  assert.equal((await publish(owner, ws, { noteId: root.id, live: true, snapshot: { rootId: root.id, options: { index: false, noDup: true } } })).status, 200);
  assert.equal(readNoteShare(id)?.snapshot.options?.index, true);
  assert.equal(readNoteShare(id)?.snapshot.options?.noDup, undefined);
  assert.equal(Number((sql("SELECT COUNT(*) AS c FROM audit WHERE action LIKE 'page.publish%' AND target = ?").get(ws) as { c: number }).c), before);
  // Changing a published page's settings (an explicit publish) is logged.
  await publish(owner, ws, { noteId: root.id, snapshot: { rootId: root.id, options: { index: false } } });
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'page.publish.settings' AND target = ?").get(ws));
});
