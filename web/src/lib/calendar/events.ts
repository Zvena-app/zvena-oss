// Server-only: events of zvena Calendar — reading a range (repeating events
// expanded, overrides in place of their occurrences), writing with Notion
// Calendar's scopes for repeating events (this event, this and following,
// all events), and undo.
//
// Times: a timed event keeps its start and end as instants plus the zone it
// was made in (repeats follow that zone's wall clock); an all-day event keeps
// its first day and the day after its last (start_at / end_at hold UTC
// midnights, for range queries). An override of one occurrence is a row of
// its own: parent_id names the series, recurrence_id the occurrence.
//
// Every write checks the person's level on the calendar (lib/calendar/access.ts)
// and leaves an undo token: the rows as they were, put back by `undo`.

import { canRead as canReadNote } from "../notes/access";
import { displayTitle, noteSlug } from "../notes/model";
import { newId, sql, tx } from "../store";
import { CalAccess, calRow, canSeeEvent, type CalRow } from "./access";
import { calDb } from "./db";
import { expand, parseOccKey, parseRRule, formatRRule, occurrenceIndex, untilBefore, hasOccurrences, type Series, type RRule } from "./rrule";
import { addDays, atMinute, dayOf, daysBetween, isDay, minuteOfDay, parseDay, validTimeZone } from "./tz";
import { COLOR_RE, RSVPS, type Attendee, type EventDetail, type EventDoc, type EventItem, type Reminder, type Rsvp, type Scope } from "./types";

export interface EvRow {
  seq: number;
  id: string;
  cal_id: string;
  ws_id: string;
  uid: string;
  parent_id: string | null;
  recurrence_id: string | null;
  title: string;
  description: string;
  location: string;
  place: string | null;
  conference: string;
  color: string | null;
  all_day: number;
  start_at: number;
  end_at: number;
  start_day: string;
  end_day: string;
  tz: string;
  rrule: string | null;
  exdates: string;
  until_at: number | null;
  status: "confirmed" | "tentative" | "cancelled";
  busy: number;
  reminders: string;
  remind_lead: number;
  docs: string;
  organizer_id: string | null;
  booking_id: string | null;
  remote_href: string | null;
  remote_etag: string | null;
  /** CalDAV: changed here, not yet on the server (written by the sync only). */
  dirty?: number;
  sequence: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface AttRow {
  event_id: string;
  email: string;
  user_id: string | null;
  name: string;
  rsvp: Rsvp;
  token_hash: string | null;
  invited_at: number | null;
  responded_at: number | null;
}

export class CalError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

const DAY = 86_400_000;
/** Longest timed event, longest all-day one. */
const MAX_TIMED = 31 * DAY;
const MAX_DAYS = 366;
/** Longest range one read may ask for. */
export const MAX_RANGE = 120 * DAY;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const EMAIL_RE = /^[^\s@<>"(),;:]{1,64}@[^\s@<>"(),;:]{1,190}\.[^\s@<>"(),;:]{2,63}$/;

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    const v = JSON.parse(s ?? "");
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
};

export function eventRow(id: unknown): EvRow | null {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  calDb();
  return (sql("SELECT * FROM cal_events WHERE id = ?").get(id) as EvRow | undefined) ?? null;
}

export function attendeesOf(eventId: string): AttRow[] {
  return sql("SELECT * FROM cal_attendees WHERE event_id = ? ORDER BY invited_at, email").all(eventId) as unknown as AttRow[];
}

/** The repeating series of a master row (null for a single event or a broken rule). */
export function seriesOf(r: Pick<EvRow, "rrule" | "start_day" | "start_at" | "all_day" | "tz" | "exdates">): Series | null {
  const rule = r.rrule ? parseRRule(r.rrule) : null;
  if (!rule) return null;
  const allDay = r.all_day === 1;
  return { startDay: r.start_day, startMinute: allDay ? 0 : minuteOfDay(r.start_at, r.tz), allDay, tz: r.tz, rule, exdates: new Set(parseJson<string[]>(r.exdates, [])) };
}

/** When the last occurrence of a series ends (null: never). */
export function untilOf(r: Pick<EvRow, "rrule" | "start_day" | "start_at" | "end_at" | "end_day" | "all_day" | "tz" | "exdates">): number | null {
  const s = seriesOf(r);
  if (!s) return r.end_at;
  if (!s.rule.until && !s.rule.count) return null;
  const all = expand({ ...s, exdates: undefined }, s.startDay, "9999-12-31", (s.rule.count ?? 20_000) + 1);
  const last = all[all.length - 1];
  if (!last) return r.end_at;
  return last.start + (r.end_at - r.start_at);
}

// ------------------------------------------------------------ input

export interface EventInput {
  calId?: unknown;
  title?: unknown;
  description?: unknown;
  location?: unknown;
  place?: unknown;
  conference?: unknown;
  color?: unknown;
  allDay?: unknown;
  start?: unknown;
  end?: unknown;
  startDay?: unknown;
  endDay?: unknown;
  tz?: unknown;
  rrule?: unknown;
  busy?: unknown;
  status?: unknown;
  reminders?: unknown;
  attendees?: unknown;
  docs?: unknown;
}

/** The fields of a row an input sets (validated); throws CalError(400) on nonsense. */
export function cleanFields(input: EventInput, base: Partial<EvRow> | null, fallbackTz: string): Partial<EvRow> {
  const out: Partial<EvRow> = {};
  const bad = (what: string): never => {
    throw new CalError(400, `bad ${what}`);
  };
  const text = (v: unknown, max: number, what: string): string => {
    if (typeof v !== "string") bad(what);
    return (v as string).replace(/\u0000/g, "").slice(0, max);
  };
  if (input.title !== undefined) out.title = text(input.title, 500, "title").replace(/\s+/g, " ").trim();
  if (input.description !== undefined) out.description = text(input.description, 20_000, "description");
  if (input.location !== undefined) out.location = text(input.location, 500, "location").replace(/\s+/g, " ").trim();
  if (input.conference !== undefined) {
    const c = text(input.conference, 2000, "conference").trim();
    if (c && !/^https:\/\/[^\s<>"']+$/i.test(c)) bad("conference");
    out.conference = c;
  }
  if (input.place !== undefined) {
    const p = input.place as { name?: unknown; lat?: unknown; lng?: unknown } | null;
    if (p === null) out.place = null;
    else {
      const lat = Number(p?.lat);
      const lng = Number(p?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) bad("place");
      out.place = JSON.stringify({ name: typeof p?.name === "string" ? p.name.slice(0, 300) : "", lat, lng });
    }
  }
  if (input.color !== undefined) {
    if (input.color !== null && (typeof input.color !== "string" || !COLOR_RE.test(input.color))) bad("color");
    out.color = (input.color as string | null) ?? null;
  }
  if (input.busy !== undefined) out.busy = input.busy === false ? 0 : 1;
  if (input.status !== undefined) {
    if (input.status !== "confirmed" && input.status !== "tentative") bad("status");
    out.status = input.status as EvRow["status"];
  }
  if (input.reminders !== undefined) {
    if (!Array.isArray(input.reminders) || input.reminders.length > 5) bad("reminders");
    const list: Reminder[] = [];
    for (const r of input.reminders as unknown[]) {
      const min = Math.round(Number((r as Reminder)?.min));
      const how = (r as Reminder)?.how === "email" ? "email" : "inbox";
      if (!Number.isFinite(min) || min < 0 || min > 40_320) bad("reminder");
      if (!list.some((x) => x.min === min && x.how === how)) list.push({ min, how });
    }
    out.reminders = JSON.stringify(list);
    out.remind_lead = list.length ? Math.max(...list.map((r) => r.min)) + 1 : 0;
  }
  if (input.docs !== undefined) {
    if (!Array.isArray(input.docs) || input.docs.length > 20 || (input.docs as unknown[]).some((d) => typeof d !== "string" || !ID_RE.test(d))) bad("docs");
    out.docs = JSON.stringify([...new Set(input.docs as string[])]);
  }
  // Times: all of them together (start, end, zone, all-day) against the base.
  const timesGiven = ["allDay", "start", "end", "startDay", "endDay", "tz"].some((k) => (input as Record<string, unknown>)[k] !== undefined);
  if (timesGiven) {
    const allDay = input.allDay !== undefined ? input.allDay === true : base?.all_day === 1;
    const tz = input.tz !== undefined ? (validTimeZone(input.tz) ? input.tz : bad("tz")) : (base?.tz ?? fallbackTz);
    if (allDay) {
      const sd = input.startDay ?? base?.start_day;
      const ed = input.endDay ?? (input.startDay !== undefined && base?.start_day && base.end_day ? addDays(input.startDay as string, daysBetween(base.start_day, base.end_day)) : base?.end_day);
      if (!isDay(sd) || !isDay(ed)) bad("days");
      const span = daysBetween(sd as string, ed as string);
      if (span < 1 || span > MAX_DAYS) bad("days");
      const p = parseDay(sd as string);
      const q = parseDay(ed as string);
      Object.assign(out, { all_day: 1, tz, start_day: sd, end_day: ed, start_at: Date.UTC(p.y, p.m - 1, p.d), end_at: Date.UTC(q.y, q.m - 1, q.d) });
    } else {
      const start = input.start !== undefined ? Number(input.start) : base?.all_day === 1 ? atMinute(base.start_day as string, 9 * 60, tz) : Number(base?.start_at);
      let end = input.end !== undefined ? Number(input.end) : base && base.all_day !== 1 ? start + (Number(base.end_at) - Number(base.start_at)) : start + 30 * 60_000;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < Date.UTC(1900, 0, 1) || start > Date.UTC(2200, 0, 1)) bad("start");
      if (end < start) bad("end");
      if (end - start > MAX_TIMED) end = start + MAX_TIMED;
      Object.assign(out, { all_day: 0, tz, start_at: Math.round(start), end_at: Math.round(end), start_day: dayOf(start, tz), end_day: dayOf(end, tz) });
    }
  }
  if (input.rrule !== undefined) {
    if (input.rrule === null || input.rrule === "") out.rrule = null;
    else {
      const r = parseRRule(input.rrule);
      if (!r) bad("rrule");
      out.rrule = formatRRule(r as RRule);
    }
  }
  return out;
}

export interface AttendeeInput {
  email?: string;
  userId?: string;
}

/** Guests as given (e-mails, members of the workspace), deduped; members are named by the server. */
export function cleanAttendees(raw: unknown, ws: string, organizer: string): { email: string; userId: string | null; name: string }[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new CalError(400, "bad attendees");
  const out = new Map<string, { email: string; userId: string | null; name: string }>();
  for (const a of raw as AttendeeInput[]) {
    if (a && typeof a.userId === "string" && ID_RE.test(a.userId)) {
      if (a.userId === organizer) continue;
      const u = sql("SELECT u.id, u.name, u.email FROM users u JOIN members m ON m.user_id = u.id AND m.ws_id = ? WHERE u.id = ?").get(ws, a.userId) as { id: string; name: string; email: string | null } | undefined;
      if (!u) throw new CalError(400, "not a member");
      const email = u.email?.toLowerCase() || `member:${u.id}`;
      out.set(email, { email, userId: u.id, name: u.name });
    } else if (a && typeof a.email === "string") {
      const email = a.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new CalError(400, "bad email");
      // A member's own address is that member.
      const u = sql("SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id AND m.ws_id = ? WHERE u.email = ? COLLATE NOCASE").get(ws, email) as { id: string; name: string } | undefined;
      if (u?.id === organizer) continue;
      out.set(email, { email, userId: u?.id ?? null, name: u?.name ?? "" });
    } else throw new CalError(400, "bad attendee");
  }
  return [...out.values()];
}

// ------------------------------------------------------------ reading a range

interface Viewer {
  acc: CalAccess;
  /** The viewer's zone: the edges of all-day events. */
  tz: string;
}

function names(ids: (string | null | undefined)[]): Map<string, string> {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!list.length) return new Map();
  return new Map((sql("SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(list)) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

/** The occurrence fields of a row placed at an occurrence. */
function placeOcc(r: EvRow, occ: { key: string; day: string; start: number } | null): Pick<EventItem, "start" | "end" | "startDay" | "endDay"> {
  if (!occ) return { start: r.start_at, end: r.end_at, startDay: r.start_day, endDay: r.end_day };
  if (r.all_day === 1) {
    const span = daysBetween(r.start_day, r.end_day);
    const endDay = addDays(occ.day, span);
    const q = parseDay(endDay);
    return { start: occ.start, end: Date.UTC(q.y, q.m - 1, q.d), startDay: occ.day, endDay };
  }
  const dur = r.end_at - r.start_at;
  return { start: occ.start, end: occ.start + dur, startDay: dayOf(occ.start, r.tz), endDay: dayOf(occ.start + dur, r.tz) };
}

export function toItem(r: EvRow, occ: { key: string; day: string; start: number } | null, opts: { canEdit: boolean; invited?: boolean; rsvp?: Rsvp; guests: number; recurring: boolean }): EventItem {
  return {
    id: r.id,
    occ: occ?.key ?? (r.parent_id ? r.recurrence_id : null),
    calId: r.cal_id,
    title: r.title,
    allDay: r.all_day === 1,
    ...placeOcc(r, occ),
    tz: r.tz,
    color: r.color,
    location: r.location,
    conference: r.conference,
    recurring: opts.recurring,
    busy: r.busy === 1,
    status: r.status,
    ...(opts.rsvp ? { rsvp: opts.rsvp } : {}),
    guests: opts.guests,
    canEdit: opts.canEdit,
    ...(opts.invited ? { invited: true } : {}),
  };
}

const overlaps = (item: Pick<EventItem, "allDay" | "start" | "end" | "startDay" | "endDay">, from: number, to: number, fromDay: string, toDay: string) =>
  item.allDay ? item.startDay <= toDay && item.endDay > fromDay : item.start < to && item.end > from;

/** Rows of these calendars (and these invitations) that may have an occurrence in [from, to). */
function candidateRows(calIds: string[], invitedIds: string[], from: number, to: number): EvRow[] {
  const slack = 14 * 3_600_000;
  const lo = from - slack;
  const hi = to + slack;
  const cals = JSON.stringify(calIds);
  const inv = JSON.stringify(invitedIds);
  return sql(
    `SELECT * FROM cal_events WHERE deleted_at IS NULL AND (cal_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)) OR parent_id IN (SELECT value FROM json_each(?)))
       AND start_at < ? AND ((rrule IS NULL AND end_at > ?) OR (rrule IS NOT NULL AND parent_id IS NULL AND (until_at IS NULL OR until_at > ?)))
     ORDER BY start_at LIMIT 20000`
  ).all(cals, inv, inv, hi, lo, lo) as unknown as EvRow[];
}

export interface RangeQuery {
  from: number;
  to: number;
  /** Only these calendars (busy overlays); default every calendar the viewer reads. */
  calIds?: string[];
  /** Busy only: titles and details are left out. */
  busyOnly?: boolean;
}

/** The viewer's readable calendars of the workspace. */
export function readableCalendars(acc: CalAccess): CalRow[] {
  calDb();
  return (sql("SELECT * FROM cal_calendars WHERE ws_id = ? AND deleted_at IS NULL ORDER BY created_at").all(acc.ws) as unknown as CalRow[]).filter((c) => acc.canRead(c));
}

/** Every occurrence the viewer sees in [from, to): their calendars' events, expanded, and events they are a guest of. */
export function listRange(v: Viewer, q: RangeQuery): EventItem[] {
  calDb();
  const { acc } = v;
  if (!acc.member) return [];
  const from = Math.floor(q.from);
  const to = Math.min(Math.floor(q.to), from + MAX_RANGE);
  const cals = new Map(readableCalendars(acc).map((c) => [c.id, c]));
  const calIds = q.calIds ? q.calIds.filter((id) => cals.has(id)) : [...cals.keys()];
  // Invitations: series and single events the viewer is a guest of, in calendars they cannot read.
  const mine = sql("SELECT a.event_id, a.rsvp FROM cal_attendees a JOIN cal_events e ON e.id = a.event_id WHERE a.user_id = ? AND e.ws_id = ? AND e.deleted_at IS NULL").all(acc.userId, acc.ws) as { event_id: string; rsvp: Rsvp }[];
  const myRsvp = new Map(mine.map((m) => [m.event_id, m.rsvp]));
  const invitedIds = q.calIds ? [] : mine.map((m) => m.event_id);
  const rows = candidateRows(calIds, invitedIds, from, to);
  const fromDay = dayOf(from, v.tz);
  const toDay = dayOf(to - 1, v.tz);
  const guestCount = new Map<string, number>();
  if (rows.length) {
    for (const g of sql("SELECT event_id, COUNT(*) AS n FROM cal_attendees WHERE event_id IN (SELECT value FROM json_each(?)) GROUP BY event_id").all(JSON.stringify(rows.map((r) => r.parent_id ?? r.id))) as { event_id: string; n: number }[])
      guestCount.set(g.event_id, Number(g.n));
  }
  // Overrides by series, so their occurrences are not shown twice.
  const overridden = new Map<string, Set<string>>();
  for (const r of rows) if (r.parent_id && r.recurrence_id) (overridden.get(r.parent_id) ?? overridden.set(r.parent_id, new Set()).get(r.parent_id)!).add(r.recurrence_id);
  // Overrides of series in range may lie outside it: fetch the missing ones by series.
  const masters = rows.filter((r) => r.rrule && !r.parent_id).map((r) => r.id);
  if (masters.length) {
    for (const o of sql("SELECT parent_id, recurrence_id FROM cal_events WHERE parent_id IN (SELECT value FROM json_each(?)) AND recurrence_id IS NOT NULL").all(JSON.stringify(masters)) as { parent_id: string; recurrence_id: string }[])
      (overridden.get(o.parent_id) ?? overridden.set(o.parent_id, new Set()).get(o.parent_id)!).add(o.recurrence_id);
  }
  const out: EventItem[] = [];
  for (const r of rows) {
    const cal = cals.get(r.cal_id);
    const seriesId = r.parent_id ?? r.id;
    const invited = !cal && myRsvp.has(seriesId);
    if (!cal && !invited) continue;
    if (r.status === "cancelled") continue;
    const opts = {
      canEdit: Boolean(cal) && acc.canWrite(cal as CalRow) && !q.busyOnly,
      invited,
      rsvp: myRsvp.get(seriesId),
      guests: guestCount.get(seriesId) ?? 0,
      recurring: Boolean(r.rrule) || Boolean(r.parent_id),
    };
    const s = r.parent_id ? null : seriesOf(r);
    const push = (it: EventItem) => {
      if (!overlaps(it, from, to, fromDay, toDay)) return;
      out.push(q.busyOnly ? { ...it, title: "", location: "", conference: "", guests: 0 } : it);
    };
    if (!s) {
      push(toItem(r, null, opts));
      continue;
    }
    const spanDays = Math.max(1, daysBetween(r.start_day, r.end_day) + 1);
    const skip = overridden.get(r.id);
    for (const o of expand(s, addDays(fromDay, -spanDays - 1), addDays(toDay, 1), 3000)) {
      if (skip?.has(o.key)) continue;
      push(toItem(r, o, opts));
    }
  }
  return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------ one event

function docsFor(acc: CalAccess, r: EvRow): EventDoc[] {
  const out: EventDoc[] = [];
  for (const id of parseJson<string[]>(r.docs, [])) {
    if (!canReadNote(acc.ws, acc.userId, id)) continue;
    const n = sql("SELECT json_extract(json, '$.title') AS title, json_extract(json, '$.icon') AS icon, json_extract(json, '$.trashedAt') AS trashed FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(acc.ws, id) as
      | { title: string | null; icon: string | null; trashed: number | null }
      | undefined;
    if (!n || n.trashed) continue;
    const title = typeof n.title === "string" ? n.title : "";
    out.push({ id, title: displayTitle({ title }, ""), icon: typeof n.icon === "string" && !n.icon.startsWith("/") && !n.icon.startsWith("icon:") ? n.icon : "", url: `/docs?ws=${encodeURIComponent(acc.ws)}#${noteSlug({ id, title })}` });
  }
  return out;
}

/** An event as its detail panel shows it, at an occurrence; null when the viewer may not see it. */
export function eventDetail(acc: CalAccess, id: string, occ?: string | null): EventDetail | null {
  const r = eventRow(id);
  if (!r || !canSeeEvent(acc, r)) return null;
  const cal = calRow(r.cal_id);
  const seriesId = r.parent_id ?? r.id;
  const series = r.parent_id ? eventRow(r.parent_id) : r;
  const atts = attendeesOf(seriesId);
  const mine = atts.find((a) => a.user_id === acc.userId);
  let at: { key: string; day: string; start: number } | null = null;
  if (occ && !r.parent_id && r.rrule) {
    const s = seriesOf(r);
    const p = parseOccKey(occ);
    if (s && p) at = expand(s, p.day, p.day, 10).find((o) => o.key === occ) ?? null;
  }
  const nameOf = names([r.organizer_id, ...atts.map((a) => a.user_id)]);
  const attendees: Attendee[] = atts.map((a) => ({ email: a.email.startsWith("member:") ? "" : a.email, ...(a.user_id ? { userId: a.user_id } : {}), name: a.user_id ? (nameOf.get(a.user_id) ?? a.name) : a.name, rsvp: a.rsvp }));
  const item = toItem(r, at, { canEdit: acc.canWrite(cal), invited: !acc.canRead(cal), rsvp: mine?.rsvp, guests: atts.length, recurring: Boolean(r.rrule || r.parent_id) });
  return {
    ...item,
    seriesId,
    rrule: series?.rrule ?? null,
    description: r.description,
    reminders: parseJson<Reminder[]>(r.reminders, []),
    attendees,
    docs: docsFor(acc, r),
    place: parseJson<EventDetail["place"]>(r.place, null),
    organizer: r.organizer_id ? { id: r.organizer_id, name: nameOf.get(r.organizer_id) ?? "" } : null,
    canRsvp: Boolean(mine),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ------------------------------------------------------------ writing

const COLS = [
  "id", "cal_id", "ws_id", "uid", "parent_id", "recurrence_id", "title", "description", "location", "place", "conference", "color", "all_day", "start_at", "end_at", "start_day", "end_day", "tz", "rrule", "exdates", "until_at",
  "status", "busy", "reminders", "remind_lead", "docs", "organizer_id", "booking_id", "remote_href", "remote_etag", "sequence", "created_by", "updated_by", "created_at", "updated_at", "deleted_at",
] as const;

/** Writes a whole row (insert or update by id). */
export function putRow(r: EvRow | Omit<EvRow, "seq">): void {
  const row = { ...r, until_at: r.rrule && !r.parent_id ? untilOf(r) : r.end_at } as Record<string, unknown>;
  const vals = COLS.map((c) => (row[c] === undefined ? null : row[c])) as (string | number | null)[];
  sql(`INSERT INTO cal_events (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")}) ON CONFLICT(id) DO UPDATE SET ${COLS.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`).run(...vals);
}

export function blankRow(cal: CalRow, by: string | null, now: number): Omit<EvRow, "seq"> {
  const id = newId(12);
  const start = Math.ceil(now / 1_800_000) * 1_800_000;
  return {
    id,
    cal_id: cal.id,
    ws_id: cal.ws_id,
    uid: `${id}@zvena`,
    parent_id: null,
    recurrence_id: null,
    title: "",
    description: "",
    location: "",
    place: null,
    conference: "",
    color: null,
    all_day: 0,
    start_at: start,
    end_at: start + 1_800_000,
    start_day: dayOf(start, cal.tz),
    end_day: dayOf(start + 1_800_000, cal.tz),
    tz: cal.tz,
    rrule: null,
    exdates: "[]",
    until_at: null,
    status: "confirmed",
    busy: 1,
    reminders: "[]",
    remind_lead: 0,
    docs: "[]",
    organizer_id: by,
    booking_id: null,
    remote_href: null,
    remote_etag: null,
    sequence: 0,
    created_by: by,
    updated_by: by,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

// --- undo ---------------------------------------------------------------------

interface Snapshot {
  userId: string;
  ws: string;
  at: number;
  rows: EvRow[];
  atts: AttRow[];
  /** Ids of rows the write created (they go again on undo). */
  created: string[];
}

const UNDO_KEY = Symbol.for("zvena.calendar.undo");
const ug = globalThis as unknown as Record<symbol, Map<string, Snapshot> | undefined>;
const undos: Map<string, Snapshot> = (ug[UNDO_KEY] ??= new Map());
const UNDO_TTL = 15 * 60_000;

/** The rows of a series (master and overrides) and their guests, as they are now. */
function capture(seriesIds: string[]): { rows: EvRow[]; atts: AttRow[] } {
  const ids = JSON.stringify(seriesIds);
  const rows = sql("SELECT * FROM cal_events WHERE id IN (SELECT value FROM json_each(?)) OR parent_id IN (SELECT value FROM json_each(?))").all(ids, ids) as unknown as EvRow[];
  const atts = sql("SELECT * FROM cal_attendees WHERE event_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(rows.map((r) => r.id))) as unknown as AttRow[];
  return { rows, atts };
}

function remember(userId: string, ws: string, before: { rows: EvRow[]; atts: AttRow[] }, created: string[]): string {
  const now = Date.now();
  for (const [k, s] of undos) if (now - s.at > UNDO_TTL) undos.delete(k);
  if (undos.size > 5000) undos.clear();
  const token = newId(12);
  undos.set(token, { userId, ws, at: now, rows: before.rows, atts: before.atts, created });
  return token;
}

/** Puts back what a write changed. Returns the series ids touched, or null when the token is not this person's (or too old). */
export function undo(acc: CalAccess, token: unknown): { seriesIds: string[]; calIds: string[] } | null {
  if (typeof token !== "string") return null;
  const s = undos.get(token);
  if (!s || s.userId !== acc.userId || s.ws !== acc.ws || Date.now() - s.at > UNDO_TTL) return null;
  // Still allowed to write each calendar involved.
  const calIds = new Set([...s.rows.map((r) => r.cal_id), ...s.created.map((id) => eventRow(id)?.cal_id).filter((x): x is string => Boolean(x))]);
  for (const c of calIds) if (!acc.canWrite(calRow(c))) throw new CalError(403, "forbidden");
  undos.delete(token);
  const now = Date.now();
  tx(() => {
    for (const id of s.created) {
      if (s.rows.some((r) => r.id === id)) continue;
      sql("UPDATE cal_events SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    }
    for (const r of s.rows) putRow({ ...r, updated_at: now });
    const ids = JSON.stringify(s.rows.map((r) => r.id));
    sql("DELETE FROM cal_attendees WHERE event_id IN (SELECT value FROM json_each(?))").run(ids);
    for (const a of s.atts)
      sql("INSERT INTO cal_attendees (event_id, email, user_id, name, rsvp, token_hash, invited_at, responded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").run(a.event_id, a.email, a.user_id, a.name, a.rsvp, a.token_hash, a.invited_at, a.responded_at);
  });
  const series = new Set<string>([...s.rows.map((r) => r.parent_id ?? r.id), ...s.created]);
  return { seriesIds: [...series], calIds: [...calIds] };
}

// --- guests ---------------------------------------------------------------------

export interface GuestChange {
  added: AttRow[];
  removed: AttRow[];
  kept: AttRow[];
}

/** Makes the guests of a series exactly `list` (answers of guests who stay are kept). */
export function setGuests(eventId: string, list: { email: string; userId: string | null; name: string }[], now: number): GuestChange {
  const have = attendeesOf(eventId);
  const want = new Map(list.map((a) => [a.email, a]));
  const removed = have.filter((a) => !want.has(a.email));
  const kept = have.filter((a) => want.has(a.email));
  const added: AttRow[] = [];
  for (const a of removed) sql("DELETE FROM cal_attendees WHERE event_id = ? AND email = ?").run(eventId, a.email);
  for (const a of list) {
    if (have.some((h) => h.email === a.email)) continue;
    const row: AttRow = { event_id: eventId, email: a.email, user_id: a.userId, name: a.name.slice(0, 200), rsvp: "needs-action", token_hash: null, invited_at: now, responded_at: null };
    sql("INSERT INTO cal_attendees (event_id, email, user_id, name, rsvp, invited_at) VALUES (?, ?, ?, ?, 'needs-action', ?)").run(eventId, row.email, row.user_id, row.name, now);
    added.push(row);
  }
  return { added, removed, kept };
}

// --- create / update / delete ------------------------------------------------------

export interface WriteOutcome {
  /** The row the person was editing, as stored (for the panel). */
  id: string;
  occ: string | null;
  /** Series touched (index, pulse, CalDAV). */
  seriesIds: string[];
  calIds: string[];
  undo: string;
  guests?: GuestChange;
  /** The times of the series moved (guests get an update). */
  moved: boolean;
  /** Rows deleted (guests get a cancellation). */
  deleted: string[];
}

function writableCal(acc: CalAccess, id: unknown): CalRow {
  const cal = calRow(id);
  if (!cal || !acc.canRead(cal)) throw new CalError(404, "calendar not found");
  if (!acc.canWrite(cal)) throw new CalError(403, "read only");
  return cal;
}

/** A new event (or series) in a calendar the person may write. */
export function createEvent(acc: CalAccess, input: EventInput & { attendees?: unknown }, now = Date.now()): WriteOutcome {
  const cal = writableCal(acc, input.calId);
  const base = blankRow(cal, acc.userId, now);
  const fields = cleanFields(input, base, cal.tz);
  const row = { ...base, ...fields } as Omit<EvRow, "seq">;
  if (!fields.reminders) row.reminders = "[]";
  // All-day events show as free unless said otherwise (a birthday or a holiday does not block the day).
  if (row.all_day === 1 && input.busy === undefined) row.busy = 0;
  const guests = input.attendees !== undefined ? cleanAttendees(input.attendees, acc.ws, acc.userId) : [];
  let change: GuestChange | undefined;
  tx(() => {
    putRow(row);
    if (guests.length) change = setGuests(row.id, guests, now);
  });
  return { id: row.id, occ: null, seriesIds: [row.id], calIds: [cal.id], undo: remember(acc.userId, acc.ws, { rows: [], atts: [] }, [row.id]), guests: change, moved: false, deleted: [] };
}

/** The occurrence a key names in a series (checked against the rule). */
function occurrenceOf(master: EvRow, key: unknown): { key: string; day: string; start: number } | null {
  if (typeof key !== "string") return null;
  const s = seriesOf(master);
  const p = parseOccKey(key);
  if (!s || !p) return null;
  return expand({ ...s, exdates: undefined }, p.day, p.day, 10).find((o) => o.key === key) ?? null;
}

const TIME_FIELDS = ["all_day", "start_at", "end_at", "start_day", "end_day", "tz"] as const;
const timesChanged = (a: Partial<EvRow>, b: Partial<EvRow>) => TIME_FIELDS.some((k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]);

/** A weekly rule's weekdays moved with the event (Monday's meeting dragged to Tuesday repeats on Tuesdays). */
function shiftRule(rrule: string | null, days: number): string | null {
  const r = rrule ? parseRRule(rrule) : null;
  if (!r || !days || !r.byDay?.length || r.freq !== "WEEKLY") return rrule;
  return formatRRule({ ...r, byDay: r.byDay.map((b) => ({ ...b, wd: (((b.wd + days) % 7) + 7) % 7 })) });
}

/** The series' new start when one of its occurrences moved from `before` to `after` (same wall-clock shift). */
function shiftMaster(master: EvRow, before: Pick<EventItem, "start" | "startDay">, after: Partial<EvRow>): Partial<EvRow> {
  if (after.all_day === 1 || master.all_day === 1) {
    if (after.all_day === 1 && master.all_day === 1) {
      const d = daysBetween(before.startDay, after.start_day as string);
      const span = daysBetween(after.start_day as string, after.end_day as string);
      const sd = addDays(master.start_day, d);
      const ed = addDays(sd, span);
      const p = parseDay(sd);
      const q = parseDay(ed);
      return { start_day: sd, end_day: ed, start_at: Date.UTC(p.y, p.m - 1, p.d), end_at: Date.UTC(q.y, q.m - 1, q.d) };
    }
    // Between all-day and timed: the series starts on its first day at the new time.
    const tz = (after.tz as string) ?? master.tz;
    if (after.all_day === 1) {
      const span = daysBetween(after.start_day as string, after.end_day as string);
      const p = parseDay(master.start_day);
      const ed = addDays(master.start_day, span);
      const q = parseDay(ed);
      return { all_day: 1, start_day: master.start_day, end_day: ed, start_at: Date.UTC(p.y, p.m - 1, p.d), end_at: Date.UTC(q.y, q.m - 1, q.d), tz };
    }
    const start = atMinute(master.start_day, minuteOfDay(after.start_at as number, tz), tz);
    const dur = (after.end_at as number) - (after.start_at as number);
    return { all_day: 0, tz, start_at: start, end_at: start + dur, start_day: dayOf(start, tz), end_day: dayOf(start + dur, tz) };
  }
  const tz = (after.tz as string) ?? master.tz;
  const dayShift = daysBetween(before.startDay, dayOf(after.start_at as number, tz));
  const minute = minuteOfDay(after.start_at as number, tz);
  const start = atMinute(addDays(master.start_day, dayShift), minute, tz);
  const dur = (after.end_at as number) - (after.start_at as number);
  return { tz, start_at: start, end_at: start + dur, start_day: dayOf(start, tz), end_day: dayOf(start + dur, tz) };
}

export interface UpdateInput extends EventInput {
  scope?: unknown;
  occ?: unknown;
}

/** Changes an event, one occurrence, this and following, or the whole series. */
export function updateEvent(acc: CalAccess, id: string, input: UpdateInput, now = Date.now()): WriteOutcome {
  const target = eventRow(id);
  if (!target || target.deleted_at || !canSeeEvent(acc, target)) throw new CalError(404, "event not found");
  const cal = calRow(target.cal_id);
  if (!acc.canWrite(cal)) throw new CalError(403, "read only");
  // Moving it to another calendar: one the person may write, of the same workspace.
  const toCal = input.calId !== undefined && input.calId !== target.cal_id ? writableCal(acc, input.calId) : null;
  const master = target.parent_id ? eventRow(target.parent_id) : target;
  if (!master) throw new CalError(404, "event not found");
  const scope: Scope = input.scope === "following" || input.scope === "all" ? input.scope : "this";
  const recurring = Boolean(master.rrule);
  const before = capture([master.id]);
  const created: string[] = [];
  const fields = cleanFields(input, target, cal!.tz);
  if (toCal) fields.cal_id = toCal.id;
  const guests = input.attendees !== undefined ? cleanAttendees(input.attendees, acc.ws, master.organizer_id ?? acc.userId) : null;
  const stamp = { updated_at: now, updated_by: acc.userId };
  let resultId = target.id;
  let resultOcc: string | null = null;
  let moved = false;
  let change: GuestChange | undefined;
  tx(() => {
    if (!recurring || (target.parent_id && scope === "this")) {
      // A single event, or an override changed on its own.
      const next = { ...target, ...fields, ...stamp, sequence: target.sequence + (timesChanged(fields, target) ? 1 : 0) };
      if (target.parent_id) delete (next as Partial<EvRow>).rrule;
      moved = timesChanged(fields, target);
      putRow(next);
      if (toCal && !target.parent_id) sql("UPDATE cal_events SET cal_id = ? WHERE parent_id = ?").run(toCal.id, target.id);
      if (guests && !target.parent_id) change = setGuests(target.id, guests, now);
      resultOcc = target.parent_id ? target.recurrence_id : null;
      return;
    }
    // A repeating event: which occurrence was edited.
    const occ = target.parent_id ? occurrenceOf(master, target.recurrence_id) : occurrenceOf(master, input.occ);
    if (!occ && scope !== "all") throw new CalError(400, "bad occurrence");
    const occItem = occ ? placeOcc(master, occ) : { start: master.start_at, end: master.end_at, startDay: master.start_day, endDay: master.end_day };
    const occBase: Partial<EvRow> = target.parent_id ? target : { ...master, start_at: occItem.start, end_at: occItem.end, start_day: occItem.startDay, end_day: occItem.endDay };
    // The edit as it applies to this occurrence.
    const occFields = cleanFields(input, occBase, cal!.tz);
    const isFirst = occ ? occurrenceIndex(seriesOf(master)!, occ.key) === 0 : true;
    if (scope === "this") {
      const key = (occ as { key: string }).key;
      const existing = sql("SELECT * FROM cal_events WHERE parent_id = ? AND recurrence_id = ?").get(master.id, key) as EvRow | undefined;
      const base = existing ?? { ...master, ...occBase, id: newId(12), parent_id: master.id, recurrence_id: key, rrule: null, exdates: "[]", created_at: now, created_by: acc.userId, remote_href: null, remote_etag: null };
      const next = { ...base, ...occFields, ...stamp, rrule: null, cal_id: master.cal_id } as EvRow;
      putRow(next);
      if (!existing) created.push(next.id);
      resultId = next.id;
      resultOcc = key;
      moved = timesChanged(occFields, occBase);
      if (guests) change = setGuests(master.id, guests, now);
      return;
    }
    const timeMove = timesChanged(occFields, occBase);
    if (scope === "all" || isFirst) {
      // The whole series: a moved occurrence moves every one by the same wall-clock shift.
      const shift: Partial<EvRow> = timeMove ? shiftMaster(master, occItem, { ...occBase, ...occFields }) : {};
      const dayShift = timeMove && shift.start_day ? daysBetween(master.start_day, shift.start_day) : 0;
      const { start_at: _a, end_at: _b, start_day: _c, end_day: _d, all_day: _e, tz: _f, ...rest } = fields;
      void [_a, _b, _c, _d, _e, _f];
      const next = { ...master, ...rest, ...shift, ...stamp, rrule: rest.rrule !== undefined ? rest.rrule : shiftRule(master.rrule, dayShift), sequence: master.sequence + (timeMove ? 1 : 0) };
      if (timeMove || rest.rrule !== undefined) {
        // Exceptions named the old occurrences: they no longer line up.
        next.exdates = "[]";
        sql("UPDATE cal_events SET deleted_at = ?, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL").run(now, now, master.id);
      } else {
        // Text fields reach the overrides too (Google's "all events").
        const textOnly: Partial<EvRow> = {};
        for (const k of ["title", "description", "location", "place", "conference", "color", "busy", "reminders", "remind_lead", "docs", "cal_id"] as const) if (fields[k] !== undefined) (textOnly as Record<string, unknown>)[k] = fields[k];
        for (const o of sql("SELECT * FROM cal_events WHERE parent_id = ? AND deleted_at IS NULL").all(master.id) as unknown as EvRow[]) putRow({ ...o, ...textOnly, ...stamp });
      }
      putRow(next);
      if (guests) change = setGuests(master.id, guests, now);
      resultId = master.id;
      resultOcc = occ && !timeMove ? occ.key : null;
      moved = timeMove;
      return;
    }
    // This and following: the series ends before this occurrence, a new one starts here.
    const s = seriesOf(master)!;
    const index = occurrenceIndex(s, (occ as { key: string }).key);
    const rule = s.rule;
    const remaining = rule.count ? rule.count - index : undefined;
    const oldRule: RRule = { ...rule, count: rule.count ? index : undefined, until: rule.count ? undefined : (untilBefore(master.all_day === 1, (occ as { key: string }).key) ?? undefined) };
    putRow({ ...master, rrule: formatRRule(oldRule), ...stamp });
    const startFields = timeMove ? { ...occBase, ...occFields } : occBase;
    const dayShift = timeMove ? daysBetween(occItem.startDay, (startFields.start_day as string) ?? occItem.startDay) : 0;
    const newRule = fields.rrule !== undefined ? fields.rrule : formatRRule({ ...rule, count: remaining, until: rule.until });
    const fresh = newId(12);
    const next: Omit<EvRow, "seq"> = {
      ...master,
      ...fields,
      ...pickTimes(startFields),
      id: fresh,
      uid: `${fresh}@zvena`,
      parent_id: null,
      recurrence_id: null,
      rrule: shiftRule(newRule ?? null, dayShift),
      exdates: "[]",
      remote_href: null,
      remote_etag: null,
      sequence: 0,
      created_at: now,
      created_by: acc.userId,
      ...stamp,
    };
    putRow(next);
    created.push(fresh);
    // Overrides and exceptions from here on belong to the new series (when the times line up).
    const key = (occ as { key: string }).key;
    if (!timeMove) {
      sql("UPDATE cal_events SET parent_id = ? WHERE parent_id = ? AND recurrence_id >= ?").run(fresh, master.id, key);
      const ex = parseJson<string[]>(master.exdates, []);
      sql("UPDATE cal_events SET exdates = ? WHERE id = ?").run(JSON.stringify(ex.filter((x) => x < key)), master.id);
      sql("UPDATE cal_events SET exdates = ? WHERE id = ?").run(JSON.stringify(ex.filter((x) => x >= key)), fresh);
    } else sql("UPDATE cal_events SET deleted_at = ? WHERE parent_id = ? AND recurrence_id >= ? AND deleted_at IS NULL").run(now, master.id, key);
    for (const a of attendeesOf(master.id))
      sql("INSERT INTO cal_attendees (event_id, email, user_id, name, rsvp, invited_at, responded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").run(fresh, a.email, a.user_id, a.name, a.rsvp, a.invited_at, a.responded_at);
    if (guests) change = setGuests(fresh, guests, now);
    // A split at nothing left: the old series is gone.
    const left = eventRow(master.id) as EvRow;
    if (!hasOccurrences(seriesOf(left) ?? s)) sql("UPDATE cal_events SET deleted_at = ? WHERE id = ?").run(now, master.id);
    resultId = fresh;
    resultOcc = null;
    moved = timeMove;
  });
  const series = new Set([master.id, ...created.filter((c) => !eventRow(c)?.parent_id)]);
  return { id: resultId, occ: resultOcc, seriesIds: [...series], calIds: [...new Set([target.cal_id, ...(toCal ? [toCal.id] : [])])], undo: remember(acc.userId, acc.ws, before, created), guests: change, moved, deleted: [] };
}

function pickTimes(r: Partial<EvRow>): Partial<EvRow> {
  const out: Partial<EvRow> = {};
  for (const k of TIME_FIELDS) if (r[k] !== undefined) (out as Record<string, unknown>)[k] = r[k];
  return out;
}

/** Deletes an event, one occurrence, this and following, or the series (kept 30 days for undo, then purged). */
export function deleteEvent(acc: CalAccess, id: string, input: { scope?: unknown; occ?: unknown }, now = Date.now()): WriteOutcome {
  const target = eventRow(id);
  if (!target || target.deleted_at || !canSeeEvent(acc, target)) throw new CalError(404, "event not found");
  if (!acc.canWrite(calRow(target.cal_id))) throw new CalError(403, "read only");
  const master = target.parent_id ? eventRow(target.parent_id) : target;
  if (!master) throw new CalError(404, "event not found");
  const scope: Scope = input.scope === "following" || input.scope === "all" ? input.scope : "this";
  const before = capture([master.id]);
  const deleted: string[] = [];
  tx(() => {
    if (!master.rrule || scope === "all") {
      sql("UPDATE cal_events SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE (id = ? OR parent_id = ?) AND deleted_at IS NULL").run(now, now, acc.userId, master.id, master.id);
      deleted.push(master.id);
      return;
    }
    const key = target.parent_id ? target.recurrence_id : typeof input.occ === "string" ? input.occ : null;
    const occ = occurrenceOf(master, key);
    if (!occ) throw new CalError(400, "bad occurrence");
    const s = seriesOf(master)!;
    if (scope === "following" && occurrenceIndex(s, occ.key) > 0) {
      const rule = s.rule;
      const index = occurrenceIndex(s, occ.key);
      putRow({ ...master, rrule: formatRRule({ ...rule, count: rule.count ? index : undefined, until: rule.count ? undefined : (untilBefore(master.all_day === 1, occ.key) ?? undefined) }), updated_at: now, updated_by: acc.userId });
      sql("UPDATE cal_events SET deleted_at = ? WHERE parent_id = ? AND recurrence_id >= ? AND deleted_at IS NULL").run(now, master.id, occ.key);
      return;
    }
    if (scope === "following") {
      sql("UPDATE cal_events SET deleted_at = ?, updated_at = ? WHERE (id = ? OR parent_id = ?) AND deleted_at IS NULL").run(now, now, master.id, master.id);
      deleted.push(master.id);
      return;
    }
    // This occurrence: an exception on the series (and its override, if any, goes).
    const ex = new Set(parseJson<string[]>(master.exdates, []));
    ex.add(occ.key);
    putRow({ ...master, exdates: JSON.stringify([...ex].sort()), updated_at: now, updated_by: acc.userId });
    sql("UPDATE cal_events SET deleted_at = ? WHERE parent_id = ? AND recurrence_id = ? AND deleted_at IS NULL").run(now, master.id, occ.key);
  });
  return { id: master.id, occ: null, seriesIds: [master.id], calIds: [master.cal_id], undo: remember(acc.userId, acc.ws, before, []), moved: false, deleted };
}

/** A copy of an event (one occurrence of a series becomes a single event), right after it. */
export function duplicateEvent(acc: CalAccess, id: string, occKeyIn: unknown, now = Date.now()): WriteOutcome {
  const r = eventRow(id);
  if (!r || r.deleted_at || !canSeeEvent(acc, r)) throw new CalError(404, "event not found");
  const cal = calRow(r.cal_id);
  // A copy of something one may only read goes to one's own default calendar.
  const into = acc.canWrite(cal) ? (cal as CalRow) : defaultCalendarOf(acc);
  if (!into) throw new CalError(403, "read only");
  const occ = !r.parent_id && r.rrule ? occurrenceOf(r, occKeyIn) : null;
  const at = placeOcc(r, occ);
  const fresh = newId(12);
  const row: Omit<EvRow, "seq"> = {
    ...r,
    id: fresh,
    uid: `${fresh}@zvena`,
    cal_id: into.id,
    parent_id: null,
    recurrence_id: null,
    rrule: occ ? null : r.parent_id ? null : r.rrule,
    exdates: occ ? "[]" : r.exdates,
    start_at: at.start,
    end_at: at.end,
    start_day: at.startDay,
    end_day: at.endDay,
    organizer_id: acc.userId,
    booking_id: null,
    remote_href: null,
    remote_etag: null,
    sequence: 0,
    created_by: acc.userId,
    updated_by: acc.userId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  putRow(row);
  return { id: fresh, occ: null, seriesIds: [fresh], calIds: [into.id], undo: remember(acc.userId, acc.ws, { rows: [], atts: [] }, [fresh]), moved: false, deleted: [] };
}

/** The viewer's answer to an invitation (the whole series). */
export function rsvp(acc: CalAccess, id: string, answer: unknown, now = Date.now()): string {
  const r = eventRow(id);
  if (!r || r.deleted_at || !canSeeEvent(acc, r)) throw new CalError(404, "event not found");
  if (!RSVPS.includes(answer as Rsvp) || answer === "needs-action") throw new CalError(400, "bad answer");
  const series = r.parent_id ?? r.id;
  const n = sql("UPDATE cal_attendees SET rsvp = ?, responded_at = ? WHERE event_id = ? AND user_id = ?").run(answer as string, now, series, acc.userId).changes;
  if (!Number(n)) throw new CalError(403, "not a guest");
  return series;
}

export function defaultCalendarOf(acc: CalAccess): CalRow | null {
  calDb();
  return (sql("SELECT * FROM cal_calendars WHERE ws_id = ? AND owner_id = ? AND kind = 'local' AND deleted_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1").get(acc.ws, acc.userId) as CalRow | undefined) ?? null;
}

/** Deleted events are kept this long (undo, CalDAV catching up), then removed for good. */
const KEEP_DELETED = 30 * DAY;

export function purgeDeleted(now = Date.now()): number {
  calDb();
  return Number(sql("DELETE FROM cal_events WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(now - KEEP_DELETED).changes);
}

