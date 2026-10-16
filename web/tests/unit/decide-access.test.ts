import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { putMetric, saveReaction, startReactions } from "@/lib/decide/engine";
import { cardsFor } from "@/lib/eco/cards";
import { indexNote } from "@/lib/eco/indexer";
import { keyVisible } from "@/lib/eco/visibility";
import { grant } from "@/lib/notes/access";
import { blankNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { ctxFor } from "@/lib/projects/core";
import { queryIssues } from "@/lib/projects/issues";
import { createTeam } from "@/lib/projects/teams";
import { sql } from "@/lib/store";
import { isBlockedAddress } from "@/lib/web-read";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
}
const tick = (ms = 300) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `dacc-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

/** Owner Ann keeps a private database "Salaries" with one row; Ben is an editor of the workspace. */
function setup() {
  const ann = person("Ann");
  const ben = person("Ben");
  const ws = createWorkspace(ann, `Acc ${n}`).id;
  assert.ok(acceptInvite(ben, createInvite(ann, ws, "editor").token));
  const team = createTeam(ctxFor(ann, ws, "edit"), { name: "Ops", key: `OP${n}` }, "en");
  const db = blankNote({
    kind: "database",
    title: "Salaries",
    space: `private:${ann}`,
    db: {
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: "sal", name: "Salary", type: "number" },
      ],
      views: [],
    },
  } as never);
  const row = blankNote({ kind: "page", title: "CEO Jane", parentId: db.id, props: { sal: 987654 } } as never);
  pushNotes(ws, [{ id: db.id, note: db }, { id: row.id, note: row }], { by: ann, quotaLeft: Infinity, access: { userId: ann } });
  indexNote(ws, db.id);
  indexNote(ws, row.id);
  return { ann, ben, ws, team, db: db.id, row: row.id };
}
const salary = (ws: string, row: string) => (JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, row) as { json: string }).json) as Note).props?.sal;

test("decide: an editor cannot save a rule over a private database or row they cannot open", () => {
  const t = setup();
  assert.deepEqual(saveReaction(t.ws, { id: `dacc-w-${n}`, when: { type: "notes", db: t.db }, if: { kind: "always" }, then: [{ do: "issue.create", title: "LEAK {Name} {Salary}", teamId: t.team.id }] }, t.ben), { error: "forbidden" });
  assert.deepEqual(
    saveReaction(t.ws, { id: `dacc-s-${n}`, when: { type: "metric", key: "k" }, if: { kind: "always" }, then: [{ do: "notes.set", note: t.row, prop: "Salary", value: 1 }] }, t.ben),
    { error: "forbidden" }
  );
  // The owner may.
  assert.ok(!("error" in saveReaction(t.ws, { id: `dacc-o-${n}`, when: { type: "metric", key: "own" }, if: { kind: "always" }, then: [{ do: "notes.set", note: t.row, prop: "Salary", value: 5 }] }, t.ann)));
});

test("decide: a rule whose author lost access neither reads nor writes the private rows", async () => {
  startReactions();
  const t = setup();
  // Rules saved before the fix (or by someone who could open the page then) run as their author: Ben now.
  const write = { id: `dacc-x-${n}`, name: "", on: true, when: { type: "metric", key: `kx${n}` }, if: { kind: "always" }, then: [{ do: "notes.set", note: t.row, prop: "Salary", value: 1 }] };
  const read = { id: `dacc-r-${n}`, name: "", on: true, when: { type: "notes", db: t.db }, if: { kind: "always" }, then: [{ do: "issue.create", title: "LEAK {Name} {Salary}", teamId: t.team.id }] };
  for (const r of [write, read]) sql("INSERT INTO dz_reactions (id, ws, json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)").run(r.id, t.ws, JSON.stringify(r), t.ben, Date.now());
  // Reload the engine's cache of this workspace's rules.
  saveReaction(t.ws, { id: `dacc-reload-${n}`, when: { type: "metric", key: "noop" }, if: { kind: "always" }, then: [{ do: "issue.create", title: "noop", teamId: t.team.id }] }, t.ann);
  putMetric(t.ws, `kx${n}`, 5, null, t.ben);
  const edited = { ...(JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(t.ws, t.row) as { json: string }).json) as Note), title: "CEO Jane!", updatedAt: Date.now() };
  pushNotes(t.ws, [{ id: t.row, note: edited }], { by: t.ann, quotaLeft: Infinity, access: { userId: t.ann } });
  await tick();
  assert.equal(salary(t.ws, t.row), 987654);
  assert.equal(queryIssues(ctxFor(t.ann, t.ws, "read"), { filter: { q: "LEAK" }, display: { group: "none" }, limit: 5 }).total, 0);
});

test("decide: the owner's own rule still changes their row", async () => {
  startReactions();
  const t = setup();
  assert.ok(!("error" in saveReaction(t.ws, { id: `dacc-ok-${n}`, when: { type: "metric", key: `ok${n}` }, if: { kind: "always" }, then: [{ do: "notes.set", note: t.row, prop: "Salary", value: 7 }] }, t.ann)));
  putMetric(t.ws, `ok${n}`, 1, null, t.ann);
  await until(() => salary(t.ws, t.row) === 7);
  assert.equal(salary(t.ws, t.row), 7);
});

test("eco: a page card names its parent only to someone who may open the parent; private page ids stay off others' pulse", async () => {
  const t = setup();
  // A sub-page of Ann's private database row, shared with nobody: Ben sees neither.
  assert.equal(keyVisible(t.ben, t.ws, `note:${t.row}`), false);
  assert.equal(keyVisible(t.ann, t.ws, `note:${t.row}`), true);
  const forAnn = await cardsFor({ wsId: t.ws, userId: t.ann, locale: "en" } as never, [`note:${t.row}`]);
  assert.equal(forAnn[0]?.sub?.includes("Salaries"), true);
  const forBen = await cardsFor({ wsId: t.ws, userId: t.ben, locale: "en" } as never, [`note:${t.row}`]);
  assert.equal(forBen.length, 0);
  // Shared with Ben on its own: he sees the row's card, not the private database's title.
  grant(t.ws, t.row, t.ben, "view", t.ann);
  const shared = await cardsFor({ wsId: t.ws, userId: t.ben, locale: "en" } as never, [`note:${t.row}`]);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].sub, undefined);
});

test("ssrf: IPv6 forms that carry an IPv4 address or tunnel to one are refused", () => {
  for (const ip of ["::ffff:0:10.0.0.1", "::ffff:0:a00:1", "2002:a00:1::1", "2001:0:4136:e378::1", "2001::1", "64:ff9b::10.0.0.1", "::ffff:127.0.0.1"]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "8.8.8.8"]) assert.equal(isBlockedAddress(ip), false, ip);
});

test("decide: a goal saved when its number already meets the target closes the issue at once", async () => {
  startReactions();
  const t = setup();
  const { createIssue, getIssueBrief } = await import("@/lib/projects/issues");
  const { listStatuses } = await import("@/lib/projects/teams");
  const issue = createIssue(ctxFor(t.ann, t.ws, "edit"), { teamId: t.team.id, title: "Reach 100 signups" });
  putMetric(t.ws, `signups${n}`, 150, "Signups", t.ann);
  saveReaction(t.ws, { id: `dacc-goal-${n}`, when: { type: "metric", key: `signups${n}` }, if: { kind: "compare", field: "value", op: ">=", value: 100 }, then: [{ do: "issue.done", issue: issue.id }] }, t.ann);
  const cat = () => listStatuses(ctxFor(t.ann, t.ws, "read")).find((s) => s.id === getIssueBrief(ctxFor(t.ann, t.ws, "read"), issue.id).statusId)?.category;
  await until(() => cat() === "completed");
  assert.equal(cat(), "completed");
});

test("eco: Create document twice opens the same document", async () => {
  const t = setup();
  const { createIssue } = await import("@/lib/projects/issues");
  const { docFor } = await import("@/lib/eco/actions");
  const issue = createIssue(ctxFor(t.ann, t.ws, "edit"), { teamId: t.team.id, title: "Spec me" });
  const actor = { userId: t.ann, wsId: t.ws, locale: "en" as const, name: "Ann" };
  const a = await docFor(actor, `issue:${issue.id}`);
  const b = await docFor(actor, `issue:${issue.id}`);
  assert.equal(a.noteId, b.noteId);
});

test("decide: a column hidden from the rule's author is no fact of the rule (title, comparison, model)", async () => {
  startReactions();
  const t = setup();
  // The database moves to the workspace (Ben may open it) and Salary is visible to Ann only.
  const stored = JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(t.ws, t.db) as { json: string }).json) as Note;
  const db = { ...stored, space: undefined, db: { ...stored.db!, properties: stored.db!.properties.map((p) => (p.id === "sal" ? { ...p, perms: { view: [t.ann] } } : p)) }, updatedAt: Date.now() } as Note;
  pushNotes(t.ws, [{ id: t.db, note: { ...db, space: "workspace" } as Note }], { by: t.ann, quotaLeft: Infinity });
  sql("UPDATE notes SET space = NULL WHERE ws = ? AND id = ?").run(t.ws, t.db);
  const { subjectsFor } = await import("@/lib/decide/adapters");
  const r = saveReaction(t.ws, { id: `dacc-col-${n}`, when: { type: "notes", db: t.db }, if: { kind: "always" }, then: [{ do: "issue.create", title: "COLLEAK {Name} {Salary}", teamId: t.team.id }] }, t.ben);
  assert.ok(!("error" in r), JSON.stringify(r));
  const s = subjectsFor(t.ws, { type: "notes", db: t.db }, { id: 0, ws: t.ws, type: "notes", ref: t.row, at: Date.now() }, `dacc-col-${n}`);
  assert.equal(s.length, 1);
  assert.equal("Salary" in s[0].facts, false, "Ben's rule does not see Salary");
  assert.equal(s[0].facts.Name, "CEO Jane");
});

test("decide: the rules and decisions list hides rules over pages the person cannot open", async () => {
  const t = setup();
  const { reactionsOf, decisionsOf, visibleRules } = await import("@/lib/decide/engine");
  saveReaction(t.ws, { id: `dacc-vis-${n}`, when: { type: "notes", db: t.db }, if: { kind: "always" }, then: [{ do: "issue.create", title: "x", teamId: t.team.id }] }, t.ann);
  const forBen = visibleRules(t.ws, t.ben, reactionsOf(t.ws), decisionsOf(t.ws));
  assert.equal(forBen.reactions.some((r) => r.id === `dacc-vis-${n}`), false);
  const forAnn = visibleRules(t.ws, t.ann, reactionsOf(t.ws), decisionsOf(t.ws));
  assert.equal(forAnn.reactions.some((r) => r.id === `dacc-vis-${n}`), true);
});
