// Formulas, rollups, typed dates, reminders and automations of Documents:
// pure code, no storage. Dates are local, so each test pins a time zone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalFormula, parseFormula, toText, type FValue } from "@/lib/notes/formula";
import { computeRows, formulaIssue } from "@/lib/notes/compute";
import { parseHumanDate } from "@/lib/notes/dates";
import { collectReminders, dueReminders } from "@/lib/notes/reminders";
import { fires, type Automation } from "@/lib/notes/automations";
import { blankNote } from "@/lib/notes/model";
import type { DbSchema, Note } from "@/lib/notes/types";

const run = (src: string, props: Record<string, FValue> = {}, locale = "en"): FValue =>
  evalFormula(parseFormula(src), {
    now: new Date(2026, 9, 14, 12, 0).getTime(),
    locale,
    prop: (name) => {
      if (!(name in props)) throw new Error(`no ${name}`);
      return props[name];
    },
  });
const text = (src: string, props?: Record<string, FValue>, locale?: string) => toText(run(src, props, locale), locale);

test("formulas: operators bind like Notion's", () => {
  process.env.TZ = "UTC";
  assert.equal(run("2 + 3 * 4"), 14);
  assert.equal(run("10 - 2 - 3"), 5);
  assert.equal(run("-2 ^ 2"), -4);
  assert.equal(run("2 ^ 3 ^ 2"), 512);
  assert.equal(run("(2 + 3) * 4"), 20);
  assert.equal(run("7 % 3"), 1);
  assert.equal(run("1 / 0"), null);
  assert.equal(run("1 < 2 and 2 < 3"), true);
  assert.equal(run("not 1 > 2"), true);
  assert.equal(run("true ? 1 : false ? 2 : 3"), 1);
  assert.equal(run("false ? 1 : false ? 2 : 3"), 3);
  assert.equal(run('"a" + 1'), "a1");
  assert.equal(run("1 + empty(0)"), 2);
  assert.equal(run('if(prop("N") > 5, "big", "small")', { N: 7 }), "big");
  assert.equal(run('prop("N") + 1', { N: null }), 1);
  assert.equal(run('lets(a, 2, b, a * 3, a + b)'), 8);
  assert.equal(run("[1, 2, 3].map(current * 2).sum()"), 12);
  assert.equal(run("[3, 1, 2].sort().join(\"-\")"), "1-2-3");
  assert.equal(run('"abc".length()'), 3);
  assert.equal(run("12.5.round()"), 13);
  assert.equal(run("5.format()"), "5");
  assert.throws(() => parseFormula("1 +"));
  assert.throws(() => parseFormula('"open'));
  assert.throws(() => run("1 > \"a\""));
});

test("formulas: numbers print whole, without float noise", () => {
  assert.equal(text("0.1 + 0.2"), "0.3");
  assert.equal(text("1760455123456"), "1760455123456");
  assert.equal(text("timestamp(fromTimestamp(1760455123456))"), "1760455123456");
  assert.equal(text("100.1 - 100"), "0.1");
});

test("formulas: dates", () => {
  process.env.TZ = "Europe/Berlin";
  const d = (s: string) => ({ kind: "date" as const, ...(() => { const m = s.split("-").map(Number); return { start: new Date(m[0], m[1] - 1, m[2]).getTime() }; })(), time: false });
  // Over the spring DST change, a day is still a day.
  assert.equal(run('dateBetween(prop("B"), prop("A"), "days")', { A: d("2026-03-28"), B: d("2026-03-30") }), 2);
  assert.equal(run('dateBetween(prop("B"), prop("A"), "months")', { A: d("2026-01-31"), B: d("2026-02-28") }), 1);
  assert.equal(run('dateBetween(prop("A"), prop("B"), "months")', { A: d("2026-01-31"), B: d("2026-03-01") }), -1);
  assert.equal(run('dateBetween(prop("B"), prop("A"), "years")', { A: d("2024-02-29"), B: d("2025-02-28") }), 1);
  // Adding months keeps to the end of a shorter month (moment / Notion).
  assert.equal(text('formatDate(dateAdd(prop("A"), 1, "months"), "YYYY-MM-DD")', { A: d("2026-01-31") }), "2026-02-28");
  assert.equal(text('formatDate(dateAdd(prop("A"), 1, "years"), "YYYY-MM-DD")', { A: d("2024-02-29") }), "2025-02-28");
  assert.equal(text('formatDate(dateSubtract(prop("A"), 1, "quarters"), "YYYY-MM-DD")', { A: d("2026-05-31") }), "2026-02-28");
  assert.equal(text('formatDate(dateAdd(prop("A"), 1, "days"), "YYYY-MM-DD")', { A: d("2026-03-28") }), "2026-03-29");
  assert.equal(run('week(prop("A"))', { A: d("2027-01-01") }), 53);
  assert.equal(run('week(prop("A"))', { A: d("2026-01-01") }), 1);
  assert.equal(run('day(prop("A"))', { A: d("2026-10-18") }), 7);
  assert.equal(text('formatDate(prop("A"), "Do MMMM")', { A: d("2026-10-22") }), "22nd October");
  assert.equal(text('formatDate(prop("A"), "D MMMM YYYY")', { A: d("2026-10-09") }, "ru"), "9 октября 2026");
  // Dates read in the page's language wherever they become text.
  assert.equal(text('"Срок: " + prop("A")', { A: d("2026-10-09") }, "ru"), "Срок: 9 октября 2026 г.");
  assert.equal(text('concat("Срок: ", prop("A"))', { A: d("2026-10-09") }, "ru"), "Срок: 9 октября 2026 г.");
  assert.equal(text('join([prop("A")], "")', { A: d("2026-10-09") }, "ru"), "9 октября 2026 г.");
});

test("formulas: runaway text is an error, not a frozen tab", () => {
  assert.throws(() => run('"xxxxxxxxxx".repeat(1000).repeat(1000)'));
});

// A database with a two-way relation to itself, every row linked to every other.
function linkedDb(rows: number, extra: DbSchema["properties"]): { db: Note; rows: Note[]; byId: Map<string, Note> } {
  const schema: DbSchema = {
    properties: [{ id: "title", name: "Name", type: "title" }, { id: "rel", name: "Related", type: "relation", relation: { dbId: "", syncedPropId: "rel" } }, { id: "n", name: "N", type: "number" }, ...extra],
    views: [],
  };
  const db = blankNote({ kind: "database", title: "Tasks", db: schema });
  schema.properties[1].relation = { dbId: db.id, syncedPropId: "rel" };
  const list = Array.from({ length: rows }, (_, i) => blankNote({ kind: "page", parentId: db.id, title: `Row ${i}`, props: { n: i } }));
  for (const r of list) r.props = { ...r.props, rel: list.filter((x) => x !== r).map((x) => x.id) };
  const byId = new Map<string, Note>([[db.id, db], ...list.map((r) => [r.id, r] as [string, Note])]);
  return { db, rows: list, byId };
}

test("rollups and formulas: plain sums, and circular ones end quickly", () => {
  const plain = linkedDb(4, [{ id: "sum", name: "Sum", type: "rollup", rollup: { relationPropId: "rel", targetPropId: "n", fn: "sum" } }]);
  const out = computeRows(plain.rows, plain.db.db, plain.byId);
  assert.deepEqual(
    out.map((r) => r.computed?.sum),
    [1 + 2 + 3, 0 + 2 + 3, 0 + 1 + 3, 0 + 1 + 2]
  );

  // A rollup over itself through the relation (and a formula in the loop):
  // 14 rows linked to each other would be billions of paths without memoizing.
  const loop = linkedDb(14, [
    { id: "r", name: "R", type: "rollup", rollup: { relationPropId: "rel", targetPropId: "f", fn: "sum" } },
    { id: "f", name: "F", type: "formula", formula: { expr: 'prop("R") + prop("N")' } },
  ]);
  const t0 = Date.now();
  const res = computeRows(loop.rows, loop.db.db, loop.byId);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(res.length, 14);
  // A rollup of itself, with no formula in between.
  const self = linkedDb(14, [{ id: "r", name: "R", type: "rollup", rollup: { relationPropId: "rel", targetPropId: "r", fn: "count_values" } }]);
  const t1 = Date.now();
  assert.equal(computeRows(self.rows, self.db.db, self.byId).length, 14);
  assert.ok(Date.now() - t1 < 2000, `took ${Date.now() - t1} ms`);

  assert.equal(formulaIssue('prop("Nope") + 1', plain.db.db as DbSchema), 'Unknown property "Nope"');
  assert.equal(formulaIssue('nope(1)', plain.db.db as DbSchema), 'Unknown function "nope"');
});

test("typed dates: relative months keep to the month's end", () => {
  const now = new Date(2026, 0, 31, 10);
  assert.equal(parseHumanDate("через 1 месяц", "ru", now), "2026-02-28");
  assert.equal(parseHumanDate("in 1 month", "en", now), "2026-02-28");
  assert.equal(parseHumanDate("1 month ago", "en", new Date(2026, 2, 31)), "2026-02-28");
  assert.equal(parseHumanDate("in 1 year", "en", new Date(2024, 1, 29)), "2025-02-28");
  assert.equal(parseHumanDate("завтра", "ru", now), "2026-02-01");
  assert.equal(parseHumanDate("15.10", "ru", new Date(2026, 9, 1)), "2026-10-15");
  assert.equal(parseHumanDate("10/15", "en", new Date(2026, 9, 1)), "2026-10-15");
  assert.equal(parseHumanDate("31 февраля", "ru", now), null);
});

test("reminders: once per key, and none from pages in the trash", () => {
  process.env.TZ = "UTC";
  const mention = (date: string) => ({ type: "paragraph", content: [{ type: "text", text: "Врач " }, { type: "mention", props: { date, remind: "day" } }] });
  const page = blankNote({ kind: "page", title: "Plans", content: [mention("2026-10-14"), mention("2026-10-14")] });
  const trashed = blankNote({ kind: "page", title: "Old", trashedAt: Date.now() });
  const child = blankNote({ kind: "page", parentId: trashed.id, title: "Child", content: [mention("2026-10-14")] });
  const list = collectReminders([page, trashed, child], () => undefined);
  const due = dueReminders(list, Date.UTC(2026, 9, 14, 9, 30), new Set());
  assert.deepEqual(
    due.map((r) => r.noteId),
    [page.id]
  );
});

test("automations: what fires", () => {
  const schema: DbSchema = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "st", name: "Status", type: "status", options: [{ id: "a", name: "To do", color: "gray" }, { id: "b", name: "Done", color: "green" }] },
      { id: "ok", name: "OK", type: "checkbox" },
    ],
    views: [],
  };
  const row = blankNote({ kind: "page", parentId: "db", props: { st: "a", ok: false } });
  const auto = (trigger: Automation["trigger"]): Automation => ({ id: "x", name: "", on: true, trigger, actions: [] });
  assert.equal(fires(auto({ type: "added" }), undefined, row, schema), true);
  assert.equal(fires(auto({ type: "added" }), row, row, schema), false);
  assert.equal(fires(auto({ type: "edited", prop: "st", value: "b" }), row, { ...row, props: { ...row.props, st: "b" } }, schema), true);
  assert.equal(fires(auto({ type: "edited", prop: "st", value: "b" }), row, { ...row, props: { ...row.props, st: "a" } }, schema), false);
  assert.equal(fires(auto({ type: "edited", prop: "ok", value: "checked" }), row, { ...row, props: { ...row.props, ok: true } }, schema), true);
  assert.equal(fires({ ...auto({ type: "added" }), on: false }, undefined, row, schema), false);
  assert.equal(fires(auto({ type: "added" }), undefined, { ...row, template: true }, schema), false);
});

test("formulas: patterns that backtrack exponentially are refused, ordinary ones work", () => {
  const started = Date.now();
  assert.throws(() => run(`test("${"a".repeat(40)}!", "(a+)+$")`));
  assert.throws(() => run(`replaceAll("x", "(.*)*", "")`));
  assert.ok(Date.now() - started < 1000);
  assert.equal(run(`test("1,2,3", "^(\\\\d+,)*\\\\d+$")`), true);
  assert.equal(text(`replaceAll("a-b-c", "-", "+")`), "a+b+c");
});
