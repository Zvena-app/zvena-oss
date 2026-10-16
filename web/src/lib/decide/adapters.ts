// How reactions see and touch the products. Server-only.
//
// A subject is what a reaction judges: one metric, one Documents row… with
// its facts by human name ("Статус", "Прогресс", "value"). An action changes a
// product through the product's own write path, so its rules (sanitizing,
// quotas, history, the pulse to every open tab) apply as if a person did it.
//
// Documents and Projects are wired here (a goal is an issue: "when revenue
// reaches 1M, mark the goal done"); Design plugs in the same way: a `when`
// type, facts for its subjects and its actions.

import { blocksText, sanitizeNote } from "../notes/model";
import { AccessResolver, atLeast } from "../notes/access";
import { deniedColumns } from "../notes/column-perms";
import { pushNotes } from "../notes/server-store";
import type { DbProperty, Note, PropValue } from "../notes/types";
import type { PulseEvent } from "../pulse/bus";
import { ctxFor, type Ctx } from "../projects/core";
import { createIssue, getIssueBrief, updateIssue, type IssueInput } from "../projects/issues";
import { getProject, listProjects } from "../projects/planning";
import { listStatuses, statusOfCategory, statusRow, defaultStatus, listTeams } from "../projects/teams";
import type { StatusCategory } from "../projects/types";
import { backlinksOf, linksOf } from "../eco/links";
import { sql } from "../store";
import type { Action, When } from "./model";
import { metricReadable } from "./sources";

export interface Subject {
  /** Stable id of what is judged ("metric:revenue", "note:<row id>"): the edge is kept per subject. */
  key: string;
  facts: Record<string, unknown>;
  /** The Documents row that fired (for "$row" in actions). */
  rowId?: string;
  /** The issue that fired (for "$subject" in actions). */
  issueId?: string;
  /**
   * Facts the model never gets, though rules may compare them: those that name or reach a person
   * (assignee, person, e-mail, phone columns) and computed ones that may read such a column or a
   * page the author cannot open (formulas, rollups, relations; files and buttons hold no words).
   */
  personal?: string[];
  /** What the model may read of a page's text ("@body"): the text without the people it mentions. */
  bodyForModel?: () => string;
}

/** Column types whose values name or reach a person. */
const PERSONAL_TYPES = new Set(["person", "created_by", "last_edited_by", "email", "phone"]);

/**
 * Column types never sent to the model, whatever a rule or an automation lists: files and buttons
 * hold no words; formulas, rollups and relations may read columns that name a person, or pages
 * the author cannot open.
 */
export const NOT_SENT_TYPES: ReadonlySet<DbProperty["type"]> = new Set<DbProperty["type"]>(["button", "files", "formula", "rollup", "relation"]);

/** A page's blocks without the people they mention (@name chips): what the model may read of its text. */
export function withoutPeople(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isPersonMention(x)).map(withoutPeople);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutPeople(x)]));
  return v;
}

function isPersonMention(x: unknown): boolean {
  const n = x as { type?: unknown; props?: { userId?: unknown; name?: unknown } } | null;
  return Boolean(n && typeof n === "object" && n.type === "mention" && (n.props?.userId || n.props?.name));
}

/** The names of a database's columns that name or reach a person (never sent to the model). */
export function personalColumns(props: DbProperty[]): string[] {
  return props.filter((p) => PERSONAL_TYPES.has(p.type)).map((p) => p.name);
}

/**
 * The subjects one event brings to a reaction's `when` (none: the event is
 * not for it). Projects subjects are read as the rule's author: an issue they
 * cannot see (a private team) is no subject of theirs.
 */
export function subjectsFor(ws: string, when: When, e: PulseEvent, ruleId?: string): Subject[] {
  if (when.type === "metric") {
    if (e.type !== "metric" || e.ref !== when.key) return [];
    // A number counted from the workspace is read as the rule's author: one they may not see
    // (someone else's mail, pages hidden from them) is no subject of theirs.
    if (!metricReadable(ws, when.key, ruleId ? ruleAuthor(ws, `rule:${ruleId}`) : null)) return [];
    return [{ key: `metric:${when.key}`, facts: { value: e.data?.value ?? null, key: when.key, label: e.data?.label ?? null } }];
  }
  if (when.type === "notes") {
    if (e.type !== "notes") return [];
    const ids = e.ref ? [e.ref] : (e.refs ?? []);
    // Rows are read as the rule's author: a row they cannot open is no subject of theirs.
    const reader = ruleId ? docsReader(ws, `rule:${ruleId}`) : null;
    if (!reader || reader.level(when.db) === null) return [];
    const db = loadNote(ws, when.db);
    if (!db?.db) return [];
    // Columns hidden from the author (column permissions) are no facts of theirs: not in a
    // title, not in a comparison, never sent to the model.
    const hidden = deniedColumns(db.db, { id: reader.userId, groups: reader.groups, full: reader.level(when.db) === "full" });
    const props = db.db.properties.filter((p) => hidden.get(p.id) !== "view");
    const personal = [...personalColumns(props), ...props.filter((p) => NOT_SENT_TYPES.has(p.type)).map((p) => p.name)];
    const out: Subject[] = [];
    for (const id of ids) {
      const row = loadNote(ws, id);
      if (!row || row.parentId !== when.db || row.template || row.trashedAt !== null) continue;
      if (reader.level(id) === null) continue;
      const bodyForModel = () => blocksText(withoutPeople(row.content), 0, 4000).slice(0, 4000);
      out.push({ key: `note:${id}`, facts: rowFacts(row, props), rowId: id, personal, bodyForModel });
    }
    return out;
  }
  if (when.type === "projects") {
    if (e.type !== "projects" || !e.ref || e.data?.deleted === true) return [];
    if (e.data?.entity !== undefined && e.data.entity !== "issue") return [];
    const ctx = ruleId ? ruleCtx(ws, `rule:${ruleId}`, "read") : null;
    if (!ctx) return [];
    let issue;
    try {
      issue = getIssueBrief(ctx, e.ref);
    } catch {
      return [];
    }
    if (when.project && issue.projectId !== when.project) return [];
    return [{ key: `issue:${issue.id}`, facts: issueFacts(ctx, issue), issueId: issue.id, personal: ["Assignee"] }];
  }
  return [];
}

// ------------------------------------------------------------------ Projects

/**
 * Rules see and act in Projects as the person who wrote them, while they may
 * still do so there (Projects' own checks then apply: private teams, roles).
 * Never as anyone else: a rule whose author left, lost the right, or that was
 * deleted does nothing.
 */
function ruleCtx(ws: string, by: string, need: "read" | "edit" = "edit"): Ctx | null {
  const author = ruleAuthor(ws, by);
  if (!author) return null;
  try {
    return ctxFor(author, ws, need);
  } catch {
    return null;
  }
}

/** Who last wrote the rule behind `by` ("rule:<id>"): its actions and reads are theirs. */
function ruleAuthor(ws: string, by: string): string | null {
  const ruleId = by.startsWith("rule:") ? by.slice(5) : null;
  if (!ruleId) return null;
  return (sql("SELECT updated_by FROM dz_reactions WHERE id = ? AND ws = ?").get(ruleId, ws) as { updated_by: string | null } | undefined)?.updated_by ?? null;
}

/** The rule's author in Documents (page access, column permissions); null when there is no author. */
function docsReader(ws: string, by: string): AccessResolver | null {
  const author = ruleAuthor(ws, by);
  return author ? new AccessResolver(ws, author) : null;
}

/** A project the context may see (a project of private teams only is "not there" for others). */
function visibleProject(ctx: Ctx, id: string): boolean {
  return listProjects(ctx).some((p) => p.id === id);
}

/** Facts computed once per event and person (several rules hear the same event). */
const factsCache = new Map<string, Record<string, unknown>>();

/** An issue's facts the way a person reads them ("Status": "In Progress", "Progress": 0.5…). Cheap: one row per lookup. */
function issueFacts(ctx: Ctx, i: ReturnType<typeof getIssueBrief>): Record<string, unknown> {
  const k = `${ctx.userId}|${i.id}|${i.updatedAt}`;
  const hit = factsCache.get(k);
  if (hit) return hit;
  let status: { name: string; category: string } | null = null;
  try {
    status = statusRow(ctx, i.statusId);
  } catch {
    status = null;
  }
  const assignee = i.assigneeId ? ((sql("SELECT name FROM users WHERE id = ?").get(i.assigneeId) as { name: string } | undefined)?.name ?? null) : null;
  let project: string | null = null;
  if (i.projectId) {
    try {
      project = getProject(ctx, i.projectId).name;
    } catch {
      project = null;
    }
  }
  const facts = {
    Title: i.title,
    Identifier: i.identifier,
    Status: status?.name ?? null,
    Category: status?.category ?? null,
    Done: status?.category === "completed",
    Priority: i.priority,
    Assignee: assignee,
    Due: i.dueDate,
    Project: project,
    "Sub-issues": i.subIssues.total,
    "Sub-issues done": i.subIssues.done,
    Progress: i.subIssues.total ? i.subIssues.done / i.subIssues.total : null,
  };
  factsCache.set(k, facts);
  if (factsCache.size > 2000) factsCache.clear();
  return facts;
}

const CATEGORIES: readonly StatusCategory[] = ["backlog", "unstarted", "started", "completed", "canceled"];

function issueAction(ws: string, a: Extract<Action, { do: "issue.done" | "issue.set" }>, subject: Subject, by: string): boolean {
  const id = a.issue === "$subject" ? subject.issueId : a.issue;
  // The issue's history says it was done automatically (with the author's rights), as for the autopilot.
  const base = id ? ruleCtx(ws, by) : null;
  const ctx: Ctx | null = base ? { ...base, via: "auto" } : null;
  if (!id || !ctx) return false;
  let issue;
  try {
    issue = getIssueBrief(ctx, id);
  } catch {
    return false;
  }
  const input: IssueInput = {};
  if (a.do === "issue.done") {
    // Already done (in any of its team's completed statuses, "Released" too): left as it is.
    if (listStatuses(ctx).find((st) => st.id === issue.statusId)?.category === "completed") return false;
    const done = statusOfCategory(issue.teamId, "completed") ?? defaultStatus(issue.teamId);
    if (done === issue.statusId) return false;
    input.statusId = done;
  } else if (a.field === "status") {
    const want = String(a.value ?? "").trim().toLowerCase();
    const cat = CATEGORIES.find((c) => c === want);
    const statusId = cat ? statusOfCategory(issue.teamId, cat) : listStatuses(ctx).find((s) => s.teamId === issue.teamId && s.name.trim().toLowerCase() === want)?.id;
    if (!statusId || statusId === issue.statusId) return false;
    input.statusId = statusId;
  } else if (a.field === "priority") {
    const p = Number(a.value);
    if (!Number.isInteger(p) || p < 0 || p > 4 || p === issue.priority) return false;
    input.priority = p;
  } else if (a.field === "assignee") {
    if ((a.value ?? null) === issue.assigneeId) return false;
    input.assigneeId = a.value === null ? null : String(a.value);
  } else {
    const due = a.value === null ? null : String(a.value);
    if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
    if (due === issue.dueDate) return false;
    input.dueDate = due;
  }
  try {
    updateIssue(ctx, id, input);
    return true;
  } catch {
    return false;
  }
}

/** "{Name}" in a title: that fact of the subject (a form row's field), as text. */
function fillTitle(title: string, facts: Record<string, unknown>): string {
  return title
    .replace(/\{([^{}]{1,80})\}/g, (_, k: string) => {
      const v = facts[k.trim()];
      return v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function createAction(ws: string, a: Extract<Action, { do: "issue.create" }>, subject: Subject, by: string, created: string[]): boolean {
  const ctx = ruleCtx(ws, by);
  const title = fillTitle(a.title, subject.facts);
  if (!ctx || !title) return false;
  const teams = listTeams(ctx).filter((t) => !t.archivedAt);
  const teamId = a.teamId ? teams.find((t) => t.id === a.teamId)?.id : (teams.find((t) => t.isMember) ?? teams[0])?.id;
  if (!teamId) return false;
  if (a.projectId && !visibleProject(ctx, a.projectId)) return false;
  try {
    const issue = createIssue(ctx, { teamId, title, ...(a.projectId ? { projectId: a.projectId } : {}) });
    created.push(issue.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * What "done" follows from an object: things made from it or for it, things
 * that hold it (a live block, a relation) and links people made by hand —
 * not pages or issues that merely mention it in passing.
 */
const STRONG = new Set(["embed", "converted", "manual", "relation"]);

function linkedForDone(ws: string, from: string): Set<string> {
  const keys = new Set<string>();
  for (const l of linksOf(ws, from)) if (STRONG.has(l.via) && l.part === "") keys.add(l.dst);
  for (const l of backlinksOf(ws, from)) if (STRONG.has(l.via) && l.part === "") keys.add(l.src);
  keys.delete(from);
  return keys;
}

/** Everything linked with `from`, both ways, that can be done. */
function linksAction(ws: string, a: Extract<Action, { do: "links.done" }>, subject: Subject, by: string): boolean {
  const from = a.from === "$subject" ? (subject.issueId ? `issue:${subject.issueId}` : null) : a.from === "$row" ? (subject.rowId ? `note:${subject.rowId}` : null) : a.from;
  if (!from) return false;
  const kinds = a.kinds ?? ["note", "issue"];
  const keys = linkedForDone(ws, from);
  let changed = false;
  for (const k of keys) {
    const [kind, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    if (kind === "note" && kinds.includes("note")) changed = notesAction(ws, { do: "notes.done", note: id }, subject, by) || changed;
    if (kind === "issue" && kinds.includes("issue")) changed = issueAction(ws, { do: "issue.done", issue: id }, subject, by) || changed;
  }
  return changed;
}

/** The objects an action writes (the engine keeps them from re-firing the same rule). */
export function targetsOf(ws: string, a: Action, subject: Subject): string[] {
  if (a.do === "notes.done" || a.do === "notes.set") {
    const id = a.note === "$row" ? subject.rowId : a.note;
    return id ? [id] : [];
  }
  if (a.do === "issue.done" || a.do === "issue.set") {
    const id = a.issue === "$subject" ? subject.issueId : a.issue;
    return id ? [id] : [];
  }
  if (a.do === "links.done") {
    const from = a.from === "$subject" ? (subject.issueId ? `issue:${subject.issueId}` : null) : a.from === "$row" ? (subject.rowId ? `note:${subject.rowId}` : null) : a.from;
    if (!from) return [];
    return [...linkedForDone(ws, from)].map((k) => k.slice(k.indexOf(":") + 1));
  }
  return [];
}

function loadNote(ws: string, id: string): Note | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  if (!r?.json) return null;
  try {
    return sanitizeNote(JSON.parse(r.json));
  } catch {
    return null;
  }
}

/** A row's values by property name, the way a person reads them (option names, dates as text). */
export function rowFacts(row: Note, props: DbProperty[]): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const p of props) {
    if (p.type === "title") {
      facts[p.name] = row.title;
      continue;
    }
    const v = row.props?.[p.id];
    if (v === undefined) continue;
    if ((p.type === "select" || p.type === "status") && typeof v === "string") facts[p.name] = p.options?.find((o) => o.id === v)?.name ?? null;
    else if (p.type === "multi_select" && Array.isArray(v)) facts[p.name] = v.map((id) => p.options?.find((o) => o.id === id)?.name).filter(Boolean);
    else if (v && typeof v === "object" && !Array.isArray(v) && "start" in v) facts[p.name] = v.end ? `${v.start} – ${v.end}` : v.start;
    else facts[p.name] = v;
  }
  facts["@body"] = blocksText(row.content, 0, 4000).slice(0, 4000);
  return facts;
}

function findProp(props: DbProperty[], nameOrId: string): DbProperty | undefined {
  const k = nameOrId.trim().toLowerCase();
  return props.find((p) => p.id === nameOrId) ?? props.find((p) => p.name.trim().toLowerCase() === k);
}

/** A value typed by a person ("Готово", "42", "да") as the property stores it, or undefined when it does not fit. */
function storedValue(p: DbProperty, v: PropValue): PropValue | undefined {
  if (v === null) return null;
  switch (p.type) {
    case "select":
    case "status": {
      const name = String(v).trim().toLowerCase();
      return p.options?.find((o) => o.id === v || o.name.trim().toLowerCase() === name)?.id;
    }
    case "checkbox":
      return v === true || v === "true" || v === "да" || v === 1;
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    }
    case "text":
    case "url":
    case "email":
    case "phone":
      return String(v).slice(0, 2000);
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? { start: v.slice(0, 40) } : undefined;
    default:
      return undefined;
  }
}

/**
 * Runs one action; true when it changed something. Writes go through each
 * product's own write path. Ids of objects it created land in `created`, so
 * the engine keeps the rule from firing on its own new objects.
 */
export function runAction(ws: string, a: Action, subject: Subject, by: string, created: string[] = []): boolean {
  if (a.do === "issue.done" || a.do === "issue.set") return issueAction(ws, a, subject, by);
  if (a.do === "issue.create") return createAction(ws, a, subject, by, created);
  if (a.do === "links.done") return linksAction(ws, a, subject, by);
  return notesAction(ws, a, subject, by);
}

function notesAction(ws: string, a: Extract<Action, { do: "notes.done" | "notes.set" }>, subject: Subject, by: string): boolean {
  const id = a.note === "$row" ? subject.rowId : a.note;
  if (!id) return false;
  // Documents rows change as the rule's author, while they may edit them there (their columns too).
  const author = ruleAuthor(ws, by);
  if (!author || !atLeast(new AccessResolver(ws, author).level(id), "edit")) return false;
  const row = loadNote(ws, id);
  if (!row || !row.parentId || row.trashedAt !== null) return false;
  const db = loadNote(ws, row.parentId);
  // A row of a trashed database (or of a database inside a trashed page) is in the trash too.
  for (let cur: Note | null = db, depth = 0; cur && depth < 50; depth++) {
    if (cur.trashedAt !== null) return false;
    cur = cur.parentId ? loadNote(ws, cur.parentId) : null;
  }
  const props = db?.db?.properties;
  if (!props) return false;
  let prop: DbProperty | undefined;
  let value: PropValue | undefined;
  if (a.do === "notes.done") {
    prop = props.find((p) => p.type === "status" && p.options?.some((o) => o.group === "done"));
    if (prop) value = prop.options?.find((o) => o.group === "done")?.id;
    else {
      prop = props.find((p) => p.type === "checkbox");
      value = prop ? true : undefined;
    }
  } else {
    prop = findProp(props, a.prop);
    value = prop ? storedValue(prop, a.value) : undefined;
  }
  if (!prop || value === undefined) return false;
  if (prop.type === "title") return false;
  if (JSON.stringify(row.props?.[prop.id] ?? null) === JSON.stringify(value)) return false;
  const next: Note = { ...row, props: { ...(row.props ?? {}), [prop.id]: value }, updatedAt: Date.now() };
  const res = pushNotes(ws, [{ id, note: next }], { by, quotaLeft: Infinity, access: { userId: author } });
  return res.saved.includes(id);
}
