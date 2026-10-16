import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { autogoalIdle, fallsTo, proposeGoal, targetsIn } from "@/lib/decide/autogoal";
import { followParent } from "@/lib/decide/cascade";
import { metricsOf, putMetric, reactionsOf, setJev } from "@/lib/decide/engine";
import { chartGoal, goalsOf, setGoal } from "@/lib/decide/goals";
import { hubSettings, setHubSettings, startJev } from "@/lib/decide/hub";
import { resetJev } from "@/lib/decide/jev";
import { activityOf, settle } from "@/lib/decide/journal";
import { databasesFor, forgetSeen, saveSource, sourceKey, visibleMetrics } from "@/lib/decide/sources";
import { setRestricted } from "@/lib/notes/access";
import { sanitizeNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, getIssueBrief, updateIssue } from "@/lib/projects/issues";
import { createProject } from "@/lib/projects/planning";
import { createTeam, listStatuses, setTeamMember } from "@/lib/projects/teams";
import { visibleTo } from "@/lib/pulse/bus";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

async function until(ok: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `jh-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Noa");
const mate = person("Ike");
const ws = createWorkspace(owner, "Hub").id;
acceptInvite(mate, createInvite(owner, ws, "editor")!.token);
const as = (u: string, need: "read" | "edit" = "edit") => ctxFor(u, ws, need);
const team = createTeam(as(owner), { name: "Growth", key: "GRW" }, "en");
setTeamMember(as(owner), team.id, mate, "member");
const cat = (id: string) => listStatuses(as(owner, "read")).find((s) => s.id === getIssueBrief(as(owner, "read"), id).statusId)?.category;
const statusOf = (c: string) => listStatuses(as(owner, "read")).find((s) => s.teamId === team.id && s.category === c)!.id;

// The hub hears everything; Jev (the model) stays off until a test turns it on.
delete process.env.TYPESAFE_API_KEY;
startJev();

let n = 0;
function note(over: Partial<Note> & { id: string; kind: Note["kind"] }): Note {
  const now = Date.now();
  return sanitizeNote({ title: "", parentId: null, icon: "", cover: null, content: [], order: ++n, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, ...over }) as Note;
}
const DB = "jhdb0000000000000000000000000sales";
function salesDb(): void {
  const db = note({
    id: DB,
    kind: "database",
    title: "Sales",
    db: {
      properties: [
        { id: "title", name: "Deal", type: "title" },
        { id: "amt", name: "Amount", type: "number" },
        { id: "st", name: "Stage", type: "status", options: [{ id: "open", name: "Open", color: "default", group: "todo" }, { id: "won", name: "Won", color: "green", group: "done" }] },
      ],
      views: [
        { id: "v1", name: "All", type: "table", filters: [], sorts: [] },
        { id: "ch", name: "Won revenue", type: "chart", filters: [], sorts: [], chart: { type: "column", x: "st", y: { fn: "sum", prop: "amt" } } },
      ],
    } as unknown as Note["db"],
  });
  pushNotes(ws, [{ id: DB, note: db }], { by: owner, quotaLeft: Infinity });
}
function deal(id: string, amount: number, stage: "open" | "won"): void {
  const row = note({ id, kind: "page", title: `Deal ${id.slice(-3)}`, parentId: DB, props: { amt: amount, st: stage } });
  pushNotes(ws, [{ id, note: row }], { by: owner, quotaLeft: Infinity });
}
const metric = (key: string) => metricsOf(ws).find((m) => m.key === key)?.value;

test("targets in titles: amounts, suffixes and percents count; years, quarters and issue numbers do not", () => {
  assert.deepEqual(
    targetsIn("Reach 1,000 sign-ups by Q4 2026").map((t) => t.value),
    [1000]
  );
  assert.deepEqual(
    targetsIn("MRR $10k").map((t) => t.value),
    [10000]
  );
  assert.deepEqual(
    targetsIn("Cut churn below 3.5%").map((t) => t.value),
    [3.5]
  );
  assert.deepEqual(
    targetsIn("Close 2.5M in pipeline, not #12").map((t) => t.value),
    [2_500_000]
  );
  assert.deepEqual(targetsIn("Fix the login page"), []);
  assert.ok(fallsTo("Cut churn below 3%"));
  assert.ok(!fallsTo("Reach 1,000 sign-ups"));
});

test("a chart becomes a goal: the chart's number is kept live, and the goal closes when the chart reaches the target", async () => {
  salesDb();
  deal("jhrow00000000000000000000000001", 400, "won");
  deal("jhrow00000000000000000000000002", 900, "open");
  const r = chartGoal(ws, { db: DB, view: "ch", bar: { prop: "st", key: "won" }, op: ">=", target: 1000, title: "Won revenue reaches 1,000" }, mate);
  assert.ok(!("error" in r), JSON.stringify(r));
  if ("error" in r) return;
  assert.equal(r.met, false);
  assert.equal(metric(r.key), 400, "the chart's Won bar: one won deal of 400");
  assert.equal(cat(r.issue.id), "unstarted");
  // Same chart, same number: a second goal reuses it.
  assert.equal(r.key, sourceKey({ kind: "docs", db: DB, view: "ch", fn: "sum", prop: "amt", where: { prop: "st", key: "won" } }));
  // The open deal is won: the bar grows to 1,300 and the goal closes by itself.
  deal("jhrow00000000000000000000000002", 900, "won");
  await until(() => cat(r.issue.id) === "completed");
  assert.equal(metric(r.key), 1300);
  assert.equal(cat(r.issue.id), "completed", "the goal closed when the chart got there");
  const g = goalsOf(ws, owner).find((x) => x.issue.id === r.issue.id);
  assert.ok(g && g.met && g.issue.done && g.source?.kind === "docs");
  assert.ok(
    activityOf(ws, owner).some((a) => a.kind === "goal_met"),
    "the journal says the goal was met"
  );
  assert.ok(databasesFor(ws, owner).some((d) => d.id === DB && d.views.some((v) => v.id === "ch" && v.chart?.fn === "sum")));
});

test("a private database's number is seen only by people who can open it", async () => {
  const PRIV = "jhdb000000000000000000000000priv1";
  const db = note({ id: PRIV, kind: "database", title: "Salaries", db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "pay", name: "Pay", type: "number" }], views: [] } as unknown as Note["db"] });
  pushNotes(ws, [{ id: PRIV, note: db }], { by: owner, quotaLeft: Infinity });
  setRestricted(ws, PRIV, true, owner);
  const row = note({ id: "jhrow0000000000000000000000priv1", kind: "page", title: "A", parentId: PRIV, props: { pay: 5000 } });
  pushNotes(ws, [{ id: row.id, note: row }], { by: owner, quotaLeft: Infinity });
  const s = saveSource(ws, { kind: "docs", db: PRIV, fn: "sum", prop: "pay" }, owner);
  assert.ok(!("error" in s), JSON.stringify(s));
  if ("error" in s) return;
  assert.equal(s.value, 5000);
  const seen = (u: string) => visibleMetrics(ws, u, metricsOf(ws)).some((m) => m.key === s.key);
  assert.equal(databasesFor(ws, mate).some((d) => d.id === PRIV), false, "the database is restricted to its owner");
  assert.equal(seen(owner), true);
  assert.equal(seen(mate), false, "a member who cannot open the database does not see its number");
  assert.equal(visibleTo(mate, { id: 1, ws, type: "metric", ref: s.key, at: Date.now(), data: { value: 5000 } }), false, "nor on the live channel");
  assert.equal(visibleTo(owner, { id: 1, ws, type: "metric", ref: s.key, at: Date.now(), data: { value: 5000 } }), true);
  assert.ok("error" in saveSource(ws, { kind: "docs", db: PRIV, fn: "sum", prop: "pay" }, mate), "nor can they count it");
  // Nobody types over a counted number (it would close the goals on it).
  assert.equal(putMetric(ws, s.key, 1e9, null, mate), false);
  assert.equal(metricsOf(ws).find((m) => m.key === s.key)?.value, 5000);
});

test("a number is shown only to people who would count the same: a restricted row in a shared database hides it", async () => {
  const SHARED = "jhdb00000000000000000000000share1";
  const db = note({ id: SHARED, kind: "database", title: "Leads", db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "v", name: "Value", type: "number" }], views: [] } as unknown as Note["db"] });
  const open = note({ id: "jhrow000000000000000000000share1", kind: "page", title: "Open lead", parentId: SHARED, props: { v: 10 } });
  const hidden = note({ id: "jhrow000000000000000000000share2", kind: "page", title: "Secret lead", parentId: SHARED, props: { v: 90 } });
  pushNotes(ws, [{ id: SHARED, note: db }, { id: open.id, note: open }, { id: hidden.id, note: hidden }], { by: owner, quotaLeft: Infinity });
  setRestricted(ws, hidden.id, true, owner);
  const s = saveSource(ws, { kind: "docs", db: SHARED, fn: "sum", prop: "v" }, owner);
  assert.ok(!("error" in s));
  if ("error" in s) return;
  assert.equal(s.value, 100, "the owner counts both rows");
  assert.equal(databasesFor(ws, mate).some((d) => d.id === SHARED), true, "the teammate can open the database…");
  assert.equal(visibleMetrics(ws, mate, metricsOf(ws)).some((m) => m.key === s.key), false, "…but not the number, which counts a row they cannot see");
  assert.ok("error" in saveSource(ws, { kind: "docs", db: SHARED, fn: "sum", prop: "v" }, mate), "nor reuse it");
  setRestricted(ws, hidden.id, false, owner);
  forgetSeen();
  assert.equal(visibleMetrics(ws, mate, metricsOf(ws)).some((m) => m.key === s.key), true, "once they see every row, they see the number");
});

test("a project's progress is a live number: a goal on 100 % closes with the project's last issue", async () => {
  const p = createProject(as(owner), { name: "Launch", teamIds: [team.id] });
  const a = createIssue(as(owner), { teamId: team.id, title: "Landing page", projectId: p.id });
  const b = createIssue(as(owner), { teamId: team.id, title: "Pricing", projectId: p.id });
  const goal = createIssue(as(owner), { teamId: team.id, title: "Launch is fully done" });
  const s = saveSource(ws, { kind: "project", project: p.id, measure: "percent" }, owner);
  assert.ok(!("error" in s));
  if ("error" in s) return;
  assert.equal(s.value, 0);
  const r = setGoal(ws, { issue: goal.id, key: s.key, op: ">=", target: 100 }, owner);
  assert.ok(!("error" in r), JSON.stringify(r));
  updateIssue(as(owner), a.id, { statusId: statusOf("completed") });
  await until(() => metric(s.key) === 50);
  assert.equal(metric(s.key), 50);
  assert.equal(cat(goal.id), "unstarted");
  updateIssue(as(owner), b.id, { statusId: statusOf("completed") });
  await until(() => cat(goal.id) === "completed");
  assert.equal(cat(goal.id), "completed");
});

test("a parent issue closes with its last sub-issue, reopens with one, and Undo puts it back", async () => {
  const parent = createIssue(as(mate), { teamId: team.id, title: "Onboarding revamp" });
  const s1 = createIssue(as(mate), { teamId: team.id, title: "Welcome email", parentId: parent.id });
  const s2 = createIssue(as(mate), { teamId: team.id, title: "Checklist", parentId: parent.id });
  updateIssue(as(mate), s1.id, { statusId: statusOf("completed") });
  await new Promise((r) => setTimeout(r, 60));
  assert.notEqual(cat(parent.id), "completed", "one sub-issue still open");
  updateIssue(as(mate), s2.id, { statusId: statusOf("canceled") });
  await until(() => cat(parent.id) === "completed");
  assert.equal(cat(parent.id), "completed", "all closed, one completed: the parent is done");
  const done = activityOf(ws, mate).find((x) => x.kind === "parent_done" && x.subject === `issue:${parent.id}`);
  assert.ok(done?.canUndo, "on record, with Undo");
  updateIssue(as(mate), s2.id, { statusId: statusOf("started") });
  await until(() => cat(parent.id) !== "completed");
  assert.equal(cat(parent.id), "unstarted", "a sub-issue reopened: the parent goes back where it was");
  // Closed again, then undone by a person.
  updateIssue(as(mate), s2.id, { statusId: statusOf("completed") });
  await until(() => cat(parent.id) === "completed");
  const again = activityOf(ws, mate).find((x) => x.kind === "parent_done" && x.subject === `issue:${parent.id}` && x.canUndo);
  assert.ok(again);
  assert.equal(settle(ws, again.id, "undo", mate), "undone");
  assert.equal(cat(parent.id), "unstarted");
  // The owner can turn it off.
  setHubSettings(ws, { parents: false }, owner);
  assert.equal(hubSettings(ws).parents, false);
  const p2 = createIssue(as(mate), { teamId: team.id, title: "Second parent" });
  const c2 = createIssue(as(mate), { teamId: team.id, title: "Only child", parentId: p2.id });
  updateIssue(as(mate), c2.id, { statusId: statusOf("completed") });
  assert.equal(followParent({ ws, id: c2.id, by: mate }, (w) => hubSettings(w).parents), null);
  setHubSettings(ws, { parents: true }, owner);
});

test("without Jev the rules only propose a goal when exactly one number is named; accepting it makes the issue close by itself", async () => {
  putMetric(ws, "signups", 120, "Signups", "ingest");
  const issue = createIssue(as(mate), { teamId: team.id, title: "Reach 500 signups" });
  await autogoalIdle();
  const prop = activityOf(ws, mate).find((a) => a.kind === "goal_linked" && a.subject === `issue:${issue.id}`);
  assert.ok(prop, "a proposal waits for the creator");
  assert.equal(prop.source, "rule");
  assert.equal(prop.canResolve, true);
  assert.equal(reactionsOf(ws).filter((r) => JSON.stringify(r.then).includes(issue.id)).length, 0, "nothing set without a person");
  assert.equal(settle(ws, prop.id, "accept", mate), "applied");
  putMetric(ws, "signups", 520, null, "ingest");
  await until(() => cat(issue.id) === "completed");
  assert.equal(cat(issue.id), "completed");
  // A title that names no number gets nothing.
  const other = createIssue(as(mate), { teamId: team.id, title: "Polish the 3 onboarding emails" });
  assert.equal((await proposeGoal(ws, other.id, mate)).status, "none");
});

test("with Jev on, a goal it is sure about is set at once, marked as Jev's, and can be undone", async () => {
  type Body = { state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: Record<string, string> }> };
  const bodies: Body[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw) as Body;
      bodies.push(b);
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(b.questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: 0.97 };
        else if (q.type === "choice") {
          const keys = Object.keys(q.criteria ?? {});
          const pick = id === "number" ? (keys.find((k) => String(q.criteria![k]).startsWith("Revenue")) ?? "none") : id === "direction" ? "up" : (keys[0] ?? "none");
          answers[id] = { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 0.93 : 0.07 / (keys.length - 1)])), confidence: 0.93 };
        } else answers[id] = { type: "score", score: 1, legend: {}, probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 }, confidence: 0.8 };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { TYPESAFE_API_KEY: "test-key", ZVENA_JEV_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`, ZVENA_JEV_TIMEOUT_MS: "800" });
  resetJev();
  setJev(ws, true, owner);
  try {
    putMetric(ws, "rev", 30_000, "Revenue", "ingest");
    const issue = createIssue(as(owner), { teamId: team.id, title: "Hit $50k in quarterly sales" });
    await autogoalIdle();
    await until(() => goalsOf(ws, owner).some((g) => g.issue.id === issue.id));
    const g = goalsOf(ws, owner).find((x) => x.issue.id === issue.id);
    assert.ok(g, "Jev set the goal");
    assert.equal(g.key, "rev");
    assert.equal(g.target, 50_000);
    assert.equal(g.op, ">=");
    assert.equal(g.byJev, true);
    const sent = bodies.find((b) => b.questions.number);
    assert.ok(sent);
    assert.deepEqual(Object.keys(sent.state), ["title"], "only the title goes out (and the numbers' names in the options)");
    const item = activityOf(ws, owner).find((a) => a.kind === "goal_linked" && a.subject === `issue:${issue.id}`);
    assert.ok(item?.canUndo && item.source === "jev");
    assert.equal(settle(ws, item.id, "undo", owner), "undone");
    assert.ok(!goalsOf(ws, owner).some((x) => x.issue.id === issue.id), "undo removes the goal");
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    resetJev();
    server.close();
  }
});
