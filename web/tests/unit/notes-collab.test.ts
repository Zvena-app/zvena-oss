import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { applyAwareness, applyUpdate, claim, closeRooms, findRoom, flushRooms, join, leave, openRoom } from "@/lib/notes/collab";
import { COLLAB_META, contentHash, fromBase64, toBase64 } from "@/lib/notes/collab-shared";
import { blankNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import { sql } from "@/lib/store";

/** A browser in a room: its own Yjs document, fed by what the server streams to it. */
function browser(ws: string, noteId: string, id: string, userId: string, mayEdit = true) {
  const doc = new Y.Doc();
  const events: { event: string; data: string }[] = [];
  const room = openRoom(ws, noteId);
  const { init, conn } = join(room, {
    id,
    userId,
    mayEdit,
    send: (event, data) => {
      events.push({ event, data });
      if (event === "update") Y.applyUpdate(doc, fromBase64(data), "server");
    },
    close: () => undefined,
  });
  Y.applyUpdate(doc, fromBase64(init.state), "server");
  // What this browser does goes to the server, as the provider POSTs it.
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "server") assert.equal(applyUpdate(room, id, u), conn.canEdit ? "ok" : "forbidden");
  });
  return { doc, events, init, conn, room, text: () => doc.getText("t").toString() };
}

const page = (ws: string, id: string) => pushNotes(ws, [{ id, note: blankNote({ kind: "page", id, title: id }) }], { by: "user-anna", quotaLeft: Infinity });

test("two browsers editing one page converge, and the state survives the room closing", () => {
  page("ws-c1", "page000001");
  const a = browser("ws-c1", "page000001", "clientAAAA", "user-anna");
  const b = browser("ws-c1", "page000001", "clientBBBB", "user-boris");
  a.doc.getText("t").insert(0, "Привет");
  b.doc.getText("t").insert(0, ">> ");
  a.doc.getText("t").insert(a.text().length, ", мир");
  assert.equal(a.text(), b.text());
  assert.ok(a.text().includes("Привет") && a.text().includes(">> ") && a.text().endsWith(", мир"));
  // Saved and loaded again (a restart, or the room closing after everyone left).
  flushRooms();
  closeRooms();
  const saved = sql("SELECT state FROM note_ydocs WHERE ws = ? AND note_id = ?").get("ws-c1", "page000001") as { state: Uint8Array } | undefined;
  assert.ok(saved && saved.state.byteLength > 0);
  const c = browser("ws-c1", "page000001", "clientCCCC", "user-vera");
  assert.equal(c.text(), a.text());
  closeRooms();
});

test("a viewer gets live updates but cannot change the page", () => {
  const ed = browser("ws-c2", "page000002", "editorEEEE", "user-ed");
  const viewer = browser("ws-c2", "page000002", "viewerVVVV", "user-view", false);
  assert.equal(viewer.init.canEdit, false);
  ed.doc.getText("t").insert(0, "live");
  assert.equal(viewer.text(), "live");
  const before = ed.text();
  viewer.doc.getText("t").insert(0, "nope");
  assert.equal(ed.text(), before);
  assert.equal(findRoom("ws-c2", "page000002")?.doc.getText("t").toString(), "live");
  closeRooms();
});

test("the editors limit: a newcomer past it reads only; someone already editing keeps the place", () => {
  process.env.ZVENA_MAX_EDITORS_PER_DOC = "3";
  try {
    const ids = ["u1aaaa", "u2bbbb", "u3cccc"].map((u, i) => browser("ws-c3", "page000003", `client${i}xxxx`, u));
    assert.ok(ids.every((x) => x.init.canEdit && !x.init.full));
    const late = browser("ws-c3", "page000003", "clientLATE", "u4dddd");
    assert.equal(late.init.full, true);
    assert.equal(late.init.canEdit, false);
    assert.equal(late.init.limit, 3);
    // The same person in a second tab is not a new editor.
    const again = browser("ws-c3", "page000003", "client0TAB2", "u1aaaa");
    assert.equal(again.init.full, false);
    assert.equal(again.init.canEdit, true);
  } finally {
    delete process.env.ZVENA_MAX_EDITORS_PER_DOC;
    closeRooms();
  }
});

test("seeding: one browser at a time is asked to fill an empty document from the page's JSON", () => {
  const now = Date.now();
  const room = openRoom("ws-c4", "page000004");
  const mk = (id: string) => ({ id, userId: `user-${id}`, mayEdit: true, send: () => undefined, close: () => undefined });
  const first = join(room, mk("seederAAAA"), now);
  const second = join(room, mk("waiterBBBB"), now + 100);
  assert.equal(first.init.seed, true);
  assert.equal(second.init.seed, false);
  assert.equal(claim(room, "waiterBBBB", now + 200), false);
  // The seeder went quiet: after the lock runs out someone else may.
  assert.equal(claim(room, "waiterBBBB", now + 11_000), true);
  // Once seeded nobody is asked again.
  const meta = new Y.Doc();
  Y.applyUpdate(meta, Y.encodeStateAsUpdate(room.doc));
  meta.getMap(COLLAB_META).set("h", contentHash([]));
  assert.equal(applyUpdate(room, "waiterBBBB", Y.encodeStateAsUpdate(meta, Y.encodeStateVector(room.doc))), "ok");
  assert.equal(join(room, mk("laterCCCC1"), now + 30_000).init.seeded, true);
  assert.equal(join(room, mk("laterCCCC2"), now + 30_000).init.seed, false);
  closeRooms();
});

test("cursors: awareness reaches the others and goes away with its browser", () => {
  const a = browser("ws-c5", "page000005", "awareAAAAA", "user-a");
  const b = browser("ws-c5", "page000005", "awareBBBBB", "user-b");
  const aw = new Awareness(a.doc);
  aw.setLocalStateField("user", { name: "Анна", color: "#337ea9" });
  assert.equal(applyAwareness(a.room, "awareAAAAA", encodeAwarenessUpdate(aw, [a.doc.clientID])), true);
  const seen = new Awareness(new Y.Doc());
  const got = b.events.filter((e) => e.event === "awareness");
  assert.ok(got.length > 0);
  for (const e of got) applyAwarenessUpdate(seen, fromBase64(e.data), "server");
  assert.equal((seen.getStates().get(a.doc.clientID) as { user?: { name: string } } | undefined)?.user?.name, "Анна");
  // Someone else leaving keeps a's cursor.
  leave(a.room, "awareBBBBB");
  assert.equal(a.room.awareness.getStates().has(a.doc.clientID), true);
  const c = browser("ws-c5", "page000005", "awareCCCCC", "user-c");
  leave(a.room, "awareAAAAA");
  const gone = c.events.filter((e) => e.event === "awareness").pop();
  assert.ok(gone);
  applyAwarenessUpdate(seen, fromBase64(gone.data), "server");
  assert.equal(seen.getStates().has(a.doc.clientID), false);
  aw.destroy();
  seen.destroy();
  closeRooms();
});

test("a page deleted forever takes its Yjs state with it", () => {
  const page = blankNote({ kind: "page", title: "Черновик" });
  pushNotes("ws-c6", [{ id: page.id, note: page }], { by: "user-z", quotaLeft: Infinity });
  const a = browser("ws-c6", page.id, "deleteAAAA", "user-z");
  a.doc.getText("t").insert(0, "x");
  flushRooms();
  assert.ok(sql("SELECT 1 FROM note_ydocs WHERE ws = ? AND note_id = ?").get("ws-c6", page.id));
  pushNotes("ws-c6", [{ id: page.id, deleted: true }], { by: "user-z", quotaLeft: Infinity });
  assert.equal(findRoom("ws-c6", page.id), undefined);
  assert.equal(sql("SELECT 1 FROM note_ydocs WHERE ws = ? AND note_id = ?").get("ws-c6", page.id), undefined);
  assert.ok(a.events.some((e) => e.event === "gone"));
});

test("base64 and the content hash are stable", () => {
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  const blocks = [{ type: "paragraph", content: [{ type: "text", text: "Ёлка", styles: {} }] }];
  assert.equal(contentHash(blocks), contentHash(JSON.parse(JSON.stringify(blocks))));
  assert.notEqual(contentHash(blocks), contentHash([]));
});

test("a page created a moment ago: its session waits in memory until the page reaches the server", async () => {
  const a = browser("ws-c7", "newpage001", "freshAAAAA", "user-anna");
  a.doc.getText("t").insert(0, "черновик");
  flushRooms();
  assert.equal(sql("SELECT 1 FROM note_ydocs WHERE ws = ? AND note_id = ?").get("ws-c7", "newpage001"), undefined);
  page("ws-c7", "newpage001");
  flushRooms();
  assert.ok(sql("SELECT 1 FROM note_ydocs WHERE ws = ? AND note_id = ?").get("ws-c7", "newpage001"));
  closeRooms();
});

test("a reader shows up as someone in the page, never as a caret in the text", () => {
  const ed = browser("ws-c8", "page000008", "readerEDIT", "user-ed");
  const reader = browser("ws-c8", "page000008", "readerVIEW", "user-view", false);
  const aw = new Awareness(reader.doc);
  aw.setLocalState({ user: { name: "Вера", color: "#448361" }, uid: "user-view", cursor: { anchor: 1, head: 1 } });
  applyAwareness(reader.room, "readerVIEW", encodeAwarenessUpdate(aw, [reader.doc.clientID]));
  const seen = new Awareness(new Y.Doc());
  for (const e of ed.events.filter((x) => x.event === "awareness")) applyAwarenessUpdate(seen, fromBase64(e.data), "server");
  const st = seen.getStates().get(reader.doc.clientID) as { uid?: string; cursor?: unknown } | undefined;
  assert.equal(st?.uid, "user-view");
  assert.equal(st?.cursor ?? null, null);
  aw.destroy();
  seen.destroy();
  closeRooms();
});
