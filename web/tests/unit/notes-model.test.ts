import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyView, databaseToCsv } from "@/lib/notes/db";
import { blankNote, copyNotes, noteSlug, sanitizeNote } from "@/lib/notes/model";
import { NotesStore } from "@/lib/notes/store";
import { NotesSync } from "@/lib/notes/sync";
import { NOTE_LIMITS, type DbSchema, type DbView, type Note } from "@/lib/notes/types";

const view = (patch: Partial<DbView> = {}): DbView => ({ id: "v1", name: "Table", type: "table", filters: [], sorts: [], hidden: [], widths: {}, ...patch });

function table(): { db: Note; schema: DbSchema; rows: Note[] } {
  const schema: DbSchema = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "n", name: "N", type: "number", numberFormat: "comma" },
      { id: "d", name: "Due", type: "date" },
      { id: "f", name: "F", type: "formula", formula: { expr: 'prop("N")' }, numberFormat: "comma" },
    ],
    views: [view()],
  };
  const db = blankNote({ kind: "database", title: "Tasks", db: schema });
  const row = (title: string, n: number | null, d: string | null, order: number) =>
    blankNote({ kind: "page", parentId: db.id, title, order, props: { n, ...(d ? { d: { start: d } } : {}) }, computed: { f: n } });
  return { db, schema, rows: [row("Ёлка", 1000, "2026-10-14", 1), row("Яблоко", 5, "2026-10-01", 2), row("Ель", null, null, 3)] };
}

test("filters: 'is not' leaves out exactly the rows 'is' keeps (numbers, dates, formulas)", () => {
  const { schema, rows } = table();
  for (const [prop, value] of [
    ["n", "1000"],
    ["d", "2026-10-14"],
    ["f", "1000"],
  ] as const) {
    const is = applyView(rows, view({ filters: [{ id: "a", prop, op: "is", value }] }), schema).map((r) => r.title);
    const isNot = applyView(rows, view({ filters: [{ id: "a", prop, op: "is_not", value }] }), schema).map((r) => r.title);
    assert.deepEqual(is, ["Ёлка"], prop);
    assert.deepEqual(isNot, ["Яблоко", "Ель"], prop);
  }
  // An empty number is not "0".
  assert.deepEqual(applyView(rows, view({ filters: [{ id: "a", prop: "n", op: "is", value: "0" }] }), schema), []);
});

test("sorts: text in the alphabet of the language, dates by time, empty last", () => {
  const { schema, rows } = table();
  const byTitle = applyView(rows, view({ sorts: [{ prop: "title", dir: "asc" }] }), schema, "", "ru").map((r) => r.title);
  assert.deepEqual(byTitle, ["Ёлка", "Ель", "Яблоко"]);
  const byDue = applyView(rows, view({ sorts: [{ prop: "d", dir: "desc" }] }), schema).map((r) => r.title);
  assert.deepEqual(byDue, ["Ёлка", "Яблоко", "Ель"]);
});

test("filters on created time use the local day", () => {
  const prevTz = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const schema: DbSchema = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "c", name: "Created", type: "created_time" }], views: [view()] };
    // 07:30 in Tokyo on October 14 is still October 13 in UTC.
    const row = blankNote({ kind: "page", title: "Night", createdAt: Date.UTC(2026, 9, 13, 22, 30) });
    assert.equal(applyView([row], view({ filters: [{ id: "a", prop: "c", op: "after", value: "2026-10-13" }] }), schema).length, 1);
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
});

test("CSV export: a byte order mark for Excel, line breaks quoted", () => {
  const { db, rows } = table();
  const csv = databaseToCsv(db, [{ ...rows[0], title: "a\rb" }]);
  assert.ok(csv.startsWith("﻿Name,N,Due,F\n"));
  assert.ok(csv.includes('"a\rb"'));
});

test("a database without a schema still gets one", () => {
  const n = sanitizeNote({ id: "abcdef123456", kind: "database", title: "X" });
  assert.ok(n?.db);
  assert.equal(n?.db?.properties[0].type, "title");
  assert.equal(n?.db?.views.length, 1);
});

test("slugs never end the title part with a dash", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(noteSlug({ id, title: `${"a".repeat(59)} b` }), `${"a".repeat(59)}-${id}`);
});

test("copies point at the copies: relations, sub-items, mentions, default template; no form link", () => {
  const db = blankNote({
    kind: "database",
    title: "Tasks",
    db: {
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: "parent", name: "Parent", type: "relation", relation: { dbId: "" } },
      ],
      views: [view({ type: "form", form: { questions: [], shareId: "formlink12345" } })],
    },
  });
  db.db!.properties[1].relation = { dbId: db.id };
  const tpl = blankNote({ kind: "page", parentId: db.id, template: true });
  db.db!.defaultTemplate = tpl.id;
  const a = blankNote({ kind: "page", parentId: db.id, title: "A" });
  const b = blankNote({ kind: "page", parentId: db.id, title: "B", props: { parent: [a.id] } });
  const page = blankNote({ kind: "page", title: "Home", content: [{ type: "paragraph", content: [{ type: "mention", props: { noteId: a.id } }], children: [] }] });
  db.parentId = page.id;

  const store = new NotesStore();
  for (const n of [page, db, tpl, a, b]) store.put(n);
  const copy = store.duplicate(page.id, "(copy)");
  assert.ok(copy);
  const all = store.all();
  const dbCopy = all.find((n) => n.kind === "database" && n.parentId === copy!.id)!;
  const aCopy = all.find((n) => n.parentId === dbCopy.id && n.title === "A")!;
  const bCopy = all.find((n) => n.parentId === dbCopy.id && n.title === "B")!;
  assert.equal(dbCopy.db!.properties[1].relation!.dbId, dbCopy.id);
  assert.notEqual(dbCopy.db!.defaultTemplate, tpl.id);
  assert.equal(dbCopy.db!.views[0].form?.shareId, undefined);
  assert.deepEqual(bCopy.props!.parent, [aCopy.id]);
  const mention = ((copy!.content[0] as { content: { props: { noteId: string } }[] }).content[0]).props.noteId;
  assert.equal(mention, aCopy.id);
  // The original is untouched.
  assert.deepEqual(store.get(b.id)!.props!.parent, [a.id]);
  assert.equal(store.get(db.id)!.db!.views[0].form?.shareId, "formlink12345");

  // A public page duplicated into a workspace (copyNotes) remaps the same way.
  const pub = copyNotes([page, db, tpl, a, b], page.id);
  const pubDb = pub.notes.find((n) => n.kind === "database")!;
  assert.equal(pubDb.db!.properties[1].relation!.dbId, pubDb.id);
  assert.equal(pub.notes.find((n) => n.id === pub.rootId)!.parentId, null);
});

test("new rows go after the database's last row, each with its own place", () => {
  const store = new NotesStore();
  const db = store.create({ kind: "database", title: "T", db: { properties: [{ id: "title", name: "Name", type: "title" }], views: [view()] } });
  const r1 = store.create({ kind: "page", parentId: db.id });
  const r2 = store.create({ kind: "page", parentId: db.id });
  const r3 = store.create({ kind: "page", parentId: db.id, title: "first" }, { first: true });
  assert.ok(r1.order < r2.order);
  assert.ok(r3.order < r1.order);
});

test("a pending deletion is not undone by an older server copy", () => {
  const store = new NotesStore();
  const n = store.create({ kind: "page", title: "Gone" });
  store.destroy(n.id);
  store.applyRemote([{ ...n, title: "Gone (server)" }], []);
  assert.equal(store.get(n.id), undefined);
});

function syncWith(store: NotesStore, answer: (items: { id: string; note?: Note }[]) => unknown, onSend?: () => void) {
  const sent: { id: string; note?: Note }[][] = [];
  const bodies: number[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { items: { id: string; note?: Note }[] };
    sent.push(body.items);
    bodies.push(Buffer.byteLength(init?.body ?? ""));
    onSend?.();
    return new Response(JSON.stringify(answer(body.items)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const s = new NotesSync(store);
  Object.assign(s as unknown as Record<string, unknown>, { stopped: false, ws: "ws1" });
  s.state = { ...s.state, user: "u:ws1" };
  return { s, sent, bodies };
}

test("push: a note over the server's limit is not sent (it would fail every request) and is reported", async () => {
  const store = new NotesStore();
  const big = store.create({ kind: "page", title: "big", content: [{ type: "paragraph", content: [{ type: "text", text: "я".repeat(NOTE_LIMITS.noteBytes / 2 + 10), styles: {} }] }] });
  const small = store.create({ kind: "page", title: "small" });
  const { s, sent } = syncWith(store, (items) => ({ saved: items.map((x) => x.id), rejected: [] }));
  let reported: string[] = [];
  s.onRejected = (ids) => (reported = ids);
  await s.push();
  assert.deepEqual(sent.flat().map((x) => x.id), [small.id]);
  assert.deepEqual(reported, [big.id]);
  assert.deepEqual(store.meta.pending, []);
});

test("push: batches are measured in UTF-8 bytes, under the route's 24 MB", async () => {
  const store = new NotesStore();
  // Cyrillic: two bytes a letter, ~2.2 MB each: twelve fit 18 M characters but are 26 MB.
  for (let i = 0; i < 12; i++) store.create({ kind: "page", title: `p${i}`, content: [{ type: "paragraph", content: [{ type: "text", text: "щ".repeat(1_100_000), styles: {} }] }] });
  const { s, bodies } = syncWith(store, (items) => ({ saved: items.map((x) => x.id), rejected: [] }));
  await s.push();
  assert.ok(bodies.length > 1);
  assert.ok(bodies.every((b) => b < 24_000_000), String(bodies));
  assert.deepEqual(store.meta.pending, []);
});

test("push: a 'quiet' change made while the request is in flight is sent too", async () => {
  const store = new NotesStore();
  const n = store.create({ kind: "page", title: "x" });
  let once = false;
  const { s, sent } = syncWith(
    store,
    (items) => ({ saved: items.map((x) => x.id), rejected: [] }),
    () => {
      if (once) return;
      once = true;
      store.update(n.id, { favorite: true }, { quiet: true });
    }
  );
  await s.push();
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0].note?.favorite, true);
  assert.deepEqual(store.meta.pending, []);
});
