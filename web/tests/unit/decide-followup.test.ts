// Follow-ups of the audit in the automations engine: rules read live numbers as their
// author, the model never reads the people a page mentions, the decision log is pruned
// on a schedule, and a goal set by hand settles the proposal still waiting for it.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { subjectsFor } from "@/lib/decide/adapters";
import { decisionsOf, ensureSchema, judge, onEvent, putMetric, reactionsOf, saveReaction } from "@/lib/decide/engine";
import { goalIssueOf, setGoal } from "@/lib/decide/goals";
import { activityOf, recordHub, resolve } from "@/lib/decide/journal";
import type { Reaction } from "@/lib/decide/model";
import { resetSmart } from "@/lib/decide/smart";
import { forgetSeen, saveSource } from "@/lib/decide/sources";
import { runMaintenance } from "@/lib/maintenance";
import { blankNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, getIssueBrief } from "@/lib/projects/issues";
import { createTeam, listStatuses } from "@/lib/projects/teams";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `dfu-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** Ann owns the workspace, Ben is an editor; each has a team issue. */
function setup() {
  const ann = person("Ann");
  const ben = person("Ben");
  const ws = createWorkspace(ann, `Follow-up ${n}`).id;
  assert.ok(acceptInvite(ben, createInvite(ann, ws, "editor").token));
  const team = createTeam(ctxFor(ann, ws, "edit"), { name: "Ops", key: `FU${n}` }, "en");
  return { ann, ben, ws, team: team.id };
}
const done = (ws: string, u: string, issue: string) => listStatuses(ctxFor(u, ws, "read")).find((s) => s.id === getIssueBrief(ctxFor(u, ws, "read"), issue).statusId)?.category === "completed";

test("decide: a rule saved through the API cannot read a colleague's mail number — not when saved, not when it runs", async () => {
  const t = setup();
  // Ann's own mail number (mail is hers alone).
  const mail = saveSource(t.ws, { kind: "mail", view: "inbox", measure: "unread" }, t.ann);
  assert.ok(!("error" in mail), JSON.stringify(mail));
  const bens = createIssue(ctxFor(t.ben, t.ws, "edit"), { teamId: t.team, title: "Tell me when Ann has mail" });
  const spy = (id: string, key: string): Reaction =>
    ({ id, name: "", on: true, when: { type: "metric", key }, if: { kind: "compare", field: "value", op: ">=", value: 0 }, then: [{ do: "issue.done", issue: bens.id }] }) as unknown as Reaction;

  // Saved by Ben (the "save" op of /api/decide): refused, as the Goal panel refuses it.
  assert.deepEqual(saveReaction(t.ws, spy(`dfu-spy-${n}`, mail.key), t.ben), { error: "forbidden" });
  // A number counted from the workspace that does not exist (yet) cannot be aimed at either…
  assert.deepEqual(saveReaction(t.ws, spy(`dfu-none-${n}`, "mail:AAAAAAAAAAAAAAAA"), t.ben), { error: "forbidden" });
  // …while typed numbers stay open to every editor, and Ann may use her own.
  assert.ok(!("error" in saveReaction(t.ws, spy(`dfu-typed-${n}`, `typed${n}`), t.ben)));
  const anns = createIssue(ctxFor(t.ann, t.ws, "edit"), { teamId: t.team, title: "Inbox zero" });
  assert.ok(!("error" in saveReaction(t.ws, { ...spy(`dfu-own-${n}`, mail.key), on: false, then: [{ do: "issue.done", issue: anns.id }] }, t.ann)));
  assert.equal(done(t.ws, t.ben, bens.id), false, "nothing ran on Ann's number for Ben");

  // A rule already there (saved before the fix) runs as its author: Ben reads nothing of Ann's mail.
  const old = spy(`dfu-old-${n}`, mail.key);
  sql("INSERT INTO dz_reactions (id, ws, json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)").run(old.id, t.ws, JSON.stringify(old), t.ben, Date.now());
  saveReaction(t.ws, spy(`dfu-reload-${n}`, `typed-reload${n}`), t.ann); // reloads the cached rules
  forgetSeen();
  const e = { id: 0, ws: t.ws, type: "metric" as const, ref: mail.key, at: Date.now(), data: { value: 3 } };
  assert.deepEqual(subjectsFor(t.ws, old.when, e, old.id), [], "no subject for Ben");
  assert.equal(subjectsFor(t.ws, old.when, e, `dfu-own-${n}`).length, 1, "Ann's own rule reads it");
  putMetric(t.ws, mail.key, 3, null, "source");
  onEvent(e);
  await tick();
  assert.equal(done(t.ws, t.ben, bens.id), false, "the old rule did not fire on Ann's number");
});

test("decide: a rule's question never carries the people a page mentions, nor formulas and relations", async () => {
  const t = setup();
  const db = blankNote({
    kind: "database",
    title: "Launches",
    db: {
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: "own", name: "Owner", type: "person" },
        { id: "sc", name: "Score", type: "formula", formula: { expr: 'prop("Owner")' } },
        { id: "rel", name: "Linked", type: "relation" },
        { id: "txt", name: "Notes", type: "text" },
      ],
      views: [],
    },
  } as never);
  const row = blankNote({
    kind: "page",
    title: "Spring launch",
    parentId: db.id,
    props: { own: [t.ben], sc: "Ben Stone", rel: ["somepage"], txt: "ready for review" },
    content: [{ id: "b1", type: "paragraph", props: {}, content: [{ type: "text", text: "Ping ", styles: {} }, { type: "mention", props: { userId: t.ben, name: "Ben Stone" } }, { type: "text", text: " about the launch", styles: {} }], children: [] }],
  } as never);
  pushNotes(t.ws, [{ id: db.id, note: db }, { id: row.id, note: row }], { by: t.ann, quotaLeft: Infinity, access: { userId: t.ann } });
  const r = { id: `dfu-ask-${n}`, name: "", on: false, when: { type: "notes", db: db.id }, if: { kind: "ask", question: "Is it ready?", fields: ["@body", "Score", "Linked", "Notes", "Owner"], auto: 0.9, suggest: 0.6 }, then: [{ do: "notes.set", note: "$row", prop: "Notes", value: "checked" }] };
  const saved = saveReaction(t.ws, r, t.ann);
  assert.ok(!("error" in saved), JSON.stringify(saved));
  const [s] = subjectsFor(t.ws, saved.when, { id: 0, ws: t.ws, type: "notes", ref: row.id, at: Date.now() }, saved.id);
  assert.ok(s, "the row is a subject of Ann's rule");
  assert.match(String(s.facts["@body"]), /Ben Stone/, "rules may still compare the page's text as written");

  const bodies: { state: Record<string, unknown> }[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "model-test", answers: { yes: { type: "noul", noul: 0.95 } }, usage: {} }));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  Object.assign(process.env, { ZVENA_AI_KEY: "test-key", ZVENA_AI_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/systemone`, ZVENA_AI_TIMEOUT_MS: "800" });
  resetSmart();
  try {
    const v = await judge(t.ws, saved, s);
    assert.equal(v?.source, "model");
    assert.equal(bodies.length, 1);
    const sent = bodies[0].state;
    assert.deepEqual(Object.keys(sent).sort(), ["@body", "Notes"], "no person column, formula or relation");
    assert.equal(sent["@body"], "Ping  about the launch");
    assert.doesNotMatch(JSON.stringify(sent), /Ben Stone/);
  } finally {
    delete process.env.ZVENA_AI_KEY;
    resetSmart();
    await new Promise<void>((ok) => srv.close(() => ok()));
  }
});

test("decide: the decision log is pruned on the schedule (90 days; suggestions expire after 14), rules or not", async () => {
  const t = setup();
  ensureSchema();
  const now = Date.now();
  const day = 86_400_000;
  const put = (id: string, at: number, status: string) =>
    sql("INSERT INTO dz_decisions (id, ws, reaction_id, subject, source, mode, status, actions, at) VALUES (?, ?, NULL, 'issue:x', 'model', 'suggest', ?, NULL, ?)").run(id, t.ws, status, at);
  put(`dfu-old-${n}`, now - 91 * day, "applied");
  put(`dfu-stale-${n}`, now - 15 * day, "pending");
  put(`dfu-new-${n}`, now - day, "pending");
  assert.equal(reactionsOf(t.ws).length, 0, "a workspace without rules");
  const out = await runMaintenance(now);
  assert.ok(out.decisionsPruned >= 1);
  const left = new Map(decisionsOf(t.ws, 50).map((d) => [d.id, d.status]));
  assert.equal(left.has(`dfu-old-${n}`), false, "past 90 days: gone");
  assert.equal(left.get(`dfu-stale-${n}`), "expired");
  assert.equal(left.get(`dfu-new-${n}`), "pending");
});

test("goals: a goal set by hand settles the proposal waiting for the issue; an old one is not shown nor accepted", () => {
  const t = setup();
  putMetric(t.ws, `signups${n}`, 10, "Signups", t.ann);
  const ctx = ctxFor(t.ann, t.ws, "edit");
  const propose = (issue: string, target: number) =>
    recordHub(t.ws, {
      subject: `issue:${issue}`,
      source: "rule",
      mode: "suggest",
      status: "pending",
      payload: { kind: "goal", issue, reaction: { id: `goal-p-${issue}`, name: "", on: true, when: { type: "metric", key: `signups${n}` }, if: { kind: "compare", field: "value", op: ">=", value: target }, then: [{ do: "issue.done", issue }] } as Reaction },
      by: t.ann,
    });
  const waiting = (issue: string) => activityOf(t.ws, t.ann).filter((a) => a.canResolve && a.subject === `issue:${issue}`);
  const goals = (issue: string) => reactionsOf(t.ws).filter((r) => goalIssueOf(r) === issue);

  const a = createIssue(ctx, { teamId: t.team, title: "Reach 500 signups" });
  const p = propose(a.id, 500);
  assert.equal(waiting(a.id).length, 1);
  // Ann sets the goal herself (the Goal panel).
  assert.ok(!("error" in setGoal(t.ws, { issue: a.id, key: `signups${n}`, op: ">=", target: 600 }, t.ann)));
  assert.equal(waiting(a.id).length, 0, "nothing waits for her any more");
  assert.equal((sql("SELECT status FROM dz_decisions WHERE id = ?").get(p) as { status: string }).status, "expired");
  assert.equal(resolve(t.ws, p, true, t.ann), "gone");
  assert.equal(goals(a.id).length, 1);

  // A proposal left from before (pending while the issue already has its goal): hidden, and accepting it adds no second goal.
  const b = createIssue(ctx, { teamId: t.team, title: "Reach 700 signups" });
  assert.ok(!("error" in setGoal(t.ws, { issue: b.id, key: `signups${n}`, op: ">=", target: 700 }, t.ann)));
  const stale = propose(b.id, 800);
  assert.equal(waiting(b.id).length, 0);
  assert.equal(resolve(t.ws, stale, true, t.ann), "gone");
  assert.deepEqual(goals(b.id).map((r) => (r.if as { value: number }).value), [700], "the person's goal stays as set");

  // Accepting a proposal still works as before.
  const c = createIssue(ctx, { teamId: t.team, title: "Reach 900 signups" });
  const pc = propose(c.id, 900);
  assert.equal(resolve(t.ws, pc, true, t.ann), "applied");
  assert.equal((sql("SELECT status FROM dz_decisions WHERE id = ?").get(pc) as { status: string }).status, "accepted");
  assert.equal(goals(c.id).length, 1);
});
