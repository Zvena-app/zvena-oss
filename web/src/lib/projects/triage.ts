// Triage: a team's intake (Linear's Triage). With it on (team setting), issues
// created by people outside the team, or sent there on purpose, wait in
// triage — left out of every list, board, cycle and goal — until someone in
// the team (or the workspace owner) decides; an editor outside the team, the
// very people triage holds back, cannot let their own issue in:
//
//   accept     into the workflow (a status of the team, default: its first);
//   duplicate  of another issue: the relation, which moves it to the team's Duplicate status;
//   decline    the canceled status, with an optional comment saying why;
//   snooze     out of sight until a moment (at most 90 days ahead), then back.
//
// The issue's creator hears what became of it ("triaged"); the team's leads
// heard of its arrival ("triage", lib/projects/effects.ts).

import { sql, tx } from "../store";
import { bad, bump, emit, forbidden, needs, PjError, type Ctx } from "./core";
import { notify, record } from "./effects";
import { announceGoals, goalSnapshot, settleGoals, type GoalEvent } from "./goals";
import { getIssueBrief, issueState, resolveIssueId, updateIssue } from "./issues";
import { addComment, addRelation } from "./social";
import { defaultStatus, statusOfCategory, statusRow } from "./teams";
import type { Issue } from "./types";

export type TriageAction = "accept" | "duplicate" | "decline" | "snooze";
const ACTIONS: readonly TriageAction[] = ["accept", "duplicate", "decline", "snooze"];
const MAX_SNOOZE_MS = 90 * 86_400_000;

export interface TriageInput {
  action?: unknown;
  /** accept: the status to accept into (the team's). */
  statusId?: unknown;
  /** duplicate: the original (id or KEY-12). */
  duplicateOf?: unknown;
  /** decline: why (a comment on the issue). */
  comment?: unknown;
  /** snooze: until when (ms since epoch). */
  until?: unknown;
}

/** Takes the issue out of triage (inside a transaction), with its history and the creator's notice. */
function leave(ctx: Ctx, id: string, result: "accepted" | "duplicate" | "declined"): GoalEvent[] {
  const st = issueState(ctx, id);
  const snap = goalSnapshot([st.project_id], [st.milestone_id]);
  const now = Date.now();
  sql("UPDATE pj_issues SET triage_at = NULL, triage_snoozed_until = NULL, updated_at = ? WHERE id = ? AND ws_id = ?").run(now, id, ctx.wsId);
  record(ctx, id, "triaged", null, result, now);
  const creator = (sql("SELECT creator_id FROM pj_issues WHERE id = ?").get(id) as { creator_id: string | null }).creator_id;
  if (creator) notify(ctx, creator, "triaged", { issueId: id, teamId: st.team_id }, { result });
  bump(ctx.wsId);
  // Accepted work joins its goal's scope.
  return settleGoals(ctx, snap, now);
}

export function triageIssue(ctx: Ctx, ref: string, input: TriageInput): Issue {
  needs(ctx, "edit");
  const action = input.action as TriageAction;
  if (!ACTIONS.includes(action)) throw bad("bad action");
  const id = resolveIssueId(ctx, ref);
  const cur = sql("SELECT team_id, triage_at FROM pj_issues WHERE id = ? AND ws_id = ?").get(id, ctx.wsId) as { team_id: string; triage_at: number | null } | undefined;
  if (!cur || !ctx.teams().has(cur.team_id)) throw new PjError(404, "issue not found");
  if (ctx.role !== "owner" && !sql("SELECT 1 FROM pj_team_members WHERE team_id = ? AND user_id = ?").get(cur.team_id, ctx.userId)) throw forbidden();
  if (cur.triage_at === null) throw new PjError(409, "not in triage");
  let goals: GoalEvent[] = [];

  switch (action) {
    case "snooze": {
      const until = Number(input.until);
      if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + MAX_SNOOZE_MS) throw bad("bad snooze time");
      tx(() => {
        sql("UPDATE pj_issues SET triage_snoozed_until = ?, updated_at = ? WHERE id = ?").run(Math.floor(until), Date.now(), id);
        record(ctx, id, "triage_snoozed", null, Math.floor(until));
        bump(ctx.wsId);
      });
      break;
    }
    case "accept": {
      let statusId: string | null = null;
      if (input.statusId !== undefined && input.statusId !== null) {
        const s = statusRow(ctx, String(input.statusId));
        if (s.team_id !== cur.team_id || s.category === "canceled") throw bad("bad status");
        statusId = s.id;
      }
      tx(() => {
        goals = leave(ctx, id, "accepted");
        if (statusId === null) statusId = defaultStatus(cur.team_id);
        if (statusId !== issueState(ctx, id).status_id) updateIssue(ctx, id, { statusId });
      });
      break;
    }
    case "duplicate": {
      if (typeof input.duplicateOf !== "string") throw bad("bad issue");
      const of = resolveIssueId(ctx, input.duplicateOf);
      if (of === id) throw bad("an issue cannot duplicate itself");
      tx(() => {
        goals = leave(ctx, id, "duplicate");
        // The relation moves it to the team's Duplicate status (lib/projects/social.ts).
        addRelation(ctx, id, { type: "duplicate", relatedId: of });
      });
      break;
    }
    case "decline": {
      const why = typeof input.comment === "string" ? input.comment.trim().slice(0, 5000) : "";
      const canceled = statusOfCategory(cur.team_id, "canceled");
      tx(() => {
        goals = leave(ctx, id, "declined");
        if (canceled) updateIssue(ctx, id, { statusId: canceled });
        if (why) addComment(ctx, id, { body: why });
      });
      break;
    }
  }
  emit(ctx, "issue", id);
  // What leaving triage did to goals (a status change after it announces its own).
  announceGoals(ctx, goals);
  return getIssueBrief(ctx, id);
}
