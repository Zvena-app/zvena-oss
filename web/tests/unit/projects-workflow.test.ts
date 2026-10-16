// Linear's workflow logic, wherever an issue's state changes: the times kept
// on status changes, the Duplicate status, cycles that end by themselves,
// the cycle graph's "started" line, and the ecosystem's status menu (the
// whole workflow, not a done / not done checkbox).
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { EcoError, issueStatuses, setIssueDone, setIssueStatus, type Actor } from "@/lib/eco/actions";
import { cardsFor } from "@/lib/eco/cards";
import { issueList } from "@/lib/eco/lists";
import { ctxFor, PjError } from "@/lib/projects/core";
import { createIssue, getIssueBrief, updateIssue, updateIssues } from "@/lib/projects/issues";
import { createCycle, createProject, getCycle, getProject, listCycles, rollOverCycles } from "@/lib/projects/planning";
import { addRelation, issueDetail } from "@/lib/projects/social";
import { createStatus, createTeam, deleteStatus, duplicateStatusOf, getTeam, listStatuses, statusOfCategory, updateTeam } from "@/lib/projects/teams";
import { triageIssue } from "@/lib/projects/triage";
import { addDays, dayOf, statusFraction, statusTimes, type StatusCategory } from "@/lib/projects/types";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `pjw-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Wanda");
const viewer = person("Vera");
const outsider = person("Otto");
const ws = createWorkspace(owner, "Workflow").id;
acceptInvite(viewer, createInvite(owner, ws, "viewer")!.token);
acceptInvite(outsider, createInvite(owner, ws, "editor")!.token);
const as = (u = owner) => ctxFor(u, ws, u === viewer ? "read" : "edit");
const actor = (userId = owner): Actor => ({ userId, name: "Someone", wsId: ws, locale: "en" });
const team = createTeam(as(), { name: "Core", key: "CORE" }, "en");
const other = createTeam(as(), { name: "Ops", key: "OPS" }, "en");
const statuses = () => listStatuses(as()).filter((s) => s.teamId === team.id);
const named = (name: string, teamId = team.id) => listStatuses(as()).find((s) => s.teamId === teamId && s.name === name)!;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PjError ? e.status : e instanceof EcoError ? e.status : -1;
  }
  return 0;
};

test("statusTimes: Linear's started / completed / canceled times for every move between categories", () => {
  const now = 1000;
  assert.deepEqual(statusTimes("started", now), { started_at: now, completed_at: null, canceled_at: null }, "a new issue created in progress");
  assert.deepEqual(statusTimes("started", now, "started"), {}, "within a category nothing changes");
  assert.deepEqual(statusTimes("completed", now, "started"), { completed_at: now, canceled_at: null }, "done keeps its start");
  assert.deepEqual(statusTimes("unstarted", now, "started"), { started_at: null, completed_at: null, canceled_at: null }, "back to todo: not started any more");
  assert.deepEqual(statusTimes("backlog", now, "completed"), { started_at: null, completed_at: null, canceled_at: null });
  assert.deepEqual(statusTimes("started", now, "completed"), { startedIfUnset: now, completed_at: null, canceled_at: null }, "reopened into work: its first start stays");
  assert.deepEqual(statusTimes("canceled", now, "unstarted"), { canceled_at: now, completed_at: null });
  for (const c of ["backlog", "unstarted", "started", "completed", "canceled"] as StatusCategory[]) assert.deepEqual(statusTimes(c, now, c), {});
});

test("status changes keep started_at, completed_at and canceled_at as Linear does, on every path", () => {
  const ctx = as();
  const i = createIssue(ctx, { teamId: team.id, title: "Times" });
  assert.equal(i.startedAt, null);
  const started = updateIssue(ctx, i.id, { statusId: named("In progress").id });
  assert.ok(started.startedAt);
  const review = updateIssue(ctx, i.id, { statusId: named("In review").id });
  assert.equal(review.startedAt, started.startedAt, "In review is still the same work");
  const done = updateIssue(ctx, i.id, { statusId: named("Done").id });
  assert.ok(done.completedAt);
  assert.equal(done.startedAt, started.startedAt, "done keeps when work started (cycle time)");
  const reopened = updateIssue(ctx, i.id, { statusId: named("In progress").id });
  assert.equal(reopened.completedAt, null, "reopened: no longer completed");
  assert.equal(reopened.startedAt, started.startedAt, "reopened into work: the first start stays");
  const back = updateIssue(ctx, i.id, { statusId: named("Todo").id });
  assert.equal(back.startedAt, null, "back to todo: not started any more");
  const canceled = updateIssue(ctx, i.id, { statusId: named("Canceled").id });
  assert.ok(canceled.canceledAt);
  assert.equal(canceled.completedAt, null);
  const restarted = updateIssue(ctx, i.id, { statusId: named("In progress").id });
  assert.equal(restarted.canceledAt, null);
  assert.ok(restarted.startedAt, "a canceled issue taken up again starts now");

  // Bulk by category, and a deleted status's issues, get the same times.
  const j = createIssue(ctx, { teamId: team.id, title: "Bulk", statusId: named("In progress").id });
  updateIssues(ctx, [j.id], { statusId: "category:unstarted" });
  assert.equal(getIssueBrief(ctx, j.id).startedAt, null);
  const extra = createStatus(ctx, team.id, { name: "Blocked", category: "started" });
  const k = createIssue(ctx, { teamId: team.id, title: "On a status that goes", statusId: extra.id });
  assert.ok(getIssueBrief(ctx, k.id).startedAt);
  deleteStatus(ctx, extra.id, named("Backlog").id);
  const moved = getIssueBrief(ctx, k.id);
  assert.equal(moved.statusId, named("Backlog").id);
  assert.equal(moved.startedAt, null, "moved to the backlog: not started");
  const extraDone = createStatus(ctx, team.id, { name: "Shipped", category: "completed" });
  const m = createIssue(ctx, { teamId: team.id, title: "Shipped one", statusId: extraDone.id });
  deleteStatus(ctx, extraDone.id, named("In progress").id);
  const m2 = getIssueBrief(ctx, m.id);
  assert.equal(m2.completedAt, null);
  assert.ok(m2.startedAt, "into work from done: started (it had no start)");
});

test("the status icon's fill: a started status's place among the team's started ones (In progress about half, In review fuller)", () => {
  const all = listStatuses(as());
  const p = statusFraction(all, named("In progress").id);
  const r = statusFraction(all, named("In review").id);
  assert.ok(p > 0 && p < r && r < 1, `${p} < ${r}`);
  assert.equal(statusFraction(all, named("Todo").id), 0);
  assert.equal(statusFraction(all, named("Backlog").id), 0);
  assert.equal(statusFraction(all, named("Done").id), 1);
});

test("Duplicate: marking an issue as a duplicate closes it in its team's Duplicate status (not Canceled)", () => {
  const ctx = as();
  const t = getTeam(ctx, team.id);
  assert.equal(t.duplicateStatusId, named("Duplicate").id, "a new team's seeded Duplicate status");
  assert.equal(duplicateStatusOf(team.id), named("Duplicate").id);
  assert.equal(statusOfCategory(team.id, "canceled"), named("Canceled").id, "canceling (decline, bulk) is not marking as duplicate");

  const orig = createIssue(ctx, { teamId: team.id, title: "Login fails on Safari" });
  const dup = createIssue(ctx, { teamId: team.id, title: "Can't log in (Safari)", statusId: named("In progress").id });
  addRelation(ctx, dup.id, { type: "duplicate", relatedId: orig.id });
  const d = getIssueBrief(ctx, dup.id);
  assert.equal(d.statusId, named("Duplicate").id);
  assert.ok(d.canceledAt);
  assert.equal(getIssueBrief(ctx, orig.id).statusId, orig.statusId, "the original stays as it is");
  assert.ok(issueDetail(ctx, dup.id).activity.some((a) => a.kind === "status"), "the change is in the history");

  // "Duplicated by" from the original's side moves the other one.
  const dup2 = createIssue(ctx, { teamId: other.id, title: "Safari login broken" });
  addRelation(ctx, orig.id, { type: "duplicated_by", relatedId: dup2.id });
  assert.equal(getIssueBrief(ctx, dup2.id).statusId, named("Duplicate", other.id).id, "in its own team's Duplicate status");

  // A closed issue keeps its status.
  const shipped = createIssue(ctx, { teamId: team.id, title: "Already done", statusId: named("Done").id });
  addRelation(ctx, shipped.id, { type: "duplicate", relatedId: orig.id });
  assert.equal(getIssueBrief(ctx, shipped.id).statusId, named("Done").id);

  // Bulk "move to canceled" picks Canceled, not Duplicate.
  const c = createIssue(ctx, { teamId: team.id, title: "Drop it" });
  updateIssues(ctx, [c.id], { statusId: "category:canceled" });
  assert.equal(getIssueBrief(ctx, c.id).statusId, named("Canceled").id);
});

test("Duplicate status setting: a canceled status of the team only; without one, the first canceled status", () => {
  const ctx = as();
  assert.equal(code(() => updateTeam(ctx, team.id, { duplicateStatusId: named("Done").id })), 400, "not a canceled status");
  assert.equal(code(() => updateTeam(ctx, team.id, { duplicateStatusId: named("Canceled", other.id).id })), 400, "another team's");
  assert.equal(updateTeam(ctx, other.id, { duplicateStatusId: named("Canceled", other.id).id }).duplicateStatusId, named("Canceled", other.id).id);
  assert.equal(statusOfCategory(other.id, "canceled"), named("Duplicate", other.id).id, "the other canceled status declines now");
  assert.equal(updateTeam(ctx, other.id, { duplicateStatusId: null }).duplicateStatusId, null);
  assert.equal(duplicateStatusOf(other.id), named("Canceled", other.id).id, "none set: the first canceled status");
  // Deleting the duplicate status clears the setting (its issues moved first).
  updateTeam(ctx, other.id, { duplicateStatusId: named("Duplicate", other.id).id });
  deleteStatus(ctx, named("Duplicate", other.id).id, named("Canceled", other.id).id);
  assert.equal(getTeam(ctx, other.id).duplicateStatusId, null);
  assert.equal(duplicateStatusOf(other.id), named("Canceled", other.id).id);
  assert.equal(code(() => updateTeam(as(viewer), team.id, { duplicateStatusId: named("Canceled").id })), 403);
});

test("triage: decline goes to Canceled, duplicate to Duplicate", () => {
  const ctx = as();
  updateTeam(ctx, team.id, { triage: true });
  const a = createIssue(as(outsider), { teamId: team.id, title: "Please add dark mode" });
  const b = createIssue(as(outsider), { teamId: team.id, title: "Safari login" });
  const orig = createIssue(ctx, { teamId: team.id, title: "Login on Safari" });
  assert.equal(triageIssue(ctx, a.id, { action: "decline" }).statusId, named("Canceled").id);
  assert.equal(triageIssue(ctx, b.id, { action: "duplicate", duplicateOf: orig.identifier }).statusId, named("Duplicate").id);
  updateTeam(ctx, team.id, { triage: false });
});

test("cycles end by themselves: unfinished issues roll over to the next cycle, completed and canceled ones stay", () => {
  const ctx = as();
  const t = createTeam(ctx, { name: "Sprint", key: "SPR" }, "en");
  const st = (name: string) => named(name, t.id);
  const c1 = createCycle(ctx, t.id, { startsOn: "2026-01-05", endsOn: "2026-01-18" });
  const c2 = createCycle(ctx, t.id, { startsOn: "2026-01-19", endsOn: "2026-02-01" });
  const open = createIssue(ctx, { teamId: t.id, title: "Unfinished", cycleId: c1.id, statusId: st("In progress").id, estimate: 3 });
  const todo = createIssue(ctx, { teamId: t.id, title: "Not started", cycleId: c1.id });
  const done = createIssue(ctx, { teamId: t.id, title: "Shipped", cycleId: c1.id, statusId: st("Done").id, estimate: 2 });
  const gone = createIssue(ctx, { teamId: t.id, title: "Dropped", cycleId: c1.id, statusId: st("Canceled").id });

  // Before its last day is over nothing happens.
  rollOverCycles(Date.parse("2026-01-18T15:00:00"));
  assert.equal(getCycle(ctx, c1.id).completedAt, null);

  rollOverCycles(Date.parse("2026-01-19T09:00:00"));
  const ended = getCycle(ctx, c1.id);
  assert.ok(ended.completedAt, "completed by itself");
  assert.equal(ended.summary?.carriedOver, 2);
  assert.equal(ended.summary?.carriedTo, c2.id);
  assert.equal(ended.summary?.completed, 1);
  assert.equal(ended.summary?.canceled, 1);
  assert.equal(ended.summary?.pointsDone, 2);
  assert.equal(getIssueBrief(ctx, open.id).cycleId, c2.id, "unfinished work rolls over");
  assert.equal(getIssueBrief(ctx, todo.id).cycleId, c2.id);
  assert.equal(getIssueBrief(ctx, done.id).cycleId, c1.id, "completed work stays with its cycle");
  assert.equal(getIssueBrief(ctx, gone.id).cycleId, c1.id);
  const move = issueDetail(ctx, open.id).activity.find((a) => a.kind === "cycle");
  assert.ok(move && move.actorId === null, "the history names no person");

  // No next cycle: one is made, the one that runs today (days the server was away are skipped).
  rollOverCycles(Date.parse("2026-02-20T09:00:00"));
  assert.ok(getCycle(ctx, c2.id).completedAt);
  const now = listCycles(ctx).filter((c) => c.teamId === t.id && !c.completedAt);
  assert.equal(now.length, 1, "one new cycle");
  assert.ok(now[0].startsOn <= "2026-02-20" && now[0].endsOn >= "2026-02-20", `${now[0].startsOn}…${now[0].endsOn}`);
  assert.equal(addDays(now[0].startsOn, 13), now[0].endsOn, "as long as the team's cycles");
  assert.equal(now[0].number, 3);
  assert.equal(getIssueBrief(ctx, open.id).cycleId, now[0].id);

  // A team with cycles off is left alone.
  const off = createTeam(ctx, { name: "Quiet", key: "QT" }, "en");
  const c3 = createCycle(ctx, off.id, { startsOn: "2026-01-05", endsOn: "2026-01-18" });
  updateTeam(ctx, off.id, { cyclesEnabled: false });
  rollOverCycles(Date.parse("2026-03-01T09:00:00"));
  assert.equal(getCycle(ctx, c3.id).completedAt, null);
});

test("the cycle graph: scope, started (done ones too) and completed per day", () => {
  const ctx = as();
  const t = createTeam(ctx, { name: "Graph", key: "GR" }, "en");
  const today = dayOf(Date.now());
  const c = createCycle(ctx, t.id, { startsOn: addDays(today, -2), endsOn: addDays(today, 5) });
  createIssue(ctx, { teamId: t.id, title: "A", cycleId: c.id });
  createIssue(ctx, { teamId: t.id, title: "B", cycleId: c.id, statusId: named("In progress", t.id).id });
  createIssue(ctx, { teamId: t.id, title: "C", cycleId: c.id, statusId: named("Done", t.id).id });
  const last = getCycle(ctx, c.id).burnup.at(-1)!;
  assert.deepEqual({ scope: last.scope, started: last.started, completed: last.completed }, { scope: 3, started: 2, completed: 1 });
  const p = createProject(ctx, { name: "Graphs", teamIds: [t.id] });
  updateIssue(ctx, createIssue(ctx, { teamId: t.id, title: "D", projectId: p.id }).id, { statusId: named("In review", t.id).id });
  assert.deepEqual([getProject(ctx, p.id).progress.started, getProject(ctx, p.id).progress.completed], [1, 0], "in progress is counted apart from done");
});

test("ecosystem: an issue's status menu offers its team's whole workflow, in board order", async () => {
  const ctx = as();
  const i = createIssue(ctx, { teamId: team.id, title: "From a document" });
  const menu = issueStatuses(actor(), i.id);
  assert.equal(menu.current, i.statusId);
  assert.deepEqual(
    menu.statuses.map((s) => s.name),
    statuses()
      .sort((a, b) => ["backlog", "unstarted", "started", "completed", "canceled"].indexOf(a.category) - ["backlog", "unstarted", "started", "completed", "canceled"].indexOf(b.category) || a.position - b.position)
      .map((s) => s.name)
  );
  assert.ok(["Backlog", "Todo", "In progress", "In review", "Done", "Canceled", "Duplicate"].every((n) => menu.statuses.some((s) => s.name === n)));
  assert.ok(menu.statuses.find((s) => s.name === "In progress")!.fraction > 0);
  assert.ok(issueStatuses(actor(viewer), i.id).statuses.length > 0, "a viewer sees the statuses");

  // Half done: In progress, then In review; the card says so.
  const card = await setIssueStatus(actor(), i.id, named("In progress").id);
  assert.equal(card.status?.category, "started");
  assert.equal(card.status?.id, named("In progress").id);
  assert.ok((card.status?.fraction ?? 0) > 0 && (card.status?.fraction ?? 1) < 1);
  assert.ok(getIssueBrief(ctx, i.id).startedAt);
  const later = await setIssueStatus(actor(), i.id, named("Backlog").id);
  assert.equal(later.status?.category, "backlog", "postponed to the backlog");
  const [again] = await cardsFor(actor(), [`issue:${i.id}`]);
  assert.equal(again.status?.name, "Backlog");

  await assert.rejects(setIssueStatus(actor(), i.id, named("Done", other.id).id), (e: unknown) => e instanceof EcoError && e.status === 400, "another team's status");
  await assert.rejects(setIssueStatus(actor(), i.id, "nope"), (e: unknown) => e instanceof EcoError && e.status === 400);
  await assert.rejects(setIssueStatus(actor(viewer), i.id, named("Done").id), (e: unknown) => e instanceof EcoError && e.status === 403, "a viewer cannot change it");
  await assert.rejects(setIssueStatus(actor(), "nope000000", named("Done").id), (e: unknown) => e instanceof EcoError && e.status === 404);
  assert.throws(() => issueStatuses(actor(), "nope000000"), (e: unknown) => e instanceof EcoError && e.status === 404);
});

test("ecosystem: a canceled issue stays canceled when a checked line says 'not done'; 'show done' lists canceled work too", async () => {
  const ctx = as();
  const p = createProject(ctx, { name: "Docs list", teamIds: [team.id] });
  const c = createIssue(ctx, { teamId: team.id, title: "Won't do", projectId: p.id, statusId: named("Canceled").id });
  createIssue(ctx, { teamId: team.id, title: "Doing", projectId: p.id, statusId: named("In progress").id });
  assert.equal((await setIssueDone(actor(), c.id, false)).status?.category, "canceled");
  assert.deepEqual((await issueList(actor(), { project: p.id })).map((x) => x.title), ["Doing"]);
  assert.deepEqual((await issueList(actor(), { project: p.id, done: true })).map((x) => x.title), ["Doing", "Won't do"]);
});
