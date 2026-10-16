// zvena Documents: pure helpers over the note model (no browser APIs), shared
// by the client store, the sync route and the tests.

import {
  NOTE_COLORS,
  NUMBER_FORMATS,
  NOTE_ID_RE,
  NOTE_LIMITS,
  PROP_TYPES,
  FORM_ID_RE,
  FORM_PROP_TYPES,
  MAX_FILTER_DEPTH,
  ROLLUP_FNS,
  VIEW_TYPES,
  MAX_COLOR_RULES,
  type ColorRule,
  type DbFilter,
  type DbFilterGroup,
  type FormCondition,
  type FormQuestion,
  type FormSpec,
  type DbProperty,
  type DbSchema,
  type DbSort,
  type DbView,
  type Note,
  type NoteColor,
  type NoteCover,
  type NoteStyle,
  type NoteSuggestion,
  type PropValue,
  type RollupFn,
  type SelectOption,
  SPACE_RE,
  type DashboardWidget,
  type LayoutSection,
  type PageLayout,
} from "./types";
import { cleanActions, cleanAutomations } from "./automations";
import { isReminder } from "./reminders";
import { cleanSiteOptions } from "./sites";
import { SUGGEST_DEL, SUGGEST_INS, blockSuggestion } from "./suggestions";

/** 32 hex characters, like Notion's page ids. */
export function newNoteId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** Short ids for properties, options, views and filters (unique within a note). */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function blankNote(partial: Partial<Note> & Pick<Note, "kind">): Note {
  const now = Date.now();
  return {
    id: newNoteId(),
    parentId: null,
    title: "",
    icon: "",
    cover: null,
    content: [],
    order: now,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    ...partial,
  };
}

export const STATUS_OPTIONS: SelectOption[] = [
  { id: "todo", name: "Not started", color: "default", group: "todo" },
  { id: "doing", name: "In progress", color: "blue", group: "doing" },
  { id: "done", name: "Done", color: "green", group: "done" },
];

export function defaultView(type: DbView["type"], name: string, schema?: DbSchema): DbView {
  const view: DbView = { id: shortId(), name, type, filters: [], sorts: [], hidden: [], widths: {} };
  if (type === "board") view.groupBy = schema?.properties.find((p) => p.type === "status" || p.type === "select")?.id;
  if (type === "calendar" || type === "timeline") view.dateProp = schema?.properties.find((p) => p.type === "date")?.id;
  if (type === "timeline") view.zoom = "month";
  if (type === "gallery") {
    view.preview = "content";
    view.cardSize = "medium";
  }
  if (type === "form") {
    const props = (schema?.properties ?? []).filter((p) => FORM_PROP_TYPES.includes(p.type)).slice(0, 8);
    view.form = { questions: props.map((p) => ({ prop: p.id, ...(p.type === "title" ? { required: true } : {}) })) };
  }
  if (type === "map") view.map = { prop: schema?.properties.find((p) => p.type === "place")?.id };
  if (type === "dashboard") view.dashboard = { widgets: [] };
  return view;
}

/** The scope of a dashboard's widget views ("dash:<dashboard view id>"). */
export const dashScope = (dashboardViewId: string) => `dash:${dashboardViewId}`;
export const DASH_SCOPE_RE = /^dash:[A-Za-z0-9_-]{1,40}$/;

/** A new database: Name + Tags, one table view (Notion's default). */
export function blankSchema(labels: { name: string; tags: string; table: string }): DbSchema {
  const schema: DbSchema = {
    properties: [
      { id: "title", name: labels.name, type: "title" },
      { id: shortId(), name: labels.tags, type: "multi_select", options: [] },
    ],
    views: [],
  };
  schema.views.push(defaultView("table", labels.table, schema));
  return schema;
}

// ---------------------------------------------------------------------------
// Validation (sync route, imports, public pages)

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
/** A linked view block's id (its views in the source database carry it). */
export const LINK_SCOPE_RE = /^[A-Za-z0-9_-]{6,40}$/;
const isColor = (v: unknown): v is NoteColor => typeof v === "string" && (NOTE_COLORS as readonly string[]).includes(v);

function cleanCover(v: unknown): NoteCover | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r.kind !== "color" && r.kind !== "gradient" && r.kind !== "image") return null;
  const value = str(r.value, 2000);
  if (!value) return null;
  if (r.kind === "image" && !safeUrl(value, true)) return null;
  return { kind: r.kind, value, y: Math.min(100, Math.max(0, num(r.y, 50))) };
}

function cleanOption(v: unknown): SelectOption | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = str(r.id, 40);
  const name = str(r.name, 200);
  if (!id || !name) return null;
  const opt: SelectOption = { id, name, color: isColor(r.color) ? r.color : "default" };
  if (r.group === "todo" || r.group === "doing" || r.group === "done") opt.group = r.group;
  return opt;
}

/** Who a column permission names: a user id, "group:<id>" or "integration:<id>". */
const PRINCIPAL_RE = /^(group:[A-Za-z0-9_-]{8,40}|integration:[a-f0-9]{32}|[A-Za-z0-9_-]{6,64})$/;

/** A user id, "form", "automation:<id>" or "integration:<id>" (who created / edited a note, who wrote a comment). */
const WHO_RE = /^(form|automation:[\w-]{1,40}|integration:[a-f0-9]{32}|[A-Za-z0-9_-]{6,64})$/;

function cleanProperty(v: unknown): DbProperty | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = str(r.id, 40);
  // An "ai" column from another app (zvena has no AI columns) is kept as plain text.
  const type = r.type === "ai" ? "text" : r.type;
  if (!id || typeof type !== "string" || !(PROP_TYPES as readonly string[]).includes(type)) return null;
  const p: DbProperty = { id, name: str(r.name, 200), type: type as DbProperty["type"] };
  if (Array.isArray(r.options)) p.options = r.options.slice(0, 500).map(cleanOption).filter((o): o is SelectOption => o !== null);
  if (typeof r.numberFormat === "string" && (NUMBER_FORMATS as readonly string[]).includes(r.numberFormat)) p.numberFormat = r.numberFormat as DbProperty["numberFormat"];
  if (typeof r.decimals === "number" && Number.isInteger(r.decimals) && r.decimals >= 0 && r.decimals <= 6) p.decimals = r.decimals;
  if (typeof r.prefix === "string" && r.prefix.trim()) p.prefix = str(r.prefix, 20).replace(/[^\p{L}\p{N}_]/gu, "").toUpperCase();
  if (typeof r.formula === "object" && r.formula !== null) p.formula = { expr: str((r.formula as Record<string, unknown>).expr, 4000) };
  if (typeof r.relation === "object" && r.relation !== null) {
    const x = r.relation as Record<string, unknown>;
    const dbId = str(x.dbId, 40);
    if (NOTE_ID_RE.test(dbId)) p.relation = { dbId, ...(typeof x.syncedPropId === "string" && x.syncedPropId ? { syncedPropId: str(x.syncedPropId, 40) } : {}) };
  }
  if (typeof r.rollup === "object" && r.rollup !== null) {
    const x = r.rollup as Record<string, unknown>;
    const fn = typeof x.fn === "string" && (ROLLUP_FNS as readonly string[]).includes(x.fn) ? (x.fn as RollupFn) : "show_original";
    p.rollup = { relationPropId: str(x.relationPropId, 40), targetPropId: str(x.targetPropId, 40), fn };
  }
  if (r.pageVis === "hideEmpty" || r.pageVis === "hide") p.pageVis = r.pageVis;
  if (r.dateFormat === "full" || r.dateFormat === "mdy" || r.dateFormat === "dmy" || r.dateFormat === "ymd" || r.dateFormat === "relative") p.dateFormat = r.dateFormat;
  if (r.timeFormat === "12" || r.timeFormat === "24") p.timeFormat = r.timeFormat;
  if ((p.type === "person" || p.type === "relation") && r.single === true) p.single = true;
  if (typeof r.description === "string" && r.description.trim()) p.description = str(r.description, 1000);
  if (typeof r.show === "object" && r.show !== null) {
    const x = r.show as Record<string, unknown>;
    if (x.as === "bar" || x.as === "ring") {
      p.show = {
        as: x.as,
        ...(isColor(x.color) && x.color !== "default" ? { color: x.color } : {}),
        ...(typeof x.divide === "number" && Number.isFinite(x.divide) && x.divide > 0 ? { divide: x.divide } : {}),
        ...(x.number === false ? { number: false } : {}),
      };
    }
  }
  if (typeof r.perms === "object" && r.perms !== null) {
    const x = r.perms as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((u): u is string => typeof u === "string" && PRINCIPAL_RE.test(u)))].slice(0, 200) : undefined);
    const view = list(x.view);
    const edit = list(x.edit);
    if (view || edit) p.perms = { ...(view ? { view } : {}), ...(edit ? { edit } : {}) };
  }
  if (p.type === "button" && typeof r.button === "object" && r.button !== null) {
    const b = r.button as Record<string, unknown>;
    p.button = { label: str(b.label, 100), actions: cleanActions(b.actions, 12), ...(typeof b.by === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(b.by) ? { by: b.by } : {}) };
  }
  return p;
}

function cleanFilter(v: unknown): DbFilter | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const ops = ["contains", "not_contains", "is", "is_not", "empty", "not_empty", "checked", "unchecked", "gt", "lt", "before", "after", "on_or_before", "on_or_after", "within", "gte", "lte", "starts_with", "ends_with"];
  if (typeof r.op !== "string" || !ops.includes(r.op)) return null;
  const prop = str(r.prop, 40);
  if (!prop) return null;
  return { id: str(r.id, 40) || shortId(), prop, op: r.op as DbFilter["op"], ...(typeof r.value === "string" ? { value: str(r.value, 500) } : {}) };
}

function cleanGroup(v: unknown, depth: number): DbFilterGroup | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.items)) return null;
  const items: (DbFilter | DbFilterGroup)[] = [];
  for (const x of r.items.slice(0, 50)) {
    const nested = typeof x === "object" && x !== null && Array.isArray((x as Record<string, unknown>).items);
    const clean = nested ? (depth < MAX_FILTER_DEPTH ? cleanGroup(x, depth + 1) : null) : cleanFilter(x);
    if (clean) items.push(clean);
  }
  return { id: str(r.id, 40) || shortId(), conj: r.conj === "or" ? "or" : "and", items };
}

function cleanCondition(v: unknown): { when?: FormCondition } {
  if (typeof v !== "object" || v === null) return {};
  const c = v as Record<string, unknown>;
  const prop = str(c.prop, 40);
  const op = c.op === "is" || c.op === "is_not" || c.op === "filled" || c.op === "empty" ? c.op : null;
  if (!prop || !op) return {};
  return { when: { prop, op, ...(op === "is" || op === "is_not" ? { value: typeof c.value === "string" ? str(c.value, 200) : "" } : {}) } };
}

function cleanForm(r: Record<string, unknown>): FormSpec {
  const questions: FormQuestion[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(r.questions) ? r.questions.slice(0, 50) : []) {
    if (typeof x !== "object" || x === null) continue;
    const q = x as Record<string, unknown>;
    const prop = str(q.prop, 40);
    if (!prop || seen.has(prop)) continue;
    seen.add(prop);
    questions.push({
      prop,
      ...(typeof q.help === "string" && q.help ? { help: str(q.help, 1000) } : {}),
      ...(q.required === true ? { required: true } : {}),
      ...cleanCondition(q.when),
    });
  }
  const form: FormSpec = { questions };
  if (typeof r.title === "string" && r.title) form.title = str(r.title, 200);
  if (typeof r.description === "string" && r.description) form.description = str(r.description, 2000);
  if (typeof r.thanks === "string" && r.thanks) form.thanks = str(r.thanks, 1000);
  if (typeof r.shareId === "string" && FORM_ID_RE.test(r.shareId)) form.shareId = r.shareId;
  if (r.access === "workspace") form.access = "workspace";
  if (r.anonymous === true) form.anonymous = true;
  return form;
}

function cleanSort(v: unknown): DbSort | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const prop = str(r.prop, 40);
  if (!prop) return null;
  return { prop, dir: r.dir === "desc" ? "desc" : "asc" };
}

function cleanColorRule(v: unknown): ColorRule | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isColor(r.color) || r.color === "default") return null;
  const filters = Array.isArray(r.filters) ? r.filters.slice(0, 10).map(cleanFilter).filter((f): f is DbFilter => f !== null) : [];
  return { id: str(r.id, 40) || shortId(), color: r.color, ...(typeof r.prop === "string" && r.prop ? { prop: str(r.prop, 40) } : {}), filters };
}

function cleanView(v: unknown): DbView | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = str(r.id, 40);
  if (!id || typeof r.type !== "string" || !(VIEW_TYPES as readonly string[]).includes(r.type)) return null;
  const widths: Record<string, number> = {};
  if (typeof r.widths === "object" && r.widths !== null) {
    for (const [k, w] of Object.entries(r.widths as Record<string, unknown>).slice(0, 200)) {
      if (typeof w === "number" && Number.isFinite(w)) widths[k.slice(0, 40)] = Math.min(1200, Math.max(60, w));
    }
  }
  const view: DbView = {
    id,
    name: str(r.name, 200),
    type: r.type as DbView["type"],
    filters: Array.isArray(r.filters) ? r.filters.slice(0, 50).map(cleanFilter).filter((f): f is DbFilter => f !== null) : [],
    sorts: Array.isArray(r.sorts) ? r.sorts.slice(0, 20).map(cleanSort).filter((s): s is DbSort => s !== null) : [],
    hidden: Array.isArray(r.hidden) ? r.hidden.filter((x): x is string => typeof x === "string").slice(0, 200) : [],
    widths,
  };
  if (r.filterGroup) {
    const g = cleanGroup(r.filterGroup, 0);
    if (g) view.filterGroup = g;
  }
  if (typeof r.form === "object" && r.form !== null) view.form = cleanForm(r.form as Record<string, unknown>);
  if (typeof r.groupBy === "string") view.groupBy = str(r.groupBy, 40);
  if (typeof r.subGroupBy === "string" && r.subGroupBy) view.subGroupBy = str(r.subGroupBy, 40);
  if (r.groupDate === "relative" || r.groupDate === "day" || r.groupDate === "week" || r.groupDate === "year") view.groupDate = r.groupDate;
  if (r.groupOrder === "desc") view.groupOrder = "desc";
  if (typeof r.template === "string" && NOTE_ID_RE.test(r.template)) view.template = r.template;
  if (typeof r.dateProp === "string") view.dateProp = str(r.dateProp, 40);
  if (typeof r.endProp === "string" && r.endProp) view.endProp = str(r.endProp, 40);
  if (Array.isArray(r.order)) view.order = r.order.filter((x): x is string => typeof x === "string").slice(0, 200);
  if (r.preview === "none" || r.preview === "cover" || r.preview === "content") view.preview = r.preview;
  if (r.cardSize === "small" || r.cardSize === "medium" || r.cardSize === "large") view.cardSize = r.cardSize;
  if (r.wrap === true) view.wrap = true;
  if (Array.isArray(r.wrapCols)) {
    const cols = [...new Set(r.wrapCols.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 200).map((x) => x.slice(0, 40));
    if (cols.length) view.wrapCols = cols;
  }
  if (typeof r.freeze === "string" && r.freeze) view.freeze = str(r.freeze, 40);
  if (typeof r.scope === "string" && (LINK_SCOPE_RE.test(r.scope) || DASH_SCOPE_RE.test(r.scope))) view.scope = r.scope;
  if (typeof r.feed === "object" && r.feed !== null) {
    const f = r.feed as Record<string, unknown>;
    view.feed = { ...(f.hideContent === true ? { hideContent: true } : {}), ...(f.hideComments === true ? { hideComments: true } : {}) };
  }
  for (const k of ["hideTitle", "noLines", "hideIcons", "plainCols", "noWeekends", "hideEmpty", "fitImage"] as const) if (r[k] === true) view[k] = true;
  if (Array.isArray(r.hiddenGroups)) {
    const keys = r.hiddenGroups.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 200).map((x) => x.slice(0, 80));
    if (keys.length) view.hiddenGroups = keys;
  }
  if (r.openIn === "center" || r.openIn === "full") view.openIn = r.openIn;
  if (r.limit === 10 || r.limit === 25 || r.limit === 50 || r.limit === 100) view.limit = r.limit;
  if (r.zoom === "week" || r.zoom === "month" || r.zoom === "quarter" || r.zoom === "year") view.zoom = r.zoom;
  if (r.hideTable === true) view.hideTable = true;
  if (r.calMode === "week") view.calMode = "week";
  if (typeof r.chart === "object" && r.chart !== null) {
    const c = r.chart as Record<string, unknown>;
    const type = c.type === "bar" || c.type === "line" || c.type === "donut" ? c.type : "column";
    const chart: NonNullable<DbView["chart"]> = { type };
    if (typeof c.x === "string") chart.x = str(c.x, 40);
    if (typeof c.y === "object" && c.y !== null) {
      const y = c.y as Record<string, unknown>;
      const fn = (["count", "sum", "average", "median", "min", "max"] as const).find((f) => f === y.fn) ?? "count";
      chart.y = { fn, ...(typeof y.prop === "string" ? { prop: str(y.prop, 40) } : {}) };
    }
    if (c.sort === "asc" || c.sort === "desc" || c.sort === "x") chart.sort = c.sort;
    if (c.labels === true) chart.labels = true;
    if (typeof c.group === "string" && c.group) chart.group = str(c.group, 40);
    if (c.cumulative === true) chart.cumulative = true;
    if (c.height === "small" || c.height === "large") chart.height = c.height;
    if (c.omitZero === true) chart.omitZero = true;
    view.chart = chart;
  }
  if (typeof r.map === "object" && r.map !== null) {
    const m = r.map as Record<string, unknown>;
    view.map = {
      ...(typeof m.prop === "string" && m.prop ? { prop: str(m.prop, 40) } : {}),
      ...(typeof m.height === "number" && Number.isFinite(m.height) ? { height: Math.min(1200, Math.max(200, Math.round(m.height))) } : {}),
    };
  }
  if (typeof r.dashboard === "object" && r.dashboard !== null) {
    const d = r.dashboard as Record<string, unknown>;
    const widgets: DashboardWidget[] = [];
    for (const w of Array.isArray(d.widgets) ? d.widgets.slice(0, 24) : []) {
      const x = w as Record<string, unknown>;
      const id = str(x?.id, 40);
      const viewId = str(x?.viewId, 40);
      if (!id || !viewId) continue;
      widgets.push({ id, viewId, width: x.width === 1 || x.width === 3 || x.width === 4 ? x.width : 2 });
    }
    view.dashboard = { widgets };
  }
  if (typeof r.source === "string" && NOTE_ID_RE.test(r.source)) view.source = r.source;
  if (Array.isArray(r.colors)) {
    const colors = r.colors.slice(0, MAX_COLOR_RULES).map(cleanColorRule).filter((c): c is ColorRule => c !== null);
    if (colors.length) view.colors = colors;
  }
  if (typeof r.calcs === "object" && r.calcs !== null) {
    const calcs: Record<string, RollupFn> = {};
    for (const [k, fn] of Object.entries(r.calcs as Record<string, unknown>).slice(0, 200)) {
      if (typeof fn === "string" && (ROLLUP_FNS as readonly string[]).includes(fn) && fn !== "show_original" && fn !== "show_unique") calcs[k.slice(0, 40)] = fn as RollupFn;
    }
    if (Object.keys(calcs).length) view.calcs = calcs;
  }
  return view;
}

function cleanSchema(v: unknown): DbSchema | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const properties = Array.isArray(r.properties) ? r.properties.slice(0, 200).map(cleanProperty).filter((p): p is DbProperty => p !== null) : [];
  if (!properties.some((p) => p.type === "title")) properties.unshift({ id: "title", name: "Name", type: "title" });
  const all = Array.isArray(r.views) ? r.views.slice(0, 200).map(cleanView).filter((x): x is DbView => x !== null) : [];
  // A dashboard's widget views live as long as their widget does; a widget is never a dashboard or a form itself.
  const widgetIds = new Set(all.flatMap((x) => (x.type === "dashboard" && !x.scope?.startsWith("dash:") ? (x.dashboard?.widgets ?? []).map((w) => `${dashScope(x.id)}/${w.viewId}`) : [])));
  const views = all.filter((x) => !x.scope?.startsWith("dash:") || (widgetIds.has(`${x.scope}/${x.id}`) && x.type !== "dashboard" && x.type !== "form"));
  for (const d of views) {
    if (d.type !== "dashboard") continue;
    const own = new Set(views.filter((x) => x.scope === dashScope(d.id)).map((x) => x.id));
    d.dashboard = { widgets: (d.dashboard?.widgets ?? []).filter((w, i, list) => own.has(w.viewId) && list.findIndex((y) => y.viewId === w.viewId) === i) };
  }
  const schema: DbSchema = { properties, views };
  // The database itself always keeps a view (linked view blocks have their own).
  if (!views.some((v) => !v.scope)) schema.views.push(defaultView("table", "Table", schema));
  if (typeof r.defaultTemplate === "string" && NOTE_ID_RE.test(r.defaultTemplate)) schema.defaultTemplate = r.defaultTemplate;
  if (typeof r.subItems === "object" && r.subItems !== null) {
    const s = r.subItems as Record<string, unknown>;
    const parent = properties.find((p) => p.id === s.parentProp && p.type === "relation");
    const child = properties.find((p) => p.id === s.childProp && p.type === "relation");
    if (parent && child && parent !== child) schema.subItems = { parentProp: parent.id, childProp: child.id };
  }
  if (typeof r.deps === "object" && r.deps !== null) {
    const d = r.deps as Record<string, unknown>;
    const by = properties.find((p) => p.id === d.blockedBy && p.type === "relation");
    const ing = properties.find((p) => p.id === d.blocking && p.type === "relation");
    if (by && ing && by !== ing) schema.deps = { blockedBy: by.id, blocking: ing.id };
  }
  // A wiki: its Owner and Verification properties, if they are still there.
  if (typeof r.wiki === "object" && r.wiki !== null) {
    const w = r.wiki as Record<string, unknown>;
    const owner = properties.find((p) => p.id === w.owner && p.type === "person");
    const verification = properties.find((p) => p.id === w.verification && p.type === "verification");
    schema.wiki = { ...(owner ? { owner: owner.id } : {}), ...(verification ? { verification: verification.id } : {}) };
  }
  const automations = cleanAutomations(r.automations);
  if (automations) schema.automations = automations;
  const layout = cleanLayout(r.layout, properties);
  if (layout) schema.layout = layout;
  // Data sources (lib/notes/sources.ts).
  if (r.dataSource === true) schema.dataSource = true;
  if (typeof r.label === "object" && r.label !== null) {
    const l = r.label as Record<string, unknown>;
    const name = str(l.name, 200);
    const icon = cleanIcon(l.icon);
    if (name || icon) schema.label = { ...(name ? { name } : {}), ...(icon ? { icon } : {}) };
  }
  if (Array.isArray(r.linked)) {
    const linked = [...new Set(r.linked.filter((x): x is string => typeof x === "string" && NOTE_ID_RE.test(x)))].slice(0, MAX_LINKED_SOURCES);
    if (linked.length) schema.linked = linked;
  }
  return schema;
}

/** Data sources one database may link from others. */
export const MAX_LINKED_SOURCES = 20;

/** A database page layout: known properties only, each in one section at most. */
function cleanLayout(v: unknown, properties: readonly DbProperty[]): PageLayout | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const known = new Set(properties.filter((p) => p.type !== "title").map((p) => p.id));
  const ids = (x: unknown, max: number) => (Array.isArray(x) ? [...new Set(x.filter((i): i is string => typeof i === "string" && known.has(i)))].slice(0, max) : []);
  const layout: PageLayout = {};
  const header = ids(r.header, 4);
  if (header.length) layout.header = header;
  if (r.panel === "side") layout.panel = "side";
  const used = new Set<string>();
  const sections: LayoutSection[] = [];
  for (const raw of Array.isArray(r.sections) ? r.sections.slice(0, 20) : []) {
    const x = (raw ?? {}) as Record<string, unknown>;
    const id = str(x.id, 40);
    if (!id || sections.some((s) => s.id === id)) continue;
    const props = ids(x.props, 200).filter((p) => !used.has(p));
    props.forEach((p) => used.add(p));
    sections.push({ id, name: str(x.name, 100), props, ...(x.collapsed === true ? { collapsed: true } : {}), ...(x.hideEmpty === true ? { hideEmpty: true } : {}) });
  }
  if (sections.length) layout.sections = sections;
  return Object.keys(layout).length ? layout : undefined;
}

const VERIFIER_RE = /^(automation:[\w-]{1,40}|integration:[a-f0-9]{32}|[A-Za-z0-9_-]{6,64})$/;

function cleanValue(v: unknown): PropValue | undefined {
  if (v === null) return null;
  if (typeof v === "string") return v.slice(0, 20_000);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  // Option ids, related row ids, file links (up to 2000 chars each).
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").slice(0, 500).map((x) => x.slice(0, 2000));
  if (typeof v === "object") {
    const r = v as Record<string, unknown>;
    if (typeof r.start === "string") return { start: r.start.slice(0, 40), ...(typeof r.end === "string" && r.end ? { end: r.end.slice(0, 40) } : {}), ...(isReminder(r.remind) ? { remind: r.remind } : {}) };
    // A wiki page's verification: a state, who verified it, when, and through which day.
    if (r.state === "verified" || r.state === "unverified") {
      return {
        state: r.state,
        ...(typeof r.by === "string" && VERIFIER_RE.test(r.by) ? { by: r.by } : {}),
        ...(typeof r.at === "number" && Number.isFinite(r.at) && r.at > 0 ? { at: Math.floor(r.at) } : {}),
        ...(typeof r.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.until) ? { until: r.until } : {}),
      };
    }
    // A place: coordinates on the globe, a name and an address.
    if (typeof r.lat === "number" && typeof r.lng === "number" && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180) {
      return { name: str(r.name, 300), lat: r.lat, lng: r.lng, ...(typeof r.address === "string" && r.address ? { address: str(r.address, 500) } : {}) };
    }
  }
  return undefined;
}

const ICON_REF_RE = /^icon:[a-z0-9-]{1,40}:(default|gray|brown|orange|yellow|green|blue|purple|pink|red)$/;
const ICON_FILE_RE = /^\/api\/notes\/file\/[A-Za-z0-9._-]{1,100}$/;

/** A page icon: an emoji (or short text), "icon:<name>:<color>", or an uploaded image. */
export function cleanIcon(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  if (v.startsWith("icon:")) return ICON_REF_RE.test(v) ? v : "";
  if (v.startsWith("/")) return ICON_FILE_RE.test(v) ? v : "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || /[<>]/.test(v)) return "";
  return v.slice(0, 64);
}

/** The icon as text (emoji only): custom icons have no text form. */
export function iconText(icon: string | undefined | null): string {
  return icon && !icon.startsWith("icon:") && !icon.startsWith("/") ? icon : "";
}

function cleanReactions(v: unknown): { reactions: Record<string, string[]> } | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [emoji, who] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    // An emoji, or a workspace's custom emoji by name (":party-parrot:").
    if (!emoji || (emoji.length > 16 && !/^:[a-z0-9_-]{1,32}:$/.test(emoji)) || /[<>]/.test(emoji) || !Array.isArray(who)) continue;
    const names = [...new Set(who.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 120)))].slice(0, 50);
    if (names.length) out[emoji] = names;
  }
  return Object.keys(out).length ? { reactions: out } : undefined;
}

function cleanSuggestion(v: unknown, now: number): NoteSuggestion | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const s: NoteSuggestion = {};
  if (r.state === "accepted" || r.state === "rejected") {
    s.state = r.state;
    if (typeof r.by === "string" && WHO_RE.test(r.by)) s.by = r.by;
    s.at = num(r.at, now);
  }
  return s;
}

function cleanStyle(v: unknown): NoteStyle | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const s: NoteStyle = {};
  if (r.font === "serif" || r.font === "mono" || r.font === "sans") s.font = r.font;
  if (r.small === true) s.small = true;
  if (r.full === true) s.full = true;
  if (r.locked === true) s.locked = true;
  if (r.backlinks === "expanded" || r.backlinks === "off") s.backlinks = r.backlinks;
  if (r.comments === "off") s.comments = "off";
  return Object.keys(s).length ? s : undefined;
}

/** A well-formed note from untrusted JSON, or null. Content stays as given (bounded by size). */
export function sanitizeNote(v: unknown): Note | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  if (!NOTE_ID_RE.test(id)) return null;
  if (r.kind !== "page" && r.kind !== "database") return null;
  const parentId = typeof r.parentId === "string" && NOTE_ID_RE.test(r.parentId) && r.parentId !== id ? r.parentId : null;
  const now = Date.now();
  const note: Note = {
    id,
    parentId,
    kind: r.kind,
    title: str(r.title, NOTE_LIMITS.titleChars),
    icon: cleanIcon(r.icon),
    cover: cleanCover(r.cover),
    content: Array.isArray(r.content) ? r.content : [],
    order: num(r.order, now),
    favorite: r.favorite === true,
    createdAt: num(r.createdAt, now),
    updatedAt: num(r.updatedAt, now),
    trashedAt: typeof r.trashedAt === "number" && Number.isFinite(r.trashedAt) ? r.trashedAt : null,
  };
  // Set by the server (pushNotes); kept on the way back to devices.
  if (typeof r.createdBy === "string" && WHO_RE.test(r.createdBy)) note.createdBy = r.createdBy;
  if (typeof r.editedBy === "string" && WHO_RE.test(r.editedBy)) note.editedBy = r.editedBy;
  if (typeof r.ysnap === "string" && /^[a-z0-9]{1,16}$/.test(r.ysnap)) note.ysnap = r.ysnap;
  // A top-level page's section; "private" alone is a device asking for its person's Private (the server fills the id).
  if (parentId === null && typeof r.space === "string" && (SPACE_RE.test(r.space) || r.space === "private")) note.space = r.space;
  // A database always has a schema (title + a table view at least): its views and rows need one.
  if (r.kind === "database") note.db = cleanSchema(typeof r.db === "object" && r.db !== null ? r.db : {});
  if (typeof r.props === "object" && r.props !== null && !Array.isArray(r.props)) {
    const props: Record<string, PropValue> = {};
    for (const [k, val] of Object.entries(r.props as Record<string, unknown>).slice(0, 200)) {
      const c = cleanValue(val);
      if (c !== undefined) props[k.slice(0, 40)] = c;
    }
    note.props = props;
  }
  if (r.inline === true) note.inline = true;
  if (r.template === true) note.template = true;
  if (r.synced === true) note.synced = true;
  const style = cleanStyle(r.style);
  if (style) note.style = style;
  if (Array.isArray(r.comments)) {
    const comments = r.comments
      .slice(0, 500)
      .map((c) => {
        const x = (c ?? {}) as Record<string, unknown>;
        const thread = typeof x.thread === "string" && /^[\w-]{1,40}$/.test(x.thread) ? x.thread : undefined;
        // A suggested edit is a thread's first entry, without text of its own.
        const suggestion = thread ? cleanSuggestion(x.suggestion, now) : undefined;
        const text = suggestion ? "" : str(x.text, 8000);
        if (!suggestion && !text.trim()) return null;
        return {
          id: str(x.id, 40) || shortId(),
          text,
          at: num(x.at, now),
          author: str(x.author, 120),
          ...(typeof x.authorId === "string" && WHO_RE.test(x.authorId) ? { authorId: x.authorId } : {}),
          ...(x.resolved === true ? { resolved: true } : {}),
          ...(!suggestion && typeof x.editedAt === "number" && Number.isFinite(x.editedAt) ? { editedAt: x.editedAt } : {}),
          ...(thread ? { thread } : {}),
          ...(thread && typeof x.quote === "string" && x.quote ? { quote: str(x.quote, 500) } : {}),
          ...(cleanReactions(x.reactions) ?? {}),
          ...(suggestion ? { suggestion } : {}),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    if (comments.length) note.comments = comments;
  }
  if (typeof r.share === "object" && r.share !== null) {
    const s = r.share as Record<string, unknown>;
    if (typeof s.id === "string" && typeof s.key === "string")
      note.share = { id: s.id.slice(0, 64), key: s.key.slice(0, 128), at: num(s.at, now), ...cleanSiteOptions(s, now) };
  }
  return note;
}

/** http(s), mailto and same-origin paths; images may also be data:image. */
export function safeUrl(url: string, image = false): boolean {
  if (/^\/(?!\/)/.test(url)) return true;
  if (/^(https?:|mailto:)/i.test(url)) return true;
  if (image && /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(url)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Block text (search, previews, Markdown export)

interface InlineLike {
  type?: string;
  text?: string;
  content?: unknown;
  href?: string;
  props?: Record<string, unknown>;
}

interface BlockLike {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown;
}

export function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    // Tables: { type: "tableContent", rows: [{ cells: [...] }] }
    const t = content as { type?: string; rows?: { cells?: unknown[] }[] } | null;
    if (t && t.type === "tableContent" && Array.isArray(t.rows)) {
      return t.rows
        .map((row) => (row.cells ?? []).map((c) => inlineText((c as { content?: unknown })?.content ?? c)).join(" | "))
        .join("\n");
    }
    return "";
  }
  let out = "";
  for (const raw of content) {
    const n = raw as InlineLike;
    if (!n || typeof n !== "object") continue;
    if (n.type === "text") out += n.text ?? "";
    else if (n.type === "link") out += inlineText(n.content);
    else if (n.type === "mention") out += String(n.props?.title ?? (n.props?.name ? `@${String(n.props.name)}` : ""));
    else if (n.type === "equation") out += String(n.props?.latex ?? "");
    else if (n.content) out += inlineText(n.content);
  }
  return out;
}

/** A page's headings, in order (the floating outline; nested ones too). */
export function outlineOf(blocks: unknown, out: { id: string; level: number; text: string }[] = [], depth = 0): { id: string; level: number; text: string }[] {
  if (!Array.isArray(blocks) || depth > 40) return out;
  for (const raw of blocks) {
    const b = raw as BlockLike & { id?: unknown };
    if (!b || typeof b !== "object") continue;
    if (b.type === "heading" && typeof b.id === "string") {
      const level = Number((b.props as { level?: unknown } | undefined)?.level) || 1;
      out.push({ id: b.id, level: Math.min(4, Math.max(1, level)), text: inlineText(b.content).trim() });
    }
    if (Array.isArray(b.children)) outlineOf(b.children, out, depth + 1);
  }
  return out;
}

/** Plain text of a block tree, one block per line, children indented. */
export function blocksText(input: unknown, depth = 0, max = 400_000): string {
  if (!Array.isArray(input)) return "";
  // What the page says, not what is suggested (search, previews, exports read this).
  const blocks: unknown[] = depth === 0 ? sanitizeBlocks(input) : input;
  const lines: string[] = [];
  let size = 0;
  for (const raw of blocks) {
    const b = raw as BlockLike;
    if (!b || typeof b !== "object") continue;
    let line = inlineText(b.content);
    if (!line && b.props) {
      const p = b.props;
      line = String(p.caption || p.name || p.title || p.url || p.latex || "");
    }
    if (line) {
      lines.push(`${"  ".repeat(depth)}${line}`);
      size += line.length;
    }
    if (Array.isArray(b.children) && b.children.length) {
      // Columns are layout only: their blocks read as if they were stacked.
      const flat = b.type === "columnList" || b.type === "column" || b.type === "tabs";
      const sub = blocksText(b.children, flat ? depth : depth + 1, max - size);
      if (sub) {
        lines.push(sub);
        size += sub.length;
      }
    }
    if (size > max) break;
  }
  return lines.join("\n");
}

/**
 * Fresh copies of a page tree (a public page duplicated into one's own
 * workspace): new ids everywhere — parents, page / database / synced blocks,
 * mentions, relations — the root at the top level, no comments or sharing.
 */
export function copyNotes(notes: readonly Note[], rootId: string, now = Date.now()): { notes: Note[]; rootId: string } {
  const map = new Map(notes.map((n) => [n.id, newNoteId()]));
  const out = notes.map((n) => {
    const c = remapNote(structuredClone(n) as Note, map);
    c.id = map.get(n.id) as string;
    c.parentId = n.id === rootId ? null : n.parentId ? (map.get(n.parentId) ?? n.parentId) : null;
    delete c.share;
    delete c.comments;
    c.favorite = false;
    c.createdAt = now;
    c.updatedAt = now;
    return c;
  });
  return { notes: out, rootId: map.get(rootId) as string };
}

/**
 * A copied note's references pointed at the other copies (`map`: old id →
 * new id; other ids stay): page / database / synced blocks and mentions,
 * relations and their values, the default template, "add page" automations.
 * A form's public link stays with the original database. Mutates `c`.
 */
export function remapNote(c: Note, map: ReadonlyMap<string, string>): Note {
  const re = (id: string) => map.get(id) ?? id;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o = { ...(v as Record<string, unknown>) };
    if (o.props && typeof o.props === "object") {
      const p = o.props as Record<string, unknown>;
      if (typeof p.noteId === "string") o.props = { ...p, noteId: re(p.noteId) };
    }
    if (Array.isArray(o.content)) o.content = walk(o.content);
    if (Array.isArray(o.children)) o.children = walk(o.children);
    return o;
  };
  c.content = walk(c.content) as unknown[];
  if (c.props) c.props = Object.fromEntries(Object.entries(c.props).map(([k, v]) => [k, Array.isArray(v) ? v.map(re) : v]));
  if (c.db) {
    const db = c.db;
    c.db = {
      ...db,
      properties: db.properties.map((p) => (p.relation ? { ...p, relation: { ...p.relation, dbId: re(p.relation.dbId) } } : p)),
      views: db.views.map((x) => {
        const v = x.source || x.template ? { ...x, ...(x.source ? { source: re(x.source) } : {}), ...(x.template ? { template: re(x.template) } : {}) } : x;
        if (!v.form?.shareId) return v;
        const { shareId: _link, ...form } = v.form;
        void _link;
        return { ...v, form };
      }),
      ...(db.linked ? { linked: db.linked.map(re) } : {}),
      ...(db.defaultTemplate ? { defaultTemplate: re(db.defaultTemplate) } : {}),
      ...(db.automations ? { automations: db.automations.map((a) => ({ ...a, actions: a.actions.map((x) => (x.type === "addPage" ? { ...x, dbId: re(x.dbId) } : x)) })) } : {}),
    };
  }
  return c;
}

/** A copy of blocks without ids (the editor gives inserted blocks new ones). */
export function withoutBlockIds(blocks: readonly unknown[]): unknown[] {
  return blocks.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const { id: _id, children, ...rest } = raw as { id?: string; children?: unknown[] };
    void _id;
    return { ...structuredClone(rest), ...(Array.isArray(children) ? { children: withoutBlockIds(children) } : {}) };
  });
}

/** Notes whose content a page's synced blocks show. */
export function syncedIds(blocks: unknown, out: string[] = []): string[] {
  if (!Array.isArray(blocks)) return out;
  for (const raw of blocks) {
    const b = raw as BlockLike;
    if (!b || typeof b !== "object") continue;
    if (b.type === "synced" && typeof b.props?.noteId === "string" && b.props.noteId) out.push(b.props.noteId);
    if (Array.isArray(b.children)) syncedIds(b.children, out);
  }
  return out;
}

/** Ids of the sub-pages / inline databases a page's body links to (page blocks). */
export function linkedChildIds(blocks: unknown, out: string[] = []): string[] {
  if (!Array.isArray(blocks)) return out;
  for (const raw of blocks) {
    const b = raw as BlockLike;
    if (!b || typeof b !== "object") continue;
    if ((b.type === "page" || b.type === "database") && typeof b.props?.noteId === "string") out.push(b.props.noteId);
    if (Array.isArray(b.children)) linkedChildIds(b.children, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tree helpers

/** A data source of the database it sits in (a database note marked so; lib/notes/sources.ts). */
export function isSourceNote(n: Pick<Note, "kind"> & { db?: Pick<DbSchema, "dataSource"> }): boolean {
  return n.kind === "database" && n.db?.dataSource === true;
}

/** A database's row: a page (or a wiki's database) under a database — not one of its data sources. */
export function isRow(n: Pick<Note, "parentId"> & Partial<Pick<Note, "kind" | "db">>, byId: ReadonlyMap<string, Note>): boolean {
  const parent = n.parentId ? byId.get(n.parentId) : undefined;
  return parent?.kind === "database" && !(n.kind && isSourceNote({ kind: n.kind, db: n.db }));
}

/** Live (not trashed) children shown in the sidebar tree, in order. Rows are not. */
export function treeChildren(parentId: string | null, all: readonly Note[], byId: ReadonlyMap<string, Note>): Note[] {
  const parent = parentId ? byId.get(parentId) : undefined;
  if (parent?.kind === "database") return [];
  return all.filter((n) => n.parentId === parentId && n.trashedAt === null).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/**
 * Pages cut off from the tree: the parent was deleted for good on another
 * device, or two devices moved pages into each other (a cycle). The sidebar
 * shows them at the top level so they can be found and moved back. For a
 * cycle, its member with the smallest id stands for it.
 */
export function lostRoots(all: readonly Note[], byId: ReadonlyMap<string, Note>): Note[] {
  const out: Note[] = [];
  for (const n of all) {
    if (n.parentId === null || n.trashedAt !== null || n.synced || n.template) continue;
    if (!byId.has(n.parentId)) {
      out.push(n);
      continue;
    }
    const seen = new Set<string>([n.id]);
    let cur = byId.get(n.parentId);
    // A trashed ancestor is not lost: the subtree is in the trash.
    while (cur && cur.parentId !== null && cur.trashedAt === null && !seen.has(cur.id) && byId.has(cur.parentId)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    if (cur && seen.has(cur.id) && cur.id === n.id && [...seen].every((id) => id >= n.id)) out.push(n);
  }
  return out.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/** Root → note chain (breadcrumbs); stops on cycles. */
export function ancestry(id: string, byId: ReadonlyMap<string, Note>): Note[] {
  const chain: Note[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/** The note and every descendant (pages, databases and rows). */
export function subtreeIds(id: string, all: readonly Note[]): string[] {
  const kids = new Map<string, string[]>();
  for (const n of all) {
    if (!n.parentId) continue;
    const list = kids.get(n.parentId) ?? [];
    list.push(n.id);
    kids.set(n.parentId, list);
  }
  const out: string[] = [];
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const k of kids.get(cur) ?? []) stack.push(k);
  }
  return out;
}

/** An order value between two neighbours (fractional indexing). */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return Date.now();
  if (before === undefined) return (after as number) - 1024;
  if (after === undefined) return before + 1024;
  return (before + after) / 2;
}

/** "Page title-<id>" for the URL hash (Notion-style readable links). */
export function noteSlug(n: Pick<Note, "id" | "title">): string {
  const words = n.title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return words ? `${words}-${n.id}` : n.id;
}

/** The note id at the end of a slug ("Title-<id>" or "<id>"). */
export function idFromSlug(slug: string): string | null {
  const m = /([A-Za-z0-9]{32})$/.exec(slug) ?? /^([A-Za-z0-9_-]{6,64})$/.exec(slug);
  return m ? m[1] : null;
}

/** The page an in-app link points at: /docs#Title-<id> (with ?ws=…, or a full URL of this site `base`; older links said /notes). */
export function linkedNoteId(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin || !/^\/(docs|notes)\/?$/.test(u.pathname)) return null;
    const slug = decodeURIComponent(u.hash.slice(1)).split(/[?&]/)[0];
    return slug ? idFromSlug(slug) : null;
  } catch {
    return null;
  }
}

export function displayTitle(n: Pick<Note, "title"> | undefined, untitled: string): string {
  const t = n?.title.trim();
  return t ? t : untitled;
}

/**
 * Public copies: links and media keep only safe URLs (http(s), mailto,
 * same-origin paths); anything else (javascript:, data:text/html…) is
 * dropped, the link text stays as plain text. Comment marks are dropped.
 */
export function sanitizeBlocks(blocks: unknown, depth = 0): unknown[] {
  if (!Array.isArray(blocks) || depth > 40) return [];
  const cleanInline = (content: unknown): unknown => {
    if (!Array.isArray(content)) {
      const t = content as { type?: string; rows?: { cells?: unknown[] }[] } | null;
      if (t && t.type === "tableContent" && Array.isArray(t.rows)) {
        return { ...t, rows: t.rows.map((r) => ({ ...r, cells: (r.cells ?? []).map((c) => (typeof c === "object" && c !== null && "content" in c ? { ...(c as object), content: cleanInline((c as { content: unknown }).content) } : cleanInline(c))) })) };
      }
      return content;
    }
    const out: unknown[] = [];
    for (const raw of content) {
      const n = raw as { type?: string; href?: string; content?: unknown };
      if (n && typeof n === "object" && n.type === "link") {
        if (typeof n.href === "string" && safeUrl(n.href)) out.push({ ...n, content: cleanInline(n.content) });
        else if (Array.isArray(n.content)) out.push(...(cleanInline(n.content) as unknown[]));
        continue;
      }
      // Inline-discussion marks point at comments that stay with the owner;
      // suggested edits are not the page yet: their text stays out, text they would remove stays in.
      const styles = (n as { styles?: Record<string, unknown> } | null)?.styles;
      if (styles && typeof styles === "object" && SUGGEST_INS in styles) continue;
      if (styles && typeof styles === "object" && ("comment" in styles || SUGGEST_DEL in styles)) {
        const { comment: _thread, [SUGGEST_DEL]: _del, ...rest } = styles;
        void _thread;
        void _del;
        out.push({ ...(n as object), styles: rest });
        continue;
      }
      out.push(raw);
    }
    return out;
  };
  // A block suggested in suggestion mode is not the page yet either.
  return blocks.filter((raw) => !blockSuggestion((raw as { id?: unknown } | null)?.id)).map((raw) => {
    const b = raw as { type?: string; props?: Record<string, unknown>; content?: unknown; children?: unknown };
    if (!b || typeof b !== "object") return b;
    let props = b.props;
    if (props && typeof props.url === "string" && props.url && !safeUrl(props.url, b.type === "image")) props = { ...props, url: "" };
    if (props && typeof props.image === "string" && props.image && !safeUrl(props.image, true)) props = { ...props, image: "" };
    if (props && typeof props.icon === "string" && /^(javascript|data):/i.test(props.icon)) props = { ...props, icon: "" };
    return {
      ...b,
      ...(props ? { props } : {}),
      ...(b.content !== undefined ? { content: cleanInline(b.content) } : {}),
      ...(Array.isArray(b.children) ? { children: sanitizeBlocks(b.children, depth + 1) } : {}),
    };
  });
}
