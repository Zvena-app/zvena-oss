import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { signInWith } from "@/lib/auth";
import type { InboxNote } from "@/lib/eco/inbox";
import { applyUpdate, closeRooms, join, openRoom } from "@/lib/notes/collab";
import { COLLAB_FRAGMENT } from "@/lib/notes/collab-shared";
import { blankNote, sanitizeBlocks, sanitizeNote } from "@/lib/notes/model";
import { setNotifierForTests } from "@/lib/notes/notify-people";
import "@/lib/notes/reactions";
import { mergeComments, pullNotes, pushNotes } from "@/lib/notes/server-store";
import { contributionOnly, decideSuggestion, suggestionIds, suggestionParts, withoutSuggestions } from "@/lib/notes/suggestions";
import type { Note, NoteComment } from "@/lib/notes/types";
import { listVersions, readVersion } from "@/lib/notes/versions";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `sug-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}
type Run = { text: string; styles?: Record<string, unknown> };
const para = (id: string, ...runs: Run[]) => ({ id, type: "paragraph", props: {}, content: runs.map((r) => ({ type: "text", text: r.text, styles: r.styles ?? {} })), children: [] });
const ins = (sid: string, extra: Record<string, unknown> = {}) => ({ suggestIns: sid, ...extra });
const del = (sid: string, extra: Record<string, unknown> = {}) => ({ suggestDel: sid, ...extra });
const record = (sid: string, authorId: string, at = 1, state?: "accepted" | "rejected"): NoteComment => ({ id: `r-${sid}`, thread: sid, text: "", at, author: "x", authorId, suggestion: state ? { state } : {} });
const own = (stored: unknown, next: unknown, comments: NoteComment[], userId: string, storedComments = comments) => contributionOnly(stored, next, { stored: storedComments, merged: comments }, userId);

test("suggestions: a commenter may add and take back only their own open suggestions", () => {
  const base = [para("b1", { text: "Hello world" })];
  const mine = [record("s1", "kira")];
  // Inserting text under a new suggestion of one's own (its record comes in the same push).
  const inserted = [para("b1", { text: "Hello" }, { text: " big", styles: ins("s1") }, { text: " world" })];
  assert.equal(own(base, inserted, mine, "kira", []), true);
  // …but plain typing is an edit, and so is text under someone else's suggestion.
  assert.equal(own(base, [para("b1", { text: "Hello big world" })], mine, "kira", []), false);
  assert.equal(own(base, inserted, [record("s1", "anna")], "kira", [record("s1", "anna")]), false);
  // Formatting kept on suggested text is part of the suggestion; formatting the page's own text is not.
  assert.equal(own(base, [para("b1", { text: "Hello" }, { text: " big", styles: ins("s1", { bold: true }) }, { text: " world" })], mine, "kira", []), true);
  assert.equal(own(base, [para("b1", { text: "Hello", styles: { bold: true } }, { text: " world" })], mine, "kira", []), false);
  // A deletion mark of one's own.
  const deleting = [para("b1", { text: "Hello " }, { text: "world", styles: del("s1") })];
  assert.equal(own(base, deleting, mine, "kira", []), true);
  // Taking one's own suggestion back (text and marks), or growing it.
  assert.equal(own(inserted, base, mine, "kira"), true);
  assert.equal(own(deleting, base, mine, "kira"), true);
  assert.equal(own(inserted, [para("b1", { text: "Hello" }, { text: " big red", styles: ins("s1") }, { text: " world" })], mine, "kira"), true);
  // Someone else's suggestion stays as it is: not removed, not grown, its deletion not undone.
  const theirs = [record("s1", "anna")];
  assert.equal(own(inserted, base, theirs, "kira"), false);
  assert.equal(own(inserted, [para("b1", { text: "Hello" }, { text: " bigger", styles: ins("s1") }, { text: " world" })], theirs, "kira"), false);
  assert.equal(own(deleting, base, theirs, "kira"), false);
  // Accepting one's own suggestion is an edit: the text without its mark, or deleted text gone.
  assert.equal(own(inserted, [para("b1", { text: "Hello big world" })], mine, "kira"), false);
  assert.equal(own(deleting, [para("b1", { text: "Hello " })], mine, "kira"), false);
  // A suggestion already decided is the page's now, even for its author.
  const decided = [record("s1", "kira", 1, "accepted")];
  assert.equal(own(inserted, base, decided, "kira"), false);
  // A suggestion on the page with no record (lost) belongs to nobody.
  assert.equal(own(inserted, base, [], "kira"), false);
  // A record claimed in the push cannot take over a thread someone else started (the stored author wins).
  assert.equal(own(inserted, base, [record("s1", "kira")], "kira", [record("s1", "anna")]), false);
});

test("suggestions: a new line is a suggested block of one's own, nothing more", () => {
  const base = [para("b1", { text: "First" })];
  const mine = [record("s2", "kira")];
  const empty = { id: "sg~s2~x1", type: "paragraph", props: {}, content: [], children: [] };
  const typed = { ...empty, content: [{ type: "text", text: "Second", styles: ins("s2") }] };
  assert.equal(own(base, [...base, empty], mine, "kira", []), true);
  assert.equal(own(base, [...base, typed], mine, "kira", []), true);
  // A suggested block holding the page's own (unmarked) text, or blocks under it, is an edit.
  assert.equal(own(base, [...base, { ...empty, content: [{ type: "text", text: "Second", styles: {} }] }], mine, "kira", []), false);
  assert.equal(own(base, [...base, { ...empty, children: [para("c1", { text: "x" })] }], mine, "kira", []), false);
  // A block named after someone else's suggestion, or a plain new block, is an edit too.
  assert.equal(own(base, [...base, typed], [record("s2", "anna")], "kira", [record("s2", "anna")]), false);
  assert.equal(own(base, [...base, para("b2", { text: "" })], mine, "kira", []), false);
  // Split a line: the rest is marked removed here and suggested on the new line.
  const split = [para("b1", { text: "Fi" }, { text: "rst", styles: del("s2") }), { ...empty, content: [{ type: "text", text: "rst", styles: ins("s2") }] }];
  assert.equal(own(base, split, mine, "kira", []), true);
  assert.deepEqual([...suggestionIds(split)], ["s2"]);
  assert.deepEqual(suggestionParts(split).get("s2"), { ins: "rst", del: "rst" });
});

test("suggestions: accepting and rejecting, and the page as the public reads it", () => {
  const page = [para("b1", { text: "Hello" }, { text: " big", styles: ins("s1") }, { text: " world", styles: del("s1") }), { id: "sg~s1~a", type: "paragraph", props: {}, content: [{ type: "text", text: "More", styles: ins("s1") }], children: [] }];
  let k = 0;
  const accepted = decideSuggestion(page, "s1", true, () => `new${++k}`) as { id: string; content: { text: string; styles: object }[] }[];
  assert.deepEqual(accepted.map((b) => b.id), ["b1", "new1"]);
  assert.deepEqual(accepted[0].content, [{ type: "text", text: "Hello big", styles: {} }]);
  assert.deepEqual(accepted[1].content, [{ type: "text", text: "More", styles: {} }]);
  const rejected = decideSuggestion(page, "s1", false, () => "x") as { id: string; content: unknown }[];
  assert.deepEqual(rejected.map((b) => b.id), ["b1"]);
  assert.deepEqual(rejected[0].content, [{ type: "text", text: "Hello world", styles: {} }]);
  // Rejecting reads like the page without the suggestion.
  assert.deepEqual(rejected, withoutSuggestions(page, () => true).plain);
  // A public copy shows the page as it is: suggested text and blocks out, text suggested for removal in.
  const pub = sanitizeBlocks(page) as { content: { text: string }[] }[];
  assert.equal(pub.length, 1);
  assert.equal(pub[0].content.map((c) => c.text).join(""), "Hello world");
});

test("suggestions: the record opens its own thread; only an editor decides it, signed by the server", () => {
  const prev: NoteComment[] = [];
  const pushed: NoteComment[] = [{ id: "r1", thread: "s1", text: "ignored", at: 5, author: "Fake", suggestion: { state: "accepted", by: "someone" } }];
  // A commenter's new suggestion: theirs, open, without text.
  const mine = mergeComments(prev, pushed, "Kira", false, "kira0001");
  assert.deepEqual(mine, [{ id: "r1", thread: "s1", text: "", at: 5, author: "Kira", authorId: "kira0001", suggestion: {} }]);
  // Its author cannot accept it; an editor can (who and when are the server's).
  assert.deepEqual(mergeComments(mine, [{ ...mine[0], suggestion: { state: "accepted" } }], "Kira", false, "kira0001")[0].suggestion, {});
  const decided = mergeComments(mine, [{ ...mine[0], suggestion: { state: "rejected", by: "kira0001", at: 1 } }], "Anna", true, "anna0001")[0];
  assert.equal(decided.suggestion?.state, "rejected");
  assert.equal(decided.suggestion?.by, "anna0001");
  assert.equal(decided.resolved, true);
  assert.equal(decided.authorId, "kira0001");
  // A stale copy cannot undo a decision.
  assert.equal(mergeComments([decided], [mine[0]], "Kira", false, "kira0001")[0].suggestion?.state, "rejected");
  // A suggestion cannot join an existing thread, nor a comment turn into one.
  const thread: NoteComment[] = [{ id: "c1", thread: "t1", text: "Why?", at: 1, author: "Anna", authorId: "anna0001" }];
  assert.equal(mergeComments(thread, [...thread, { id: "r2", thread: "t1", text: "", at: 2, author: "K", suggestion: {} }], "Kira", false, "kira0001").length, 1);
  const turned = mergeComments(thread, [{ ...thread[0], suggestion: {} }], "Anna", true, "anna0001");
  assert.equal(turned[0].suggestion, undefined);
  // The sanitizer keeps a record without text, and only well-formed decisions.
  const n1 = sanitizeNote({ ...blankNote({ kind: "page" }), comments: [{ id: "r", thread: "s9", text: "", at: 1, author: "K", suggestion: { state: "maybe" } }, { id: "c", text: "", at: 1, author: "K" }] });
  assert.deepEqual(n1?.comments, [{ id: "r", text: "", at: 1, author: "K", thread: "s9", suggestion: {} }]);
});

test("suggestions: a commenter's push lands their suggestion; an editor accepts; inbox and history follow", () => {
  const sent: { to: string; n: InboxNote }[] = [];
  setNotifierForTests((to, x) => void sent.push({ to, n: x }));
  const olga = person("Olga");
  const kira = person("Kira");
  const ws = createWorkspace(olga, `Suggest ${n}`).id;
  assert.ok(acceptInvite(kira, createInvite(olga, ws, "commenter").token));
  const page = blankNote({ kind: "page", title: "Spec", content: [para("b1", { text: "Hello world" })] });
  pushNotes(ws, [{ id: page.id, note: page }], { by: olga, quotaLeft: Infinity, author: "Olga", access: { userId: olga } });
  sent.length = 0;
  const get = () => pullNotes(ws, 0, olga).notes.find((x) => x.id === page.id) as Note;
  const asKira = (note: Note) => pushNotes(ws, [{ id: note.id, note }], { by: kira, quotaLeft: Infinity, author: "Kira", access: { userId: kira } });
  const asOlga = (note: Note) => pushNotes(ws, [{ id: note.id, note }], { by: olga, quotaLeft: Infinity, author: "Olga", access: { userId: olga } });
  // Kira suggests " big" (the record with it); Olga hears of it.
  const suggested = [para("b1", { text: "Hello" }, { text: " big", styles: ins("s1") }, { text: " world" })];
  asKira({ ...get(), content: suggested, comments: [{ id: "r1", thread: "s1", text: "", at: Date.now(), author: "Kira", suggestion: {} }] });
  let cur = get();
  assert.match(JSON.stringify(cur.content), /"suggestIns":"s1"/);
  assert.equal(cur.comments?.[0].authorId, kira);
  assert.deepEqual(sent.map((x) => [x.to === olga, x.n.kind, x.n.text]), [[true, "suggestion", "+ big"]]);
  sent.length = 0;
  // Kira can neither accept it herself nor edit the page itself around it.
  asKira({ ...cur, content: [para("b1", { text: "Hello big world" })], comments: [{ ...cur.comments![0], suggestion: { state: "accepted" } }] });
  cur = get();
  assert.match(JSON.stringify(cur.content), /"suggestIns":"s1"/);
  assert.equal(cur.comments?.[0].suggestion?.state, undefined);
  asKira({ ...cur, content: [para("b1", { text: "Hello" }, { text: " big", styles: ins("s1") }, { text: " moon" })] });
  assert.match(JSON.stringify(get().content), / world/);
  // Olga's own suggestion is out of Kira's reach.
  asOlga({ ...get(), content: [para("b1", { text: "Hello" }, { text: " big", styles: ins("s1") }, { text: " world" }, { text: "!", styles: ins("s2") })], comments: [...get().comments!, { id: "r2", thread: "s2", text: "", at: Date.now() + 1, author: "Olga", suggestion: {} }] });
  asKira({ ...get(), content: suggested });
  assert.match(JSON.stringify(get().content), /"suggestIns":"s2"/);
  // Olga accepts Kira's: the text is the page's, Kira hears of it, and the history has it under Kira.
  cur = get();
  asOlga({ ...cur, content: decideSuggestion(cur.content, "s1", true, () => "x") as unknown[], comments: cur.comments!.map((c) => (c.thread === "s1" ? { ...c, suggestion: { state: "accepted" } } : c)) });
  cur = get();
  assert.doesNotMatch(JSON.stringify(cur.content), /"suggestIns":"s1"/);
  assert.equal(cur.comments?.find((c) => c.thread === "s1")?.suggestion?.by, olga);
  assert.deepEqual(sent.map((x) => [x.to === kira, x.n.kind, x.n.text]), [[true, "suggestion_accepted", "+ big"]]);
  const v = listVersions(ws, page.id)[0];
  assert.equal(v.kind, "suggestion");
  assert.equal(v.by, kira);
  assert.equal(v.acceptedBy, olga);
  assert.match(JSON.stringify(readVersion(ws, page.id, v.id)?.note.content), /Hello big world/);
  // Kira may not take the accepted text back.
  asKira({ ...cur, content: [para("b1", { text: "Hello world" }, { text: "!", styles: ins("s2") })] });
  assert.match(JSON.stringify(get().content), /Hello big world/);
  // Olga rejects her own: nobody else to tell.
  sent.length = 0;
  cur = get();
  asOlga({ ...cur, content: decideSuggestion(cur.content, "s2", false, () => "x") as unknown[], comments: cur.comments!.map((c) => (c.thread === "s2" ? { ...c, suggestion: { state: "rejected" } } : c)) });
  assert.equal(sent.length, 0);
  assert.equal(JSON.stringify(get().content).includes("!"), false);
});

/** A page body as y-prosemirror keeps it: blockGroup › blockContainer(id) › paragraph › text. */
function seed(doc: Y.Doc, text: string): void {
  const frag = doc.getXmlFragment(COLLAB_FRAGMENT);
  const group = new Y.XmlElement("blockGroup");
  const block = new Y.XmlElement("blockContainer");
  block.setAttribute("id", "b1");
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  block.insert(0, [p]);
  group.insert(0, [block]);
  frag.insert(0, [group]);
}
const groupOf = (doc: Y.Doc) => doc.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement;
const textOf = (doc: Y.Doc, i = 0) => (((groupOf(doc).get(i) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText);

test("suggestions: in a live session a commenter's updates may only make or take back their own", () => {
  const room = openRoom("ws-sug-live", "pagesug001");
  const mk = (id: string, userId: string, mayEdit: boolean, mayComment = false) => join(room, { id, userId, mayEdit, mayComment, send: () => undefined, close: () => undefined });
  const editor = mk("editorEEEE", "user-ed", true);
  const kira = mk("kiraKKKKKK", "user-kira", false, true);
  const vera = mk("veraVVVVVV", "user-vera", false, true);
  const ed = new Y.Doc();
  seed(ed, "Hello world");
  assert.equal(applyUpdate(room, editor.conn.id, Y.encodeStateAsUpdate(ed)), "ok");
  const copy = () => {
    const d = new Y.Doc();
    Y.applyUpdate(d, Y.encodeStateAsUpdate(room.doc));
    return d;
  };
  const send = (who: string, d: Y.Doc, fn: () => void) => {
    const sv = Y.encodeStateVector(d);
    fn();
    return applyUpdate(room, who, Y.encodeStateAsUpdate(d, sv));
  };
  // Kira types " big" as a suggestion and marks "world" removed: hers.
  const k = copy();
  assert.equal(send(kira.conn.id, k, () => textOf(k).insert(5, " big", { suggestIns: { stringValue: "s1" } })), "ok");
  assert.equal(send(kira.conn.id, k, () => textOf(k).format(10, 5, { suggestDel: { stringValue: "s1" } })), "ok");
  // A new line of hers: a suggested block with suggested text.
  assert.equal(
    send(kira.conn.id, k, () => {
      const block = new Y.XmlElement("blockContainer");
      block.setAttribute("id", "sg~s1~n1");
      const p = new Y.XmlElement("paragraph");
      const t = new Y.XmlText();
      t.insert(0, "Again", { suggestIns: { stringValue: "s1" } });
      p.insert(0, [t]);
      block.insert(0, [p]);
      groupOf(k).insert(1, [block]);
    }),
    "ok"
  );
  // Plain typing is not suggesting.
  const k2 = copy();
  assert.equal(send(kira.conn.id, k2, () => textOf(k2).insert(0, "X")), "forbidden");
  // Vera cannot take Kira's suggestion back, grow it, or undo its deletion (no record yet: the room knows whose it is).
  const v = copy();
  assert.equal(send(vera.conn.id, v, () => textOf(v).delete(5, 4)), "forbidden");
  const v2 = copy();
  assert.equal(send(vera.conn.id, v2, () => textOf(v2).insert(7, "gg", { suggestIns: { stringValue: "s1" } })), "forbidden");
  const v3 = copy();
  assert.equal(send(vera.conn.id, v3, () => textOf(v3).format(10, 5, { suggestDel: null })), "forbidden");
  const v4 = copy();
  assert.equal(send(vera.conn.id, v4, () => groupOf(v4).delete(1, 1)), "forbidden");
  // Kira takes her new line back.
  const k3 = copy();
  assert.equal(send(kira.conn.id, k3, () => groupOf(k3).delete(1, 1)), "ok");
  const out = textOf(room.doc).toDelta();
  assert.deepEqual(out, [{ insert: "Hello" }, { insert: " big", attributes: { suggestIns: { stringValue: "s1" } } }, { insert: " " }, { insert: "world", attributes: { suggestDel: { stringValue: "s1" } } }]);
  // The editor accepts: an ordinary edit, and the text is the page's — Kira can no longer remove it.
  const e = copy();
  assert.equal(send(editor.conn.id, e, () => (textOf(e).format(5, 4, { suggestIns: null }), textOf(e).delete(10, 5))), "ok");
  room.suggesters.clear();
  const k4 = copy();
  assert.equal(send(kira.conn.id, k4, () => textOf(k4).delete(5, 4)), "forbidden");
  closeRooms();
});

test("suggestions: a commenter can never suggest an embed, an image, a file or a line with settings (sync)", () => {
  const base = [para("b1", { text: "First" })];
  const mine = [record("s3", "kira")];
  const media = [
    { id: "sg~s3~e1", type: "embed", props: { url: "https://evil.example/login", height: 400 }, children: [] },
    { id: "sg~s3~i1", type: "image", props: { url: "https://evil.example/pixel.gif" }, children: [] },
    { id: "sg~s3~f1", type: "file", props: { url: "https://evil.example/x.exe", name: "x.exe" }, children: [] },
    { id: "sg~s3~p1", type: "paragraph", props: { backgroundColor: "red" }, content: [], children: [] },
    { id: "sg~s3~b1", type: "bookmark", props: { url: "https://evil.example" }, content: [], children: [] },
  ];
  for (const b of media) assert.equal(own(base, [...base, b], mine, "kira", []), false, `${b.type} is refused`);
  // An ordinary new line with default settings still is a suggestion.
  assert.equal(own(base, [...base, { id: "sg~s3~ok", type: "checkListItem", props: { textColor: "default", backgroundColor: "default", textAlignment: "left", checked: false }, content: [], children: [] }], mine, "kira", []), true);
});

test("suggestions: a commenter can never suggest an embed, an image or a file (live session)", () => {
  const room = openRoom("ws-sug-media", "pagesugm01");
  const mk = (id: string, userId: string, mayEdit: boolean, mayComment = false) => join(room, { id, userId, mayEdit, mayComment, send: () => undefined, close: () => undefined });
  const editor = mk("editorMMMM", "user-ed2", true);
  const kira = mk("kiraMMMMMM", "user-kira2", false, true);
  const ed = new Y.Doc();
  seed(ed, "Hello");
  assert.equal(applyUpdate(room, editor.conn.id, Y.encodeStateAsUpdate(ed)), "ok");
  const copy = () => {
    const d = new Y.Doc();
    Y.applyUpdate(d, Y.encodeStateAsUpdate(room.doc));
    return d;
  };
  const send = (who: string, d: Y.Doc, fn: () => void) => {
    const sv = Y.encodeStateVector(d);
    fn();
    return applyUpdate(room, who, Y.encodeStateAsUpdate(d, sv));
  };
  const block = (id: string, node: string, attrs: Record<string, unknown>) => {
    const b = new Y.XmlElement("blockContainer");
    b.setAttribute("id", id);
    const n = new Y.XmlElement(node);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v as string);
    b.insert(0, [n]);
    return b;
  };
  for (const [node, attrs] of [
    ["embed", { url: "https://evil.example/login" }],
    ["image", { url: "https://evil.example/pixel.gif" }],
    ["file", { url: "https://evil.example/x.exe", name: "x.exe" }],
    ["paragraph", { backgroundColor: "red" }],
  ] as const) {
    const k = copy();
    assert.equal(send(kira.conn.id, k, () => groupOf(k).insert(1, [block(`sg~s9~${node}`, node, attrs)])), "forbidden", `${node} ${JSON.stringify(attrs)} is refused`);
  }
  // A plain empty suggested line is fine.
  const k = copy();
  assert.equal(send(kira.conn.id, k, () => groupOf(k).insert(1, [block("sg~s9~line", "paragraph", {})])), "ok");
  closeRooms();
});

test("suggestions: a stored page never keeps a suggested block that may not be one (defense in depth)", async () => {
  const { dropUnsuggestable } = await import("@/lib/notes/suggestions");
  const out = dropUnsuggestable([para("b1", { text: "x" }), { id: "sg~s4~e", type: "embed", props: { url: "https://evil.example" } }, { ...para("b2", { text: "y" }), children: [{ id: "sg~s4~i", type: "image", props: { url: "https://evil.example/i.png" } }] }]) as { id: string; children?: unknown[] }[];
  assert.deepEqual(out.map((b) => b.id), ["b1", "b2"]);
  assert.deepEqual(out[1].children, []);
});

test("suggestions: whoever writes it, a stored page drops a suggested embed (the write path itself)", () => {
  const owner = person("SugStoreOwner");
  const ws = createWorkspace(owner, "Store").id;
  const page = blankNote({ kind: "page", title: "P", content: [para("b1", { text: "x" }), { id: "sg~s5~e", type: "embed", props: { url: "https://evil.example" }, children: [] }] as never });
  pushNotes(ws, [{ id: page.id, note: page }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  const stored = pullNotes(ws, 0).notes.find((n) => n.id === page.id)!;
  assert.deepEqual((stored.content as { id: string }[]).map((b) => b.id), ["b1"]);
});

test("suggestions: an accept that comes with the editor's own edits credits each to its author; decision notices only to who can still read", () => {
  const sent: { to: string; n: InboxNote }[] = [];
  setNotifierForTests((to, x) => void sent.push({ to, n: x }));
  const olga = person("Olga-mixed");
  const kira = person("Kira-mixed");
  const ws = createWorkspace(olga, `Mixed ${n}`).id;
  assert.ok(acceptInvite(kira, createInvite(olga, ws, "commenter").token));
  const page = blankNote({ kind: "page", title: "Plan", content: [para("b1", { text: "Hello world" })] });
  const as = (who: string, name: string, note: Note) => pushNotes(ws, [{ id: note.id, note }], { by: who, quotaLeft: Infinity, author: name, access: { userId: who } });
  as(olga, "Olga", page);
  const get = () => pullNotes(ws, 0, olga).notes.find((x) => x.id === page.id) as Note;
  as(kira, "Kira", { ...get(), content: [para("b1", { text: "Hello" }, { text: " big", styles: ins("m1") }, { text: " world" })], comments: [{ id: "rm1", thread: "m1", text: "", at: Date.now(), author: "Kira", suggestion: {} }] });
  const cur = get();
  // Olga accepts and, in the same write, renames the page.
  as(olga, "Olga", { ...cur, title: "Plan v2", content: decideSuggestion(cur.content, "m1", true, () => "x") as unknown[], comments: cur.comments!.map((c) => (c.thread === "m1" ? { ...c, suggestion: { state: "accepted" } } : c)) });
  const versions = listVersions(ws, page.id);
  const sug = versions.find((v) => v.kind === "suggestion");
  assert.equal(sug?.by, kira);
  assert.equal(readVersion(ws, page.id, sug!.id)?.note.title, "Plan", "the suggester's version is the accept alone");
  assert.equal(versions[0].by, olga, "the rename is the editor's");
  // Kira loses access before the next decision: she hears nothing of it.
  as(kira, "Kira", { ...get(), content: [para("b1", { text: "Hello big world" }, { text: "!", styles: ins("m2") })], comments: [...get().comments!, { id: "rm2", thread: "m2", text: "", at: Date.now() + 1, author: "Kira", suggestion: {} }] });
  sql("DELETE FROM members WHERE ws_id = ? AND user_id = ?").run(ws, kira);
  sent.length = 0;
  const now = get();
  as(olga, "Olga", { ...now, content: decideSuggestion(now.content, "m2", false, () => "x") as unknown[], comments: now.comments!.map((c) => (c.thread === "m2" ? { ...c, suggestion: { state: "rejected" } } : c)) });
  assert.ok(!sent.some((x) => x.to === kira), "no notice to someone who can no longer open the page");
});
