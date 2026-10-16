// Planning: projects (with milestones, status updates and dependencies for
// the roadmap) and cycles (time boxes of a team, with rollover of unfinished
// issues when a cycle is completed).

import { audit, sql, tx } from "../store";
import { bad, bump, emit, isMember, needs, notFound, PjError, pid, str, visibleProject, type Ctx } from "./core";
import { notify, record } from "./effects";
import {
  COLOR_RE,
  HEALTHS,
  PALETTE,
  PROJECT_STATES,
  addDays,
  dayOf,
  isDate,
  isPriority,
  type Cycle,
  type CycleSummary,
  type Health,
  type Milestone,
  type Progress,
  type Project,
  type ProjectDetail,
  type ProjectState,
  type ProjectUpdate,
} from "./types";

// --- Progress ------------------------------------------------------------------

/** Progress of the issues matched by `where` (canceled issues and issues still in triage leave the scope). */
function progressOf(where: string, params: unknown[], visible: string): Progress {
  const r = sql(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN s.category = 'started' THEN 1 ELSE 0 END) AS started,
       SUM(CASE WHEN s.category = 'completed' THEN 1 ELSE 0 END) AS completed,
       IFNULL(SUM(i.estimate), 0) AS points,
       IFNULL(SUM(CASE WHEN s.category = 'completed' THEN i.estimate ELSE 0 END), 0) AS points_done
     FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id
     WHERE ${where} AND i.archived_at IS NULL AND i.triage_at IS NULL AND s.category <> 'canceled' AND i.team_id IN (SELECT value FROM json_each(?))`
  ).get(...([...params, visible] as never[])) as { total: number; started: number | null; completed: number | null; points: number; points_done: number };
  return {
    total: Number(r.total),
    started: Number(r.started ?? 0),
    completed: Number(r.completed ?? 0),
    points: Number(r.points),
    pointsDone: Number(r.points_done),
  };
}

// --- Projects ------------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  summary: string;
  description: string;
  icon: string | null;
  color: string;
  state: ProjectState;
  priority: number;
  health: Health | null;
  lead_id: string | null;
  start_date: string | null;
  target_date: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  archived_at: number | null;
}

const PROJECT_COLS = "id, name, summary, description, icon, color, state, priority, health, lead_id, start_date, target_date, sort_order, created_at, updated_at, completed_at, archived_at";

function projectFrom(ctx: Ctx, r: ProjectRow): Project {
  const visible = JSON.stringify([...ctx.teams()]);
  const teams = (sql("SELECT team_id FROM pj_project_teams WHERE project_id = ?").all(r.id) as { team_id: string }[]).map((x) => x.team_id).filter((t) => ctx.teams().has(t));
  const members = (sql("SELECT user_id FROM pj_project_members WHERE project_id = ?").all(r.id) as { user_id: string }[]).map((x) => x.user_id);
  const deps = (sql("SELECT depends_on FROM pj_project_deps WHERE project_id = ?").all(r.id) as { depends_on: string }[]).map((x) => x.depends_on).filter((d) => visibleProject(ctx, d));
  const milestones = (sql("SELECT id, name, target_date, sort_order FROM pj_milestones WHERE project_id = ? ORDER BY sort_order, created_at").all(r.id) as {
    id: string;
    name: string;
    target_date: string | null;
    sort_order: number;
  }[]).map((m): Milestone => ({ id: m.id, name: m.name, targetDate: m.target_date, sortOrder: m.sort_order }));
  return {
    id: r.id,
    name: r.name,
    summary: r.summary,
    icon: r.icon,
    color: r.color,
    state: r.state,
    priority: r.priority as Project["priority"],
    health: r.health,
    leadId: r.lead_id,
    startDate: r.start_date,
    targetDate: r.target_date,
    sortOrder: r.sort_order,
    teamIds: teams,
    memberIds: members,
    dependsOn: deps,
    milestones,
    progress: progressOf("i.project_id = ?", [r.id], visible),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    archivedAt: r.archived_at,
  };
}

export function listProjects(ctx: Ctx, opts: { archived?: boolean } = {}): Project[] {
  const rows = sql(`SELECT ${PROJECT_COLS} FROM pj_projects WHERE ws_id = ? AND (archived_at IS NULL) = ? ORDER BY sort_order, created_at`).all(ctx.wsId, opts.archived ? 0 : 1) as unknown as ProjectRow[];
  return rows.filter((r) => visibleProject(ctx, r.id)).map((r) => projectFrom(ctx, r));
}

function projectRow(ctx: Ctx, id: string): ProjectRow {
  const r = sql(`SELECT ${PROJECT_COLS} FROM pj_projects WHERE id = ? AND ws_id = ?`).get(id, ctx.wsId) as ProjectRow | undefined;
  if (!r || !visibleProject(ctx, id)) throw notFound("project not found");
  return r;
}

export function getProject(ctx: Ctx, id: string): ProjectDetail {
  const r = projectRow(ctx, id);
  return { ...projectFrom(ctx, r), description: r.description, updates: projectUpdates(ctx, id) };
}

export interface ProjectInput {
  name?: unknown;
  summary?: unknown;
  description?: unknown;
  icon?: unknown;
  color?: unknown;
  state?: unknown;
  priority?: unknown;
  leadId?: unknown;
  startDate?: unknown;
  targetDate?: unknown;
  teamIds?: unknown;
  memberIds?: unknown;
  dependsOn?: unknown;
  archived?: unknown;
  sortOrder?: unknown;
}

function cleanProject(ctx: Ctx, input: ProjectInput, cur: ProjectRow | null): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (input.name !== undefined || !cur) out.name = str(input.name, 120);
  if (input.summary !== undefined) out.summary = str(input.summary, 255, { allowEmpty: true });
  if (input.description !== undefined) out.description = str(input.description, 100_000, { allowEmpty: true, trim: false });
  if (input.icon !== undefined) {
    if (input.icon !== null && (typeof input.icon !== "string" || [...input.icon].length > 4 || /[<>"'&]/.test(input.icon))) throw bad("bad icon");
    out.icon = (input.icon as string | null) || null;
  }
  if (input.color !== undefined) {
    if (typeof input.color !== "string" || !COLOR_RE.test(input.color)) throw bad("bad color");
    out.color = input.color;
  }
  if (input.state !== undefined) {
    if (!(PROJECT_STATES as readonly unknown[]).includes(input.state)) throw bad("bad state");
    out.state = input.state as string;
    // Set by hand: zvena no longer reopens it when work reopens.
    if (cur) out.auto_completed = 0;
    const now = Date.now();
    out.completed_at = input.state === "completed" ? (cur?.completed_at ?? now) : null;
    out.canceled_at = input.state === "canceled" ? now : null;
  }
  if (input.priority !== undefined) {
    if (!isPriority(input.priority)) throw bad("bad priority");
    out.priority = input.priority;
  }
  if (input.leadId !== undefined) {
    if (input.leadId !== null && (typeof input.leadId !== "string" || !isMember(ctx.wsId, input.leadId))) throw bad("lead is not a member");
    out.lead_id = input.leadId as string | null;
  }
  for (const [k, col] of [
    ["startDate", "start_date"],
    ["targetDate", "target_date"],
  ] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (v !== null && !isDate(v)) throw bad("bad date");
    out[col] = v as string | null;
  }
  const start = (out.start_date !== undefined ? out.start_date : cur?.start_date) ?? null;
  const target = (out.target_date !== undefined ? out.target_date : cur?.target_date) ?? null;
  if (start && target && start > target) throw bad("start after target");
  if (input.archived !== undefined) out.archived_at = input.archived === true ? (cur?.archived_at ?? Date.now()) : null;
  if (input.sortOrder !== undefined) {
    const n = Number(input.sortOrder);
    if (!Number.isFinite(n)) throw bad("bad order");
    out.sort_order = n;
  }
  return out;
}

function setProjectLinks(ctx: Ctx, id: string, input: ProjectInput): void {
  if (input.teamIds !== undefined) {
    if (!Array.isArray(input.teamIds) || input.teamIds.length > 50) throw bad("bad teams");
    const teams = [...new Set(input.teamIds.map(String))];
    for (const t of teams) if (!ctx.teams().has(t)) throw bad("unknown team");
    // Private teams the person cannot see stay linked.
    sql("DELETE FROM pj_project_teams WHERE project_id = ? AND team_id IN (SELECT value FROM json_each(?))").run(id, JSON.stringify([...ctx.teams()]));
    for (const t of teams) sql("INSERT OR IGNORE INTO pj_project_teams (project_id, team_id) VALUES (?, ?)").run(id, t);
  }
  if (input.memberIds !== undefined) {
    if (!Array.isArray(input.memberIds) || input.memberIds.length > 500) throw bad("bad members");
    const members = [...new Set(input.memberIds.map(String))];
    for (const m of members) if (!isMember(ctx.wsId, m)) throw bad("not a member");
    sql("DELETE FROM pj_project_members WHERE project_id = ?").run(id);
    for (const m of members) sql("INSERT INTO pj_project_members (project_id, user_id) VALUES (?, ?)").run(id, m);
  }
  if (input.dependsOn !== undefined) {
    if (!Array.isArray(input.dependsOn) || input.dependsOn.length > 50) throw bad("bad dependencies");
    const deps = [...new Set(input.dependsOn.map(String))];
    for (const d of deps) {
      if (d === id || !visibleProject(ctx, d)) throw bad("unknown project");
      if (dependsTransitively(d, id)) throw new PjError(409, "dependency loop");
    }
    // Dependencies on projects the person cannot see stay as they are.
    for (const old of (sql("SELECT depends_on FROM pj_project_deps WHERE project_id = ?").all(id) as { depends_on: string }[]).map((x) => x.depends_on))
      if (visibleProject(ctx, old)) sql("DELETE FROM pj_project_deps WHERE project_id = ? AND depends_on = ?").run(id, old);
    for (const d of deps) sql("INSERT OR IGNORE INTO pj_project_deps (project_id, depends_on, created_at) VALUES (?, ?, ?)").run(id, d, Date.now());
  }
}

function dependsTransitively(from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of sql("SELECT depends_on FROM pj_project_deps WHERE project_id = ?").all(cur) as { depends_on: string }[]) stack.push(r.depends_on);
  }
  return false;
}

export function createProject(ctx: Ctx, input: ProjectInput): ProjectDetail {
  needs(ctx, "edit");
  const v = cleanProject(ctx, input, null);
  const id = pid();
  const now = Date.now();
  tx(() => {
    const n = sql("SELECT COUNT(*) AS n, IFNULL(MAX(sort_order), 0) AS m FROM pj_projects WHERE ws_id = ?").get(ctx.wsId) as { n: number; m: number };
    if (Number(n.n) >= 2000) throw new PjError(409, "too many projects");
    sql(
      "INSERT INTO pj_projects (id, ws_id, name, summary, description, icon, color, state, priority, lead_id, start_date, target_date, sort_order, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      ctx.wsId,
      v.name as string,
      (v.summary as string) ?? "",
      (v.description as string) ?? "",
      (v.icon as string | null) ?? null,
      (v.color as string) ?? PALETTE[Number(n.n) % PALETTE.length],
      (v.state as string) ?? "planned",
      (v.priority as number) ?? 0,
      (v.lead_id as string | null) ?? null,
      (v.start_date as string | null) ?? null,
      (v.target_date as string | null) ?? null,
      Number(n.m) + 1,
      ctx.userId,
      now,
      now
    );
    setProjectLinks(ctx, id, input);
    if (v.lead_id) sql("INSERT OR IGNORE INTO pj_project_members (project_id, user_id) VALUES (?, ?)").run(id, v.lead_id);
    bump(ctx.wsId);
  });
  emit(ctx, "project", id);
  return getProject(ctx, id);
}

export function updateProject(ctx: Ctx, id: string, input: ProjectInput): ProjectDetail {
  needs(ctx, "edit");
  const cur = projectRow(ctx, id);
  const v = cleanProject(ctx, input, cur);
  tx(() => {
    const cols = Object.keys(v);
    if (cols.length) sql(`UPDATE pj_projects SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND ws_id = ?`).run(...(Object.values(v) as (string | number | null)[]), Date.now(), id, ctx.wsId);
    setProjectLinks(ctx, id, input);
    if (v.lead_id) {
      sql("INSERT OR IGNORE INTO pj_project_members (project_id, user_id) VALUES (?, ?)").run(id, v.lead_id);
      if (v.lead_id !== cur.lead_id) notify(ctx, v.lead_id as string, "subscribed", { projectId: id }, { role: "lead", project: cur.name });
    }
    bump(ctx.wsId);
  });
  emit(ctx, "project", id);
  return getProject(ctx, id);
}

/** Deletes a project; its issues stay (without a project). Owner only. */
export function deleteProject(ctx: Ctx, id: string): void {
  needs(ctx, "manage");
  projectRow(ctx, id);
  const issues = (sql("SELECT id FROM pj_issues WHERE project_id = ? AND ws_id = ?").all(id, ctx.wsId) as { id: string }[]).map((r) => r.id);
  tx(() => {
    sql("DELETE FROM pj_projects WHERE id = ? AND ws_id = ?").run(id, ctx.wsId);
    bump(ctx.wsId);
  });
  audit(ctx.userId, "projects.project.delete", ctx.wsId, { project: id });
  // Its issues stay, without a project.
  for (const i of issues) emit(ctx, "issue", i);
  emit(ctx, "project", id, { deleted: true });
}

// Milestones

export function saveMilestone(ctx: Ctx, projectId: string, input: { id?: unknown; name?: unknown; targetDate?: unknown; sortOrder?: unknown }): ProjectDetail {
  needs(ctx, "edit");
  projectRow(ctx, projectId);
  const name = str(input.name, 120);
  const target = input.targetDate === undefined || input.targetDate === null ? null : isDate(input.targetDate) ? input.targetDate : null;
  if (input.targetDate !== undefined && input.targetDate !== null && !target) throw bad("bad date");
  if (typeof input.id === "string") {
    const changed = sql("UPDATE pj_milestones SET name = ?, target_date = ?, sort_order = IFNULL(?, sort_order) WHERE id = ? AND project_id = ? AND ws_id = ?").run(
      name,
      target,
      input.sortOrder === undefined ? null : Number(input.sortOrder),
      input.id,
      projectId,
      ctx.wsId
    ).changes;
    if (!Number(changed)) throw notFound("milestone not found");
  } else {
    const n = sql("SELECT COUNT(*) AS n FROM pj_milestones WHERE project_id = ?").get(projectId) as { n: number };
    if (Number(n.n) >= 100) throw new PjError(409, "too many milestones");
    sql("INSERT INTO pj_milestones (id, ws_id, project_id, name, target_date, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(pid(), ctx.wsId, projectId, name, target, Number(n.n), Date.now());
  }
  bump(ctx.wsId);
  emit(ctx, "project", projectId);
  return getProject(ctx, projectId);
}

export function deleteMilestone(ctx: Ctx, projectId: string, milestoneId: string): ProjectDetail {
  needs(ctx, "edit");
  projectRow(ctx, projectId);
  sql("DELETE FROM pj_milestones WHERE id = ? AND project_id = ? AND ws_id = ?").run(milestoneId, projectId, ctx.wsId);
  bump(ctx.wsId);
  emit(ctx, "project", projectId);
  return getProject(ctx, projectId);
}

// Status updates

export function projectUpdates(ctx: Ctx, projectId: string): ProjectUpdate[] {
  return (
    sql("SELECT id, project_id, author_id, health, body, auto, created_at, updated_at FROM pj_project_updates WHERE project_id = ? AND ws_id = ? ORDER BY created_at DESC LIMIT 100").all(projectId, ctx.wsId) as {
      id: string;
      project_id: string;
      author_id: string | null;
      health: Health;
      body: string;
      auto: string | null;
      created_at: number;
      updated_at: number;
    }[]
  ).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    authorId: r.author_id,
    health: r.health,
    body: r.body,
    auto: r.auto === "met" || r.auto === "reopened" ? r.auto : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** A status update: sets the project's health and tells its members and lead. */
export function addProjectUpdate(ctx: Ctx, projectId: string, input: { health?: unknown; body?: unknown }): ProjectDetail {
  needs(ctx, "edit");
  const p = projectRow(ctx, projectId);
  if (!(HEALTHS as readonly unknown[]).includes(input.health)) throw bad("bad health");
  const body = str(input.body, 50_000, { trim: false });
  if (!body.trim()) throw bad("empty update");
  const now = Date.now();
  tx(() => {
    sql("INSERT INTO pj_project_updates (id, ws_id, project_id, author_id, health, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      pid(),
      ctx.wsId,
      projectId,
      ctx.userId,
      input.health as string,
      body,
      now,
      now
    );
    sql("UPDATE pj_projects SET health = ?, updated_at = ? WHERE id = ?").run(input.health as string, now, projectId);
    const people = new Set((sql("SELECT user_id FROM pj_project_members WHERE project_id = ?").all(projectId) as { user_id: string }[]).map((r) => r.user_id));
    if (p.lead_id) people.add(p.lead_id);
    for (const u of people) notify(ctx, u, "project_update", { projectId }, { health: input.health, project: p.name });
    bump(ctx.wsId);
  });
  emit(ctx, "project", projectId);
  return getProject(ctx, projectId);
}

export function deleteProjectUpdate(ctx: Ctx, updateId: string): void {
  needs(ctx, "edit");
  const r = sql("SELECT author_id, project_id FROM pj_project_updates WHERE id = ? AND ws_id = ?").get(updateId, ctx.wsId) as { author_id: string | null; project_id: string } | undefined;
  if (!r) throw notFound("update not found");
  projectRow(ctx, r.project_id);
  if (r.author_id !== ctx.userId && ctx.role !== "owner") throw new PjError(403, "forbidden");
  sql("DELETE FROM pj_project_updates WHERE id = ?").run(updateId);
  bump(ctx.wsId);
  emit(ctx, "project", r.project_id);
}

// --- Cycles --------------------------------------------------------------------

interface CycleRow {
  id: string;
  team_id: string;
  number: number;
  name: string;
  description: string;
  starts_on: string;
  ends_on: string;
  completed_at: number | null;
  summary: string | null;
}

const CYCLE_COLS = "id, team_id, number, name, description, starts_on, ends_on, completed_at, summary";

function toCycle(ctx: Ctx, r: CycleRow): Cycle {
  return {
    id: r.id,
    teamId: r.team_id,
    number: r.number,
    name: r.name,
    description: r.description,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    completedAt: r.completed_at,
    progress: progressOf("i.cycle_id = ?", [r.id], JSON.stringify([...ctx.teams()])),
  };
}

export function listCycles(ctx: Ctx): Cycle[] {
  return (sql(`SELECT ${CYCLE_COLS} FROM pj_cycles WHERE ws_id = ? AND team_id IN (SELECT value FROM json_each(?)) ORDER BY team_id, starts_on`).all(ctx.wsId, JSON.stringify([...ctx.teams()])) as unknown as CycleRow[]).map(
    (r) => toCycle(ctx, r)
  );
}

function cycleRow(ctx: Ctx, id: string): CycleRow {
  const r = sql(`SELECT ${CYCLE_COLS} FROM pj_cycles WHERE id = ? AND ws_id = ?`).get(id, ctx.wsId) as CycleRow | undefined;
  if (!r || !ctx.teams().has(r.team_id)) throw notFound("cycle not found");
  return r;
}

export interface CycleLoad {
  userId: string | null;
  total: number;
  started: number;
  completed: number;
  points: number;
}

export function getCycle(ctx: Ctx, id: string): Cycle & { summary: CycleSummary | null; burnup: BurnupDay[]; load: CycleLoad[] } {
  const r = cycleRow(ctx, id);
  // Who carries what in the cycle (canceled issues left out).
  const load = (
    sql(
      `SELECT i.assignee_id, COUNT(*) AS total, SUM(s.category = 'started') AS started, SUM(s.category = 'completed') AS completed, IFNULL(SUM(i.estimate), 0) AS points
       FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id WHERE i.cycle_id = ? AND i.archived_at IS NULL AND s.category <> 'canceled' GROUP BY i.assignee_id ORDER BY total DESC`
    ).all(id) as { assignee_id: string | null; total: number; started: number; completed: number; points: number }[]
  ).map((x) => ({ userId: x.assignee_id, total: Number(x.total), started: Number(x.started), completed: Number(x.completed), points: Number(x.points) }));
  return { ...toCycle(ctx, r), summary: r.summary ? (JSON.parse(r.summary) as CycleSummary) : null, burnup: burnup(r), load };
}

/** One day of a cycle's graph: its scope, the issues started by then (done ones too) and completed. */
export interface BurnupDay {
  day: string;
  scope: number;
  started: number;
  completed: number;
}

/**
 * Scope, started and completed issues per day of the cycle (Linear's cycle
 * graph): an issue counts from the day it entered the cycle (its history,
 * else its creation), as started from the day work on it started (or it was
 * completed), and as completed from its completion day.
 */
function burnup(c: CycleRow): BurnupDay[] {
  const issues = sql(
    `SELECT i.id, i.created_at, i.started_at, i.completed_at, s.category,
       (SELECT MAX(a.created_at) FROM pj_activity a WHERE a.issue_id = i.id AND a.kind = 'cycle' AND a.to_value = json_quote(i.cycle_id)) AS added_at
     FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id WHERE i.cycle_id = ? AND i.archived_at IS NULL AND s.category <> 'canceled'`
  ).all(c.id) as { id: string; created_at: number; started_at: number | null; completed_at: number | null; category: string; added_at: number | null }[];
  const today = dayOf(Date.now());
  const last = c.completed_at ? dayOf(c.completed_at) : today < c.ends_on ? today : c.ends_on;
  const out: BurnupDay[] = [];
  for (let day = c.starts_on; day <= last && out.length < 120; day = addDays(day, 1)) {
    let scope = 0;
    let started = 0;
    let completed = 0;
    for (const i of issues) {
      const added = dayOf(i.added_at ?? i.created_at);
      if (added > day) continue;
      scope++;
      const done = i.category === "completed" && i.completed_at !== null && dayOf(i.completed_at) <= day;
      if (done) completed++;
      // Started and not moved back to todo since (a reset start is null), or already done.
      if (done || (i.started_at !== null && (i.category === "started" || i.category === "completed") && dayOf(i.started_at) <= day)) started++;
    }
    out.push({ day, scope, started, completed });
  }
  return out;
}

export function createCycle(ctx: Ctx, teamId: string, input: { startsOn?: unknown; endsOn?: unknown; name?: unknown; description?: unknown }): Cycle {
  needs(ctx, "edit");
  if (!ctx.teams().has(teamId)) throw notFound("team not found");
  const team = sql("SELECT cycle_weeks FROM pj_teams WHERE id = ? AND ws_id = ?").get(teamId, ctx.wsId) as { cycle_weeks: number } | undefined;
  if (!team) throw notFound("team not found");
  const lastCycle = sql("SELECT ends_on FROM pj_cycles WHERE team_id = ? ORDER BY ends_on DESC LIMIT 1").get(teamId) as { ends_on: string } | undefined;
  const start = input.startsOn === undefined ? (lastCycle ? addDays(lastCycle.ends_on, 1) : dayOf(Date.now())) : input.startsOn;
  if (!isDate(start)) throw bad("bad start");
  const end = input.endsOn === undefined ? addDays(start, team.cycle_weeks * 7 - 1) : input.endsOn;
  if (!isDate(end) || end < start) throw bad("bad end");
  const id = pid();
  tx(() => {
    const overlap = sql("SELECT 1 FROM pj_cycles WHERE team_id = ? AND starts_on <= ? AND ends_on >= ?").get(teamId, end, start);
    if (overlap) throw new PjError(409, "cycles overlap");
    const n = sql("SELECT IFNULL(MAX(number), 0) AS n FROM pj_cycles WHERE team_id = ?").get(teamId) as { n: number };
    const now = Date.now();
    sql("INSERT INTO pj_cycles (id, ws_id, team_id, number, name, description, starts_on, ends_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      ctx.wsId,
      teamId,
      Number(n.n) + 1,
      typeof input.name === "string" ? input.name.trim().slice(0, 80) : "",
      typeof input.description === "string" ? input.description.slice(0, 2000) : "",
      start,
      end,
      now,
      now
    );
    bump(ctx.wsId);
  });
  emit(ctx, "cycle", id);
  return toCycle(ctx, cycleRow(ctx, id));
}

export function updateCycle(ctx: Ctx, id: string, input: { name?: unknown; description?: unknown; startsOn?: unknown; endsOn?: unknown }): Cycle {
  needs(ctx, "edit");
  const cur = cycleRow(ctx, id);
  const start = input.startsOn === undefined ? cur.starts_on : input.startsOn;
  const end = input.endsOn === undefined ? cur.ends_on : input.endsOn;
  if (!isDate(start) || !isDate(end) || end < start) throw bad("bad dates");
  tx(() => {
    if (sql("SELECT 1 FROM pj_cycles WHERE team_id = ? AND id <> ? AND starts_on <= ? AND ends_on >= ?").get(cur.team_id, id, end, start)) throw new PjError(409, "cycles overlap");
    sql("UPDATE pj_cycles SET name = ?, description = ?, starts_on = ?, ends_on = ?, updated_at = ? WHERE id = ?").run(
      input.name === undefined ? cur.name : str(input.name, 80, { allowEmpty: true }),
      input.description === undefined ? cur.description : str(input.description, 2000, { allowEmpty: true }),
      start,
      end,
      Date.now(),
      id
    );
    bump(ctx.wsId);
  });
  emit(ctx, "cycle", id);
  return toCycle(ctx, cycleRow(ctx, id));
}

export function deleteCycle(ctx: Ctx, id: string): void {
  needs(ctx, "edit");
  const cur = cycleRow(ctx, id);
  if (cur.completed_at) throw new PjError(409, "cycle completed");
  const issues = (sql("SELECT id FROM pj_issues WHERE cycle_id = ?").all(id) as { id: string }[]).map((r) => r.id);
  tx(() => {
    sql("UPDATE pj_issues SET cycle_id = NULL, updated_at = ? WHERE cycle_id = ?").run(Date.now(), id);
    sql("DELETE FROM pj_cycles WHERE id = ?").run(id);
    bump(ctx.wsId);
  });
  for (const i of issues) emit(ctx, "issue", i);
  emit(ctx, "cycle", id, { deleted: true });
}

/**
 * Completes a cycle: unfinished issues move to `moveTo` (the next cycle, or
 * none), and a summary of what was planned and done is kept on the cycle.
 */
export function completeCycle(ctx: Ctx, id: string, moveTo: string | null): Cycle & { summary: CycleSummary | null } {
  needs(ctx, "edit");
  const c = cycleRow(ctx, id);
  if (c.completed_at) throw new PjError(409, "cycle completed");
  if (moveTo !== null) {
    const t = cycleRow(ctx, moveTo);
    if (t.team_id !== c.team_id || t.id === c.id || t.completed_at) throw bad("bad target cycle");
  }
  const moved = tx(() => closeCycle(ctx, c, moveTo, Date.now()));
  emit(ctx, "cycle", id);
  for (const m of moved) emit(ctx, "issue", m);
  return getCycle(ctx, id);
}

/** Writes a cycle's completion (inside a transaction); returns the issues carried over. */
function closeCycle(ctx: Ctx, c: CycleRow, moveTo: string | null, now: number): string[] {
  const rows = sql(
    "SELECT i.id, i.assignee_id, i.estimate, s.category FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id WHERE i.cycle_id = ? AND i.archived_at IS NULL AND i.triage_at IS NULL"
  ).all(c.id) as { id: string; assignee_id: string | null; estimate: number | null; category: string }[];
  // Unfinished work rolls over; completed and canceled issues stay with the cycle they closed in.
  const open = rows.filter((r) => r.category !== "completed" && r.category !== "canceled");
  const by = new Map<string | null, { total: number; completed: number }>();
  for (const r of rows) {
    if (r.category === "canceled") continue;
    const e = by.get(r.assignee_id) ?? { total: 0, completed: 0 };
    e.total++;
    if (r.category === "completed") e.completed++;
    by.set(r.assignee_id, e);
  }
  const summary: CycleSummary = {
    scope: rows.filter((r) => r.category !== "canceled").length,
    completed: rows.filter((r) => r.category === "completed").length,
    canceled: rows.filter((r) => r.category === "canceled").length,
    carriedOver: open.length,
    carriedTo: moveTo,
    points: rows.filter((r) => r.category !== "canceled").reduce((a, r) => a + (r.estimate ?? 0), 0),
    pointsDone: rows.filter((r) => r.category === "completed").reduce((a, r) => a + (r.estimate ?? 0), 0),
    byAssignee: [...by.entries()].map(([userId, v]) => ({ userId, ...v })),
  };
  for (const r of open) {
    sql("UPDATE pj_issues SET cycle_id = ?, updated_at = ? WHERE id = ?").run(moveTo, now, r.id);
    record(ctx, r.id, "cycle", c.id, moveTo, now);
  }
  sql("UPDATE pj_cycles SET completed_at = ?, summary = ?, updated_at = ? WHERE id = ?").run(now, JSON.stringify(summary), now, c.id);
  bump(ctx.wsId);
  return open.map((r) => r.id);
}

/**
 * Cycles end by themselves (Linear): the hourly job completes every cycle of
 * a team with cycles on whose last day is past, and its unfinished issues roll
 * over to the team's next cycle, made when there is none yet (as long as the
 * team's cycle length, placed so that it runs today). Completed and canceled
 * issues stay. The history names no person ("zvena"). Returns the cycles completed.
 */
export function rollOverCycles(now = Date.now()): number {
  const today = dayOf(now);
  const due = sql(
    `SELECT c.${CYCLE_COLS.split(", ").join(", c.")}, c.ws_id, t.cycle_weeks FROM pj_cycles c JOIN pj_teams t ON t.id = c.team_id
     WHERE c.completed_at IS NULL AND c.ends_on < ? AND t.cycles_enabled = 1 AND t.archived_at IS NULL ORDER BY c.team_id, c.ends_on LIMIT 500`
  ).all(today) as unknown as (CycleRow & { ws_id: string; cycle_weeks: number })[];
  let done = 0;
  for (const c of due) {
    const ctx: Ctx = { userId: "", wsId: c.ws_id, role: "owner", teams: () => new Set([c.team_id]) };
    let made: string | null = null;
    let moved: string[] = [];
    try {
      tx(() => {
        // Still open (another process may have completed it meanwhile).
        if (!sql("SELECT 1 FROM pj_cycles WHERE id = ? AND completed_at IS NULL").get(c.id)) return;
        let next = (sql("SELECT id FROM pj_cycles WHERE team_id = ? AND completed_at IS NULL AND starts_on > ? ORDER BY starts_on LIMIT 1").get(c.team_id, c.ends_on) as { id: string } | undefined)?.id ?? null;
        if (!next) {
          const len = c.cycle_weeks * 7;
          let start = addDays(c.ends_on, 1);
          // Days the server was away: the new cycle is the one that runs today.
          while (addDays(start, len - 1) < today) start = addDays(start, len);
          const end = addDays(start, len - 1);
          if (!sql("SELECT 1 FROM pj_cycles WHERE team_id = ? AND starts_on <= ? AND ends_on >= ?").get(c.team_id, end, start)) {
            const n = sql("SELECT IFNULL(MAX(number), 0) AS n FROM pj_cycles WHERE team_id = ?").get(c.team_id) as { n: number };
            next = pid();
            sql("INSERT INTO pj_cycles (id, ws_id, team_id, number, name, description, starts_on, ends_on, created_at, updated_at) VALUES (?, ?, ?, ?, '', '', ?, ?, ?, ?)").run(
              next,
              c.ws_id,
              c.team_id,
              Number(n.n) + 1,
              start,
              end,
              now,
              now
            );
            made = next;
          }
        }
        moved = closeCycle(ctx, c, next, now);
        done++;
      });
    } catch (e) {
      console.error(`[projects] cycle rollover failed (${e instanceof Error ? e.name : "error"})`);
      continue;
    }
    if (made) emit(ctx, "cycle", made, { created: true });
    emit(ctx, "cycle", c.id);
    for (const m of moved) emit(ctx, "issue", m);
  }
  return done;
}

/** The team's active cycle on `today`, if any. */
export function currentCycle(teamId: string, today: string): string | null {
  const r = sql("SELECT id FROM pj_cycles WHERE team_id = ? AND starts_on <= ? AND ends_on >= ? AND completed_at IS NULL ORDER BY starts_on LIMIT 1").get(teamId, today, today) as { id: string } | undefined;
  return r?.id ?? null;
}
