// Server-only: POST /databases/{id}/query — Notion's filter and sort objects
// evaluated over a database's rows (computed values included).

import { localYmd } from "../dates";
import { parseFileItem, relationIds } from "../compute";
import { isDateValue, isPlaceValue, type DbProperty, type DbSchema, type Note, type PropValue } from "../types";
import { cleanDate, InputError, noteIdOf } from "./richtext";
import { findProperty } from "./properties";
import { verificationState } from "../verification";

type Cond = Record<string, unknown>;

const DAY = 86_400_000;

/** A row's value for filtering: text, number, boolean, date (ms), list of strings, or null. */
type Val = string | number | boolean | string[] | null;

function dateMs(v: PropValue | undefined | string): number | null {
  const s = typeof v === "string" ? v : isDateValue(v) ? v.start : null;
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function textOf(row: Note, p: DbProperty, names: (id: string) => string): string {
  const v = row.props?.[p.id];
  switch (p.type) {
    case "title":
      return row.title;
    case "select":
    case "status":
      return p.options?.find((o) => o.id === v)?.name ?? "";
    case "place":
      return isPlaceValue(v) ? `${v.name} ${v.address ?? ""}`.trim() : "";
    case "person":
      return (Array.isArray(v) ? v : []).map(names).join(", ");
    default:
      return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  }
}

function listOf(row: Note, p: DbProperty): string[] {
  const v = row.props?.[p.id];
  if (p.type === "multi_select") return (Array.isArray(v) ? v : []).map((id) => p.options?.find((o) => o.id === id)?.name ?? "").filter(Boolean);
  if (p.type === "relation") return relationIds(row, p);
  if (p.type === "person") return Array.isArray(v) ? v : [];
  if (p.type === "files") return (Array.isArray(v) ? v : []).map((x) => parseFileItem(x).name);
  if (p.type === "created_by") return row.createdBy ? [row.createdBy] : [];
  if (p.type === "last_edited_by") return row.editedBy ?? row.createdBy ? [String(row.editedBy ?? row.createdBy)] : [];
  return [];
}

function textCond(s: string, c: Cond): boolean {
  const low = s.toLowerCase();
  const want = typeof c.equals === "string" ? c.equals : typeof c.does_not_equal === "string" ? c.does_not_equal : typeof c.contains === "string" ? c.contains : typeof c.does_not_contain === "string" ? c.does_not_contain : typeof c.starts_with === "string" ? c.starts_with : typeof c.ends_with === "string" ? c.ends_with : "";
  const w = want.toLowerCase();
  if ("equals" in c) return s === c.equals;
  if ("does_not_equal" in c) return s !== c.does_not_equal;
  if ("contains" in c) return low.includes(w);
  if ("does_not_contain" in c) return !low.includes(w);
  if ("starts_with" in c) return low.startsWith(w);
  if ("ends_with" in c) return low.endsWith(w);
  if (c.is_empty === true) return s === "";
  if (c.is_not_empty === true) return s !== "";
  throw new InputError("unknown text filter condition");
}

function numberCond(n: number | null, c: Cond): boolean {
  if (c.is_empty === true) return n === null;
  if (c.is_not_empty === true) return n !== null;
  const want = Number(Object.values(c)[0]);
  if (n === null) return "does_not_equal" in c;
  if ("equals" in c) return n === want;
  if ("does_not_equal" in c) return n !== want;
  if ("greater_than" in c) return n > want;
  if ("less_than" in c) return n < want;
  if ("greater_than_or_equal_to" in c) return n >= want;
  if ("less_than_or_equal_to" in c) return n <= want;
  throw new InputError("unknown number filter condition");
}

function dateCond(ms: number | null, c: Cond, now: number): boolean {
  if (c.is_empty === true) return ms === null;
  if (c.is_not_empty === true) return ms !== null;
  if (ms === null) return false;
  const day = (t: number) => localYmd(new Date(t));
  const at = (v: unknown): number => {
    const s = cleanDate(v);
    if (!s) throw new InputError("a date filter needs an ISO 8601 date");
    return dateMs(s) as number;
  };
  if ("equals" in c) return day(ms) === day(at(c.equals));
  if ("before" in c) return ms < at(c.before);
  if ("after" in c) return ms > at(c.after) && day(ms) !== day(at(c.after));
  if ("on_or_before" in c) return ms <= at(c.on_or_before) || day(ms) === day(at(c.on_or_before));
  if ("on_or_after" in c) return ms >= at(c.on_or_after) || day(ms) === day(at(c.on_or_after));
  const span = (days: number, forward: boolean) => (forward ? ms >= now && ms <= now + days * DAY : ms <= now && ms >= now - days * DAY);
  if ("past_week" in c) return span(7, false);
  if ("past_month" in c) return span(30, false);
  if ("past_year" in c) return span(365, false);
  if ("next_week" in c) return span(7, true);
  if ("next_month" in c) return span(30, true);
  if ("next_year" in c) return span(365, true);
  if ("this_week" in c) {
    const d = new Date(now);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    return ms >= start && ms < start + 7 * DAY;
  }
  throw new InputError("unknown date filter condition");
}

function listCond(list: string[], c: Cond, normalize: (s: string) => string = (s) => s): boolean {
  if (c.is_empty === true) return list.length === 0;
  if (c.is_not_empty === true) return list.length > 0;
  if ("contains" in c) return list.map(normalize).includes(normalize(String(c.contains)));
  if ("does_not_contain" in c) return !list.map(normalize).includes(normalize(String(c.does_not_contain)));
  throw new InputError("unknown list filter condition");
}

function valueCond(v: Val, c: Cond, now: number): boolean {
  // A formula / rollup condition names its result type.
  if (typeof c.string === "object" && c.string) return textCond(typeof v === "string" ? v : v === null ? "" : String(v), c.string as Cond);
  if (typeof c.number === "object" && c.number) return numberCond(typeof v === "number" ? v : null, c.number as Cond);
  if (typeof c.checkbox === "object" && c.checkbox) return (c.checkbox as Cond).equals === undefined ? (c.checkbox as Cond).does_not_equal !== (v === true) : (c.checkbox as Cond).equals === (v === true);
  if (typeof c.date === "object" && c.date) return dateCond(typeof v === "number" ? v : null, c.date as Cond, now);
  throw new InputError("formula and rollup filters need string, number, checkbox or date");
}

function computedVal(v: PropValue | undefined): Val {
  if (v === undefined || v === null) return null;
  if (isDateValue(v)) return dateMs(v);
  if (isPlaceValue(v)) return v.name;
  return v as Val;
}

const uuidless = (s: string) => noteIdOf(s) ?? s;

function propertyMatches(row: Note, p: DbProperty, f: Cond, now: number, names: (id: string) => string): boolean {
  const v = row.props?.[p.id];
  const key = Object.keys(f).find((k) => k !== "property" && k !== "type") ?? "";
  const c = (typeof f[key] === "object" && f[key] !== null ? f[key] : {}) as Cond;
  switch (key) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number":
    case "select":
    case "status":
    case "place":
      return textCond(textOf(row, p, names), c);
    case "number":
      return numberCond(typeof v === "number" ? v : null, c);
    case "unique_id":
      return numberCond(typeof v === "number" ? v : null, c);
    case "checkbox":
      return "does_not_equal" in c ? (v === true) !== c.does_not_equal : (v === true) === c.equals;
    case "date":
      return dateCond(p.type === "created_time" ? row.createdAt : p.type === "last_edited_time" ? row.updatedAt : dateMs(v), c, now);
    case "created_time":
      return dateCond(row.createdAt, c, now);
    case "last_edited_time":
      return dateCond(row.updatedAt, c, now);
    case "multi_select":
      return listCond(listOf(row, p), c);
    case "relation":
    case "people":
    case "created_by":
    case "last_edited_by":
      return listCond(listOf(row, p), c, uuidless);
    case "files":
      return listCond(listOf(row, p), c);
    // Notion's verification filter: { status: "verified" | "expired" | "none" }.
    case "verification": {
      const s = verificationState(v);
      const want = c.status === "none" ? "unverified" : c.status;
      return typeof want === "string" ? s === want : true;
    }
    case "formula":
      return valueCond(computedVal(row.computed?.[p.id]), c, now);
    case "rollup": {
      const r = row.computed?.[p.id];
      const arr = Array.isArray(r) ? r : null;
      for (const q of ["any", "every", "none"] as const) {
        if (typeof c[q] !== "object" || !c[q]) continue;
        const inner = c[q] as Cond;
        const items = (arr ?? (r === null || r === undefined ? [] : [String(r)])).map((x) => String(x));
        const hit = (s: string) => (typeof inner.rich_text === "object" ? textCond(s, inner.rich_text as Cond) : typeof inner.number === "object" ? numberCond(Number(s), inner.number as Cond) : textCond(s, inner as Cond));
        if (q === "any") return items.some(hit);
        if (q === "every") return items.every(hit);
        return !items.some(hit);
      }
      return valueCond(computedVal(r), c, now);
    }
    default:
      throw new InputError(`filter on ${p.name} needs a condition for its type`);
  }
}

/** Whether a row passes a Notion filter object (compound and/or up to 2 levels). */
export function matches(row: Note, schema: DbSchema, f: unknown, now: number, names: (id: string) => string, depth = 0): boolean {
  if (f === undefined || f === null) return true;
  if (typeof f !== "object" || Array.isArray(f)) throw new InputError("filter should be an object");
  const r = f as Cond;
  if (Array.isArray(r.and) || Array.isArray(r.or)) {
    if (depth > 2) throw new InputError("filters may be nested 2 levels deep");
    const list = (r.and ?? r.or) as unknown[];
    if (list.length > 100) throw new InputError("at most 100 filters in a group");
    return Array.isArray(r.and) ? list.every((x) => matches(row, schema, x, now, names, depth + 1)) : list.some((x) => matches(row, schema, x, now, names, depth + 1));
  }
  if (r.timestamp === "created_time" || r.timestamp === "last_edited_time") {
    const c = (r[r.timestamp] ?? {}) as Cond;
    return dateCond(r.timestamp === "created_time" ? row.createdAt : row.updatedAt, c, now);
  }
  if (typeof r.property !== "string") throw new InputError("a filter needs a property (or and / or / timestamp)");
  const p = findProperty(schema, r.property);
  if (!p) throw new InputError(`${r.property} is not a property that exists`);
  return propertyMatches(row, p, r, now, names);
}

function sortKey(row: Note, p: DbProperty, names: (id: string) => string): string | number | null {
  const v = row.props?.[p.id];
  switch (p.type) {
    case "number":
    case "unique_id":
      return typeof v === "number" ? v : null;
    case "checkbox":
      return v === true ? 1 : 0;
    case "date":
      return dateMs(v);
    case "created_time":
      return row.createdAt;
    case "last_edited_time":
      return row.updatedAt;
    case "select":
    case "status": {
      // Options sort in their order, as in Notion.
      const i = p.options?.findIndex((o) => o.id === v) ?? -1;
      return i < 0 ? null : i;
    }
    case "formula":
    case "rollup": {
      const c = computedVal(row.computed?.[p.id]);
      return typeof c === "number" ? c : c === null ? null : String(c);
    }
    case "created_by":
      return names(row.createdBy ?? "");
    case "last_edited_by":
      return names(row.editedBy ?? row.createdBy ?? "");
    default:
      return textOf(row, p, names) || null;
  }
}

const collator = new Intl.Collator(["ru", "en"], { sensitivity: "base", numeric: true });

/** Rows in the order of Notion sort objects (empty values last), stable. */
export function sortRows(rows: Note[], schema: DbSchema, sorts: unknown, names: (id: string) => string): Note[] {
  if (sorts === undefined) return rows;
  if (!Array.isArray(sorts) || sorts.length > 100) throw new InputError("sorts should be an array (at most 100)");
  const keys = sorts.map((s) => {
    const r = (typeof s === "object" && s !== null ? s : {}) as Cond;
    const dir = r.direction === "descending" ? -1 : 1;
    if (r.timestamp === "created_time" || r.timestamp === "last_edited_time") return { dir, get: (n: Note) => (r.timestamp === "created_time" ? n.createdAt : n.updatedAt) as string | number | null };
    const p = typeof r.property === "string" ? findProperty(schema, r.property) : undefined;
    if (!p) throw new InputError("a sort needs an existing property or a timestamp");
    return { dir, get: (n: Note) => sortKey(n, p, names) };
  });
  return rows
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      for (const k of keys) {
        const x = k.get(a.n);
        const y = k.get(b.n);
        if (x === y) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
        if (c !== 0) return c * k.dir;
      }
      return a.i - b.i;
    })
    .map((x) => x.n);
}

// --- Cursors ----------------------------------------------------------------------

/** An opaque cursor (an offset into the result list). */
export function cursorAt(offset: number): string {
  return Buffer.from(`o:${offset}`).toString("base64url");
}

export function offsetOf(cursor: unknown): number {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== "string") throw new InputError("start_cursor should be a string");
  const m = /^o:(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString());
  if (!m) throw new InputError("start_cursor is not valid");
  return Number(m[1]);
}

export function pageSize(v: unknown): number {
  if (v === undefined || v === null) return 100;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new InputError("page_size should be between 1 and 100");
  return n;
}

/** One page of a list in Notion's list shape. */
export function paginate<T>(items: T[], cursor: unknown, size: unknown, type: string): { object: "list"; results: T[]; next_cursor: string | null; has_more: boolean; type: string; [k: string]: unknown } {
  const start = offsetOf(cursor);
  const n = pageSize(size);
  const results = items.slice(start, start + n);
  const more = start + n < items.length;
  return { object: "list", results, next_cursor: more ? cursorAt(start + n) : null, has_more: more, type, [type]: {} };
}
