// zvena Documents databases: pure logic over rows (filters, sorts, search,
// grouping, value formatting). Rows are notes whose parent is the database.

import { blocksText, isSourceNote, shortId } from "./model";
import { computeRows, hasComputed, parseFileItem } from "./compute";
import { localYmd } from "./dates";
import { filterDay, isWithinToken, withinDays } from "./date-filter";
import type { ColorRule, DateValue, DbFilter, DbFilterGroup, DbProperty, DbSchema, DbView, FilterOp, Note, NoteColor, PropValue, SelectOption } from "./types";
import { CURRENCY_FORMATS, NOTE_COLORS, isCurrency, isFilterGroup, isPlaceValue } from "./types";
import { people, personName, resolvePerson } from "./people";
import { intlOf, nearDay } from "@/i18n/locales";
import { isVerification, verificationState } from "./verification";

/** A database's rows in manual order, with formulas, rollups and relation titles computed. */
export function rowsOf(dbId: string, all: readonly Note[], opts?: { byId?: ReadonlyMap<string, Note>; locale?: string }): Note[] {
  // A wiki keeps its own body: inline databases and synced blocks in it are not its pages.
  // Data sources under a database are not its rows (lib/notes/sources.ts).
  const rows = all.filter((n) => n.parentId === dbId && n.trashedAt === null && !n.template && !n.inline && !n.synced && !isSourceNote(n)).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const db = opts?.byId?.get(dbId) ?? all.find((n) => n.id === dbId);
  if (!hasComputed(db?.db)) return rows;
  const byId = opts?.byId ?? new Map(all.map((n) => [n.id, n]));
  return computeRows(rows, db?.db, byId, opts?.locale ?? "en");
}

/**
 * A row's value for a property. Formula and rollup values, and a relation's
 * page titles, come from `row.computed` (see rowsOf / computeRow); the
 * relation's stored ids are read with relationIds().
 */
export function propValue(row: Note, prop: DbProperty): PropValue {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  if (prop.type === "formula" || prop.type === "rollup" || prop.type === "relation") return row.computed?.[prop.id] ?? null;
  // Who created / last edited the row: one person, as a Person value.
  if (prop.type === "created_by") return row.createdBy ? [row.createdBy] : null;
  if (prop.type === "last_edited_by") return row.editedBy ? [row.editedBy] : null;
  return row.props?.[prop.id] ?? null;
}

/** Person, Created by and Last edited by: values are user ids. */
export const isPeopleType = (t: DbProperty["type"]) => t === "person" || t === "created_by" || t === "last_edited_by";

/** A verification's state in words (search, sort keys, CSV). */
const VERIFY_LABELS: Record<string, Record<"verified" | "expired" | "unverified", string>> = {
  en: { verified: "Verified", expired: "Expired", unverified: "" },
  ru: { verified: "Подтверждено", expired: "Истекло", unverified: "" },
};

const WHO_LABELS: Record<string, { unknown: string; form: string; automation: string }> = {
  en: { unknown: "Unknown", form: "Form", automation: "Automation" },
  ru: { unknown: "Неизвестный", form: "Форма", automation: "Автоматизация" },
};

/** A person's name in exports, sort keys and search ("form" and automations named as such). */
export function personText(id: string, locale = "en"): string {
  return personName(id, WHO_LABELS[locale] ?? WHO_LABELS.en);
}

const isDateValue = (v: PropValue): v is DateValue => typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as DateValue).start === "string";

/** Rollups that give a share (0..1), shown as a percent. */
export function isPercentRollup(prop: DbProperty): boolean {
  return prop.type === "rollup" && Boolean(prop.rollup?.fn.startsWith("percent_"));
}

/** The text of a computed (formula / rollup) value, by its runtime type. */
function computedText(prop: DbProperty, v: PropValue, locale: string): string {
  if (typeof v === "number") {
    if (isPercentRollup(prop)) return `${Math.round(v * 1000) / 10}%`;
    return formatNumber(v, prop.numberFormat, locale, prop.decimals);
  }
  if (typeof v === "boolean") return v ? "✓" : "";
  if (isDateValue(v)) return v.end ? `${fmtDate(v.start, locale)} → ${fmtDate(v.end, locale)}` : fmtDate(v.start, locale);
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export function isEmptyValue(v: PropValue): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  // A page that was never verified (or whose verification was removed) has none.
  if (isVerification(v)) return verificationState(v) === "unverified";
  if (typeof v === "object" && "start" in v) return !v.start;
  return false;
}

export function optionById(prop: DbProperty, id: string): SelectOption | undefined {
  return prop.options?.find((o) => o.id === id);
}

/** Text form of a value (search, sort keys, CSV). */
export function valueText(prop: DbProperty, v: PropValue, locale = "en"): string {
  if (isEmptyValue(v)) return "";
  switch (prop.type) {
    case "select":
    case "status":
      return optionById(prop, String(v))?.name ?? "";
    case "multi_select":
      return (Array.isArray(v) ? v : []).map((id) => optionById(prop, id)?.name ?? "").filter(Boolean).join(", ");
    case "checkbox":
      return v ? "✓" : "";
    case "date": {
      const d = v as DateValue;
      return d.end ? `${fmtDateAs(d.start, prop, locale)} → ${fmtDateAs(d.end, prop, locale)}` : fmtDateAs(d.start, prop, locale);
    }
    case "created_time":
    case "last_edited_time":
      if (prop.dateFormat || prop.timeFormat) {
        const t = new Date(Number(v));
        const p2 = (n: number) => String(n).padStart(2, "0");
        return fmtDateAs(`${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}T${p2(t.getHours())}:${p2(t.getMinutes())}`, prop, locale);
      }
      return stampFormat(locale).format(new Date(Number(v)));
    case "number":
      return formatNumber(Number(v), prop.numberFormat, locale, prop.decimals);
    case "formula":
    case "rollup":
      return computedText(prop, v, locale);
    case "relation":
      return (Array.isArray(v) ? v : []).join(", ");
    case "files":
      return (Array.isArray(v) ? v : []).map((x) => parseFileItem(x).name).join(", ");
    case "unique_id":
      return prop.prefix ? `${prop.prefix}-${v}` : String(v);
    case "person":
    case "created_by":
    case "last_edited_by":
      return (Array.isArray(v) ? v : []).map((id) => personText(id, locale)).join(", ");
    case "place":
      return isPlaceValue(v) ? v.name : "";
    case "verification":
      return (VERIFY_LABELS[locale] ?? VERIFY_LABELS.en)[verificationState(v)];
    default:
      return String(v);
  }
}

/** A place's name and address, for "contains" filters and search. */
function placeText(v: PropValue): string {
  return isPlaceValue(v) ? `${v.name} ${v.address ?? ""}` : "";
}

// Building an Intl formatter is slow; tables format hundreds of dates per render.
const dateFormats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(locale: string, hasTime: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${hasTime}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(intlOf(locale), { month: "long", day: "numeric", year: "numeric", ...(hasTime ? { hour: "numeric", minute: "2-digit" } : {}) });
    dateFormats.set(key, f);
  }
  return f;
}

const stampFormats = new Map<string, Intl.DateTimeFormat>();
function stampFormat(locale: string): Intl.DateTimeFormat {
  let f = stampFormats.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(intlOf(locale), { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    stampFormats.set(locale, f);
  }
  return f;
}

export function fmtDate(iso: string, locale = "en"): string {
  if (!iso) return "";
  const hasTime = iso.length > 10;
  const d = new Date(hasTime ? iso : `${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return dateFormat(locale, hasTime).format(d);
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();
function timeOf(d: Date, locale: string, clock: DbProperty["timeFormat"]): string {
  const key = `${locale}|${clock ?? ""}`;
  let f = timeFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(intlOf(locale), { hour: "numeric", minute: "2-digit", ...(clock ? { hour12: clock === "12" } : {}) });
    timeFormats.set(key, f);
  }
  return f.format(d);
}

/** A date the way its property shows it (Notion's "Date format" and "Time format"). */
export function fmtDateAs(iso: string, prop: Pick<DbProperty, "dateFormat" | "timeFormat"> | undefined, locale = "en", now = new Date()): string {
  const fmt = prop?.dateFormat ?? "full";
  if (!iso) return "";
  if (fmt === "full" && !prop?.timeFormat) return fmtDate(iso, locale);
  const hasTime = iso.length > 10;
  const d = new Date(hasTime ? iso : `${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const [y, m, day] = [d.getFullYear(), p2(d.getMonth() + 1), p2(d.getDate())];
  let date: string;
  if (fmt === "mdy") date = `${m}/${day}/${y}`;
  else if (fmt === "dmy") date = `${day}/${m}/${y}`;
  else if (fmt === "ymd") date = `${y}/${m}/${day}`;
  else {
    date = dateFormat(locale, false).format(d);
    if (fmt === "relative") {
      const days = Math.round((new Date(y, d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
      if (days === 0 || days === 1 || days === -1) date = nearDay(locale, days);
    }
  }
  return hasTime ? `${date} ${timeOf(d, locale, prop?.timeFormat)}` : date;
}

/** `decimals`: exactly that many digits after the point (Notion's "Decimal places"); unset, as written. */
export function formatNumber(n: number, fmt: DbProperty["numberFormat"], locale = "en", decimals?: number): string {
  if (!Number.isFinite(n)) return "";
  const loc = intlOf(locale);
  const digits = typeof decimals === "number" ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : null;
  switch (fmt) {
    case "comma":
      return n.toLocaleString(loc, digits ?? undefined);
    case "percent":
      return `${(n * 100).toLocaleString(loc, digits ?? { maximumFractionDigits: 2 })}%`;
    default:
      if (isCurrency(fmt)) return n.toLocaleString(loc, { style: "currency", currency: CURRENCY_FORMATS[fmt], ...(digits ?? {}) });
      return digits ? n.toFixed(decimals) : String(n);
  }
}

/** A date's sort key: its local time (dates without a time at midnight), "" when unreadable. */
function dateKey(iso: string): number | "" {
  const t = new Date(iso.length > 10 ? iso : `${iso}T00:00:00`).getTime();
  return Number.isNaN(t) ? "" : t;
}

function sortKey(prop: DbProperty, v: PropValue): string | number {
  if (isEmptyValue(v)) return "";
  switch (prop.type) {
    case "number":
    case "created_time":
    case "last_edited_time":
    case "unique_id":
      return Number(v);
    case "checkbox":
      return v ? 1 : 0;
    case "date":
      return dateKey((v as DateValue).start);
    // Verified first, then expired, then pages never verified.
    case "verification":
      return { verified: 0, expired: 1, unverified: 2 }[verificationState(v)];
    case "select":
    case "status": {
      const i = prop.options?.findIndex((o) => o.id === v) ?? -1;
      return i < 0 ? "" : i;
    }
    case "formula":
    case "rollup":
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (isDateValue(v)) return dateKey(v.start);
      return valueText(prop, v).toLowerCase();
    default:
      return valueText(prop, v).toLowerCase();
  }
}

/** Operators that compare against a value (a rule without one is ignored). */
export function filterNeedsValue(op: FilterOp): boolean {
  return op !== "empty" && op !== "not_empty" && op !== "checked" && op !== "unchecked";
}

function matchFilter(row: Note, f: DbFilter, schema: DbSchema): boolean {
  const prop = schema.properties.find((p) => p.id === f.prop);
  if (!prop) return true;
  const v = propValue(row, prop);
  const val = (f.value ?? "").trim();
  switch (f.op) {
    case "empty":
      return isEmptyValue(v);
    case "not_empty":
      return !isEmptyValue(v);
    case "checked":
      return v === true;
    case "unchecked":
      return v !== true;
    case "contains":
      if (!val) return true;
      if (prop.type === "multi_select") return Array.isArray(v) && v.includes(val);
      // People: the person (or "Me") is among them.
      if (isPeopleType(prop.type)) return Array.isArray(v) && v.includes(resolvePerson(val));
      if (prop.type === "place") return placeText(v).toLowerCase().includes(val.toLowerCase());
      return valueText(prop, v).toLowerCase().includes(val.toLowerCase());
    case "not_contains":
      if (!val) return true;
      if (prop.type === "multi_select") return !(Array.isArray(v) && v.includes(val));
      if (isPeopleType(prop.type)) return !(Array.isArray(v) && v.includes(resolvePerson(val)));
      if (prop.type === "place") return !placeText(v).toLowerCase().includes(val.toLowerCase());
      return !valueText(prop, v).toLowerCase().includes(val.toLowerCase());
    case "is":
    case "is_not":
      if (!val) return true;
      // A date rule: the day may be relative to today ("Today", "One week ago").
      if (isDateProp(prop, v)) return (!isEmptyValue(v) && dateOf(prop, v) === filterDay(val)) === (f.op === "is");
      // "Is not" is exactly the rows "is" leaves out (numbers, dates and formulas compare the same way).
      return isValue(prop, v, val) === (f.op === "is");
    case "starts_with":
      if (!val) return true;
      return valueText(prop, v).toLowerCase().startsWith(val.toLowerCase());
    case "ends_with":
      if (!val) return true;
      return valueText(prop, v).toLowerCase().endsWith(val.toLowerCase());
    case "gte":
      if (!val) return true;
      return !isEmptyValue(v) && Number(v) >= Number(val);
    case "lte":
      if (!val) return true;
      return !isEmptyValue(v) && Number(v) <= Number(val);
    case "on_or_before":
      if (!val) return true;
      return !isEmptyValue(v) && dateOf(prop, v) <= filterDay(val);
    case "on_or_after":
      if (!val) return true;
      return !isEmptyValue(v) && dateOf(prop, v) >= filterDay(val);
    case "within": {
      if (!isWithinToken(val)) return true;
      if (isEmptyValue(v)) return false;
      const [from, to] = withinDays(val);
      const d = dateOf(prop, v);
      return d >= from && d <= to;
    }
    case "gt":
      if (!val) return true;
      return !isEmptyValue(v) && Number(v) > Number(val);
    case "lt":
      if (!val) return true;
      return !isEmptyValue(v) && Number(v) < Number(val);
    case "before":
      if (!val) return true;
      return !isEmptyValue(v) && dateOf(prop, v) < filterDay(val);
    case "after":
      if (!val) return true;
      return !isEmptyValue(v) && dateOf(prop, v) > filterDay(val);
    default:
      return true;
  }
}

function isValue(prop: DbProperty, v: PropValue, val: string): boolean {
  if (prop.type === "select" || prop.type === "status") return v === val;
  if (prop.type === "verification") return verificationState(v) === val;
  if (prop.type === "multi_select") return Array.isArray(v) && v.length === 1 && v[0] === val;
  if (prop.type === "unique_id") return String(v) === val.replace(/^\D+-?/, "") || valueText(prop, v).toLowerCase() === val.toLowerCase();
  if (prop.type === "number" || typeof v === "number") return !isEmptyValue(v) && Number(v) === Number(val);
  if (isDateValue(v)) return v.start.slice(0, 10) === val;
  return valueText(prop, v).toLowerCase() === val.toLowerCase();
}

/** A rule on dates: a date property, created / edited time, or a formula / rollup giving a date. */
function isDateProp(prop: DbProperty, v: PropValue): boolean {
  return prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time" || isDateValue(v);
}

function dateOf(prop: DbProperty, v: PropValue): string {
  if (isDateValue(v)) return v.start.slice(0, 10);
  // The local calendar day, as the filter's date is typed (toISOString gives the UTC one).
  if (prop.type === "created_time" || prop.type === "last_edited_time") return localYmd(new Date(Number(v)));
  return String(v);
}

/**
 * An advanced filter group: its rules joined by "and" / "or". Rules still
 * waiting for a value, or on a deleted property, are left out (Notion).
 */
export function filterLive(x: DbFilter | DbFilterGroup, schema: DbSchema): boolean {
  if (isFilterGroup(x)) return x.items.some((y) => filterLive(y, schema));
  return schema.properties.some((p) => p.id === x.prop) && (!filterNeedsValue(x.op) || !!(x.value ?? "").trim());
}

/**
 * Sub-items: each row's sub-items in view order, and the top-level rows. A
 * row whose parent is filtered out shows at the top; loops are broken there.
 */
export function nestRows(rows: Note[], parentProp: string): { roots: Note[]; children: Map<string, Note[]> } {
  const inView = new Set(rows.map((r) => r.id));
  const parentOf = new Map<string, string>();
  for (const r of rows) {
    const v = r.props?.[parentProp];
    const pid = Array.isArray(v) ? v.find((id) => id !== r.id && inView.has(id)) : undefined;
    if (pid) parentOf.set(r.id, pid);
  }
  const looped = (id: string) => {
    const seen = new Set([id]);
    for (let cur = parentOf.get(id); cur; cur = parentOf.get(cur)) {
      if (seen.has(cur)) return true;
      seen.add(cur);
    }
    return false;
  };
  const roots: Note[] = [];
  const children = new Map<string, Note[]>();
  for (const r of rows) {
    const pid = parentOf.get(r.id);
    if (!pid || looped(r.id)) roots.push(r);
    else children.set(pid, [...(children.get(pid) ?? []), r]);
  }
  return { roots, children };
}

/** The advanced filter without rules on a deleted property (undefined once empty). */
export function groupWithoutProp(g: DbFilterGroup, propId: string): DbFilterGroup | undefined {
  const items: (DbFilter | DbFilterGroup)[] = [];
  for (const x of g.items) {
    if (isFilterGroup(x)) {
      const sub = groupWithoutProp(x, propId);
      if (sub) items.push(sub);
    } else if (x.prop !== propId) items.push(x);
  }
  return items.length ? { ...g, items } : undefined;
}

export function matchGroup(row: Note, g: DbFilterGroup, schema: DbSchema): boolean {
  const live = g.items.filter((x) => filterLive(x, schema));
  if (!live.length) return true;
  const test = (x: DbFilter | DbFilterGroup) => (isFilterGroup(x) ? matchGroup(row, x, schema) : matchFilter(row, x, schema));
  return g.conj === "or" ? live.some(test) : live.every(test);
}

const collators = new Map<string, Intl.Collator>();

/** Numbers by value, text in the language's alphabet ("ё" with "е", not after "я"); numbers before text. */
function compareKeys(a: string | number, b: string | number, locale: string): number {
  if (typeof a === "number" && typeof b === "number") return Math.sign(a - b) || 0;
  if (typeof a === "string" && typeof b === "string") {
    let c = collators.get(locale);
    if (!c) {
      c = new Intl.Collator(intlOf(locale));
      collators.set(locale, c);
    }
    return c.compare(a, b);
  }
  return typeof a === "number" ? -1 : 1;
}

/** The colors a view's conditional color rules give a row: the row's (or card's), and per property. */
export interface RowColors {
  row?: ColorRule["color"];
  cells: Record<string, ColorRule["color"]>;
}

const NO_COLORS: RowColors = { cells: {} };

/** Whether a color rule holds for a row: every condition complete and true. */
export function colorRuleHolds(row: Note, rule: ColorRule, schema: DbSchema): boolean {
  if (!rule.filters.length) return false;
  return rule.filters.every((f) => filterLive(f, schema) && matchFilter(row, f, schema));
}

/**
 * Notion's conditional color: rules are tried top first; the first that
 * holds colors the row, and for each property the first cell rule that
 * holds colors that cell.
 */
export function rowColors(row: Note, view: Pick<DbView, "colors">, schema: DbSchema): RowColors {
  if (!view.colors?.length) return NO_COLORS;
  const out: RowColors = { cells: {} };
  for (const rule of view.colors) {
    if (rule.prop ? out.cells[rule.prop] !== undefined || !schema.properties.some((p) => p.id === rule.prop) : out.row !== undefined) continue;
    if (!colorRuleHolds(row, rule, schema)) continue;
    if (rule.prop) out.cells[rule.prop] = rule.color;
    else out.row = rule.color;
  }
  return out;
}

/** Rows a view shows: filters, the search box, then sorts (manual order otherwise). */
export function applyView(rows: Note[], view: DbView, schema: DbSchema, search = "", locale = "en"): Note[] {
  const group = view.filterGroup;
  let out = rows.filter((r) => view.filters.every((f) => matchFilter(r, f, schema)) && (!group || matchGroup(r, group, schema)));
  const q = search.trim().toLowerCase();
  if (q) {
    out = out.filter((r) => {
      if (r.title.toLowerCase().includes(q)) return true;
      for (const p of schema.properties) if (valueText(p, propValue(r, p), locale).toLowerCase().includes(q)) return true;
      return blocksText(r.content, 0, 4000).toLowerCase().includes(q);
    });
  }
  if (view.sorts.length) {
    const sorts = view.sorts.map((s) => ({ s, prop: schema.properties.find((p) => p.id === s.prop) })).filter((x) => x.prop);
    out = [...out].sort((a, b) => {
      for (const { s, prop } of sorts) {
        const ka = sortKey(prop as DbProperty, propValue(a, prop as DbProperty));
        const kb = sortKey(prop as DbProperty, propValue(b, prop as DbProperty));
        // Empty values always go last (Notion).
        if (ka === "" && kb !== "") return 1;
        if (kb === "" && ka !== "") return -1;
        const c = compareKeys(ka, kb, locale);
        if (c) return s.dir === "asc" ? c : -c;
      }
      return a.order - b.order;
    });
  }
  return out;
}

/** Options with `id` moved before or after `target` (board column drag); a status stays within its group. Null: not allowed. */
export function movedOptions(prop: DbProperty, id: string, target: string, after: boolean): SelectOption[] | null {
  const opts = prop.options ?? [];
  const a = opts.find((o) => o.id === id);
  const b = opts.find((o) => o.id === target);
  if (!a || !b || a.id === b.id) return null;
  if (prop.type === "status" && a.group !== b.group) return null;
  const rest = opts.filter((o) => o.id !== id);
  rest.splice(rest.indexOf(b) + (after ? 1 : 0), 0, a);
  return rest;
}

/** Every property id in a view's order (hidden ones too), then `id` moved before or after `target` (column drag). */
export function movedOrder(schema: DbSchema, view: Pick<DbView, "order">, id: string, target: string, after: boolean): string[] {
  const known = new Set(schema.properties.map((p) => p.id));
  const ids = [...(view.order ?? []).filter((x) => known.has(x))];
  for (const p of schema.properties) if (!ids.includes(p.id)) ids.push(p.id);
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids;
  const rest = ids.filter((x) => x !== id);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, id);
  return rest;
}

/** Properties shown in a view, in its order (title first). */
export function visibleProps(schema: DbSchema, view: DbView): DbProperty[] {
  const order = view.order ?? [];
  const byId = new Map(schema.properties.map((p) => [p.id, p]));
  const ordered: DbProperty[] = [];
  for (const id of order) {
    const p = byId.get(id);
    if (p) {
      ordered.push(p);
      byId.delete(id);
    }
  }
  for (const p of schema.properties) if (byId.has(p.id)) ordered.push(p);
  const title = ordered.find((p) => p.type === "title");
  const rest = ordered.filter((p) => p.type !== "title" && !view.hidden.includes(p.id));
  return title ? [title, ...rest] : rest;
}

export interface Group {
  key: string;
  option: SelectOption | null;
  rows: Note[];
}

/**
 * People as board columns: every member (directory order), then anyone else
 * a row names (a former member). The "option" carries the user id and name.
 */
function peopleGroups(rows: Note[], prop: DbProperty, locale = "en"): { groups: Group[]; none: Group } {
  const ids = people().map((p) => p.id);
  for (const r of rows) {
    const v = propValue(r, prop);
    for (const id of Array.isArray(v) ? v : []) if (!ids.includes(id)) ids.push(id);
  }
  const groups: Group[] = ids.map((id) => ({ key: id, option: { id, name: personText(id, locale), color: "default" }, rows: [] }));
  const none: Group = { key: "__none", option: null, rows: [] };
  for (const r of rows) {
    const v = propValue(r, prop);
    const hits = groups.filter((g) => Array.isArray(v) && v.includes(g.key));
    // A row with two people shows under each (Notion).
    if (hits.length) hits.forEach((g) => g.rows.push(r));
    else none.rows.push(r);
  }
  return { groups, none };
}

/** Board columns: one per option (in option order), plus "No <prop>". */
export function groupRows(rows: Note[], prop: DbProperty): Group[] {
  if (isPeopleType(prop.type)) {
    const { groups, none } = peopleGroups(rows, prop);
    return [none, ...groups];
  }
  const groups: Group[] = (prop.options ?? []).map((o) => ({ key: o.id, option: o, rows: [] }));
  const none: Group = { key: "__none", option: null, rows: [] };
  for (const r of rows) {
    const v = propValue(r, prop);
    const id = prop.type === "multi_select" ? (Array.isArray(v) ? v[0] : undefined) : (v as string | null);
    const g = id ? groups.find((x) => x.key === id) : undefined;
    (g ?? none).rows.push(r);
  }
  return [none, ...groups];
}

/** The groups a view shows and the ones hidden by "Hide group" ("Hide empty groups" just leaves empty ones out). */
export function splitGroups<T extends { key: string; rows: Note[] }>(groups: T[], view: Pick<DbView, "hiddenGroups" | "hideEmpty"> | undefined): { shown: T[]; hidden: T[] } {
  const off = new Set(view?.hiddenGroups ?? []);
  return {
    shown: groups.filter((g) => !off.has(g.key) && !(view?.hideEmpty && g.rows.length === 0)),
    hidden: groups.filter((g) => off.has(g.key)),
  };
}

/** A table / list group (Notion's "Group" setting). */
export interface RowGroup {
  key: string;
  label: string;
  option: SelectOption | null;
  rows: Note[];
  /** What a new row in this group gets for the grouped property (undefined: nothing). */
  value?: PropValue;
}

/** Types a table or list can group by. */
export function canGroupBy(prop: DbProperty): boolean {
  return ["select", "status", "multi_select", "checkbox", "date", "text", "url", "email", "phone", "number", "formula", "created_time", "last_edited_time", "person", "created_by", "last_edited_by"].includes(prop.type);
}

/** Rows grouped by a property: options in order, checkboxes, months, or plain values. */
/** Labels for date groups by relative time (Notion's "Date by: Relative"). */
export interface RelativeLabels {
  today: string;
  tomorrow: string;
  yesterday: string;
  next7: string;
  last7: string;
  next30: string;
  last30: string;
  /** "Week of {date}". */
  weekOf: string;
}

/** A date's group: its key (sorts in time order) and label, by the view's "Date by". */
function dateGroup(iso: string, by: NonNullable<DbView["groupDate"]>, loc: string, rel: RelativeLabels | undefined, now: Date): { key: string; label: string } {
  const day = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (by === "day") return { key: iso.slice(0, 10), label: day.toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" }) };
  if (by === "year") return { key: iso.slice(0, 4), label: iso.slice(0, 4) };
  if (by === "week") {
    // Weeks start on Monday (ISO).
    const monday = new Date(day);
    monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    const key = localYmd(monday);
    const text = monday.toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" });
    return { key, label: rel ? rel.weekOf.replace("{date}", text) : text };
  }
  if (by === "relative" && rel) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const d = Math.round((day.getTime() - today.getTime()) / 86_400_000);
    // Keys keep time order among themselves and with the months around them.
    const bucket = (k: string, label: string) => ({ key: `r:${k}`, label });
    if (d === 0) return bucket(`${localYmd(today)}:3`, rel.today);
    if (d === 1) return bucket(`${localYmd(today)}:4`, rel.tomorrow);
    if (d === -1) return bucket(`${localYmd(today)}:2`, rel.yesterday);
    if (d > 1 && d <= 7) return bucket(`${localYmd(today)}:5`, rel.next7);
    if (d < -1 && d >= -7) return bucket(`${localYmd(today)}:1`, rel.last7);
    if (d > 7 && d <= 30) return bucket(`${localYmd(today)}:6`, rel.next30);
    if (d < -7 && d >= -30) return bucket(`${localYmd(today)}:0`, rel.last30);
  }
  const key = iso.slice(0, 7);
  return { key, label: new Date(`${key}-01T00:00:00`).toLocaleDateString(loc, { month: "long", year: "numeric" }) };
}

/** The order of a date group's key in time (relative buckets sit at today). */
const timeKey = (key: string) => (key.startsWith("r:") ? key.slice(2) : key);

export function groupRowsFor(
  rows: Note[],
  prop: DbProperty,
  labels: { none: string; checked: string; unchecked: string; relative?: RelativeLabels },
  locale = "en",
  view?: Pick<DbView, "groupDate" | "groupOrder">,
  now = new Date()
): RowGroup[] {
  if (prop.type === "select" || prop.type === "status") {
    return groupRows(rows, prop).map((g) => ({ key: g.key, label: g.option?.name ?? labels.none, option: g.option, rows: g.rows, value: g.option?.id ?? null }));
  }
  if (prop.type === "multi_select") {
    const groups: RowGroup[] = [{ key: "__none", label: labels.none, option: null, rows: [], value: [] }, ...(prop.options ?? []).map((o) => ({ key: o.id, label: o.name, option: o, rows: [] as Note[], value: [o.id] }))];
    for (const r of rows) {
      const v = propValue(r, prop);
      const ids = Array.isArray(v) ? v : [];
      // A row shows in every group it belongs to (Notion).
      const hits = groups.filter((g) => g.option && ids.includes(g.option.id));
      if (hits.length) hits.forEach((g) => g.rows.push(r));
      else groups[0].rows.push(r);
    }
    return groups;
  }
  if (isPeopleType(prop.type)) {
    // Only a Person property can be set from a group (Created by / Last edited by are the server's).
    const settable = prop.type === "person";
    const { groups, none } = peopleGroups(rows, prop, locale);
    return [
      { key: none.key, label: labels.none, option: null, rows: none.rows, ...(settable ? { value: [] } : {}) },
      ...groups.filter((g) => g.rows.length > 0).map((g) => ({ key: g.key, label: g.option?.name ?? "", option: g.option, rows: g.rows, ...(settable ? { value: [g.key] } : {}) })),
    ];
  }
  if (prop.type === "checkbox") {
    const on = rows.filter((r) => propValue(r, prop) === true);
    return [
      { key: "__on", label: labels.checked, option: null, rows: on, value: true },
      { key: "__off", label: labels.unchecked, option: null, rows: rows.filter((r) => !on.includes(r)), value: false },
    ];
  }
  const map = new Map<string, RowGroup>();
  const loc = intlOf(locale);
  for (const r of rows) {
    const v = propValue(r, prop);
    let key = "__none";
    let label = labels.none;
    if (!isEmptyValue(v)) {
      const iso = isDateValue(v) ? v.start : prop.type === "created_time" || prop.type === "last_edited_time" ? localYmd(new Date(Number(v))) : null;
      if (iso) {
        // Dates group by month unless the view says otherwise (Notion's "Date by").
        ({ key, label } = dateGroup(iso, view?.groupDate ?? "month", loc, labels.relative, now));
      } else {
        label = valueText(prop, v, locale);
        key = `v:${label.toLowerCase()}`;
      }
    }
    let g = map.get(key);
    if (!g) {
      g = { key, label, option: null, rows: [], ...(prop.type === "text" || prop.type === "url" || prop.type === "email" || prop.type === "phone" ? { value: key === "__none" ? null : label } : {}) };
      map.set(key, g);
    }
    g.rows.push(r);
  }
  // Dates in time order; plain values A→Z (or the other way round); the empty group last.
  const dir = view?.groupOrder === "desc" ? -1 : 1;
  return [...map.values()].sort((a, b) => (a.key === "__none" ? 1 : b.key === "__none" ? -1 : dir * timeKey(a.key).localeCompare(timeKey(b.key), locale)));
}

const OPTION_COLORS: NoteColor[] = NOTE_COLORS.filter((c) => c !== "default");

/** A new option with the next color in rotation (Notion picks colors for you). */
export function newOption(prop: DbProperty, name: string): SelectOption {
  const used = prop.options?.length ?? 0;
  return { id: shortId(), name: name.slice(0, 200), color: used === 0 ? "default" : OPTION_COLORS[(used - 1) % OPTION_COLORS.length] };
}

/** Schema helpers (immutable updates). */
export function withProp(schema: DbSchema, propId: string, patch: Partial<DbProperty>): DbSchema {
  return { ...schema, properties: schema.properties.map((p) => (p.id === propId ? { ...p, ...patch } : p)) };
}

/**
 * The schema without a property: no view, filter, sort, grouping, chart,
 * form question, calculation or color rule keeps pointing at it (the title
 * stays). Rows keep their values (the page history has them).
 */
export function withoutProp(s: DbSchema, propId: string): DbSchema {
  return {
    ...s,
    properties: s.properties.filter((p) => p.id !== propId || p.type === "title"),
    subItems: s.subItems && (s.subItems.parentProp === propId || s.subItems.childProp === propId) ? undefined : s.subItems,
    deps: s.deps && (s.deps.blockedBy === propId || s.deps.blocking === propId) ? undefined : s.deps,
    ...(s.layout
      ? {
          layout: {
            ...s.layout,
            ...(s.layout.header ? { header: s.layout.header.filter((x) => x !== propId) } : {}),
            ...(s.layout.sections ? { sections: s.layout.sections.map((x) => ({ ...x, props: x.props.filter((y) => y !== propId) })) } : {}),
          },
        }
      : {}),
    views: s.views.map((v) => ({
      ...v,
      filters: v.filters.filter((f) => f.prop !== propId),
      filterGroup: v.filterGroup && groupWithoutProp(v.filterGroup, propId),
      sorts: v.sorts.filter((x) => x.prop !== propId),
      hidden: v.hidden.filter((h) => h !== propId),
      ...(v.wrapCols ? { wrapCols: v.wrapCols.filter((c) => c !== propId) } : {}),
      order: v.order?.filter((o) => o !== propId),
      groupBy: v.groupBy === propId ? undefined : v.groupBy,
      subGroupBy: v.subGroupBy === propId ? undefined : v.subGroupBy,
      dateProp: v.dateProp === propId ? undefined : v.dateProp,
      endProp: v.endProp === propId ? undefined : v.endProp,
      freeze: v.freeze === propId ? undefined : v.freeze,
      ...(v.calcs?.[propId] ? { calcs: Object.fromEntries(Object.entries(v.calcs).filter(([k]) => k !== propId)) } : {}),
      ...(v.form ? { form: { ...v.form, questions: v.form.questions.filter((q) => q.prop !== propId) } } : {}),
      ...(v.chart && (v.chart.x === propId || v.chart.y?.prop === propId)
        ? { chart: { ...v.chart, ...(v.chart.x === propId ? { x: undefined } : {}), ...(v.chart.y?.prop === propId ? { y: { fn: "count" as const } } : {}) } }
        : {}),
      ...(v.map?.prop === propId ? { map: { ...v.map, prop: undefined } } : {}),
      ...(v.colors?.some((c) => c.prop === propId || c.filters.some((f) => f.prop === propId))
        ? { colors: v.colors.filter((c) => c.prop !== propId).map((c) => ({ ...c, filters: c.filters.filter((f) => f.prop !== propId) })) }
        : {}),
    })),
  };
}

export function withView(schema: DbSchema, viewId: string, patch: Partial<DbView>): DbSchema {
  return { ...schema, views: schema.views.map((v) => (v.id === viewId ? { ...v, ...patch } : v)) };
}

/** "Name: value" lines for a row (Markdown export, the page's properties as text). */
export function rowPropLines(row: Note, schema: DbSchema, locale = "en"): string[] {
  return schema.properties
    .filter((p) => p.type !== "title")
    .map((p) => {
      const v = valueText(p, propValue(row, p), locale);
      return v ? `${p.name}: ${v}` : "";
    })
    .filter(Boolean);
}

/** Database → CSV (header = property names). */
export function databaseToCsv(db: Note, rows: Note[], locale = "en"): string {
  const schema = db.db;
  if (!schema) return "";
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = schema.properties.map((p) => cell(p.name)).join(",");
  const body = rows.map((r) => schema.properties.map((p) => cell(valueText(p, propValue(r, p), locale))).join(",")).join("\n");
  // The byte order mark tells Excel the file is UTF-8 (Cyrillic reads as mojibake without it).
  return `\uFEFF${head}\n${body}\n`;
}

/** The first image in a row's body (gallery "page content" preview). */
export function firstImage(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  for (const raw of blocks) {
    const b = raw as { type?: string; props?: { url?: string }; children?: unknown[] };
    if (b?.type === "image" && b.props?.url) return b.props.url;
    const sub = firstImage(b?.children);
    if (sub) return sub;
  }
  return "";
}
