// Live numbers from inside zvena. Server-only.
//
// A goal closes when a number reaches its target (lib/decide: a reaction on a
// metric). Numbers used to arrive only from outside (/api/pulse/ingest) or by
// hand; a source makes one out of what the workspace already has, and keeps it
// current as the work moves:
//
//   docs     a Documents database, the way its chart sees it: the rows of a
//            view (its filters), optionally one group of a property ("Status
//            is Done", one bar of the chart), counted or summed/averaged/… over
//            a number column;
//   project  a project's progress: percent done, issues done, total or open;
//   calendar events of one calendar in a window (today, this week, this
//            month, the last 30 days, the next 7), counted or in hours,
//            optionally only those whose title has a word ("Customer call");
//   mail     conversations in one of the author's own Mail views, all or
//            unread — mail is personal: only its owner ever sees the number.
//
// A source is computed as the person who made it, with their access (pages,
// column permissions, private teams), and only a person who may see the same
// may see its number (metricsOf → visibleMetrics, the pulse filter). Values are
// recomputed shortly after a change of what they count, and put on the pulse
// only when they actually change, so a goal on them fires on the edge as any
// other.

import { createHash } from "node:crypto";
import { listenAll, registerPulseFilter, type PulseEvent } from "../pulse/bus";
import { AccessResolver } from "../notes/access";
import { deniedColumns } from "../notes/column-perms";
import { calcColumn, hasComputed } from "../notes/compute";
import { applyView, groupRowsFor, rowsOf } from "../notes/db";
import { sanitizeNote } from "../notes/model";
import type { DbProperty, DbView, Note } from "../notes/types";
import { CalAccess, calRow } from "../calendar/access";
import { prefsOf as calPrefs } from "../calendar/calendars";
import { listRange } from "../calendar/events";
import { addDays, dayOf, dayStart, startOfMonth, startOfWeek, validTimeZone } from "../calendar/tz";
import { countThreads } from "../mail-client/store";
import { viewOf as mailViewOf } from "../mail-client/prefs";
import { isSystemView, systemFilter } from "../mail-client/views";
import { ctxFor } from "../projects/core";
import { onChange } from "../projects/events";
import { goalCountFor } from "../projects/goals";
import { getProject } from "../projects/planning";
import { sql, store } from "../store";
import { ensureSchema, putMetric } from "./engine";

export type DocsFn = "count" | "sum" | "average" | "median" | "min" | "max";
export const DOCS_FNS: readonly DocsFn[] = ["count", "sum", "average", "median", "min", "max"];
export type ProjectMeasure = "percent" | "done" | "total" | "open";
export const PROJECT_MEASURES: readonly ProjectMeasure[] = ["percent", "done", "total", "open"];
export type CalPeriod = "today" | "week" | "month" | "last30" | "next7";
export const CAL_PERIODS: readonly CalPeriod[] = ["today", "week", "month", "last30", "next7"];
export type CalMeasure = "events" | "hours";
export type MailMeasure = "unread" | "total";

export type Source =
  | {
      kind: "docs";
      /** The database (page id). */
      db: string;
      /** One of its views: its filters (and data source) apply, as on the chart. */
      view?: string;
      fn: DocsFn;
      /** The number column summed / averaged… (not for count). */
      prop?: string;
      /** Only the rows of one group of a property: an option id, "__on" / "__off" for a checkbox (a chart's bar). */
      where?: { prop: string; key: string };
    }
  | { kind: "project"; project: string; measure: ProjectMeasure }
  | {
      kind: "calendar";
      cal: string;
      period: CalPeriod;
      measure: CalMeasure;
      /** Only events whose title has this (any case). */
      match?: string;
      /** The zone the window is counted in (its author's, set by the server). */
      tz: string;
    }
  /** `user`: the mailbox's owner (set by the server, never taken from a browser). */
  | { kind: "mail"; user: string; view: string; measure: MailMeasure };

/** Kinds whose numbers move with the clock too (a window, snoozed mail): counted again every few minutes. */
export const TIMED_KINDS: ReadonlySet<Source["kind"]> = new Set(["calendar", "mail"]);

export interface SourceRow {
  key: string;
  source: Source;
  label: string;
  by: string;
  at: number;
}

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const PART_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SOURCES = 200;
/** Sources over one database or project. */
export const PER_OBJECT = 10;

/** A source as sent by a browser (untrusted), or null. */
export function cleanSource(v: unknown): Source | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== "object") return null;
  if (s.kind === "docs") {
    if (typeof s.db !== "string" || !ID_RE.test(s.db)) return null;
    const fn = DOCS_FNS.find((f) => f === s.fn) ?? "count";
    const view = typeof s.view === "string" && PART_RE.test(s.view) ? s.view : undefined;
    const prop = typeof s.prop === "string" && PART_RE.test(s.prop) ? s.prop : undefined;
    if (fn !== "count" && !prop) return null;
    const w = s.where as Record<string, unknown> | undefined;
    const where = w && typeof w === "object" && typeof w.prop === "string" && PART_RE.test(w.prop) && typeof w.key === "string" && PART_RE.test(w.key) ? { prop: w.prop, key: w.key } : undefined;
    return { kind: "docs", db: s.db, fn, ...(view ? { view } : {}), ...(fn !== "count" ? { prop } : {}), ...(where ? { where } : {}) };
  }
  if (s.kind === "project") {
    if (typeof s.project !== "string" || !ID_RE.test(s.project)) return null;
    const measure = PROJECT_MEASURES.find((m) => m === s.measure) ?? "percent";
    return { kind: "project", project: s.project, measure };
  }
  if (s.kind === "calendar") {
    if (typeof s.cal !== "string" || !/^[A-Za-z0-9_-]{6,40}$/.test(s.cal)) return null;
    const period = CAL_PERIODS.find((p) => p === s.period) ?? "week";
    const measure: CalMeasure = s.measure === "hours" ? "hours" : "events";
    const match = typeof s.match === "string" ? s.match.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    const tz = typeof s.tz === "string" && validTimeZone(s.tz) ? s.tz : "UTC";
    return { kind: "calendar", cal: s.cal, period, measure, ...(match ? { match } : {}), tz };
  }
  if (s.kind === "mail") {
    if (typeof s.user !== "string" || !ID_RE.test(s.user) || typeof s.view !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s.view)) return null;
    return { kind: "mail", user: s.user, view: s.view, measure: s.measure === "total" ? "total" : "unread" };
  }
  return null;
}

/** A source's metric key: the same definition always gives the same number ("docs:…", "project:…", "calendar:…", "mail:…"). */
export function sourceKey(s: Source): string {
  const canon =
    s.kind === "docs"
      ? [s.kind, s.db, s.view ?? "", s.fn, s.prop ?? "", s.where?.prop ?? "", s.where?.key ?? ""]
      : s.kind === "project"
        ? [s.kind, s.project, s.measure]
        : s.kind === "calendar"
          ? [s.kind, s.cal, s.period, s.measure, (s.match ?? "").toLowerCase(), s.tz]
          : [s.kind, s.user, s.view, s.measure];
  return `${s.kind}:${createHash("sha256").update(canon.join("\u0000")).digest("base64url").slice(0, 16)}`;
}

// ------------------------------------------------------------------ storage

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dz_sources (
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ws, key)
);
`;

interface State {
  db: object | null;
  started: boolean;
  /** Sources per workspace (cache; null = none). */
  byWs: Map<string, SourceRow[]>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Sources waiting to be computed again, per workspace. */
  pending: Map<string, Map<string, SourceRow>>;
  /** Who may see which number (canSee), until it moves. */
  seen: Map<string, { stored: number | undefined; ok: boolean; at: number }>;
  /** While a batch is computed: each database's notes, loaded once. */
  batch: Map<string, Note[]> | null;
}
const KEY = Symbol.for("zvena.decide.sources");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const st: State = (g[KEY] ??= { db: null, started: false, byWs: new Map(), timers: new Map(), pending: new Map(), seen: new Map(), batch: null });
st.pending ??= new Map();
st.seen ??= new Map();

/** Creates the table on the open database (once per database handle). */
function schema(): void {
  ensureSchema();
  const d = store();
  if (st.db === d) return;
  d.exec(SCHEMA);
  st.db = d;
  st.byWs.clear();
}

export function sourcesOf(ws: string): SourceRow[] {
  schema();
  const hit = st.byWs.get(ws);
  if (hit) return hit;
  const rows = sql("SELECT key, json, label, created_by, created_at FROM dz_sources WHERE ws = ? ORDER BY created_at").all(ws) as { key: string; json: string; label: string; created_by: string; created_at: number }[];
  const list: SourceRow[] = [];
  for (const r of rows) {
    let s: Source | null = null;
    try {
      s = cleanSource(JSON.parse(r.json));
    } catch {
      s = null;
    }
    if (s) list.push({ key: r.key, source: s, label: r.label, by: r.created_by, at: r.created_at });
  }
  st.byWs.set(ws, list);
  return list;
}

export function sourceOf(ws: string, key: string): SourceRow | null {
  return sourcesOf(ws).find((s) => s.key === key) ?? null;
}

// ------------------------------------------------------------------ reading

function loadNote(ws: string, id: string): Note | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  if (!r?.json) return null;
  try {
    return sanitizeNote(JSON.parse(r.json));
  } catch {
    return null;
  }
}

/** The notes a database's rows need: the database, its rows, and (for formulas over relations) every page of the workspace. */
function notesFor(ws: string, db: Note): Note[] {
  const memo = st.batch?.get(`${ws}|${db.id}`);
  if (memo) return memo;
  const out = loadNotesFor(ws, db);
  st.batch?.set(`${ws}|${db.id}`, out);
  return out;
}

function loadNotesFor(ws: string, db: Note): Note[] {
  const all = hasComputed(db.db)
    ? (sql("SELECT json FROM notes WHERE ws = ? AND deleted = 0").all(ws) as { json: string | null }[])
    : (sql("SELECT json FROM notes WHERE ws = ? AND deleted = 0 AND json LIKE ?").all(ws, `%"parentId":"${db.id}"%`) as { json: string | null }[]);
  const out: Note[] = [db];
  for (const r of all) {
    try {
      const n = r.json ? sanitizeNote(JSON.parse(r.json)) : null;
      if (n && n.id !== db.id) out.push(n);
    } catch {
      // A broken row counts as no row.
    }
  }
  return out;
}

function inTrash(ws: string, n: Note): boolean {
  for (let cur: Note | null = n, depth = 0; cur && depth < 50; depth++) {
    if (cur.trashedAt !== null) return true;
    cur = cur.parentId ? loadNote(ws, cur.parentId) : null;
  }
  return false;
}

/** The database a docs source counts (the view's data source when it shows another). */
function dataOf(ws: string, s: Extract<Source, { kind: "docs" }>): { host: Note; data: Note; view: DbView | undefined } | null {
  const host = loadNote(ws, s.db);
  if (!host?.db || inTrash(ws, host)) return null;
  const view = s.view ? host.db.views.find((v) => v.id === s.view) : undefined;
  if (s.view && !view) return null;
  const srcId = view?.source && view.source !== host.id ? view.source : host.id;
  const data = srcId === host.id ? host : loadNote(ws, srcId);
  if (!data?.db) return null;
  return { host, data, view };
}

/** The columns of `data` a person may read (column permissions). */
function readableProps(data: Note, acc: AccessResolver): DbProperty[] {
  const hidden = deniedColumns(data.db, { id: acc.userId, groups: acc.groups, full: acc.level(data.id) === "full" });
  return (data.db?.properties ?? []).filter((p) => hidden.get(p.id) !== "view");
}

const NUMERIC = new Set(["number", "formula", "rollup"]);

/** A docs source's value as `userId` sees it; null when they cannot see it (or it makes no sense now). */
export function docsValue(ws: string, s: Extract<Source, { kind: "docs" }>, userId: string): number | null {
  const acc = new AccessResolver(ws, userId);
  if (!acc.role) return null;
  const d = dataOf(ws, s);
  if (!d || acc.level(d.host.id) === null || acc.level(d.data.id) === null) return null;
  const props = readableProps(d.data, acc);
  const all = notesFor(ws, d.data);
  const byId = new Map(all.map((n) => [n.id, n]));
  let rows = rowsOf(d.data.id, all, { byId }).filter((r) => acc.level(r.id) !== null);
  if (d.view) {
    // A filter on a column the person may not read is not theirs to apply.
    const json = JSON.stringify([d.view.filters ?? [], d.view.filterGroup ?? null]);
    if ((d.data.db?.properties ?? []).some((p) => !props.includes(p) && json.includes(`"${p.id}"`))) return null;
    rows = applyView(rows, d.view, d.data.db!);
  }
  if (s.where) {
    const p = props.find((x) => x.id === s.where!.prop);
    if (!p) return null;
    const groups = groupRowsFor(rows, p, { none: "", checked: "", unchecked: "" });
    rows = groups.find((x) => x.key === s.where!.key)?.rows ?? [];
  }
  if (s.fn === "count") return rows.length;
  const prop = props.find((x) => x.id === s.prop && NUMERIC.has(x.type));
  if (!prop) return null;
  if (!rows.length) return s.fn === "sum" ? 0 : null;
  const v = calcColumn(s.fn, rows, prop, byId);
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A project source's value as `userId` sees it (their teams' issues only). */
export function projectValue(ws: string, s: Extract<Source, { kind: "project" }>, userId: string): number | null {
  let ctx;
  try {
    ctx = ctxFor(userId, ws, "read");
    getProject(ctx, s.project);
  } catch {
    return null;
  }
  const c = goalCountFor(ctx, { projectId: s.project });
  switch (s.measure) {
    case "done":
      return c.done;
    case "total":
      return c.total;
    case "open":
      return c.total - c.done;
    default:
      return c.total ? Math.round((c.done / c.total) * 1000) / 10 : 0;
  }
}

/** The window of a calendar source at `now`: [from, to) in its zone. */
export function calWindow(period: CalPeriod, tz: string, now = Date.now()): { from: number; to: number } {
  const today = dayOf(now, tz);
  switch (period) {
    case "today":
      return { from: dayStart(today, tz), to: dayStart(addDays(today, 1), tz) };
    case "month": {
      const first = startOfMonth(today);
      return { from: dayStart(first, tz), to: dayStart(startOfMonth(addDays(first, 32)), tz) };
    }
    case "last30":
      return { from: dayStart(addDays(today, -29), tz), to: dayStart(addDays(today, 1), tz) };
    case "next7":
      return { from: now, to: dayStart(addDays(today, 8), tz) };
    default: {
      const first = startOfWeek(today, 1);
      return { from: dayStart(first, tz), to: dayStart(addDays(first, 7), tz) };
    }
  }
}

/** A calendar source's value as `userId` sees it: null when they cannot read the calendar. */
export function calendarValue(ws: string, s: Extract<Source, { kind: "calendar" }>, userId: string, now = Date.now()): number | null {
  const acc = new CalAccess(userId, ws);
  const cal = calRow(s.cal);
  if (!acc.member || !cal || !acc.canRead(cal)) return null;
  const { from, to } = calWindow(s.period, s.tz, now);
  const want = s.match?.toLowerCase();
  const items = listRange({ acc, tz: s.tz }, { from, to, calIds: [s.cal] }).filter((it) => it.calId === s.cal && it.status !== "cancelled" && (!want || it.title.toLowerCase().includes(want)));
  if (s.measure === "events") return items.length;
  let ms = 0;
  for (const it of items) ms += Math.max(0, Math.min(it.end, to) - Math.max(it.start, from));
  return Math.round((ms / 3600_000) * 10) / 10;
}

/** A mail source's value: its owner's alone (anyone else gets null). */
export function mailValue(ws: string, s: Extract<Source, { kind: "mail" }>, userId: string, now = Date.now()): number | null {
  // Its owner's, while they are in the workspace.
  if (userId !== s.user || !sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(ws, userId)) return null;
  const filter = isSystemView(s.view) ? systemFilter(s.view) : mailViewOf(userId, s.view)?.filter;
  if (!filter) return null;
  return countThreads(userId, filter, { unread: s.measure === "unread", now });
}

/** A source's value as `userId` sees it (`at`: the moment a window of the clock is counted at). */
export function valueFor(ws: string, s: Source, userId: string, at = Date.now()): number | null {
  try {
    switch (s.kind) {
      case "docs":
        return docsValue(ws, s, userId);
      case "project":
        return projectValue(ws, s, userId);
      case "calendar":
        return calendarValue(ws, s, userId, at);
      case "mail":
        return mailValue(ws, s, userId, at);
    }
  } catch {
    return null;
  }
}

/** What a source is about, for its label: the database (and view), the project, the calendar or the Mail view. */
function describe(ws: string, s: Source, userId: string): string {
  if (s.kind === "docs") {
    const d = dataOf(ws, s);
    if (!d) return "";
    return [d.host.title || "", d.view?.name ?? ""].filter(Boolean).join(" · ").slice(0, 120);
  }
  if (s.kind === "calendar") return [calRow(s.cal)?.name ?? "", s.match ? `“${s.match}”` : ""].filter(Boolean).join(" · ").slice(0, 120);
  if (s.kind === "mail") return (isSystemView(s.view) ? "" : (mailViewOf(userId, s.view)?.name ?? "")).slice(0, 120);
  if (s.kind !== "project") return "";
  try {
    return getProject(ctxFor(userId, ws, "read"), s.project).name.slice(0, 120);
  } catch {
    return "";
  }
}

/**
 * Whether `userId` may see a source's number: only when they would count the
 * same — the same rows (page access), columns (permissions, a view's filters)
 * and teams (private ones) as its author. Anything less and the number would
 * tell them about what they cannot see. Answers are kept until the number
 * moves, and 10 seconds at most (access changes too).
 */
const SEEN_MS = 10_000;

export function canSee(ws: string, row: Pick<SourceRow, "key" | "source" | "by">, userId: string): boolean {
  if (userId === row.by) return true;
  // Mail is its owner's alone, however the numbers compare.
  if (row.source.kind === "mail") return false;
  const m = sql("SELECT value, at FROM dz_metrics WHERE ws = ? AND key = ?").get(ws, row.key) as { value: number; at: number } | undefined;
  const stored = m?.value;
  const k = `${ws}|${row.key}|${userId}`;
  const hit = st.seen.get(k);
  // Access changes too (a page shared, a team joined): an answer is kept a few seconds at most.
  if (hit && hit.stored === stored && Date.now() - hit.at < SEEN_MS) return hit.ok;
  // Counted at the same moment as the stored number: a window of the clock moves in between.
  const mine = valueFor(ws, row.source, userId, m ? Number(m.at) : Date.now());
  const ok = mine !== null && (stored === undefined || mine === stored);
  if (st.seen.size > 5000) st.seen.clear();
  st.seen.set(k, { stored, ok, at: Date.now() });
  return ok;
}

// ------------------------------------------------------------------ writing

/**
 * Makes (or finds) a source for this person and returns its metric key. The
 * person must be able to see what it counts; its value is computed at once.
 */
export function saveSource(ws: string, raw: unknown, by: string): { key: string; value: number | null; label: string } | { error: "invalid" | "forbidden" | "limit" } {
  schema();
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  // The server's word on whose mailbox and which zone: never the browser's.
  const s = cleanSource(r.kind === "mail" ? { ...r, user: by } : r.kind === "calendar" ? { ...r, tz: calPrefs(by).tz } : r);
  if (!s) return { error: "invalid" };
  const key = sourceKey(s);
  const existing = sourceOf(ws, key);
  if (existing) {
    // The same number someone already counts: theirs stays (one author, one value); it is
    // shared only with a person who would count exactly the same.
    if (!canSee(ws, existing, by)) return { error: "forbidden" };
    const cur = sql("SELECT value FROM dz_metrics WHERE ws = ? AND key = ?").get(ws, key) as { value: number } | undefined;
    return { key, value: cur?.value ?? null, label: existing.label };
  }
  const value = valueFor(ws, s, by);
  if (value === null) return { error: "forbidden" };
  const n = sql("SELECT COUNT(*) AS n FROM dz_sources WHERE ws = ?").get(ws) as { n: number };
  if (Number(n.n) >= MAX_SOURCES) return { error: "limit" };
  // A few numbers per database or project are plenty; many would only cost every edit there.
  const same = s.kind === "docs" ? `"db":"${s.db}"` : s.kind === "project" ? `"project":"${s.project}"` : s.kind === "calendar" ? `"cal":"${s.cal}"` : `"user":"${s.user}"`;
  if (Number((sql("SELECT COUNT(*) AS n FROM dz_sources WHERE ws = ? AND instr(json, ?) > 0").get(ws, same) as { n: number }).n) >= PER_OBJECT) return { error: "limit" };
  const label = describe(ws, s, by);
  sql("INSERT INTO dz_sources (ws, key, json, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(ws, key, JSON.stringify(s), label, by, Date.now());
  st.byWs.delete(ws);
  putMetric(ws, key, value, label || null, "source");
  return { key, value, label };
}

/** Sources nobody's goal uses any more (and their numbers) go after an hour. */
export function pruneSources(now = Date.now()): number {
  schema();
  const old = sql("SELECT ws, key FROM dz_sources WHERE created_at < ?").all(now - 3600_000) as { ws: string; key: string }[];
  let n = 0;
  for (const r of old) {
    const used = sql("SELECT 1 FROM dz_reactions WHERE ws = ? AND instr(json, ?) > 0").get(r.ws, `"key":"${r.key}"`);
    if (used) continue;
    sql("DELETE FROM dz_sources WHERE ws = ? AND key = ?").run(r.ws, r.key);
    sql("DELETE FROM dz_metrics WHERE ws = ? AND key = ?").run(r.ws, r.key);
    st.byWs.delete(r.ws);
    n++;
  }
  return n;
}

/** Computes a source again (as its author) and puts its number on the pulse when it moved. */
export function refresh(ws: string, row: SourceRow): void {
  const value = valueFor(ws, row.source, row.by);
  if (value === null) return;
  const cur = sql("SELECT value FROM dz_metrics WHERE ws = ? AND key = ?").get(ws, row.key) as { value: number } | undefined;
  if (cur && cur.value === value) return;
  putMetric(ws, row.key, value, row.label || null, "source");
}

const SETTLE_MS = 400;

/**
 * Recomputes soon: a burst of edits (typing in a cell, a bulk move) is one
 * computation, and the sources of a workspace are computed together, each
 * database's rows read once.
 */
function soon(ws: string, row: SourceRow): void {
  let p = st.pending.get(ws);
  if (!p) st.pending.set(ws, (p = new Map()));
  p.set(row.key, row);
  const t = st.timers.get(ws);
  if (t) clearTimeout(t);
  st.timers.set(
    ws,
    setTimeout(() => {
      st.timers.delete(ws);
      const rows = [...(st.pending.get(ws)?.values() ?? [])];
      st.pending.delete(ws);
      st.batch = new Map();
      try {
        for (const r of rows) {
          try {
            refresh(ws, r);
          } catch {
            // Retried on the next change.
          }
        }
      } finally {
        st.batch = null;
      }
    }, SETTLE_MS)
  );
}

/** Which databases a Documents change touches: the pages themselves and their parents (a row's database). */
function touchedNotes(ws: string, ids: string[]): { ids: Set<string>; unknown: boolean } {
  const out = new Set<string>();
  let unknown = false;
  for (const id of ids.slice(0, 50)) {
    out.add(id);
    const n = loadNote(ws, id);
    if (!n) unknown = true;
    else if (n.parentId) out.add(n.parentId);
  }
  return { ids: out, unknown };
}

function onPulse(e: PulseEvent): void {
  if (e.type === "calendar" || e.type === "mail") {
    // A calendar's events moved (ref = the calendar), or someone's mail did (ref = its owner).
    if (!e.ref) return;
    let list: SourceRow[];
    try {
      list = sourcesOf(e.ws);
    } catch {
      return;
    }
    for (const row of list) {
      const s = row.source;
      if ((e.type === "calendar" && s.kind === "calendar" && s.cal === e.ref) || (e.type === "mail" && s.kind === "mail" && s.user === e.ref)) soon(e.ws, row);
    }
    return;
  }
  if (e.type !== "notes") return;
  let list: SourceRow[];
  try {
    list = sourcesOf(e.ws).filter((s) => s.source.kind === "docs");
  } catch {
    return;
  }
  if (!list.length) return;
  const { ids, unknown } = touchedNotes(e.ws, e.ref ? [e.ref] : (e.refs ?? []));
  // Each database is read once per event, however many sources count it.
  const data = new Map<string, { id: string; all: boolean } | null>();
  for (const row of list) {
    const s = row.source as Extract<Source, { kind: "docs" }>;
    const vk = `${s.db}|${s.view ?? ""}`;
    if (!data.has(vk)) {
      const d = dataOf(e.ws, s);
      data.set(vk, d ? { id: d.data.id, all: hasComputed(d.data.db) } : null);
    }
    const d = data.get(vk);
    // A page deleted for good says nothing about its parent; formulas may read any page.
    if (unknown || ids.has(s.db) || (d && (d.all || ids.has(d.id)))) soon(e.ws, row);
  }
}

/** Counts again the numbers the clock moves (a calendar window, snoozed mail); hub.ts calls it every few minutes. */
export function refreshTimed(): number {
  schema();
  const rows = sql("SELECT DISTINCT ws FROM dz_sources WHERE json LIKE '%\"kind\":\"calendar\"%' OR json LIKE '%\"kind\":\"mail\"%' LIMIT 2000").all() as { ws: string }[];
  let n = 0;
  for (const r of rows) {
    for (const row of sourcesOf(r.ws)) {
      if (!TIMED_KINDS.has(row.source.kind)) continue;
      soon(r.ws, row);
      n++;
    }
  }
  return n;
}

/** Starts keeping the sources current (once per process; lib/decide/hub.ts). */
export function startSources(): void {
  if (st.started) return;
  st.started = true;
  listenAll(onPulse);
  onChange((c) => {
    // A project's counts moved (lib/projects/goals.ts announces every move).
    if (c.entity !== "project" && c.entity !== "issue") return;
    let list: SourceRow[];
    try {
      list = sourcesOf(c.ws).filter((s) => s.source.kind === "project");
    } catch {
      return;
    }
    if (!list.length) return;
    const project =
      c.entity === "project" ? c.id : ((sql("SELECT project_id FROM pj_issues WHERE id = ? AND ws_id = ?").get(c.id, c.ws) as { project_id: string | null } | undefined)?.project_id ?? null);
    // An issue that moved out of a project changes that project too: its numbers are counted again on the project's own change.
    for (const row of list) if ((row.source as Extract<Source, { kind: "project" }>).project === project) soon(c.ws, row);
  });
  // A source's number reaches only people who may see what it counts.
  registerPulseFilter("metric", (userId, e) => {
    if (!e.ref) return true;
    const row = sourceOf(e.ws, e.ref);
    return row ? canSee(e.ws, row, userId) : true;
  });
}

/** The workspace's numbers this person may see (typed and pushed ones, and sources they can read). */
export function visibleMetrics<T extends { key: string }>(ws: string, userId: string, metrics: T[]): T[] {
  const sources = new Map(sourcesOf(ws).map((s) => [s.key, s]));
  return metrics.filter((m) => {
    const s = sources.get(m.key);
    return !s || canSee(ws, s, userId);
  });
}

/** Forgets who may see which number (tests; an access change is otherwise picked up within SEEN_MS). */
export function forgetSeen(): void {
  st.seen.clear();
}

/** Test hook. */
export function resetSources(): void {
  for (const t of st.timers.values()) clearTimeout(t);
  st.timers.clear();
  st.pending.clear();
  st.seen.clear();
  st.byWs.clear();
  st.db = null;
}

export interface DatabaseChoice {
  id: string;
  title: string;
  views: { id: string; name: string; type: string; chart?: { fn: DocsFn; prop?: string } }[];
  props: { id: string; name: string; type: string; options?: { id: string; name: string }[] }[];
}

/** The databases a person may count from (for the goal's "number from a database" picker), with the columns they may read. */
export function databasesFor(ws: string, userId: string, limit = 100): DatabaseChoice[] {
  const acc = new AccessResolver(ws, userId);
  if (!acc.role) return [];
  const rows = sql("SELECT json FROM notes WHERE ws = ? AND deleted = 0 AND json LIKE '%\"kind\":\"database\"%' ORDER BY stamp DESC LIMIT 500").all(ws) as { json: string | null }[];
  const out: DatabaseChoice[] = [];
  for (const r of rows) {
    let n: Note | null = null;
    try {
      n = r.json ? sanitizeNote(JSON.parse(r.json)) : null;
    } catch {
      n = null;
    }
    if (!n?.db || n.kind !== "database" || n.template || n.synced || n.db.dataSource || acc.level(n.id) === null || inTrash(ws, n)) continue;
    const props = readableProps(n, acc);
    out.push({
      id: n.id,
      title: n.title,
      views: n.db.views
        .filter((v) => !v.source || v.source === n!.id)
        .map((v) => {
          const fn = DOCS_FNS.find((f) => f === v.chart?.y?.fn);
          return { id: v.id, name: v.name, type: v.type, ...(v.type === "chart" ? { chart: { fn: fn ?? "count", ...(fn && fn !== "count" && v.chart?.y?.prop ? { prop: v.chart.y.prop } : {}) } } : {}) };
        }),
      props: props
        .filter((p) => NUMERIC.has(p.type) || p.type === "select" || p.type === "status" || p.type === "checkbox")
        .map((p) => ({ id: p.id, name: p.name, type: p.type, ...(p.options ? { options: p.options.map((o) => ({ id: o.id, name: o.name })) } : {}) })),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** What a chart view of a database adds up (its Y), or null when the view is no chart. */
export function chartSpec(ws: string, db: string, view: string): { fn: DocsFn; prop?: string; name: string } | null {
  const host = loadNote(ws, db);
  const v = host?.db?.views.find((x) => x.id === view);
  if (!v || v.type !== "chart") return null;
  const fn = DOCS_FNS.find((f) => f === v.chart?.y?.fn) ?? "count";
  const prop = fn !== "count" ? v.chart?.y?.prop : undefined;
  if (fn !== "count" && !prop) return { fn: "count", name: v.name };
  return { fn, ...(prop ? { prop } : {}), name: v.name };
}
