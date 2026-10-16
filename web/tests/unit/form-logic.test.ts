import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { meets, shownQuestions } from "@/lib/notes/form-logic";
import { blankNote, defaultView, sanitizeNote } from "@/lib/notes/model";
import { openNoteForm, pullNotes, pushNotes, readNoteForm, submitNoteForm } from "@/lib/notes/server-store";
import type { DbProperty, FormQuestion, Note } from "@/lib/notes/types";
import { createWorkspace } from "@/lib/workspaces";

test("form logic: is / is not an option, filled / empty; a condition looks only at an earlier, shown question", () => {
  assert.equal(meets({ prop: "a", op: "is", value: "bug" }, "bug"), true);
  assert.equal(meets({ prop: "a", op: "is", value: "bug" }, ["idea", "bug"]), true);
  assert.equal(meets({ prop: "a", op: "is_not", value: "bug" }, "idea"), true);
  assert.equal(meets({ prop: "a", op: "is", value: "Yes please" }, "yes PLEASE "), true);
  assert.equal(meets({ prop: "a", op: "filled" }, true), true);
  assert.equal(meets({ prop: "a", op: "empty" }, false), true);
  assert.equal(meets({ prop: "a", op: "empty" }, []), true);
  const qs: FormQuestion[] = [
    { prop: "kind" },
    { prop: "steps", when: { prop: "kind", op: "is", value: "bug" } },
    { prop: "shot", when: { prop: "steps", op: "filled" } },
    // Looks at a later question: ignored, always shown.
    { prop: "odd", when: { prop: "last", op: "filled" } },
    { prop: "last" },
  ];
  assert.deepEqual([...shownQuestions(qs, { kind: "idea", steps: "x" })], ["kind", "odd", "last"], "steps hidden, so shot (which hangs on it) too");
  assert.deepEqual([...shownQuestions(qs, { kind: "bug", steps: "x" })], ["kind", "steps", "shot", "odd", "last"]);
});

test("a form's hidden question is neither required nor kept; the logic survives sanitizing", () => {
  const r = signInWith({ provider: "dev", subject: "form-logic-owner", name: "Owner" }, "2026-10-15");
  assert.ok(r.ok);
  const ws = createWorkspace(r.user.id, "Forms with logic").id;
  const KIND: DbProperty = { id: "kind", name: "Kind", type: "select", options: [{ id: "bug", name: "Bug", color: "red" }, { id: "idea", name: "Idea", color: "blue" }] };
  const STEPS: DbProperty = { id: "steps", name: "Steps", type: "text" };
  const db = blankNote({ kind: "database", title: "Feedback" });
  const view = defaultView("form", "Form");
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }, KIND, STEPS], views: [defaultView("table", "Table"), view] };
  pushNotes(ws, [{ id: db.id, note: db }], { by: r.user.id, quotaLeft: Infinity });
  const formId = openNoteForm(ws, db.id, view.id);
  view.form = { questions: [{ prop: "title", required: true }, { prop: "kind", required: true }, { prop: "steps", required: true, when: { prop: "kind", op: "is", value: "bug" } }], shareId: formId };
  const next = sanitizeNote({ ...db, db: { ...db.db, views: [db.db.views[0], view] } }) as Note;
  assert.deepEqual(next.db?.views[1].form?.questions[2].when, { prop: "kind", op: "is", value: "bug" });
  pushNotes(ws, [{ id: db.id, note: next }], { by: r.user.id, quotaLeft: Infinity });
  assert.deepEqual(readNoteForm(formId)?.questions[2].when, { prop: "kind", op: "is", value: "bug" });
  // An idea: Steps is hidden — not required, and an answer sent anyway is not kept.
  const idea = submitNoteForm(formId, { title: "Dark mode", kind: "idea", steps: "sneaked in" });
  assert.equal(idea.ok, true);
  // A bug: Steps shows, and is required.
  const missing = submitNoteForm(formId, { title: "Crash", kind: "bug" });
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.prop, "steps");
  assert.equal(submitNoteForm(formId, { title: "Crash", kind: "bug", steps: "Open it" }).ok, true);
  const rows = pullNotes(ws, 0).notes.filter((n) => n.parentId === db.id);
  assert.equal(rows.find((n) => n.title === "Dark mode")?.props?.steps, undefined);
  assert.equal(rows.find((n) => n.title === "Crash")?.props?.steps, "Open it");
});

test("who may answer: a members-only form wants a member; a member's response is theirs unless the form is anonymous", async () => {
  const { acceptInvite, createInvite } = await import("@/lib/workspaces");
  const own = signInWith({ provider: "dev", subject: "form-access-owner", name: "Owner" }, "2026-10-15");
  const mate = signInWith({ provider: "dev", subject: "form-access-mate", name: "Mate" }, "2026-10-15");
  const out = signInWith({ provider: "dev", subject: "form-access-out", name: "Outsider" }, "2026-10-15");
  assert.ok(own.ok && mate.ok && out.ok);
  const ws = createWorkspace(own.user.id, "Forms with access").id;
  assert.ok(acceptInvite(mate.user.id, createInvite(own.user.id, ws, "viewer").token));
  const db = blankNote({ kind: "database", title: "Requests" });
  const view = defaultView("form", "Form");
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [view] };
  pushNotes(ws, [{ id: db.id, note: db }], { by: own.user.id, quotaLeft: Infinity });
  const formId = openNoteForm(ws, db.id, view.id);
  const setForm = (extra: Record<string, unknown>) => {
    const cur = pullNotes(ws, 0).notes.find((n) => n.id === db.id) as Note;
    const next = sanitizeNote({ ...cur, db: { ...cur.db!, views: [{ ...view, form: { questions: [{ prop: "title" }], shareId: formId, ...extra } }] } }) as Note;
    pushNotes(ws, [{ id: db.id, note: next }], { by: own.user.id, quotaLeft: Infinity });
  };
  setForm({ access: "workspace" });
  assert.equal(readNoteForm(formId)?.membersOnly, true);
  const anon = submitNoteForm(formId, { title: "a" }, Date.now(), null);
  assert.ok(!anon.ok && anon.status === 401);
  const stranger = submitNoteForm(formId, { title: "b" }, Date.now(), out.user.id);
  assert.ok(!stranger.ok && stranger.status === 403);
  assert.equal(submitNoteForm(formId, { title: "From mate" }, Date.now(), mate.user.id).ok, true);
  setForm({ access: "workspace", anonymous: true });
  assert.equal(submitNoteForm(formId, { title: "Anonymous mate" }, Date.now(), mate.user.id).ok, true);
  setForm({});
  assert.equal(submitNoteForm(formId, { title: "From outside" }, Date.now(), out.user.id).ok, true);
  const rows = pullNotes(ws, 0).notes.filter((n) => n.parentId === db.id);
  assert.equal(rows.find((n) => n.title === "From mate")?.createdBy, mate.user.id);
  assert.equal(rows.find((n) => n.title === "Anonymous mate")?.createdBy, "form");
  assert.equal(rows.find((n) => n.title === "From outside")?.createdBy, "form", "someone outside the workspace is never named");
});

test("a members-only form shows anyone else no questions; a member sees them", async () => {
  const { acceptInvite, createInvite } = await import("@/lib/workspaces");
  const { formForVisitor } = await import("@/lib/notes/server-store");
  const own = signInWith({ provider: "dev", subject: "form-gate-owner", name: "Owner" }, "2026-10-15");
  const mate = signInWith({ provider: "dev", subject: "form-gate-mate", name: "Mate" }, "2026-10-15");
  assert.ok(own.ok && mate.ok);
  const ws = createWorkspace(own.user.id, "Gated forms").id;
  assert.ok(acceptInvite(mate.user.id, createInvite(own.user.id, ws, "viewer").token));
  const db = blankNote({ kind: "database", title: "Requests" });
  const view = defaultView("form", "Form");
  db.db = { properties: [{ id: "title", name: "SecretQuestionSteps", type: "title" }], views: [view] };
  pushNotes(ws, [{ id: db.id, note: db }], { by: own.user.id, quotaLeft: Infinity });
  const formId = openNoteForm(ws, db.id, view.id);
  const next = sanitizeNote({ ...db, db: { ...db.db, views: [{ ...view, form: { questions: [{ prop: "title", help: "secret help" }], shareId: formId, access: "workspace", thanks: "secret thanks" } }] } }) as Note;
  pushNotes(ws, [{ id: db.id, note: next }], { by: own.user.id, quotaLeft: Infinity });
  const outsider = formForVisitor(formId, false);
  assert.equal(outsider?.questions.length, 0);
  assert.ok(!JSON.stringify(outsider).includes("Secret") && !JSON.stringify(outsider).includes("secret"));
  assert.equal(formForVisitor(formId, true)?.questions[0].name, "SecretQuestionSteps");
});

test("a page deleted for good takes its views with it", async () => {
  const { recordView } = await import("@/lib/notes/versions");
  const { sql } = await import("@/lib/store");
  const { purgeNoteTombstones } = await import("@/lib/notes/server-store");
  const r = signInWith({ provider: "dev", subject: "views-gone", name: "Viewer" }, "2026-10-15");
  assert.ok(r.ok);
  const ws = createWorkspace(r.user.id, "Views go").id;
  const p = blankNote({ kind: "page", title: "Short-lived" });
  const q = blankNote({ kind: "page", title: "Old tombstone" });
  pushNotes(ws, [{ id: p.id, note: p }, { id: q.id, note: q }], { by: r.user.id, quotaLeft: Infinity });
  assert.ok(recordView(ws, p.id, r.user.id));
  const count = (id: string) => Number((sql("SELECT COUNT(*) AS n FROM note_views WHERE ws = ? AND note_id = ?").get(ws, id) as { n: number }).n);
  pushNotes(ws, [{ id: p.id, deleted: true }], { by: r.user.id, quotaLeft: Infinity });
  assert.equal(count(p.id), 0);
  // A view left from before (a tombstone whose views stayed) goes with the next sweep.
  sql("UPDATE notes SET deleted = 1, json = NULL WHERE ws = ? AND id = ?").run(ws, q.id);
  sql("INSERT INTO note_views (ws, note_id, user_id, at) VALUES (?, ?, ?, ?)").run(ws, q.id, r.user.id, Date.now());
  purgeNoteTombstones();
  assert.equal(count(q.id), 0);
});
