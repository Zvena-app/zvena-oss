import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { directionIn, proposeGoal, targetIn } from "@/lib/decide/autogoal";
import { putMetric, reactionsOf, setSmart } from "@/lib/decide/engine";
import { goalIssueOf, setGoal } from "@/lib/decide/goals";
import { resetSmart } from "@/lib/decide/smart";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, updateIssue } from "@/lib/projects/issues";
import { createTeam } from "@/lib/projects/teams";
import { sql } from "@/lib/store";
import { createWorkspace } from "@/lib/workspaces";

// Goals that set themselves up: every part of the decision (a goal at all, the number, the
// target, the direction) must be sure before anything is set at once.

const r = signInWith({ provider: "dev", subject: "ag-owner", name: "Ada" }, "2026-10-13");
assert.ok(r.ok);
const owner = r.ok ? r.user.id : "";
const ws = createWorkspace(owner, "Autogoal").id;
const ctx = () => ctxFor(owner, ws, "edit");
const team = createTeam(ctx(), { name: "Growth", key: "AGL" }, "en");
setSmart(ws, true, owner);
putMetric(ws, "churn", 5, "Churn", "ingest");
putMetric(ws, "mrr", 10_000, "MRR", "ingest");
putMetric(ws, "signups", 120, "Signups", "ingest");
putMetric(ws, "costs", 6_000, "Costs", "ingest");

type Qs = Record<string, { type: string; criteria?: Record<string, string> }>;
interface Reply {
  goal?: number;
  number: string;
  numberP?: number;
  direction: "up" | "down";
  directionP?: number;
  target?: number;
  targetP?: number;
}

/** The model's answer to the questions sent, as the test wants it. */
function answer(qs: Qs, w: Reply): Record<string, unknown> {
  const pick = (id: string, choice: string, p: number) => {
    const keys = Object.keys(qs[id].criteria ?? {});
    return { type: "choice", choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : (1 - p) / Math.max(1, keys.length - 1)])), confidence: p };
  };
  const num = Object.entries(qs.number.criteria ?? {}).find(([, v]) => v.startsWith(`${w.number} (`))?.[0] ?? "none";
  return {
    goal: { type: "noul", noul: w.goal ?? 0.99 },
    number: pick("number", num, w.numberP ?? 0.99),
    direction: pick("direction", w.direction, w.directionP ?? 0.97),
    ...(qs.target ? { target: pick("target", `t${w.target ?? 0}`, w.targetP ?? 0.97) } : {}),
  };
}

let reply: Reply = { number: "none", direction: "up" };
let during: (() => void) | null = null;
let calls = 0;
const realFetch = globalThis.fetch;

async function withModel(fn: () => Promise<void>): Promise<void> {
  Object.assign(process.env, { ZVENA_AI_KEY: "k", ZVENA_AI_URL: "http://model.invalid/v1", ZVENA_AI_TIMEOUT_MS: "2000" });
  resetSmart();
  calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as { state: { title: string }; questions: Qs };
    // Something happens while the question is out (a person edits the issue).
    during?.();
    await new Promise((res) => setTimeout(res, 5));
    return new Response(JSON.stringify({ model: "m-test", answers: answer(body.questions, reply), usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    during = null;
    delete process.env.ZVENA_AI_KEY;
    delete process.env.ZVENA_AI_URL;
    delete process.env.ZVENA_AI_TIMEOUT_MS;
    resetSmart();
  }
}

const issue = (title: string) => createIssue(ctx(), { teamId: team.id, title }).id;
const goalOf = (id: string) => {
  const g = reactionsOf(ws).find((x) => goalIssueOf(x) === id);
  return g && g.if.kind === "compare" ? { key: g.when.type === "metric" ? g.when.key : "", op: g.if.op, target: g.if.value } : null;
};
const proposal = (decision: string) => {
  const row = sql("SELECT mode, status, actions, confidence FROM dz_decisions WHERE id = ?").get(decision) as { mode: string; status: string; actions: string; confidence: number };
  const p = JSON.parse(row.actions) as { reaction: { when: { key: string }; if: { op: string; value: number } } };
  return { mode: row.mode, status: row.status, confidence: row.confidence, key: p.reaction.when.key, op: p.reaction.if.op, target: p.reaction.if.value };
};

test("autogoal: the title's words on direction and target", () => {
  assert.equal(directionIn("Reduce churn below 3%"), "down");
  assert.equal(directionIn("Decrease costs to 4,000"), "down");
  assert.equal(directionIn("Grow MRR to $15k"), "up");
  assert.equal(directionIn("Increase signups to 500"), "up");
  assert.equal(directionIn("Signups 500 by June"), null);
  assert.equal(directionIn("Cut churn from 5% to 3%"), "down");
  assert.equal(directionIn("Grow MRR from $10k to $15k"), "up");
  assert.equal(directionIn("Churn from 5% to 3%"), "down", "from → to says which way by itself");
  assert.equal(directionIn("Grow churn from 5% to 3%"), "both", "words that contradict themselves decide nothing");
  assert.equal(targetIn("Grow MRR from $10k to $15k"), 1);
  assert.equal(targetIn("Cut churn from 5% to 3%"), 1);
  assert.equal(targetIn("Get 500 signups in 30 days"), null);
  assert.equal(targetIn("Reach 1,000 sign-ups by Q4 2026"), 0);
});

test("autogoal: reduce / decrease → ≤, grow / increase → ≥, set at once when every part is sure", async () => {
  await withModel(async () => {
    reply = { number: "Churn", direction: "down" };
    const a = issue("Reduce churn below 3%");
    assert.equal((await proposeGoal(ws, a, owner)).status, "applied");
    assert.deepEqual(goalOf(a), { key: "churn", op: "<=", target: 3 });

    reply = { number: "Costs", direction: "down" };
    const b = issue("Decrease costs to 4,000");
    assert.equal((await proposeGoal(ws, b, owner)).status, "applied");
    assert.deepEqual(goalOf(b), { key: "costs", op: "<=", target: 4000 });

    reply = { number: "MRR", direction: "up" };
    const c = issue("Grow MRR to $15k");
    assert.equal((await proposeGoal(ws, c, owner)).status, "applied");
    assert.deepEqual(goalOf(c), { key: "mrr", op: ">=", target: 15_000 });

    reply = { number: "Signups", direction: "up" };
    const d = issue("Increase signups to 500");
    assert.equal((await proposeGoal(ws, d, owner)).status, "applied");
    assert.deepEqual(goalOf(d), { key: "signups", op: ">=", target: 500 });
  });
});

test("autogoal: a direction the model is unsure about is never set at once (the audit case: churn ≥ 3%)", async () => {
  await withModel(async () => {
    // The model says "grow" at 51% about "Reduce churn below 3%": the words win, a person confirms.
    reply = { number: "Churn", direction: "up", directionP: 0.51 };
    const a = issue("Reduce churn below 3%");
    const out = await proposeGoal(ws, a, owner);
    assert.equal(out.status, "pending");
    assert.equal(goalOf(a), null, "nothing set");
    const p = proposal((out as { decision: string }).decision);
    assert.equal(p.mode, "suggest");
    assert.equal(p.op, "<=", "the proposal follows the words, never the model's coin flip");
    assert.ok(p.confidence < 0.85);

    // Sure, but contradicting the words: a proposal with the words' direction, not an automatic ≥.
    reply = { number: "Churn", direction: "up", directionP: 0.97 };
    const b = issue("Cut churn below 2%");
    const ob = await proposeGoal(ws, b, owner);
    assert.equal(ob.status, "pending");
    assert.equal(goalOf(b), null);
    assert.equal(proposal((ob as { decision: string }).decision).op, "<=");

    // No direction words: the model's direction alone, fairly sure → a proposal; unsure → nothing.
    reply = { number: "Signups", direction: "up", directionP: 0.7 };
    const c = issue("Signups 500 by June");
    const oc = await proposeGoal(ws, c, owner);
    assert.equal(oc.status, "pending");
    assert.equal(goalOf(c), null);
    assert.equal(proposal((oc as { decision: string }).decision).op, ">=");
    reply = { number: "Signups", direction: "up", directionP: 0.51 };
    const d = issue("Signups 700 by July");
    assert.deepEqual(await proposeGoal(ws, d, owner), { status: "none", why: "unsure" });
    assert.equal(goalOf(d), null);
  });
});

test("autogoal: a goal that would be met the moment it is set is only proposed", async () => {
  await withModel(async () => {
    // Churn is 5 now: "≥ 4" would close the issue at once — a person confirms instead.
    reply = { number: "Churn", direction: "up" };
    const a = issue("Churn 4% by Q3");
    const out = await proposeGoal(ws, a, owner);
    assert.equal(out.status, "pending");
    assert.equal(goalOf(a), null);
  });
});

test("autogoal: several numbers in the title — the target is the one the words aim at, ambiguity is never set at once", async () => {
  await withModel(async () => {
    reply = { number: "MRR", direction: "up", target: 1 };
    const a = issue("Grow MRR from $10k to $15k");
    assert.equal((await proposeGoal(ws, a, owner)).status, "applied");
    assert.deepEqual(goalOf(a), { key: "mrr", op: ">=", target: 15_000 });

    reply = { number: "Churn", direction: "down", target: 1 };
    const b = issue("Cut churn from 5% to 3%");
    assert.equal((await proposeGoal(ws, b, owner)).status, "applied");
    assert.deepEqual(goalOf(b), { key: "churn", op: "<=", target: 3 });

    // The model picks the starting value: the words' target is proposed, not set.
    reply = { number: "MRR", direction: "up", target: 0, targetP: 0.97 };
    const c = issue("Grow MRR from $12k to $20k");
    const oc = await proposeGoal(ws, c, owner);
    assert.equal(oc.status, "pending");
    assert.equal(goalOf(c), null);
    assert.equal(proposal((oc as { decision: string }).decision).target, 20_000);

    // Two numbers and no "from … to": the model's pick, never at once when it is unsure.
    reply = { number: "Signups", direction: "up", target: 0, targetP: 0.7 };
    const d = issue("Get 500 signups in 30 days");
    const od = await proposeGoal(ws, d, owner);
    assert.equal(od.status, "pending");
    assert.equal(proposal((od as { decision: string }).decision).target, 500);
    reply = { number: "Signups", direction: "up", target: 0, targetP: 0.4 };
    const e = issue("Get 600 signups in 45 days");
    assert.deepEqual(await proposeGoal(ws, e, owner), { status: "none", why: "unsure" });
  });
  // Without the model the rules never guess among several numbers.
  const f = issue("Get 800 signups in 60 days");
  assert.deepEqual(await proposeGoal(ws, f, owner), { status: "none", why: "unsure" });
  // …but "from … to" names the target.
  const g = issue("Grow signups from 120 to 900");
  const og = await proposeGoal(ws, g, owner);
  assert.equal(og.status, "pending");
  const pg = proposal((og as { decision: string }).decision);
  assert.deepEqual([pg.key, pg.op, pg.target], ["signups", ">=", 900]);
});

test("autogoal: the title changed while the question was out — the stale answer is not applied", async () => {
  await withModel(async () => {
    // Changed once: asked again about the new title, and that answer is used.
    reply = { number: "Signups", direction: "up" };
    const a = issue("Reach 300 signups");
    let first = true;
    during = () => {
      if (!first) return;
      first = false;
      updateIssue(ctx(), a, { title: "Reach 900 signups" });
    };
    assert.equal((await proposeGoal(ws, a, owner)).status, "applied");
    assert.equal(calls, 2, "asked again about the new title");
    assert.deepEqual(goalOf(a), { key: "signups", op: ">=", target: 900 }, "the target of the title as it is now");

    // Changed into something that is no goal: nothing.
    const b = issue("Reach 400 signups");
    during = () => updateIssue(ctx(), b, { title: "Polish the onboarding emails" });
    calls = 0;
    assert.deepEqual(await proposeGoal(ws, b, owner), { status: "none", why: "no target" });
    assert.equal(goalOf(b), null);

    // Changing every time: given up, nothing set.
    const c = issue("Reach 500 signups");
    let k = 0;
    during = () => updateIssue(ctx(), c, { title: `Reach ${600 + ++k} signups` });
    assert.deepEqual(await proposeGoal(ws, c, owner), { status: "none", why: "changed" });
    assert.equal(goalOf(c), null);

    // A goal set by hand while the question was out: the answer does not add another.
    const d = issue("Reach 650 signups");
    during = () => {
      during = null;
      assert.ok(!("error" in setGoal(ws, { issue: d, key: "signups", op: ">", target: 640 }, owner)));
    };
    assert.deepEqual(await proposeGoal(ws, d, owner), { status: "none", why: "already" });
    assert.deepEqual(goalOf(d), { key: "signups", op: ">", target: 640 }, "the person's goal stays as they set it");
    assert.equal(reactionsOf(ws).filter((x) => goalIssueOf(x) === d).length, 1);
  });
});
