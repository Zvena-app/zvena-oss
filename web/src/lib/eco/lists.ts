// Lists of issues for other products to show live: a project's issues inside
// its document, my open issues on a page. Server-only; Projects' own query
// decides what the person may see.

import { ctxFor, type Ctx } from "../projects/core";
import { queryIssues } from "../projects/issues";
import { listCycles, listProjects } from "../projects/planning";
import { listTeams } from "../projects/teams";
import type { StatusCategory } from "../projects/types";
import { cardsFor, type Viewer } from "./cards";
import type { Card } from "./types";

function readCtx(v: Viewer): Ctx | null {
  try {
    return ctxFor(v.userId, v.wsId, "read");
  } catch {
    return null;
  }
}

const OPEN: StatusCategory[] = ["started", "unstarted", "backlog"];
const ALL: StatusCategory[] = ["started", "unstarted", "backlog", "completed"];

/** A project's issues, or the person's own; open ones, or done too. In progress first, then by priority. */
export async function issueList(v: Viewer, opts: { project?: string | null; mine?: boolean; done?: boolean; limit?: number; dueFrom?: string; dueTo?: string }): Promise<Card[]> {
  const ctx = readCtx(v);
  if (!ctx || (!opts.project && !opts.mine)) return [];
  const filter = { ...(opts.project ? { project: [opts.project] } : {}), ...(opts.mine ? { assignee: ["me"] } : {}), category: opts.done ? ALL : OPEN };
  let ids: string[] = [];
  try {
    // A due-date window (Calendar's layer) is applied in the query, before the limit.
    const window = opts.dueFrom && opts.dueTo ? { dueFrom: opts.dueFrom, dueTo: opts.dueTo } : {};
    const page = queryIssues(ctx, { filter, display: { group: "none", order: window.dueFrom ? "due" : "priority", subIssues: true }, limit: Math.min(opts.limit ?? 50, 100), ...window });
    ids = page.groups.flatMap((g) => g.items.map((i) => i.id));
  } catch {
    return [];
  }
  const rank: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, completed: 3, canceled: 4 };
  const cards = await cardsFor(v, ids.map((id) => `issue:${id}`));
  // Stable: Projects' priority order within each status group.
  return cards.map((c, i) => ({ c, i })).sort((a, b) => (rank[a.c.status?.category ?? "backlog"] ?? 5) - (rank[b.c.status?.category ?? "backlog"] ?? 5) || a.i - b.i).map((x) => x.c);
}

/** Projects to choose from (pickers). */
export function projectOptions(v: Viewer): { id: string; name: string; icon: string | null; color: string }[] {
  const ctx = readCtx(v);
  if (!ctx) return [];
  return listProjects(ctx)
    .filter((p) => p.state !== "canceled")
    .map((p) => ({ id: p.id, name: p.name, icon: p.icon, color: p.color }));
}

/** The teams' cycles (Calendar shows them as read-only ranges): Projects' own list, only teams the person sees. */
export function cycleList(v: Viewer): { id: string; number: number; name: string; teamKey: string; teamName: string; color: string; startsOn: string; endsOn: string; url: string }[] {
  const ctx = readCtx(v);
  if (!ctx) return [];
  try {
    const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
    return listCycles(ctx)
      .filter((c) => teams.has(c.teamId) && !teams.get(c.teamId)?.archivedAt)
      .map((c) => {
        const t = teams.get(c.teamId)!;
        return { id: c.id, number: c.number, name: c.name, teamKey: t.key, teamName: t.name, color: t.color, startsOn: c.startsOn, endsOn: c.endsOn, url: `/projects/team/${encodeURIComponent(t.key)}/cycles/${c.number}?ws=${encodeURIComponent(v.wsId)}` };
      });
  } catch {
    return [];
  }
}
