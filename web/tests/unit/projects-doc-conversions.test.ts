import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { resetSmart } from "@/lib/decide/smart";
import { sanitizeNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { ctxFor, PjError } from "@/lib/projects/core";
import { claimConversions, createFromDoc, pendingConversions, planFromDoc, pruneConversions } from "@/lib/projects/from-doc";
import { createTeam } from "@/lib/projects/teams";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `pjc-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Ada");
const viewer = person("Vic");
const stranger = person("Stan");
const ws = createWorkspace(owner, "Conversions").id;
acceptInvite(viewer, createInvite(owner, ws, "viewer")!.token);
const as = (u: string, need: "read" | "edit" = "edit") => ctxFor(u, ws, need);
const team = createTeam(as(owner), { name: "Core", key: "DOC" }, "en");

test("the task lines of a page the person may edit are queued once, handed to one editor, and forgotten after 30 days", async () => {
  const now = Date.now();
  const id = "pjcdoc000000000000000000000000q4";
  const note = sanitizeNote({
    id,
    kind: "page",
    title: "Launch",
    parentId: null,
    icon: "",
    cover: null,
    content: [
      { id: "h1", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Goal: launch the beta", styles: {} }], children: [] },
      { id: "c1", type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Write the release notes", styles: {} }], children: [] },
      { id: "c2", type: "checkListItem", props: { checked: true }, content: [{ type: "text", text: "Book the venue", styles: {} }], children: [] },
    ],
    order: 1,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
  }) as Note;
  pushNotes(ws, [{ id, note }], { by: owner, quotaLeft: Infinity });
  resetSmart();
  delete process.env.ZVENA_AI_KEY;

  const plan = await planFromDoc(as(owner), id);
  const tasks = plan.lines.filter((l) => l.kind === "task");
  assert.deepEqual(
    tasks.map((l) => l.blockId),
    ["c1", "c2"],
    "each line knows its block"
  );
  const made = createFromDoc(as(owner), {
    teamId: team.id,
    noteId: id,
    goals: [{ text: "Goal: launch the beta" }],
    tasks: [...tasks.map((l) => ({ text: l.text, goal: 0, done: l.checked === true, blockId: l.blockId })), { text: "Bad block", blockId: "<script>" }],
  });
  assert.equal(made.issues.length, 3);
  assert.equal(made.converting, 2, "only well-formed blocks are queued");

  assert.deepEqual(pendingConversions(as(viewer, "read"), id), [], "a viewer of the page sees nothing to swap");
  assert.throws(() => claimConversions(as(viewer, "read"), id, ["c1"]), (e: unknown) => e instanceof PjError && e.status === 403);
  const other = createWorkspace(stranger, "Elsewhere").id;
  assert.deepEqual(pendingConversions(ctxFor(stranger, other, "edit"), id), [], "another workspace has no such page");
  assert.throws(() => claimConversions(ctxFor(stranger, other, "edit"), id, ["c1"]), (e: unknown) => e instanceof PjError && e.status === 404);

  const pending = pendingConversions(as(owner), id);
  assert.deepEqual(pending.map((p) => p.blockId).sort(), ["c1", "c2"]);
  assert.match(pending[0].ident, /^DOC-\d+$/);
  const first = claimConversions(as(owner), id, ["c1"]);
  assert.deepEqual(first.map((p) => p.blockId), ["c1"]);
  assert.deepEqual(claimConversions(as(owner), id, ["c1"]), [], "a second editor gets nothing: one swap per line");
  assert.equal(pendingConversions(as(owner), id).length, 1);

  // A reader of the page cannot queue its lines.
  const readOnly = createFromDoc(as(owner), { teamId: team.id, noteId: "nosuchnote0000000000", tasks: [{ text: "Orphan", blockId: "x1" }] });
  assert.equal(readOnly.converting, 0);

  assert.equal(pruneConversions(Date.now() + 31 * 86_400_000), 1, "forgotten after 30 days");
  assert.equal(pendingConversions(as(owner), id).length, 0);
});
