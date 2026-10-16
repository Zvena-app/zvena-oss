import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { ask, choice, smartAvailable, smartStats, noul, resetSmart, score } from "@/lib/decide/smart";
import { cleanReaction, compare, type Reaction } from "@/lib/decide/model";
import { decisionsOf, fire, metricsOf, newIngestToken, putMetric, resolveDecision, saveReaction, setSmart, settingsOf, startReactions, wsOfIngestToken } from "@/lib/decide/engine";
import { subjectsFor } from "@/lib/decide/adapters";
import { pushNotes } from "@/lib/notes/server-store";
import { sanitizeNote } from "@/lib/notes/model";
import type { Note } from "@/lib/notes/types";
import { emit, listen, listenAll, type PulseEvent } from "@/lib/pulse/bus";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
/** Waits until `ok()` holds (or gives up after `ms`): event delivery is async, and a cold start can be slow. */
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); !ok() && Date.now() - t0 < ms; ) await tick(5);
}

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: name, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

const anna = person("anna-pulse");
let spaces = 0;
/** A team workspace of its own (a person may own only a few). */
function space(name: string): string {
  const owner = person(`pulse-owner-${++spaces}`);
  const ws = createWorkspace(owner, name).id;
  // Anna writes the rules: they read and change Documents as her, so she is an editor there.
  assert.ok(acceptInvite(anna, createInvite(owner, ws, "editor").token));
  return ws;
}

/** A Documents database "Цели" with a status property and one goal row. */
function goals(ws: string, prefix: string): { db: string; row: string } {
  const now = Date.now();
  const db = sanitizeNote({
    id: `${prefix}db0001`,
    kind: "database",
    title: "Цели",
    parentId: null,
    db: {
      properties: [
        { id: "title", name: "Цель", type: "title" },
        {
          id: "st",
          name: "Статус",
          type: "status",
          options: [
            { id: "todo", name: "Не начато", color: "default", group: "todo" },
            { id: "doing", name: "В работе", color: "blue", group: "doing" },
            { id: "done", name: "Готово", color: "green", group: "done" },
          ],
        },
        { id: "pr", name: "Прогресс", type: "number" },
        { id: "nt", name: "Заметка", type: "text" },
      ],
      views: [],
    },
    createdAt: now,
    updatedAt: now,
  }) as Note;
  const row = sanitizeNote({ id: `${prefix}row001`, kind: "page", parentId: db.id, title: "1 млн выручки", props: { st: "doing", pr: 40, nt: "" }, createdAt: now, updatedAt: now }) as Note;
  assert.ok(db?.db && row);
  pushNotes(ws, [{ id: db.id, note: db }, { id: row.id, note: row }], { by: anna, quotaLeft: Infinity });
  return { db: db.id, row: row.id };
}

function rowStatus(ws: string, id: string): unknown {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, id) as { json: string };
  return (JSON.parse(r.json) as Note).props?.st;
}

test("pulse: an event reaches its workspace's listeners and nobody else's", async () => {
  const got: PulseEvent[] = [];
  const other: PulseEvent[] = [];
  const all: PulseEvent[] = [];
  const off1 = listen("wsAAAAAAAA", (e) => got.push(e));
  const off2 = listen("wsBBBBBBBB", (e) => other.push(e));
  const off3 = listenAll((e) => all.push(e));
  const e = emit("wsAAAAAAAA", { type: "notes", ref: "n1", origin: "tab-abcdefgh" });
  assert.equal(got.length, 0, "listeners run on a later tick, never inside the writing request");
  await until(() => got.length > 0 && all.some((x) => x.id === e.id));
  assert.deepEqual(got.map((x) => x.id), [e.id]);
  assert.equal(other.length, 0);
  assert.ok(all.some((x) => x.id === e.id));
  off1();
  off2();
  off3();
  emit("wsAAAAAAAA", { type: "notes" });
  await tick();
  assert.equal(got.length, 1, "unsubscribed");
});

test("pulse: saving notes pokes the workspace, with the writer's tab as origin", async () => {
  const ws = space("Пульс");
  const got: PulseEvent[] = [];
  const off = listen(ws, (e) => got.push(e));
  const n = sanitizeNote({ id: "pulseNote01", kind: "page", title: "x" }) as Note;
  pushNotes(ws, [{ id: n.id, note: n }], { by: anna, quotaLeft: Infinity, origin: "tab-12345678" });
  pushNotes(ws, [{ id: "pulseNote01", deleted: true }, { id: "pulseNote02", note: { ...n, id: "pulseNote02" } }], { by: anna, quotaLeft: Infinity });
  await until(() => got.length >= 2);
  off();
  assert.equal(got.length, 2);
  assert.deepEqual([got[0].type, got[0].ref, got[0].origin, got[0].by], ["notes", "pulseNote01", "tab-12345678", anna]);
  assert.deepEqual(got[1].refs, ["pulseNote01", "pulseNote02"]);
  assert.ok(!JSON.stringify(got).includes('"title"'), "a poke carries ids, never content");
});

test("reactions: untrusted input is cleaned or refused", () => {
  assert.equal(cleanReaction(null), null);
  assert.equal(cleanReaction({ id: "r1", when: { type: "metric", key: "x" }, then: [] }), null, "id too short, nothing to do");
  assert.equal(cleanReaction({ id: "react1", when: { type: "metric", key: "rev" }, if: { kind: "always" }, then: [{ do: "notes.done", note: "$row" }] }), null, "$row needs a row");
  assert.equal(cleanReaction({ id: "react1", when: { type: "notes", db: "../../x" }, then: [{ do: "notes.done", note: "$row" }] }), null);
  const r = cleanReaction({
    id: "react1",
    name: " Цель ",
    when: { type: "metric", key: "выручка" },
    if: { kind: "ask", question: "Достигнута ли цель?", fields: ["value", 5, "@body"], auto: 7, suggest: 0.95 },
    then: [{ do: "notes.set", note: "abcdef12", prop: "Статус", value: "Готово" }, { do: "rm -rf", note: "abcdef12" }],
  });
  assert.ok(r);
  assert.equal(r.name, "Цель");
  assert.deepEqual(r.if, { kind: "ask", question: "Достигнута ли цель?", fields: ["value", "@body"], auto: 1, suggest: 0.95 });
  assert.equal(r.then.length, 1);
});

test("reactions: comparisons read numbers and text the way people type them", () => {
  assert.equal(compare(1_000_000, ">=", 1_000_000), true);
  assert.equal(compare("1 200 000,5", ">", 1_000_000), true);
  assert.equal(compare("много", ">", 1), false);
  assert.equal(compare(null, ">=", 0), false);
  assert.equal(compare("Готово", "=", "готово"), true);
  assert.equal(compare(["Срочно", "Баг"], "=", "баг"), true);
  assert.equal(compare(["Срочно"], "!=", "баг"), true);
  assert.equal(compare(true, "=", true), true);
});

test("when the chart reaches the target, the goal in Documents is marked done — once, and every tab hears it", async () => {
  startReactions();
  const ws = space("Цели");
  const { db, row } = goals(ws, "g1");
  const r = saveReaction(
    ws,
    { id: "react-goal-1", name: "Выручка → цель", when: { type: "metric", key: "revenue" }, if: { kind: "compare", field: "value", op: ">=", value: 1_000_000 }, then: [{ do: "notes.done", note: row }] },
    anna
  ) as Reaction;
  assert.equal(r.id, "react-goal-1");
  const heard: PulseEvent[] = [];
  const off = listen(ws, (e) => heard.push(e));

  putMetric(ws, "revenue", 900_000, "Выручка", "ingest");
  await tick(30);
  assert.equal(rowStatus(ws, row), "doing", "below the target nothing happens");

  const t0 = Date.now();
  putMetric(ws, "revenue", 1_200_000, null, "ingest");
  // Delivery is async: under a parallel run the poke may land a little later than the write.
  await until(() => rowStatus(ws, row) === "done" && heard.some((e) => e.type === "notes" && e.ref === row));
  assert.equal(rowStatus(ws, row), "done");
  await until(() => heard.some((e) => e.type === "notes" && e.ref === row));
  const notesPoke = heard.find((e) => e.type === "notes" && e.ref === row);
  assert.ok(notesPoke, "open tabs are poked to pull the goal");
  assert.equal(notesPoke.by, "rule:react-goal-1");
  assert.ok(notesPoke.at - t0 < 50, `the goal changed within ${notesPoke.at - t0} ms of the number`);
  assert.ok(heard.some((e) => e.type === "decision" && e.data?.mode === "auto"));
  assert.equal(metricsOf(ws).find((m) => m.key === "revenue")?.label, "Выручка", "a later value keeps the label");

  // Still above the target: no new decision (the edge already fired).
  putMetric(ws, "revenue", 1_300_000, null, "ingest");
  await tick(30);
  assert.equal(decisionsOf(ws).length, 1);
  assert.equal(decisionsOf(ws)[0].status, "applied");

  // Dropping below and crossing again judges again; the goal is already done.
  putMetric(ws, "revenue", 10, null, "ingest");
  await tick(30);
  putMetric(ws, "revenue", 2_000_000, null, "ingest");
  await tick(30);
  assert.deepEqual(decisionsOf(ws).map((d) => d.status), ["unchanged", "applied"]);
  off();
  assert.ok(db);
});

test("a row reaction marks its own row, by a property set by hand, without looping", async () => {
  startReactions();
  const ws = space("Строки");
  const { db, row } = goals(ws, "g2");
  saveReaction(ws, { id: "react-row-1", when: { type: "notes", db }, if: { kind: "compare", field: "Прогресс", op: ">=", value: 100 }, then: [{ do: "notes.set", note: "$row", prop: "статус", value: "готово" }] }, anna);
  const r = JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, row) as { json: string }).json) as Note;
  pushNotes(ws, [{ id: row, note: { ...r, props: { ...r.props, pr: 100 }, updatedAt: Date.now() } }], { by: anna, quotaLeft: Infinity });
  await tick(50);
  assert.equal(rowStatus(ws, row), "done");
  assert.equal(decisionsOf(ws).length, 1, "its own write does not fire it again");
});

test("an ingest secret is shown once, stored hashed, and replaced by the next one", () => {
  const ws = space("Секрет");
  const t1 = newIngestToken(ws, anna);
  assert.equal(wsOfIngestToken(t1), ws);
  assert.equal(sql("SELECT COUNT(*) AS n FROM dz_settings WHERE ingest_hash = ?").get(t1)?.n, 0, "the secret itself is never stored");
  const t2 = newIngestToken(ws, anna);
  assert.equal(wsOfIngestToken(t1), null);
  assert.equal(wsOfIngestToken(t2), ws);
  assert.equal(wsOfIngestToken("zvi_short"), null);
});

// ---------------------------------------------------------------- the decision model

interface Mock {
  url: string;
  bodies: Record<string, unknown>[];
  reply: (body: Record<string, unknown>, res: ServerResponse) => void;
  close: () => Promise<void>;
}

async function modelMock(): Promise<Mock> {
  const m: Mock = { url: "", bodies: [], reply: () => {}, close: async () => {} };
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer test-key");
      const body = JSON.parse(raw) as Record<string, unknown>;
      m.bodies.push(body);
      m.reply(body, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  m.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/systemone`;
  m.close = () => new Promise((r) => srv.close(() => r()));
  return m;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// No settings row: the default switch (on) applies.
const MODEL_WS = "ws-model-unit";

test("decision model: off without both a URL and a key; typed answers, cache, retry, malformed answers and timeouts fail safe", async () => {
  resetSmart();
  delete process.env.ZVENA_AI_KEY;
  delete process.env.ZVENA_AI_URL;
  assert.equal(await ask(MODEL_WS, { a: 1 }, { q: noul("?") }), null);
  assert.equal(smartAvailable(), false);
  // A key alone is not enough: no endpoint is built in.
  process.env.ZVENA_AI_KEY = "test-key";
  assert.equal(smartAvailable(), false, "no URL: off");
  assert.equal(await ask(MODEL_WS, { a: 1 }, { q: noul("?") }), null);

  const m = await modelMock();
  Object.assign(process.env, { ZVENA_AI_KEY: "test-key", ZVENA_AI_URL: m.url, ZVENA_AI_TIMEOUT_MS: "800" });
  try {
    let calls = 0;
    m.reply = (body, res) => {
      calls++;
      if (calls === 1) return send(res, 529, { error: "overloaded" });
      const qs = body.questions as Record<string, { type: string }>;
      assert.equal(body.model, undefined, "no ZVENA_AI_MODEL: the request names no model");
      assert.deepEqual(Object.keys(qs), ["done", "kind", "size"]);
      send(res, 200, {
        model: "model-1.13.0",
        answers: {
          done: { type: "noul", noul: 0.97 },
          kind: { type: "choice", choice: "bug", probabilities: { bug: 0.9, feature: 0.1 }, confidence: 0.88 },
          size: { type: "score", score: 1.8, legend: { "0": "s", "1": "m", "2": "l" }, probabilities: { "0": 0, "1": 0.2, "2": 0.8 }, confidence: 0.8 },
        },
        usage: { input_tokens: 42, output_tokens: 3 },
      });
    };
    const qs = { done: noul("Is `ticket` done?"), kind: choice("What is `ticket`?", { bug: null, feature: "A new thing" }), size: score("How big?", ["s", "m", "l"]) };
    const out = await ask(MODEL_WS, { ticket: "Fixed the export" }, qs);
    assert.ok(out);
    assert.equal(out.answers.done.noul, 0.97);
    assert.equal(out.answers.kind.choice, "bug");
    assert.equal(out.answers.size.score, 1.8);
    assert.equal(out.model, "model-1.13.0");
    assert.equal(calls, 2, "529 is retried within the time budget");
    const again = await ask(MODEL_WS, { ticket: "Fixed the export" }, qs);
    assert.equal(again?.cached, true);
    assert.equal(calls, 2, "an identical question is answered from the cache");

    m.reply = (_b, res) => send(res, 200, { answers: { q: { type: "choice", choice: "rm -rf" } } });
    assert.equal(await ask(MODEL_WS, { x: 1 }, { q: choice("?", { a: null }) }), null, "an option that was not offered is refused");

    m.reply = () => {};
    const t0 = Date.now();
    assert.equal(await ask(MODEL_WS, { x: 2 }, { q: noul("?") }, { timeoutMs: 200 }), null);
    assert.ok(Date.now() - t0 < 400, "a hung API costs at most the budget");

    resetSmart();
    m.reply = (_b, res) => send(res, 500, {});
    for (let i = 0; i < 5; i++) await ask(MODEL_WS, { i }, { q: noul("?") });
    assert.equal(smartStats().breakerOpen, true, "five failures in a row open the breaker");
    const before = m.bodies.length;
    assert.equal(await ask(MODEL_WS, { i: 99 }, { q: noul("?") }), null);
    assert.equal(m.bodies.length, before, "an open breaker does not call at all");
  } finally {
    resetSmart();
    delete process.env.ZVENA_AI_KEY;
    await m.close();
  }
});

test("decision model in a reaction: on by default, the owner can turn it off; only the chosen fields; sure → done, unsure → a person confirms", async () => {
  resetSmart();
  const m = await modelMock();
  Object.assign(process.env, { ZVENA_AI_KEY: "test-key", ZVENA_AI_URL: m.url, ZVENA_AI_TIMEOUT_MS: "800" });
  try {
    const ws = space("Smart");
    const { db, row } = goals(ws, "g3");
    const r = saveReaction(
      ws,
      { id: "react-ask-1", when: { type: "notes", db }, if: { kind: "ask", question: "Does `Заметка` say the goal is reached?", fields: ["Заметка"], auto: 0.9, suggest: 0.6 }, then: [{ do: "notes.done", note: "$row" }] },
      anna
    ) as Reaction;
    let p = 0.7;
    m.reply = (_b, res) => send(res, 200, { model: "model-1.13.0", answers: { yes: { type: "noul", noul: p } }, usage: {} });
    const subject = () => subjectsFor(ws, r.when, { id: 0, ws, type: "notes", ref: row, at: Date.now() }, r.id)[0];
    const base = JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, row) as { json: string }).json) as Note;
    pushNotes(ws, [{ id: row, note: { ...base, props: { ...base.props, nt: "Вышли на миллион в сентябре" }, updatedAt: Date.now() } }], { by: anna, quotaLeft: Infinity });

    assert.equal(settingsOf(ws).smart, true, "on in every workspace by default");
    setSmart(ws, false, anna);
    assert.equal(await fire(ws, r, subject(), 0), "skip", "the owner turned it off");
    assert.equal(m.bodies.length, 0, "nothing was sent");

    setSmart(ws, true, anna);
    assert.equal(await fire(ws, r, subject(), 0), "pending");
    assert.deepEqual(m.bodies[0].state, { Заметка: "Вышли на миллион в сентябре" }, "only the chosen field leaves the server");
    assert.equal(rowStatus(ws, row), "doing", "unsure: a person decides");
    const pending = decisionsOf(ws)[0];
    assert.equal(pending.status, "pending");
    assert.equal(pending.confidence, 0.7);
    assert.equal(resolveDecision(ws, pending.id, true, anna), "applied");
    assert.equal(rowStatus(ws, row), "done");
    assert.equal(resolveDecision(ws, pending.id, true, anna), "gone", "a suggestion is used once");

    // Sure: done at once (after the edge resets).
    sql("DELETE FROM dz_edges WHERE reaction_id = ?").run(r.id);
    const now = JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, row) as { json: string }).json) as Note;
    pushNotes(ws, [{ id: row, note: { ...now, props: { ...now.props, st: "doing", nt: "Миллион есть!" }, updatedAt: Date.now() } }], { by: anna, quotaLeft: Infinity });
    p = 0.96;
    assert.equal(await fire(ws, r, subject(), 0), "applied");
    assert.equal(rowStatus(ws, row), "done");
    assert.equal(decisionsOf(ws)[0].source, "model");
    assert.equal(decisionsOf(ws)[0].model, "model-1.13.0");
  } finally {
    resetSmart();
    delete process.env.ZVENA_AI_KEY;
    await m.close();
  }
});

test("design events: Design's backend reports a file change, the team's workspace hears it, throttled per file", async () => {
  const { POST } = await import("@/app/api/internal/design-events/route");
  process.env.ZVENA_INTERNAL_KEY = "k".repeat(40);
  const ws = space("Дизайн");
  const team = "0b6c3f7e-1111-4a2b-9c3d-123456789abc";
  const file = "9a8b7c6d-2222-4e5f-8a9b-abcdefabcdef";
  sql("UPDATE workspaces SET penpot_team_id = ? WHERE id = ?").run(team, ws);
  const heard: PulseEvent[] = [];
  const off = listen(ws, (e) => heard.push(e));
  const post = (key: string, events: unknown[]) =>
    POST(new Request("http://x/api/internal/design-events", { method: "POST", headers: { "x-zvena-key": key, "content-type": "application/json" }, body: JSON.stringify({ events }) }));
  assert.equal((await post("wrong", [{ team, file }])).status, 403);
  const login = `u-${"a".repeat(24)}@users.zvena.invalid`;
  const res = await post("k".repeat(40), [{ team, file, name: "update-file", login }, { team, file, name: "update-file" }, { team: "not-a-uuid", file }]);
  assert.deepEqual(await res.json(), { delivered: 2 });
  await tick(20);
  assert.equal(heard.length, 1, "a burst is one poke now…");
  assert.deepEqual([heard[0].type, heard[0].ref, heard[0].by, heard[0].data?.event], ["design", file, "a".repeat(24), "update-file"]);
  await tick(350);
  assert.equal(heard.length, 2, "…and the last change of the burst a moment later");
  off();
  delete process.env.ZVENA_INTERNAL_KEY;
});

test("design events: a comment saved with the file is announced on its own, not folded into the edit", async () => {
  const { POST } = await import("@/app/api/internal/design-events/route");
  process.env.ZVENA_INTERNAL_KEY = "k".repeat(40);
  const ws = space("Комментарии");
  const team = "1b6c3f7e-1111-4a2b-9c3d-123456789abc";
  const file = "8a8b7c6d-2222-4e5f-8a9b-abcdefabcdef";
  sql("UPDATE workspaces SET penpot_team_id = ? WHERE id = ?").run(team, ws);
  const heard: PulseEvent[] = [];
  const off = listen(ws, (e) => heard.push(e));
  const res = await POST(new Request("http://x/api/internal/design-events", { method: "POST", headers: { "x-zvena-key": "k".repeat(40), "content-type": "application/json" }, body: JSON.stringify({ events: [{ team, file, name: "create-comment-thread" }, { team, file, name: "update-file" }] }) }));
  assert.equal(res.status, 200);
  await until(() => heard.length >= 2);
  assert.deepEqual(heard.map((e) => e.data?.event).sort(), ["create-comment-thread", "update-file"]);
  off();
  delete process.env.ZVENA_INTERNAL_KEY;
});

test("pulse: a big write is announced in full, split into events of at most 50 ids", async () => {
  const { REFS_PER_EVENT } = await import("@/lib/pulse/bus");
  const heard: PulseEvent[] = [];
  const off = listen("wsSPLIT0001", (e) => heard.push(e));
  const ids = Array.from({ length: 120 }, (_, i) => `note${String(i).padStart(4, "0")}`);
  emit("wsSPLIT0001", { type: "notes", refs: ids, by: "u" });
  await until(() => heard.length >= 3);
  off();
  assert.equal(heard.length, 3);
  assert.ok(heard.every((e) => (e.refs?.length ?? 0) <= REFS_PER_EVENT));
  assert.deepEqual(heard.flatMap((e) => e.refs ?? []), ids, "no id is lost");
});

test("pulse: products hide events from people who may not see them; a broken filter hides too", async () => {
  const { registerPulseFilter, visibleTo } = await import("@/lib/pulse/bus");
  const e: PulseEvent = { id: 1, ws: "wsFILTER001", type: "projects", ref: "secret", at: Date.now() };
  assert.equal(visibleTo("anna", e), true, "no filter: everyone in the workspace");
  const off1 = registerPulseFilter("projects", (user, ev) => !(ev.ref === "secret" && user !== "anna"));
  assert.equal(visibleTo("anna", e), true);
  assert.equal(visibleTo("boris", e), false);
  assert.equal(visibleTo("boris", { ...e, type: "notes" }), true, "a filter applies to its type only");
  const off2 = registerPulseFilter("projects", () => {
    throw new Error("boom");
  });
  assert.equal(visibleTo("anna", e), false, "a filter that fails hides the event");
  off1();
  off2();
  assert.equal(visibleTo("boris", e), true);
});
