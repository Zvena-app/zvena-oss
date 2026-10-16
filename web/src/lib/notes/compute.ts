// zvena Documents computed properties: formulas, relations (the related pages'
// titles) and rollups. Values are computed when rows are read and kept in
// `row.computed`, never stored or synced.

import { evalFormula, formulaProps, FormulaError, parseDateText, parseFormula, toText, dateText, unknownFunctions, type FDate, type FNode, type FValue } from "./formula";
import { personName } from "./people";
import { isDateValue, isPlaceValue, type DateValue, type DbProperty, type DbSchema, type Note, type PropValue, type RollupFn } from "./types";
import { isVerification, verificationState } from "./verification";

/** "url#bn=<name>": a file property item keeps its display name in the link. */
export function fileItem(url: string, name: string): string {
  return `${url}#bn=${encodeURIComponent(name.slice(0, 300))}`;
}

export function parseFileItem(item: string): { url: string; name: string } {
  const i = item.lastIndexOf("#bn=");
  if (i < 0) {
    const tail = item.split(/[?#]/)[0].split("/").pop() ?? item;
    let name = tail;
    try {
      name = decodeURIComponent(tail);
    } catch {
      // keep as is
    }
    return { url: item, name: name || item };
  }
  let name = item.slice(i + 4);
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep as is
  }
  return { url: item.slice(0, i), name };
}

const parsed = new Map<string, FNode | FormulaError>();

/** A parsed formula (cached), or the parse error. */
export function compileFormula(expr: string): FNode | FormulaError {
  let hit = parsed.get(expr);
  if (!hit) {
    try {
      hit = parseFormula(expr);
    } catch (e) {
      hit = e instanceof FormulaError ? e : new FormulaError(String(e));
    }
    if (parsed.size > 500) parsed.clear();
    parsed.set(expr, hit);
  }
  return hit;
}

/** What is wrong with a formula before running it: syntax, unknown props or functions. */
export function formulaIssue(expr: string, schema: DbSchema, selfId?: string): string | null {
  if (!expr.trim()) return null;
  const ast = compileFormula(expr);
  if (ast instanceof FormulaError) return ast.message;
  for (const name of formulaProps(ast)) {
    const p = findProp(schema, name);
    if (!p) return `Unknown property "${name}"`;
    if (p.id === selfId) return "A formula cannot use itself";
  }
  const fns = unknownFunctions(ast);
  if (fns.length) return `Unknown function "${fns[0]}"`;
  return null;
}

export function findProp(schema: DbSchema, name: string): DbProperty | undefined {
  return schema.properties.find((p) => p.name === name) ?? schema.properties.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
}

export function hasComputed(schema: DbSchema | undefined): boolean {
  return Boolean(schema?.properties.some((p) => p.type === "formula" || p.type === "rollup" || p.type === "relation"));
}

interface Ctx {
  byId: ReadonlyMap<string, Note>;
  now: number;
  locale: string;
  memo: Map<string, FValue | FormulaError>;
}

/** Present and not in the trash — itself or through its database or a parent page (only a trashed subtree's root carries trashedAt). */
function alive(n: Note | undefined, byId: ReadonlyMap<string, Note>): n is Note {
  for (let cur = n, depth = 0; cur && depth < 100; cur = cur.parentId ? byId.get(cur.parentId) : undefined, depth++) {
    if (cur.trashedAt !== null) return false;
  }
  return Boolean(n);
}

/** Ids a relation cell points to (stored), ignoring trashed or missing rows. */
export function relationIds(row: Note, prop: DbProperty, byId?: ReadonlyMap<string, Note>): string[] {
  const v = row.props?.[prop.id];
  const ids = Array.isArray(v) ? v : [];
  return byId ? ids.filter((id) => alive(byId.get(id), byId)) : ids;
}

function toFDate(d: DateValue): FDate | null {
  const s = parseDateText(d.start);
  if (!s) return null;
  const e = d.end ? parseDateText(d.end) : null;
  return { ...s, ...(e ? { end: e.start } : {}), time: s.time || Boolean(e?.time) };
}

/** A row's property as a formula value. */
function fvalue(row: Note, prop: DbProperty, schema: DbSchema, ctx: Ctx, stack: string[]): FValue {
  const v = row.props?.[prop.id] ?? null;
  switch (prop.type) {
    case "title":
      return row.title;
    case "text":
    case "url":
    case "email":
    case "phone":
      return typeof v === "string" ? v : v === null ? "" : String(v);
    case "number":
    case "unique_id":
      return typeof v === "number" ? v : null;
    case "checkbox":
      return v === true;
    case "select":
    case "status":
      return (typeof v === "string" && prop.options?.find((o) => o.id === v)?.name) || "";
    case "multi_select":
      return (Array.isArray(v) ? v : []).map((id) => prop.options?.find((o) => o.id === id)?.name ?? "").filter(Boolean);
    case "date":
      return isDateValue(v) ? toFDate(v) : null;
    case "created_time":
      return { kind: "date", start: row.createdAt, time: true };
    case "last_edited_time":
      return { kind: "date", start: row.updatedAt, time: true };
    case "files":
      return (Array.isArray(v) ? v : []).map((x) => parseFileItem(x).name);
    case "relation":
      return relationIds(row, prop, ctx.byId).map((id) => ctx.byId.get(id)?.title ?? "");
    case "rollup":
      return rollupValue(row, prop, schema, ctx, stack);
    case "formula":
      return formulaValue(row, prop, schema, ctx, stack);
    case "person":
      return (Array.isArray(v) ? v : []).map((id) => personName(id)).filter(Boolean);
    case "created_by":
      return personName(row.createdBy);
    case "last_edited_by":
      return personName(row.editedBy);
    case "place":
      return isPlaceValue(v) ? v.name : "";
    // A wiki page's verification as Notion's formulas see it: "verified", "expired" or "unverified".
    case "verification":
      return verificationState(v);
    case "button":
      return null;
  }
}

function formulaValue(row: Note, prop: DbProperty, schema: DbSchema, ctx: Ctx, stack: string[]): FValue {
  const key = `${row.id}:${prop.id}`;
  const hit = ctx.memo.get(key);
  if (hit !== undefined) {
    if (hit instanceof FormulaError) throw hit;
    return hit;
  }
  if (stack.includes(key)) throw new FormulaError("Circular reference");
  const expr = prop.formula?.expr ?? "";
  if (!expr.trim()) return null;
  const ast = compileFormula(expr);
  if (ast instanceof FormulaError) throw ast;
  const next = [...stack, key];
  let out: FValue | FormulaError;
  try {
    out = evalFormula(ast, {
      id: row.id,
      now: ctx.now,
      locale: ctx.locale,
      prop: (name) => {
        const p = findProp(schema, name);
        if (!p) throw new FormulaError(`Unknown property "${name}"`);
        return fvalue(row, p, schema, ctx, next);
      },
    });
  } catch (e) {
    out = e instanceof FormulaError ? e : new FormulaError(e instanceof Error ? e.message : String(e));
  }
  ctx.memo.set(key, out);
  if (out instanceof FormulaError) throw out;
  return out;
}

const isFDate = (v: FValue): v is FDate => typeof v === "object" && v !== null && !Array.isArray(v) && v.kind === "date";
const emptyF = (v: FValue) => v === null || v === "" || (Array.isArray(v) && v.length === 0);

function rollupValue(row: Note, prop: DbProperty, schema: DbSchema, ctx: Ctx, stack: string[]): FValue {
  const cfg = prop.rollup;
  if (!cfg) return null;
  const key = `${row.id}:${prop.id}`;
  // Remembered like formulas: a rollup over itself through a relation would
  // otherwise walk every path between the linked rows (and freeze the tab).
  const hit = ctx.memo.get(key);
  if (hit !== undefined) {
    if (hit instanceof FormulaError) throw hit;
    return hit;
  }
  if (stack.includes(key)) throw new FormulaError("Circular reference");
  const rel = schema.properties.find((p) => p.id === cfg.relationPropId && p.type === "relation");
  if (!rel?.relation) return null;
  const targetDb = ctx.byId.get(rel.relation.dbId);
  const tSchema = targetDb?.db;
  const tProp = tSchema?.properties.find((p) => p.id === cfg.targetPropId);
  if (!tSchema || !tProp) return null;
  const rows = relationIds(row, rel, ctx.byId).map((id) => ctx.byId.get(id) as Note);
  const next = [...stack, key];
  const vals = rows.map((r) => {
    try {
      return fvalue(r, tProp, tSchema, ctx, next);
    } catch {
      return null;
    }
  });
  const out = aggregate(cfg.fn, vals, tProp);
  ctx.memo.set(key, out);
  return out;
}

/** A rollup over the related rows' values. */
export function aggregate(fn: RollupFn, vals: FValue[], target: DbProperty): FValue {
  const flat = vals.flatMap((v) => (Array.isArray(v) ? v : [v]));
  // Checkboxes count as "empty" when unchecked (Notion).
  const empty = (v: FValue) => emptyF(v) || (target.type === "checkbox" && v === false);
  const nums = flat.filter((v): v is number => typeof v === "number");
  const dates = flat.filter(isFDate);
  const n = vals.length;
  const uniq = (list: FValue[]) => {
    const seen = new Set<string>();
    return list.filter((v) => {
      const k = isFDate(v) ? `d${v.start}` : `${typeof v}:${toText(v)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  switch (fn) {
    case "show_original":
      return flat.filter((v) => !emptyF(v));
    case "show_unique":
      return uniq(flat.filter((v) => !emptyF(v)));
    case "count":
      return n;
    case "count_values":
      return flat.filter((v) => !empty(v)).length;
    case "count_unique":
      return uniq(flat.filter((v) => !empty(v))).length;
    case "count_empty":
      return vals.filter(empty).length;
    case "count_not_empty":
      return vals.filter((v) => !empty(v)).length;
    case "percent_empty":
      return n ? vals.filter(empty).length / n : null;
    case "percent_not_empty":
      return n ? vals.filter((v) => !empty(v)).length / n : null;
    case "sum":
      return nums.reduce((s, x) => s + x, 0);
    case "average":
      return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
    case "median": {
      if (!nums.length) return null;
      const s = [...nums].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
    case "range":
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    case "earliest": {
      if (!dates.length) return null;
      const d = dates.reduce((a, b) => (b.start < a.start ? b : a));
      return { kind: "date", start: d.start, time: d.time };
    }
    case "latest": {
      if (!dates.length) return null;
      const d = dates.reduce((a, b) => ((b.end ?? b.start) > (a.end ?? a.start) ? b : a));
      return { kind: "date", start: d.end ?? d.start, time: d.time };
    }
    case "date_range": {
      if (!dates.length) return null;
      const lo = Math.min(...dates.map((d) => d.start));
      const hi = Math.max(...dates.map((d) => d.end ?? d.start));
      return { kind: "date", start: lo, ...(hi !== lo ? { end: hi } : {}), time: dates.some((d) => d.time) };
    }
    case "checked":
      return flat.filter((v) => v === true).length;
    case "unchecked":
      return flat.filter((v) => v === false).length;
    case "percent_checked":
      return n ? flat.filter((v) => v === true).length / n : null;
    case "percent_unchecked":
      return n ? flat.filter((v) => v === false).length / n : null;
  }
}

/** Rollup functions that make sense for a target property type. */
export function rollupFnsFor(target: DbProperty | undefined): RollupFn[] {
  const base: RollupFn[] = ["show_original", "show_unique", "count", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"];
  if (!target) return base;
  if (target.type === "number" || target.type === "formula" || target.type === "rollup") base.push("sum", "average", "median", "min", "max", "range");
  if (target.type === "date" || target.type === "created_time" || target.type === "last_edited_time" || target.type === "formula" || target.type === "rollup") base.push("earliest", "latest", "date_range");
  if (target.type === "checkbox" || target.type === "formula") base.push("checked", "unchecked", "percent_checked", "percent_unchecked");
  return base;
}

/** A formula value as a stored-shape value (dates as "YYYY-MM-DD[THH:mm]"). */
export function toPropValue(v: FValue, locale = "en"): PropValue {
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.filter((x) => !emptyF(x)).map((x) => toText(x, locale));
  return { start: dateText(v.start, v.time), ...(v.end !== undefined ? { end: dateText(v.end, v.time) } : {}) };
}

function ctxOf(byId: ReadonlyMap<string, Note>, locale: string, now: number): Ctx {
  return { byId, locale, now, memo: new Map() };
}

function computeOne(row: Note, schema: DbSchema, ctx: Ctx): Note {
  const computed: Record<string, PropValue> = {};
  for (const p of schema.properties) {
    if (p.type !== "formula" && p.type !== "rollup" && p.type !== "relation") continue;
    try {
      computed[p.id] = toPropValue(fvalue(row, p, schema, ctx, []), ctx.locale);
    } catch {
      computed[p.id] = null;
    }
  }
  return { ...row, computed };
}

/** Rows with their computed values (formulas, rollups, relation titles). */
export function computeRows(rows: Note[], schema: DbSchema | undefined, byId: ReadonlyMap<string, Note>, locale = "en", now = Date.now()): Note[] {
  if (!schema || !hasComputed(schema)) return rows;
  const ctx = ctxOf(byId, locale, now);
  return rows.map((r) => computeOne(r, schema, ctx));
}

/** One row (a row page) with its computed values. */
export function computeRow(row: Note, byId: ReadonlyMap<string, Note>, locale = "en", now = Date.now()): Note {
  const schema = row.parentId ? byId.get(row.parentId)?.db : undefined;
  if (!schema || !hasComputed(schema)) return row;
  return computeOne(row, schema, ctxOf(byId, locale, now));
}

/** A formula's value for one row, or its error (the editor preview). */
export function previewFormula(expr: string, row: Note | undefined, schema: DbSchema, byId: ReadonlyMap<string, Note>, locale = "en"): { value: PropValue; error: string | null } {
  const issue = formulaIssue(expr, schema);
  if (issue) return { value: null, error: issue };
  if (!row || !expr.trim()) return { value: null, error: null };
  const prop: DbProperty = { id: "__preview", name: "", type: "formula", formula: { expr } };
  const ctx = ctxOf(byId, locale, Date.now());
  try {
    return { value: toPropValue(fvalue(row, prop, { ...schema, properties: [...schema.properties, prop] }, ctx, []), locale), error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A table footer calculation over a column (the same math as rollups). */
export function calcColumn(fn: RollupFn, rows: Note[], prop: DbProperty, byId: ReadonlyMap<string, Note>, locale = "en"): PropValue {
  const schema: DbSchema = { properties: [prop], views: [] };
  const ctx = ctxOf(byId, locale, Date.now());
  const vals = rows.map((r): FValue => {
    if (prop.type === "formula" || prop.type === "rollup" || prop.type === "relation") return fromPropValue(r.computed?.[prop.id] ?? null);
    try {
      return fvalue(r, prop, schema, ctx, []);
    } catch {
      return null;
    }
  });
  return toPropValue(aggregate(fn, vals, prop), locale);
}

/** A stored-shape value back into a formula value (computed cells). */
function fromPropValue(v: PropValue): FValue {
  if (v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v;
  if (isPlaceValue(v)) return v.name;
  if (isVerification(v)) return verificationState(v);
  return toFDate(v);
}

/** Calculations offered for a column type (Notion's footer menu). */
export function calcFnsFor(prop: DbProperty): RollupFn[] {
  // A button has no values to count.
  if (prop.type === "button") return [];
  return rollupFnsFor(prop).filter((f) => f !== "show_original" && f !== "show_unique");
}

/**
 * Unique ID fixes for a database: rows without a number (new, imported,
 * duplicated) get the next ones in creation order; numbers are never reused.
 */
export function uniqueIdFixes(rows: Note[], prop: DbProperty): { id: string; n: number }[] {
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
  let max = 0;
  for (const r of sorted) {
    const v = r.props?.[prop.id];
    if (typeof v === "number" && v > max) max = v;
  }
  const seen = new Set<number>();
  const out: { id: string; n: number }[] = [];
  for (const r of sorted) {
    const v = r.props?.[prop.id];
    if (typeof v === "number" && v > 0 && !seen.has(v)) {
      seen.add(v);
      continue;
    }
    max += 1;
    seen.add(max);
    out.push({ id: r.id, n: max });
  }
  return out;
}
