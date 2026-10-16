// Goals: a project is a goal and its milestones are the steps towards it.
// They move by themselves as the work under them moves, decided here from the
// counts before and after a change (never from the browser):
//
//   met       the last open issue of a project closed: the project becomes
//             Completed (marked as done by zvena, so reopening work undoes it),
//             an automatic update says so, its lead and members are notified;
//   reopened  an issue of a project zvena completed opened again (or a new one
//             arrived): the project is back In progress (a project left with no
//             work at all stays as it is);
//   started   the first issue of a Backlog/Planned project started;
//   milestone the last open issue of a milestone closed;
//   moved     any other change of the counts (the chart moves).
//
// A project someone completed or canceled by hand is left alone. Canceled,
// archived and not yet triaged issues leave the scope, as in the progress bars. Every outcome is
// announced as a "project" change with `goal` (lib/projects/events.ts → the
// workspace's pulse), so open documents, home and boards update at once.

import { sql } from "../store";
import { emit, pid, type Ctx } from "./core";
import { notify } from "./effects";

export type GoalKind = "met" | "reopened" | "started" | "milestone" | "moved";

export interface GoalEvent {
  kind: GoalKind;
  projectId: string;
  milestoneId?: string;
  /** The project's name (the milestone's for "milestone"). */
  name: string;
  done: number;
  total: number;
}

interface Count {
  total: number;
  done: number;
  started: number;
}

/** The counts of projects and milestones before a change. */
export interface GoalSnapshot {
  projects: Map<string, Count>;
  milestones: Map<string, Count>;
}

/** The goal's counts: all of its work (deciding it), or only the teams `teams` lists (what a person may be told). */
function count(col: "project_id" | "milestone_id", id: string, teams?: string[]): Count {
  const r = sql(
    `SELECT COUNT(*) AS total,
       IFNULL(SUM(CASE WHEN s.category = 'completed' THEN 1 ELSE 0 END), 0) AS done,
       IFNULL(SUM(CASE WHEN s.category = 'started' THEN 1 ELSE 0 END), 0) AS started
     FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id
     WHERE i.${col} = ? AND i.archived_at IS NULL AND i.triage_at IS NULL AND s.category <> 'canceled'
       ${teams ? "AND i.team_id IN (SELECT value FROM json_each(?))" : ""}`
  ).get(...((teams ? [id, JSON.stringify(teams)] : [id]) as never[])) as { total: number; done: number; started: number };
  return { total: Number(r.total), done: Number(r.done), started: Number(r.started) };
}

/**
 * A goal's counts as this person may see them: the issues of their teams
 * only (as the progress bars), never a private team's work in a shared project.
 */
export function goalCountFor(ctx: Ctx, e: Pick<GoalEvent, "projectId" | "milestoneId">): { done: number; total: number } {
  const c = e.milestoneId ? count("milestone_id", e.milestoneId, [...ctx.teams()]) : count("project_id", e.projectId, [...ctx.teams()]);
  return { done: c.done, total: c.total };
}

const complete = (c: Count) => c.total > 0 && c.done === c.total;

/** Counts of these projects and milestones (nulls ignored); take it before the write. */
export function goalSnapshot(projectIds: Iterable<string | null | undefined>, milestoneIds: Iterable<string | null | undefined> = []): GoalSnapshot {
  const projects = new Map<string, Count>();
  const milestones = new Map<string, Count>();
  for (const p of projectIds) if (p && !projects.has(p)) projects.set(p, count("project_id", p));
  for (const m of milestoneIds) if (m && !milestones.has(m)) milestones.set(m, count("milestone_id", m));
  return { projects, milestones };
}

/** Merges two snapshots (the first count of each object wins). */
export function mergeSnapshots(a: GoalSnapshot, b: GoalSnapshot): GoalSnapshot {
  for (const [k, v] of b.projects) if (!a.projects.has(k)) a.projects.set(k, v);
  for (const [k, v] of b.milestones) if (!a.milestones.has(k)) a.milestones.set(k, v);
  return a;
}

function audience(projectId: string): string[] {
  const p = sql("SELECT lead_id, created_by FROM pj_projects WHERE id = ?").get(projectId) as { lead_id: string | null; created_by: string | null } | undefined;
  const people = new Set((sql("SELECT user_id FROM pj_project_members WHERE project_id = ?").all(projectId) as { user_id: string }[]).map((r) => r.user_id));
  if (p?.lead_id) people.add(p.lead_id);
  if (p?.created_by) people.add(p.created_by);
  return [...people];
}

/**
 * Compares the counts now with `before`, moves the projects that reached (or
 * left) their goal, writes their automatic updates and notifications. Runs
 * inside the write's transaction; returns what happened (announce it with
 * announceGoals after the commit).
 */
export function settleGoals(ctx: Ctx, before: GoalSnapshot, at = Date.now()): GoalEvent[] {
  const out: GoalEvent[] = [];
  for (const [mid, was] of before.milestones) {
    const m = sql("SELECT m.name, m.project_id, p.name AS project FROM pj_milestones m JOIN pj_projects p ON p.id = m.project_id WHERE m.id = ? AND m.ws_id = ?").get(mid, ctx.wsId) as
      | { name: string; project_id: string; project: string }
      | undefined;
    if (!m) continue;
    const now = count("milestone_id", mid);
    if (complete(now) && !complete(was)) {
      out.push({ kind: "milestone", projectId: m.project_id, milestoneId: mid, name: m.name, done: now.done, total: now.total });
      for (const u of audience(m.project_id)) notify(ctx, u, "goal_met", { projectId: m.project_id }, { project: m.project, milestone: m.name });
    }
  }
  for (const [id, was] of before.projects) {
    const p = sql("SELECT name, state, auto_completed FROM pj_projects WHERE id = ? AND ws_id = ? AND archived_at IS NULL").get(id, ctx.wsId) as
      | { name: string; state: string; auto_completed: number }
      | undefined;
    if (!p) continue;
    const now = count("project_id", id);
    const ev = (kind: GoalKind) => out.push({ kind, projectId: id, name: p.name, done: now.done, total: now.total });
    const autoUpdate = (kind: "met" | "reopened") =>
      sql("INSERT INTO pj_project_updates (id, ws_id, project_id, author_id, health, body, created_at, updated_at, auto) VALUES (?, ?, ?, ?, 'on_track', '', ?, ?, ?)").run(
        pid(),
        ctx.wsId,
        id,
        ctx.userId,
        at,
        at,
        kind
      );
    if (complete(now) && !complete(was) && p.state !== "completed" && p.state !== "canceled") {
      sql("UPDATE pj_projects SET state = 'completed', completed_at = ?, canceled_at = NULL, health = 'on_track', auto_completed = 1, updated_at = ? WHERE id = ?").run(at, at, id);
      autoUpdate("met");
      for (const u of audience(id)) notify(ctx, u, "goal_met", { projectId: id }, { project: p.name });
      ev("met");
    } else if (p.state === "completed" && p.auto_completed === 1 && now.total > 0 && !complete(now)) {
      sql("UPDATE pj_projects SET state = 'started', completed_at = NULL, auto_completed = 0, updated_at = ? WHERE id = ?").run(at, id);
      autoUpdate("reopened");
      ev("reopened");
    } else if ((p.state === "backlog" || p.state === "planned") && now.started + now.done > 0 && was.started + was.done === 0) {
      sql("UPDATE pj_projects SET state = 'started', updated_at = ? WHERE id = ?").run(at, id);
      ev("started");
    } else if (now.done !== was.done || now.total !== was.total) {
      ev("moved");
    }
  }
  return out;
}

/** After the commit: each goal's outcome on the change feed (→ the pulse). */
export function announceGoals(ctx: Ctx, events: GoalEvent[]): void {
  const seen = new Set<string>();
  // One announcement per project: a milestone and its project met at once say "met".
  const rank: Record<GoalKind, number> = { met: 0, reopened: 1, milestone: 2, started: 3, moved: 4 };
  for (const e of [...events].sort((a, b) => rank[a.kind] - rank[b.kind])) {
    if (seen.has(e.projectId)) continue;
    seen.add(e.projectId);
    // No counts: the pulse reaches people who may not see every team in the project; clients re-read.
    emit(ctx, "project", e.projectId, { goal: { kind: e.kind, ...(e.milestoneId ? { milestone: e.milestoneId } : {}) } });
  }
}
