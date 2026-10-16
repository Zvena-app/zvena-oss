import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { ask, choice, noul, resetSmart, score } from "@/lib/decide/smart";
import { judge, setSmart } from "@/lib/decide/engine";
import type { Reaction } from "@/lib/decide/model";
import { createWorkspace } from "@/lib/workspaces";

// Live check against the configured decision model with synthetic, non-personal
// text. Skipped unless ZVENA_AI_LIVE=1, ZVENA_AI_URL and ZVENA_AI_KEY are set
// (it sends a request out).
const live = process.env.ZVENA_AI_LIVE === "1" && Boolean(process.env.ZVENA_AI_URL) && Boolean(process.env.ZVENA_AI_KEY);

test("smart live: yes/no, choice and score questions answer within the budget; off sends nothing", { skip: !live && "set ZVENA_AI_LIVE=1, ZVENA_AI_URL and ZVENA_AI_KEY" }, async () => {
  resetSmart();
  process.env.ZVENA_AI_TIMEOUT_MS = "5000";
  const r = signInWith({ provider: "dev", subject: "smart-live", name: "Live" }, "2026-10-13");
  assert.ok(r.ok);
  const owner = r.ok ? r.user.id : "";
  const ws = createWorkspace(owner, "Live").id;

  const yes = await ask(ws, { status: "Done", checklist: "3 of 3 items checked" }, { done: noul("Is the task finished?") }, { cacheMs: 0 });
  assert.ok(yes, "the model answered");
  assert.ok(yes.answers.done.noul > 0.5, `finished task: p(yes)=${yes.answers.done.noul}`);
  console.log(`  noul p=${yes.answers.done.noul.toFixed(2)} model=${yes.model} ${yes.ms} ms`);

  const tri = await ask(ws, { title: "Checkout page returns 500 for every customer", description: "Since the last deploy nobody can pay. Production is down for payments." }, {
    priority: score("How urgent is this issue?", ["Low", "Medium", "High", "Urgent: production is down"]),
    kind: choice("What kind of issue is this?", { bug: "Something is broken", feature: "A new capability", chore: "Maintenance" }),
  }, { cacheMs: 0 });
  assert.ok(tri, "the model answered the triage questions");
  assert.equal(tri.answers.kind.choice, "bug");
  assert.ok(tri.answers.priority.score >= 2, `priority level ${tri.answers.priority.score}`);
  console.log(`  triage kind=${tri.answers.kind.choice} (${tri.answers.kind.confidence.toFixed(2)}) priority=${tri.answers.priority.score} ${tri.ms} ms`);

  const reaction = { id: "r-live", name: "", on: true, when: { type: "projects" }, if: { kind: "ask", question: "Is the work finished?", fields: ["Title", "Status", "Assignee"], auto: 0.9, suggest: 0.6 }, then: [] } as unknown as Reaction;
  const v = await judge(ws, reaction, { key: "issue:live", facts: { Title: "Publish the release notes", Status: "Done", Assignee: "Test Person" }, personal: ["Assignee"] });
  assert.equal(v?.source, "model");
  console.log(`  reaction mode=${v?.mode} p=${v?.confidence?.toFixed(2)}`);

  setSmart(ws, false, owner);
  assert.equal(await ask(ws, { status: "Done" }, { done: noul("Is the task finished?") }, { cacheMs: 0 }), null, "off: nothing sent");
  resetSmart();
});
