// What runs by itself did, and what it proposes, across the workspace. Server-only.
//
// Automatic work happens in several places: reactions (a goal's number reached its target,
// a rule fired), the hub's own steps (a parent issue closed with its last
// sub-issue, a goal linked to its number — lib/decide/cascade.ts, autogoal.ts;
// an issue that follows Design or Calendar — flows.ts), Documents' database
// automations (docs-smart.ts) and Projects' autopilot (fields of a new issue). Each keeps its own record
// (dz_decisions, pj_suggestions); this module reads them as one list, newest
// first, and is the one place a person confirms, dismisses or undoes any of it.
//
// The hub's records live in dz_decisions too, with what they did (or would do)
// in `actions` as {"kind": …}; reactions' records keep their list of actions.
// Like every decision, they hold ids and numbers, never content.

import { randomBytes } from "node:crypto";
import { AccessResolver } from "../notes/access";
import { keyVisible } from "../eco/visibility";
import { emit } from "../pulse/bus";
import { ctxFor, type Ctx } from "../projects/core";
import { getIssueBrief, updateIssue } from "../projects/issues";
import { resolveSuggestion } from "../projects/autopilot";
import { sql } from "../store";
import { decisionsOf, deleteReaction, ensureSchema, metricsOf, reactionsOf, resolveDecision, visibleRules } from "./engine";
import { cleanReaction, type Reaction } from "./model";
import { closeGoalProposals, goalIssueOf, setGoal, type GoalOp } from "./goals";
import { metricReadable, visibleMetrics } from "./sources";

/** What a hub record did or proposes (kept in dz_decisions.actions). */
export type HubPayload =
  /** An issue was made a goal on a number (or is proposed to be): the reaction saved. */
  | { kind: "goal"; reaction: Reaction; issue: string }
  /** A parent issue followed its sub-issues: closed with the last one (or reopened with one), from status `prev` to `status`. */
  | { kind: "parent"; issue: string; prev: string; status: string; reopen?: boolean }
  /** An issue followed another product (flows.ts): its status or due date, from `prev` to `next`. */
  | { kind: "issue"; issue: string; field: "status" | "due"; prev: string | null; next: string | null; why: IssueWhy; from: string }
  /**
   * A database automation ran on a row (or by the clock: row null), or waits for a person's yes
   * (`facts`: a hash of what the model judged; the yes holds while the page says the same).
   * `prev`/`next`: the values it set that can be put back (options, numbers, dates, checkboxes,
   * people — ids, never text); `added`: pages it made. `onlyIf`: its "run only if" condition, as saved.
   */
  | { kind: "automation"; db: string; row: string | null; automation: string; onlyIf?: string; facts?: string; prev?: Record<string, unknown>; next?: Record<string, unknown>; added?: string[] };

export type IssueWhy = "thread_resolved" | "thread_reopened" | "event_moved";
const WHYS = new Set<IssueWhy>(["thread_resolved", "thread_reopened", "event_moved"]);
const KINDS = new Set(["goal", "parent", "issue", "automation"]);
const IDISH = /^[A-Za-z0-9_-]{1,64}$/;
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** What some kinds do when a person accepts or undoes them, registered by their module (docs-smart.ts). */
export interface KindHandler {
  accept?(ws: string, id: string, p: HubPayload, by: string): Settle;
  undo?(ws: string, p: HubPayload, by: string): Settle;
}
// On globalThis: the server's bundles (instrumentation, each route) share one hub.
const HANDLERS = Symbol.for("zvena.decide.journal-kinds");
const gk = globalThis as unknown as Record<symbol, Map<HubPayload["kind"], KindHandler> | undefined>;
const handlers: Map<HubPayload["kind"], KindHandler> = (gk[HANDLERS] ??= new Map());
export function registerHubKind(kind: HubPayload["kind"], h: KindHandler): void {
  handlers.set(kind, h);
}

function payloadOf(json: string | null): HubPayload | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (!v || Array.isArray(v) || typeof v !== "object" || !KINDS.has(String(v.kind))) return null;
    if (v.kind === "goal") {
      const r = cleanReaction(v.reaction);
      return r && typeof v.issue === "string" ? { kind: "goal", reaction: r, issue: v.issue } : null;
    }
    if (v.kind === "issue") {
      const nul = (x: unknown) => (x === null || typeof x === "string" ? (x as string | null) : undefined);
      const prev = nul(v.prev);
      const next = nul(v.next);
      if (typeof v.issue !== "string" || (v.field !== "status" && v.field !== "due") || prev === undefined || next === undefined || !WHYS.has(v.why as IssueWhy)) return null;
      return { kind: "issue", issue: v.issue, field: v.field, prev, next, why: v.why as IssueWhy, from: typeof v.from === "string" ? v.from : "" };
    }
    if (v.kind === "automation") {
      if (typeof v.db !== "string" || typeof v.automation !== "string" || (v.row !== null && typeof v.row !== "string")) return null;
      const added = Array.isArray(v.added) ? v.added.filter((x): x is string => typeof x === "string" && IDISH.test(x)).slice(0, 50) : undefined;
      return {
        kind: "automation",
        db: v.db,
        row: v.row as string | null,
        automation: v.automation,
        ...(typeof v.onlyIf === "string" ? { onlyIf: v.onlyIf } : {}),
        ...(typeof v.facts === "string" ? { facts: v.facts } : {}),
        ...(obj(v.prev) ? { prev: obj(v.prev) } : {}),
        ...(obj(v.next) ? { next: obj(v.next) } : {}),
        ...(added?.length ? { added } : {}),
      };
    }
    return typeof v.issue === "string" && typeof v.prev === "string" && typeof v.status === "string" ? { kind: "parent", issue: v.issue, prev: v.prev, status: v.status, ...(v.reopen ? { reopen: true } : {}) } : null;
  } catch {
    return null;
  }
}

export interface HubRecord {
  subject: string;
  source: "model" | "rule";
  mode: "auto" | "suggest";
  status: "applied" | "pending";
  payload: HubPayload;
  /** For a goal: the reaction it is about. */
  reaction?: string;
  confidence?: number;
  model?: string;
  ms?: number;
  /** Who it acted for (the person whose rights it used). */
  by: string;
}

/** The object a record is about, for lookups (dz_decisions.row_id). */
function rowOf(p: HubPayload): string {
  return p.kind === "automation" ? (p.row ?? p.db) : p.issue;
}

/** Writes what the hub did (or proposes) and tells open tabs. */
export function recordHub(ws: string, h: HubRecord): string {
  ensureSchema();
  const id = randomBytes(12).toString("base64url");
  sql("INSERT INTO dz_decisions (id, ws, reaction_id, subject, source, confidence, mode, status, model, ms, actions, row_id, at, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    ws,
    h.reaction ?? null,
    h.subject,
    h.source,
    h.confidence ?? null,
    h.mode,
    h.status,
    h.model ?? null,
    h.ms ?? null,
    JSON.stringify(h.payload),
    rowOf(h.payload),
    Date.now(),
    // Whose rights a pending proposal will use is settled by who accepts it; an applied one keeps its person.
    h.status === "applied" ? h.by : null
  );
  emit(ws, { type: "decision", ref: id, by: "auto", data: { mode: h.mode, kind: h.payload.kind } });
  return id;
}

/** A pending proposal of the hub for this subject (one at a time). */
export function pendingFor(ws: string, subject: string, kind: HubPayload["kind"]): string | null {
  ensureSchema();
  const r = sql("SELECT id FROM dz_decisions WHERE ws = ? AND subject = ? AND status = 'pending' AND actions LIKE ?").get(ws, subject, `{"kind":"${kind}"%`) as { id: string } | undefined;
  return r?.id ?? null;
}

/** The latest applied record of the hub about an issue (a parent closed automatically). */
export function lastApplied(ws: string, issue: string, kind: HubPayload["kind"]): { id: string; payload: HubPayload } | null {
  ensureSchema();
  const r = sql("SELECT id, actions FROM dz_decisions WHERE ws = ? AND row_id = ? AND status IN ('applied', 'accepted') AND actions LIKE ? ORDER BY at DESC LIMIT 1").get(ws, issue, `{"kind":"${kind}"%`) as
    | { id: string; actions: string }
    | undefined;
  const p = r ? payloadOf(r.actions) : null;
  return r && p ? { id: r.id, payload: p } : null;
}

function editCtx(by: string, ws: string): Ctx | null {
  try {
    return { ...ctxFor(by, ws, "edit"), via: "auto" };
  } catch {
    return null;
  }
}

export type Settle = "applied" | "unchanged" | "rejected" | "undone" | "gone" | "forbidden";

/**
 * A person confirms or dismisses a proposal: the hub's (a goal) or a
 * reaction's (lib/decide/engine.ts). What it does uses their rights.
 */
export function resolve(ws: string, id: string, accept: boolean, by: string): Settle {
  ensureSchema();
  const row = sql("SELECT subject, actions FROM dz_decisions WHERE ws = ? AND id = ? AND status = 'pending'").get(ws, id) as { subject: string; actions: string | null } | undefined;
  if (!row) return "gone";
  const p = payloadOf(row.actions);
  if (!p) return resolveDecision(ws, id, accept, by);
  if (!keyVisible(by, ws, row.subject)) return "gone";
  const now = Date.now();
  if (!accept) {
    sql("UPDATE dz_decisions SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ?").run(by, now, id);
    emit(ws, { type: "decision", ref: id, by, data: { mode: "rejected" } });
    return "rejected";
  }
  const h = handlers.get(p.kind);
  if (h?.accept) return h.accept(ws, id, p, by);
  if (p.kind !== "goal" || p.reaction.when.type !== "metric" || p.reaction.if.kind !== "compare" || typeof p.reaction.if.value !== "number") return "gone";
  // The issue got its goal another way meanwhile (set by hand): nothing left to accept, and no second goal.
  if (reactionsOf(ws).some((r) => goalIssueOf(r) === p.issue)) {
    closeGoalProposals(ws, p.issue, by);
    return "gone";
  }
  // The goal is saved as the person who accepts it, through the same checks as one they set by hand:
  // they may edit the issue and see the number; their rights read it and close the issue.
  const saved = setGoal(ws, { issue: p.issue, key: p.reaction.when.key, op: p.reaction.if.op as GoalOp, target: p.reaction.if.value, docs: p.reaction.then.some((a) => a.do === "links.done") }, by);
  if ("error" in saved) return saved.error === "forbidden" || saved.error === "no number" ? "forbidden" : "gone";
  sql("UPDATE dz_decisions SET status = 'accepted', reaction_id = ?, resolved_by = ?, resolved_at = ? WHERE id = ?").run(saved.id, by, now, id);
  emit(ws, { type: "decision", ref: id, by, data: { mode: "accepted" } });
  return "applied";
}

/** A person takes back what was done automatically (a goal linked, a parent closed or reopened). */
export function undo(ws: string, id: string, by: string): Settle {
  ensureSchema();
  const row = sql("SELECT subject, actions, status FROM dz_decisions WHERE ws = ? AND id = ?").get(ws, id) as { subject: string; actions: string | null; status: string } | undefined;
  const p = row ? payloadOf(row.actions) : null;
  if (!row || !p || (row.status !== "applied" && row.status !== "accepted")) return "gone";
  if (!keyVisible(by, ws, row.subject)) return "gone";
  const h = handlers.get(p.kind);
  if (h?.undo) {
    const r = h.undo(ws, p, by);
    if (r !== "undone") return r;
    sql("UPDATE dz_decisions SET status = 'undone', resolved_by = ?, resolved_at = ? WHERE id = ?").run(by, Date.now(), id);
    emit(ws, { type: "decision", ref: id, by, data: { mode: "undone" } });
    return "undone";
  }
  const ctx = editCtx(by, ws);
  if (!ctx) return "forbidden";
  if (p.kind === "goal") {
    deleteReaction(ws, p.reaction.id);
  } else if (p.kind === "issue") {
    let cur;
    try {
      cur = getIssueBrief(ctx, p.issue);
    } catch {
      return "gone";
    }
    // Only what is still the automation's: a person's later change stays.
    const now = p.field === "status" ? cur.statusId : cur.dueDate;
    if (now === p.next) {
      try {
        updateIssue(ctx, p.issue, p.field === "status" ? { statusId: p.prev } : { dueDate: p.prev });
      } catch {
        return "forbidden";
      }
    }
  } else if (p.kind === "parent") {
    let cur;
    try {
      cur = getIssueBrief(ctx, p.issue);
    } catch {
      return "gone";
    }
    // Only what is still the automation's: a person's later change stays.
    if (cur.statusId === p.status) {
      try {
        updateIssue(ctx, p.issue, { statusId: p.prev });
      } catch {
        return "forbidden";
      }
    }
  }
  sql("UPDATE dz_decisions SET status = 'undone', resolved_by = ?, resolved_at = ? WHERE id = ?").run(by, Date.now(), id);
  emit(ws, { type: "decision", ref: id, by, data: { mode: "undone" } });
  return "undone";
}

// ------------------------------------------------------------------ the list

export type ActivityKind = "goal_met" | "goal_linked" | "parent_done" | "parent_reopened" | "issue_flow" | "automation" | "rule" | "autopilot";

export interface ActivityItem {
  /** "d:<decision id>" or "s:<Projects suggestion id>". */
  id: string;
  at: number;
  kind: ActivityKind;
  /** The decision model judged it (with a confidence), or an exact rule did. */
  source: "model" | "rule";
  /** applied, pending, accepted, rejected, undone, expired, unchanged; Projects: open, applied, accepted, dismissed, undone. */
  status: string;
  confidence: number | null;
  /** What it is about, as a ref key ("issue:<id>", "note:<id>", "metric:<key>"). */
  subject: string;
  /** A short name of the subject for this person ("GRO-12 Reach 1,000 signups", a page's title, a number's label). */
  title: string;
  /** Details by kind: autopilot's field ("priority"…), a goal's number and target… */
  detail: Record<string, string | number | boolean | null>;
  canUndo: boolean;
  canResolve: boolean;
}

interface Namer {
  issue(id: string): string | null;
  note(id: string): string | null;
  metric(key: string): string | null;
  /** An automation's name, for a person who may open its database. */
  automation(db: string, id: string): string | null;
}

function namer(ws: string, userId: string): Namer {
  let ctx: Ctx | null = null;
  try {
    ctx = ctxFor(userId, ws, "read");
  } catch {
    ctx = null;
  }
  const acc = new AccessResolver(ws, userId);
  const metrics = new Map(visibleMetrics(ws, userId, metricsOf(ws)).map((m) => [m.key, m.label ?? m.key]));
  return {
    issue(id) {
      if (!ctx) return null;
      try {
        const i = getIssueBrief(ctx, id);
        return `${i.identifier} ${i.title}`;
      } catch {
        return null;
      }
    },
    note(id) {
      if (acc.level(id) === null) return null;
      const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
      try {
        const n = r?.json ? (JSON.parse(r.json) as { title?: unknown }) : null;
        return typeof n?.title === "string" ? n.title.slice(0, 200) : null;
      } catch {
        return null;
      }
    },
    metric(key) {
      return metrics.get(key) ?? null;
    },
    automation(db, id) {
      if (acc.level(db) === null) return null;
      const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, db) as { json: string | null } | undefined;
      try {
        const n = r?.json ? (JSON.parse(r.json) as { db?: { automations?: { id?: unknown; name?: unknown }[] } }) : null;
        const a = n?.db?.automations?.find((x) => x?.id === id);
        return a ? (typeof a.name === "string" ? a.name.slice(0, 200) : "") : null;
      } catch {
        return null;
      }
    },
  };
}

function titleOf(n: Namer, subject: string): string | null {
  const i = subject.indexOf(":");
  const kind = subject.slice(0, i);
  const id = subject.slice(i + 1);
  if (kind === "issue") return n.issue(id);
  if (kind === "note") return n.note(id);
  if (kind === "metric") return n.metric(id);
  return null;
}

/**
 * What was done automatically and is proposed in the workspace, newest first, as this person
 * may see it: decisions about things hidden from them, and rules over pages
 * they cannot open, are left out.
 */
export function activityOf(ws: string, userId: string, limit = 50): ActivityItem[] {
  ensureSchema();
  const n = namer(ws, userId);
  const reactions = reactionsOf(ws);
  const goals = new Map(reactions.map((r) => [r.id, goalIssueOf(r)]));
  const withGoal = new Set([...goals.values()].filter(Boolean));
  const { decisions } = visibleRules(ws, userId, reactions, decisionsOf(ws, 200));
  const payloads = new Map(
    (sql("SELECT id, actions FROM dz_decisions WHERE ws = ? AND actions LIKE '{\"kind\":%' ORDER BY at DESC LIMIT 400").all(ws) as { id: string; actions: string }[]).map((r) => [r.id, payloadOf(r.actions)])
  );
  const out: ActivityItem[] = [];
  for (const d of decisions) {
    const p = payloads.get(d.id) ?? null;
    let kind: ActivityKind;
    let subject = d.subject;
    const detail: ActivityItem["detail"] = {};
    if (p?.kind === "goal") {
      // A proposal for an issue that has its goal by now (one set by hand) waits for nobody.
      if (d.status === "pending" && withGoal.has(p.issue)) continue;
      // A goal on a number the person may not read (someone else's mail) is not theirs to know.
      if (p.reaction.when.type === "metric" && !metricReadable(ws, p.reaction.when.key, userId)) continue;
      kind = "goal_linked";
      subject = `issue:${p.issue}`;
      if (p.reaction.when.type === "metric" && p.reaction.if.kind === "compare") {
        detail.number = n.metric(p.reaction.when.key) ?? p.reaction.when.key;
        detail.op = p.reaction.if.op;
        detail.target = typeof p.reaction.if.value === "number" ? p.reaction.if.value : null;
      }
    } else if (p?.kind === "parent") {
      kind = p.reopen ? "parent_reopened" : "parent_done";
      subject = `issue:${p.issue}`;
    } else if (p?.kind === "issue") {
      kind = "issue_flow";
      subject = `issue:${p.issue}`;
      detail.why = p.why;
      detail.field = p.field;
      if (p.field === "due") detail.due = p.next;
    } else if (p?.kind === "automation") {
      kind = "automation";
      subject = `note:${p.row ?? p.db}`;
      const name = n.automation(p.db, p.automation);
      if (name === null) continue;
      detail.automation = name;
      detail.scheduled = p.row === null;
      if (p.added?.length) detail.added = p.added.length;
    } else if (d.reaction_id && goals.get(d.reaction_id)) {
      kind = "goal_met";
      const issue = goals.get(d.reaction_id) as string;
      detail.number = n.metric(d.subject.replace(/^metric:/, "")) ?? null;
      detail.issue = n.issue(issue);
      if (!detail.issue) continue;
    } else kind = "rule";
    if (!keyVisible(userId, ws, subject)) continue;
    const title = titleOf(n, subject);
    if (title === null && !subject.startsWith("metric:")) continue;
    out.push({
      id: `d:${d.id}`,
      at: d.at,
      kind,
      source: d.source === "model" ? "model" : "rule",
      status: d.status,
      confidence: d.confidence,
      subject,
      title: title ?? subject.slice(7),
      detail,
      canUndo: Boolean(p) && (d.status === "applied" || d.status === "accepted") && (p?.kind !== "automation" || Boolean(p.prev || p.added)),
      canResolve: d.status === "pending",
    });
  }
  // Projects' autopilot: fields of new issues, duplicates, "is it done?".
  let ctx: Ctx | null = null;
  try {
    ctx = ctxFor(userId, ws, "read");
  } catch {
    ctx = null;
  }
  if (ctx) {
    const rows = sql("SELECT id, issue_id, kind, confidence, state, created_at FROM pj_suggestions WHERE ws_id = ? ORDER BY created_at DESC LIMIT 200").all(ws) as {
      id: string;
      issue_id: string;
      kind: string;
      confidence: number;
      state: string;
      created_at: number;
    }[];
    for (const r of rows) {
      if (!keyVisible(userId, ws, `issue:${r.issue_id}`)) continue;
      const title = n.issue(r.issue_id);
      if (!title) continue;
      out.push({
        id: `s:${r.id}`,
        at: r.created_at,
        kind: "autopilot",
        source: "model",
        status: r.state,
        confidence: r.confidence,
        subject: `issue:${r.issue_id}`,
        title,
        detail: { field: r.kind },
        canUndo: r.state === "applied" && (r.kind === "priority" || r.kind === "label" || r.kind === "project"),
        canResolve: r.state === "open",
      });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, Math.min(200, Math.max(1, limit)));
}

/** Settles one item of the list ("d:…" or "s:…"): accept, dismiss or undo, with the person's rights. */
export function settle(ws: string, itemId: string, action: "accept" | "dismiss" | "undo", by: string): Settle {
  if (itemId.startsWith("d:")) {
    const id = itemId.slice(2);
    return action === "undo" ? undo(ws, id, by) : resolve(ws, id, action === "accept", by);
  }
  if (itemId.startsWith("s:")) {
    try {
      const ctx = ctxFor(by, ws, "edit");
      resolveSuggestion(ctx, itemId.slice(2), action);
      return action === "undo" ? "undone" : action === "accept" ? "applied" : "rejected";
    } catch {
      return "gone";
    }
  }
  return "gone";
}
