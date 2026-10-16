// Insights (Linear's Insights): how a team's work flows, computed on the
// server from the issues the person may see — never sent whole to the browser.
//
//   flow       issues created and completed per 7-day period (the newest ends today)
//   cycle      median days from started to completed, per period
//   tiles      open now, completed in the range, median cycle and lead time
//   breakdown  open issues by status, assignee, priority and label
//
// Scope: a team or a project (or the whole workspace), archived issues and
// issues still in triage left out, as everywhere else.

import { sql } from "../store";
import { bad, visibleProject, type Ctx } from "./core";
import { isDate } from "./types";

const DAY = 86_400_000;
export const INSIGHT_RANGES = [4, 12, 26] as const;

export interface Insights {
  /** The last day (YYYY-MM-DD, UTC) of each 7-day period, oldest first. */
  periods: string[];
  created: number[];
  completed: number[];
  /** Median days from started to completed of the issues completed in each period (null: none). */
  cycleDays: (number | null)[];
  open: number;
  completedInRange: number;
  createdInRange: number;
  medianCycleDays: number | null;
  medianLeadDays: number | null;
  byStatus: { id: string; count: number }[];
  byAssignee: { id: string | null; count: number }[];
  byPriority: { priority: number; count: number }[];
  byLabel: { id: string; count: number }[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  const v = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v * 10) / 10;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function insights(ctx: Ctx, opts: { teamId?: string | null; projectId?: string | null; weeks?: unknown; today?: unknown }): Insights {
  const weeks = (INSIGHT_RANGES as readonly number[]).includes(Number(opts.weeks)) ? Number(opts.weeks) : 12;
  const where = ["i.ws_id = ?", "i.team_id IN (SELECT value FROM json_each(?))", "i.archived_at IS NULL", "i.triage_at IS NULL"];
  const params: unknown[] = [ctx.wsId, JSON.stringify([...ctx.teams()])];
  if (opts.teamId) {
    if (!ctx.teams().has(opts.teamId)) throw bad("unknown team");
    where.push("i.team_id = ?");
    params.push(opts.teamId);
  }
  if (opts.projectId) {
    if (!visibleProject(ctx, opts.projectId)) throw bad("unknown project");
    where.push("i.project_id = ?");
    params.push(opts.projectId);
  }
  // The newest period ends at the end of "today" (the person's day when given, else the server's).
  const todayStr = isDate(opts.today) ? opts.today : ymd(Date.now());
  const end = Date.parse(`${todayStr}T00:00:00Z`) + DAY;
  const start = end - weeks * 7 * DAY;
  const rows = sql(
    `SELECT i.created_at, i.started_at, i.completed_at, s.category FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id
     WHERE ${where.join(" AND ")} AND (i.created_at >= ? OR i.completed_at >= ? OR s.category NOT IN ('completed', 'canceled'))`
  ).all(...([...params, start, start] as never[])) as { created_at: number; started_at: number | null; completed_at: number | null; category: string }[];

  const periods = Array.from({ length: weeks }, (_, k) => ymd(start + (k + 1) * 7 * DAY - DAY));
  const created = new Array<number>(weeks).fill(0);
  const completed = new Array<number>(weeks).fill(0);
  const cycles: number[][] = Array.from({ length: weeks }, () => []);
  const allCycles: number[] = [];
  const leads: number[] = [];
  const bucket = (t: number) => Math.floor((t - start) / (7 * DAY));
  let open = 0;
  for (const r of rows) {
    if (r.category !== "completed" && r.category !== "canceled") open++;
    const c = bucket(r.created_at);
    if (c >= 0 && c < weeks) created[c]++;
    if (r.category === "completed" && r.completed_at !== null) {
      const d = bucket(r.completed_at);
      if (d >= 0 && d < weeks) {
        completed[d]++;
        leads.push((r.completed_at - r.created_at) / DAY);
        if (r.started_at !== null && r.started_at <= r.completed_at) {
          const days = (r.completed_at - r.started_at) / DAY;
          cycles[d].push(days);
          allCycles.push(days);
        }
      }
    }
  }

  // What is open now, by the fields people triage by.
  const openWhere = `${where.join(" AND ")} AND s.category NOT IN ('completed', 'canceled')`;
  const from = `FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id WHERE ${openWhere}`;
  const byStatus = (sql(`SELECT i.status_id AS id, COUNT(*) AS n ${from} GROUP BY i.status_id ORDER BY n DESC`).all(...(params as never[])) as { id: string; n: number }[]).map((r) => ({
    id: r.id,
    count: Number(r.n),
  }));
  const byAssignee = (sql(`SELECT i.assignee_id AS id, COUNT(*) AS n ${from} GROUP BY i.assignee_id ORDER BY n DESC LIMIT 12`).all(...(params as never[])) as { id: string | null; n: number }[]).map(
    (r) => ({ id: r.id, count: Number(r.n) })
  );
  const byPriority = (sql(`SELECT i.priority AS p, COUNT(*) AS n ${from} GROUP BY i.priority ORDER BY CASE i.priority WHEN 0 THEN 5 ELSE i.priority END`).all(...(params as never[])) as { p: number; n: number }[]).map(
    (r) => ({ priority: Number(r.p), count: Number(r.n) })
  );
  const byLabel = (
    sql(`SELECT l.label_id AS id, COUNT(*) AS n FROM pj_issue_labels l JOIN pj_issues i ON i.id = l.issue_id JOIN pj_statuses s ON s.id = i.status_id WHERE ${openWhere} GROUP BY l.label_id ORDER BY n DESC LIMIT 12`).all(
      ...(params as never[])
    ) as { id: string; n: number }[]
  ).map((r) => ({ id: r.id, count: Number(r.n) }));

  return {
    periods,
    created,
    completed,
    cycleDays: cycles.map(median),
    open,
    completedInRange: completed.reduce((a, b) => a + b, 0),
    createdInRange: created.reduce((a, b) => a + b, 0),
    medianCycleDays: median(allCycles),
    medianLeadDays: median(leads),
    byStatus,
    byAssignee,
    byPriority,
    byLabel,
  };
}
