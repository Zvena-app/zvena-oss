// The first run of Projects: no setup form. The workspace gets "My team"
// (keyed after the workspace) and three example issues that teach the basics
// by doing, so the first screen is a working board, not a questionnaire.

import { needs, type Ctx } from "./core";
import { createIssue, updateIssue } from "./issues";
import { ensureTeam, statusOfCategory } from "./teams";
import { seedFor } from "./seed";
import type { Team } from "./types";

// Order, status and priority of the examples; their words are in seed.ts.
const EXAMPLES: { category: "unstarted" | "started" | "backlog"; priority: 0 | 1 | 2 | 3 | 4 }[] = [
  { category: "unstarted", priority: 2 },
  { category: "unstarted", priority: 3 },
  { category: "started", priority: 0 },
];

/** Sets the workspace up on its first visit (editors); returns the team to open. */
export function startProjects(ctx: Ctx, locale: string): { team: Team; created: boolean } {
  needs(ctx, "edit");
  const existing = [...ctx.teams()].length;
  const team = ensureTeam(ctx, locale);
  if (existing > 0) return { team, created: false };
  // In reading order: KEY-1 is the first example and sits on top of its column.
  let above: string | null = null;
  const words = seedFor(locale).examples;
  for (const [i, shape] of EXAMPLES.entries()) {
    const ex = { ...shape, ...words[i] };
    // The examples teach the basics; Jev's autopilot leaves them alone.
    const it = createIssue({ ...ctx, quiet: true }, { teamId: team.id, title: ex.title, description: ex.description, priority: ex.priority, statusId: statusOfCategory(team.id, ex.category) ?? undefined, assigneeId: ctx.userId });
    if (above && ex.category === "unstarted") updateIssue(ctx, it.id, { position: { before: above, after: null } });
    above = ex.category === "unstarted" ? it.id : above;
  }
  return { team, created: true };
}
