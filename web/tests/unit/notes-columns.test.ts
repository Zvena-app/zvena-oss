import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { connectPage, createIntegration } from "@/lib/notes/api/integrations";
import { Space } from "@/lib/notes/api/space";
import { addGroupMember, createGroup } from "@/lib/notes/groups";
import { blankNote } from "@/lib/notes/model";
import { pullNotes, pushNotes, saveNoteShare, readNoteShare, validShareSnapshot } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `col-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}

function team() {
  const olga = person("Olga");
  const anna = person("Anna");
  const boris = person("Boris");
  const ws = createWorkspace(olga, `Cols ${n}`).id;
  for (const u of [anna, boris]) assert.ok(acceptInvite(u, createInvite(olga, ws, "editor").token));
  return { ws, olga, anna, boris };
}

const as = (ws: string, userId: string, notes: Note[], fields?: string[]) =>
  pushNotes(ws, notes.map((x) => ({ id: x.id, note: x, ...(fields ? { fields } : {}) })), { by: userId, quotaLeft: Infinity, author: userId, access: { userId } });
const mine = (ws: string, userId: string) => pullNotes(ws, 0, userId).notes;
const stored = (ws: string, id: string) => pullNotes(ws, 0).notes.find((x) => x.id === id) as Note;

function salaryDb(ws: string, by: string, perms: { view?: string[]; edit?: string[] }) {
  const db = blankNote({ kind: "database", title: "People" });
  db.db = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "salary", name: "Salary", type: "number", perms },
      { id: "status", name: "Status", type: "text" },
    ],
    views: [],
  };
  as(ws, by, [db]);
  const row = blankNote({ kind: "page", parentId: db.id, title: "Ivan", props: { salary: 100, status: "ok" } });
  as(ws, by, [row]);
  return { db, row };
}

test("column permissions: a hidden column's values never reach people outside the list", () => {
  const t = team();
  const hr = createGroup(t.ws, t.olga, "HR");
  addGroupMember(t.ws, hr.id, t.olga, t.boris);
  const { db, row } = salaryDb(t.ws, t.olga, { view: [`group:${hr.id}`] });
  const annaRow = mine(t.ws, t.anna).find((x) => x.id === row.id) as Note;
  assert.equal(annaRow.props?.salary, undefined);
  assert.equal(annaRow.props?.status, "ok");
  const salary = (mine(t.ws, t.anna).find((x) => x.id === db.id) as Note).db?.properties.find((p) => p.id === "salary");
  assert.equal(salary?.denied, "view");
  assert.equal(salary?.perms, undefined, "who is on the list stays with the managers");
  // A member of the group, and the owner (full access), see it.
  assert.equal((mine(t.ws, t.boris).find((x) => x.id === row.id) as Note).props?.salary, 100);
  const olgaDb = mine(t.ws, t.olga).find((x) => x.id === db.id) as Note;
  assert.deepEqual(olgaDb.db?.properties.find((p) => p.id === "salary")?.perms, { view: [`group:${hr.id}`] });
});

test("column permissions: pushes keep the stored values of columns one may not change", () => {
  const t = team();
  const { row } = salaryDb(t.ws, t.olga, { view: [t.boris], edit: [t.olga] });
  // Anna cannot see it: a whole-note push without it, or one with a made-up value, keeps it.
  as(t.ws, t.anna, [{ ...row, props: { status: "late" }, updatedAt: row.updatedAt + 1 }]);
  assert.deepEqual(stored(t.ws, row.id).props, { salary: 100, status: "late" });
  as(t.ws, t.anna, [{ ...row, props: { salary: 999, status: "late" }, updatedAt: row.updatedAt + 2 }], ["props.salary"]);
  assert.equal(stored(t.ws, row.id).props?.salary, 100);
  // Boris sees it but may not edit it.
  as(t.ws, t.boris, [{ ...stored(t.ws, row.id), props: { ...stored(t.ws, row.id).props, salary: 5 }, updatedAt: row.updatedAt + 3 }]);
  assert.equal(stored(t.ws, row.id).props?.salary, 100);
  // The owner may.
  as(t.ws, t.olga, [{ ...stored(t.ws, row.id), props: { ...stored(t.ws, row.id).props, salary: 120 }, updatedAt: row.updatedAt + 4 }]);
  assert.equal(stored(t.ws, row.id).props?.salary, 120);
  // A new row from Anna cannot set it either.
  const fresh = blankNote({ kind: "page", parentId: row.parentId, title: "New", props: { salary: 1 } });
  as(t.ws, t.anna, [fresh]);
  assert.equal(stored(t.ws, fresh.id).props?.salary, undefined);
});

test("column permissions: schema pushes cannot drop, change or open a protected column without full access", () => {
  const t = team();
  const { db } = salaryDb(t.ws, t.olga, { view: [t.olga] });
  const schema = () => stored(t.ws, db.id).db;
  const annaCopy = mine(t.ws, t.anna).find((x) => x.id === db.id) as Note;
  // Anna deletes the column and puts a list on another one.
  const props = (annaCopy.db?.properties ?? []).filter((p) => p.id !== "salary").map((p) => (p.id === "status" ? { ...p, perms: { view: [t.anna] } } : p));
  as(t.ws, t.anna, [{ ...annaCopy, db: { ...annaCopy.db!, properties: props }, updatedAt: db.updatedAt + 1 }]);
  assert.deepEqual(schema()?.properties.find((p) => p.id === "salary")?.perms, { view: [t.olga] });
  assert.equal(schema()?.properties.find((p) => p.id === "status")?.perms, undefined);
  // Renaming the protected column is reverted too.
  const again = mine(t.ws, t.anna).find((x) => x.id === db.id) as Note;
  as(t.ws, t.anna, [{ ...again, db: { ...again.db!, properties: again.db!.properties.map((p) => (p.id === "salary" ? { ...p, name: "Pay" } : p)) }, updatedAt: db.updatedAt + 2 }]);
  assert.equal(schema()?.properties.find((p) => p.id === "salary")?.name, "Salary");
  // The owner opens it to everyone.
  const olgaCopy = mine(t.ws, t.olga).find((x) => x.id === db.id) as Note;
  as(t.ws, t.olga, [{ ...olgaCopy, db: { ...olgaCopy.db!, properties: olgaCopy.db!.properties.map(({ perms: _p, ...p }) => (void _p, p)) }, updatedAt: db.updatedAt + 3 }]);
  assert.equal(schema()?.properties.find((p) => p.id === "salary")?.perms, undefined);
  assert.equal((mine(t.ws, t.anna).find((x) => x.parentId === db.id) as Note).props?.salary, 100);
});

test("column permissions: an integration reads only open columns and cannot write limited ones; public copies leave them out", () => {
  const t = team();
  const { integration } = createIntegration(t.olga, t.ws, { name: "Payroll reader" });
  const { db, row } = salaryDb(t.ws, t.olga, { view: [t.olga] });
  connectPage(t.olga, t.ws, integration.id, db.id);
  const space = Space.load(integration);
  assert.deepEqual(space.note(row.id)?.props, { status: "ok" });
  pushNotes(ws(t), [{ id: row.id, note: { ...row, props: { salary: 1000, status: "B" }, updatedAt: row.updatedAt + 1 } }], {
    by: `integration:${integration.id}`,
    quotaLeft: Infinity,
    columnsFor: `integration:${integration.id}`,
  });
  assert.deepEqual(stored(t.ws, row.id).props, { salary: 100, status: "B" });
  // Publishing (even by the owner, who sees it) leaves the column's values out.
  const snap = validShareSnapshot({ notes: [stored(t.ws, db.id), stored(t.ws, row.id)], rootId: db.id });
  assert.ok(snap);
  const id = saveNoteShare(t.ws, t.olga, db.id, snap);
  const pub = readNoteShare(id);
  assert.equal(pub?.snapshot.notes.find((x) => x.id === row.id)?.props?.salary, undefined);
  assert.equal(pub?.snapshot.notes.find((x) => x.id === db.id)?.db?.properties.find((p) => p.id === "salary")?.perms, undefined);
});

function ws(t: { ws: string }): string {
  return t.ws;
}
