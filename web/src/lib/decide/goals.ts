// Goals that close themselves. Server-only.
//
// A goal is an issue; its condition is a reaction of the workspace: "when the
// number <key> becomes ≥ <target>, the issue is done (and the pages linked to
// it)". The number is typed in, pushed from outside, or a source counting what
// the workspace already has (lib/decide/sources.ts: a Documents chart, a
// project's progress). This module is the one way such a goal is made — by a
// person (the issue's Goal panel, a chart's "Set a goal"), or automatically
// (lib/decide/autogoal.ts) — and read back with its progress.

import { randomBytes } from "node:crypto";
import { teamFor } from "../eco/actions";
import { addLink } from "../eco/links";
import { keyVisible } from "../eco/visibility";
import { emit } from "../pulse/bus";
import { ctxFor } from "../projects/core";
import { createIssue, getIssueBrief } from "../projects/issues";
import { listStatuses } from "../projects/teams";
import { sql } from "../store";
import { metricsOf, reactionsOf, saveReaction } from "./engine";
import type { CompareOp, Reaction } from "./model";
import { chartSpec, saveSource, sourceOf, sourcesOf, visibleMetrics, type Source } from "./sources";

export type GoalOp = Extract<CompareOp, ">=" | ">" | "<=" | "<" | "=">;
export const GOAL_OPS: readonly GoalOp[] = [">=", ">", "<=", "<", "="];

export interface GoalInput {
  issue: string;
  key: string;
  op: GoalOp;
  target: number;
  /** Also mark the pages linked to the issue done (default yes). */
  docs?: boolean;
}

/** The reaction that makes an issue a goal on a number. */
export function goalReaction(g: GoalInput, id = `goal-${randomBytes(9).toString("base64url")}`): Reaction {
  return {
    id,
    name: `Goal ${g.issue}`,
    on: true,
    when: { type: "metric", key: g.key },
    if: { kind: "compare", field: "value", op: g.op, value: g.target },
    then: [{ do: "issue.done", issue: g.issue }, ...(g.docs === false ? [] : [{ do: "links.done" as const, from: `issue:${g.issue}`, kinds: ["note" as const] }])],
  };
}

/** Whether a reaction is a goal of an issue: a number compared, then that issue done. */
export function goalIssueOf(r: Reaction): string | null {
  if (r.when.type !== "metric" || r.if.kind !== "compare" || r.if.field !== "value" || typeof r.if.value !== "number") return null;
  const a = r.then.find((x) => x.do === "issue.done" && x.issue !== "$subject");
  return a && a.do === "issue.done" ? a.issue : null;
}

/**
 * Makes an issue a goal (as `by`, who must be able to edit it). The number
 * must exist and be visible to them. Judged at once: a target already met
 * closes the issue now.
 */
export function setGoal(ws: string, g: GoalInput, by: string): Reaction | { error: string } {
  if (!GOAL_OPS.includes(g.op) || !Number.isFinite(g.target)) return { error: "invalid" };
  try {
    getIssueBrief(ctxFor(by, ws, "edit"), g.issue);
  } catch {
    return { error: "forbidden" };
  }
  const metric = visibleMetrics(ws, by, metricsOf(ws)).find((m) => m.key === g.key);
  if (!metric) return { error: "no number" };
  const saved = saveReaction(ws, goalReaction(g), by);
  if (!("error" in saved)) closeGoalProposals(ws, g.issue, by);
  return saved;
}

/**
 * The issue has its goal now: a proposal for it still waiting (lib/decide/autogoal.ts) has
 * nothing left to propose, and leaves "Waiting for you". (Accepting one, journal.ts marks it
 * accepted right after.)
 */
export function closeGoalProposals(ws: string, issue: string, by: string): void {
  const now = Date.now();
  const rows = sql("SELECT id FROM dz_decisions WHERE ws = ? AND subject = ? AND status = 'pending' AND actions LIKE '{\"kind\":\"goal\"%'").all(ws, `issue:${issue}`) as { id: string }[];
  for (const r of rows) {
    sql("UPDATE dz_decisions SET status = 'expired', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(by, now, r.id);
    emit(ws, { type: "decision", ref: r.id, by, data: { mode: "expired" } });
  }
}

export interface GoalView {
  reaction: string;
  issue: { id: string; identifier: string; title: string; done: boolean };
  key: string;
  label: string | null;
  value: number | null;
  at: number | null;
  op: GoalOp;
  target: number;
  met: boolean;
  /** 0–1 toward the target (≥ / > goals with a positive target), else null. */
  progress: number | null;
  source: Source | null;
  /** Set up automatically (not by a person). */
  auto: boolean;
}

export function metNow(value: number | null, op: GoalOp, target: number): boolean {
  if (value === null) return false;
  return op === ">=" ? value >= target : op === ">" ? value > target : op === "<=" ? value <= target : op === "<" ? value < target : value === target;
}

/** The workspace's goals a person may see, with where each number stands. */
export function goalsOf(ws: string, userId: string): GoalView[] {
  let ctx;
  try {
    ctx = ctxFor(userId, ws, "read");
  } catch {
    return [];
  }
  const metrics = new Map(visibleMetrics(ws, userId, metricsOf(ws)).map((m) => [m.key, m]));
  const sources = new Set(sourcesOf(ws).map((s) => s.key));
  const completed = new Set(listStatuses(ctx).filter((s) => s.category === "completed").map((s) => s.id));
  // Goals set up automatically (lib/decide/journal.ts keeps what was done).
  const auto = new Set(
    (sql("SELECT reaction_id FROM dz_decisions WHERE ws = ? AND source = 'model' AND status IN ('applied', 'accepted') AND actions LIKE '{\"kind\":\"goal\"%'").all(ws) as { reaction_id: string | null }[]).map((r) => r.reaction_id)
  );
  const out: GoalView[] = [];
  for (const r of reactionsOf(ws)) {
    const issueId = goalIssueOf(r);
    if (!issueId || !r.on || r.when.type !== "metric" || r.if.kind !== "compare") continue;
    if (!keyVisible(userId, ws, `issue:${issueId}`)) continue;
    let issue;
    try {
      issue = getIssueBrief(ctx, issueId);
    } catch {
      continue;
    }
    const key = r.when.key;
    // A number hidden from the person (a source over pages they cannot read) is not shown.
    if (sources.has(key) && !metrics.has(key)) continue;
    const m = metrics.get(key);
    const op = r.if.op as GoalOp;
    const target = Number(r.if.value);
    const value = m?.value ?? null;
    out.push({
      reaction: r.id,
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, done: completed.has(issue.statusId) },
      key,
      label: m?.label ?? null,
      value,
      at: m?.at ?? null,
      op,
      target,
      met: metNow(value, op, target),
      progress: value !== null && (op === ">=" || op === ">") && target > 0 ? Math.max(0, Math.min(1, value / target)) : null,
      source: sourceOf(ws, key)?.source ?? null,
      auto: auto.has(r.id),
    });
  }
  return out;
}

export interface ChartGoalInput {
  db: string;
  view: string;
  /** One bar of the chart (a group of its X property), or the whole chart. */
  bar?: { prop: string; key: string };
  op: GoalOp;
  target: number;
  /** The goal issue's title, in the person's language. */
  title: string;
  locale?: string;
}

/**
 * "Set a goal" on a chart: the chart's number becomes a live source, a goal
 * issue is made in the person's team and linked to the database, and the
 * issue closes when the chart reaches the target.
 */
export function chartGoal(ws: string, g: ChartGoalInput, by: string): { issue: { id: string; identifier: string }; key: string; met: boolean } | { error: string } {
  if (!GOAL_OPS.includes(g.op) || !Number.isFinite(g.target)) return { error: "invalid" };
  const title = g.title.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!title) return { error: "invalid" };
  const spec = chartSpec(ws, g.db, g.view);
  if (!spec) return { error: "no chart" };
  let ctx;
  try {
    ctx = ctxFor(by, ws, "edit");
  } catch {
    return { error: "forbidden" };
  }
  const src = saveSource(ws, { kind: "docs", db: g.db, view: g.view, fn: spec.fn, ...(spec.prop ? { prop: spec.prop } : {}), ...(g.bar ? { where: g.bar } : {}) }, by);
  if ("error" in src) return src;
  let issue;
  try {
    issue = createIssue(ctx, { teamId: teamFor(ctx, g.locale ?? "en"), title });
  } catch {
    return { error: "forbidden" };
  }
  addLink(ws, `issue:${issue.id}`, `note:${g.db}`, "manual", by);
  const r = setGoal(ws, { issue: issue.id, key: src.key, op: g.op, target: g.target, docs: false }, by);
  if ("error" in r) return r;
  return { issue: { id: issue.id, identifier: issue.identifier }, key: src.key, met: metNow(src.value, g.op, g.target) };
}
