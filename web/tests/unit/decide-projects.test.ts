import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { putMetric, saveReaction, startReactions, decisionsOf } from "@/lib/decide/engine";
import { cleanReaction } from "@/lib/decide/model";
import { indexNote, startEco } from "@/lib/eco/indexer";
import { pushNotes } from "@/lib/notes/server-store";
import { sanitizeNote } from "@/lib/notes/model";
import type { Note } from "@/lib/notes/types";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, getIssueBrief, queryIssues, updateIssue } from "@/lib/projects/issues";
import { createTeam, listStatuses } from "@/lib/projects/teams";
import { sql } from "@/lib/store";
import { createWorkspace } from "@/lib/workspaces";

/** Waits until `ok()` holds (parallel test runs are slow), at most `ms`. */
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `dp-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Grace");
const ws = createWorkspace(owner, "Growth").id;
const team = createTeam(ctxFor(owner, ws, "edit"), { name: "Growth", key: "GRO" }, "en");
const cat = (issueId: string) => listStatuses(ctxFor(owner, ws, "read")).find((s) => s.id === getIssueBrief(ctxFor(owner, ws, "read"), issueId).statusId)?.category;

/** A Documents database "Key results" (with a status) and one row that holds a live issue. */
function keyResults(issueId: string): { db: string; row: string } {
  const now = Date.now();
  const db = sanitizeNote({
    id: "dpdb000000000000000000000000kr01",
    kind: "database",
    title: "Key results",
    parentId: null,
    icon: "",
    cover: null,
    content: [],
    order: 1,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    db: {
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: "st", name: "Status", type: "status", options: [{ id: "todo", name: "Not started", color: "default", group: "todo" }, { id: "done", name: "Done", color: "green", group: "done" }] },
      ],
      views: [],
    },
  }) as Note;
  const row = sanitizeNote({
    id: "dprow00000000000000000000000kr11",
    kind: "page",
    title: "Reach $1k MRR",
    parentId: db.id,
    icon: "",
    cover: null,
    content: [{ id: "b1", type: "issue", props: { issueId, ident: "" }, children: [] }],
    props: { st: "todo" },
    order: 1,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
  }) as Note;
  pushNotes(ws, [{ id: db.id, note: db }, { id: row.id, note: row }], { by: owner, quotaLeft: Infinity });
  indexNote(ws, db.id);
  indexNote(ws, row.id);
  return { db: db.id, row: row.id };
}
const rowStatus = (row: string) => (JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, row) as { json: string }).json) as Note).props?.st;

test("rules accept Projects triggers and issue actions, and refuse placeholders that name nothing", () => {
  const ok = (r: unknown) => cleanReaction(r) !== null;
  assert.ok(ok({ id: "rule-ok-1", when: { type: "projects", entity: "issue" }, if: { kind: "compare", field: "Done", op: "=", value: true }, then: [{ do: "links.done", from: "$subject" }] }));
  assert.ok(ok({ id: "rule-ok-2", when: { type: "metric", key: "mrr" }, if: { kind: "compare", field: "value", op: ">=", value: 1000 }, then: [{ do: "issue.done", issue: "issue_00001" }] }));
  assert.ok(ok({ id: "rule-ok-3", when: { type: "notes", db: "dpdb000000000000000000000000kr01" }, if: { kind: "always" }, then: [{ do: "issue.create", title: "Follow up: {Name}" }] }));
  assert.ok(!ok({ id: "rule-no-1", when: { type: "notes", db: "dpdb000000000000000000000000kr01" }, if: { kind: "always" }, then: [{ do: "issue.done", issue: "$subject" }] }), "$subject needs an issue trigger");
  assert.ok(!ok({ id: "rule-no-2", when: { type: "projects", entity: "issue" }, if: { kind: "always" }, then: [{ do: "notes.done", note: "$row" }] }), "$row needs a row trigger");
  assert.ok(!ok({ id: "rule-no-3", when: { type: "notes", db: "dpdb000000000000000000000000kr01" }, if: { kind: "always" }, then: [{ do: "issue.done", issue: "$row" }] }), "an issue action never takes a row");
  assert.ok(!ok({ id: "rule-no-4", when: { type: "projects", entity: "issue", project: "bad id" }, if: { kind: "always" }, then: [{ do: "issue.done", issue: "$subject" }] }));
  assert.ok(!ok({ id: "rule-no-5", when: { type: "metric", key: "mrr" }, if: { kind: "always" }, then: [{ do: "issue.set", issue: "issue_00001", field: "colour", value: "red" }] }));
});

test("a goal is an issue: the live number reaches the target, the goal closes, and the Documents row linked to it is marked done", async () => {
  startReactions();
  startEco();
  const goal = createIssue(ctxFor(owner, ws, "edit"), { teamId: team.id, title: "Reach $1k MRR" });
  const { row } = keyResults(goal.id);
  await tick();
  const r = saveReaction(
    ws,
    {
      id: "goal-mrr-1",
      name: "MRR goal",
      when: { type: "metric", key: "mrr" },
      if: { kind: "compare", field: "value", op: ">=", value: 1000 },
      then: [
        { do: "issue.done", issue: goal.id },
        { do: "links.done", from: `issue:${goal.id}`, kinds: ["note"] },
      ],
    },
    owner
  );
  assert.ok(!("error" in r), JSON.stringify(r));
  putMetric(ws, "mrr", 640, "MRR", "ingest");
  await tick(80);
  assert.equal(cat(goal.id), "unstarted", "below the target: nothing happens");
  assert.equal(rowStatus(row), "todo");
  putMetric(ws, "mrr", 1040, null, "ingest");
  await until(() => cat(goal.id) === "completed" && rowStatus(row) === "done");
  assert.equal(cat(goal.id), "completed", "the goal closed by itself");
  assert.equal(rowStatus(row), "done", "and the key result in Documents with it");
  assert.ok(decisionsOf(ws).some((d) => d.reaction_id === "goal-mrr-1" && d.status === "applied"), "why it changed is on record");
});

test("an issue closing marks done what it is linked with; a rule never feeds itself", async () => {
  startReactions();
  startEco();
  const ctx = ctxFor(owner, ws, "edit");
  const issue = createIssue(ctx, { teamId: team.id, title: "Launch the referral program" });
  const { row } = keyResults(issue.id);
  pushNotes(ws, [{ id: row, note: { ...(JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, row) as { json: string }).json) as Note), props: { st: "todo" }, updatedAt: Date.now() } }], { by: owner, quotaLeft: Infinity });
  indexNote(ws, row);
  saveReaction(ws, { id: "done-follows-1", when: { type: "projects", entity: "issue" }, if: { kind: "compare", field: "Done", op: "=", value: true }, then: [{ do: "links.done", from: "$subject" }] }, owner);
  await tick();
  const completed = listStatuses(ctx).find((s) => s.teamId === team.id && s.category === "completed")!;
  updateIssue(ctx, issue.id, { statusId: completed.id });
  await until(() => rowStatus(row) === "done");
  assert.equal(rowStatus(row), "done");
  assert.equal(decisionsOf(ws).filter((d) => d.reaction_id === "done-follows-1" && d.subject === `issue:${issue.id}`).length, 1, "fired once, on the edge");
});

test("a new row of a Documents database (a form answer) becomes an issue titled from its fields", async () => {
  startReactions();
  const now = Date.now();
  const leads = sanitizeNote({
    id: "dpdb000000000000000000000leads1",
    kind: "database",
    title: "Leads",
    parentId: null,
    icon: "",
    cover: null,
    content: [],
    order: 2,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "co", name: "Company", type: "text" }], views: [] },
  }) as Note;
  pushNotes(ws, [{ id: leads.id, note: leads }], { by: owner, quotaLeft: Infinity });
  saveReaction(ws, { id: "lead-to-issue", when: { type: "notes", db: leads.id }, if: { kind: "always" }, then: [{ do: "issue.create", title: "Call {Name} ({Company})", teamId: team.id }] }, owner);
  const answer = sanitizeNote({ id: "dprow00000000000000000000lead01", kind: "page", title: "Ada", parentId: leads.id, icon: "", cover: null, content: [], props: { co: "Analytical Engines" }, order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null }) as Note;
  pushNotes(ws, [{ id: answer.id, note: answer }], { by: "form", quotaLeft: Infinity });
  await until(() => queryIssues(ctxFor(owner, ws, "read"), { filter: { q: "Analytical" }, display: { group: "none" }, limit: 5 }).total > 0);
  const found = queryIssues(ctxFor(owner, ws, "read"), { filter: { q: "Analytical" }, display: { group: "none" }, limit: 5 });
  assert.deepEqual(
    found.groups.flatMap((g) => g.items.map((i) => i.title)),
    ["Call Ada (Analytical Engines)"]
  );
});
