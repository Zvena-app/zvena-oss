// zvena Calendar, the pure parts: time zones, repeating events across
// daylight saving, ICS read/write round trips, booking slots, "go to" words
// and the overlap layout.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIcs, fold, importEvents, ianaOf, parseDuration, parseIcs, vtimezone } from "@/lib/calendar/ics";
import { layoutBars, layoutDay } from "@/lib/calendar/layout";
import { parseJump } from "@/lib/calendar/natural";
import { cleanRRule, expand, occurrenceIndex, parseRRule, untilBefore, type Series } from "@/lib/calendar/rrule";
import { cleanWeekly, freeSlots, type Availability } from "@/lib/calendar/slots";
import { addDays, addMonths, atMinute, dayOf, fromWall, minuteOfDay, offsetOf, startOfWeek, validTimeZone, wallOf, weekday } from "@/lib/calendar/tz";

const NY = "America/New_York";
const hhmm = (ms: number, tz: string) => {
  const w = wallOf(ms, tz);
  return `${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`;
};

test("wall clock and back, across the spring gap and the autumn overlap", () => {
  assert.equal(offsetOf(Date.UTC(2026, 0, 15), NY), -300);
  assert.equal(offsetOf(Date.UTC(2026, 6, 15), NY), -240);
  // 2026-03-08 02:30 does not exist in New York: it moves forward to 03:30 EDT.
  const gap = fromWall({ y: 2026, m: 3, d: 8, h: 2, mi: 30, s: 0 }, NY);
  assert.equal(hhmm(gap, NY), "03:30");
  // 2026-11-01 01:30 happens twice: the first (EDT, UTC-4) one.
  const twice = fromWall({ y: 2026, m: 11, d: 1, h: 1, mi: 30, s: 0 }, NY);
  assert.equal(twice, Date.UTC(2026, 10, 1, 5, 30));
  // Half-hour zones.
  assert.equal(offsetOf(Date.UTC(2026, 0, 1), "Asia/Kolkata"), 330);
  assert.equal(dayOf(Date.UTC(2026, 0, 1, 20), "Asia/Kolkata"), "2026-01-02");
  assert.ok(validTimeZone("Europe/Paris") && validTimeZone("UTC") && !validTimeZone("Mars/Base") && !validTimeZone("../etc"));
});

test("calendar days: weeks, months, weekdays", () => {
  assert.equal(weekday("2026-10-15"), 4);
  assert.equal(startOfWeek("2026-10-15", 1), "2026-10-12");
  assert.equal(startOfWeek("2026-10-15", 0), "2026-10-11");
  assert.equal(startOfWeek("2026-10-15", 6), "2026-10-10");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
});

function series(rule: string, startDay: string, minute: number, tz = NY, allDay = false): Series {
  const r = parseRRule(rule);
  assert.ok(r, rule);
  return { startDay, startMinute: minute, allDay, tz, rule: r };
}

test("a weekly 9:00 meeting stays at 9:00 on the wall clock through the end of daylight saving", () => {
  const s = series("FREQ=WEEKLY;BYDAY=MO,TH", "2026-10-19", 9 * 60);
  const occ = expand(s, "2026-10-19", "2026-11-12");
  assert.deepEqual(
    occ.map((o) => o.day),
    ["2026-10-19", "2026-10-22", "2026-10-26", "2026-10-29", "2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12"]
  );
  for (const o of occ) assert.equal(hhmm(o.start, NY), "09:00");
  // In UTC the meeting moves an hour later once New York leaves daylight saving.
  assert.equal(new Date(occ[3].start).getUTCHours(), 13);
  assert.equal(new Date(occ[4].start).getUTCHours(), 14);
  assert.equal(occ[0].key, "20261019T130000Z");
});

test("a daily event in the spring gap moves forward on that one day only", () => {
  const s = series("FREQ=DAILY;COUNT=3", "2026-03-07", 150);
  const occ = expand(s, "2026-03-01", "2026-03-31");
  assert.deepEqual(occ.map((o) => hhmm(o.start, NY)), ["02:30", "03:30", "02:30"]);
});

test("monthly and yearly rules: last Friday, the 2nd Tuesday, BYSETPOS, the 31st, Feb 29", () => {
  const lastFri = expand(series("FREQ=MONTHLY;BYDAY=-1FR", "2026-10-30", 600), "2026-10-01", "2027-02-28");
  assert.deepEqual(lastFri.map((o) => o.day), ["2026-10-30", "2026-11-27", "2026-12-25", "2027-01-29", "2027-02-26"]);
  const second = expand(series("FREQ=MONTHLY;BYDAY=2TU;COUNT=3", "2026-10-13", 600), "2026-01-01", "2027-12-31");
  assert.deepEqual(second.map((o) => o.day), ["2026-10-13", "2026-11-10", "2026-12-08"]);
  // The last weekday of the month.
  const lastWorkday = expand(series("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "2026-10-30", 600), "2026-10-01", "2027-01-31");
  assert.deepEqual(lastWorkday.map((o) => o.day), ["2026-10-30", "2026-11-30", "2026-12-31", "2027-01-29"]);
  // Months without a 31st are skipped (RFC 5545), not moved.
  const the31st = expand(series("FREQ=MONTHLY", "2026-10-31", 600), "2026-10-01", "2027-03-31");
  assert.deepEqual(the31st.map((o) => o.day), ["2026-10-31", "2026-12-31", "2027-01-31", "2027-03-31"]);
  const leap = expand(series("FREQ=YEARLY", "2024-02-29", 0, "UTC", true), "2024-01-01", "2032-12-31");
  assert.deepEqual(leap.map((o) => o.day), ["2024-02-29", "2028-02-29", "2032-02-29"]);
  const thanksgiving = expand(series("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "2026-11-26", 0, NY, true), "2026-01-01", "2028-12-31");
  assert.deepEqual(thanksgiving.map((o) => o.day), ["2026-11-26", "2027-11-25", "2028-11-23"]);
});

test("COUNT counts removed occurrences; UNTIL is inclusive; every other week", () => {
  const s = { ...series("FREQ=DAILY;COUNT=5", "2026-10-01", 600), exdates: new Set(["20261003T140000Z"]) };
  assert.deepEqual(expand(s, "2026-09-01", "2026-12-31").map((o) => o.day), ["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05"]);
  const until = expand(series("FREQ=WEEKLY;UNTIL=20261029T140000Z", "2026-10-01", 600), "2026-09-01", "2026-12-31");
  assert.deepEqual(until.map((o) => o.day), ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]);
  const biweekly = expand(series("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "2026-10-06", 600), "2026-10-01", "2026-11-30");
  assert.deepEqual(biweekly.map((o) => o.day), ["2026-10-06", "2026-10-20", "2026-11-03", "2026-11-17"]);
  // A range far from the start is found without walking every day of years.
  const old = series("FREQ=DAILY", "2016-01-01", 600);
  const far = expand(old, "2026-10-15", "2026-10-16");
  assert.deepEqual(far.map((o) => o.day), ["2026-10-15", "2026-10-16"]);
});

test("splitting a series: UNTIL just before an occurrence, and its index", () => {
  const s = series("FREQ=DAILY;COUNT=10", "2026-10-01", 600);
  assert.equal(occurrenceIndex(s, "20261004T140000Z"), 3);
  assert.equal(untilBefore(false, "20261004T140000Z"), "20261004T135959Z");
  assert.equal(untilBefore(true, "20261004"), "20261003");
  assert.equal(cleanRRule("rrule:freq=weekly;byday=mo,we;interval=1"), "FREQ=WEEKLY;BYDAY=MO,WE");
  assert.equal(cleanRRule("FREQ=HOURLY"), null);
  assert.equal(cleanRRule("FREQ=DAILY;COUNT=3;UNTIL=20260101"), null);
  assert.equal(cleanRRule("FREQ=DAILY;BYHOUR=9"), null);
});

test("ICS: a calendar written and read back keeps times, zones, rules, exceptions and overrides", () => {
  const start = atMinute("2026-10-19", 9 * 60, NY);
  const ics = buildIcs({
    name: "Team, ops; and more",
    events: [
      { uid: "series@zvena", title: "Standup, daily; sync", description: "Line one\nLine two — ünïcødé ".repeat(4), location: "Room 4", allDay: false, start, end: start + 30 * 60_000, startDay: "2026-10-19", endDay: "2026-10-19", tz: NY, rrule: "FREQ=WEEKLY;BYDAY=MO,TH", exdates: ["20261022T130000Z"], alarms: [10], attendees: [{ email: "a@example.com", name: "Ann \"A\"", partstat: "ACCEPTED" }] },
      { uid: "series@zvena", title: "Standup (moved)", allDay: false, start: start + 7 * 86_400_000 + 3_600_000, end: start + 7 * 86_400_000 + 5_400_000, startDay: "2026-10-26", endDay: "2026-10-26", tz: NY, recurrenceId: "20261026T130000Z" },
      { uid: "trip@zvena", title: "Trip", allDay: true, start: 0, end: 0, startDay: "2026-12-24", endDay: "2026-12-27", tz: "UTC" },
    ],
    now: Date.UTC(2026, 9, 15),
  });
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, `folded: ${line}`);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York/);
  assert.match(ics, /RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU/);
  assert.match(ics, /RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU/);
  const cal = parseIcs(ics);
  assert.equal(cal.name, "Team, ops; and more");
  const evs = importEvents(cal, "UTC");
  assert.equal(evs.length, 3);
  const [s, moved, trip] = evs;
  assert.equal(s.title, "Standup, daily; sync");
  assert.equal(s.tz, NY);
  assert.equal(s.start, start);
  assert.equal(s.end - s.start, 30 * 60_000);
  assert.equal(s.rrule, "FREQ=WEEKLY;BYDAY=MO,TH");
  assert.deepEqual(s.exdates, ["20261022T130000Z"]);
  assert.deepEqual(s.alarms, [10]);
  assert.equal(s.description, "Line one\nLine two — ünïcødé ".repeat(4));
  assert.deepEqual(s.attendees, [{ email: "a@example.com", name: "Ann A", partstat: "ACCEPTED" }]);
  assert.equal(moved.recurrenceId, "20261026T130000Z");
  assert.equal(hhmm(moved.start, NY), "10:00");
  assert.ok(trip.allDay);
  assert.equal(trip.startDay, "2026-12-24");
  assert.equal(trip.endDay, "2026-12-27");
});

test("ICS: other apps' files — Windows zones, Mozilla TZIDs, floating times, DURATION, folded lines, CANCELLED", () => {
  const text = [
    "BEGIN:VCALENDAR",
    "X-WR-TIMEZONE:Europe/Paris",
    "BEGIN:VEVENT",
    "UID:1",
    "DTSTART;TZID=Eastern Standard Time:20261015T090000",
    "DURATION:PT1H30M",
    "SUMMARY:Outlook ",
    " meeting",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:2",
    "DTSTART;TZID=/mozilla.org/20050126_1/Asia/Tokyo:20261015T090000",
    "DTEND;TZID=/mozilla.org/20050126_1/Asia/Tokyo:20261015T100000",
    "STATUS:CANCELLED",
    "SUMMARY:Thunderbird",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:3",
    "DTSTART:20261015T090000",
    "SUMMARY:Floating",
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:No UID: skipped",
    "DTSTART:20261015T090000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const evs = importEvents(parseIcs(text), "UTC");
  assert.equal(evs.length, 3);
  assert.equal(evs[0].title, "Outlook meeting");
  assert.equal(evs[0].tz, NY);
  assert.equal(evs[0].end - evs[0].start, 90 * 60_000);
  assert.equal(evs[1].tz, "Asia/Tokyo");
  assert.ok(evs[1].cancelled);
  assert.equal(evs[2].tz, "Europe/Paris");
  assert.equal(hhmm(evs[2].start, "Europe/Paris"), "09:00");
  assert.deepEqual(evs[2].alarms, [1440]);
  assert.equal(ianaOf("Nowhere Standard Time"), null);
  assert.equal(parseDuration("-PT15M"), -15 * 60_000);
  assert.equal(parseDuration("P"), null);
  assert.equal(fold("x".repeat(160)).split("\r\n ").join(""), "x".repeat(160));
  assert.deepEqual(vtimezone("Asia/Tokyo", 2026).filter((l) => l.startsWith("TZOFFSET")), ["TZOFFSETFROM:+0900", "TZOFFSETTO:+0900"]);
});

test("ICS: a hostile file stays bounded and never throws", () => {
  const big = ["BEGIN:VCALENDAR", ...Array.from({ length: 30_000 }, (_, i) => `BEGIN:VEVENT\nUID:${i}\nDTSTART:20261015T090000Z\nSUMMARY:x\nEND:VEVENT`), "END:VCALENDAR"].join("\n");
  assert.equal(parseIcs(big).events.length, 20_000);
  assert.doesNotThrow(() => parseIcs("BEGIN:VEVENT\nDTSTART:2026\nRRULE:FREQ=SECONDLY\nEND:VEVENT\n:::\n;;;"));
});

const avail = (over: Partial<Availability> = {}): Availability => ({ tz: NY, weekly: cleanWeekly({ 1: [[540, 720]], 2: [[540, 720]], 3: [[540, 720]], 4: [[540, 720]], 5: [[540, 720]] })!, duration: 30, step: 30, bufferBefore: 0, bufferAfter: 0, noticeMin: 0, windowDays: 14, maxPerDay: 0, ...over });

test("booking slots: the host's hours on the host's wall clock, minus busy time, buffers and notice", () => {
  // Thursday 2026-10-15, 08:00 in New York.
  const now = atMinute("2026-10-15", 8 * 60, NY);
  const day = (d: string) => ({ from: atMinute(d, 0, NY), to: atMinute(addDays(d, 1), 0, NY) });
  const all = freeSlots({ avail: avail(), busy: [], now, ...day("2026-10-15") });
  assert.equal(all.length, 6);
  assert.deepEqual(all.map((s) => hhmm(s, NY)), ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
  // A meeting 10:00–10:30 with 15-minute buffers takes 9:30 and 10:30 too.
  const busy = [{ start: atMinute("2026-10-15", 600, NY), end: atMinute("2026-10-15", 630, NY) }];
  const around = freeSlots({ avail: avail({ bufferBefore: 15, bufferAfter: 15 }), busy, now, ...day("2026-10-15") });
  assert.deepEqual(around.map((s) => hhmm(s, NY)), ["09:00", "11:00", "11:30"]);
  // Two hours of notice from 8:00.
  assert.deepEqual(freeSlots({ avail: avail({ noticeMin: 120 }), busy: [], now, ...day("2026-10-15") }).map((s) => hhmm(s, NY)), ["10:00", "10:30", "11:00", "11:30"]);
  // Weekends are closed; the window ends.
  assert.deepEqual(freeSlots({ avail: avail(), busy: [], now, ...day("2026-10-17") }), []);
  assert.deepEqual(freeSlots({ avail: avail({ windowDays: 1 }), busy: [], now, ...day("2026-10-16") }), []);
  // A full day by maxPerDay.
  assert.deepEqual(freeSlots({ avail: avail({ maxPerDay: 2 }), busy: [], bookedPerDay: new Map([["2026-10-15", 2]]), now, ...day("2026-10-15") }), []);
});

test("booking slots across the change of daylight saving keep the host's 9:00", () => {
  const now = atMinute("2026-10-30", 8 * 60, NY);
  const from = atMinute("2026-11-02", 0, NY);
  const slots = freeSlots({ avail: avail({ duration: 60, step: 60 }), busy: [], now, from, to: from + 86_400_000 });
  assert.deepEqual(slots.map((s) => hhmm(s, NY)), ["09:00", "10:00", "11:00"]);
  assert.equal(minuteOfDay(slots[0], "UTC"), 14 * 60);
  assert.equal(cleanWeekly({ 1: [[600, 700], [650, 800]] })![1].length, 1);
  assert.equal(cleanWeekly({ 1: [[-5, 10]] }), null);
});

test("go to a date in plain words, on the calendar's own zone", () => {
  const now = Date.UTC(2026, 9, 15, 15); // Thursday
  assert.equal(parseJump("next fri", "en", now, NY), "2026-10-16");
  assert.equal(parseJump("tomorrow", "en", now, NY), "2026-10-16");
  assert.equal(parseJump("next week", "en", now, NY), "2026-10-22");
  assert.equal(parseJump("next month", "en", now, NY), "2026-11-01");
  assert.equal(parseJump("+3", "en", now, NY), "2026-10-18");
  assert.equal(parseJump("dec 24", "en", now, NY), "2026-12-24");
  assert.equal(parseJump("march", "en", now, NY), "2027-03-01");
  assert.equal(parseJump("2027-01-05", "en", now, NY), "2027-01-05");
  // Late evening in New York is already tomorrow in Tokyo.
  assert.equal(parseJump("today", "en", Date.UTC(2026, 9, 16, 2), NY), "2026-10-15");
  assert.equal(parseJump("today", "en", Date.UTC(2026, 9, 16, 2), "Asia/Tokyo"), "2026-10-16");
  assert.equal(parseJump("gibberish words", "en", now, NY), null);
});

test("go to in the interface's language: its own weekday and month names, today and tomorrow", () => {
  const now = Date.UTC(2026, 9, 15, 15); // Thursday
  assert.equal(parseJump("viernes", "es", now, NY), "2026-10-16");
  assert.equal(parseJump("mañana", "es", now, NY), "2026-10-16");
  assert.equal(parseJump("24 déc.", "fr", now, NY), "2026-12-24");
  assert.equal(parseJump("vendredi", "fr", now, NY), "2026-10-16");
  assert.equal(parseJump("sexta-feira", "pt", now, NY), "2026-10-16");
  assert.equal(parseJump("25 desember", "id", now, NY), "2026-12-25");
  // English always works too.
  assert.equal(parseJump("next fri", "fr", now, NY), "2026-10-16");
});

test("overlapping events share the column; a lone event takes it all", () => {
  const placed = layoutDay([
    { id: "a", top: 540, bottom: 600 },
    { id: "b", top: 570, bottom: 630 },
    { id: "c", top: 600, bottom: 660 },
    { id: "d", top: 720, bottom: 780 },
  ]);
  const by = Object.fromEntries(placed.map((p) => [p.id, p]));
  assert.equal(by.a.cols, 2);
  assert.equal(by.b.col, 1);
  assert.equal(by.c.col, 0);
  assert.equal(by.d.cols, 1);
  assert.equal(by.d.span, 1);
  const bars = layoutBars([
    { id: "x", from: 0, to: 2 },
    { id: "y", from: 1, to: 1 },
    { id: "z", from: 3, to: 4 },
  ]);
  assert.deepEqual(bars.map((b) => [b.id, b.row]), [["x", 0], ["y", 1], ["z", 0]]);
});
