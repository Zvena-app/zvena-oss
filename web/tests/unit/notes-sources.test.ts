import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { setRestricted } from "@/lib/notes/access";
import { connectPage, createIntegration } from "@/lib/notes/api/integrations";
import { eventsOf } from "@/lib/notes/api/webhooks";
import { annotateSchema, deniedColumns } from "@/lib/notes/column-perms";
import { groupRowsFor, rowColors, rowsOf, withoutProp } from "@/lib/notes/db";
import { blankNote, defaultView, remapNote, sanitizeNote } from "@/lib/notes/model";
import { openNoteForm, pullNotes, pushNotes, readNoteForm, submitNoteForm } from "@/lib/notes/server-store";
import { childSources, mergedSchema, moveSourcePlan, retargetView, sourceTables, sourcesOf, splitSchema, splitSourcePlan, viewSourceId, viewsOf } from "@/lib/notes/sources";
import { guardSources } from "@/lib/notes/sources-guard";
import { notionSources } from "@/lib/notes/import-formats";
import type { DbSchema, DbView, Note } from "@/lib/notes/types";
import { asWiki, withoutWiki } from "@/lib/notes/verification";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";
import * as dbRoute from "@/app/api/v1/databases/[id]/route";
import * as dbQueryRoute from "@/app/api/v1/databases/[id]/query/route";
import * as dsCreateRoute from "@/app/api/v1/data_sources/route";
import * as dsRoute from "@/app/api/v1/data_sources/[id]/route";
import * as dsQueryRoute from "@/app/api/v1/data_sources/[id]/query/route";
import * as dsTemplatesRoute from "@/app/api/v1/data_sources/[id]/templates/route";
import * as pagesRoute from "@/app/api/v1/pages/route";
import * as pageRoute from "@/app/api/v1/pages/[id]/route";
import * as searchRoute from "@/app/api/v1/search/route";
import { resetRate } from "@/lib/notes/api/respond";
import { toUuid } from "@/lib/notes/api/space";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `src-${name}-${++n}`, name }, "2026-10-15");
  assert.ok(r.ok);
  return r.user.id;
}

function team() {
  const olga = person("Olga");
  const anna = person("Anna");
  const ws = createWorkspace(olga, `Sources ${n}`).id;
  assert.ok(acceptInvite(anna, createInvite(olga, ws, "editor").token));
  return { ws, olga, anna };
}

const as = (ws: string, userId: string, notes: Note[]) => pushNotes(ws, notes.map((x) => ({ id: x.id, note: x })), { by: userId, quotaLeft: Infinity, author: userId, access: { userId } });
const mine = (ws: string, userId: string) => pullNotes(ws, 0, userId).notes;
const stored = (ws: string, id: string) => pullNotes(ws, 0).notes.find((x) => x.id === id) as Note;

/** A database "Projects" with its own source (Name, Status) and a further one "Bugs" (Name, Severity). */
function twoSources(parentId: string | null = null) {
  const db = blankNote({ kind: "database", title: "Projects", parentId });
  const own: DbSchema = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "status", name: "Status", type: "text" }], views: [] };
  const bugs = blankNote({ kind: "database", title: "Bugs", parentId: db.id, icon: "🐞" });
  bugs.db = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "sev", name: "Severity", type: "number" }], views: [defaultView("table", "Table")], dataSource: true };
  const tasks = defaultView("table", "Tasks");
  const bugView: DbView = { ...defaultView("board", "Bug board"), source: bugs.id };
  db.db = { ...own, views: [tasks, bugView] };
  const row = blankNote({ kind: "page", parentId: db.id, title: "Launch", props: { status: "doing" } });
  const bug = blankNote({ kind: "page", parentId: bugs.id, title: "Crash", props: { sev: 3 } });
  return { db, bugs, row, bug, tasks, bugView };
}

// --- Model ----------------------------------------------------------------------

test("data sources: the sanitizer keeps sources, links, labels and color rules; drops bad ones", () => {
  const { db, bugs } = twoSources();
  const raw = JSON.parse(JSON.stringify(db)) as Note;
  (raw.db as DbSchema).linked = ["a".repeat(32), "bad id!", "a".repeat(32)];
  (raw.db as DbSchema).label = { name: "Tasks", icon: "javascript:x" };
  raw.db!.views[0].colors = [
    { id: "c1", color: "red", filters: [{ id: "f", prop: "status", op: "is", value: "doing" }] },
    { id: "c2", color: "default" as never, filters: [] },
  ];
  raw.db!.views[1].source = "../../etc";
  const clean = sanitizeNote(raw) as Note;
  assert.deepEqual(clean.db?.linked, ["a".repeat(32)]);
  assert.deepEqual(clean.db?.label, { name: "Tasks" });
  assert.equal(clean.db?.views[0].colors?.length, 1, "a rule without a real color is dropped");
  assert.equal(clean.db?.views[1].source, undefined, "a source is a note id");
  const src = sanitizeNote(JSON.parse(JSON.stringify(bugs))) as Note;
  assert.equal(src.db?.dataSource, true);
});

test("data sources: a further source is not a row; sources come in order, linked ones last", () => {
  const { db, bugs, row, bug } = twoSources();
  const other = blankNote({ kind: "database", title: "Elsewhere" });
  other.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [defaultView("table", "T")] };
  db.db = { ...(db.db as DbSchema), linked: [other.id] };
  const all = [db, bugs, row, bug, other];
  const byId = new Map(all.map((x) => [x.id, x]));
  assert.deepEqual(rowsOf(db.id, all).map((x) => x.id), [row.id], "the source note is not a row of its database");
  assert.deepEqual(rowsOf(bugs.id, all).map((x) => x.id), [bug.id]);
  assert.deepEqual(childSources(db.id, all).map((x) => x.id), [bugs.id]);
  const list = sourcesOf(db, all, byId, "Untitled");
  assert.deepEqual(list.map((s) => [s.kind, s.name]), [["own", "Projects"], ["child", "Bugs"], ["linked", "Elsewhere"]]);
  assert.equal(viewSourceId(db.id, db.db!.views[1]), bugs.id);
  assert.equal(viewSourceId(db.id, db.db!.views[0]), db.id);
  // A database still says only what was there before (old devices read the first source as the whole).
  assert.equal(db.db?.properties.length, 2);
});

test("data sources: a merged schema splits back — views to the database, the rest to the source", () => {
  const { db, bugs } = twoSources();
  const merged = mergedSchema(db.db as DbSchema, bugs.db, false) as DbSchema;
  assert.equal(merged.views, db.db?.views);
  assert.equal(merged.properties, bugs.db?.properties);
  const added = { ...merged, properties: [...merged.properties, { id: "x", name: "Owner", type: "person" as const }] };
  const parts = splitSchema(db.db as DbSchema, bugs.db as DbSchema, added);
  assert.equal(parts.views, null, "the views did not change");
  assert.equal(parts.source?.properties.length, 3);
  assert.equal(parts.source?.views, bugs.db?.views, "the source keeps its own views");
  const renamed = { ...merged, views: merged.views.map((v) => ({ ...v, name: `${v.name}!` })) };
  const p2 = splitSchema(db.db as DbSchema, bugs.db as DbSchema, renamed);
  assert.equal(p2.source, null);
  assert.equal(p2.views?.[1].name, "Bug board!");
});

test("data sources: moving one to another database takes its tabs; the first stays while there are others", () => {
  const { db, bugs, row, bug } = twoSources();
  const target = blankNote({ kind: "database", title: "Archive" });
  target.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [defaultView("table", "All")] };
  const all = [db, bugs, row, bug, target];
  const plan = moveSourcePlan(db, bugs, target, all, "Table");
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.src.parentId, target.id);
  assert.deepEqual(viewsOf(plan.to.views, target.id, bugs.id).map((v) => v.name), ["Bug board"]);
  assert.deepEqual(plan.from?.views.map((v) => v.name), ["Tasks"]);
  const own = moveSourcePlan(db, db, target, all);
  assert.equal(own.ok, false);
  assert.equal(!own.ok && own.reason, "own");
  // Never into its own rows.
  const inner = blankNote({ kind: "database", title: "Inner", parentId: bug.id });
  inner.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [defaultView("table", "T")] };
  const cyc = moveSourcePlan(db, bugs, inner, [...all, inner]);
  assert.equal(!cyc.ok && cyc.reason, "cycle");
  // A database with one source moves whole: it becomes a data source of the target.
  const solo = blankNote({ kind: "database", title: "Solo" });
  solo.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [defaultView("table", "Grid")] };
  const whole = moveSourcePlan(solo, solo, target, [solo, target]);
  assert.ok(whole.ok);
  if (whole.ok) {
    assert.equal(whole.src.db?.dataSource, true);
    assert.equal(whole.to.views.find((v) => v.name === "Grid")?.source, solo.id);
  }
});

test("data sources: turning one into a database puts it beside the old one with its tabs", () => {
  const { db, bugs } = twoSources();
  const page = blankNote({ kind: "page", title: "Hub" });
  db.parentId = page.id;
  const plan = splitSourcePlan(db, bugs, "Table");
  assert.ok(plan);
  assert.equal(plan?.src.parentId, page.id);
  assert.equal(plan?.src.db?.dataSource, undefined);
  assert.deepEqual(plan?.src.db?.views.map((v) => [v.name, v.source]), [["Bug board", undefined]]);
  assert.deepEqual(plan?.from.views.map((v) => v.name), ["Tasks"]);
  assert.equal(splitSourcePlan(db, db), null, "the first one is the database itself");
});

test("data sources: a view switched to another source keeps only what that source has", () => {
  const { db, bugs } = twoSources();
  const v: DbView = { ...defaultView("board", "B"), groupBy: "status", filters: [{ id: "f", prop: "status", op: "is", value: "x" }, { id: "g", prop: "title", op: "contains", value: "a" }], sorts: [{ prop: "status", dir: "asc" }], hidden: ["status"], colors: [{ id: "c", color: "red", filters: [{ id: "h", prop: "status", op: "empty" }] }] };
  const out = retargetView(v, db.id, bugs.id, bugs.db as DbSchema);
  assert.equal(out.source, bugs.id);
  assert.deepEqual(out.filters.map((f) => f.prop), ["title"]);
  assert.deepEqual(out.sorts, []);
  assert.deepEqual(out.hidden, []);
  assert.equal(out.groupBy, undefined, "Bugs has no select or status to group by");
  assert.deepEqual(out.colors, []);
  const back = retargetView(out, db.id, db.id, db.db as DbSchema);
  assert.equal(back.source, undefined);
});

test("data sources: copies point at the copies (views, links)", () => {
  const { db, bugs } = twoSources();
  db.db = { ...(db.db as DbSchema), linked: ["b".repeat(32)] };
  const map = new Map([[bugs.id, "c".repeat(32)], ["b".repeat(32), "d".repeat(32)]]);
  const c = remapNote(structuredClone(db), map);
  assert.equal(c.db?.views[1].source, "c".repeat(32));
  assert.deepEqual(c.db?.linked, ["d".repeat(32)]);
});

test("data sources: public copies show one table per published source", () => {
  const { db, bugs, row, bug } = twoSources();
  const tables = sourceTables(db, [db, bugs, row, bug]);
  assert.deepEqual(tables.map((x) => x.src.id), [db.id, bugs.id]);
  assert.deepEqual(sourceTables(db, [db, row]).map((x) => x.src.id), [db.id], "an unpublished source is left out");
});

// --- Conditional color --------------------------------------------------------------

test("conditional color: the first rule that holds wins, per row and per cell", () => {
  const schema: DbSchema = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "n", name: "Points", type: "number" },
      { id: "s", name: "Status", type: "select", options: [{ id: "o1", name: "Late", color: "red" }] },
    ],
    views: [],
  };
  const view: Pick<DbView, "colors"> = {
    colors: [
      { id: "1", color: "red", filters: [{ id: "a", prop: "s", op: "is", value: "o1" }] },
      { id: "2", color: "green", filters: [{ id: "b", prop: "n", op: "gt", value: "5" }] },
      { id: "3", color: "blue", prop: "n", filters: [{ id: "c", prop: "n", op: "gt", value: "5" }] },
      { id: "4", color: "yellow", prop: "n", filters: [{ id: "d", prop: "n", op: "gt", value: "1" }] },
      // Incomplete: a value is missing, so it colors nothing (a filter would let everything through).
      { id: "5", color: "purple", filters: [{ id: "e", prop: "n", op: "gt", value: "" }] },
      { id: "6", color: "pink", filters: [] },
    ],
  };
  const row = (props: Note["props"]) => blankNote({ kind: "page", title: "r", props });
  assert.deepEqual(rowColors(row({ s: "o1", n: 9 }), view, schema), { row: "red", cells: { n: "blue" } });
  assert.deepEqual(rowColors(row({ n: 9 }), view, schema), { row: "green", cells: { n: "blue" } });
  assert.deepEqual(rowColors(row({ n: 2 }), view, schema), { cells: { n: "yellow" } });
  assert.deepEqual(rowColors(row({}), view, schema), { cells: {} });
  // A deleted property's rules go with it.
  const s2 = withoutProp({ ...schema, views: [{ ...defaultView("table", "T"), colors: view.colors }] }, "n");
  assert.deepEqual(s2.views[0].colors?.map((c) => [c.id, c.filters.length]), [["1", 1], ["2", 0], ["5", 0], ["6", 0]]);
});

// --- Known gaps fixed ---------------------------------------------------------------

test("wiki: Turn into database drops Owner and Verification (Notion), the rest stays", () => {
  const base: DbSchema = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "tags", name: "Tags", type: "multi_select", options: [] }], views: [{ ...defaultView("table", "T"), sorts: [] }] };
  let i = 0;
  const wiki = asWiki(base, { owner: "Owner", verification: "Verification" }, () => `w${++i}`);
  wiki.views = [{ ...wiki.views[0], hidden: ["w1"], filters: [{ id: "f", prop: "w2", op: "is", value: "verified" }] }];
  const back = withoutWiki(wiki, withoutProp);
  assert.equal(back.wiki, undefined);
  assert.deepEqual(back.properties.map((p) => p.id), ["title", "tags"]);
  assert.deepEqual(back.views[0].hidden, []);
  assert.deepEqual(back.views[0].filters, []);
});

test("column permissions: a formula or rollup over a hidden column is hidden too", () => {
  const who = { id: "anna-user", groups: new Set<string>(), full: false };
  const schema: DbSchema = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "salary", name: "Salary", type: "number", perms: { view: ["hr-user"] } },
      { id: "f1", name: "Bonus", type: "formula", formula: { expr: 'prop("Salary") * 0.1' } },
      { id: "f2", name: "Total", type: "formula", formula: { expr: 'prop("Bonus") + 1' } },
      { id: "f3", name: "Shout", type: "formula", formula: { expr: 'upper(prop("Name"))' } },
      { id: "rel", name: "Team", type: "relation", relation: { dbId: "t".repeat(32) } },
      { id: "r1", name: "Team pay", type: "rollup", rollup: { relationPropId: "rel", targetPropId: "pay", fn: "sum" } },
      { id: "r2", name: "Team size", type: "rollup", rollup: { relationPropId: "rel", targetPropId: "title", fn: "count" } },
      { id: "f4", name: "Team cost", type: "formula", formula: { expr: 'prop("Team").map(current.prop("Pay")).sum()' } },
    ],
    views: [],
  };
  const team: DbSchema = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "pay", name: "Pay", type: "number" }], views: [] };
  const others = (id: string) => (id === "t".repeat(32) ? { schema: team, denied: new Map([["pay", "view" as const]]) } : undefined);
  const denied = deniedColumns(schema, who, others);
  assert.deepEqual([...denied.entries()].sort(), [["f1", "view"], ["f2", "view"], ["f4", "view"], ["r1", "view"], ["salary", "view"]]);
  // People who may see the column see the formulas too.
  assert.equal(deniedColumns(schema, { ...who, id: "hr-user" }, () => undefined).size, 0);
  const db = blankNote({ kind: "database", title: "Pay", db: schema });
  const shown = annotateSchema(db, who, denied);
  assert.equal(shown.db?.properties.find((p) => p.id === "f2")?.denied, "view");
  assert.equal(shown.db?.properties.find((p) => p.id === "f3")?.denied, undefined);
});

test("column permissions: a pull marks such a formula restricted for the reader", () => {
  const t = team();
  const db = blankNote({ kind: "database", title: "Pay" });
  db.db = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "salary", name: "Salary", type: "number", perms: { view: [t.olga] } },
      { id: "bonus", name: "Bonus", type: "formula", formula: { expr: 'prop("Salary") * 2' } },
    ],
    views: [defaultView("table", "T")],
  };
  as(t.ws, t.olga, [db]);
  const annas = mine(t.ws, t.anna).find((x) => x.id === db.id) as Note;
  assert.equal(annas.db?.properties.find((p) => p.id === "bonus")?.denied, "view");
  const olgas = mine(t.ws, t.olga).find((x) => x.id === db.id) as Note;
  assert.equal(olgas.db?.properties.find((p) => p.id === "bonus")?.denied, undefined);
  // Anna pushing the schema back cannot store the mark, nor lose the formula.
  as(t.ws, t.anna, [{ ...annas, title: "Pay 2" }]);
  const after = stored(t.ws, db.id);
  assert.equal(after.title, "Pay 2");
  assert.equal(after.db?.properties.find((p) => p.id === "bonus")?.denied, undefined);
  assert.equal(after.db?.properties.find((p) => p.id === "bonus")?.formula?.expr, 'prop("Salary") * 2');
});

// --- Server: access, forms, links -----------------------------------------------------

test("data sources: a restricted source and its rows stay out of others' pulls; the database does not", () => {
  const t = team();
  const { db, bugs, row, bug } = twoSources();
  as(t.ws, t.olga, [db, bugs, row, bug]);
  assert.ok(mine(t.ws, t.anna).some((x) => x.id === bug.id));
  setRestricted(t.ws, bugs.id, true, t.olga);
  const annas = new Set(mine(t.ws, t.anna).map((x) => x.id));
  assert.ok(annas.has(db.id) && annas.has(row.id));
  assert.ok(!annas.has(bugs.id) && !annas.has(bug.id));
  // Nor can she add rows there.
  const sneak = blankNote({ kind: "page", parentId: bugs.id, title: "x" });
  assert.equal(as(t.ws, t.anna, [sneak]).rejected[0]?.reason, "forbidden");
});

test("data sources: a database links or shows only sources its pusher may read", () => {
  const t = team();
  const { db, bugs } = twoSources();
  as(t.ws, t.olga, [db, bugs]);
  const secret = blankNote({ kind: "database", title: "Secret" });
  secret.db = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "x", name: "X", type: "text" }], views: [defaultView("table", "T")] };
  as(t.ws, t.olga, [secret]);
  setRestricted(t.ws, secret.id, true, t.olga);
  const cur = stored(t.ws, db.id);
  const pushed: Note = { ...cur, db: { ...(cur.db as DbSchema), linked: [secret.id], views: [...(cur.db as DbSchema).views, { ...defaultView("table", "Peek"), source: secret.id }, { ...defaultView("form", "Leak"), source: bugs.id }] } };
  as(t.ws, t.anna, [pushed]);
  const after = stored(t.ws, db.id);
  assert.equal(after.db?.linked, undefined, "she cannot read Secret: no link");
  assert.equal(after.db?.views.find((v) => v.name === "Peek")?.source, undefined);
  assert.equal(after.db?.views.find((v) => v.name === "Leak")?.source, bugs.id, "a form on a source she may edit");
  // Olga may link it.
  as(t.ws, t.olga, [pushed]);
  assert.deepEqual(stored(t.ws, db.id).db?.linked, [secret.id]);
  // The pure guard: an unchanged reference stays whoever pushes.
  const g = guardSources(pushed, pushed, { canRead: () => false, canEdit: () => false, parentOf: () => null, exists: () => true });
  assert.equal(g, pushed);
  // A source pushed after its database in one batch is not on the server yet: the reference waits for it.
  const fresh = { ...defaultView("table", "Next"), source: "e".repeat(32) };
  const later = guardSources(stored(t.ws, db.id), { ...pushed, db: { ...(pushed.db as DbSchema), views: [fresh] } }, { canRead: () => false, canEdit: () => false, parentOf: () => null, exists: () => false });
  assert.equal(later.db?.views[0].source, "e".repeat(32));
});

test("data sources: a form view adds its responses to the view's data source", () => {
  const t = team();
  const { db, bugs } = twoSources();
  const view: DbView = { ...defaultView("form", "Report a bug"), source: bugs.id };
  db.db = { ...(db.db as DbSchema), views: [...(db.db as DbSchema).views, view] };
  as(t.ws, t.olga, [db, bugs]);
  const formId = openNoteForm(t.ws, db.id, view.id);
  const cur = stored(t.ws, db.id);
  as(t.ws, t.olga, [{ ...cur, db: { ...(cur.db as DbSchema), views: (cur.db as DbSchema).views.map((v) => (v.id === view.id ? { ...v, form: { questions: [{ prop: "title", required: true }, { prop: "sev" }] , shareId: formId } } : v)) } }]);
  const form = readNoteForm(formId);
  assert.deepEqual(form?.questions.map((q) => q.name), ["Name", "Severity"]);
  const res = submitNoteForm(formId, { title: "Login fails", sev: 2 });
  assert.ok(res.ok);
  const created = stored(t.ws, (res as { rowId: string }).rowId);
  assert.equal(created.parentId, bugs.id);
  assert.equal(created.props?.sev, 2);
  // A source that is no longer in the database closes the form.
  const b = stored(t.ws, bugs.id);
  as(t.ws, t.olga, [{ ...b, parentId: null }]);
  assert.equal(readNoteForm(formId), null);
});

test("webhooks: database notes also report as data sources", () => {
  const { db, bugs } = twoSources();
  const created = eventsOf({ id: bugs.id, before: null, after: bugs });
  assert.deepEqual(created.map((e) => e.type), ["database.created", "data_source.created"]);
  assert.equal(created[1].entity.type, "data_source");
  assert.deepEqual(created[1].data.parent, { id: toUuid(db.id), type: "database" });
  const changed = eventsOf({ id: bugs.id, before: bugs, after: { ...bugs, db: { ...(bugs.db as DbSchema), properties: [] } } });
  assert.deepEqual(changed.map((e) => e.type), ["database.schema_updated", "data_source.schema_updated"]);
});

// --- Public API (Notion 2025-09-03) ----------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx?: { params: Promise<any> }) => Promise<Response>;

async function call(handler: Handler, secret: string, version: string, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const req = new Request("http://localhost/api/v1/x", {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "notion-version": version },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  resetRate();
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("API 2025-09-03: databases list data sources; data sources have schemas, rows and templates", async () => {
  const t = team();
  const page = blankNote({ kind: "page", title: "Hub" });
  const { db, bugs, row, bug } = twoSources(page.id);
  const tpl = blankNote({ kind: "page", parentId: bugs.id, title: "Bug report", template: true });
  bugs.db = { ...(bugs.db as DbSchema), defaultTemplate: tpl.id };
  as(t.ws, t.olga, [page, db, bugs, row, bug, tpl]);
  const { integration, secret } = createIntegration(t.olga, t.ws, { name: "Sync" });
  assert.ok(connectPage(t.olga, t.ws, integration.id, page.id));
  const NEW = "2025-09-03";
  const OLD = "2022-06-28";

  const d = await call(dbRoute.GET, secret, NEW, { params: { id: db.id } });
  assert.equal(d.status, 200);
  assert.equal(d.body.properties, undefined);
  assert.deepEqual(d.body.data_sources, [{ id: toUuid(db.id), name: "Projects" }, { id: toUuid(bugs.id), name: "Bugs" }]);
  // The old version keeps the old shape: the database with its (first source's) properties.
  const old = await call(dbRoute.GET, secret, OLD, { params: { id: db.id } });
  assert.deepEqual(Object.keys(old.body.properties as object).sort(), ["Name", "Status"]);
  assert.equal(old.body.data_sources, undefined);

  const ds = await call(dsRoute.GET, secret, NEW, { params: { id: toUuid(bugs.id) } });
  assert.equal(ds.status, 200);
  assert.equal(ds.body.object, "data_source");
  assert.deepEqual(ds.body.parent, { type: "database_id", database_id: toUuid(db.id) });
  assert.deepEqual(ds.body.database_parent, { type: "page_id", page_id: toUuid(page.id) });
  assert.deepEqual(Object.keys(ds.body.properties as object).sort(), ["Name", "Severity"]);
  // A further source is not a database of its own in the new version.
  assert.equal((await call(dbRoute.GET, secret, NEW, { params: { id: bugs.id } })).status, 400);

  const q = await call(dsQueryRoute.POST, secret, NEW, { body: {}, params: { id: bugs.id } });
  const results = q.body.results as { id: string; parent: Record<string, string> }[];
  assert.deepEqual(results.map((r) => r.id), [toUuid(bug.id)]);
  assert.deepEqual(results[0].parent, { type: "data_source_id", data_source_id: toUuid(bugs.id), database_id: toUuid(db.id) });
  assert.equal((await call(dbQueryRoute.POST, secret, NEW, { body: {}, params: { id: db.id } })).status, 400, "rows are queried per data source");
  const oldQ = await call(dbQueryRoute.POST, secret, OLD, { body: {}, params: { id: db.id } });
  assert.deepEqual((oldQ.body.results as { id: string; parent: unknown }[]).map((r) => r.id), [toUuid(row.id)], "the source note is no row");
  assert.deepEqual((oldQ.body.results as { parent: unknown }[])[0].parent, { type: "database_id", database_id: toUuid(db.id) });

  const tp = await call(dsTemplatesRoute.GET, secret, NEW, { params: { id: bugs.id } });
  assert.deepEqual(tp.body.templates, [{ id: toUuid(tpl.id), name: "Bug report", is_default: true }]);

  // Rows: a data source parent; a database with several sources needs one named.
  const viaDb = await call(pagesRoute.POST, secret, NEW, { body: { parent: { database_id: db.id }, properties: { Name: { title: [{ text: { content: "x" } }] } } } });
  assert.equal(viaDb.status, 400);
  const viaDs = await call(pagesRoute.POST, secret, NEW, { body: { parent: { type: "data_source_id", data_source_id: toUuid(bugs.id) }, properties: { Name: { title: [{ text: { content: "Freeze" } }] }, Severity: { number: 5 } } } });
  assert.equal(viaDs.status, 200);
  assert.deepEqual(viaDs.body.parent, { type: "data_source_id", data_source_id: toUuid(bugs.id), database_id: toUuid(db.id) });
  const got = await call(pageRoute.GET, secret, OLD, { params: { id: String(viaDs.body.id) } });
  assert.deepEqual(got.body.parent, { type: "database_id", database_id: toUuid(bugs.id) }, "old clients see the source as a database");

  // Search: data sources in the new version, databases in the old.
  const sNew = await call(searchRoute.POST, secret, NEW, { body: { filter: { property: "object", value: "data_source" } } });
  assert.deepEqual((sNew.body.results as { object: string }[]).map((r) => r.object), ["data_source", "data_source"]);
  assert.equal((await call(searchRoute.POST, secret, NEW, { body: { filter: { property: "object", value: "database" } } })).status, 400);
  const sOld = await call(searchRoute.POST, secret, OLD, { body: { filter: { property: "object", value: "database" } } });
  assert.deepEqual((sOld.body.results as { object: string }[]).map((r) => r.object), ["database", "database"]);
});

test("API 2025-09-03: create, change and move data sources", async () => {
  const t = team();
  const page = blankNote({ kind: "page", title: "Hub" });
  const { db, bugs, row, bug } = twoSources(page.id);
  const archive = blankNote({ kind: "database", title: "Archive", parentId: page.id });
  archive.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [defaultView("table", "All")] };
  as(t.ws, t.olga, [page, db, bugs, row, bug, archive]);
  const { integration, secret } = createIntegration(t.olga, t.ws, { name: "Builder" });
  assert.ok(connectPage(t.olga, t.ws, integration.id, page.id));
  const NEW = "2025-09-03";

  const made = await call(dsCreateRoute.POST, secret, NEW, { body: { parent: { type: "database_id", database_id: toUuid(db.id) }, title: [{ text: { content: "Ideas" } }], properties: { Name: { title: {} }, Votes: { number: {} } } } });
  assert.equal(made.status, 200);
  const ideas = String(made.body.id).replace(/-/g, "");
  const stIdeas = stored(t.ws, ideas);
  assert.equal(stIdeas.parentId, db.id);
  assert.equal(stIdeas.db?.dataSource, true);
  assert.ok(stored(t.ws, db.id).db?.views.some((v) => v.source === ideas), "a tab of it in the database");
  const list = await call(dbRoute.GET, secret, NEW, { params: { id: db.id } });
  assert.deepEqual((list.body.data_sources as { name: string }[]).map((x) => x.name), ["Projects", "Bugs", "Ideas"]);

  // Properties change on the data source, never on the database in the new version.
  assert.equal((await call(dbRoute.PATCH, secret, NEW, { method: "PATCH", body: { properties: { X: { rich_text: {} } } }, params: { id: db.id } })).status, 400);
  const ren = await call(dsRoute.PATCH, secret, NEW, { method: "PATCH", body: { title: [{ text: { content: "Tasks" } }], properties: { Due: { date: {} } } }, params: { id: db.id } });
  assert.equal(ren.status, 200);
  const host = stored(t.ws, db.id);
  assert.equal(host.title, "Projects", "renaming the first source leaves the database's name");
  assert.equal(host.db?.label?.name, "Tasks");
  assert.ok(host.db?.properties.some((p) => p.name === "Due"));
  assert.equal((await call(dsRoute.PATCH, secret, NEW, { method: "PATCH", body: { in_trash: true }, params: { id: db.id } })).status, 400);

  // Moving Bugs to Archive: its tab goes along.
  const mv = await call(dsRoute.PATCH, secret, NEW, { method: "PATCH", body: { parent: { type: "database_id", database_id: toUuid(archive.id) } }, params: { id: bugs.id } });
  assert.equal(mv.status, 200);
  assert.equal(stored(t.ws, bugs.id).parentId, archive.id);
  assert.ok(stored(t.ws, archive.id).db?.views.some((v) => v.source === bugs.id && v.name === "Bug board"));
  assert.ok(!stored(t.ws, db.id).db?.views.some((v) => v.source === bugs.id));
  // The first source stays while there are others.
  assert.equal((await call(dsRoute.PATCH, secret, NEW, { method: "PATCH", body: { parent: { database_id: archive.id } }, params: { id: db.id } })).status, 400);
});

// --- Notion audit: grouping by date, number display, descriptions, view templates, wrapped columns ---

test("grouping: dates by relative time, day, week, month or year, in either order", () => {
  const prop = { id: "d", name: "Due", type: "date" as const };
  const labels = { none: "No Due", checked: "", unchecked: "", relative: { today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday", next7: "Next 7 days", last7: "Last 7 days", next30: "Next 30 days", last30: "Last 30 days", weekOf: "Week of {date}" } };
  const at = (iso: string) => blankNote({ kind: "page", title: iso, props: { d: { start: iso } } });
  const rows = [at("2026-10-15"), at("2026-10-16"), at("2026-10-14"), at("2026-10-20"), at("2026-11-02"), at("2026-12-25"), at("2025-03-01"), blankNote({ kind: "page", title: "none" })];
  const now = new Date("2026-10-15T12:00:00");
  const rel = groupRowsFor(rows, prop, labels, "en", { groupDate: "relative" }, now);
  assert.deepEqual(rel.map((g) => g.label), ["March 2025", "Yesterday", "Today", "Tomorrow", "Next 7 days", "Next 30 days", "December 2026", "No Due"]);
  const years = groupRowsFor(rows, prop, labels, "en", { groupDate: "year", groupOrder: "desc" }, now);
  assert.deepEqual(years.map((g) => [g.label, g.rows.length]), [["2026", 6], ["2025", 1], ["No Due", 1]]);
  const weeks = groupRowsFor([at("2026-10-14"), at("2026-10-18"), at("2026-10-19")], prop, labels, "en", { groupDate: "week" }, now);
  assert.deepEqual(weeks.map((g) => [g.key, g.rows.length]), [["2026-10-12", 2], ["2026-10-19", 1]]);
  assert.match(weeks[0].label, /^Week of /);
  const days = groupRowsFor([at("2026-10-14"), at("2026-10-14")], prop, labels, "en", { groupDate: "day" }, now);
  assert.equal(days.length, 1);
  // Months stay the default.
  assert.equal(groupRowsFor([at("2026-10-14")], prop, labels, "en", undefined, now)[0].label, "October 2026");
  // Text groups A→Z, or Z→A.
  const t = { id: "t", name: "Team", type: "text" as const };
  const txt = (v: string) => blankNote({ kind: "page", title: v, props: { t: v } });
  assert.deepEqual(groupRowsFor([txt("b"), txt("a")], t, labels, "en", { groupOrder: "desc" }).map((g) => g.label), ["b", "a"]);
});

test("audit: number display, descriptions, view templates and wrapped columns survive the sanitizer", () => {
  const db = blankNote({ kind: "database", title: "Audit" });
  db.db = {
    properties: [
      { id: "title", name: "Name", type: "title", description: "  What it is  " },
      { id: "p", name: "Progress", type: "number", show: { as: "ring", color: "green", divide: 10, number: false } },
      { id: "q", name: "Bad", type: "number", show: { as: "pie" as never, color: "green" } },
    ],
    views: [{ ...defaultView("table", "T"), groupDate: "week", groupOrder: "desc", template: "a".repeat(32), wrapCols: ["p", "p", ""], endProp: "p" }],
  };
  const clean = sanitizeNote(JSON.parse(JSON.stringify(db))) as Note;
  assert.equal(clean.db?.properties[0].description, "  What it is  ");
  assert.deepEqual(clean.db?.properties[1].show, { as: "ring", color: "green", divide: 10, number: false });
  assert.equal(clean.db?.properties[2].show, undefined);
  const v = clean.db?.views[0];
  assert.equal(v?.groupDate, "week");
  assert.equal(v?.groupOrder, "desc");
  assert.equal(v?.template, "a".repeat(32));
  assert.deepEqual(v?.wrapCols, ["p"]);
  assert.equal(v?.endProp, "p", "a timeline's separate end date");
  assert.deepEqual(withoutProp(clean.db as DbSchema, "p").views[0].wrapCols, []);
  assert.equal(withoutProp(clean.db as DbSchema, "p").views[0].endProp, undefined);
  // A copied view's template points at the copied template.
  const c = remapNote(structuredClone(clean), new Map([["a".repeat(32), "b".repeat(32)]]));
  assert.equal(c.db?.views[0].template, "b".repeat(32));
});

test("import: a Notion export's several CSVs of one database become its data sources", () => {
  const paths = [
    "Export/Hub abc.md",
    "Export/Hub abc/Projects 111.csv",
    "Export/Hub abc/Projects 111_all.csv",
    "Export/Hub abc/Projects 111/Launch 222.md",
    "Export/Hub abc/Projects 111/Bugs 333.csv",
    "Export/Hub abc/Projects 111/Bugs 333/Crash 444.md",
    "Export/Team 555/Tasks 666.csv",
    "Export/Team 555/Docs 777.csv",
    "Export/Solo 888/Only 999.csv",
  ];
  const m = notionSources(paths);
  assert.deepEqual(m.get("Export/Hub abc/Projects 111/Bugs 333.csv"), { host: "Export/Hub abc/Projects 111.csv" });
  assert.equal(m.has("Export/Hub abc/Projects 111.csv"), false, "a database in a page is a database of its own");
  assert.deepEqual(m.get("Export/Team 555/Docs 777.csv"), { host: "", folder: "Export/Team 555" });
  assert.deepEqual(m.get("Export/Team 555/Tasks 666.csv"), { host: "Export/Team 555/Docs 777.csv" });
  assert.equal(m.has("Export/Solo 888/Only 999.csv"), false, "one CSV alone is an ordinary database");
});
