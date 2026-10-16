// Issues: creating, changing, ordering, bulk changes, and the server-side
// query behind every list, board and calendar (filters, grouping, ordering
// and keyset pagination run in SQLite; the browser never gets a whole
// workspace to filter itself).

import { audit, sql, tx } from "../store";
import { bad, bump, emit, isMember, needs, notFound, PjError, between, pid, str, visibleProject, type Ctx } from "./core";
import { issueChanged, issueCreated, record, notify, triageArrived, type IssueState } from "./effects";
import { announceGoals, goalSnapshot, mergeSnapshots, settleGoals, type GoalEvent } from "./goals";
import { parseIdentifier } from "./ident";
import { cleanFieldValue, defaultStatus, fieldRow, statusRow, validLabels } from "./teams";
import {
  DEFAULT_DISPLAY,
  ESTIMATE_SCALES,
  addDays,
  dayOf,
  isDate,
  isPriority,
  type EstimateScale,
  type Grouping,
  type Issue,
  type IssueDisplay,
  type IssueFilter,
  type IssueGroup,
  type IssuePage,
  type IssueRef,
  type Ordering,
  type StatusCategory,
} from "./types";

// --- Reading -------------------------------------------------------------------

interface IssueRow {
  id: string;
  team_id: string;
  team_key: string;
  number: number;
  title: string;
  status_id: string;
  priority: number;
  estimate: number | null;
  assignee_id: string | null;
  creator_id: string | null;
  project_id: string | null;
  milestone_id: string | null;
  cycle_id: string | null;
  parent_id: string | null;
  due_date: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  canceled_at: number | null;
  archived_at: number | null;
  triage_at: number | null;
  triage_snoozed_until: number | null;
  labels: string | null;
  sub_total: number;
  sub_done: number;
  comments: number;
  attachments: number;
  blocked_by: number;
  blocking: number;
}

const CLOSED = "('completed', 'canceled')";

// `vis` (the teams the person sees) is defined by the WITH clause of each query.
const ISSUE_COLS = `i.id, i.team_id, t.key AS team_key, i.number, i.title, i.status_id, i.priority, i.estimate, i.assignee_id, i.creator_id,
  i.project_id, i.milestone_id, i.cycle_id, i.parent_id, i.due_date, i.sort_order, i.created_at, i.updated_at, i.started_at,
  i.completed_at, i.canceled_at, i.archived_at, i.triage_at, i.triage_snoozed_until,
  (SELECT group_concat(label_id) FROM pj_issue_labels WHERE issue_id = i.id) AS labels,
  (SELECT COUNT(*) FROM pj_issues c WHERE c.parent_id = i.id AND c.archived_at IS NULL AND c.team_id IN (SELECT id FROM vis)) AS sub_total,
  (SELECT COUNT(*) FROM pj_issues c JOIN pj_statuses cs ON cs.id = c.status_id WHERE c.parent_id = i.id AND c.archived_at IS NULL AND c.team_id IN (SELECT id FROM vis) AND cs.category IN ${CLOSED}) AS sub_done,
  (SELECT COUNT(*) FROM pj_comments WHERE issue_id = i.id) AS comments,
  (SELECT COUNT(*) FROM pj_attachments WHERE issue_id = i.id) AS attachments,
  (SELECT COUNT(*) FROM pj_issue_relations r JOIN pj_issues b ON b.id = r.issue_id JOIN pj_statuses bs ON bs.id = b.status_id
     WHERE r.related_id = i.id AND r.type = 'blocks' AND b.archived_at IS NULL AND b.team_id IN (SELECT id FROM vis) AND bs.category NOT IN ${CLOSED}) AS blocked_by,
  (SELECT COUNT(*) FROM pj_issue_relations r JOIN pj_issues b ON b.id = r.related_id JOIN pj_statuses bs ON bs.id = b.status_id
     WHERE r.issue_id = i.id AND r.type = 'blocks' AND b.archived_at IS NULL AND b.team_id IN (SELECT id FROM vis) AND bs.category NOT IN ${CLOSED}) AS blocking`;

const VIS = "WITH vis(id) AS (SELECT value FROM json_each(?))";

export function toIssue(r: IssueRow): Issue {
  return {
    id: r.id,
    identifier: `${r.team_key}-${r.number}`,
    teamId: r.team_id,
    number: r.number,
    title: r.title,
    statusId: r.status_id,
    priority: r.priority as Issue["priority"],
    estimate: r.estimate,
    assigneeId: r.assignee_id,
    creatorId: r.creator_id,
    projectId: r.project_id,
    milestoneId: r.milestone_id,
    cycleId: r.cycle_id,
    parentId: r.parent_id,
    dueDate: r.due_date,
    sortOrder: r.sort_order,
    labelIds: r.labels ? r.labels.split(",") : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    canceledAt: r.canceled_at,
    archivedAt: r.archived_at,
    triage: r.triage_at !== null,
    triageSnoozedUntil: r.triage_snoozed_until,
    subIssues: { total: Number(r.sub_total), done: Number(r.sub_done) },
    comments: Number(r.comments),
    attachments: Number(r.attachments),
    blockedBy: Number(r.blocked_by),
    blocking: Number(r.blocking),
  };
}

/** Issues by id, in the given order (unknown or invisible ids are skipped). */
export function issuesByIds(ctx: Ctx, ids: string[]): Issue[] {
  if (!ids.length) return [];
  const rows = sql(
    // Driven by the ids (each a primary-key lookup), not by a scan of the workspace.
    `${VIS} SELECT ${ISSUE_COLS} FROM json_each(?) j CROSS JOIN pj_issues i ON i.id = j.value JOIN pj_teams t ON t.id = i.team_id WHERE i.ws_id = ? AND i.team_id IN (SELECT id FROM vis)`
  ).all(JSON.stringify([...ctx.teams()]), JSON.stringify([...new Set(ids)]), ctx.wsId) as unknown as IssueRow[];
  const byId = new Map(rows.map((r) => [r.id, toIssue(r)]));
  return ids.map((id) => byId.get(id)).filter((x): x is Issue => Boolean(x));
}

export function getIssueBrief(ctx: Ctx, id: string): Issue {
  const [it] = issuesByIds(ctx, [id]);
  if (!it) throw notFound("issue not found");
  return it;
}

/** An issue id from an id or an identifier like ZVN-12 (old identifiers too). */
export function resolveIssueId(ctx: Ctx, ref: string): string {
  const ident = parseIdentifier(ref);
  if (ident) {
    const r = sql("SELECT i.id FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id WHERE t.ws_id = ? AND t.key = ? AND i.number = ?").get(ctx.wsId, ident.key, ident.number) as { id: string } | undefined;
    const alias = r ? undefined : (sql("SELECT issue_id AS id FROM pj_issue_aliases WHERE ws_id = ? AND identifier = ?").get(ctx.wsId, `${ident.key}-${ident.number}`) as { id: string } | undefined);
    const id = r?.id ?? alias?.id;
    if (id) return id;
  }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(ref)) throw notFound("issue not found");
  return ref;
}

export function issueRefs(ctx: Ctx, ids: string[]): Map<string, IssueRef> {
  const out = new Map<string, IssueRef>();
  if (!ids.length) return out;
  const rows = sql(
    "SELECT i.id, t.key, i.number, i.title, i.status_id, i.team_id FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id WHERE i.ws_id = ? AND i.id IN (SELECT value FROM json_each(?)) AND i.team_id IN (SELECT value FROM json_each(?))"
  ).all(ctx.wsId, JSON.stringify(ids), JSON.stringify([...ctx.teams()])) as { id: string; key: string; number: number; title: string; status_id: string; team_id: string }[];
  for (const r of rows) out.set(r.id, { id: r.id, identifier: `${r.key}-${r.number}`, title: r.title, statusId: r.status_id, teamId: r.team_id });
  return out;
}

/** The raw state of an issue (for changes and their history), checked for access. */
export function issueState(ctx: Ctx, id: string): IssueState & { ws_id: string; number: number; sort_order: number } {
  const r = sql(
    "SELECT id, ws_id, team_id, number, title, description, status_id, priority, estimate, assignee_id, project_id, milestone_id, cycle_id, parent_id, due_date, archived_at, sort_order FROM pj_issues WHERE id = ? AND ws_id = ?"
  ).get(id, ctx.wsId) as (IssueState & { ws_id: string; number: number; sort_order: number }) | undefined;
  if (!r || !ctx.teams().has(r.team_id)) throw notFound("issue not found");
  const labels = (sql("SELECT label_id FROM pj_issue_labels WHERE issue_id = ?").all(id) as { label_id: string }[]).map((x) => x.label_id);
  return { ...r, labels };
}

// --- The query behind lists and boards -----------------------------------------

interface QueryOpts {
  filter: IssueFilter;
  display?: Partial<IssueDisplay>;
  /** Issues per group (first page). */
  limit?: number;
  /** Next page of one group. */
  group?: string;
  cursor?: string | null;
  /** The viewer's calendar day (YYYY-MM-DD) for "overdue", "this week"… */
  today?: string;
  /** Due dates in [from, to] (the calendar). */
  dueFrom?: string;
  dueTo?: string;
  /** Restrict to a project / cycle (their pages). */
  scope?: { projectId?: string; cycleId?: string; teamId?: string };
}

const GROUP_KEY: Record<Grouping, string> = {
  status: "s.category || ':' || s.name",
  assignee: "IFNULL(i.assignee_id, '')",
  priority: "CAST(i.priority AS TEXT)",
  project: "IFNULL(i.project_id, '')",
  cycle: "IFNULL(i.cycle_id, '')",
  team: "i.team_id",
  none: "'all'",
};

const ORDER: Record<Ordering, { expr: string; dir: "ASC" | "DESC" }[]> = {
  manual: [{ expr: "i.sort_order", dir: "ASC" }],
  priority: [
    { expr: "(CASE i.priority WHEN 0 THEN 5 ELSE i.priority END)", dir: "ASC" },
    { expr: "i.sort_order", dir: "ASC" },
  ],
  updated: [{ expr: "i.updated_at", dir: "DESC" }],
  created: [{ expr: "i.created_at", dir: "DESC" }],
  due: [{ expr: "IFNULL(i.due_date, '9999-12-31')", dir: "ASC" }],
  title: [{ expr: "(i.title COLLATE NOCASE)", dir: "ASC" }],
  estimate: [{ expr: "IFNULL(i.estimate, -1)", dir: "DESC" }],
};

const DAY_MS = 86_400_000;

function listParam(values: string[], map: Record<string, string> = {}): string {
  return JSON.stringify(values.map((v) => map[v] ?? v));
}

/** WHERE conditions (with their parameters) for a filter. */
export function filterSql(ctx: Ctx, f: IssueFilter, d: IssueDisplay, today: string, params: unknown[]): string[] {
  const w: string[] = ["i.ws_id = ?", "i.team_id IN (SELECT id FROM vis)"];
  params.push(ctx.wsId);
  const now = Date.now();
  const me = { me: ctx.userId };
  w.push(f.archived ? "i.archived_at IS NOT NULL" : "i.archived_at IS NULL");
  // Triage is a team's intake, not its work: its issues show only in Triage.
  if (f.triage) {
    w.push("i.triage_at IS NOT NULL");
    if (!f.snoozed) {
      params.push(now);
      w.push("(i.triage_snoozed_until IS NULL OR i.triage_snoozed_until <= ?)");
    }
  } else w.push("i.triage_at IS NULL");
  const inList = (col: string, values: string[], map: Record<string, string> = {}) => {
    params.push(listParam(values, map));
    return `${col} IN (SELECT value FROM json_each(?))`;
  };
  const withNone = (col: string, values: string[] | undefined, map: Record<string, string> = {}) => {
    if (!values?.length) return;
    const real = values.filter((v) => v !== "none");
    const parts: string[] = [];
    if (real.length) parts.push(inList(col, real, map));
    if (values.includes("none")) parts.push(`${col} IS NULL`);
    w.push(`(${parts.join(" OR ")})`);
  };
  if (f.team?.length) w.push(inList("i.team_id", f.team));
  if (f.status?.length) w.push(inList("i.status_id", f.status));
  if (f.category?.length) w.push(inList("s.category", f.category));
  withNone("i.assignee_id", f.assignee, me);
  if (f.creator?.length) w.push(inList("i.creator_id", f.creator, me));
  if (f.priority?.length) {
    params.push(JSON.stringify(f.priority));
    w.push("i.priority IN (SELECT value FROM json_each(?))");
  }
  if (f.label?.length) {
    const labels = JSON.stringify(f.label);
    if (f.labelMode === "all") {
      params.push(labels, f.label.length);
      w.push("(SELECT COUNT(DISTINCT label_id) FROM pj_issue_labels l WHERE l.issue_id = i.id AND l.label_id IN (SELECT value FROM json_each(?))) = ?");
    } else {
      // A label group matches any label inside it.
      params.push(labels, labels);
      w.push(
        "EXISTS (SELECT 1 FROM pj_issue_labels l JOIN pj_labels lb ON lb.id = l.label_id WHERE l.issue_id = i.id AND (l.label_id IN (SELECT value FROM json_each(?)) OR lb.parent_id IN (SELECT value FROM json_each(?))))"
      );
    }
  }
  withNone("i.project_id", f.project);
  if (f.cycle?.length) {
    const ids = f.cycle.filter((c) => c !== "none" && c !== "current");
    const parts: string[] = [];
    if (ids.length) parts.push(inList("i.cycle_id", ids));
    if (f.cycle.includes("none")) parts.push("i.cycle_id IS NULL");
    if (f.cycle.includes("current")) {
      params.push(today, today);
      parts.push("i.cycle_id IN (SELECT id FROM pj_cycles c WHERE c.team_id = i.team_id AND c.starts_on <= ? AND c.ends_on >= ? AND c.completed_at IS NULL)");
    }
    w.push(`(${parts.join(" OR ")})`);
  }
  switch (f.due) {
    case "overdue":
      params.push(today);
      w.push(`(i.due_date < ? AND s.category NOT IN ${CLOSED})`);
      break;
    case "today":
      params.push(today);
      w.push("i.due_date = ?");
      break;
    case "week":
    case "month":
      params.push(today, addDays(today, f.due === "week" ? 7 : 31));
      w.push("i.due_date BETWEEN ? AND ?");
      break;
    case "none":
      w.push("i.due_date IS NULL");
      break;
    case "any":
      w.push("i.due_date IS NOT NULL");
      break;
  }
  const recent = { day: DAY_MS, week: 7 * DAY_MS, month: 31 * DAY_MS };
  if (f.created) {
    params.push(now - recent[f.created]);
    w.push("i.created_at >= ?");
  }
  if (f.updated) {
    params.push(now - recent[f.updated]);
    w.push("i.updated_at >= ?");
  }
  if (f.blocked)
    w.push(
      `EXISTS (SELECT 1 FROM pj_issue_relations r JOIN pj_issues b ON b.id = r.issue_id JOIN pj_statuses bs ON bs.id = b.status_id WHERE r.related_id = i.id AND r.type = 'blocks' AND b.archived_at IS NULL AND b.team_id IN (SELECT id FROM vis) AND bs.category NOT IN ${CLOSED})`
    );
  if (f.blocking)
    w.push(
      `EXISTS (SELECT 1 FROM pj_issue_relations r JOIN pj_issues b ON b.id = r.related_id JOIN pj_statuses bs ON bs.id = b.status_id WHERE r.issue_id = i.id AND r.type = 'blocks' AND b.archived_at IS NULL AND b.team_id IN (SELECT id FROM vis) AND bs.category NOT IN ${CLOSED})`
    );
  if (f.parent) {
    params.push(f.parent);
    w.push("i.parent_id = ?");
  }
  if (f.subscribed) {
    params.push(ctx.userId);
    w.push("EXISTS (SELECT 1 FROM pj_issue_subscribers su WHERE su.issue_id = i.id AND su.user_id = ? AND su.muted = 0)");
  }
  if (f.q) textCondition(f.q, w, params);
  if (d.completed === "none") w.push(`s.category NOT IN ${CLOSED}`);
  else if (d.completed === "week" || d.completed === "month") {
    params.push(now - (d.completed === "week" ? 7 : 31) * DAY_MS);
    w.push(`(s.category NOT IN ${CLOSED} OR IFNULL(i.completed_at, IFNULL(i.canceled_at, i.updated_at)) >= ?)`);
  }
  if (!d.subIssues && !f.parent) w.push("i.parent_id IS NULL");
  return w;
}

/** Text search: identifier (ZVN-12), else full text (3+ characters) or a title prefix. */
function textCondition(q: string, w: string[], params: unknown[]): void {
  const ident = parseIdentifier(q);
  const parts: string[] = [];
  if (ident) {
    params.push(ident.key, ident.number);
    parts.push("(t.key = ? AND i.number = ?)");
  } else if (/^\d{1,9}$/.test(q)) {
    params.push(Number(q));
    parts.push("i.number = ?");
  }
  const terms = ftsQuery(q);
  if (terms) {
    params.push(terms);
    parts.push("i.fts_id IN (SELECT rowid FROM pj_issues_fts WHERE pj_issues_fts MATCH ?)");
  } else {
    params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    parts.push("i.title LIKE ? ESCAPE '\\'");
  }
  w.push(`(${parts.join(" OR ")})`);
}

/** An FTS5 query: every word (3+ characters) must appear; null if none qualifies. */
export function ftsQuery(q: string): string | null {
  const words = q
    .split(/\s+/)
    .map((x) => x.replace(/"/g, ""))
    .filter((x) => [...x].length >= 3)
    .slice(0, 8);
  return words.length ? words.map((x) => `"${x}"`).join(" AND ") : null;
}

function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

function decodeCursor(c: string, n: number): unknown[] {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === n && v.every((x) => typeof x === "string" || typeof x === "number")) return v;
  } catch {
    // fall through
  }
  throw bad("bad cursor");
}

/** Keyset condition "after this row" for a mixed-direction ORDER BY. */
function keysetAfter(order: { expr: string; dir: "ASC" | "DESC" }[], values: unknown[], params: unknown[]): string {
  const ors: string[] = [];
  for (let k = 0; k < order.length; k++) {
    const ands: string[] = [];
    for (let j = 0; j < k; j++) {
      ands.push(`${order[j].expr} = ?`);
      params.push(values[j]);
    }
    ands.push(`${order[k].expr} ${order[k].dir === "ASC" ? ">" : "<"} ?`);
    params.push(values[k]);
    ors.push(`(${ands.join(" AND ")})`);
  }
  return `(${ors.join(" OR ")})`;
}

export function queryIssues(ctx: Ctx, opts: QueryOpts): IssuePage {
  const d: IssueDisplay = { ...DEFAULT_DISPLAY, ...(opts.display ?? {}) };
  const today = opts.today && isDate(opts.today) ? opts.today : dayOf(Date.now());
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const group = d.layout === "calendar" ? "none" : d.group;
  const gk = GROUP_KEY[group];
  const order = [...ORDER[d.order], { expr: "i.id", dir: "ASC" as const }];
  const params: unknown[] = [JSON.stringify([...ctx.teams()])];
  const where = filterSql(ctx, opts.filter, d, today, params);
  if (opts.scope?.projectId) {
    params.push(opts.scope.projectId);
    where.push("i.project_id = ?");
  }
  if (opts.scope?.cycleId) {
    params.push(opts.scope.cycleId);
    where.push("i.cycle_id = ?");
  }
  if (opts.scope?.teamId) {
    params.push(opts.scope.teamId);
    where.push("i.team_id = ?");
  }
  if (opts.dueFrom && opts.dueTo && isDate(opts.dueFrom) && isDate(opts.dueTo)) {
    params.push(opts.dueFrom, opts.dueTo);
    where.push("i.due_date BETWEEN ? AND ?");
  }
  const from = `FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id JOIN pj_statuses s ON s.id = i.status_id WHERE ${where.join(" AND ")}`;
  const orderBy = order.map((o) => `${o.expr} ${o.dir}`).join(", ");

  if (opts.group !== undefined) {
    // The next page of one group.
    const p = [...params, opts.group];
    let cond = `${gk} = ?`;
    if (opts.cursor) cond += ` AND ${keysetAfter(order, decodeCursor(opts.cursor, order.length), p)}`;
    p.push(limit + 1);
    const rows = sql(`${VIS} SELECT i.id, ${order.map((o, n) => `${o.expr} AS o${n}`).join(", ")} ${from} AND ${cond} ORDER BY ${orderBy} LIMIT ?`).all(...(p as never[])) as Record<string, unknown>[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const count = sql(`${VIS} SELECT COUNT(*) AS n ${from} AND ${gk} = ?`).get(...([...params, opts.group] as never[])) as { n: number };
    return {
      groups: [{ key: opts.group, count: Number(count.n), items: issuesByIds(ctx, page.map((r) => r.id as string)), cursor: more && last ? encodeCursor(order.map((_, n) => last[`o${n}`])) : null }],
      total: Number(count.n),
    };
  }

  const counts = sql(`${VIS} SELECT ${gk} AS gk, COUNT(*) AS n ${from} GROUP BY gk`).all(...(params as never[])) as { gk: string; n: number }[];
  const ranked = sql(
    `${VIS} SELECT id, gk, rn, ${order.map((_, n) => `o${n}`).join(", ")} FROM (SELECT i.id, ${gk} AS gk, ${order.map((o, n) => `${o.expr} AS o${n}`).join(", ")}, ROW_NUMBER() OVER (PARTITION BY ${gk} ORDER BY ${orderBy}) AS rn ${from}) WHERE rn <= ? ORDER BY gk, rn`
  ).all(...([...params, limit] as never[])) as Record<string, unknown>[];
  const issues = new Map(issuesByIds(ctx, ranked.map((r) => r.id as string)).map((x) => [x.id, x]));
  const groups: IssueGroup[] = counts.map((c) => {
    const rows = ranked.filter((r) => r.gk === c.gk);
    const last = rows[rows.length - 1];
    return {
      key: c.gk,
      count: Number(c.n),
      items: rows.map((r) => issues.get(r.id as string)).filter((x): x is Issue => Boolean(x)),
      cursor: Number(c.n) > rows.length && last ? encodeCursor(order.map((_, n) => last[`o${n}`])) : null,
    };
  });
  return { groups, total: counts.reduce((a, c) => a + Number(c.n), 0) };
}

// --- Writing -------------------------------------------------------------------

export interface IssueInput {
  teamId?: unknown;
  title?: unknown;
  description?: unknown;
  statusId?: unknown;
  priority?: unknown;
  estimate?: unknown;
  assigneeId?: unknown;
  projectId?: unknown;
  milestoneId?: unknown;
  cycleId?: unknown;
  parentId?: unknown;
  dueDate?: unknown;
  labelIds?: unknown;
  addLabelIds?: unknown;
  removeLabelIds?: unknown;
  archived?: unknown;
  /** Manual position: between two neighbours (ids of the same workspace). */
  position?: unknown;
  fields?: unknown;
  /** On create: send it to the team's triage (when the team has triage on). */
  triage?: unknown;
}

const DESCRIPTION_MAX = 100_000;

function teamRow(ctx: Ctx, teamId: unknown): { id: string; estimates: EstimateScale; cycles_enabled: number; triage: number } {
  if (typeof teamId !== "string" || !ctx.teams().has(teamId)) throw notFound("team not found");
  const r = sql("SELECT id, estimates, cycles_enabled, triage FROM pj_teams WHERE id = ? AND ws_id = ? AND archived_at IS NULL").get(teamId, ctx.wsId) as
    | { id: string; estimates: EstimateScale; cycles_enabled: number; triage: number }
    | undefined;
  if (!r) throw notFound("team not found");
  return r;
}

function checkAssignee(ctx: Ctx, v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !isMember(ctx.wsId, v)) throw bad("assignee is not a member");
  return v;
}

function checkProject(ctx: Ctx, v: unknown): string | null {
  if (v === null) return null;
  // A project of private teams the person does not see is "unknown" (and never gets linked to another team).
  if (typeof v !== "string" || !visibleProject(ctx, v)) throw bad("unknown project");
  return v;
}

function checkMilestone(ctx: Ctx, v: unknown, projectId: string | null): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !projectId || !sql("SELECT 1 FROM pj_milestones WHERE id = ? AND ws_id = ? AND project_id = ?").get(v, ctx.wsId, projectId)) throw bad("unknown milestone");
  return v;
}

function checkCycle(ctx: Ctx, v: unknown, teamId: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !sql("SELECT 1 FROM pj_cycles WHERE id = ? AND ws_id = ? AND team_id = ? AND completed_at IS NULL").get(v, ctx.wsId, teamId)) throw bad("unknown or closed cycle");
  return v;
}

function checkParent(ctx: Ctx, v: unknown, self: string | null): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw bad("bad parent");
  const p = sql("SELECT id, team_id FROM pj_issues WHERE id = ? AND ws_id = ?").get(v, ctx.wsId) as { id: string; team_id: string } | undefined;
  if (!p || !ctx.teams().has(p.team_id)) throw bad("unknown parent");
  if (self) {
    // No loops: the new parent must not be the issue itself or one of its sub-issues.
    let cur: string | null = p.id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === self) throw new PjError(409, "parent loop");
      seen.add(cur);
      cur = (sql("SELECT parent_id FROM pj_issues WHERE id = ?").get(cur) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
  }
  return p.id;
}

function checkEstimate(v: unknown, scale: EstimateScale): number | null {
  if (v === null) return null;
  const n = Number(v);
  if (scale === "none" || !(ESTIMATE_SCALES[scale] as readonly number[]).includes(n)) throw bad("bad estimate");
  return n;
}

function checkDue(v: unknown): string | null {
  if (v === null) return null;
  if (!isDate(v)) throw bad("bad date");
  return v;
}

function statusTimes(category: StatusCategory, now: number): { started_at?: number; completed_at: number | null; canceled_at: number | null } {
  return {
    ...(category === "started" ? { started_at: now } : {}),
    completed_at: category === "completed" ? now : null,
    canceled_at: category === "canceled" ? now : null,
  };
}

function setFieldValues(ctx: Ctx, issueId: string, teamId: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("bad fields");
  for (const [fieldId, value] of Object.entries(raw as Record<string, unknown>)) {
    const f = fieldRow(ctx, fieldId);
    if (f.teamId && f.teamId !== teamId) throw bad("field of another team");
    const v = cleanFieldValue(f, value);
    const before = sql("SELECT value FROM pj_field_values WHERE issue_id = ? AND field_id = ?").get(issueId, fieldId) as { value: string } | undefined;
    if ((before?.value ?? null) === v) continue;
    if (v === null) sql("DELETE FROM pj_field_values WHERE issue_id = ? AND field_id = ?").run(issueId, fieldId);
    else sql("INSERT INTO pj_field_values (issue_id, field_id, value) VALUES (?, ?, ?) ON CONFLICT(issue_id, field_id) DO UPDATE SET value = excluded.value").run(issueId, fieldId, v);
    record(ctx, issueId, "field", { field: fieldId, value: before?.value ?? null }, { field: fieldId, value: v });
  }
}

export function createIssue(ctx: Ctx, input: IssueInput): Issue {
  needs(ctx, "edit");
  const team = teamRow(ctx, input.teamId);
  const title = str(input.title, 300);
  const description = input.description === undefined ? "" : str(input.description, DESCRIPTION_MAX, { allowEmpty: true, trim: false });
  const statusId = input.statusId === undefined ? defaultStatus(team.id) : String(input.statusId);
  const status = statusRow(ctx, statusId);
  if (status.team_id !== team.id) throw bad("status of another team");
  if (input.priority !== undefined && !isPriority(input.priority)) throw bad("bad priority");
  const priority = (input.priority as number | undefined) ?? 0;
  const estimate = input.estimate === undefined ? null : checkEstimate(input.estimate, team.estimates);
  const assignee = input.assigneeId === undefined ? null : checkAssignee(ctx, input.assigneeId);
  const project = input.projectId === undefined ? null : checkProject(ctx, input.projectId);
  const milestone = input.milestoneId === undefined ? null : checkMilestone(ctx, input.milestoneId, project);
  const cycle = input.cycleId === undefined ? null : checkCycle(ctx, input.cycleId, team.id);
  const parent = input.parentId === undefined ? null : checkParent(ctx, input.parentId, null);
  const due = input.dueDate === undefined ? null : checkDue(input.dueDate);
  const labels = input.labelIds === undefined ? [] : validLabels(ctx, team.id, input.labelIds);
  const now = Date.now();
  const id = pid();
  // A team with triage on gets issues from outside it (or sent there on purpose) in its intake.
  const triage = team.triage === 1 && (input.triage === true || !sql("SELECT 1 FROM pj_team_members WHERE team_id = ? AND user_id = ?").get(team.id, ctx.userId));
  let goals: GoalEvent[] = [];
  tx(() => {
    const snap = goalSnapshot([project], [milestone]);
    const seq = sql("UPDATE pj_teams SET issue_seq = issue_seq + 1 WHERE id = ? RETURNING issue_seq").get(team.id) as { issue_seq: number };
    const top = sql("SELECT MIN(sort_order) AS m FROM pj_issues WHERE team_id = ? AND status_id = ?").get(team.id, statusId) as { m: number | null };
    const times = statusTimes(status.category, now);
    sql(
      `INSERT INTO pj_issues (id, ws_id, team_id, number, title, description, status_id, priority, estimate, assignee_id, creator_id, project_id, milestone_id,
        cycle_id, parent_id, due_date, sort_order, created_at, updated_at, status_changed_at, started_at, completed_at, canceled_at, triage_at, fts_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT IFNULL(MAX(fts_id), 0) + 1 FROM pj_issues))`
    ).run(
      id,
      ctx.wsId,
      team.id,
      Number(seq.issue_seq),
      title,
      description,
      statusId,
      priority,
      estimate,
      assignee,
      ctx.userId,
      project,
      milestone,
      cycle,
      parent,
      due,
      top.m === null ? 0 : Number(top.m) - 1,
      now,
      now,
      now,
      times.started_at ?? null,
      times.completed_at,
      times.canceled_at,
      triage ? now : null
    );
    for (const l of labels) sql("INSERT INTO pj_issue_labels (issue_id, label_id) VALUES (?, ?)").run(id, l);
    if (project) sql("INSERT OR IGNORE INTO pj_project_teams (project_id, team_id) VALUES (?, ?)").run(project, team.id);
    setFieldValues(ctx, id, team.id, input.fields);
    issueCreated(
      ctx,
      { id, team_id: team.id, title, description, status_id: statusId, priority, estimate, assignee_id: assignee, project_id: project, milestone_id: milestone, cycle_id: cycle, parent_id: parent, due_date: due, archived_at: null, labels },
      now
    );
    if (triage) triageArrived(ctx, team.id, id);
    // New work under a goal moves it (and reopens one zvena had completed).
    goals = settleGoals(ctx, snap, now);
    bump(ctx.wsId);
  });
  emit(ctx, "issue", id, { created: true });
  announceGoals(ctx, goals);
  return getIssueBrief(ctx, id);
}

/** Sort order between two neighbours (either may be missing). */
function positionBetween(ctx: Ctx, pos: unknown): number {
  const p = (pos && typeof pos === "object" ? pos : {}) as { before?: unknown; after?: unknown };
  const order = (id: unknown): number | null => {
    if (id === undefined || id === null) return null;
    const r = sql("SELECT sort_order, team_id FROM pj_issues WHERE id = ? AND ws_id = ?").get(String(id), ctx.wsId) as { sort_order: number; team_id: string } | undefined;
    if (!r || !ctx.teams().has(r.team_id)) throw bad("unknown neighbour");
    return Number(r.sort_order);
  };
  // "before": the issue shown above the new place; "after": the one below it.
  const above = order(p.before);
  const below = order(p.after);
  if (above !== null && below !== null && Math.abs(below - above) < 1e-9) return above + 1e-7;
  return between(above, below);
}

/** Changes an issue; `goals` receives what that did to its project and milestone. */
export function updateIssue(ctx: Ctx, id: string, input: IssueInput, goals: GoalEvent[] = []): Issue {
  needs(ctx, "edit");
  tx(() => goals.push(...applyUpdate(ctx, id, input)));
  emit(ctx, "issue", id);
  announceGoals(ctx, goals);
  return getIssueBrief(ctx, id);
}

function applyUpdate(ctx: Ctx, id: string, input: IssueInput): GoalEvent[] {
  const before = issueState(ctx, id);
  const after: IssueState = { ...before, labels: [...before.labels] };
  const now = Date.now();
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  let team = teamRow(ctx, before.team_id);

  if (input.teamId !== undefined && input.teamId !== before.team_id) {
    // Moving to another team: a new number there; the old identifier keeps working.
    team = teamRow(ctx, input.teamId);
    const oldKey = (sql("SELECT key FROM pj_teams WHERE id = ?").get(before.team_id) as { key: string }).key;
    sql("INSERT OR IGNORE INTO pj_issue_aliases (ws_id, identifier, issue_id) VALUES (?, ?, ?)").run(ctx.wsId, `${oldKey}-${before.number}`, id);
    const seq = sql("UPDATE pj_teams SET issue_seq = issue_seq + 1 WHERE id = ? RETURNING issue_seq").get(team.id) as { issue_seq: number };
    set("team_id", team.id);
    set("number", Number(seq.issue_seq));
    after.team_id = team.id;
    // Same kind of status in the new team; team-only things are dropped.
    const cat = statusRow(ctx, before.status_id).category;
    const mapped =
      (sql("SELECT id FROM pj_statuses WHERE team_id = ? AND category = ? ORDER BY position LIMIT 1").get(team.id, cat) as { id: string } | undefined)?.id ?? defaultStatus(team.id);
    after.status_id = mapped;
    after.cycle_id = null;
    after.labels = after.labels.filter((l) => {
      const r = sql("SELECT team_id FROM pj_labels WHERE id = ?").get(l) as { team_id: string | null } | undefined;
      return r && (r.team_id === null || r.team_id === team.id);
    });
    if (after.estimate !== null && !(ESTIMATE_SCALES[team.estimates] as readonly number[]).includes(after.estimate)) after.estimate = null;
  }
  if (input.title !== undefined) after.title = str(input.title, 300);
  if (input.description !== undefined) after.description = str(input.description, DESCRIPTION_MAX, { allowEmpty: true, trim: false });
  if (input.statusId !== undefined) {
    const s = statusRow(ctx, String(input.statusId));
    if (s.team_id !== after.team_id) throw bad("status of another team");
    after.status_id = s.id;
  }
  if (input.priority !== undefined) {
    if (!isPriority(input.priority)) throw bad("bad priority");
    after.priority = input.priority;
  }
  if (input.estimate !== undefined) after.estimate = checkEstimate(input.estimate, team.estimates);
  if (input.assigneeId !== undefined) after.assignee_id = checkAssignee(ctx, input.assigneeId);
  if (input.projectId !== undefined) {
    after.project_id = checkProject(ctx, input.projectId);
    if (after.project_id !== before.project_id) after.milestone_id = null;
  }
  if (input.milestoneId !== undefined) after.milestone_id = checkMilestone(ctx, input.milestoneId, after.project_id);
  if (input.cycleId !== undefined) after.cycle_id = checkCycle(ctx, input.cycleId, after.team_id);
  if (input.parentId !== undefined) after.parent_id = checkParent(ctx, input.parentId, id);
  if (input.dueDate !== undefined) after.due_date = checkDue(input.dueDate);
  if (input.labelIds !== undefined) after.labels = validLabels(ctx, after.team_id, input.labelIds);
  if (input.addLabelIds !== undefined || input.removeLabelIds !== undefined) {
    const add = input.addLabelIds === undefined ? [] : validLabels(ctx, after.team_id, input.addLabelIds);
    const remove = Array.isArray(input.removeLabelIds) ? input.removeLabelIds.map(String) : [];
    // A label of a group replaces the issue's other label of that group.
    const groupsOf = (ids: string[]) =>
      new Map((sql("SELECT id, parent_id FROM pj_labels WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { id: string; parent_id: string | null }[]).map((r) => [r.id, r.parent_id]));
    const addGroups = new Set([...groupsOf(add).values()].filter(Boolean));
    const cur = groupsOf(after.labels);
    after.labels = [...new Set([...after.labels.filter((l) => !remove.includes(l) && !addGroups.has(cur.get(l) ?? null)), ...add])];
  }
  if (input.archived !== undefined) after.archived_at = input.archived === true ? (before.archived_at ?? now) : null;

  const cols: [keyof IssueState, string][] = [
    ["title", "title"],
    ["description", "description"],
    ["priority", "priority"],
    ["estimate", "estimate"],
    ["assignee_id", "assignee_id"],
    ["project_id", "project_id"],
    ["milestone_id", "milestone_id"],
    ["cycle_id", "cycle_id"],
    ["parent_id", "parent_id"],
    ["due_date", "due_date"],
    ["archived_at", "archived_at"],
  ];
  for (const [k, col] of cols) if (after[k] !== before[k]) set(col, after[k] as string | number | null);
  if (after.status_id !== before.status_id) {
    const s = statusRow(ctx, after.status_id);
    const prev = statusRow(ctx, before.status_id);
    set("status_id", after.status_id);
    set("status_changed_at", now);
    if (s.category === "started" && prev.category !== "started") set("started_at", now);
    if (s.category !== prev.category) {
      set("completed_at", s.category === "completed" ? now : null);
      set("canceled_at", s.category === "canceled" ? now : null);
    }
    // A status change without an explicit place puts the issue on top of its new column.
    if (input.position === undefined) {
      const top = sql("SELECT MIN(sort_order) AS m FROM pj_issues WHERE team_id = ? AND status_id = ?").get(after.team_id, after.status_id) as { m: number | null };
      set("sort_order", top.m === null ? before.sort_order : Number(top.m) - 1);
    }
  }
  if (input.position !== undefined) set("sort_order", positionBetween(ctx, input.position));
  const labelsChanged = after.labels.length !== before.labels.length || after.labels.some((l) => !before.labels.includes(l));
  if (labelsChanged) {
    sql("DELETE FROM pj_issue_labels WHERE issue_id = ?").run(id);
    for (const l of after.labels) sql("INSERT INTO pj_issue_labels (issue_id, label_id) VALUES (?, ?)").run(id, l);
  }
  setFieldValues(ctx, id, after.team_id, input.fields);
  if (!sets.length && !labelsChanged && input.fields === undefined) return [];
  set("updated_at", now);
  // The goals this change can move: the project and milestone before and after.
  const moves = after.status_id !== before.status_id || after.project_id !== before.project_id || after.milestone_id !== before.milestone_id || after.archived_at !== before.archived_at;
  const snap = moves ? goalSnapshot([before.project_id, after.project_id], [before.milestone_id, after.milestone_id]) : null;
  sql(`UPDATE pj_issues SET ${sets.join(", ")} WHERE id = ? AND ws_id = ?`).run(...vals, id, ctx.wsId);
  if (after.project_id && after.project_id !== before.project_id) sql("INSERT OR IGNORE INTO pj_project_teams (project_id, team_id) VALUES (?, ?)").run(after.project_id, after.team_id);
  issueChanged(ctx, before, after, now, {
    statusName: (sid) => {
      const s = statusRow(ctx, sid);
      return { name: s.name, category: s.category };
    },
  });
  bump(ctx.wsId);
  return snap ? settleGoals(ctx, snap, now) : [];
}

/** The same change applied to many issues at once (all or nothing). */
export function updateIssues(ctx: Ctx, ids: unknown, input: IssueInput, goals: GoalEvent[] = []): Issue[] {
  needs(ctx, "edit");
  if (!Array.isArray(ids) || !ids.length || ids.length > 250) throw bad("bad ids");
  const list = [...new Set(ids.map(String))];
  if (input.position !== undefined || input.title !== undefined || input.description !== undefined) throw bad("not a bulk change");
  tx(() => {
    for (const id of list) {
      // A status by category maps to each issue's own team ("move all to Done").
      const own = { ...input };
      if (typeof input.statusId === "string" && input.statusId.startsWith("category:")) {
        const cat = input.statusId.slice(9) as StatusCategory;
        const team = issueState(ctx, id).team_id;
        const s = sql("SELECT id FROM pj_statuses WHERE team_id = ? AND category = ? ORDER BY position LIMIT 1").get(team, cat) as { id: string } | undefined;
        if (!s) throw bad("no status of that category");
        own.statusId = s.id;
      }
      goals.push(...applyUpdate(ctx, id, own));
    }
  });
  for (const id of list) emit(ctx, "issue", id);
  announceGoals(ctx, goals);
  return issuesByIds(ctx, list);
}

export function deleteIssues(ctx: Ctx, ids: unknown): number {
  needs(ctx, "edit");
  if (!Array.isArray(ids) || !ids.length || ids.length > 250) throw bad("bad ids");
  const list = [...new Set(ids.map(String))];
  let n = 0;
  // Sub-issues (they lose their parent) and related issues (they lose the relation) change too.
  const touched = new Set<string>();
  let goals: GoalEvent[] = [];
  tx(() => {
    let snap = goalSnapshot([]);
    for (const id of list) {
      const st = issueState(ctx, id);
      snap = mergeSnapshots(snap, goalSnapshot([st.project_id], [st.milestone_id]));
      for (const r of sql(
        "SELECT id FROM pj_issues WHERE parent_id = ? UNION SELECT related_id FROM pj_issue_relations WHERE issue_id = ? UNION SELECT issue_id FROM pj_issue_relations WHERE related_id = ?"
      ).all(id, id, id) as { id: string }[])
        touched.add(r.id);
      n += Number(sql("DELETE FROM pj_issues WHERE id = ? AND ws_id = ?").run(id, ctx.wsId).changes);
    }
    goals = settleGoals(ctx, snap);
    bump(ctx.wsId);
  });
  audit(ctx.userId, "projects.issue.delete", ctx.wsId, { count: n });
  for (const id of list) emit(ctx, "issue", id, { deleted: true });
  for (const id of touched) if (!list.includes(id)) emit(ctx, "issue", id);
  announceGoals(ctx, goals);
  return n;
}

// --- Detail --------------------------------------------------------------------

export function subIssues(ctx: Ctx, parentId: string): Issue[] {
  const ids = (sql("SELECT id FROM pj_issues WHERE parent_id = ? AND ws_id = ? AND archived_at IS NULL AND team_id IN (SELECT value FROM json_each(?)) ORDER BY sort_order, created_at").all(
    parentId,
    ctx.wsId,
    JSON.stringify([...ctx.teams()])
  ) as { id: string }[]).map((r) => r.id);
  return issuesByIds(ctx, ids);
}

export function issueDescription(ctx: Ctx, id: string): string {
  return issueState(ctx, id).description;
}

export function fieldValues(issueId: string): Record<string, string> {
  return Object.fromEntries((sql("SELECT field_id, value FROM pj_field_values WHERE issue_id = ?").all(issueId) as { field_id: string; value: string }[]).map((r) => [r.field_id, r.value]));
}

export function aliasesOf(issueId: string): string[] {
  return (sql("SELECT identifier FROM pj_issue_aliases WHERE issue_id = ?").all(issueId) as { identifier: string }[]).map((r) => r.identifier);
}

/** Sends "due soon" and "overdue" reminders once per issue and due date (hourly job). */
export function sendDueReminders(now = Date.now()): number {
  const today = dayOf(now);
  const tomorrow = addDays(today, 1);
  const rows = sql(
    `SELECT i.id, i.ws_id, i.team_id, i.assignee_id, i.due_date FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id
     WHERE i.assignee_id IS NOT NULL AND i.archived_at IS NULL AND i.due_date IS NOT NULL AND i.due_date <= ? AND s.category NOT IN ${CLOSED}
     AND i.due_date >= ? LIMIT 2000`
  ).all(tomorrow, addDays(today, -7)) as { id: string; ws_id: string; team_id: string; assignee_id: string; due_date: string }[];
  let sent = 0;
  for (const r of rows) {
    const kind = r.due_date < today ? "overdue" : "due_soon";
    const fresh = Number(sql("INSERT OR IGNORE INTO pj_reminders (issue_id, kind, due_date) VALUES (?, ?, ?)").run(r.id, kind, r.due_date).changes) > 0;
    if (!fresh) continue;
    const ctx: Ctx = { userId: r.assignee_id, wsId: r.ws_id, role: "viewer", teams: () => new Set([r.team_id]) };
    if (notify(ctx, r.assignee_id, kind, { issueId: r.id, teamId: r.team_id }, { due: r.due_date }, { selfOk: true })) {
      sent++;
      bump(r.ws_id);
    }
  }
  return sent;
}
