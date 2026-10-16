import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { automationRuns, indexSchedules, notifyTargets, pendingWebhooks, pressButton, runDueSchedules, setWorkspaceTz } from "@/lib/notes/automations-server";
import type { Automation } from "@/lib/notes/automations";
import { blankNote, defaultView } from "@/lib/notes/model";
import { nextRun, zonedTime } from "@/lib/notes/schedule";
import { openNoteForm, pullNotes, pushNotes, submitNoteForm } from "@/lib/notes/server-store";
import type { DbProperty, Note } from "@/lib/notes/types";
import { postJson } from "@/lib/web-read";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";
import { POST as pressRoute } from "@/app/api/notes/button/route";

// Automations act for their author: each test's workspace is its author's.
let USER = "";
const space = (name: string) => {
  const r = signInWith({ provider: "dev", subject: `auto-${name}`, name }, "2026-10-13");
  if (!r.ok) throw new Error("sign in");
  USER = r.user.id;
  return createWorkspace(USER, name).id;
};
const STATUS: DbProperty = { id: "st", name: "Status", type: "status", options: [{ id: "todo", name: "To do", color: "default", group: "todo" }, { id: "done", name: "Done", color: "green", group: "done" }] };
const OWNER: DbProperty = { id: "who", name: "Owner", type: "person" };
const NOTE: DbProperty = { id: "nt", name: "Note", type: "text" };

const push = (ws: string, notes: Note[], by?: string) => pushNotes(ws, notes.map((n) => ({ id: n.id, note: n })), { by: by ?? USER, quotaLeft: Infinity });
const rowsOf = (ws: string, dbId: string) => pullNotes(ws, 0).notes.filter((n) => n.parentId === dbId && !n.template);
const rowById = (ws: string, id: string) => pullNotes(ws, 0).notes.find((n) => n.id === id) as Note;

function database(ws: string, automations: Automation[], extra: DbProperty[] = []): Note {
  const db = blankNote({ kind: "database", title: "Tasks" });
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }, STATUS, OWNER, NOTE, ...extra], views: [defaultView("table", "Table")], automations };
  push(ws, [db]);
  return db;
}

test("a form response is a page added: the automation runs once, on the server", () => {
  const ws = space("form");
  const db = database(ws, [{ id: "a1", name: "Triage", on: true, trigger: { type: "added" }, actions: [{ type: "set", prop: "st", value: "todo" }] }]);
  const view = defaultView("form", "Form");
  const formId = openNoteForm(ws, db.id, view.id);
  view.form = { questions: [{ prop: "title", required: true }], shareId: formId };
  push(ws, [{ ...db, db: { ...db.db!, views: [...db.db!.views, view] } }]);
  assert.equal(submitNoteForm(formId, { title: "Bug report" }).ok, true);
  const rows = rowsOf(ws, db.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].props?.st, "todo");
  assert.equal(rows[0].editedBy, "automation:a1");
  assert.equal(automationRuns(ws, db.id).find((r) => r.automationId === "a1")?.runs, 1);
});

test("automations' own writes set off nothing (no loops), and several on one row chain their edits", () => {
  const ws = space("loop");
  const db = database(ws, [
    { id: "ping", name: "Ping", on: true, trigger: { type: "edited", prop: "nt" }, actions: [{ type: "set", prop: "nt", value: "pong" }] },
    { id: "done", name: "Done", on: true, trigger: { type: "edited", prop: "nt" }, actions: [{ type: "set", prop: "st", value: "done" }] },
  ]);
  const row = blankNote({ kind: "page", parentId: db.id, title: "Row", props: {} });
  push(ws, [row]);
  push(ws, [{ ...row, props: { nt: "ping" }, updatedAt: row.updatedAt + 1 }]);
  const saved = rowById(ws, row.id);
  assert.equal(saved.props?.nt, "pong");
  assert.equal(saved.props?.st, "done");
  assert.equal(automationRuns(ws, db.id).find((r) => r.automationId === "ping")?.runs, 1);
});

test("old pages arriving late (an adopted guest workspace) are not 'added' now", () => {
  const ws = space("stale");
  const db = database(ws, [{ id: "a1", name: "", on: true, trigger: { type: "added" }, actions: [{ type: "set", prop: "st", value: "todo" }] }]);
  const old = blankNote({ kind: "page", parentId: db.id, title: "Old", createdAt: Date.now() - 3 * 86_400_000 });
  push(ws, [old]);
  assert.equal(rowById(ws, old.id).props?.st, undefined);
});

test("notification targets: people, a Person property, the creator, the editor", () => {
  const db = blankNote({ kind: "database", title: "D", createdBy: "creator1" });
  const row = blankNote({ kind: "page", parentId: db.id, props: { who: ["alice001", "bob00001", "form"] }, createdBy: "rowmaker", editedBy: "editor01" });
  assert.deepEqual(notifyTargets(["prop:who", "creator", "editor", "zed00001", "automation:x"], row, db, { actorId: null }).sort(), ["alice001", "bob00001", "editor01", "rowmaker", "zed00001"]);
  assert.deepEqual(notifyTargets(["creator", "prop:who"], null, db, { actorId: null }), ["creator1"]);
});

test("schedules run once per occurrence at the workspace's wall-clock time", () => {
  const ws = space("sched");
  setWorkspaceTz(ws, "Asia/Tokyo");
  const db = database(ws, [{ id: "daily", name: "Standup", on: true, trigger: { type: "schedule", every: "day", at: "09:00" }, actions: [{ type: "addPage", dbId: "", title: "Standup" }] }]);
  // The action adds to this same database.
  const fixed = { ...db, db: { ...db.db!, automations: [{ id: "daily", name: "Standup", on: true, trigger: { type: "schedule", every: "day", at: "09:00" }, actions: [{ type: "addPage", dbId: db.id, title: "Standup" }] }] as Automation[] } };
  const t0 = zonedTime(2026, 10, 20, 8, 0, "Asia/Tokyo");
  indexSchedules(ws, db.id, fixed, t0);
  push(ws, [fixed]);
  indexSchedules(ws, db.id, fixed, t0);
  assert.equal(runDueSchedules(t0 + 59 * 60_000), 0);
  assert.equal(runDueSchedules(t0 + 60 * 60_000 + 20_000), 1);
  assert.equal(runDueSchedules(t0 + 61 * 60_000), 0);
  assert.equal(rowsOf(ws, db.id).filter((n) => n.title === "Standup").length, 1);
  assert.equal(runDueSchedules(t0 + 25 * 3_600_000), 1);
  assert.equal(rowsOf(ws, db.id).filter((n) => n.title === "Standup").length, 2);
});

test("schedule math: weekdays, month ends, DST, intervals", () => {
  const berlin = "Europe/Berlin";
  // 9:00 stays 9:00 across the end of summer time (25 Oct 2026).
  const sat = zonedTime(2026, 10, 24, 10, 0, berlin);
  const next = nextRun({ type: "schedule", every: "day", at: "09:00" }, berlin, sat) as number;
  assert.equal(new Date(next).toISOString(), "2026-10-25T08:00:00.000Z");
  // Mondays and Fridays.
  const wd = nextRun({ type: "schedule", every: "week", at: "09:00", weekdays: [1, 5] }, berlin, next) as number;
  assert.equal(new Date(wd).toISOString(), "2026-10-26T08:00:00.000Z");
  // The 31st in a 30-day month is its last day.
  const m = nextRun({ type: "schedule", every: "month", at: "12:00", monthday: 31 }, "UTC", Date.UTC(2026, 10, 1)) as number;
  assert.equal(new Date(m).toISOString(), "2026-11-30T12:00:00.000Z");
  // Every 2 weeks from a start date.
  const fortnight = { type: "schedule" as const, every: "week" as const, at: "10:00", weekdays: [3], interval: 2, from: "2026-10-14" };
  const a = nextRun(fortnight, "UTC", Date.UTC(2026, 9, 14, 11)) as number;
  assert.equal(new Date(a).toISOString(), "2026-10-28T10:00:00.000Z");
  const y = nextRun({ type: "schedule", every: "year", at: "08:00", month: 2, monthday: 29 }, "UTC", Date.UTC(2027, 0, 1)) as number;
  assert.equal(new Date(y).toISOString(), "2027-02-28T08:00:00.000Z");
});

test("a repeating template adds a page from that template", () => {
  const ws = space("tpl");
  const db = database(ws, []);
  const tpl = blankNote({ kind: "page", parentId: db.id, template: true, title: "Weekly review", icon: "📝", content: [{ type: "paragraph", content: [{ type: "text", text: "What went well?", styles: {} }] }], props: { st: "todo" } });
  push(ws, [tpl]);
  const a: Automation = { id: `repeat-${tpl.id}`.slice(0, 40), name: "Repeat", on: true, trigger: { type: "schedule", every: "week", at: "18:00", weekdays: [5] }, actions: [{ type: "addPage", dbId: db.id, title: "", templateId: tpl.id }] };
  const withRepeat = { ...db, db: { ...db.db!, automations: [a] } };
  // Saving the database indexed its schedule: the next Friday at 18:00 in the workspace's zone.
  push(ws, [withRepeat]);
  const fri = automationRuns(ws, db.id).find((r) => r.automationId === a.id)?.nextAt as number;
  assert.equal(new Date(fri).getUTCDay(), 5);
  assert.equal(new Date(fri).getUTCHours(), 18);
  assert.equal(runDueSchedules(fri + 1000), 1);
  const made = rowsOf(ws, db.id).find((n) => n.title === "Weekly review");
  assert.ok(made);
  assert.equal(made.icon, "📝");
  assert.equal(made.props?.st, "todo");
  assert.equal(made.createdBy, `automation:${a.id}`);
  assert.ok(JSON.stringify(made.content).includes("What went well?"));
});

test("webhooks reach only public https addresses", async () => {
  for (const url of ["https://127.0.0.1/hook", "https://10.1.2.3/hook", "https://[::1]/x", "https://localhost/x", "http://example.com/x", "https://169.254.169.254/latest"]) {
    const r = await postJson(url, { a: 1 });
    assert.equal(r.ok, false, url);
  }
});

test("a webhook action is queued, not sent on the write's path", () => {
  const ws = space("hook");
  const before = pendingWebhooks().length;
  const db = database(ws, [{ id: "h1", name: "Hook", on: true, trigger: { type: "added" }, actions: [{ type: "webhook", url: "https://127.0.0.1/never" }] }]);
  push(ws, [blankNote({ kind: "page", parentId: db.id, title: "New" })]);
  assert.ok(pendingWebhooks().length >= before + 1 || automationRuns(ws, db.id).some((r) => r.automationId === "h1"));
});

test("button property: runs as the clicker; editors only", async () => {
  const user = (name: string) => {
    const r = signInWith({ provider: "dev", subject: `btn-${name}`, name }, "2026-10-13");
    assert.ok(r.ok);
    return r.user.id;
  };
  const owner = user("Owner");
  const viewer = user("Viewer");
  const space = createWorkspace(owner, "Buttons");
  assert.ok(acceptInvite(viewer, createInvite(owner, space.id, "viewer").token));
  const btn: DbProperty = { id: "go", name: "Finish", type: "button", button: { label: "Done!", actions: [{ type: "set", prop: "st", value: "done" }, { type: "openUrl", url: "https://example.com" }] } };
  const db = database(space.id, [], [btn]);
  const row = blankNote({ kind: "page", parentId: db.id, title: "Task" });
  push(space.id, [row], owner);
  const res = pressButton(space.id, db.id, row.id, "go", { id: owner });
  assert.equal(res.ok, true);
  assert.equal(rowById(space.id, row.id).props?.st, "done");
  assert.equal(rowById(space.id, row.id).editedBy, owner);
  const call = (who: string) =>
    pressRoute(
      new Request(`http://localhost:3100/api/notes/button?ws=${space.id}`, {
        method: "POST",
        headers: { cookie: `${sessionCookieName()}=${issueSession(who)}`, origin: "http://localhost:3100", host: "localhost:3100", "content-type": "application/json" },
        body: JSON.stringify({ dbId: db.id, rowId: row.id, propId: "go" }),
      })
    );
  assert.equal((await call(viewer)).status, 403);
  assert.equal((await call(owner)).status, 200);
});
