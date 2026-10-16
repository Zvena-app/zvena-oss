// Issue filters and display options: validation (the server never trusts
// what it receives) and a compact URL form (?status=…&assignee=me&layout=board)
// so every view can be shared by link. Pure: used on both sides.

import {
  COMPLETED_RANGES,
  DEFAULT_DISPLAY,
  DISPLAY_PROPS,
  GROUPINGS,
  LAYOUTS,
  ORDERINGS,
  STATUS_CATEGORIES,
  isPriority,
  type DisplayProp,
  type DueFilter,
  type IssueDisplay,
  type IssueFilter,
  type Priority,
  type RecentFilter,
  type StatusCategory,
} from "./types";

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DUES: readonly DueFilter[] = ["overdue", "today", "week", "month", "none", "any"];
const RECENT: readonly RecentFilter[] = ["day", "week", "month"];

function ids(v: unknown, extra: readonly string[] = [], max = 100): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((x): x is string => typeof x === "string" && (ID_RE.test(x) || extra.includes(x))))].slice(0, max);
  return out.length ? out : undefined;
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** A clean filter from anything (unknown keys and bad values are dropped). */
export function cleanFilter(raw: unknown): IssueFilter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const f: IssueFilter = {};
  if (typeof r.q === "string" && r.q.trim()) f.q = r.q.trim().slice(0, 200);
  const team = ids(r.team);
  if (team) f.team = team;
  const status = ids(r.status);
  if (status) f.status = status;
  if (Array.isArray(r.category)) {
    const c = [...new Set(r.category.filter((x): x is StatusCategory => (STATUS_CATEGORIES as readonly unknown[]).includes(x)))];
    if (c.length) f.category = c;
  }
  const assignee = ids(r.assignee, ["me", "none"]);
  if (assignee) f.assignee = assignee;
  const creator = ids(r.creator, ["me"]);
  if (creator) f.creator = creator;
  if (Array.isArray(r.priority)) {
    const p = [...new Set(r.priority.map(Number).filter(isPriority))] as Priority[];
    if (p.length) f.priority = p;
  }
  const label = ids(r.label);
  if (label) f.label = label;
  if (r.labelMode === "all") f.labelMode = "all";
  const project = ids(r.project, ["none"]);
  if (project) f.project = project;
  const cycle = ids(r.cycle, ["none", "current"]);
  if (cycle) f.cycle = cycle;
  const due = oneOf(r.due, DUES);
  if (due) f.due = due;
  const created = oneOf(r.created, RECENT);
  if (created) f.created = created;
  const updated = oneOf(r.updated, RECENT);
  if (updated) f.updated = updated;
  if (r.blocked === true) f.blocked = true;
  if (r.blocking === true) f.blocking = true;
  if (typeof r.parent === "string" && ID_RE.test(r.parent)) f.parent = r.parent;
  if (r.subscribed === true) f.subscribed = true;
  if (r.archived === true) f.archived = true;
  if (r.triage === true) f.triage = true;
  if (r.snoozed === true) f.snoozed = true;
  return f;
}

export function cleanDisplay(raw: unknown): Partial<IssueDisplay> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d: Partial<IssueDisplay> = {};
  const layout = oneOf(r.layout, LAYOUTS);
  if (layout) d.layout = layout;
  const group = oneOf(r.group, GROUPINGS);
  if (group) d.group = group;
  const order = oneOf(r.order, ORDERINGS);
  if (order) d.order = order;
  const completed = oneOf(r.completed, COMPLETED_RANGES);
  if (completed) d.completed = completed;
  if (typeof r.subIssues === "boolean") d.subIssues = r.subIssues;
  if (typeof r.emptyGroups === "boolean") d.emptyGroups = r.emptyGroups;
  if (Array.isArray(r.props)) d.props = [...new Set(r.props.filter((x): x is DisplayProp => (DISPLAY_PROPS as readonly unknown[]).includes(x)))];
  return d;
}

export function fullDisplay(d: Partial<IssueDisplay> | undefined, base: IssueDisplay = DEFAULT_DISPLAY): IssueDisplay {
  return { ...base, ...(d ?? {}) };
}

export function isEmptyFilter(f: IssueFilter): boolean {
  return Object.keys(f).length === 0;
}

/** How many separate conditions a filter has (the badge on the Filter button). */
export function filterCount(f: IssueFilter): number {
  return Object.keys(f).filter((k) => k !== "q" && k !== "labelMode").length;
}

// --- URL form ------------------------------------------------------------------

const LIST_KEYS = ["team", "status", "category", "assignee", "creator", "priority", "label", "project", "cycle"] as const;
const FLAG_KEYS = ["blocked", "blocking", "subscribed", "archived", "triage", "snoozed"] as const;

/** Writes the filter into URL parameters (lists comma-separated). */
export function filterToParams(f: IssueFilter, p: URLSearchParams = new URLSearchParams()): URLSearchParams {
  if (f.q) p.set("q", f.q);
  for (const k of LIST_KEYS) {
    const v = f[k];
    if (v && v.length) p.set(k, (v as readonly (string | number)[]).join(","));
  }
  if (f.labelMode === "all") p.set("labelMode", "all");
  if (f.due) p.set("due", f.due);
  if (f.created) p.set("created", f.created);
  if (f.updated) p.set("updated", f.updated);
  if (f.parent) p.set("parent", f.parent);
  for (const k of FLAG_KEYS) if (f[k]) p.set(k, "1");
  return p;
}

export function filterFromParams(p: URLSearchParams): IssueFilter {
  const raw: Record<string, unknown> = {};
  if (p.get("q")) raw.q = p.get("q");
  for (const k of LIST_KEYS) {
    const v = p.get(k);
    if (v) raw[k] = v.split(",").map((x) => (k === "priority" ? Number(x) : x));
  }
  for (const k of ["labelMode", "due", "created", "updated", "parent"] as const) if (p.get(k)) raw[k] = p.get(k);
  for (const k of FLAG_KEYS) if (p.get(k) === "1") raw[k] = true;
  return cleanFilter(raw);
}

/** Display options that differ from `base`, as URL parameters. */
export function displayToParams(d: IssueDisplay, base: IssueDisplay = DEFAULT_DISPLAY, p: URLSearchParams = new URLSearchParams()): URLSearchParams {
  if (d.layout !== base.layout) p.set("layout", d.layout);
  if (d.group !== base.group) p.set("group", d.group);
  if (d.order !== base.order) p.set("order", d.order);
  if (d.completed !== base.completed) p.set("completed", d.completed);
  if (d.subIssues !== base.subIssues) p.set("sub", d.subIssues ? "1" : "0");
  if (d.emptyGroups !== base.emptyGroups) p.set("empty", d.emptyGroups ? "1" : "0");
  if (d.props.join(",") !== base.props.join(",")) p.set("props", d.props.join(",") || "-");
  return p;
}

export function displayFromParams(p: URLSearchParams, base: IssueDisplay = DEFAULT_DISPLAY): IssueDisplay {
  const raw: Record<string, unknown> = {};
  for (const k of ["layout", "group", "order", "completed"] as const) if (p.get(k)) raw[k] = p.get(k);
  if (p.get("sub")) raw.subIssues = p.get("sub") === "1";
  if (p.get("empty")) raw.emptyGroups = p.get("empty") === "1";
  if (p.get("props")) raw.props = p.get("props") === "-" ? [] : (p.get("props") as string).split(",");
  return fullDisplay(cleanDisplay(raw), base);
}
