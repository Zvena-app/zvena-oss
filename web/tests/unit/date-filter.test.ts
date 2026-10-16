import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyView } from "@/lib/notes/db";
import { filterDay, withinDays } from "@/lib/notes/date-filter";
import { localYmd } from "@/lib/notes/dates";
import { blankNote, sanitizeNote } from "@/lib/notes/model";
import type { DbFilter, DbSchema, DbView, Note } from "@/lib/notes/types";

const view = (filters: DbFilter[]): DbView => ({ id: "v1", name: "Table", type: "table", filters, sorts: [], hidden: [], widths: {} });

test("date tokens and ranges are days relative to today (weeks start on Monday)", () => {
  const now = new Date(2026, 9, 15, 13, 0); // Thursday, Oct 15 2026
  assert.equal(filterDay("today", now), "2026-10-15");
  assert.equal(filterDay("tomorrow", now), "2026-10-16");
  assert.equal(filterDay("week_ago", now), "2026-10-08");
  assert.equal(filterDay("month_from_now", now), "2026-11-15");
  assert.equal(filterDay("2026-01-02", now), "2026-01-02");
  assert.deepEqual(withinDays("this_week", now), ["2026-10-12", "2026-10-18"]);
  assert.deepEqual(withinDays("past_week", now), ["2026-10-08", "2026-10-15"]);
  assert.deepEqual(withinDays("this_month", now), ["2026-10-01", "2026-10-31"]);
  assert.deepEqual(withinDays("next_year", now), ["2026-10-15", "2027-10-15"]);
  assert.equal(filterDay("month_ago", new Date(2026, 2, 31)), "2026-02-28", "a shorter month keeps to its end");
});

test("filters: relative to today, on or before / after, ≥ ≤, starts / ends with; the operators survive sanitizing", () => {
  const schema: DbSchema = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "d", name: "Due", type: "date" },
      { id: "n", name: "N", type: "number" },
    ],
    views: [],
  };
  const db = blankNote({ kind: "database", title: "Tasks", db: schema });
  const day = (offset: number) => {
    const d = new Date();
    return localYmd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset));
  };
  const row = (title: string, offset: number | null, n: number) => blankNote({ kind: "page", parentId: db.id, title, props: { n, ...(offset === null ? {} : { d: { start: day(offset) } }) } });
  const rows: Note[] = [row("Alpha today", 0, 1), row("Beta last week", -5, 5), row("Gamma next week", 5, 10), row("Delta undated", null, 20)];
  const titles = (f: DbFilter) => applyView(rows, view([f]), schema).map((r) => r.title);
  assert.deepEqual(titles({ id: "a", prop: "d", op: "is", value: "today" }), ["Alpha today"]);
  assert.deepEqual(titles({ id: "a", prop: "d", op: "within", value: "past_week" }), ["Alpha today", "Beta last week"]);
  assert.deepEqual(titles({ id: "a", prop: "d", op: "within", value: "next_week" }), ["Alpha today", "Gamma next week"]);
  assert.deepEqual(titles({ id: "a", prop: "d", op: "on_or_before", value: "today" }), ["Alpha today", "Beta last week"]);
  assert.deepEqual(titles({ id: "a", prop: "d", op: "after", value: "today" }), ["Gamma next week"]);
  assert.deepEqual(titles({ id: "a", prop: "d", op: "on_or_after", value: "tomorrow" }), ["Gamma next week"]);
  assert.deepEqual(titles({ id: "a", prop: "n", op: "gte", value: "10" }), ["Gamma next week", "Delta undated"]);
  assert.deepEqual(titles({ id: "a", prop: "n", op: "lte", value: "5" }), ["Alpha today", "Beta last week"]);
  assert.deepEqual(titles({ id: "a", prop: "title", op: "starts_with", value: "be" }), ["Beta last week"]);
  assert.deepEqual(titles({ id: "a", prop: "title", op: "ends_with", value: "WEEK" }), ["Beta last week", "Gamma next week"]);
  const kept = sanitizeNote({ ...db, db: { ...schema, views: [view([{ id: "a", prop: "d", op: "within", value: "this_month" }, { id: "b", prop: "n", op: "gte", value: "1" }])] } });
  assert.deepEqual(kept?.db?.views[0].filters.map((f) => f.op), ["within", "gte"]);
});

test("numbers: decimal places in every format; relations may be limited to one page", async () => {
  const { formatNumber } = await import("@/lib/notes/db");
  assert.equal(formatNumber(1234.5, "number", "en", 2), "1234.50");
  assert.equal(formatNumber(1234.5, "comma", "en", 0), "1,235");
  assert.equal(formatNumber(0.125, "percent", "en", 1), "12.5%");
  assert.equal(formatNumber(10, "dollar", "en", 0), "$10");
  assert.equal(formatNumber(1234.5, "number", "en"), "1234.5", "unset: as typed");
  const db = blankNote({ kind: "database", title: "X", db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "r", name: "Parent", type: "relation", relation: { dbId: "abcdefgh" }, single: true }, { id: "n", name: "N", type: "number", decimals: 2 }, { id: "bad", name: "B", type: "number", decimals: 9 }], views: [] } });
  const kept = sanitizeNote(db);
  assert.equal(kept?.db?.properties.find((p) => p.id === "r")?.single, true);
  assert.equal(kept?.db?.properties.find((p) => p.id === "n")?.decimals, 2);
  assert.equal(kept?.db?.properties.find((p) => p.id === "bad")?.decimals, undefined);
});
