import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { ctxFor, PjError } from "@/lib/projects/core";
import { createIssue, getIssueBrief, queryIssues } from "@/lib/projects/issues";
import { createProject, getProject } from "@/lib/projects/planning";
import { issueDetail } from "@/lib/projects/social";
import { createTeam, getTeam, listStatuses, setTeamMember, updateTeam } from "@/lib/projects/teams";
import { triageIssue } from "@/lib/projects/triage";
import { DEFAULT_DISPLAY, type IssueFilter } from "@/lib/projects/types";
import { inbox } from "@/lib/projects/workspace";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `pjt-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const lead = person("Ada");
const mate = person("Lin");
const outsider = person("Sam");
const viewer = person("Vic");
const stranger = person("Stan");
const ws = createWorkspace(lead, "Triage").id;
acceptInvite(mate, createInvite(lead, ws, "editor")!.token);
acceptInvite(outsider, createInvite(lead, ws, "editor")!.token);
acceptInvite(viewer, createInvite(lead, ws, "viewer")!.token);
const as = (u: string, need: "read" | "edit" = "edit") => ctxFor(u, ws, need);
const team = createTeam(as(lead), { name: "Support", key: "SUP" }, "en");
setTeamMember(as(lead), team.id, mate, "member");
const other = createTeam(as(lead), { name: "Web", key: "WEB" }, "en");
const st = listStatuses(as(lead));
const of = (teamId: string, cat: string) => st.find((s) => s.teamId === teamId && s.category === cat)!;

const list = (u: string, f: IssueFilter = {}) =>
  queryIssues(as(u), { filter: { team: [team.id], ...f }, display: { ...DEFAULT_DISPLAY, group: "none", completed: "all" } }).groups.flatMap((g) => g.items.map((i) => i.title));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PjError ? e.status : -1;
  }
  return 0;
};

test("with triage off nothing waits; with it on, issues from outside the team wait and the leads hear of them", () => {
  const before = createIssue(as(outsider), { teamId: team.id, title: "Before triage" });
  assert.equal(before.triage, false);
  assert.equal(updateTeam(as(lead), team.id, { triage: true }).triage, true);

  const own = createIssue(as(mate), { teamId: team.id, title: "From a member" });
  assert.equal(own.triage, false, "a member's issue goes straight in");
  const sent = createIssue(as(mate), { teamId: team.id, title: "Sent on purpose", triage: true });
  assert.equal(sent.triage, true);
  const ext = createIssue(as(outsider), { teamId: team.id, title: "Export is broken" });
  assert.equal(ext.triage, true, "an outsider's issue waits");
  assert.ok(inbox(as(lead)).items.some((n) => n.kind === "triage" && n.issue?.id === ext.id), "the lead is told");

  assert.ok(!list(lead).includes("Export is broken"), "lists leave triage out");
  assert.ok(list(lead).includes("From a member"));
  assert.deepEqual(list(lead, { triage: true }).sort(), ["Export is broken", "Sent on purpose"]);
  assert.equal(getTeam(as(lead), team.id).triageCount, 2);
  assert.ok(issueDetail(as(lead), ext.id).activity.some((a) => a.kind === "triage"));
});

test("accept: into the first status or a chosen one of the team; the creator hears; the issue joins its goal", () => {
  const p = createProject(as(lead), { name: "Billing", teamIds: [team.id] });
  const a = createIssue(as(outsider), { teamId: team.id, title: "Invoice PDF is blank", projectId: p.id });
  assert.equal(a.triage, true);
  assert.equal(getProject(as(lead), p.id).progress.total, 0, "work still in triage is outside the goal");

  assert.equal(code(() => triageIssue(as(lead), a.id, { action: "accept", statusId: of(other.id, "unstarted").id })), 400, "a status of another team is refused");
  assert.equal(code(() => triageIssue(as(lead), a.id, { action: "accept", statusId: of(team.id, "canceled").id })), 400, "accepting into canceled is refused");
  assert.equal(code(() => triageIssue(as(viewer, "read"), a.id, { action: "accept" })), 403, "a viewer may not triage");
  assert.equal(code(() => triageIssue(as(lead), a.id, { action: "maybe" })), 400);

  const started = of(team.id, "started");
  const done = triageIssue(as(mate), a.identifier, { action: "accept", statusId: started.id });
  assert.equal(done.triage, false);
  assert.equal(done.statusId, started.id);
  assert.ok(inbox(as(outsider)).items.some((n) => n.kind === "triaged" && n.issue?.id === a.id && n.data.result === "accepted"));
  assert.ok(list(lead).includes("Invoice PDF is blank"));
  assert.equal(getProject(as(lead), p.id).progress.total, 1);
  assert.equal(code(() => triageIssue(as(lead), a.id, { action: "accept" })), 409, "only once");

  const b = createIssue(as(outsider), { teamId: team.id, title: "Plain accept" });
  assert.equal(triageIssue(as(lead), b.id, { action: "accept" }).statusId, of(team.id, "unstarted").id, "the team's first status");
});

test("decline with a reason, duplicate of another issue, snooze until later", () => {
  const d = createIssue(as(outsider), { teamId: team.id, title: "Make it purple" });
  const declined = triageIssue(as(lead), d.id, { action: "decline", comment: "Not on our roadmap." });
  assert.equal(st.find((s) => s.id === declined.statusId)?.category, "canceled");
  const det = issueDetail(as(lead), d.id);
  assert.ok(det.comments_.some((c) => c.body === "Not on our roadmap."));
  assert.ok(inbox(as(outsider)).items.some((n) => n.kind === "triaged" && n.data.result === "declined"));

  const orig = createIssue(as(mate), { teamId: team.id, title: "Export fails for big files" });
  const dup = createIssue(as(outsider), { teamId: team.id, title: "Export fails" });
  assert.equal(code(() => triageIssue(as(lead), dup.id, { action: "duplicate", duplicateOf: dup.id })), 400);
  const marked = triageIssue(as(lead), dup.id, { action: "duplicate", duplicateOf: orig.identifier });
  assert.equal(st.find((s) => s.id === marked.statusId)?.category, "canceled");
  assert.ok(issueDetail(as(lead), dup.id).relations.some((r) => r.type === "duplicate" && r.issue.id === orig.id));

  const later = createIssue(as(outsider), { teamId: team.id, title: "Look at this next week" });
  assert.equal(code(() => triageIssue(as(lead), later.id, { action: "snooze", until: Date.now() - 1000 })), 400, "not in the past");
  assert.equal(code(() => triageIssue(as(lead), later.id, { action: "snooze", until: Date.now() + 200 * 86_400_000 })), 400, "not too far");
  const until = Date.now() + 3_600_000;
  const snoozed = triageIssue(as(lead), later.id, { action: "snooze", until });
  assert.equal(snoozed.triage, true);
  assert.equal(snoozed.triageSnoozedUntil, until);
  assert.ok(!list(lead, { triage: true }).includes("Look at this next week"), "out of sight while snoozed");
  assert.ok(list(lead, { triage: true, snoozed: true }).includes("Look at this next week"));
});

test("nobody outside the workspace or the team's privacy can triage; turning triage off lets everything in", () => {
  const x = createIssue(as(outsider), { teamId: team.id, title: "Waiting one" });
  // The people triage holds back cannot let their own issue in.
  assert.equal(code(() => triageIssue(as(outsider), x.id, { action: "accept" })), 403, "an editor outside the team may not triage");
  assert.equal(code(() => triageIssue(as(outsider), x.id, { action: "snooze", until: Date.now() + 86_400_000 })), 403);
  const sent = createIssue(as(outsider), { teamId: team.id, title: "Sent on purpose", triage: true });
  assert.equal(code(() => triageIssue(as(outsider), sent.id, { action: "decline" })), 403);
  assert.equal(code(() => triageIssue(as(mate), sent.id, { action: "accept" })), 0, "a team member decides");
  assert.throws(() => triageIssue(ctxFor(stranger, ws, "edit"), x.id, { action: "accept" }), (e: unknown) => e instanceof PjError && e.status === 403);
  const otherWs = createWorkspace(stranger, "Elsewhere").id;
  assert.throws(() => triageIssue(ctxFor(stranger, otherWs, "edit"), x.id, { action: "accept" }), (e: unknown) => e instanceof PjError && e.status === 404, "another workspace's id is not found");

  const secret = createTeam(as(lead), { name: "Secret", key: "SEC", private: true }, "en");
  updateTeam(as(lead), secret.id, { triage: true });
  const s = createIssue(as(lead), { teamId: secret.id, title: "Private intake", triage: true });
  assert.equal(code(() => triageIssue(as(outsider), s.id, { action: "accept" })), 404, "a private team's issue is not found for others");

  updateTeam(as(lead), team.id, { triage: false });
  assert.equal(getIssueBrief(as(lead), x.id).triage, false);
  assert.ok(list(lead).includes("Waiting one"));
  assert.equal(getTeam(as(lead), team.id).triageCount, 0);
});
