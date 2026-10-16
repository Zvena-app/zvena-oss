import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { setSmart } from "@/lib/decide/engine";
import { resetSmart } from "@/lib/decide/smart";
import { smartState, triageSmart } from "@/lib/projects/assist-smart";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, getIssueBrief } from "@/lib/projects/issues";
import { createLabel, createTeam, listLabels } from "@/lib/projects/teams";
import { createWorkspace } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `pjj-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Ada");
const ws = createWorkspace(owner, "Smart").id;
const ctx = ctxFor(owner, ws, "edit");
const team = createTeam(ctx, { name: "Core", key: "CORE" }, "en");
const perf = createLabel(ctx, { name: "Performance", teamId: team.id, description: "Slow pages, timeouts" });

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("triage asks the decision model unless the owner turned it off (on by default); low confidence or nonsense falls back to the rules; nothing changes", async () => {
  const bodies: Record<string, unknown>[] = [];
  let reply: (body: Record<string, unknown>, res: ServerResponse) => void = () => {};
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      reply(body, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/systemone`;
  const input = { title: "Search page times out for big teams", description: "Since Monday the **search** takes 30 s. @[Ada]", teamId: team.id };
  const issue = createIssue(ctx, { teamId: team.id, title: input.title, description: input.description });
  try {
    resetSmart();
    delete process.env.ZVENA_AI_KEY;
    assert.equal(smartState(ws), "unconfigured");
    assert.equal((await triageSmart(ctx, input)).source, "rules");

    Object.assign(process.env, { ZVENA_AI_KEY: "test-key", ZVENA_AI_URL: url, ZVENA_AI_TIMEOUT_MS: "800" });
    assert.equal(smartState(ws), "on", "on by default once the model is configured");
    setSmart(ws, false, owner);
    assert.equal(smartState(ws), "off");
    const off = await triageSmart(ctx, input);
    assert.equal(off.source, "rules");
    assert.equal(bodies.length, 0, "the model is not asked while the owner has it off");
    assert.equal(off.priority, 2, "the rules read a timeout as high");
    const bug = listLabels(ctx).find((l) => l.name === "Bug");
    assert.ok(bug && off.labels.some((l) => l.id === bug.id), "…and as a bug");
    const add = await triageSmart(ctx, { title: "Add Apple Pay", description: "", teamId: team.id });
    const feature = listLabels(ctx).find((l) => l.name === "Feature");
    assert.ok(feature && add.labels.some((l) => l.id === feature.id), "“Add …” reads as a feature");

    setSmart(ws, true, owner);
    assert.equal(smartState(ws), "on");
    reply = (body, res) => {
      const qs = body.questions as Record<string, { type: string; criteria: unknown }>;
      assert.deepEqual(Object.keys(qs).sort(), ["label", "priority"]);
      send(res, 200, {
        model: "model-1.13.0",
        answers: {
          priority: { type: "score", score: 2, legend: {}, probabilities: { "0": 0.02, "1": 0.08, "2": 0.82, "3": 0.08 }, confidence: 0.82 },
          label: { type: "choice", choice: perf.id, probabilities: { none: 0.1, [perf.id]: 0.9 }, confidence: 0.9 },
        },
        usage: { input_tokens: 40, output_tokens: 2 },
      });
    };
    const on = await triageSmart(ctx, input);
    assert.equal(on.source, "model");
    assert.equal(on.priority, 2, "score level 2 of low→urgent is High");
    assert.equal(on.labels[0]?.id, perf.id);
    assert.ok(!("model" in on), "which model answered stays on the server");
    assert.ok((on.confidence ?? 0) >= 0.8);
    const sent = bodies[0];
    const state = sent.state as Record<string, unknown>;
    assert.deepEqual(Object.keys(state).sort(), ["description", "title"], "only the title and the description's text leave");
    assert.ok(!JSON.stringify(sent).includes(owner), "no person ids are sent");
    assert.ok(!String(state.description).includes("**"), "the description goes as plain text");

    reply = (_b, res) =>
      send(res, 200, {
        model: "model-1.13.0",
        answers: {
          priority: { type: "score", score: 1, legend: {}, probabilities: { "0": 0.3, "1": 0.35, "2": 0.2, "3": 0.15 }, confidence: 0.35 },
          label: { type: "choice", choice: "none", probabilities: { none: 0.5, [perf.id]: 0.5 }, confidence: 0.5 },
        },
      });
    const unsure = await triageSmart(ctx, { ...input, title: `${input.title}!` });
    assert.equal(unsure.source, "rules", "an unsure answer is not presented as one");

    reply = (_b, res) => send(res, 200, { answers: { priority: { type: "score", score: "high" } } });
    assert.equal((await triageSmart(ctx, { ...input, title: `${input.title}?` })).source, "rules", "a malformed answer is refused");

    const after = getIssueBrief(ctx, issue.id);
    assert.equal(after.priority, issue.priority, "triage proposes; it never writes");
    assert.deepEqual(after.labelIds, issue.labelIds);
  } finally {
    resetSmart();
    delete process.env.ZVENA_AI_KEY;
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
