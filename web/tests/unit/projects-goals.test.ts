import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { ctxFor } from "@/lib/projects/core";
import { onChange, type PjChange } from "@/lib/projects/events";
import { goalCountFor, type GoalEvent } from "@/lib/projects/goals";
import { createIssue, deleteIssues, getIssueBrief, updateIssue, updateIssues } from "@/lib/projects/issues";
import { createProject, getProject, saveMilestone, updateProject } from "@/lib/projects/planning";
import { createStatus, createTeam, deleteStatus, listStatuses, setTeamMember, updateTeam } from "@/lib/projects/teams";
import { inbox } from "@/lib/projects/workspace";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `pjg-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Ada");
const lead = person("Lin");
const outsider = person("Vic");
const ws = createWorkspace(owner, "Goals").id;
acceptInvite(lead, createInvite(owner, ws, "editor")!.token);
acceptInvite(outsider, createInvite(owner, ws, "editor")!.token);
const as = (u: string) => ctxFor(u, ws, "edit");
const team = createTeam(as(owner), { name: "Core", key: "GOAL" }, "en");
setTeamMember(as(owner), team.id, lead, "member");
const statuses = listStatuses(as(owner)).filter((s) => s.teamId === team.id);
const done = statuses.find((s) => s.category === "completed")!.id;
const todo = statuses.find((s) => s.category === "unstarted")!.id;
const started = statuses.find((s) => s.category === "started")!.id;
const canceled = statuses.find((s) => s.category === "canceled")!.id;

const heard: PjChange[] = [];
onChange((c) => heard.push(c));
const tick = () => new Promise((r) => setImmediate(r));
const goalNotes = (u: string) => inbox(as(u)).items.filter((n) => n.kind === "goal_met");

test("closing the last issue meets the goal: completed, an automatic update, the lead told, the pulse hears it", async () => {
  const p = createProject(as(owner), { name: "Launch v2", teamIds: [team.id], leadId: lead });
  assert.equal(p.state, "planned");
  const a = createIssue(as(owner), { teamId: team.id, title: "Write the post", projectId: p.id });
  const b = createIssue(as(owner), { teamId: team.id, title: "Ship the build", projectId: p.id });
  const c = createIssue(as(owner), { teamId: team.id, title: "Out of scope", projectId: p.id });

  updateIssue(as(owner), c.id, { statusId: canceled });
  let goals: GoalEvent[] = [];
  updateIssue(as(owner), a.id, { statusId: started }, goals);
  assert.equal(getProject(as(owner), p.id).state, "started", "the first started issue starts a planned project");
  assert.deepEqual(goals.map((g) => g.kind), ["started"]);

  goals = [];
  updateIssue(as(owner), a.id, { statusId: done }, goals);
  assert.equal(goals[0]?.kind, "moved");
  assert.equal(getProject(as(owner), p.id).state, "started");
  assert.equal(goalNotes(lead).length, 0);

  goals = [];
  updateIssue(as(owner), b.id, { statusId: done }, goals);
  assert.deepEqual(
    goals.map((g) => [g.kind, g.done, g.total]),
    [["met", 2, 2]],
    "canceled issues leave the scope"
  );
  const met = getProject(as(owner), p.id);
  assert.equal(met.state, "completed");
  assert.ok(met.completedAt);
  assert.equal(met.updates[0]?.auto, "met");
  assert.equal(met.updates[0]?.body, "");
  assert.equal(met.updates[0]?.authorId, owner, "the update is the closer's act");
  const n = goalNotes(lead);
  assert.equal(n.length, 1, "the lead is told");
  assert.equal(n[0].projectId, p.id);
  assert.equal(n[0].data.project, "Launch v2");
  assert.equal(goalNotes(owner).length, 0, "nobody is told of their own act");
  assert.equal(goalNotes(outsider).length, 0, "people outside the project are not told");
  await tick();
  // Announcements arrive after the commit, in order: the last one about this project.
  const ev = heard.filter((h) => h.entity === "project" && h.id === p.id).at(-1);
  assert.deepEqual(ev?.goal, { kind: "met" }, "no counts on the change feed (they reach people who may not see every team)");

  // New work reopens a goal zvena completed…
  goals = [];
  const d = createIssue(as(owner), { teamId: team.id, title: "Fix the launch bug", projectId: p.id });
  const back = getProject(as(owner), p.id);
  assert.equal(back.state, "started");
  assert.equal(back.completedAt, null);
  assert.equal(back.updates[0]?.auto, "reopened");
  // …and closing it meets it again.
  updateIssue(as(owner), d.id, { statusId: done }, goals);
  assert.equal(goals[0]?.kind, "met");
  assert.equal(getProject(as(owner), p.id).state, "completed");
  assert.equal(goalNotes(lead).length, 1, "one unread row per project, refreshed");
});

test("a project completed by hand stays completed when work reopens; a canceled one is never completed", () => {
  const p = createProject(as(owner), { name: "Hand-made", teamIds: [team.id] });
  const a = createIssue(as(owner), { teamId: team.id, title: "Only task", projectId: p.id, statusId: todo });
  updateProject(as(owner), p.id, { state: "completed" });
  updateIssue(as(owner), a.id, { statusId: started });
  assert.equal(getProject(as(owner), p.id).state, "completed");

  const q = createProject(as(owner), { name: "Dropped", teamIds: [team.id], state: "canceled" });
  const b = createIssue(as(owner), { teamId: team.id, title: "Leftover", projectId: q.id });
  updateIssue(as(owner), b.id, { statusId: done });
  assert.equal(getProject(as(owner), q.id).state, "canceled");
});

test("milestones are met on their own; bulk changes and deletes move goals too", async () => {
  const p = createProject(as(owner), { name: "Q4 goals", teamIds: [team.id], leadId: lead });
  const withMs = saveMilestone(as(owner), p.id, { name: "Beta" });
  const ms = withMs.milestones[0].id;
  const a = createIssue(as(owner), { teamId: team.id, title: "Beta 1", projectId: p.id, milestoneId: ms });
  const b = createIssue(as(owner), { teamId: team.id, title: "Beta 2", projectId: p.id, milestoneId: ms });
  const c = createIssue(as(owner), { teamId: team.id, title: "GA", projectId: p.id });

  const goals: GoalEvent[] = [];
  updateIssues(as(owner), [a.id, b.id], { statusId: "category:completed" }, goals);
  const msEv = goals.find((g) => g.kind === "milestone");
  assert.ok(msEv, "the milestone is met");
  assert.equal(msEv.name, "Beta");
  assert.equal(getProject(as(owner), p.id).state, "started");
  const note = goalNotes(lead).find((n) => n.projectId === p.id);
  assert.equal(note?.data.milestone, "Beta");

  // Deleting the last open issue leaves only done work: the goal is met.
  deleteIssues(as(owner), [c.id]);
  assert.equal(getProject(as(owner), p.id).state, "completed");
  await tick();
  assert.equal(heard.filter((h) => h.entity === "project" && h.id === p.id).at(-1)?.goal?.kind, "met");
  assert.equal(goalNotes(lead).find((n) => n.projectId === p.id)?.data.milestone, undefined, "the project's news replaces the milestone's");
});

test("a project is met only with work in it, and archiving the open work counts like closing it", () => {
  const p = createProject(as(owner), { name: "Empty", teamIds: [team.id] });
  const a = createIssue(as(owner), { teamId: team.id, title: "Done one", projectId: p.id, statusId: done });
  assert.equal(getProject(as(owner), p.id).state, "completed", "created already done: met at once");
  updateIssue(as(owner), a.id, { archived: true });
  assert.equal(getProject(as(owner), p.id).state, "completed", "nothing left in scope: it stays as it was");

  const q = createProject(as(owner), { name: "Archive", teamIds: [team.id] });
  createIssue(as(owner), { teamId: team.id, title: "Finished", projectId: q.id, statusId: done });
  updateProject(as(owner), q.id, { state: "started" });
  const open = createIssue(as(owner), { teamId: team.id, title: "Abandoned", projectId: q.id });
  updateIssue(as(owner), open.id, { archived: true });
  assert.equal(getProject(as(owner), q.id).state, "completed");
});

test("turning triage off lets the waiting issues into their goals; deleting a status into another category moves the goals too", async () => {
  const t2 = createTeam(as(owner), { name: "Intake", key: "INTK" }, "en");
  const st2 = listStatuses(as(owner)).filter((s) => s.teamId === t2.id);
  const done2 = st2.find((s) => s.category === "completed")!.id;
  updateTeam(as(owner), t2.id, { triage: true });
  const p = createProject(as(owner), { name: "Intake goal", teamIds: [t2.id] });
  createIssue(as(owner), { teamId: t2.id, title: "Shipped", projectId: p.id, statusId: done2 });
  assert.equal(getProject(as(owner), p.id).state, "completed");
  const asked = createIssue(as(outsider), { teamId: t2.id, title: "A request from outside", projectId: p.id });
  assert.ok(asked.triage, "an outsider's issue waits in triage");
  assert.equal(getProject(as(owner), p.id).state, "completed", "waiting work is not in the goal");
  const heardBefore = heard.length;
  updateTeam(as(owner), t2.id, { triage: false });
  assert.equal(getProject(as(owner), p.id).state, "started", "released work reopens the goal zvena met");
  await tick();
  assert.ok(heard.slice(heardBefore).some((c) => c.goal?.kind === "reopened"), "the pulse hears it");

  const qa = createStatus(as(owner), t2.id, { name: "QA", category: "started" });
  const q = createProject(as(owner), { name: "QA goal", teamIds: [t2.id] });
  const inQa = createIssue(as(owner), { teamId: t2.id, title: "Check it", projectId: q.id, statusId: qa.id });
  assert.notEqual(getProject(as(owner), q.id).state, "completed");
  deleteStatus(as(owner), qa.id, done2);
  assert.equal(getProject(as(owner), q.id).state, "completed", "its last open issue went to Done with the status");
  assert.ok(getIssueBrief(as(owner), inQa.id).completedAt, "and was completed like any status change");
});

test("a goal shared with a private team tells others only about the work they can see", async () => {
  const priv = createTeam(as(owner), { name: "Vault", key: "VLT", private: true }, "en");
  const pdone = listStatuses(as(owner)).find((s) => s.teamId === priv.id && s.category === "completed")!.id;
  const p = createProject(as(owner), { name: "Shared goal", teamIds: [team.id, priv.id], leadId: lead });
  createIssue(as(owner), { teamId: priv.id, title: "Secret one", projectId: p.id, statusId: pdone });
  createIssue(as(owner), { teamId: priv.id, title: "Secret two", projectId: p.id, statusId: pdone });
  const pub = createIssue(as(owner), { teamId: team.id, title: "Public part", projectId: p.id });
  const goals: GoalEvent[] = [];
  const before = heard.length;
  updateIssue(as(outsider), pub.id, { statusId: done }, goals);
  const met = goals.find((g) => g.kind === "met");
  assert.ok(met, "the goal is met: all its work is done");
  assert.deepEqual(goalCountFor(as(outsider), met!), { done: 1, total: 1 }, "someone outside the private team counts only what they see");
  assert.deepEqual(goalCountFor(as(owner), met!), { done: 3, total: 3 }, "the owner sees it all");
  assert.equal(goalNotes(lead).find((n) => n.projectId === p.id)?.data.total, undefined, "no counts in the notification");
  await tick();
  const ev = heard.slice(before).find((h) => h.entity === "project" && h.id === p.id && h.goal);
  assert.deepEqual(ev?.goal, { kind: "met" }, "no counts on the change feed");
});
