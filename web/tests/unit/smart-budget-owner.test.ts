import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { ask, noul, resetSmart, setWorkspaceGate, smartBudget } from "@/lib/decide/smart";
import { createWorkspace, deleteWorkspace } from "@/lib/workspaces";

// The spending budget per owner: one person's many workspaces share one daily share, so
// they cannot add up to the whole server's budget.

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `sbo-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

test("smart: the workspaces one person owns share one daily share; deleting one does not hand out a new one", async () => {
  let calls = 0;
  const srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "m", answers: { yes: { type: "noul", noul: 0.9 } }, usage: {} }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  resetSmart();
  setWorkspaceGate(() => true);
  const env = { ZVENA_AI_KEY: "k", ZVENA_AI_URL: url, ZVENA_AI_WS_DAILY_QUESTIONS: "2", ZVENA_AI_DAILY_QUESTIONS: "100", ZVENA_AI_DAILY_PER_OWNER: "3" };
  Object.assign(process.env, env);
  try {
    const q = (i: number) => ({ yes: noul(`question ${i}`) });
    const ann = person("Ann");
    const ben = person("Ben");
    const a1 = createWorkspace(ann, "A1").id;
    const a2 = createWorkspace(ann, "A2").id;
    const a3 = createWorkspace(ann, "A3").id;
    const b1 = createWorkspace(ben, "B1").id;
    assert.ok(await ask(a1, { i: 1 }, q(1), { cacheMs: 0 }));
    assert.ok(await ask(a1, { i: 2 }, q(2), { cacheMs: 0 }));
    assert.ok(await ask(a2, { i: 3 }, q(3), { cacheMs: 0 }), "a second workspace of Ann's, within her share");
    assert.equal(await ask(a3, { i: 4 }, q(4), { cacheMs: 0 }), null, "Ann's share is spent, whichever workspace asks");
    assert.equal(calls, 3);
    // Deleting a workspace and making a new one: still Ann's spent share.
    deleteWorkspace(ann, a1);
    const a4 = createWorkspace(ann, "A4").id;
    assert.equal(await ask(a4, { i: 5 }, q(5), { cacheMs: 0 }), null);
    // Ben has his own share; a workspace with no owner on record has only its workspace share.
    assert.ok(await ask(b1, { i: 6 }, q(6), { cacheMs: 0 }));
    assert.ok(await ask("ws-unowned", { i: 7 }, q(7), { cacheMs: 0 }));
    assert.equal(calls, 5);
    assert.equal(smartBudget().used, 5, "a refused call takes nothing");
    // Unset, the owner's share is twice a workspace's.
    delete process.env.ZVENA_AI_DAILY_PER_OWNER;
    assert.equal(smartBudget().perOwner, 4);
  } finally {
    await new Promise((r) => srv.close(() => r(null)));
    resetSmart();
    for (const k of Object.keys(env)) delete process.env[k];
    setWorkspaceGate(null);
  }
});
