// Side effects of issue changes, decided in one place from the state before
// and after a change (never from the browser): the activity history, the
// subscribers, and notifications.
//
// Notification rules:
//   - nobody is notified about their own action;
//   - an assignee is notified when assigned (and when unassigned by someone else);
//   - people mentioned for the first time in a description or comment get "mentioned";
//   - subscribers get comments and status changes; a mention wins over "comment";
//   - an unread notification of the same kind about the same issue is
//     refreshed instead of duplicated (one inbox row per issue and kind);
//   - recipients must still be members of the workspace and see the issue's team.

import { newId, sql } from "../store";
import { isMember, type Ctx } from "./core";
import { newMentions, mentionsIn } from "./markdown";
import type { NotificationKind } from "./types";

export interface IssueState {
  id: string;
  team_id: string;
  title: string;
  description: string;
  status_id: string;
  priority: number;
  estimate: number | null;
  assignee_id: string | null;
  project_id: string | null;
  milestone_id: string | null;
  cycle_id: string | null;
  parent_id: string | null;
  due_date: string | null;
  archived_at: number | null;
  labels: string[];
}

export function record(ctx: Ctx, issueId: string, kind: string, from: unknown, to: unknown, at = Date.now()): void {
  sql("INSERT INTO pj_activity (ws_id, issue_id, actor_id, kind, from_value, to_value, created_at, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    ctx.wsId,
    issueId,
    // No person: zvena's own upkeep (a cycle that ended rolls its issues over).
    ctx.userId || null,
    kind,
    from === undefined ? null : JSON.stringify(from),
    to === undefined ? null : JSON.stringify(to),
    at,
    ctx.via ?? null
  );
}

export function subscribe(issueId: string, userId: string, explicit = false): void {
  if (explicit) sql("INSERT INTO pj_issue_subscribers (issue_id, user_id, muted) VALUES (?, ?, 0) ON CONFLICT(issue_id, user_id) DO UPDATE SET muted = 0").run(issueId, userId);
  else sql("INSERT OR IGNORE INTO pj_issue_subscribers (issue_id, user_id, muted) VALUES (?, ?, 0)").run(issueId, userId);
}

function canSee(wsId: string, userId: string, teamId: string): boolean {
  if (!isMember(wsId, userId)) return false;
  const t = sql("SELECT private FROM pj_teams WHERE id = ?").get(teamId) as { private: number } | undefined;
  if (!t) return false;
  if (!t.private) return true;
  const owner = sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ? AND role = 'owner'").get(wsId, userId);
  return Boolean(owner || sql("SELECT 1 FROM pj_team_members WHERE team_id = ? AND user_id = ?").get(teamId, userId));
}

export function notify(
  ctx: Ctx,
  userId: string,
  kind: NotificationKind,
  target: { issueId?: string; teamId?: string; projectId?: string; commentId?: string },
  data: Record<string, unknown> = {},
  opts: { selfOk?: boolean } = {}
): boolean {
  if (userId === ctx.userId && !opts.selfOk) return false;
  if (target.teamId && !canSee(ctx.wsId, userId, target.teamId)) return false;
  if (!target.teamId && !isMember(ctx.wsId, userId)) return false;
  // A project of private teams: only people who see one of its teams hear about it.
  if (target.projectId && !target.teamId) {
    const teams = (sql("SELECT team_id FROM pj_project_teams WHERE project_id = ?").all(target.projectId) as { team_id: string }[]).map((x) => x.team_id);
    if (teams.length && !teams.some((t) => canSee(ctx.wsId, userId, t))) return false;
  }
  const now = Date.now();
  const actor = opts.selfOk ? null : ctx.userId;
  // One unread row per (person, kind, issue/project): refreshed, not repeated.
  const existing = sql(
    "SELECT id FROM pj_notifications WHERE user_id = ? AND ws_id = ? AND kind = ? AND IFNULL(issue_id, '') = ? AND IFNULL(project_id, '') = ? AND read_at IS NULL AND archived_at IS NULL"
  ).get(userId, ctx.wsId, kind, target.issueId ?? "", target.projectId ?? "") as { id: string } | undefined;
  if (existing) {
    sql("UPDATE pj_notifications SET actor_id = ?, comment_id = ?, data = ?, updated_at = ?, snoozed_until = NULL WHERE id = ?").run(actor, target.commentId ?? null, JSON.stringify(data), now, existing.id);
    return true;
  }
  sql(
    "INSERT INTO pj_notifications (id, ws_id, user_id, actor_id, kind, issue_id, project_id, comment_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(newId(12), ctx.wsId, userId, actor, kind, target.issueId ?? null, target.projectId ?? null, target.commentId ?? null, JSON.stringify(data), now, now);
  return true;
}

function subscribers(issueId: string): string[] {
  return (sql("SELECT user_id FROM pj_issue_subscribers WHERE issue_id = ? AND muted = 0").all(issueId) as { user_id: string }[]).map((r) => r.user_id);
}

/** History, subscriptions and notifications for a new issue. */
export function issueCreated(ctx: Ctx, issue: IssueState, at: number): void {
  record(ctx, issue.id, "created", null, null, at);
  subscribe(issue.id, ctx.userId);
  if (issue.assignee_id) {
    subscribe(issue.id, issue.assignee_id);
    notify(ctx, issue.assignee_id, "assigned", { issueId: issue.id, teamId: issue.team_id });
  }
  for (const m of mentionsIn(issue.description)) {
    if (!isMember(ctx.wsId, m.id)) continue;
    subscribe(issue.id, m.id);
    notify(ctx, m.id, "mentioned", { issueId: issue.id, teamId: issue.team_id }, { in: "description" });
  }
}

/** A new issue waits in its team's triage: the team's leads hear of it. */
export function triageArrived(ctx: Ctx, teamId: string, issueId: string): void {
  record(ctx, issueId, "triage", null, null);
  for (const r of sql("SELECT user_id FROM pj_team_members WHERE team_id = ? AND role = 'lead'").all(teamId) as { user_id: string }[])
    notify(ctx, r.user_id, "triage", { issueId, teamId });
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** History and notifications for a changed issue (`before` → `after`). */
export function issueChanged(ctx: Ctx, before: IssueState, after: IssueState, at: number, extra: { statusName?: (id: string) => { name: string; category: string } } = {}): void {
  const id = after.id;
  const simple: [keyof IssueState, string][] = [
    ["title", "title"],
    ["priority", "priority"],
    ["estimate", "estimate"],
    ["assignee_id", "assignee"],
    ["project_id", "project"],
    ["milestone_id", "milestone"],
    ["cycle_id", "cycle"],
    ["due_date", "due"],
    ["team_id", "team"],
  ];
  for (const [k, kind] of simple) if (before[k] !== after[k]) record(ctx, id, kind, before[k], after[k], at);
  if (before.status_id !== after.status_id) record(ctx, id, "status", before.status_id, after.status_id, at);
  if (before.parent_id !== after.parent_id) record(ctx, id, "parent", before.parent_id, after.parent_id, at);
  if (before.description !== after.description) record(ctx, id, "description", null, null, at);
  if (!sameSet(before.labels, after.labels)) {
    const added = after.labels.filter((l) => !before.labels.includes(l));
    const removed = before.labels.filter((l) => !after.labels.includes(l));
    record(ctx, id, "labels", removed, added, at);
  }
  if (before.archived_at !== after.archived_at) record(ctx, id, after.archived_at ? "archived" : "unarchived", null, null, at);

  // Changing an issue subscribes its editor (Linear does the same).
  subscribe(id, ctx.userId);
  const team = after.team_id;
  if (before.assignee_id !== after.assignee_id) {
    if (after.assignee_id) {
      subscribe(id, after.assignee_id);
      notify(ctx, after.assignee_id, "assigned", { issueId: id, teamId: team });
    }
    if (before.assignee_id) notify(ctx, before.assignee_id, "unassigned", { issueId: id, teamId: team });
  }
  if (before.status_id !== after.status_id) {
    const s = extra.statusName?.(after.status_id);
    for (const u of subscribers(id)) notify(ctx, u, "status", { issueId: id, teamId: team }, s ? { status: s.name, category: s.category } : {});
    // People waiting on this issue learn that it no longer blocks them.
    if (s && (s.category === "completed" || s.category === "canceled")) {
      const waiting = sql(
        "SELECT i.id, i.assignee_id, i.team_id FROM pj_issue_relations r JOIN pj_issues i ON i.id = r.related_id WHERE r.issue_id = ? AND r.type = 'blocks' AND i.assignee_id IS NOT NULL"
      ).all(id) as { id: string; assignee_id: string; team_id: string }[];
      for (const w of waiting) notify(ctx, w.assignee_id, "unblocked", { issueId: w.id, teamId: w.team_id });
    }
  }
  if (before.priority !== after.priority && after.priority === 1 && after.assignee_id) notify(ctx, after.assignee_id, "priority", { issueId: id, teamId: team }, { priority: 1 });
  if (before.description !== after.description) {
    for (const m of newMentions(before.description, after.description)) {
      if (!isMember(ctx.wsId, m.id)) continue;
      subscribe(id, m.id);
      notify(ctx, m.id, "mentioned", { issueId: id, teamId: team }, { in: "description" });
    }
  }
}

/** A new comment: subscribers learn of it; the newly mentioned get "mentioned" instead. */
export function commentAdded(ctx: Ctx, issue: { id: string; team_id: string }, comment: { id: string; body: string; parentAuthor: string | null }, at: number): void {
  record(ctx, issue.id, "comment", null, { comment: comment.id }, at);
  subscribe(issue.id, ctx.userId);
  const mentioned = new Set<string>();
  for (const m of mentionsIn(comment.body)) {
    if (!isMember(ctx.wsId, m.id)) continue;
    subscribe(issue.id, m.id);
    if (notify(ctx, m.id, "mentioned", { issueId: issue.id, teamId: issue.team_id, commentId: comment.id }, { in: "comment" })) mentioned.add(m.id);
  }
  if (comment.parentAuthor && !mentioned.has(comment.parentAuthor)) {
    if (notify(ctx, comment.parentAuthor, "reply", { issueId: issue.id, teamId: issue.team_id, commentId: comment.id })) mentioned.add(comment.parentAuthor);
  }
  for (const u of subscribers(issue.id)) if (!mentioned.has(u)) notify(ctx, u, "comment", { issueId: issue.id, teamId: issue.team_id, commentId: comment.id });
}

/** An edited comment notifies only people mentioned for the first time. */
export function commentEdited(ctx: Ctx, issue: { id: string; team_id: string }, commentId: string, before: string, after: string): void {
  for (const m of newMentions(before, after)) {
    if (!isMember(ctx.wsId, m.id)) continue;
    subscribe(issue.id, m.id);
    notify(ctx, m.id, "mentioned", { issueId: issue.id, teamId: issue.team_id, commentId }, { in: "comment" });
  }
}
