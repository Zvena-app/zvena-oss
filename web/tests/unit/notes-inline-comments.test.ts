import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { signInWith } from "@/lib/auth";
import { applyUpdate, closeRooms, join, openRoom } from "@/lib/notes/collab";
import { COLLAB_FRAGMENT } from "@/lib/notes/collab-shared";
import { commentMarksOnly } from "@/lib/notes/comment-marks";
import { blankNote } from "@/lib/notes/model";
import { pullNotes, pushNotes } from "@/lib/notes/server-store";
import type { Note, NoteComment } from "@/lib/notes/types";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `icm-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}
const para = (...runs: { text: string; styles?: Record<string, unknown> }[]) => ({ id: "b1", type: "paragraph", props: {}, content: runs.map((r) => ({ type: "text", text: r.text, styles: r.styles ?? {} })), children: [] });
const comment = (id: string, thread: string, authorId: string, at = 1): NoteComment => ({ id, thread, text: "hm", at, author: "x", authorId });

test("inline comments: only marks of one's own discussions may change", () => {
  const before = [para({ text: "Hello world" })];
  const marked = [para({ text: "Hello", styles: { comment: "t1" } }, { text: " world" })];
  assert.equal(commentMarksOnly(before, marked, [comment("c1", "t1", "kira")], "kira"), true);
  // Someone else's thread, or a mark with no comment yet (by sync), is refused.
  assert.equal(commentMarksOnly(before, marked, [comment("c1", "t1", "anna")], "kira"), false);
  assert.equal(commentMarksOnly(before, marked, [], "kira"), false);
  // The text itself may not change, even next to a mark.
  const edited = [para({ text: "Hello", styles: { comment: "t1" } }, { text: " there" })];
  assert.equal(commentMarksOnly(before, edited, [comment("c1", "t1", "kira")], "kira"), false);
  const bold = [para({ text: "Hello", styles: { comment: "t1", bold: true } }, { text: " world" })];
  assert.equal(commentMarksOnly(before, bold, [comment("c1", "t1", "kira")], "kira"), false);
  // Taking a mark away: one's own, or of a thread that is gone; not someone else's.
  assert.equal(commentMarksOnly(marked, before, [comment("c1", "t1", "kira")], "kira"), true);
  assert.equal(commentMarksOnly(marked, before, [], "kira"), true);
  assert.equal(commentMarksOnly(marked, before, [comment("c1", "t1", "anna")], "kira"), false);
  // Stretching someone else's mark over more text is a change of their thread.
  const wider = [para({ text: "Hello wo", styles: { comment: "t1" } }, { text: "rld" })];
  assert.equal(commentMarksOnly(marked, wider, [comment("c1", "t1", "anna")], "kira"), false);
});

test("inline comments: a commenter's push lands the mark with the first comment, nothing else", () => {
  const olga = person("Olga");
  const kira = person("Kira");
  const ws = createWorkspace(olga, `Inline ${n}`).id;
  assert.ok(acceptInvite(kira, createInvite(olga, ws, "commenter").token));
  const page = blankNote({ kind: "page", title: "Spec", content: [para({ text: "Hello world" })] });
  pushNotes(ws, [{ id: page.id, note: page }], { by: olga, quotaLeft: Infinity, author: olga, access: { userId: olga } });
  const push = (note: Note) => pushNotes(ws, [{ id: note.id, note }], { by: kira, quotaLeft: Infinity, author: "Kira", access: { userId: kira } });
  const get = () => pullNotes(ws, 0, olga).notes.find((x) => x.id === page.id) as Note;
  push({ ...get(), content: [para({ text: "Hello", styles: { comment: "t1" } }, { text: " world" })], comments: [{ id: "c1", thread: "t1", text: "Why?", at: Date.now(), author: "Kira", quote: "Hello" }] });
  const after = get();
  assert.equal(after.comments?.[0].authorId, kira);
  assert.match(JSON.stringify(after.content), /"comment":"t1"/);
  // Changing the words around the mark is refused (the stored body stays).
  push({ ...after, content: [para({ text: "Hello", styles: { comment: "t1" } }, { text: " moon" })] });
  assert.match(JSON.stringify(get().content), / world/);
  // Marking text for Olga's thread is refused too.
  pushNotes(ws, [{ id: page.id, note: { ...get(), comments: [...(get().comments ?? []), { id: "c2", thread: "t2", text: "Mine", at: Date.now() + 1, author: "Olga" }] } }], { by: olga, quotaLeft: Infinity, author: "Olga", access: { userId: olga } });
  push({ ...get(), content: [para({ text: "Hello", styles: { comment: "t1" } }, { text: " world", styles: { comment: "t2" } })] });
  assert.doesNotMatch(JSON.stringify(get().content), /"comment":"t2"/);
});

/** A page body as y-prosemirror keeps it: a paragraph's text in an XmlText. */
function seed(doc: Y.Doc, text: string): Y.XmlText {
  const frag = doc.getXmlFragment(COLLAB_FRAGMENT);
  const group = new Y.XmlElement("blockGroup");
  const block = new Y.XmlElement("blockContainer");
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  block.insert(0, [p]);
  group.insert(0, [block]);
  frag.insert(0, [group]);
  return t;
}

test("inline comments: in a live session a commenter's update may only mark text", () => {
  const ws = "ws-icm1";
  const noteId = "pageicm001";
  const room = openRoom(ws, noteId);
  const mk = (id: string, userId: string, mayEdit: boolean, mayComment = false) => join(room, { id, userId, mayEdit, mayComment, send: () => undefined, close: () => undefined });
  const editor = mk("editorEEEE", "user-ed", true);
  const kira = mk("kiraKKKKKK", "user-kira", false, true);
  const viewer = mk("viewerVVVV", "user-view", false);
  assert.equal(kira.init.canComment, true);
  assert.equal(viewer.init.canComment, false);
  // The editor writes the page.
  const ed = new Y.Doc();
  seed(ed, "Hello world");
  assert.equal(applyUpdate(room, editor.conn.id, Y.encodeStateAsUpdate(ed)), "ok");
  // Kira's copy: she marks "Hello" for a new discussion.
  const k = new Y.Doc();
  Y.applyUpdate(k, Y.encodeStateAsUpdate(room.doc));
  const kText = (k.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
  const t = (kText.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const sv = Y.encodeStateVector(k);
  t.format(0, 5, { comment: { stringValue: "t1" } });
  assert.equal(applyUpdate(room, kira.conn.id, Y.encodeStateAsUpdate(k, sv)), "ok");
  // Typing is not commenting.
  const sv2 = Y.encodeStateVector(k);
  t.insert(11, "!");
  assert.equal(applyUpdate(room, kira.conn.id, Y.encodeStateAsUpdate(k, sv2)), "forbidden");
  // A viewer may not even mark.
  const v = new Y.Doc();
  Y.applyUpdate(v, Y.encodeStateAsUpdate(room.doc));
  const vsv = Y.encodeStateVector(v);
  const vt = (((v.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
  vt.format(6, 5, { comment: { stringValue: "t9" } });
  assert.equal(applyUpdate(room, viewer.conn.id, Y.encodeStateAsUpdate(v, vsv)), "forbidden");
  // A mark built on her refused "!" would wait (pending) for it: refused, so the "!" can never slip in later.
  const sv3 = Y.encodeStateVector(k);
  t.format(11, 1, { comment: { stringValue: "t1" } });
  assert.equal(applyUpdate(room, kira.conn.id, Y.encodeStateAsUpdate(k, sv3)), "forbidden");
  assert.equal(room.doc.store.pendingStructs, null);
  // The room holds the text with Kira's mark and nothing else of hers.
  const out = ((((room.doc.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText).toDelta();
  assert.deepEqual(out, [{ insert: "Hello", attributes: { comment: { stringValue: "t1" } } }, { insert: " world" }]);
  closeRooms();
});
