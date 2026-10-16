import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ask, noul, resetSmart, setWorkspaceGate, smartBudget } from "@/lib/decide/smart";

// The spending budget: a day's questions in all and per workspace, and the size of one request.

test("smart: over the daily budget nothing is sent; another workspace has its own share; big states never go out", async () => {
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
  Object.assign(process.env, { ZVENA_AI_KEY: "k", ZVENA_AI_URL: url, ZVENA_AI_WS_DAILY_QUESTIONS: "3", ZVENA_AI_DAILY_QUESTIONS: "5", ZVENA_AI_MAX_BYTES: "2000" });
  try {
    const q = (i: number) => ({ yes: noul(`question ${i}`) });
    for (let i = 0; i < 3; i++) assert.ok(await ask("ws-a", { i }, q(i), { cacheMs: 0 }), `call ${i} within the workspace's share`);
    assert.equal(await ask("ws-a", { i: 9 }, q(9), { cacheMs: 0 }), null, "the workspace's share is spent");
    assert.equal(calls, 3, "and nothing went out for it");
    assert.ok(await ask("ws-b", { i: 1 }, q(1), { cacheMs: 0 }));
    assert.ok(await ask("ws-b", { i: 2 }, q(2), { cacheMs: 0 }));
    assert.equal(await ask("ws-c", { i: 3 }, q(3), { cacheMs: 0 }), null, "the whole server's budget is spent");
    assert.equal(smartBudget().used, 5);
    resetSmart();
    assert.equal(await ask("ws-d", { text: "x".repeat(5000) }, q(1), { cacheMs: 0 }), null, "a state over ZVENA_AI_MAX_BYTES is never sent");
    assert.equal(calls, 5);
  } finally {
    resetSmart();
    setWorkspaceGate(null);
    for (const k of ["ZVENA_AI_KEY", "ZVENA_AI_URL", "ZVENA_AI_WS_DAILY_QUESTIONS", "ZVENA_AI_DAILY_QUESTIONS", "ZVENA_AI_MAX_BYTES"]) delete process.env[k];
    await new Promise((r) => srv.close(() => r(null)));
  }
});
