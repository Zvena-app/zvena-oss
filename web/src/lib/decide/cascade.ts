// Work that follows other work. Server-only.
//
// A parent issue is done when its sub-issues are: when the last open
// sub-issue closes (completed or canceled, at least one completed), Jev moves
// the parent to its team's completed status; when one of them opens again and
// the parent is still where Jev put it, the parent goes back to where it was.
// Higher parents follow the same way (each step is a change of its own).
//
// Exact rules, no AI: it runs whatever the Jev switch says, with the rights
// of the person whose change set it off, and every step lands in the journal
// with Undo (lib/decide/journal.ts). The workspace's owner can turn it off
// (hub settings, lib/decide/hub.ts).

import { ctxFor, type Ctx } from "../projects/core";
import { onChange, type PjChange } from "../projects/events";
import { getIssueBrief, updateIssue } from "../projects/issues";
import { statusOfCategory } from "../projects/teams";
import { sql } from "../store";
import { lastApplied, recordHub } from "./journal";

const KEY = Symbol.for("zvena.decide.cascade");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;

interface Counts {
  total: number;
  closed: number;
  completed: number;
}

/** A parent's sub-issues as they stand (all of them: the rule is about the work, not one person's view). */
function counts(parentId: string): Counts {
  const r = sql(
    `SELECT COUNT(*) AS total,
       IFNULL(SUM(CASE WHEN s.category IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0) AS closed,
       IFNULL(SUM(CASE WHEN s.category = 'completed' THEN 1 ELSE 0 END), 0) AS completed
     FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id
     WHERE i.parent_id = ? AND i.archived_at IS NULL AND i.triage_at IS NULL`
  ).get(parentId) as { total: number; closed: number; completed: number };
  return { total: Number(r.total), closed: Number(r.closed), completed: Number(r.completed) };
}

function categoryOf(statusId: string): string | null {
  return (sql("SELECT category FROM pj_statuses WHERE id = ?").get(statusId) as { category: string } | undefined)?.category ?? null;
}

/** Whether the workspace lets parents follow their sub-issues (set in hub.ts). */
type Enabled = (ws: string) => boolean;

/** One change of an issue: its parent (if any) follows. Returns what happened (for tests). */
export function followParent(c: Pick<PjChange, "ws" | "id" | "by">, enabled: Enabled = () => true): "done" | "reopened" | null {
  if (!enabled(c.ws)) return null;
  const row = sql("SELECT parent_id FROM pj_issues WHERE id = ? AND ws_id = ?").get(c.id, c.ws) as { parent_id: string | null } | undefined;
  const parentId = row?.parent_id;
  if (!parentId) return null;
  let ctx: Ctx;
  try {
    ctx = { ...ctxFor(c.by, c.ws, "edit"), via: "jev" };
  } catch {
    return null;
  }
  let parent;
  try {
    parent = getIssueBrief(ctx, parentId);
  } catch {
    // A parent the person cannot see is not theirs to move.
    return null;
  }
  const cat = categoryOf(parent.statusId);
  const n = counts(parentId);
  if (n.total > 0 && n.closed === n.total && n.completed > 0 && cat !== "completed" && cat !== "canceled") {
    const done = statusOfCategory(parent.teamId, "completed");
    if (!done || done === parent.statusId) return null;
    try {
      updateIssue(ctx, parentId, { statusId: done });
    } catch {
      return null;
    }
    recordHub(c.ws, { subject: `issue:${parentId}`, source: "rule", mode: "auto", status: "applied", payload: { kind: "parent", issue: parentId, prev: parent.statusId, status: done }, by: c.by });
    return "done";
  }
  if (cat === "completed" && n.closed < n.total) {
    // Only a parent Jev closed, and only while it is still where Jev put it.
    const last = lastApplied(c.ws, parentId, "parent");
    if (!last || last.payload.kind !== "parent" || last.payload.reopen || last.payload.status !== parent.statusId) return null;
    const back = last.payload.prev;
    try {
      updateIssue(ctx, parentId, { statusId: back });
    } catch {
      return null;
    }
    recordHub(c.ws, { subject: `issue:${parentId}`, source: "rule", mode: "auto", status: "applied", payload: { kind: "parent", issue: parentId, prev: parent.statusId, status: back, reopen: true }, by: c.by });
    return "reopened";
  }
  return null;
}

/** Starts following Projects' changes (once per process; hub.ts). */
export function startCascade(enabled: Enabled): void {
  if (g[KEY]) return;
  g[KEY] = true;
  onChange((c) => {
    if (c.entity !== "issue" || c.quiet || c.deleted || !c.by) return;
    try {
      followParent(c, enabled);
    } catch {
      // One failed step never stops the change that set it off.
    }
  });
}
