import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { ask, choice, noul, resetJev, score } from "@/lib/decide/jev";
import { judge, setJev } from "@/lib/decide/engine";
import type { Reaction } from "@/lib/decide/model";
import { createWorkspace } from "@/lib/workspaces";

// Live check against TypeSafe AI with synthetic, non-personal text. Skipped
// unless JEV_LIVE=1 and TYPESAFE_API_KEY are set (it sends a request out).
const live = process.env.JEV_LIVE === "1" && Boolean(process.env.TYPESAFE_API_KEY);

test("jev live: yes/no, choice and score questions answer within the budget; off sends nothing", { skip: !live && "set JEV_LIVE=1 and TYPESAFE_API_KEY" }, async () => {
  resetJev();
  process.env.ZVENA_JEV_TIMEOUT_MS = "5000";
  const r = signInWith({ provider: "dev", subject: "jev-live", name: "Live" }, "2026-10-13");
  assert.ok(r.ok);
  const owner = r.ok ? r.user.id : "";
  const ws = createWorkspace(owner, "Live").id;

  const yes = await ask(ws, { status: "Done", checklist: "3 of 3 items checked" }, { done: noul("Is the task finished?") }, { cacheMs: 0 });
  assert.ok(yes, "Jev answered");
  assert.ok(yes.answers.done.noul > 0.5, `finished task: p(yes)=${yes.answers.done.noul}`);
  console.log(`  noul p=${yes.answers.done.noul.toFixed(2)} model=${yes.model} ${yes.ms} ms`);

  const tri = await ask(ws, { title: "Checkout page returns 500 for every customer", description: "Since the last deploy nobody can pay. Production is down for payments." }, {
    priority: score("How urgent is this issue?", ["Low", "Medium", "High", "Urgent: production is down"]),
    kind: choice("What kind of issue is this?", { bug: "Something is broken", feature: "A new capability", chore: "Maintenance" }),
  }, { cacheMs: 0 });
  assert.ok(tri, "Jev answered the triage questions");
  assert.equal(tri.answers.kind.choice, "bug");
  assert.ok(tri.answers.priority.score >= 2, `priority level ${tri.answers.priority.score}`);
  console.log(`  triage kind=${tri.answers.kind.choice} (${tri.answers.kind.confidence.toFixed(2)}) priority=${tri.answers.priority.score} ${tri.ms} ms`);

  const reaction = { id: "r-live", name: "", on: true, when: { type: "projects" }, if: { kind: "ask", question: "Is the work finished?", fields: ["Title", "Status", "Assignee"], auto: 0.9, suggest: 0.6 }, then: [] } as unknown as Reaction;
  const v = await judge(ws, reaction, { key: "issue:live", facts: { Title: "Publish the release notes", Status: "Done", Assignee: "Test Person" }, personal: ["Assignee"] });
  assert.equal(v?.source, "jev");
  console.log(`  reaction mode=${v?.mode} p=${v?.confidence?.toFixed(2)}`);

  setJev(ws, false, owner);
  assert.equal(await ask(ws, { status: "Done" }, { done: noul("Is the task finished?") }, { cacheMs: 0 }), null, "off: nothing sent");
  resetJev();
});
