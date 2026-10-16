// "My day" on Home: what is on this person's plate across products. Server-only.
//
//   issues     assigned to me and open: overdue first, then due today, then
//              in progress, then the rest (by priority)
//   mentions   documents and issues that @mention me, newest first
//   projects   projects that are under way
//
// Everything is a card the person may see; Home renders them live.

import { ctxFor, type Ctx } from "../projects/core";
import { queryIssues } from "../projects/issues";
import { listProjects } from "../projects/planning";
import { cardsFor, type Viewer } from "./cards";
import { sql } from "../store";
import { ecoDb } from "./schema";
import type { Card } from "./types";

export interface MyDay {
  today: string;
  issues: Card[];
  overdue: number;
  dueToday: number;
  mentions: Card[];
  projects: Card[];
  /** Projects is set up in this workspace (a team exists). */
  hasProjects: boolean;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function projectsCtx(v: Viewer): Ctx | null {
  try {
    return ctxFor(v.userId, v.wsId, "read");
  } catch {
    return null;
  }
}

const RANK: Record<string, number> = { started: 0, unstarted: 1, backlog: 2 };

export async function myDay(v: Viewer, now = new Date()): Promise<MyDay> {
  const today = ymd(now);
  const ctx = projectsCtx(v);
  const keys: string[] = [];
  let hasProjects = false;
  if (ctx) {
    hasProjects = ctx.teams().size > 0;
    try {
      const page = queryIssues(ctx, { filter: { assignee: ["me"], category: ["started", "unstarted", "backlog"] }, display: { group: "none", order: "updated", subIssues: true }, limit: 50, today });
      for (const g of page.groups) for (const i of g.items) keys.push(`issue:${i.id}`);
    } catch {
      // Nothing assigned yet.
    }
  }
  const issues = (await cardsFor(v, keys)).sort((a, b) => {
    const da = a.due ?? "9999-99-99";
    const db = b.due ?? "9999-99-99";
    const lateA = da < today ? 0 : da === today ? 1 : 2;
    const lateB = db < today ? 0 : db === today ? 1 : 2;
    if (lateA !== lateB) return lateA - lateB;
    const ra = RANK[a.status?.category ?? "backlog"] ?? 3;
    const rb = RANK[b.status?.category ?? "backlog"] ?? 3;
    if (ra !== rb) return ra - rb;
    // Linear's priority: 1 urgent … 4 low, 0 none last.
    const pa = a.priority || 5;
    const pb = b.priority || 5;
    if (pa !== pb) return pa - pb;
    return da.localeCompare(db);
  });
  const overdue = issues.filter((c) => c.due && c.due < today).length;
  const dueToday = issues.filter((c) => c.due === today).length;
  ecoDb();
  // Where the person is @mentioned in a document or an issue — not every link to them
  // (calendar invites, mail they were mentioned in), which would crowd those out.
  const mentionKeys = [
    ...new Set(
      (
        sql("SELECT src FROM eco_links WHERE ws_id = ? AND dst = ? AND via = 'mention' AND (src LIKE 'note:%' OR src LIKE 'issue:%') ORDER BY created_at DESC LIMIT 40").all(
          v.wsId,
          `user:${v.userId}`
        ) as { src: string }[]
      ).map((l) => l.src)
    ),
  ];
  const mentions = (await cardsFor(v, mentionKeys)).slice(0, 6);
  const projects: Card[] = ctx
    ? await cardsFor(
        v,
        listProjects(ctx)
          .filter((p) => p.state === "started" || p.state === "planned")
          .sort((a, b) => (a.state === b.state ? b.updatedAt - a.updatedAt : a.state === "started" ? -1 : 1))
          .slice(0, 6)
          .map((p) => `project:${p.id}`)
      )
    : [];
  return { today, issues: issues.slice(0, 12), overdue, dueToday, mentions, projects, hasProjects };
}
