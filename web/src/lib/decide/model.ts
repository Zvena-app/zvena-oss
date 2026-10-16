// zvena reactions: "when … if … then …" across products, kept per workspace.
//
//   when  a pulse event: a live number arrived (metric), a row of a Documents
//         database was saved (notes), an issue changed in Projects (projects);
//         Design adds its own through adapters (src/lib/decide/adapters.ts)
//   if    always | a comparison of one field (exact, instant, no AI) |
//         a yes/no question to Jev about the chosen fields only
//   then  actions of the products' adapters: a Documents row (notes.done,
//         notes.set), an issue (issue.done, issue.set, issue.create — a goal
//         is an issue), everything linked to something (links.done)
//
// A reaction fires on the edge: when its condition becomes true for a subject
// (a metric, a row), not again while it stays true. Pure types and the
// validation of untrusted input; the engine lives in engine.ts.

import type { PropValue } from "../notes/types";

export type When = { type: "metric"; key: string } | { type: "notes"; db: string } | { type: "projects"; entity: "issue"; project?: string };

export type CompareOp = ">=" | ">" | "<=" | "<" | "=" | "!=";

export type Condition =
  | { kind: "always" }
  | { kind: "compare"; field: string; op: CompareOp; value: number | string | boolean }
  | {
      kind: "ask";
      /** The question, in plain words, about the fields ("Is the goal in `Описание` reached?"). */
      question: string;
      /** The only fields sent to Jev (names of properties, "value", "@body"). */
      fields: string[];
      /** At or above: act at once. */
      auto: number;
      /** At or above (and below `auto`): ask a person to confirm. */
      suggest: number;
    };

export type Action =
  /** A Documents row: its status to the first "done" option (or its first checkbox on). "$row" = the row that fired. */
  | { do: "notes.done"; note: string }
  /** A Documents row: one property (by name or id; select/status by option name). */
  | { do: "notes.set"; note: string; prop: string; value: PropValue }
  /** An issue (a goal) to its team's first completed status. "$subject" = the issue that fired. */
  | { do: "issue.done"; issue: string }
  /** An issue: its status (by name, or a category: started, completed…), priority (0–4), assignee (user id or null), due (YYYY-MM-DD or null). */
  | { do: "issue.set"; issue: string; field: IssueField; value: string | number | null }
  /** A new issue; "{Name}" in the title takes that fact of the subject (a form row's "Name"). */
  | { do: "issue.create"; title: string; teamId?: string; projectId?: string }
  /** Everything linked with `from` (both ways) that can be done: Documents rows and issues. */
  | { do: "links.done"; from: string; kinds?: ("note" | "issue")[] };

export type IssueField = "status" | "priority" | "assignee" | "due";
const ISSUE_FIELDS: readonly IssueField[] = ["status", "priority", "assignee", "due"];
const REF_RE = /^(note|issue|project|design):[A-Za-z0-9_/-]{6,120}$/;

export interface Reaction {
  id: string;
  name: string;
  on: boolean;
  when: When;
  if: Condition;
  then: Action[];
}

export const MAX_REACTIONS = 50;
export const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const OPS: readonly CompareOp[] = [">=", ">", "<=", "<", "=", "!="];
const FIELD_RE = /^[^\u0000-\u001f]{1,80}$/;

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const unit = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : dflt);

function cleanWhen(v: unknown): When | null {
  const w = v as Record<string, unknown> | null;
  if (!w || typeof w !== "object") return null;
  if (w.type === "metric") {
    const key = str(w.key, 64);
    return key && /^[\p{L}\p{N}_.:-]+$/u.test(key) ? { type: "metric", key } : null;
  }
  if (w.type === "notes" && typeof w.db === "string" && ID_RE.test(w.db)) return { type: "notes", db: w.db };
  if (w.type === "projects" && (w.entity === undefined || w.entity === "issue")) {
    if (w.project === undefined || w.project === null || w.project === "") return { type: "projects", entity: "issue" };
    return typeof w.project === "string" && ID_RE.test(w.project) ? { type: "projects", entity: "issue", project: w.project } : null;
  }
  return null;
}

function cleanCondition(v: unknown): Condition | null {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || c.kind === "always") return { kind: "always" };
  if (c.kind === "compare") {
    const field = str(c.field, 80);
    const op = OPS.find((o) => o === c.op);
    const value = typeof c.value === "number" ? (Number.isFinite(c.value) ? c.value : null) : typeof c.value === "boolean" ? c.value : str(c.value, 200);
    return field && op && value !== null ? { kind: "compare", field, op, value } : null;
  }
  if (c.kind === "ask") {
    const question = str(c.question, 1000);
    const fields = (Array.isArray(c.fields) ? c.fields : []).filter((f): f is string => typeof f === "string" && FIELD_RE.test(f)).slice(0, 12);
    if (!question || fields.length === 0) return null;
    const auto = unit(c.auto, 0.9);
    const suggest = Math.min(unit(c.suggest, 0.6), auto);
    return { kind: "ask", question, fields, auto, suggest };
  }
  return null;
}

/** One action as stored or sent (untrusted). */
export function cleanAction(v: unknown): Action | null {
  const a = v as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  if (a.do === "issue.done" || a.do === "issue.set") {
    const issue = a.issue === "$subject" ? "$subject" : typeof a.issue === "string" && ID_RE.test(a.issue) ? a.issue : null;
    if (!issue) return null;
    if (a.do === "issue.done") return { do: "issue.done", issue };
    const field = ISSUE_FIELDS.find((f) => f === a.field);
    const value = a.value === null ? null : typeof a.value === "number" ? (Number.isFinite(a.value) ? a.value : undefined) : typeof a.value === "string" ? a.value.slice(0, 200) : undefined;
    return field && value !== undefined ? { do: "issue.set", issue, field, value } : null;
  }
  if (a.do === "issue.create") {
    const title = str(a.title, 300);
    if (!title) return null;
    const teamId = typeof a.teamId === "string" && ID_RE.test(a.teamId) ? a.teamId : undefined;
    const projectId = typeof a.projectId === "string" && ID_RE.test(a.projectId) ? a.projectId : undefined;
    return { do: "issue.create", title, ...(teamId ? { teamId } : {}), ...(projectId ? { projectId } : {}) };
  }
  if (a.do === "links.done") {
    const from = a.from === "$subject" || a.from === "$row" ? a.from : typeof a.from === "string" && REF_RE.test(a.from) ? a.from : null;
    if (!from) return null;
    const kinds = Array.isArray(a.kinds) ? a.kinds.filter((k): k is "note" | "issue" => k === "note" || k === "issue") : undefined;
    return { do: "links.done", from, ...(kinds?.length ? { kinds } : {}) };
  }
  const note = a.note === "$row" ? "$row" : typeof a.note === "string" && ID_RE.test(a.note) ? a.note : null;
  if (!note) return null;
  if (a.do === "notes.done") return { do: "notes.done", note };
  if (a.do === "notes.set") {
    const prop = str(a.prop, 80);
    const value = a.value === null || typeof a.value === "boolean" ? a.value : typeof a.value === "number" ? (Number.isFinite(a.value) ? a.value : undefined) : typeof a.value === "string" ? a.value.slice(0, 2000) : undefined;
    return prop && value !== undefined ? { do: "notes.set", note, prop, value } : null;
  }
  return null;
}

/** What an action names by placeholder: "$row" (a Documents row fired) or "$subject" (an issue fired). */
function placeholderOf(a: Action): string | null {
  if (a.do === "notes.done" || a.do === "notes.set") return a.note.startsWith("$") ? a.note : null;
  if (a.do === "issue.done" || a.do === "issue.set") return a.issue.startsWith("$") ? a.issue : null;
  if (a.do === "links.done") return a.from.startsWith("$") ? a.from : null;
  return null;
}

/** A reaction as sent by a browser (untrusted), or null when it makes no sense. */
export function cleanReaction(v: unknown): Reaction | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !ID_RE.test(r.id)) return null;
  const when = cleanWhen(r.when);
  const cond = cleanCondition(r.if);
  const then = (Array.isArray(r.then) ? r.then : []).slice(0, 10).map(cleanAction).filter((a): a is Action => a !== null);
  if (!when || !cond || then.length === 0) return null;
  // "$row" only means something when a row fired the reaction, "$subject" when an issue did.
  for (const a of then) {
    const ph = placeholderOf(a);
    if (ph === "$row" && when.type !== "notes") return null;
    if (ph === "$subject" && when.type !== "projects") return null;
    // An issue placeholder names an issue; a row placeholder a row.
    if (ph === "$row" && (a.do === "issue.done" || a.do === "issue.set")) return null;
  }
  return { id: r.id, name: str(r.name, 200) ?? "", on: r.on !== false, when, if: cond, then };
}

/** Compares a fact with the condition's value: numbers as numbers, the rest as text. */
export function compare(fact: unknown, op: CompareOp, value: number | string | boolean): boolean {
  if (fact === undefined || fact === null) return op === "!=";
  if (typeof value === "number") {
    const n = typeof fact === "number" ? fact : typeof fact === "string" && fact.trim() !== "" ? Number(fact.replace(/\s/g, "").replace(",", ".")) : NaN;
    if (!Number.isFinite(n)) return op === "!=";
    switch (op) {
      case ">=":
        return n >= value;
      case ">":
        return n > value;
      case "<=":
        return n <= value;
      case "<":
        return n < value;
      case "=":
        return n === value;
      case "!=":
        return n !== value;
    }
  }
  if (typeof value === "boolean") {
    const b = fact === true || fact === "true";
    return op === "!=" ? b !== value : op === "=" ? b === value : false;
  }
  const a = (Array.isArray(fact) ? fact.join(", ") : String(fact)).trim().toLowerCase();
  const b = value.trim().toLowerCase();
  if (op === "=") return a === b || (Array.isArray(fact) && fact.some((x) => String(x).toLowerCase() === b));
  if (op === "!=") return a !== b && !(Array.isArray(fact) && fact.some((x) => String(x).toLowerCase() === b));
  return op === ">=" ? a >= b : op === ">" ? a > b : op === "<=" ? a <= b : a < b;
}
