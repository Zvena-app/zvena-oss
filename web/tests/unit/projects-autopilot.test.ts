import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { setJev } from "@/lib/decide/engine";
import { resetJev } from "@/lib/decide/jev";
import { sanitizeNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { autopilotIdle, resolveSuggestion, similarIssues, startAutopilot, suggestionsOf } from "@/lib/projects/autopilot";
import { ctxFor, PjError } from "@/lib/projects/core";
import { createFromDoc, planFromDoc } from "@/lib/projects/from-doc";
import { createIssue, getIssueBrief, updateIssue } from "@/lib/projects/issues";
import { createProject } from "@/lib/projects/planning";
import { addComment, issueDetail, relationsOf } from "@/lib/projects/social";
import { startProjects } from "@/lib/projects/start";
import { createTeam, listLabels, listStatuses, setTeamMember } from "@/lib/projects/teams";
import { inbox } from "@/lib/projects/workspace";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `pja-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Ada");
const mate = person("Lin");
const viewer = person("Vic");
const stranger = person("Stan");
const ws = createWorkspace(owner, "Autopilot").id;
for (const [u, role] of [
  [mate, "editor"],
  [viewer, "viewer"],
] as const)
  acceptInvite(u, createInvite(owner, ws, role)!.token);
const as = (u: string, need: "read" | "edit" = "edit") => ctxFor(u, ws, need);
const team = createTeam(as(owner), { name: "Core", key: "CORE" }, "en");
setTeamMember(as(owner), team.id, mate, "member");
const bug = listLabels(as(owner)).find((l) => l.name === "Bug");
const checkout = createProject(as(owner), { name: "Checkout v2", teamIds: [team.id], summary: "Payments and the cart" });
const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof PjError ? `${e.status}` : String(e);
  }
};

type Body = { state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: unknown }> };
let bodies: Body[] = [];
let reply: (b: Body) => unknown = () => ({});
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const b = JSON.parse(raw) as Body;
    bodies.push(b);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "jev-test", answers: reply(b), usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});

/** A choice answer: `pick` (an option key) with probability p. */
const pickA = (q: { criteria?: unknown }, pick: string, p: number) => {
  const keys = Object.keys(q.criteria as Record<string, unknown>);
  return { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? p : (1 - p) / (keys.length - 1)])), confidence: p };
};
const keyOf = (q: { criteria?: unknown }, includes: string) => Object.entries(q.criteria as Record<string, string>).find(([, v]) => String(v).includes(includes))?.[0] ?? "none";

test("autopilot: fills empty fields when sure, suggests the rest, marks it Jev, and undo / accept / dismiss work with people's rights", async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { TYPESAFE_API_KEY: "test-key", ZVENA_JEV_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`, ZVENA_JEV_TIMEOUT_MS: "800" });
  resetJev();
  startAutopilot();
  setJev(ws, true, owner);
  try {
    const original = createIssue(as(mate), { teamId: team.id, title: "Checkout payment fails for large carts", priority: 2, assigneeId: mate });
    await autopilotIdle();
    bodies = [];
    reply = (b) => {
      const q = b.questions;
      const out: Record<string, unknown> = {};
      if (q.priority) out.priority = { type: "score", score: 3, legend: {}, probabilities: { "0": 0.02, "1": 0.03, "2": 0.05, "3": 0.9 }, confidence: 0.9 };
      if (q.label) out.label = pickA(q.label, keyOf(q.label, "Bug"), 0.88);
      if (q.project) out.project = pickA(q.project, keyOf(q.project, "Checkout"), 0.7);
      if (q.assignee) out.assignee = pickA(q.assignee, keyOf(q.assignee, "Checkout payment fails"), 0.75);
      if (q.duplicate) out.duplicate = pickA(q.duplicate, keyOf(q.duplicate, "Checkout payment fails"), 0.86);
      return out;
    };
    const issue = createIssue(as(owner), { teamId: team.id, title: "Payment fails at checkout for big carts", description: "Customers with 50+ items get **error 500**." });
    await autopilotIdle();
    assert.equal(bodies.length, 1, "one Jev call per new issue");
    assert.deepEqual(Object.keys(bodies[0].questions).sort(), ["assignee", "duplicate", "label", "priority", "project"]);
    assert.deepEqual(Object.keys(bodies[0].state).sort(), ["description", "title"]);
    assert.ok(!JSON.stringify(bodies[0]).includes(owner) && !JSON.stringify(bodies[0]).includes(mate), "no user ids leave");
    assert.ok(!JSON.stringify(bodies[0]).includes("Ada") && !JSON.stringify(bodies[0]).includes("Lin"), "no names leave either");
    assert.ok(!String(bodies[0].state.description).includes("**"), "plain text only");

    const after = getIssueBrief(as(owner), issue.id);
    assert.equal(after.priority, 1, "empty priority filled at 90%");
    assert.deepEqual(after.labelIds, [bug?.id], "empty label filled at 88%");
    assert.equal(after.projectId, null, "a project at 70% is only suggested");
    assert.equal(after.assigneeId, null, "the assignee is never set automatically");
    const list = suggestionsOf(as(owner), issue.id);
    const by = (k: string) => list.find((s) => s.kind === k);
    assert.equal(by("priority")?.state, "applied");
    assert.equal(by("label")?.state, "applied");
    assert.equal(by("project")?.state, "open");
    assert.equal(by("assignee")?.state, "open");
    assert.equal(by("assignee")?.value.userId, mate);
    assert.equal(by("duplicate")?.value.identifier, original.identifier);
    const detail = issueDetail(as(owner), issue.id);
    assert.ok(detail.activity.some((a) => a.kind === "priority" && a.via === "jev" && a.actorId === owner), "the history says Jev, on the author's behalf");
    const note = inbox(as(owner), {}).items.find((n) => n.kind === "duplicate");
    assert.equal(note?.data.of, original.identifier, "the author hears about the possible duplicate");

    // People decide; viewers and strangers cannot.
    assert.equal(code(() => resolveSuggestion(as(viewer, "read"), by("assignee")!.id, "accept")), "403");
    assert.equal(code(() => resolveSuggestion(ctxFor(stranger, createWorkspace(stranger, "Other").id, "edit"), by("assignee")!.id, "accept")), "404");
    resolveSuggestion(as(owner), by("priority")!.id, "undo");
    assert.equal(getIssueBrief(as(owner), issue.id).priority, 0, "undo restores the empty priority");
    updateIssue(as(owner), issue.id, { removeLabelIds: [bug!.id], addLabelIds: [listLabels(as(owner)).find((l) => l.name === "Feature")!.id] });
    resolveSuggestion(as(owner), by("label")!.id, "undo");
    assert.ok(!getIssueBrief(as(owner), issue.id).labelIds.includes(bug!.id) && getIssueBrief(as(owner), issue.id).labelIds.length === 1, "a person's later change stays");
    resolveSuggestion(as(mate), by("assignee")!.id, "accept");
    assert.equal(getIssueBrief(as(owner), issue.id).assigneeId, mate);
    resolveSuggestion(as(owner), by("project")!.id, "dismiss");
    assert.equal(getIssueBrief(as(owner), issue.id).projectId, null);
    assert.equal(code(() => resolveSuggestion(as(owner), by("project")!.id, "accept")), "400", "a dismissed suggestion stays dismissed");
    resolveSuggestion(as(owner), by("duplicate")!.id, "accept");
    assert.ok(relationsOf(as(owner), issue.id).some((r) => r.type === "duplicate" && r.issue.id === original.id));
    const canceled = listStatuses(as(owner)).find((s) => s.teamId === team.id && s.category === "canceled");
    assert.equal(getIssueBrief(as(owner), issue.id).statusId, canceled?.id, "a duplicate is closed as canceled");
    assert.equal(suggestionsOf(as(owner), issue.id).filter((s) => s.state === "open").length, 0);

    // A comment that says the work is done → a suggestion to close, never an automatic close.
    bodies = [];
    reply = (b) => ("done" in b.questions ? { done: { type: "noul", noul: 0.93 } } : {});
    const open = createIssue(as(owner), { teamId: team.id, title: "Add Apple Pay", priority: 3, labelIds: [bug!.id], projectId: checkout.id, assigneeId: owner });
    await autopilotIdle();
    addComment(as(mate), open.id, { body: "Shipped to production this morning, all green." });
    await autopilotIdle();
    const done = suggestionsOf(as(owner), open.id).find((s) => s.kind === "done");
    assert.ok(done && done.state === "open");
    assert.notEqual(listStatuses(as(owner)).find((s) => s.id === getIssueBrief(as(owner), open.id).statusId)?.category, "completed");
    resolveSuggestion(as(owner), done.id, "accept");
    assert.equal(listStatuses(as(owner)).find((s) => s.id === getIssueBrief(as(owner), open.id).statusId)?.category, "completed");

    // Nothing to decide (all fields set, no similar issue): no call at all.
    bodies = [];
    createIssue(as(owner), { teamId: team.id, title: "Zzqx unique", priority: 4, labelIds: [bug!.id], projectId: checkout.id, assigneeId: owner });
    await autopilotIdle();
    assert.equal(bodies.length, 0);

    // The first-run examples are left alone; a workspace that turned Jev off is never asked.
    const fresh = createWorkspace(owner, "Fresh").id;
    bodies = [];
    startProjects(ctxFor(owner, fresh, "edit"), "en");
    await autopilotIdle();
    assert.equal(bodies.length, 0, "examples are quiet");
    setJev(ws, false, owner);
    createIssue(as(owner), { teamId: team.id, title: "Checkout totals are wrong" });
    await autopilotIdle();
    assert.equal(bodies.length, 0, "off means off");
    setJev(ws, true, owner);

    // While typing a new issue: similar ones, with Jev's verdict.
    reply = (b) => ({ same: pickA(b.questions.same, keyOf(b.questions.same, "Checkout payment fails"), 0.9) });
    const sim = await similarIssues(as(owner), { title: "Checkout payment fails with many items" });
    assert.equal(sim.source, "jev");
    assert.equal(sim.issues[0]?.id, original.id);
  } finally {
    resetJev();
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("goals from a document: lines a person may read become proposed projects and issues; Jev or rules decide; only ticked ones are made", async () => {
  const now = Date.now();
  const id = "pjadoc000000000000000000000000q4";
  const line = (type: string, text: string, props: Record<string, unknown> = {}) => ({ id: Math.random().toString(36).slice(2, 10), type, props, content: [{ type: "text", text, styles: {} }], children: [] });
  const note = sanitizeNote({
    id,
    kind: "page",
    title: "Q4 plan",
    parentId: null,
    icon: "",
    cover: null,
    content: [
      line("heading", "Plan for the quarter", { level: 2 }),
      line("bulletListItem", "Reach 1000 paying teams by December"),
      line("checkListItem", "Ship Apple Pay", { checked: false }),
      line("checkListItem", "Fix the refund e-mails", { checked: true }),
      line("paragraph", "We met on Monday."),
    ],
    order: 1,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
  }) as Note;
  pushNotes(ws, [{ id, note }], { by: owner, quotaLeft: Infinity });

  resetJev();
  delete process.env.TYPESAFE_API_KEY;
  const rules = await planFromDoc(as(owner), id);
  assert.equal(rules.source, "rules");
  const kinds = rules.lines.map((l) => `${l.kind}:${l.text}`);
  assert.ok(kinds.includes("goal:Reach 1000 paying teams by December"));
  assert.ok(kinds.includes("task:Ship Apple Pay"));
  assert.equal(rules.lines.find((l) => l.text === "Ship Apple Pay")?.goal, rules.lines.findIndex((l) => l.text.startsWith("Reach")), "a task belongs to the goal above");
  assert.equal(code(() => void planFromDoc(ctxFor(stranger, createWorkspace(stranger, "S2").id, "read"), id).catch(() => undefined)), "ok");
  await assert.rejects(() => planFromDoc(ctxFor(stranger, createWorkspace(stranger, "S3").id, "read"), id), (e: unknown) => e instanceof PjError && e.status === 404);

  // With Jev: its verdict per line.
  Object.assign(process.env, { TYPESAFE_API_KEY: "test-key" });
  setJev(ws, true, owner);
  bodies = [];
  reply = (b) => !Array.isArray(b.state.lines) ? {} : Object.fromEntries(Object.entries(b.questions).map(([k, q]) => [k, pickA(q, String((b.state.lines as string[])[Number(k.slice(1))]).startsWith("We met") ? "none" : String((b.state.lines as string[])[Number(k.slice(1))]).startsWith("Reach") ? "goal" : "task", 0.8)]));
  const plan = await planFromDoc(as(owner), id);
  assert.equal(plan.source, "jev");
  assert.equal(plan.lines.find((l) => l.text === "We met on Monday.")?.kind, "none");
  assert.deepEqual(Object.keys(bodies[0].state).sort(), ["document", "lines"]);

  const goalAt = plan.lines.findIndex((l) => l.kind === "goal");
  const made = createFromDoc(as(owner), {
    teamId: team.id,
    goals: [{ text: plan.lines[goalAt].text }],
    tasks: plan.lines.filter((l) => l.kind === "task" && l.text !== "Plan for the quarter").map((l) => ({ text: l.text, goal: 0, done: l.checked === true })),
  });
  await autopilotIdle();
  assert.equal(made.projects.length, 1);
  assert.equal(made.issues.length, 2);
  const shipped = getIssueBrief(as(owner), made.issues[1]);
  assert.equal(shipped.projectId, made.projects[0]);
  assert.equal(listStatuses(as(owner)).find((s) => s.id === shipped.statusId)?.category, "completed", "a ticked checklist item is done");
  const again = await planFromDoc(as(owner), id);
  assert.ok(again.lines.find((l) => l.text === "Ship Apple Pay")?.exists, "a second run marks what already exists");
  assert.equal(code(() => createFromDoc(as(viewer, "read"), { teamId: team.id, goals: [{ text: "x" }] })), "403");
  resetJev();
  delete process.env.TYPESAFE_API_KEY;
  await new Promise<void>((r) => server.close(() => r()));
});

test("Jev's suggestions are kept 90 days", async () => {
  const { pruneSuggestions } = await import("@/lib/projects/autopilot");
  const { sql } = await import("@/lib/store");
  const n = Number((sql("SELECT COUNT(*) AS n FROM pj_suggestions").get() as { n: number }).n);
  assert.ok(n > 0);
  assert.equal(pruneSuggestions(Date.now() + 89 * 86_400_000), 0);
  assert.equal(pruneSuggestions(Date.now() + 91 * 86_400_000), n);
});

test("the autopilot's hourly budget per workspace", async () => {
  const { spend, HOURLY_LIMIT } = await import("@/lib/projects/autopilot");
  const t = Date.UTC(2030, 0, 1, 10, 0, 0);
  let ok = 0;
  for (let i = 0; i < HOURLY_LIMIT + 5; i++) if (spend("budget-ws-1", t + i)) ok++;
  assert.equal(ok, HOURLY_LIMIT, "the hour's budget is spent");
  assert.ok(spend("budget-ws-2", t), "another workspace has its own");
  assert.ok(spend("budget-ws-1", t + 3_600_000), "a new hour, a new budget");
});
