// Teams, their workflow statuses, labels and custom fields.

import { audit, sql, tx } from "../store";
import { bad, bump, emit, forbidden, isMember, needs, notFound, PjError, pid, str, type Ctx } from "./core";
import { announceGoals, goalSnapshot, settleGoals, type GoalEvent } from "./goals";
import { isTeamKey, suggestKey } from "./ident";
import { LABEL_COLORS, seedFor, STATUS_SHAPE } from "./seed";
import {
  COLOR_RE,
  ESTIMATE_SCALES,
  FIELD_TYPES,
  PALETTE,
  STATUS_CATEGORIES,
  type CustomField,
  type EstimateScale,
  type FieldType,
  type Label,
  type Status,
  type StatusCategory,
  type Team,
} from "./types";

// --- Teams ---------------------------------------------------------------------

interface TeamRow {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  icon: string | null;
  private: number;
  estimates: EstimateScale;
  cycles_enabled: number;
  cycle_weeks: number;
  triage: number;
  archived_at: number | null;
}

const TEAM_COLS = "id, key, name, description, color, icon, private, estimates, cycles_enabled, cycle_weeks, triage, archived_at";

/** Issues waiting (not snoozed) in the triage of each of these teams. */
function triageCounts(teamIds: string[]): Map<string, number> {
  if (!teamIds.length) return new Map();
  const rows = sql(
    "SELECT team_id, COUNT(*) AS n FROM pj_issues WHERE team_id IN (SELECT value FROM json_each(?)) AND triage_at IS NOT NULL AND archived_at IS NULL AND (triage_snoozed_until IS NULL OR triage_snoozed_until <= ?) GROUP BY team_id"
  ).all(JSON.stringify(teamIds), Date.now()) as { team_id: string; n: number }[];
  return new Map(rows.map((r) => [r.team_id, Number(r.n)]));
}

function teamMembers(teamIds: string[]): Map<string, { userId: string; role: "lead" | "member" }[]> {
  const out = new Map<string, { userId: string; role: "lead" | "member" }[]>();
  if (!teamIds.length) return out;
  const rows = sql(
    "SELECT m.team_id, m.user_id, m.role FROM pj_team_members m JOIN pj_teams t ON t.id = m.team_id JOIN members w ON w.ws_id = t.ws_id AND w.user_id = m.user_id WHERE m.team_id IN (SELECT value FROM json_each(?)) ORDER BY m.role = 'lead' DESC, m.created_at"
  ).all(JSON.stringify(teamIds)) as { team_id: string; user_id: string; role: "lead" | "member" }[];
  for (const r of rows) {
    const list = out.get(r.team_id) ?? [];
    list.push({ userId: r.user_id, role: r.role });
    out.set(r.team_id, list);
  }
  return out;
}

function toTeam(r: TeamRow, members: { userId: string; role: "lead" | "member" }[], viewer: string, triage = 0): Team {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    color: r.color,
    icon: r.icon,
    private: r.private === 1,
    estimates: r.estimates,
    cyclesEnabled: r.cycles_enabled === 1,
    cycleWeeks: r.cycle_weeks,
    triage: r.triage === 1,
    triageCount: r.triage === 1 ? triage : 0,
    members,
    isMember: members.some((m) => m.userId === viewer),
    archivedAt: r.archived_at,
  };
}

export function listTeams(ctx: Ctx): Team[] {
  const rows = sql(`SELECT ${TEAM_COLS} FROM pj_teams WHERE ws_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE`).all(
    ctx.wsId,
    JSON.stringify([...ctx.teams()])
  ) as unknown as TeamRow[];
  const members = teamMembers(rows.map((r) => r.id));
  const triage = triageCounts(rows.filter((r) => r.triage === 1).map((r) => r.id));
  return rows.map((r) => toTeam(r, members.get(r.id) ?? [], ctx.userId, triage.get(r.id) ?? 0));
}

export function getTeam(ctx: Ctx, teamId: string): Team {
  if (!ctx.teams().has(teamId)) throw notFound("team not found");
  const r = sql(`SELECT ${TEAM_COLS} FROM pj_teams WHERE id = ? AND ws_id = ?`).get(teamId, ctx.wsId) as TeamRow | undefined;
  if (!r) throw notFound("team not found");
  return toTeam(r, teamMembers([teamId]).get(teamId) ?? [], ctx.userId, triageCounts([teamId]).get(teamId) ?? 0);
}

export interface TeamInput {
  name?: unknown;
  key?: unknown;
  description?: unknown;
  color?: unknown;
  icon?: unknown;
  private?: unknown;
  estimates?: unknown;
  cyclesEnabled?: unknown;
  cycleWeeks?: unknown;
  triage?: unknown;
}

function cleanIcon(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || [...v].length > 4 || /[<>"'&]/.test(v)) throw bad("bad icon");
  return v;
}

function cleanColor(v: unknown): string {
  if (typeof v !== "string" || !COLOR_RE.test(v)) throw bad("bad color");
  return v.toLowerCase();
}

export function createTeam(ctx: Ctx, input: TeamInput, locale: string = "en"): Team {
  needs(ctx, "edit");
  const name = str(input.name, 80);
  const key = typeof input.key === "string" ? input.key.trim().toUpperCase() : "";
  if (!isTeamKey(key)) throw bad("bad key");
  const now = Date.now();
  const id = pid();
  tx(() => {
    if (sql("SELECT 1 FROM pj_teams WHERE ws_id = ? AND key = ?").get(ctx.wsId, key)) throw new PjError(409, "key taken");
    const count = sql("SELECT COUNT(*) AS n FROM pj_teams WHERE ws_id = ?").get(ctx.wsId) as { n: number };
    if (Number(count.n) >= 100) throw new PjError(409, "too many teams");
    sql(
      "INSERT INTO pj_teams (id, ws_id, key, name, description, color, icon, private, estimates, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      ctx.wsId,
      key,
      name,
      typeof input.description === "string" ? input.description.slice(0, 2000) : "",
      input.color === undefined ? PALETTE[Number(count.n) % PALETTE.length] : cleanColor(input.color),
      input.icon === undefined ? null : cleanIcon(input.icon),
      input.private === true ? 1 : 0,
      typeof input.estimates === "string" && input.estimates in ESTIMATE_SCALES ? input.estimates : "fibonacci",
      ctx.userId,
      now,
      now
    );
    sql("INSERT INTO pj_team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'lead', ?)").run(id, ctx.userId, now);
    // The workflow and labels are written in the language of the person who made the team.
    const seed = seedFor(locale);
    STATUS_SHAPE.forEach(([cat, color], i) => {
      const n = seed.statuses[i];
      sql("INSERT INTO pj_statuses (id, ws_id, team_id, name, category, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(pid(), ctx.wsId, id, n, cat, color, i, now);
    });
    // The workspace's first team brings a few common labels.
    if (Number(count.n) === 0 && !sql("SELECT 1 FROM pj_labels WHERE ws_id = ? LIMIT 1").get(ctx.wsId)) {
      for (const [i, n] of seed.labels.entries()) sql("INSERT INTO pj_labels (id, ws_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)").run(pid(), ctx.wsId, n, LABEL_COLORS[i], now);
    }
    bump(ctx.wsId);
  });
  audit(ctx.userId, "projects.team.create", ctx.wsId, { team: id });
  emit(ctx, "team", id);
  // The new team is visible from now on (the request's cache predates it).
  ctx.teams().add(id);
  return getTeam(ctx, id);
}

/**
 * A team for issues created from elsewhere (a checkbox in a document…): the
 * first team the person sees, or — for editors of a workspace with none —
 * a new team named after the workspace.
 */
export function ensureTeam(ctx: Ctx, locale: string = "en"): Team {
  const first = listTeams(ctx).find((t) => !t.archivedAt);
  if (first) return first;
  needs(ctx, "edit");
  // "My team", keyed after the workspace (a personal one: after its owner's name).
  const ws = sql("SELECT w.name, w.personal, u.name AS owner FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ?").get(ctx.wsId) as { name: string; personal: number; owner: string };
  const base = suggestKey(ws.personal ? ws.owner : ws.name);
  let key = base;
  for (let n = 2; sql("SELECT 1 FROM pj_teams WHERE ws_id = ? AND key = ?").get(ctx.wsId, key); n++) key = `${base.slice(0, 5)}${n}`;
  return createTeam(ctx, { name: seedFor(locale).team, key }, locale);
}

/**
 * Editors change the teams they can see: any public team, and a private team
 * only as its member (others never see it) or as the workspace owner.
 */
function assertTeamEditor(ctx: Ctx, teamId: string): void {
  needs(ctx, "edit");
  if (!ctx.teams().has(teamId)) throw notFound("team not found");
}

export function updateTeam(ctx: Ctx, teamId: string, input: TeamInput): Team {
  assertTeamEditor(ctx, teamId);
  const cur = sql("SELECT key, private FROM pj_teams WHERE id = ? AND ws_id = ?").get(teamId, ctx.wsId) as { key: string; private: number } | undefined;
  if (!cur) throw notFound("team not found");
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (input.name !== undefined) set("name", str(input.name, 80));
  if (input.description !== undefined) set("description", str(input.description, 2000, { allowEmpty: true }));
  if (input.color !== undefined) set("color", cleanColor(input.color));
  if (input.icon !== undefined) set("icon", cleanIcon(input.icon));
  if (input.estimates !== undefined) {
    if (typeof input.estimates !== "string" || !(input.estimates in ESTIMATE_SCALES)) throw bad("bad estimates");
    set("estimates", input.estimates);
  }
  if (input.cyclesEnabled !== undefined) set("cycles_enabled", input.cyclesEnabled === true ? 1 : 0);
  // Turning triage off lets everything waiting in it into the team's workflow.
  const triageOff = input.triage === false;
  if (input.triage !== undefined) set("triage", input.triage === true ? 1 : 0);
  if (input.cycleWeeks !== undefined) {
    const w = Number(input.cycleWeeks);
    if (!Number.isInteger(w) || w < 1 || w > 8) throw bad("bad cycle length");
    set("cycle_weeks", w);
  }
  if (input.private !== undefined) {
    // Making a team private hides it from everyone else: only its members or the owner may.
    const priv = input.private === true ? 1 : 0;
    if (priv !== cur.private && ctx.role !== "owner" && !sql("SELECT 1 FROM pj_team_members WHERE team_id = ? AND user_id = ?").get(teamId, ctx.userId)) throw forbidden();
    set("private", priv);
  }
  let newKey: string | null = null;
  if (input.key !== undefined) {
    const key = typeof input.key === "string" ? input.key.trim().toUpperCase() : "";
    if (!isTeamKey(key)) throw bad("bad key");
    if (key !== cur.key) {
      newKey = key;
      set("key", key);
    }
  }
  if (!sets.length) return getTeam(ctx, teamId);
  set("updated_at", Date.now());
  let goals: GoalEvent[] = [];
  tx(() => {
    if (newKey && sql("SELECT 1 FROM pj_teams WHERE ws_id = ? AND key = ? AND id <> ?").get(ctx.wsId, newKey, teamId)) throw new PjError(409, "key taken");
    if (newKey) {
      // Old identifiers (OLD-12) keep resolving to their issues.
      sql("INSERT OR IGNORE INTO pj_issue_aliases (ws_id, identifier, issue_id) SELECT ws_id, ? || '-' || number, id FROM pj_issues WHERE team_id = ?").run(cur.key, teamId);
      sql("DELETE FROM pj_issue_aliases WHERE ws_id = ? AND identifier IN (SELECT ? || '-' || number FROM pj_issues WHERE team_id = ?)").run(ctx.wsId, newKey, teamId);
    }
    sql(`UPDATE pj_teams SET ${sets.join(", ")} WHERE id = ? AND ws_id = ?`).run(...vals, teamId, ctx.wsId);
    if (triageOff) {
      // The released issues join their projects' goals (a met goal may open again).
      const waiting = sql("SELECT id, project_id, milestone_id FROM pj_issues WHERE team_id = ? AND triage_at IS NOT NULL").all(teamId) as { id: string; project_id: string | null; milestone_id: string | null }[];
      const snap = goalSnapshot(
        waiting.map((r) => r.project_id),
        waiting.map((r) => r.milestone_id)
      );
      const now = Date.now();
      sql("UPDATE pj_issues SET triage_at = NULL, triage_snoozed_until = NULL, updated_at = ? WHERE team_id = ? AND triage_at IS NOT NULL").run(now, teamId);
      goals = settleGoals(ctx, snap, now);
    }
    bump(ctx.wsId);
  });
  emit(ctx, "team", teamId);
  announceGoals(ctx, goals);
  return getTeam(ctx, teamId);
}

export function deleteTeam(ctx: Ctx, teamId: string): void {
  needs(ctx, "manage");
  if (!ctx.teams().has(teamId)) throw notFound("team not found");
  // Followers (link indexes, rules) hear about every issue that goes or changes with the team.
  const gone = (sql("SELECT id FROM pj_issues WHERE team_id = ? AND ws_id = ?").all(teamId, ctx.wsId) as { id: string }[]).map((r) => r.id);
  const touched = (
    sql(
      `SELECT DISTINCT i.id FROM pj_issues i WHERE i.ws_id = ? AND i.team_id <> ? AND (i.parent_id IN (SELECT id FROM pj_issues WHERE team_id = ?)
         OR i.id IN (SELECT r.issue_id FROM pj_issue_relations r JOIN pj_issues x ON x.id = r.related_id WHERE x.team_id = ?)
         OR i.id IN (SELECT r.related_id FROM pj_issue_relations r JOIN pj_issues x ON x.id = r.issue_id WHERE x.team_id = ?))`
    ).all(ctx.wsId, teamId, teamId, teamId, teamId) as { id: string }[]
  ).map((r) => r.id);
  tx(() => {
    // Issues of other teams that pointed into this one lose the link, not their data.
    sql("UPDATE pj_issues SET parent_id = NULL WHERE parent_id IN (SELECT id FROM pj_issues WHERE team_id = ?) AND team_id <> ?").run(teamId, teamId);
    sql("DELETE FROM pj_issues WHERE team_id = ?").run(teamId);
    sql("DELETE FROM pj_teams WHERE id = ? AND ws_id = ?").run(teamId, ctx.wsId);
    bump(ctx.wsId);
  });
  audit(ctx.userId, "projects.team.delete", ctx.wsId, { team: teamId });
  for (const id of gone) emit(ctx, "issue", id, { deleted: true });
  for (const id of touched) emit(ctx, "issue", id);
  emit(ctx, "team", teamId, { deleted: true });
}

/**
 * Joins, leaves or changes a member. Anyone may join a public team or leave
 * any team; adding others and changing roles takes an editor who is in the
 * team (or the owner); a team always keeps at least one lead.
 */
export function setTeamMember(ctx: Ctx, teamId: string, userId: string, role: "lead" | "member" | null): Team {
  if (!ctx.teams().has(teamId)) throw notFound("team not found");
  const team = sql("SELECT private FROM pj_teams WHERE id = ? AND ws_id = ?").get(teamId, ctx.wsId) as { private: number } | undefined;
  if (!team) throw notFound("team not found");
  const self = userId === ctx.userId;
  const actor = sql("SELECT role FROM pj_team_members WHERE team_id = ? AND user_id = ?").get(teamId, ctx.userId) as { role: string } | undefined;
  const cur = sql("SELECT role FROM pj_team_members WHERE team_id = ? AND user_id = ?").get(teamId, userId) as { role: string } | undefined;
  const isOwner = ctx.role === "owner";
  if (role !== null && !isMember(ctx.wsId, userId)) throw bad("not a workspace member");
  if (self && role === "member" && !cur) {
    if (team.private && !isOwner) throw forbidden();
  } else if (self && role === null) {
    // Leaving is always allowed.
  } else {
    needs(ctx, "edit");
    if (!isOwner && !actor) throw forbidden();
    if ((role === "lead" || cur?.role === "lead") && !isOwner && actor?.role !== "lead") throw forbidden();
  }
  tx(() => {
    if (role === null) sql("DELETE FROM pj_team_members WHERE team_id = ? AND user_id = ?").run(teamId, userId);
    else sql("INSERT INTO pj_team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role").run(teamId, userId, role, Date.now());
    const leads = sql("SELECT COUNT(*) AS n FROM pj_team_members WHERE team_id = ? AND role = 'lead'").get(teamId) as { n: number };
    const members = sql("SELECT COUNT(*) AS n FROM pj_team_members WHERE team_id = ?").get(teamId) as { n: number };
    if (Number(members.n) > 0 && Number(leads.n) === 0) throw new PjError(409, "last lead");
    bump(ctx.wsId);
  });
  emit(ctx, "team", teamId);
  return getTeam(ctx, teamId);
}

// --- Statuses ------------------------------------------------------------------

interface StatusRow {
  id: string;
  team_id: string;
  name: string;
  category: StatusCategory;
  color: string;
  description: string;
  position: number;
}

const toStatus = (r: StatusRow): Status => ({ id: r.id, teamId: r.team_id, name: r.name, category: r.category, color: r.color, description: r.description, position: r.position });

export function listStatuses(ctx: Ctx): Status[] {
  return (
    sql("SELECT id, team_id, name, category, color, description, position FROM pj_statuses WHERE ws_id = ? AND team_id IN (SELECT value FROM json_each(?)) ORDER BY team_id, position").all(
      ctx.wsId,
      JSON.stringify([...ctx.teams()])
    ) as unknown as StatusRow[]
  ).map(toStatus);
}

export function statusRow(ctx: Ctx, statusId: string): StatusRow {
  const r = sql("SELECT id, team_id, name, category, color, description, position FROM pj_statuses WHERE id = ? AND ws_id = ?").get(statusId, ctx.wsId) as StatusRow | undefined;
  if (!r || !ctx.teams().has(r.team_id)) throw notFound("status not found");
  return r;
}

/** The status a new issue starts in: the first "unstarted", else the first open one. */
export function defaultStatus(teamId: string): string {
  const r = sql(
    "SELECT id FROM pj_statuses WHERE team_id = ? ORDER BY CASE category WHEN 'unstarted' THEN 0 WHEN 'backlog' THEN 1 WHEN 'started' THEN 2 ELSE 3 END, position LIMIT 1"
  ).get(teamId) as { id: string } | undefined;
  if (!r) throw new PjError(409, "team has no statuses");
  return r.id;
}

/** The first status of a category in a team (null if it has none). */
export function statusOfCategory(teamId: string, category: StatusCategory): string | null {
  const r = sql("SELECT id FROM pj_statuses WHERE team_id = ? AND category = ? ORDER BY position LIMIT 1").get(teamId, category) as { id: string } | undefined;
  return r?.id ?? null;
}

function isCategory(v: unknown): v is StatusCategory {
  return (STATUS_CATEGORIES as readonly unknown[]).includes(v);
}

export function createStatus(ctx: Ctx, teamId: string, input: { name?: unknown; category?: unknown; color?: unknown; description?: unknown }): Status {
  assertTeamEditor(ctx, teamId);
  const name = str(input.name, 60);
  if (!isCategory(input.category)) throw bad("bad category");
  const color = input.color === undefined ? "#95a2b3" : cleanColor(input.color);
  const id = pid();
  tx(() => {
    if (sql("SELECT 1 FROM pj_statuses WHERE team_id = ? AND name = ?").get(teamId, name)) throw new PjError(409, "name taken");
    const n = sql("SELECT COUNT(*) AS n FROM pj_statuses WHERE team_id = ?").get(teamId) as { n: number };
    if (Number(n.n) >= 40) throw new PjError(409, "too many statuses");
    // Placed after the last status of the same category (board order follows categories).
    const all = sql("SELECT category, position FROM pj_statuses WHERE team_id = ? ORDER BY position").all(teamId) as { category: StatusCategory; position: number }[];
    const order: StatusCategory[] = ["backlog", "unstarted", "started", "completed", "canceled"];
    const mine = order.indexOf(input.category as StatusCategory);
    let pos = all.length ? all[all.length - 1].position + 1 : 0;
    const sameOrBefore = all.filter((s) => order.indexOf(s.category) <= mine);
    const after = all.filter((s) => order.indexOf(s.category) > mine);
    if (after.length) pos = sameOrBefore.length ? (sameOrBefore[sameOrBefore.length - 1].position + after[0].position) / 2 : after[0].position - 1;
    sql("INSERT INTO pj_statuses (id, ws_id, team_id, name, category, color, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      ctx.wsId,
      teamId,
      name,
      input.category as StatusCategory,
      color,
      typeof input.description === "string" ? input.description.slice(0, 300) : "",
      pos,
      Date.now()
    );
    bump(ctx.wsId);
  });
  emit(ctx, "status", id);
  return toStatus(statusRow(ctx, id));
}

export function updateStatus(ctx: Ctx, statusId: string, input: { name?: unknown; color?: unknown; description?: unknown; position?: unknown }): Status {
  const cur = statusRow(ctx, statusId);
  assertTeamEditor(ctx, cur.team_id);
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (input.name !== undefined) {
    const name = str(input.name, 60);
    if (sql("SELECT 1 FROM pj_statuses WHERE team_id = ? AND name = ? AND id <> ?").get(cur.team_id, name, statusId)) throw new PjError(409, "name taken");
    sets.push("name = ?");
    vals.push(name);
  }
  if (input.color !== undefined) {
    sets.push("color = ?");
    vals.push(cleanColor(input.color));
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    vals.push(str(input.description, 300, { allowEmpty: true }));
  }
  if (input.position !== undefined) {
    const p = Number(input.position);
    if (!Number.isFinite(p)) throw bad("bad position");
    sets.push("position = ?");
    vals.push(p);
  }
  if (sets.length) {
    sql(`UPDATE pj_statuses SET ${sets.join(", ")} WHERE id = ? AND ws_id = ?`).run(...vals, statusId, ctx.wsId);
    bump(ctx.wsId);
    emit(ctx, "status", statusId);
  }
  return toStatus(statusRow(ctx, statusId));
}

/** Deletes a status; its issues move to `moveTo` (same team). The last status of a category stays. */
export function deleteStatus(ctx: Ctx, statusId: string, moveTo: string): void {
  const cur = statusRow(ctx, statusId);
  assertTeamEditor(ctx, cur.team_id);
  const target = statusRow(ctx, moveTo);
  if (target.team_id !== cur.team_id || target.id === cur.id) throw bad("bad target status");
  const movedRows = sql("SELECT id, project_id, milestone_id FROM pj_issues WHERE status_id = ?").all(cur.id) as { id: string; project_id: string | null; milestone_id: string | null }[];
  const moved = movedRows.map((r) => r.id);
  // Into another category: the issues get its times (as a status change would) and their goals move.
  const across = target.category !== cur.category;
  let goals: GoalEvent[] = [];
  tx(() => {
    const same = sql("SELECT COUNT(*) AS n FROM pj_statuses WHERE team_id = ? AND category = ?").get(cur.team_id, cur.category) as { n: number };
    if (Number(same.n) <= 1) throw new PjError(409, "last status of category");
    const now = Date.now();
    const snap = across
      ? goalSnapshot(
          movedRows.map((r) => r.project_id),
          movedRows.map((r) => r.milestone_id)
        )
      : null;
    if (across)
      sql(
        `UPDATE pj_issues SET status_id = ?, updated_at = ?, status_changed_at = ?,
           started_at = CASE WHEN ? = 'started' THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
           canceled_at = CASE WHEN ? = 'canceled' THEN ? ELSE NULL END
         WHERE status_id = ?`
      ).run(target.id, now, now, target.category, now, target.category, now, target.category, now, cur.id);
    else sql("UPDATE pj_issues SET status_id = ?, updated_at = ?, status_changed_at = ? WHERE status_id = ?").run(target.id, now, now, cur.id);
    sql("DELETE FROM pj_statuses WHERE id = ? AND ws_id = ?").run(cur.id, ctx.wsId);
    if (snap) goals = settleGoals(ctx, snap, now);
    bump(ctx.wsId);
  });
  for (const id of moved) emit(ctx, "issue", id);
  emit(ctx, "status", cur.id, { deleted: true });
  announceGoals(ctx, goals);
}

// --- Labels --------------------------------------------------------------------

interface LabelRow {
  id: string;
  team_id: string | null;
  parent_id: string | null;
  is_group: number;
  name: string;
  color: string;
  description: string;
}

const toLabel = (r: LabelRow): Label => ({ id: r.id, teamId: r.team_id, parentId: r.parent_id, isGroup: r.is_group === 1, name: r.name, color: r.color, description: r.description });

export function listLabels(ctx: Ctx): Label[] {
  return (
    sql(
      "SELECT id, team_id, parent_id, is_group, name, color, description FROM pj_labels WHERE ws_id = ? AND archived_at IS NULL AND (team_id IS NULL OR team_id IN (SELECT value FROM json_each(?))) ORDER BY is_group DESC, name COLLATE NOCASE"
    ).all(ctx.wsId, JSON.stringify([...ctx.teams()])) as unknown as LabelRow[]
  ).map(toLabel);
}

function labelRow(ctx: Ctx, id: string): LabelRow {
  const r = sql("SELECT id, team_id, parent_id, is_group, name, color, description FROM pj_labels WHERE id = ? AND ws_id = ? AND archived_at IS NULL").get(id, ctx.wsId) as LabelRow | undefined;
  if (!r || (r.team_id && !ctx.teams().has(r.team_id))) throw notFound("label not found");
  return r;
}

function sameNameExists(ctx: Ctx, teamId: string | null, name: string, except: string | null): boolean {
  const rows = sql("SELECT id, name FROM pj_labels WHERE ws_id = ? AND IFNULL(team_id, '') = ?").all(ctx.wsId, teamId ?? "") as { id: string; name: string }[];
  return rows.some((r) => r.id !== except && r.name.toLocaleLowerCase() === name.toLocaleLowerCase());
}

export function createLabel(ctx: Ctx, input: { name?: unknown; color?: unknown; teamId?: unknown; parentId?: unknown; isGroup?: unknown; description?: unknown }): Label {
  needs(ctx, "edit");
  const name = str(input.name, 60);
  const teamId = input.teamId === undefined || input.teamId === null ? null : String(input.teamId);
  if (teamId && !ctx.teams().has(teamId)) throw notFound("team not found");
  let parentId: string | null = null;
  if (typeof input.parentId === "string") {
    const p = labelRow(ctx, input.parentId);
    if (!p.is_group) throw bad("parent is not a group");
    parentId = p.id;
  }
  const id = pid();
  tx(() => {
    if (sameNameExists(ctx, teamId, name, null)) throw new PjError(409, "name taken");
    const n = sql("SELECT COUNT(*) AS n FROM pj_labels WHERE ws_id = ?").get(ctx.wsId) as { n: number };
    if (Number(n.n) >= 1000) throw new PjError(409, "too many labels");
    sql("INSERT INTO pj_labels (id, ws_id, team_id, parent_id, is_group, name, color, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      ctx.wsId,
      teamId,
      parentId,
      input.isGroup === true && !parentId ? 1 : 0,
      name,
      input.color === undefined ? PALETTE[Number(n.n) % PALETTE.length] : cleanColor(input.color),
      typeof input.description === "string" ? input.description.slice(0, 300) : "",
      Date.now()
    );
    bump(ctx.wsId);
  });
  emit(ctx, "label", id);
  return toLabel(labelRow(ctx, id));
}

export function updateLabel(ctx: Ctx, id: string, input: { name?: unknown; color?: unknown; description?: unknown; parentId?: unknown }): Label {
  needs(ctx, "edit");
  const cur = labelRow(ctx, id);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (input.name !== undefined) {
    const name = str(input.name, 60);
    if (sameNameExists(ctx, cur.team_id, name, id)) throw new PjError(409, "name taken");
    sets.push("name = ?");
    vals.push(name);
  }
  if (input.color !== undefined) {
    sets.push("color = ?");
    vals.push(cleanColor(input.color));
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    vals.push(str(input.description, 300, { allowEmpty: true }));
  }
  if (input.parentId !== undefined) {
    if (input.parentId === null) {
      sets.push("parent_id = NULL");
    } else {
      const p = labelRow(ctx, String(input.parentId));
      if (!p.is_group || cur.is_group) throw bad("bad parent");
      sets.push("parent_id = ?");
      vals.push(p.id);
    }
  }
  if (sets.length) {
    sql(`UPDATE pj_labels SET ${sets.join(", ")} WHERE id = ? AND ws_id = ?`).run(...vals, id, ctx.wsId);
    bump(ctx.wsId);
    emit(ctx, "label", id);
  }
  return toLabel(labelRow(ctx, id));
}

export function deleteLabel(ctx: Ctx, id: string): void {
  needs(ctx, "edit");
  labelRow(ctx, id);
  const labelled = (sql("SELECT DISTINCT issue_id FROM pj_issue_labels WHERE label_id = ? OR label_id IN (SELECT id FROM pj_labels WHERE parent_id = ?)").all(id, id) as { issue_id: string }[]).map((r) => r.issue_id);
  tx(() => {
    sql("DELETE FROM pj_labels WHERE id = ? AND ws_id = ?").run(id, ctx.wsId);
    bump(ctx.wsId);
  });
  for (const issue of labelled) emit(ctx, "issue", issue);
  emit(ctx, "label", id, { deleted: true });
}

/** Checks label ids for an issue of `teamId`: visible, not groups, one per group. */
export function validLabels(ctx: Ctx, teamId: string, ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > 50) throw bad("bad labels");
  const uniq = [...new Set(ids.map(String))];
  if (!uniq.length) return [];
  const rows = sql("SELECT id, team_id, parent_id, is_group FROM pj_labels WHERE ws_id = ? AND archived_at IS NULL AND id IN (SELECT value FROM json_each(?))").all(ctx.wsId, JSON.stringify(uniq)) as {
    id: string;
    team_id: string | null;
    parent_id: string | null;
    is_group: number;
  }[];
  if (rows.length !== uniq.length) throw bad("unknown label");
  const groups = new Set<string>();
  for (const r of rows) {
    if (r.is_group) throw bad("a label group is not a label");
    if (r.team_id && r.team_id !== teamId) throw bad("label of another team");
    if (r.parent_id) {
      if (groups.has(r.parent_id)) throw bad("one label per group");
      groups.add(r.parent_id);
    }
  }
  return uniq;
}

// --- Custom fields -------------------------------------------------------------

interface FieldRow {
  id: string;
  team_id: string | null;
  name: string;
  type: FieldType;
  options: string;
  sort_order: number;
}

const toField = (r: FieldRow): CustomField => ({ id: r.id, teamId: r.team_id, name: r.name, type: r.type, options: JSON.parse(r.options), sortOrder: r.sort_order });

export function listFields(ctx: Ctx): CustomField[] {
  return (
    sql(
      "SELECT id, team_id, name, type, options, sort_order FROM pj_fields WHERE ws_id = ? AND archived_at IS NULL AND (team_id IS NULL OR team_id IN (SELECT value FROM json_each(?))) ORDER BY sort_order, created_at"
    ).all(ctx.wsId, JSON.stringify([...ctx.teams()])) as unknown as FieldRow[]
  ).map(toField);
}

export function fieldRow(ctx: Ctx, id: string): CustomField {
  const r = sql("SELECT id, team_id, name, type, options, sort_order FROM pj_fields WHERE id = ? AND ws_id = ? AND archived_at IS NULL").get(id, ctx.wsId) as FieldRow | undefined;
  if (!r || (r.team_id && !ctx.teams().has(r.team_id))) throw notFound("field not found");
  return toField(r);
}

function cleanOptions(v: unknown): { id: string; name: string; color: string }[] {
  if (!Array.isArray(v) || v.length > 50) throw bad("bad options");
  return v.map((o, i) => {
    const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    return {
      id: typeof r.id === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(r.id) ? r.id : pid(),
      name: str(r.name, 60),
      color: typeof r.color === "string" && COLOR_RE.test(r.color) ? r.color : PALETTE[i % PALETTE.length],
    };
  });
}

export function createField(ctx: Ctx, input: { name?: unknown; type?: unknown; teamId?: unknown; options?: unknown }): CustomField {
  needs(ctx, "edit");
  const name = str(input.name, 60);
  if (!(FIELD_TYPES as readonly unknown[]).includes(input.type)) throw bad("bad type");
  const teamId = typeof input.teamId === "string" ? input.teamId : null;
  if (teamId && !ctx.teams().has(teamId)) throw notFound("team not found");
  const options = input.type === "select" ? cleanOptions(input.options ?? []) : [];
  const id = pid();
  const n = sql("SELECT COUNT(*) AS n FROM pj_fields WHERE ws_id = ?").get(ctx.wsId) as { n: number };
  if (Number(n.n) >= 50) throw new PjError(409, "too many fields");
  sql("INSERT INTO pj_fields (id, ws_id, team_id, name, type, options, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    ctx.wsId,
    teamId,
    name,
    input.type as FieldType,
    JSON.stringify(options),
    Number(n.n),
    Date.now()
  );
  bump(ctx.wsId);
  return fieldRow(ctx, id);
}

export function updateField(ctx: Ctx, id: string, input: { name?: unknown; options?: unknown }): CustomField {
  needs(ctx, "edit");
  const cur = fieldRow(ctx, id);
  if (input.name !== undefined) sql("UPDATE pj_fields SET name = ? WHERE id = ? AND ws_id = ?").run(str(input.name, 60), id, ctx.wsId);
  if (input.options !== undefined && cur.type === "select") {
    const options = cleanOptions(input.options);
    sql("UPDATE pj_fields SET options = ? WHERE id = ? AND ws_id = ?").run(JSON.stringify(options), id, ctx.wsId);
    // Values of removed options are cleared.
    sql("DELETE FROM pj_field_values WHERE field_id = ? AND value NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))").run(id, JSON.stringify(options));
  }
  bump(ctx.wsId);
  return fieldRow(ctx, id);
}

export function deleteField(ctx: Ctx, id: string): void {
  needs(ctx, "edit");
  fieldRow(ctx, id);
  sql("DELETE FROM pj_fields WHERE id = ? AND ws_id = ?").run(id, ctx.wsId);
  bump(ctx.wsId);
}

/** A field value as stored (text), or null to clear; throws on a value of the wrong type. */
export function cleanFieldValue(field: CustomField, v: unknown): string | null {
  if (v === null || v === "" || v === undefined) return null;
  switch (field.type) {
    case "text":
      return str(v, 2000);
    case "url": {
      const s = str(v, 2000);
      if (!/^https?:\/\/[^\s]+$/i.test(s)) throw bad("bad url");
      return s;
    }
    case "number": {
      const n = Number(v);
      if (!Number.isFinite(n)) throw bad("bad number");
      return String(n);
    }
    case "date": {
      const s = String(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad("bad date");
      return s;
    }
    case "checkbox":
      return v === true || v === "true" ? "true" : null;
    case "select": {
      const s = String(v);
      if (!field.options.some((o) => o.id === s)) throw bad("bad option");
      return s;
    }
  }
}
