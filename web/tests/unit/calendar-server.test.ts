// zvena Calendar on the server: who may see and change what, repeating
// events edited this / following / all, undo, the ecosystem (cards, search,
// links, the live stream, Turn into issue), feeds, imports, subscriptions,
// CalDAV against a fake server, Docs databases as layers, scheduling links
// and bookings, reminders, and an account that goes.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { signInWith } from "@/lib/auth";
import { CalAccess, calendarPulseVisible, calRow } from "@/lib/calendar/access";
import { book, bookingByToken, cancelBooking, rescheduleBooking, saveLink, slotsOf, publicLink } from "@/lib/calendar/booking";
import { setDavTransport, connectAccount, linkRemote, syncCalendar, type DavAnswer } from "@/lib/calendar/caldav";
import { calendarOfFeed, createCalendar, ensureDefault, feedOf, resetFeed, revokeFeed, savePrefs, setShare, updateCalendar } from "@/lib/calendar/calendars";
import { afterWrite } from "@/lib/calendar/effects";
import { createEvent, deleteEvent, duplicateEvent, eventDetail, eventRow, listRange, rsvp, undo, updateEvent, CalError, type WriteOutcome } from "@/lib/calendar/events";
import { calendarIcs } from "@/lib/calendar/export";
import { importEvents, parseIcs } from "@/lib/calendar/ics";
import { addLayer, layerItems, listDatabases, moveDocRow } from "@/lib/calendar/layers";
import { dueReminders, sendDueReminders } from "@/lib/calendar/reminders";
import { open, seal } from "@/lib/calendar/seal";
import { importFile, refreshSubscription, subscribe } from "@/lib/calendar/subscriptions";
import { atMinute, wallOf } from "@/lib/calendar/tz";
import { issueFromEvent } from "@/lib/eco/calendar";
import { cardsFor } from "@/lib/eco/cards";
import { inboxOf } from "@/lib/eco/inbox";
import { linksOf } from "@/lib/eco/links";
import { searchAll } from "@/lib/eco/search";
import { keyVisible, registerEcoFilters } from "@/lib/eco/visibility";
import { sanitizeNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { listen, visibleTo, type PulseEvent } from "@/lib/pulse/bus";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";
import { TEST_DIR } from "./env";

const NY = "America/New_York";
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); !ok() && Date.now() - t0 < ms; ) await tick(5);
}

function person(name: string, email?: string): string {
  const r = signInWith(email ? { provider: "email", subject: email, name, email, emailVerified: true } : { provider: "dev", subject: `cal-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

const owner = person("Olivia Cal", "olivia@example.com");
const mate = person("Mason Cal", "mason@example.com");
const viewer = person("Vera Cal");
const outsider = person("Otto Cal");
const ws = createWorkspace(owner, "Calendar team").id;
acceptInvite(mate, createInvite(owner, ws, "editor").token);
acceptInvite(viewer, createInvite(owner, ws, "viewer").token);
const other = createWorkspace(outsider, "Elsewhere").id;
const acc = (u: string, w = ws) => new CalAccess(u, w);
savePrefs(owner, { tz: NY });
savePrefs(mate, { tz: NY });
const ownCal = ensureDefault(acc(owner), "Olivia Cal", NY)!;
const mateCal = ensureDefault(acc(mate), "Mason Cal", NY)!;
ensureDefault(acc(viewer), "Vera Cal", NY);
registerEcoFilters();

const at = (day: string, h: number, m = 0) => atMinute(day, h * 60 + m, NY);
const range = (u: string, from: string, to: string) => listRange({ acc: acc(u), tz: NY }, { from: at(from, 0), to: at(to, 0) });
const done = (o: WriteOutcome) => (afterWrite({ ws, by: owner, seriesIds: o.seriesIds, calIds: o.calIds, guests: o.guests, moved: o.moved, deleted: o.deleted, notifyGuests: false }), o);

test("a person's own calendar is made once; teammates see only free/busy by default; outsiders nothing", () => {
  assert.equal(ensureDefault(acc(owner), "x", NY)!.id, ownCal.id);
  const ev = createEvent(acc(owner), { calId: ownCal.id, title: "Salary review", start: at("2026-10-20", 10), end: at("2026-10-20", 11), tz: NY });
  assert.equal(acc(mate).level(ownCal), "busy");
  assert.equal(eventDetail(acc(mate), ev.id), null, "free/busy shows no details");
  assert.deepEqual(range(mate, "2026-10-19", "2026-10-26").filter((e) => e.id === ev.id), [], "not on a teammate's grid");
  assert.equal(acc(outsider).level(ownCal), null);
  assert.equal(new CalAccess(outsider, ws).member, false);
  // Another workspace's id never opens it.
  assert.equal(acc(owner, other).level(ownCal), null);
  assert.throws(() => updateEvent(acc(mate), ev.id, { title: "Mine now" }), (e: unknown) => e instanceof CalError && e.status === 404);
  assert.throws(() => deleteEvent(acc(mate), ev.id, {}), (e: unknown) => e instanceof CalError && e.status === 404);
});

test("sharing: view shows details, edit allows changes, a workspace viewer never edits; the owner alone shares", () => {
  const ev = createEvent(acc(owner), { calId: ownCal.id, title: "Planning", start: at("2026-10-21", 9), end: at("2026-10-21", 10), tz: NY });
  setShare(acc(owner), ownCal.id, mate, "view");
  assert.equal(eventDetail(acc(mate), ev.id)?.title, "Planning");
  assert.throws(() => updateEvent(acc(mate), ev.id, { title: "x" }), (e: unknown) => e instanceof CalError && e.status === 403);
  setShare(acc(owner), ownCal.id, mate, "edit");
  updateEvent(acc(mate), ev.id, { title: "Planning (moved)" });
  assert.equal(eventRow(ev.id)?.title, "Planning (moved)");
  updateCalendar(acc(owner), ownCal.id, { wsAccess: "edit" });
  assert.equal(acc(viewer).level(calRow(ownCal.id)!), "view", "a workspace viewer reads but never edits");
  assert.equal(acc(mate).level(calRow(ownCal.id)!), "edit");
  assert.throws(() => setShare(acc(mate), ownCal.id, viewer, "edit"), (e: unknown) => e instanceof CalError && e.status === 403);
  assert.throws(() => setShare(acc(owner), ownCal.id, outsider, "view"), (e: unknown) => e instanceof CalError && e.status === 400);
  updateCalendar(acc(owner), ownCal.id, { wsAccess: "busy" });
  setShare(acc(owner), ownCal.id, mate, null);
  assert.equal(acc(mate).level(calRow(ownCal.id)!), "busy");
});

test("a weekly series: move one occurrence, change this and following, delete one, change all", () => {
  const a = acc(owner);
  const s = createEvent(a, { calId: ownCal.id, title: "Standup", start: at("2026-10-26", 9), end: at("2026-10-26", 9, 15), tz: NY, rrule: "FREQ=WEEKLY;BYDAY=MO,WE" });
  const week = () => range(owner, "2026-10-26", "2026-11-12").filter((e) => e.title.startsWith("Standup"));
  assert.equal(week().length, 6);
  // Every occurrence at 9:00 New York, through the end of daylight saving (Nov 1).
  for (const o of week()) assert.equal(wallOf(o.start, NY).h, 9);
  // This event: Wednesday Oct 28 moves to 10:00.
  const wed = week()[1];
  const moved = updateEvent(a, s.id, { scope: "this", occ: wed.occ, start: at("2026-10-28", 10), end: at("2026-10-28", 10, 15) });
  assert.notEqual(moved.id, s.id, "an override of its own");
  const after = week();
  assert.equal(after.length, 6, "not shown twice");
  assert.equal(wallOf(after[1].start, NY).h, 10);
  assert.equal(after[1].occ, wed.occ);
  // Delete one occurrence.
  deleteEvent(a, s.id, { scope: "this", occ: after[2].occ });
  assert.equal(week().length, 5);
  // This and following from Wednesday Nov 4: renamed, the earlier ones untouched.
  const nov4 = week().find((o) => o.startDay === "2026-11-04")!;
  const split = updateEvent(a, s.id, { scope: "following", occ: nov4.occ, title: "Standup v2" });
  const titles = week().map((o) => `${o.startDay} ${o.title}`);
  assert.deepEqual(titles, ["2026-10-26 Standup", "2026-10-28 Standup", "2026-11-04 Standup v2", "2026-11-09 Standup v2", "2026-11-11 Standup v2"]);
  assert.notEqual(split.id, s.id);
  // All events of the new series move to 8:30 (dragging one moves all by the same wall-clock shift).
  const one = week().find((o) => o.startDay === "2026-11-09")!;
  updateEvent(a, split.id, { scope: "all", occ: one.occ, start: at("2026-11-09", 8, 30), end: at("2026-11-09", 8, 45) });
  const v2 = week().filter((o) => o.title === "Standup v2");
  assert.deepEqual(v2.map((o) => `${o.startDay} ${wallOf(o.start, NY).h}:${wallOf(o.start, NY).mi}`), ["2026-11-04 8:30", "2026-11-09 8:30", "2026-11-11 8:30"]);
  // Dragging a Monday occurrence to Tuesday for all events moves the weekday of the rule too.
  const mon = week().find((o) => o.startDay === "2026-11-09")!;
  updateEvent(a, split.id, { scope: "all", occ: mon.occ, start: at("2026-11-10", 8, 30), end: at("2026-11-10", 8, 45) });
  assert.match(eventRow(split.id)!.rrule!, /BYDAY=TU,TH/);
});

test("undo puts back exactly what a write changed, and only for the person who wrote", () => {
  const a = acc(owner);
  const s = createEvent(a, { calId: ownCal.id, title: "Retro", start: at("2026-11-02", 15), end: at("2026-11-02", 16), tz: NY, rrule: "FREQ=WEEKLY;COUNT=4" });
  const before = range(owner, "2026-11-01", "2026-12-01").filter((e) => e.title === "Retro").map((e) => e.start);
  const occ = range(owner, "2026-11-01", "2026-12-01").filter((e) => e.title === "Retro")[2].occ;
  const split = updateEvent(a, s.id, { scope: "following", occ, start: at("2026-11-16", 17), end: at("2026-11-16", 18) });
  assert.notDeepEqual(range(owner, "2026-11-01", "2026-12-01").filter((e) => e.title === "Retro").map((e) => e.start), before);
  assert.equal(undo(acc(mate), split.undo), null, "someone else's undo");
  assert.ok(undo(a, split.undo));
  assert.deepEqual(range(owner, "2026-11-01", "2026-12-01").filter((e) => e.title === "Retro").map((e) => e.start), before);
  const del = deleteEvent(a, s.id, { scope: "all" });
  assert.equal(range(owner, "2026-11-01", "2026-12-01").filter((e) => e.title === "Retro").length, 0);
  undo(a, del.undo);
  assert.equal(range(owner, "2026-11-01", "2026-12-01").filter((e) => e.title === "Retro").length, 4);
  const created = createEvent(a, { calId: ownCal.id, title: "Oops", start: at("2026-11-03", 9), end: at("2026-11-03", 10), tz: NY });
  undo(a, created.undo);
  assert.ok(eventRow(created.id)?.deleted_at);
});

test("all-day events and duplicates; guests (members) see an invitation and answer it", () => {
  const a = acc(owner);
  const trip = createEvent(a, { calId: ownCal.id, title: "Offsite", allDay: true, startDay: "2026-12-07", endDay: "2026-12-10", tz: NY, attendees: [{ userId: mate }, { email: "guest@example.org" }] });
  const items = range(owner, "2026-12-08", "2026-12-09").filter((e) => e.id === trip.id);
  assert.equal(items.length, 1);
  assert.ok(items[0].allDay && items[0].endDay === "2026-12-10");
  // Mason reads only free/busy of the calendar, but sees the event he is invited to.
  const his = range(mate, "2026-12-07", "2026-12-08").find((e) => e.id === trip.id);
  assert.ok(his?.invited && his.rsvp === "needs-action");
  assert.ok(eventDetail(acc(mate), trip.id)?.canRsvp);
  rsvp(acc(mate), trip.id, "accepted");
  assert.equal(eventDetail(acc(owner), trip.id)?.attendees.find((g) => g.userId === mate)?.rsvp, "accepted");
  assert.throws(() => rsvp(acc(viewer), trip.id, "accepted"), (e: unknown) => e instanceof CalError);
  const copy = duplicateEvent(a, trip.id, null);
  assert.equal(eventRow(copy.id)?.title, "Offsite");
  assert.equal(eventRow(copy.id)?.start_day, "2026-12-07");
  assert.throws(() => createEvent(a, { calId: ownCal.id, title: "Bad", allDay: true, startDay: "2026-12-07", endDay: "2026-12-07" }), (e: unknown) => e instanceof CalError && e.status === 400);
  assert.throws(() => createEvent(a, { calId: ownCal.id, title: "Bad", start: 10, end: 5 }), (e: unknown) => e instanceof CalError);
  assert.throws(() => createEvent(a, { calId: ownCal.id, title: "Bad", conference: "javascript:alert(1)" }), (e: unknown) => e instanceof CalError);
  assert.throws(() => createEvent(acc(mate), { calId: ownCal.id, title: "Not mine" }), (e: unknown) => e instanceof CalError && e.status === 404, "free/busy: not even told it exists");
});

test("ecosystem: cards and search follow the calendar's rule; links from descriptions; event keys on the stream", async () => {
  const a = acc(owner);
  const note = sanitizeNote({ id: "ca1e0000000000000000000000000001", kind: "page", title: "Launch brief", parentId: null, icon: "", cover: null, content: [], order: 1, favorite: false, createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null }) as Note;
  pushNotes(ws, [{ id: note.id, note }], { by: owner, quotaLeft: Infinity });
  const ev = done(createEvent(a, { calId: ownCal.id, title: "Zebra launch sync", description: `See [the brief](/docs?ws=${ws}#Launch-brief-${note.id}) and ask [@ id="${mate}" label="Mason"]`, start: at("2026-11-20", 13), end: at("2026-11-20", 14), tz: NY }));
  const v = (u: string) => ({ userId: u, wsId: ws, locale: "en" as const });
  assert.equal((await cardsFor(v(owner), [`event:${ev.id}`])).length, 1);
  assert.deepEqual(await cardsFor(v(mate), [`event:${ev.id}`]), [], "free/busy only: no card");
  assert.deepEqual(await cardsFor({ userId: outsider, wsId: ws, locale: "en" }, [`event:${ev.id}`]), []);
  const mine = (await searchAll(v(owner), "Zebra launch")).hits.filter((h) => h.kind === "event");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].url, `/calendar?ws=${ws}&event=${ev.id}`);
  assert.deepEqual((await searchAll(v(mate), "Zebra launch")).hits.filter((h) => h.kind === "event"), [], "search shows only what one may open");
  const links = linksOf(ws, `event:${ev.id}`).map((l) => `${l.dst}|${l.via}`);
  assert.ok(links.includes(`note:${note.id}|link`), links.join(","));
  assert.ok(links.includes(`user:${mate}|mention`), links.join(","));
  assert.equal(keyVisible(owner, ws, `event:${ev.id}`), true);
  assert.equal(keyVisible(mate, ws, `event:${ev.id}`), false, "links pokes about a private event stay private");
  // The live stream: a calendar poke reaches who can see the calendar at all.
  const e: PulseEvent = { id: 1, ws, type: "calendar", ref: ownCal.id, refs: [ev.id], at: Date.now() };
  assert.equal(visibleTo(owner, e), true);
  assert.equal(visibleTo(mate, e), true, "free/busy: the overlay changes");
  assert.equal(visibleTo(outsider, e), false);
  updateCalendar(a, ownCal.id, { wsAccess: "none" });
  assert.equal(calendarPulseVisible(mate, e), false, "a private calendar's moves are not told");
  updateCalendar(a, ownCal.id, { wsAccess: "busy" });
  // A deleted event loses its search row.
  done(deleteEvent(a, ev.id, {}));
  assert.deepEqual((await searchAll(v(owner), "Zebra launch")).hits.filter((h) => h.kind === "event"), []);
});

test("Turn into issue: due on the event's day, quoted inert, linked as converted; nothing from an event one cannot open", async () => {
  const a = acc(owner);
  const ev = done(createEvent(a, { calId: ownCal.id, title: "Vendor call", description: "Discuss ![x](https://evil.example/t.png) and [@ id=\"x\" label=\"y\"]", start: at("2026-11-24", 11), end: at("2026-11-24", 12), tz: NY }));
  const card = await issueFromEvent({ userId: owner, name: "Olivia", wsId: ws, locale: "en" }, { event: ev.id });
  assert.equal(card.kind, "issue");
  assert.equal(card.due, "2026-11-24");
  assert.ok(linksOf(ws, `event:${ev.id}`).some((l) => l.dst === card.key && l.via === "converted"));
  const desc = (sql("SELECT description FROM pj_issues WHERE id = ?").get(card.key.slice(6)) as { description: string }).description;
  assert.ok(!desc.includes("![x](") && !desc.includes("evil.example") && !desc.includes("[@ "), "the quote cannot become an image or a mention");
  await assert.rejects(() => issueFromEvent({ userId: mate, name: "Mason", wsId: ws, locale: "en" }, { event: ev.id }), /event not found/);
});

test("reminders reach the owner's Inbox once per occurrence (the one Inbox)", async () => {
  const a = acc(owner);
  const start = Date.now() + 9 * 60_000;
  const ev = done(createEvent(a, { calId: ownCal.id, title: "Dentist", start, end: start + 1_800_000, tz: NY, reminders: [{ min: 10, how: "inbox" }] }));
  assert.ok(dueReminders(Date.now()).some((d) => d.row.id === ev.id));
  assert.ok(sendDueReminders(Date.now()) >= 1);
  assert.equal(sendDueReminders(Date.now()), 0, "sent once");
  const inbox = await inboxOf({ userId: owner, wsId: ws, locale: "en" });
  const item = inbox.items.find((i) => i.card?.key === `event:${ev.id}`);
  assert.equal(item?.kind, "reminder");
  assert.match(item?.text ?? "", /Dentist/);
});

test("the secret feed: an ICS of the calendar, by a token only its owner sees; reset and off stop the old address", () => {
  const a = acc(owner);
  createEvent(a, { calId: ownCal.id, title: "Feed check", start: at("2026-12-01", 9), end: at("2026-12-01", 10), tz: NY });
  assert.throws(() => resetFeed(acc(mate), ownCal.id), (e: unknown) => e instanceof CalError && e.status === 404);
  const url = resetFeed(a, ownCal.id);
  const token = url.split("/").pop()!.replace(/\.ics$/, "");
  assert.equal(feedOf(a, ownCal.id), url);
  const cal = calendarOfFeed(token)!;
  assert.equal(cal.id, ownCal.id);
  const ics = calendarIcs(cal);
  assert.match(ics, /SUMMARY:Feed check/);
  assert.equal(importEvents(parseIcs(ics), "UTC").some((e) => e.title === "Feed check"), true);
  // The database keeps no token in the clear.
  const row = sql("SELECT feed_hash, feed_token FROM cal_calendars WHERE id = ?").get(ownCal.id) as { feed_hash: string; feed_token: string };
  assert.ok(!row.feed_hash.includes(token) && !row.feed_token.includes(token));
  const again = resetFeed(a, ownCal.id);
  assert.equal(calendarOfFeed(token), null, "a reset address stops the old one");
  revokeFeed(a, ownCal.id);
  assert.equal(calendarOfFeed(again.split("/").pop()!.replace(/\.ics$/, "")), null);
  assert.equal(calendarOfFeed("short"), null);
  // Sealed values open only for their row.
  const s = seal("app-password", "caldav:a");
  assert.equal(open(s, "caldav:a"), "app-password");
  assert.equal(open(s, "caldav:b"), null);
  assert.equal(open(`${s.slice(0, -2)}xx`, "caldav:a"), null);
});

test("import an .ics file into one's own calendar; never into a subscription or someone else's", () => {
  const text = buildSample();
  const res = importFile(acc(owner), ownCal.id, text);
  assert.equal(res.added, 2);
  assert.equal(importFile(acc(owner), ownCal.id, text).added, 0, "the same UIDs update, not duplicate");
  assert.ok(range(owner, "2027-01-01", "2027-01-31").some((e) => e.title === "Imported weekly"));
  assert.throws(() => importFile(acc(mate), ownCal.id, text), (e: unknown) => e instanceof CalError);
  assert.throws(() => importFile(acc(owner), ownCal.id, "not a calendar"), (e: unknown) => e instanceof CalError && e.status === 400);
});

function buildSample(): string {
  return [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:imp-1@example.org",
    "DTSTART;TZID=America/New_York:20270104T100000",
    "DTEND;TZID=America/New_York:20270104T103000",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "SUMMARY:Imported weekly",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:imp-2@example.org",
    "DTSTART;VALUE=DATE:20270115",
    "DTEND;VALUE=DATE:20270116",
    "SUMMARY:Imported day",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

test("subscriptions: fetched through the guard, read-only, replaced on refresh; private addresses are refused", async () => {
  let body = buildSample();
  const fake = async () => ({ url: "https://feeds.example.org/x.ics", contentType: "text/calendar", body: Buffer.from(body), truncated: false });
  await assert.rejects(() => subscribe(acc(owner), { url: "http://127.0.0.1/cal.ics" }, fake), /bad url/);
  await assert.rejects(() => subscribe(acc(owner), { url: "http://10.0.0.5/cal.ics" }, fake), /bad url/);
  await assert.rejects(() => subscribe(acc(owner), { url: "file:///etc/passwd" }, fake), /bad url/);
  const info = await subscribe(acc(owner), { url: "webcal://feeds.example.org/x.ics", name: "Holidays" }, fake);
  assert.equal(info.kind, "ics");
  assert.ok(info.readOnly);
  assert.equal(info.wsAccess, "none", "a subscription is private by default");
  const ev = range(owner, "2027-01-01", "2027-01-31").find((e) => e.calId === info.id && e.title === "Imported day")!;
  assert.ok(ev && !ev.canEdit);
  assert.throws(() => updateEvent(acc(owner), ev.id, { title: "x" }), (e: unknown) => e instanceof CalError && e.status === 403);
  body = buildSample().replace(/BEGIN:VEVENT\r\nUID:imp-2[\s\S]*?END:VEVENT\r\n/, "");
  sql("UPDATE cal_calendars SET synced_at = 0 WHERE id = ?").run(info.id);
  const r = await refreshSubscription(info.id, fake);
  assert.ok(r.ok);
  assert.equal(r.result?.removed, 1);
  assert.equal(range(owner, "2027-01-01", "2027-01-31").some((e) => e.calId === info.id && e.title === "Imported day"), false);
});

test("CalDAV: discover, sync in, send a local change back, follow a delete on the server", async () => {
  // A tiny CalDAV server: one calendar, resources by href.
  const store = new Map<string, { etag: string; ics: string }>();
  store.set("/cal/home/work/abc.ics", { etag: '"1"', ics: ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:abc", "DTSTART:20261201T150000Z", "DTEND:20261201T160000Z", "SUMMARY:From iCloud", "END:VEVENT", "END:VCALENDAR"].join("\r\n") });
  let ctag = 1;
  const seen: string[] = [];
  const ms = (body: string): DavAnswer => ({ status: 207, headers: {}, body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${body}</d:multistatus>` });
  const fake = (user: string, pass: string) => async (method: string, url: string, headers: Record<string, string>, body?: string): Promise<DavAnswer> => {
    const path = new URL(url).pathname;
    seen.push(`${method} ${path}`);
    if (user !== "olivia" || pass !== "app-pass") return { status: 401, headers: {}, body: "" };
    if (method === "PROPFIND" && body?.includes("current-user-principal")) return ms(`<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/olivia/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    if (method === "PROPFIND" && body?.includes("calendar-home-set")) return ms(`<d:response><d:href>/principals/olivia/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/cal/home/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    if (method === "PROPFIND" && headers.depth === "1") return ms(`<d:response><d:href>/cal/home/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/cal/home/work/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work &amp; more</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    if (method === "PROPFIND") return ms(`<d:response><d:href>/cal/home/work/</d:href><d:propstat><d:prop><cs:getctag>${ctag}</cs:getctag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    if (method === "REPORT") return ms([...store].map(([href, r]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${r.etag}</d:getetag><c:calendar-data><![CDATA[${r.ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join(""));
    if (method === "PUT") {
      const cur = store.get(path);
      if (headers["if-match"] && cur?.etag !== headers["if-match"]) return { status: 412, headers: {}, body: "" };
      store.set(path, { etag: `"${++ctag}"`, ics: body ?? "" });
      return { status: 201, headers: { etag: `"${ctag}"` }, body: "" };
    }
    if (method === "DELETE") {
      store.delete(path);
      ctag++;
      return { status: 204, headers: {}, body: "" };
    }
    return { status: 405, headers: {}, body: "" };
  };
  setDavTransport(fake);
  try {
    await assert.rejects(() => connectAccount(acc(owner), { serverUrl: "https://caldav.example.com/", username: "olivia", password: "wrong" }), /wrong user name or password/);
    await assert.rejects(() => connectAccount(acc(owner), { serverUrl: "http://caldav.example.com/", username: "olivia", password: "app-pass" }), /https/);
    const { accountId, calendars } = await connectAccount(acc(owner), { serverUrl: "https://caldav.example.com/", username: "olivia", password: "app-pass" });
    assert.deepEqual(calendars.map((c) => c.name), ["Work & more"]);
    // The password is kept sealed.
    const secret = (sql("SELECT secret FROM cal_accounts WHERE id = ?").get(accountId) as { secret: string }).secret;
    assert.ok(!secret.includes("app-pass"));
    const info = await linkRemote(acc(owner), accountId, { href: calendars[0].href });
    assert.equal(info.kind, "caldav");
    const pulled = range(owner, "2026-12-01", "2026-12-02").find((e) => e.calId === info.id);
    assert.equal(pulled?.title, "From iCloud");
    // A local change goes back with If-Match.
    const out = updateEvent(acc(owner), pulled!.id, { title: "Renamed here" });
    afterWrite({ ws, by: owner, seriesIds: out.seriesIds, calIds: out.calIds, notifyGuests: false });
    await syncCalendar(info.id);
    assert.match(store.get("/cal/home/work/abc.ics")!.ics, /SUMMARY:Renamed here/);
    // A new local event is created on the server.
    const fresh = createEvent(acc(owner), { calId: info.id, title: "Made in zvena", start: at("2026-12-02", 9), end: at("2026-12-02", 10), tz: NY });
    afterWrite({ ws, by: owner, seriesIds: fresh.seriesIds, calIds: fresh.calIds, notifyGuests: false });
    await syncCalendar(info.id);
    assert.ok([...store.values()].some((r) => /SUMMARY:Made in zvena/.test(r.ics)));
    // Deleted on the server: gone here after the next sync.
    store.delete("/cal/home/work/abc.ics");
    ctag++;
    await syncCalendar(info.id);
    assert.equal(range(owner, "2026-12-01", "2026-12-02").some((e) => e.calId === info.id && e.title === "Renamed here"), false);
  } finally {
    setDavTransport(null);
  }
});

test("a Docs database as a layer: rows show, dragging writes through Documents with the person's access", async () => {
  const now = Date.now();
  const db = sanitizeNote({ id: "caldb0000000000000000000000000001", kind: "database", title: "Content plan", parentId: null, icon: "", cover: null, content: [], order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "when", name: "Publish", type: "date" }], views: [] } }) as Note;
  const row = sanitizeNote({ id: "calrow0000000000000000000000000001", kind: "page", title: "Blog post", parentId: db.id, icon: "", cover: null, content: [], props: { when: { start: "2026-12-03" } }, order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null }) as Note;
  pushNotes(ws, [{ id: db.id, note: db }, { id: row.id, note: row }], { by: owner, quotaLeft: Infinity });
  assert.ok(listDatabases(acc(owner)).some((d) => d.id === db.id && d.props[0].id === "when"));
  addLayer(acc(owner), { kind: "docs", ref: db.id, prop: "when" });
  const items = await layerItems(acc(owner), "en", "2026-12-01", "2026-12-31");
  const it = items.find((i) => i.key === `doc:${row.id}`);
  assert.ok(it && it.canEdit && it.start === "2026-12-03");
  const v = await moveDocRow({ id: owner, name: "Olivia" }, ws, { dbId: db.id, rowId: row.id, propId: "when", start: "2026-12-05T10:00", end: "2026-12-05T11:00" });
  assert.equal(v.start, "2026-12-05T10:00");
  // A viewer cannot move it (Documents says no).
  await assert.rejects(() => moveDocRow({ id: viewer, name: "Vera" }, ws, { dbId: db.id, rowId: row.id, propId: "when", start: "2026-12-06" }), (e: unknown) => e instanceof CalError && e.status === 403);
  await assert.rejects(() => moveDocRow({ id: outsider, name: "Otto" }, ws, { dbId: db.id, rowId: row.id, propId: "when", start: "2026-12-06" }), (e: unknown) => e instanceof CalError && e.status === 404);
  await assert.rejects(() => moveDocRow({ id: owner, name: "Olivia" }, ws, { dbId: db.id, rowId: row.id, propId: "when", start: "not a date" }), (e: unknown) => e instanceof CalError && e.status === 400);
  // Someone without access to the database cannot even add it.
  assert.throws(() => addLayer(acc(outsider, other), { kind: "docs", ref: db.id, prop: "when" }), (e: unknown) => e instanceof CalError);
});

test("a scheduling link: free times only, a booking makes the event and letters, cancel and reschedule by the private link", async () => {
  const a = acc(mate);
  const link = saveLink(a, null, { title: "Intro call", duration: 30, step: 30, noticeMin: 0, windowDays: 60, tz: NY, weekly: { 1: [[540, 660]], 2: [[540, 660]], 3: [[540, 660]], 4: [[540, 660]], 5: [[540, 660]] } }, "Mason Cal");
  assert.ok(publicLink(link.slug));
  // Mason is busy 9:30–10:00 on Monday Dec 14.
  createEvent(a, { calId: mateCal.id, title: "Private: therapy", start: at("2026-12-14", 9, 30), end: at("2026-12-14", 10), tz: NY });
  const lr = publicLink(link.slug)!.row;
  const day = slotsOf(lr, at("2026-12-14", 0), at("2026-12-15", 0), at("2026-12-01", 8));
  const hhmm = (ms: number) => `${wallOf(ms, NY).h}:${String(wallOf(ms, NY).mi).padStart(2, "0")}`;
  assert.deepEqual(day.map(hhmm), ["9:00", "10:00", "10:30"]);
  // The answer is bare times: nothing of the busy event.
  assert.ok(!JSON.stringify(day).includes("therapy"));
  const outbox = join(TEST_DIR, "outbox");
  // Other test files write letters to the same outbox at the same time: the new ones are those not there before.
  const seen = new Set(safeList(outbox));
  const res = await book(link.slug, { start: day[1], name: "Grace Guest", email: "grace@example.net", note: "Let's talk [click](https://evil.example)", tz: "Europe/Paris", locale: "fr" }, at("2026-12-01", 8));
  assert.ok(res.manage.includes(`/cal/${link.slug}/`));
  await assert.rejects(() => book(link.slug, { start: day[1], name: "Second", email: "second@example.net" }, at("2026-12-01", 8)), /taken/);
  await assert.rejects(() => book(link.slug, { start: day[0] + 60_000, name: "Odd", email: "odd@example.net" }, at("2026-12-01", 8)), /taken/);
  await assert.rejects(() => book(link.slug, { start: day[0], name: "", email: "x" }, at("2026-12-01", 8)), /bad request/);
  const ev = range(mate, "2026-12-14", "2026-12-15").find((e) => e.title.startsWith("Intro call"))!;
  assert.equal(ev.start, day[1]);
  const detail = eventDetail(a, ev.id)!;
  assert.equal(detail.attendees[0].email, "grace@example.net");
  assert.ok(!/\]\(https/.test(detail.description), "the visitor's note is inert text");
  const fresh = () => safeList(outbox).filter((f) => !seen.has(f));
  // Wait for both letters by their addressees: another file's letter may land in between.
  const read = () => fresh().map((f) => readFileSync(join(outbox, f), "utf8"));
  await until(() => {
    const ls = read();
    return ls.some((l) => /To: grace@example.net/.test(l)) && ls.some((l) => /To: mason@example.com/.test(l));
  });
  const letters = read();
  const toGuest = letters.find((l) => /To: grace@example.net/.test(l))!;
  assert.ok(toGuest && /text\/calendar/.test(toGuest) && !toGuest.includes("evil.example"), "the guest's letter holds only the host's words and the .ics");
  assert.ok(letters.some((l) => /To: mason@example.com/.test(l)));
  // Host's Inbox.
  const inbox = await inboxOf({ userId: mate, wsId: ws, locale: "en" });
  assert.ok(inbox.items.some((i) => i.card?.key === `event:${ev.id}` && /Grace Guest/.test(i.text)));
  // Manage by the private link.
  const token = res.manage.split("/").pop()!;
  assert.equal(bookingByToken(link.slug, "x".repeat(32)), null);
  assert.equal(bookingByToken("other-slug", token), null);
  const moved = await rescheduleBooking(link.slug, token, day[2], at("2026-12-01", 8));
  assert.equal(moved.start, day[2]);
  assert.equal(eventRow(ev.id)?.start_at, day[2]);
  await cancelBooking(link.slug, token, at("2026-12-01", 8));
  assert.ok(eventRow(ev.id)?.deleted_at);
  assert.equal(bookingByToken(link.slug, token)?.booking.status, "canceled");
  // Turned off: the page is gone.
  saveLink(a, link.id, { active: false }, "Mason Cal");
  assert.equal(publicLink(link.slug), null);
});

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

test("an event-only change is announced as a calendar poke with ids only", async () => {
  const seen: PulseEvent[] = [];
  const stop = listen(ws, (e) => seen.push(e));
  try {
    const out = createEvent(acc(owner), { calId: ownCal.id, title: "Secret plan", start: at("2026-12-09", 9), end: at("2026-12-09", 10), tz: NY });
    done(out);
    await until(() => seen.some((e) => e.type === "calendar"));
    const e = seen.find((x) => x.type === "calendar")!;
    assert.equal(e.ref, ownCal.id);
    assert.deepEqual(e.refs, [out.id]);
    assert.ok(!JSON.stringify(e).includes("Secret plan"));
  } finally {
    stop();
  }
});

test("a deleted account takes its calendars, events, answers and settings along", async () => {
  const gone = person("Leaving Cal", "leaving@example.com");
  acceptInvite(gone, createInvite(owner, ws, "editor").token);
  const a = acc(gone);
  const cal = ensureDefault(a, "Leaving Cal", NY)!;
  const extra = createCalendar(a, { name: "Side project" });
  const ev = done(createEvent(a, { calId: cal.id, title: "Leaving party", start: at("2026-12-18", 17), end: at("2026-12-18", 18), tz: NY, attendees: [{ userId: owner }] }));
  saveLink(a, null, { title: "Coffee" }, "Leaving Cal");
  const invited = createEvent(acc(owner), { calId: ownCal.id, title: "Farewell", start: at("2026-12-19", 17), end: at("2026-12-19", 18), tz: NY, attendees: [{ userId: gone }] });
  assert.ok(linksOf(ws, `event:${ev.id}`).length > 0, "before: the event links its guest");
  const { deleteAccount } = await import("@/lib/account");
  await deleteAccount(gone);
  const count = (q: string, ...p: string[]) => Number((sql(q).get(...p) as { n: number }).n);
  assert.equal(count("SELECT COUNT(*) AS n FROM cal_calendars WHERE owner_id = ?", gone), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM cal_events WHERE cal_id IN (?, ?)", cal.id, extra.id), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM cal_links WHERE user_id = ?", gone), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM cal_attendees WHERE user_id = ?", gone), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM cal_prefs WHERE user_id = ?", gone), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM eco_links WHERE src = ?", `event:${ev.id}`), 0);
  assert.ok(eventRow(invited.id), "other people's events stay");
});

test("booking letters relay none of the host's links, links and feeds stop when publishing is off, and a link has a daily cap", async () => {
  const { defang, knownMeetingUrl } = await import("@/lib/calendar/booking");
  const { updateSecurity } = await import("@/lib/enterprise/security");
  const d = defang("Your account is locked: https://evil.example/login or go to evil.example now, www.evil.io");
  assert.ok(!/https?:\/\//.test(d) && !/evil\.example|www\.evil/.test(d), d);
  assert.equal(knownMeetingUrl("https://us02web.zoom.us/j/123"), true);
  assert.equal(knownMeetingUrl("https://zoom.us.evil.example/j/1"), false);
  assert.equal(knownMeetingUrl("http://meet.google.com/abc"), false);
  // Publishing off: neither the booking page nor a secret feed answers.
  const team = createWorkspace(outsider, "Locked down").id;
  const a = acc(outsider, team);
  const cal = ensureDefault(a, "Otto Cal", NY)!;
  const link = saveLink(a, null, { title: "Chat", duration: 30, step: 30, noticeMin: 0, windowDays: 60, tz: NY, weekly: { 1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]], 4: [[540, 1020]], 5: [[540, 1020]] } }, "Otto Cal");
  const token = resetFeed(a, cal.id).split("/").pop()!.replace(/\.ics$/, "");
  assert.ok(publicLink(link.slug) && calendarOfFeed(token));
  updateSecurity(team, outsider, { disablePublish: true });
  assert.equal(publicLink(link.slug), null);
  assert.equal(calendarOfFeed(token), null);
  updateSecurity(team, outsider, { disablePublish: false });
  // A link takes so many bookings a day, from however many addresses.
  const lr = publicLink(link.slug)!.row;
  const now = at("2026-12-01", 8);
  for (let i = 0; i < 30; i++) sql("INSERT INTO cal_bookings (id, link_id, event_id, name, email, note, start_at, end_at, tz, locale, token_hash, status, created_at, updated_at) VALUES (?, ?, NULL, 'x', ?, '', 0, 0, ?, 'en', ?, 'canceled', ?, ?)").run(`cap${i}`, lr.id, `p${i}@example.org`, NY, `h${i}`, now - 1000, now - 1000);
  const day = slotsOf(lr, at("2026-12-14", 0), at("2026-12-15", 0), now);
  await assert.rejects(() => book(link.slug, { start: day[0], name: "One more", email: "late@example.org" }, now), /limit/);
});

test("a big import is searchable without indexing it all on the request, and a sweep finds what was left out", async () => {
  const { sweepUnindexed } = await import("@/lib/calendar/effects");
  const cal = createCalendar(acc(owner), { name: "Imported", color: "#2f6fde" });
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (let i = 0; i < 120; i++) lines.push("BEGIN:VEVENT", `UID:bulk-${i}@test`, `DTSTART:20270105T1${i % 10}0000Z`, `DTEND:20270105T1${i % 10}3000Z`, `SUMMARY:Quokka ${i}`, "END:VEVENT");
  lines.push("END:VCALENDAR");
  const t0 = Date.now();
  assert.equal(importFile(acc(owner), cal.id, lines.join("\r\n")).added, 120);
  assert.ok(Date.now() - t0 < 5000);
  const ids = (sql("SELECT id, seq FROM cal_events WHERE cal_id = ?").all(cal.id) as { id: string; seq: number }[]);
  const indexed = () => Number((sql(`SELECT COUNT(*) AS n FROM eco_search WHERE rowid IN (${ids.map((r) => 2 ** 50 + Number(r.seq)).join(",")})`).get() as { n: number }).n);
  await until(() => indexed() === 120);
  assert.equal(indexed(), 120, "every series indexed in the background");
  // A row that lost its index (a restart mid-import) is found again.
  sql(`DELETE FROM eco_search WHERE rowid = ${2 ** 50 + Number(ids[7].seq)}`).run();
  assert.ok(sweepUnindexed() >= 1, "found (with any other test event written without its after-write)");
  await until(() => indexed() === 120);
  assert.equal(indexed(), 120);
});

test("event search checks access in the query: many hidden matches never crowd out a visible one; a quote's bare URLs stay inert", async () => {
  const hidden = createCalendar(acc(owner), { name: "Private board", color: "#2f6fde" });
  for (let i = 0; i < 60; i++) done(createEvent(acc(owner), { calId: hidden.id, title: `Narwhal sync ${i}`, start: at("2027-02-01", 9), end: at("2027-02-01", 10), tz: NY }));
  const open = done(createEvent(acc(mate), { calId: mateCal.id, title: "Narwhal sync open", start: at("2027-02-02", 9), end: at("2027-02-02", 10), tz: NY }));
  const v = (u: string) => ({ userId: u, wsId: ws, locale: "en" as const });
  const { eventHits } = await import("@/lib/eco/calendar");
  const seen = eventHits(v(viewer), "Narwhal sync");
  assert.ok(!seen.some((h) => h.key !== `event:${open.id}`), "a viewer finds nothing of the private calendar");
  assert.ok(eventHits(v(mate), "Narwhal").some((h) => h.key === `event:${open.id}`), "the teammate's own event is found past 60 hidden matches");
  assert.ok(!eventHits(v(mate), "Narwhal").some((h) => h.key !== `event:${open.id}`), "nothing from the private calendar");
  // Turn into issue: a bare URL in the description cannot become a link.
  const ev = done(createEvent(acc(owner), { calId: ownCal.id, title: "Link check", description: "Go to https://evil.example/login now", start: at("2027-02-03", 9), end: at("2027-02-03", 10), tz: NY }));
  const card = await issueFromEvent({ userId: owner, name: "Olivia", wsId: ws, locale: "en" }, { event: ev.id });
  const desc = (sql("SELECT description FROM pj_issues WHERE id = ?").get(card.key.slice(6)) as { description: string }).description;
  assert.ok(!desc.includes("https://evil.example"), desc);
});

test("a deleted calendar leaves the shared search index", async () => {
  const { deleteCalendar } = await import("@/lib/calendar/calendars");
  const side = createCalendar(acc(owner), { name: "Side", color: "#2f6fde" });
  const ev = done(createEvent(acc(owner), { calId: side.id, title: "Axolotl offsite", start: at("2027-03-01", 9), end: at("2027-03-01", 10), tz: NY }));
  const v = (u: string) => ({ userId: u, wsId: ws, locale: "en" as const });
  assert.ok((await searchAll(v(owner), "Axolotl offsite")).hits.some((h) => h.key === `event:${ev.id}`));
  const seq = Number((sql("SELECT seq FROM cal_events WHERE id = ?").get(ev.id) as { seq: number }).seq);
  deleteCalendar(acc(owner), side.id);
  await until(() => !sql(`SELECT 1 FROM eco_search WHERE rowid = ${2 ** 50 + seq}`).get());
  assert.equal(sql(`SELECT 1 FROM eco_search WHERE rowid = ${2 ** 50 + seq}`).get(), undefined, "its text left the shared index");
});

test("an invitation letter to an outside guest relays nobody's words as links or in the subject; the sending cap survives restarts", async () => {
  const { mayMail } = await import("@/lib/calendar/effects");
  const outbox = join(TEST_DIR, "outbox");
  const seen = new Set(safeList(outbox));
  const a = acc(owner);
  const o = done(createEvent(a, { calId: ownCal.id, title: "Your account is locked: https://evil.example/login", location: "evil.example", conference: "https://evil.example/join", start: at("2027-04-05", 9), end: at("2027-04-05", 10), tz: NY, attendees: [{ email: "victim@example.net" }] }));
  afterWrite({ ws, by: owner, seriesIds: o.seriesIds, calIds: o.calIds, guests: o.guests, notifyGuests: true });
  const fresh = () => safeList(outbox).filter((f) => !seen.has(f)).map((f) => readFileSync(join(outbox, f), "utf8"));
  await until(() => fresh().some((l) => /To: victim@example.net/.test(l)));
  const letter = fresh().find((l) => /To: victim@example.net/.test(l))!;
  const head = letter.split("\r\n\r\n")[0];
  const text = letter.split("Content-Type: text/plain; charset=utf-8\r\n\r\n")[1]?.split("\r\n--")[0] ?? "";
  assert.ok(!/locked/i.test(head), "the title is not in the subject");
  assert.ok(!/evil\.example/.test(text) && !/https?:\/\/evil/.test(text), text);
  // The cap is in the database: a fresh process (the same rows) keeps counting.
  for (let i = 0; i < 60; i++) sql("INSERT INTO cal_letters (sender, at) VALUES (?, ?)").run("cap-test", Date.now() - 1000);
  assert.equal(mayMail("cap-test"), false);
});

test("booking: an all-day event shown as busy (out of office) blocks its days; all-day events are free unless set busy", () => {
  const a = acc(mate);
  const link = saveLink(a, null, { title: "Office hours", duration: 30, step: 30, noticeMin: 0, windowDays: 90, tz: NY, weekly: { 1: [[540, 660]], 2: [[540, 660]], 3: [[540, 660]], 4: [[540, 660]], 5: [[540, 660]] } }, "Mason Cal");
  const lr = publicLink(link.slug)!.row;
  const day = (d: string) => slotsOf(lr, at(d, 0), at(addDay(d), 0), at("2027-05-01", 8));
  const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const holiday = createEvent(a, { calId: mateCal.id, title: "Birthday", allDay: true, startDay: "2027-05-10", endDay: "2027-05-11", tz: NY });
  assert.equal(eventRow(holiday.id)?.busy, 0, "free by default");
  assert.ok(day("2027-05-10").length > 0, "a free all-day event leaves the day bookable");
  createEvent(a, { calId: mateCal.id, title: "Out of office", allDay: true, busy: true, startDay: "2027-05-11", endDay: "2027-05-13", tz: NY });
  assert.deepEqual(day("2027-05-11"), []);
  assert.deepEqual(day("2027-05-12"), []);
  assert.ok(day("2027-05-13").length > 0, "the day after is open again");
});
