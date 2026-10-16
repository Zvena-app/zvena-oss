import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { ctxFor, PjError } from "@/lib/projects/core";
import { insights } from "@/lib/projects/insights";
import { createIssue, updateIssue } from "@/lib/projects/issues";
import { createProject } from "@/lib/projects/planning";
import { createTeam, listStatuses, updateTeam } from "@/lib/projects/teams";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `pji-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Ada");
const mate = person("Lin");
const ws = createWorkspace(owner, "Insights").id;
acceptInvite(mate, createInvite(owner, ws, "editor")!.token);
const as = (u: string) => ctxFor(u, ws, "edit");
const team = createTeam(as(owner), { name: "Core", key: "INS" }, "en");
const secret = createTeam(as(owner), { name: "Secret", key: "HID", private: true }, "en");
const st = listStatuses(as(owner));
const of = (teamId: string, cat: string) => st.find((s) => s.teamId === teamId && s.category === cat)!.id;
const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const now = Date.parse(`${today}T12:00:00Z`);
// Moves an issue's times back (the history of a real team).
const backdate = (id: string, t: { created?: number; started?: number; completed?: number }) =>
  sql("UPDATE pj_issues SET created_at = IFNULL(?, created_at), started_at = IFNULL(?, started_at), completed_at = IFNULL(?, completed_at) WHERE id = ?").run(
    t.created ?? null,
    t.started ?? null,
    t.completed ?? null,
    id
  );

test("flow, cycle and lead time per week; open by status, assignee, priority and label; team and project scope", () => {
  const p = createProject(as(owner), { name: "Launch", teamIds: [team.id] });
  // Three done: cycle 2, 4 and 6 days, completed in the newest week and two weeks ago.
  const done = [2, 4, 6].map((d, k) => {
    const it = createIssue(as(owner), { teamId: team.id, title: `Done ${d}`, projectId: k === 0 ? p.id : undefined });
    updateIssue(as(owner), it.id, { statusId: of(team.id, "started") });
    updateIssue(as(owner), it.id, { statusId: of(team.id, "completed") });
    const completed = k === 2 ? now - 14 * DAY : now - DAY;
    backdate(it.id, { created: completed - (d + 1) * DAY, started: completed - d * DAY, completed });
    return it;
  });
  createIssue(as(owner), { teamId: team.id, title: "Open urgent", priority: 1, assigneeId: mate });
  createIssue(as(owner), { teamId: team.id, title: "Open none" });
  // Not counted: another team nobody here sees… (the owner sees private teams; the mate does not)
  createIssue(as(owner), { teamId: secret.id, title: "Hidden work" });
  // …and an issue still in triage.
  updateTeam(as(owner), team.id, { triage: true });
  createIssue(as(owner), { teamId: team.id, title: "Waiting", triage: true });

  const r = insights(as(mate), { teamId: null, weeks: 12, today });
  assert.equal(r.periods.length, 12);
  assert.equal(r.periods[11], today, "the newest week ends today");
  assert.equal(r.open, 2, "open now: the two open issues of visible teams, not triage");
  assert.equal(r.completedInRange, 3);
  assert.equal(r.completed[11], 2);
  assert.equal(r.completed[9], 1, "two weeks ago");
  assert.equal(r.cycleDays[11], 3, "median of 2 and 4 days");
  assert.equal(r.medianCycleDays, 4);
  assert.equal(r.medianLeadDays, 5, "created a day before started: 3, 5, 7");
  assert.equal(r.byPriority.find((x) => x.priority === 1)?.count, 1);
  assert.equal(r.byAssignee.find((x) => x.id === mate)?.count, 1);
  assert.equal(r.byAssignee.find((x) => x.id === null)?.count, 1);
  assert.equal(r.byStatus.reduce((a, b) => a + b.count, 0), 2);

  const own = insights(as(owner), { weeks: 12, today });
  assert.equal(own.open, 3, "the owner also sees the private team");
  assert.equal(insights(as(owner), { teamId: secret.id, weeks: 4, today }).open, 1);
  assert.throws(() => insights(as(mate), { teamId: secret.id, weeks: 4, today }), (e: unknown) => e instanceof PjError && e.status === 400, "a private team is not a scope for others");
  const proj = insights(as(mate), { projectId: p.id, weeks: 4, today });
  assert.equal(proj.completedInRange, 1);
  assert.equal(proj.open, 0);
  assert.equal(insights(as(mate), { weeks: 99, today }).periods.length, 12, "unknown ranges fall back to 12 weeks");
  assert.equal(done.length, 3);

  const other = createWorkspace(person("Stan"), "Elsewhere").id;
  assert.equal(insights(ctxFor(person("Stan"), other, "read"), { weeks: 4, today }).open, 0, "another workspace sees nothing");
});
