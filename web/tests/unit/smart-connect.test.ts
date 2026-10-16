// The automations hub joined to the rest of zvena: numbers from Calendar and Mail,
// issues that follow Design comments and meetings, and Documents' database
// automations in the journal (with Undo) and under "run only if …".
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { CalAccess } from "@/lib/calendar/access";
import { ensureDefault, savePrefs } from "@/lib/calendar/calendars";
import { afterWrite } from "@/lib/calendar/effects";
import { createEvent, updateEvent } from "@/lib/calendar/events";
import { atMinute, addDays, dayOf } from "@/lib/calendar/tz";
import { issueFromEvent } from "@/lib/eco/calendar";
import { ecoDb } from "@/lib/eco/schema";
import { metricsOf, setSmart } from "@/lib/decide/engine";
import { followThreads } from "@/lib/decide/flows";
import { hubSettings, setHubSettings, startHub } from "@/lib/decide/hub";
import { resetSmart } from "@/lib/decide/smart";
import { activityOf, settle } from "@/lib/decide/journal";
import { forgetSeen, saveSource, visibleMetrics } from "@/lib/decide/sources";
import { sanitizeNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, getIssueBrief, updateIssue } from "@/lib/projects/issues";
import { createTeam, listStatuses } from "@/lib/projects/teams";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

async function until(ok: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `jc-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const NY = "America/New_York";
const owner = person("Ada");
const mate = person("Bo");
const stranger = person("Cy");
const ws = createWorkspace(owner, "Connected").id;
acceptInvite(mate, createInvite(owner, ws, "editor")!.token);
savePrefs(owner, { tz: NY });
savePrefs(mate, { tz: NY });
const as = (u: string, need: "read" | "edit" = "edit") => ctxFor(u, ws, need);
const team = createTeam(as(owner), { name: "Ops", key: "OPS" }, "en");
const cat = (id: string) => listStatuses(as(owner, "read")).find((s) => s.id === getIssueBrief(as(owner, "read"), id).statusId)?.category;
const cal = (u: string) => new CalAccess(u, ws);

delete process.env.ZVENA_AI_KEY;
startHub();

test("a calendar is a live number: meetings in a window, by title, only for people who can read the calendar", async () => {
  const mine = ensureDefault(cal(owner), "Ada", NY)!;
  const day = addDays(dayOf(Date.now(), NY), 2);
  const at = (h: number) => atMinute(day, h * 60, NY);
  createEvent(cal(owner), { calId: mine.id, title: "Customer call: Acme", start: at(10), end: at(11), tz: NY });
  createEvent(cal(owner), { calId: mine.id, title: "Lunch", start: at(12), end: at(13), tz: NY });
  const s = saveSource(ws, { kind: "calendar", cal: mine.id, period: "next7", measure: "events", match: "customer call", tz: "UTC" }, owner);
  assert.ok(!("error" in s), JSON.stringify(s));
  assert.equal(s.value, 1);
  const hours = saveSource(ws, { kind: "calendar", cal: mine.id, period: "next7", measure: "hours" }, owner);
  assert.ok(!("error" in hours));
  assert.equal(hours.value, 2);
  // A new customer call: the number follows (the calendar's pulse).
  const out = createEvent(cal(owner), { calId: mine.id, title: "customer call: Beta", start: at(15), end: at(16), tz: NY });
  afterWrite({ ws, by: owner, seriesIds: out.seriesIds, calIds: out.calIds, notifyGuests: false });
  await until(() => metricsOf(ws).find((m) => m.key === s.key)?.value === 2);
  assert.equal(metricsOf(ws).find((m) => m.key === s.key)?.value, 2);
  // Ada's default calendar is hers: Bo cannot read it, so he does not see its number.
  forgetSeen();
  const seen = visibleMetrics(ws, mate, metricsOf(ws)).map((m) => m.key);
  assert.ok(!seen.includes(s.key));
  assert.ok(visibleMetrics(ws, owner, metricsOf(ws)).some((m) => m.key === s.key));
});

test("mail is a number its owner alone sees, and never a browser's word on whose mailbox", () => {
  const s = saveSource(ws, { kind: "mail", view: "inbox", measure: "unread", user: mate }, owner);
  assert.ok(!("error" in s), JSON.stringify(s));
  assert.equal(s.value, 0);
  const row = sql("SELECT json FROM dz_sources WHERE ws = ? AND key = ?").get(ws, s.key) as { json: string };
  assert.equal(JSON.parse(row.json).user, owner, "the mailbox is the saver's own");
  forgetSeen();
  assert.ok(visibleMetrics(ws, owner, metricsOf(ws)).some((m) => m.key === s.key));
  assert.ok(!visibleMetrics(ws, mate, metricsOf(ws)).some((m) => m.key === s.key), "nobody else, even when their own count would be the same");
});

test("an issue made from a meeting moves with it; a date set by hand stays; Undo puts it back", async () => {
  const mine = ensureDefault(cal(owner), "Ada", NY)!;
  const day = addDays(dayOf(Date.now(), NY), 3);
  const ev = createEvent(cal(owner), { calId: mine.id, title: "Launch review", start: atMinute(day, 600, NY), end: atMinute(day, 660, NY), tz: NY });
  const card = await issueFromEvent({ userId: owner, name: "Ada", wsId: ws, locale: "en" }, { event: ev.id, teamId: team.id });
  const issueId = card.key.split(":")[1];
  assert.equal(getIssueBrief(as(owner, "read"), issueId).dueDate, day);
  const later = addDays(day, 2);
  const moved = updateEvent(cal(owner), ev.id, { start: atMinute(later, 600, NY), end: atMinute(later, 660, NY) });
  afterWrite({ ws, by: owner, seriesIds: moved.seriesIds, calIds: moved.calIds, notifyGuests: false });
  await until(() => getIssueBrief(as(owner, "read"), issueId).dueDate === later);
  assert.equal(getIssueBrief(as(owner, "read"), issueId).dueDate, later, "the due date followed the meeting");
  const item = activityOf(ws, owner).find((a) => a.kind === "issue_flow" && a.subject === `issue:${issueId}`);
  assert.ok(item?.canUndo);
  assert.equal(item.detail.why, "event_moved");
  assert.equal(settle(ws, item.id, "undo", owner), "undone");
  assert.equal(getIssueBrief(as(owner, "read"), issueId).dueDate, day, "Undo puts the date back");
  // A date someone sets by hand is theirs: the meeting moving again leaves it.
  updateIssue(as(owner), issueId, { dueDate: addDays(day, 10) });
  const again = updateEvent(cal(owner), ev.id, { start: atMinute(addDays(day, 1), 600, NY), end: atMinute(addDays(day, 1), 660, NY) });
  afterWrite({ ws, by: owner, seriesIds: again.seriesIds, calIds: again.calIds, notifyGuests: false });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getIssueBrief(as(owner, "read"), issueId).dueDate, addDays(day, 10));
  // The owner can turn it off.
  setHubSettings(ws, { calendar: false }, owner);
  assert.equal(hubSettings(ws).calendar, false);
  setHubSettings(ws, { calendar: true }, owner);
});

test("an issue made from a Design comment closes when the thread is resolved and reopens with it", async () => {
  let resolved = true;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw) as { threadId: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: b.threadId, fileId: FILE, teamId: null, isResolved: resolved, comments: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { PENPOT_MGMT_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, PENPOT_MGMT_KEY: "k" });
  const FILE = "0e0e0e0e-1111-4222-8333-444444444444";
  const THREAD = "0e0e0e0e-5555-4666-8777-888888888888";
  try {
    const issue = createIssue(as(owner), { teamId: team.id, title: "Fix the hero spacing" });
    ecoDb();
    sql("INSERT INTO eco_design_threads (ws_id, thread_id, issue_id, file_id, created_by, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?, 0)").run(ws, THREAD, issue.id, FILE, owner, Date.now());
    assert.equal(await followThreads(ws, FILE, mate), 1);
    assert.equal(cat(issue.id), "completed", "resolved in Design: done here");
    const item = activityOf(ws, owner).find((a) => a.kind === "issue_flow" && a.subject === `issue:${issue.id}`);
    assert.equal(item?.detail.why, "thread_resolved");
    // Nothing changed: nothing happens.
    assert.equal(await followThreads(ws, FILE, mate), 0);
    resolved = false;
    assert.equal(await followThreads(ws, FILE, mate), 1);
    assert.notEqual(cat(issue.id), "completed", "reopened in Design: open here again");
    // Someone outside the workspace (or Design itself) resolved it: the issue's maker acts.
    resolved = true;
    assert.equal(await followThreads(ws, FILE, stranger, () => true, THREAD), 1);
    assert.equal(cat(issue.id), "completed");
    resolved = false;
    assert.equal(await followThreads(ws, FILE, "design", () => true, THREAD), 1);
    assert.notEqual(cat(issue.id), "completed");
    // Only the thread Design named is followed.
    resolved = true;
    assert.equal(await followThreads(ws, FILE, mate, () => true, "0e0e0e0e-9999-4999-8999-999999999999"), 0);
    // Off: the thread's state is kept, the issue is left alone.
    setHubSettings(ws, { design: false }, owner);
    assert.equal(await followThreads(ws, FILE, mate, (w) => hubSettings(w).design), 0);
    setHubSettings(ws, { design: true }, owner);
  } finally {
    delete process.env.PENPOT_MGMT_URL;
    delete process.env.PENPOT_MGMT_KEY;
    server.close();
  }
});

let n = 0;
function note(over: Partial<Note> & { id: string; kind: Note["kind"] }): Note {
  const now = Date.now();
  return sanitizeNote({ title: "", parentId: null, icon: "", cover: null, content: [], order: ++n, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, ...over }) as Note;
}
const DB = "jcdb000000000000000000000000tickets";
const tickets = (automations: unknown[]) =>
  note({
    id: DB,
    kind: "database",
    title: "Tickets",
    db: {
      properties: [
        { id: "title", name: "Ticket", type: "title" },
        { id: "kind", name: "Kind", type: "select", options: [{ id: "bug", name: "Bug", color: "red" }, { id: "ask", name: "Question", color: "blue" }] },
        { id: "who", name: "Reporter", type: "person" },
        { id: "body", name: "Details", type: "text" },
      ],
      views: [{ id: "v1", name: "All", type: "table", filters: [], sorts: [] }],
      automations,
    } as unknown as Note["db"],
  });
const ticket = (id: string, title: string, extra: Record<string, unknown> = {}) => note({ id, kind: "page", title, parentId: DB, props: { who: [mate], body: "The page crashes on save", ...extra } as Note["props"] });
const kindOf = (id: string) => (JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, id) as { json: string }).json) as Note).props?.kind;

test("a database automation's runs are in the journal, and Undo puts back what it set", async () => {
  pushNotes(ws, [{ id: DB, note: tickets([{ id: "a1", name: "Triage new tickets", on: true, trigger: { type: "added" }, actions: [{ type: "set", prop: "kind", value: "ask" }] }]) }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  const row = "jcrow00000000000000000000000000001";
  pushNotes(ws, [{ id: row, note: ticket(row, "How do I export?") }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  assert.equal(kindOf(row), "ask");
  const item = activityOf(ws, owner).find((a) => a.kind === "automation" && a.subject === `note:${row}`);
  assert.ok(item, "the run is on the list");
  assert.equal(item.detail.automation, "Triage new tickets");
  assert.equal(item.source, "rule");
  assert.ok(item.canUndo);
  assert.equal(settle(ws, item.id, "undo", owner), "undone");
  assert.equal(kindOf(row) ?? null, null, "Undo put the value back");
});

test("“run only if …”: sure runs it, less sure waits for a yes; only the named properties go out, never a person", async () => {
  type Body = { state: Record<string, unknown>; questions: Record<string, { type: string }> };
  const bodies: Body[] = [];
  let p = 0.97;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "model-test", answers: { yes: { type: "noul", noul: p } }, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { ZVENA_AI_KEY: "test-key", ZVENA_AI_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`, ZVENA_AI_TIMEOUT_MS: "800" });
  resetSmart();
  setSmart(ws, true, owner);
  try {
    const onlyIf = { question: "Is this a bug report?", fields: ["title", "body", "who"] };
    pushNotes(ws, [{ id: DB, note: tickets([{ id: "a2", name: "Mark bugs", on: true, trigger: { type: "added" }, onlyIf, actions: [{ type: "set", prop: "kind", value: "bug" }] }]) }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
    const sure = "jcrow00000000000000000000000000002";
    pushNotes(ws, [{ id: sure, note: ticket(sure, "Crash on save") }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
    await until(() => kindOf(sure) === "bug");
    assert.equal(kindOf(sure), "bug", "the model was sure: it ran");
    const sent = bodies[0];
    assert.deepEqual(Object.keys(sent.state).sort(), ["Details", "Ticket"], "the person column never goes out");
    const ran = activityOf(ws, owner).find((a) => a.kind === "automation" && a.subject === `note:${sure}`);
    assert.equal(ran?.source, "model");

    p = 0.7;
    const unsure = "jcrow00000000000000000000000000003";
    pushNotes(ws, [{ id: unsure, note: ticket(unsure, "Odd colours") }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
    await until(() => activityOf(ws, owner).some((a) => a.kind === "automation" && a.subject === `note:${unsure}` && a.canResolve));
    const waiting = activityOf(ws, owner).find((a) => a.kind === "automation" && a.subject === `note:${unsure}` && a.canResolve);
    assert.ok(waiting, "less sure: it waits for a person");
    assert.equal(kindOf(unsure) ?? null, null);
    assert.equal(settle(ws, waiting.id, "accept", mate), "applied");
    assert.equal(kindOf(unsure), "bug", "a yes runs it");

    // A yes given after the page changed is stale: nothing runs.
    const stale = "jcrow00000000000000000000000000006";
    pushNotes(ws, [{ id: stale, note: ticket(stale, "Slow search") }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
    await until(() => activityOf(ws, owner).some((a) => a.subject === `note:${stale}` && a.canResolve));
    const proposal = activityOf(ws, owner).find((a) => a.subject === `note:${stale}` && a.canResolve);
    assert.ok(proposal);
    pushNotes(ws, [{ id: stale, note: { ...ticket(stale, "Slow search — fixed itself"), updatedAt: Date.now() + 1 } }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
    assert.equal(settle(ws, proposal.id, "accept", mate), "gone");
    assert.equal(kindOf(stale) ?? null, null);

    p = 0.2;
    const no = "jcrow00000000000000000000000000004";
    pushNotes(ws, [{ id: no, note: ticket(no, "Thanks!") }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
    await until(() => bodies.length >= 4);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(kindOf(no) ?? null, null, "the condition does not hold: nothing ran");

    // Smart suggestions off in the workspace: such automations do not run at all.
    setSmart(ws, false, owner);
    const off = "jcrow00000000000000000000000000005";
    pushNotes(ws, [{ id: off, note: ticket(off, "Crash again") }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(bodies.length, 4, "nothing was sent");
    assert.equal(kindOf(off) ?? null, null);
  } finally {
    delete process.env.ZVENA_AI_KEY;
    resetSmart();
    server.close();
  }
});
