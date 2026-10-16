import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ask, noul, resetSmart, setWorkspaceGate, smartBudget } from "@/lib/decide/smart";
import { sql } from "@/lib/store";

// The spending budget lives in the database: a restart does not hand out a new day, parallel
// calls never go over it, a retry and a cache hit are not charged twice, and the provider's
// answer is read with a size cap.

const ENV = ["ZVENA_AI_KEY", "ZVENA_AI_URL", "ZVENA_AI_WS_DAILY_QUESTIONS", "ZVENA_AI_DAILY_QUESTIONS", "ZVENA_AI_MAX_RESPONSE_BYTES", "ZVENA_AI_TIMEOUT_MS"];
const realFetch = globalThis.fetch;
const ok = (questions: Record<string, unknown>) =>
  new Response(JSON.stringify({ model: "m", answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function withStub(env: Record<string, string>, stub: (init: RequestInit, n: number) => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  resetSmart();
  setWorkspaceGate(() => true);
  Object.assign(process.env, { ZVENA_AI_KEY: "k", ZVENA_AI_URL: "http://model.invalid/v1", ...env });
  let n = 0;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => stub(init ?? {}, ++n)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    resetSmart();
    setWorkspaceGate(null);
    for (const k of ENV) delete process.env[k];
  }
}
const q = (i: number) => ({ yes: noul(`question ${i}`) });
const qsOf = (init: RequestInit) => (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions;

test("smart budget: a restart keeps today's spending (it is in the database)", async () => {
  let calls = 0;
  await withStub({ ZVENA_AI_WS_DAILY_QUESTIONS: "3" }, async (init) => (calls++, ok(qsOf(init))), async () => {
    assert.ok(await ask("ws-r", { i: 1 }, q(1), { cacheMs: 0 }));
    assert.ok(await ask("ws-r", { i: 2 }, q(2), { cacheMs: 0 }));
    // What a restart forgets: everything in memory.
    resetSmart({ budget: false });
    assert.equal(smartBudget().used, 2, "the counter survived");
    const row = sql("SELECT used FROM smart_budget WHERE day = ? AND ws = ?").get(smartBudget().day, "ws-r") as { used: number };
    assert.equal(row.used, 2);
    assert.ok(await ask("ws-r", { i: 3 }, q(3), { cacheMs: 0 }));
    assert.equal(await ask("ws-r", { i: 4 }, q(4), { cacheMs: 0 }), null, "the day's share is spent, restart or not");
    assert.equal(calls, 3);
  });
});

test("smart budget: many calls at once never go over the limit", async () => {
  let calls = 0;
  await withStub(
    { ZVENA_AI_WS_DAILY_QUESTIONS: "100", ZVENA_AI_DAILY_QUESTIONS: "7" },
    async (init) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return ok(qsOf(init));
    },
    async () => {
      const out = await Promise.all(Array.from({ length: 50 }, (_, i) => ask(`ws-c${i % 4}`, { i }, q(i), { cacheMs: 0 })));
      assert.equal(out.filter(Boolean).length, 7);
      assert.equal(calls, 7, "nothing went out past the budget");
      assert.equal(smartBudget().used, 7);
    }
  );
});

test("smart budget: a retry after 429 is the same question, charged once", async () => {
  await withStub(
    {},
    async (init, n) => (n === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "0" } }) : ok(qsOf(init))),
    async () => {
      const out = await ask("ws-t", { x: 1 }, { a: noul("a?"), b: noul("b?") }, { cacheMs: 0, timeoutMs: 3000 });
      assert.ok(out, "answered on the second try");
      assert.equal(smartBudget().used, 2, "two questions, one charge — not one per HTTP attempt");
    }
  );
});

test("smart budget: a cache hit is free; exhaustion returns null and takes nothing; a failed request stays charged", async () => {
  let calls = 0;
  let fail = false;
  await withStub(
    { ZVENA_AI_WS_DAILY_QUESTIONS: "2" },
    async (init) => {
      calls++;
      if (fail) throw new TypeError("network down");
      return ok(qsOf(init));
    },
    async () => {
      assert.ok(await ask("ws-h", { same: 1 }, q(1)));
      const again = await ask("ws-h", { same: 1 }, q(1));
      assert.ok(again?.cached, "from the cache");
      assert.equal(smartBudget().used, 1, "the cache hit was not charged");
      assert.equal(calls, 1);
      assert.ok(await ask("ws-h", { same: 2 }, q(2)));
      assert.equal(smartBudget().used, 2);
      assert.equal(await ask("ws-h", { same: 3 }, q(3)), null, "over the share");
      assert.equal(smartBudget().used, 2, "nothing taken by a refused call");
      assert.equal(calls, 2, "and nothing sent");
      // A request that went out and failed stays charged (it may have been billed).
      fail = true;
      assert.equal(await ask("ws-f", { same: 4 }, q(4)), null);
      assert.equal(smartBudget().used, 3);
    }
  );
});

test("smart budget: days older than a week are pruned", async () => {
  await withStub({}, async (init) => ok(qsOf(init)), async () => {
    assert.ok(await ask("ws-p", { i: 1 }, q(1), { cacheMs: 0 }));
    sql("INSERT INTO smart_budget (day, ws, used) VALUES ('2020-01-01', 'ws-p', 50)").run();
    resetSmart({ budget: false });
    assert.equal(smartBudget().used, 1);
    assert.equal(sql("SELECT COUNT(*) AS n FROM smart_budget WHERE day = '2020-01-01'").get()?.n, 0);
  });
});

test("smart: an answer bigger than ZVENA_AI_MAX_RESPONSE_BYTES is dropped, whatever its Content-Length says", async () => {
  let pulls = 0;
  let canceled = false;
  const endless = (headers: Record<string, string>) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++;
          c.enqueue(new TextEncoder().encode(`{"pad":"${"x".repeat(4000)}",`));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json", ...headers } }
    );
  let mode: "small" | "big" | "lying" | "chunked" | "declared" = "small";
  await withStub(
    { ZVENA_AI_MAX_RESPONSE_BYTES: "10000" },
    async (init) => {
      const qs = qsOf(init);
      if (mode === "small") return ok(qs);
      if (mode === "big") {
        const body = JSON.stringify({ model: "m", answers: Object.fromEntries(Object.keys(qs).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: {}, pad: "x".repeat(20_000) });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (mode === "lying") return endless({ "content-length": "20" });
      if (mode === "chunked") return endless({});
      return endless({ "content-length": "50000" });
    },
    async () => {
      assert.ok(await ask("ws-b", { i: 1 }, q(1), { cacheMs: 0 }), "a normal answer passes");
      mode = "big";
      assert.equal(await ask("ws-b", { i: 2 }, q(2), { cacheMs: 0 }), null, "a valid but oversized answer is dropped");
      mode = "lying";
      assert.equal(await ask("ws-b", { i: 3 }, q(3), { cacheMs: 0 }), null, "a lying Content-Length does not help");
      assert.ok(canceled, "the stream was cut off");
      assert.ok(pulls <= 5, `read no further than the cap (${pulls} chunks)`);
      mode = "chunked";
      canceled = false;
      pulls = 0;
      assert.equal(await ask("ws-b", { i: 4 }, q(4), { cacheMs: 0 }), null, "no Content-Length at all");
      assert.ok(canceled && pulls <= 5);
      mode = "declared";
      canceled = false;
      pulls = 0;
      assert.equal(await ask("ws-b", { i: 5 }, q(5), { cacheMs: 0 }), null, "too big by its own Content-Length");
      assert.ok(canceled, "and never read");
    }
  );
});
