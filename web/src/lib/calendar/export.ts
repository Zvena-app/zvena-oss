// Server-only: events as iCalendar — the secret feed, the .ics download,
// CalDAV bodies and invitations all describe an event the same way.

import { config } from "../config";
import { sql } from "../store";
import type { CalRow } from "./access";
import { calDb } from "./db";
import { attendeesOf, parseJson, type AttRow, type EvRow } from "./events";
import { buildIcs, type IcsOutEvent, type IcsPerson } from "./ics";
import type { Reminder, Rsvp } from "./types";

const PARTSTAT: Record<Rsvp, string> = { "needs-action": "NEEDS-ACTION", accepted: "ACCEPTED", declined: "DECLINED", tentative: "TENTATIVE" };

/** The Markdown of a description as plain text that keeps its lines (mentions read @name, links "text (url)"). */
export function mdToText(md: string): string {
  return md
    .slice(0, 20_000)
    .replace(/\[@ ([^[\]]{0,300})\]/g, (_, attrs: string) => `@${/label="([^"]*)"/.exec(attrs)?.[1] ?? ""}`)
    .replace(/!\[[^[\]]*\]\([^()]*\)/g, "")
    .replace(/\[([^[\]]*)\]\(([^()\s]*)\)/g, (_, t: string, u: string) => (u && u !== t ? `${t} (${u})` : t))
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/gm, (_, sp: string, x: string) => `${sp}${x.trim() ? "☑" : "☐"} `)
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>@])/g, "$1")
    .trim();
}

function organizerOf(r: EvRow): IcsPerson | undefined {
  if (!r.organizer_id) return undefined;
  const u = sql("SELECT name, email FROM users WHERE id = ?").get(r.organizer_id) as { name: string; email: string | null } | undefined;
  return u?.email ? { email: u.email, name: u.name } : undefined;
}

function guests(atts: AttRow[]): IcsPerson[] {
  return atts.filter((a) => !a.email.startsWith("member:")).map((a) => ({ email: a.email, ...(a.name ? { name: a.name } : {}), partstat: PARTSTAT[a.rsvp] }));
}

/** One row as an ICS event (an override carries its RECURRENCE-ID). */
export function outEvent(r: EvRow, opts: { guests?: AttRow[]; withAlarms?: boolean; method?: "CANCEL" } = {}): IcsOutEvent {
  const appLink = `${config.appUrl}/calendar?ws=${encodeURIComponent(r.ws_id)}&event=${encodeURIComponent(r.parent_id ?? r.id)}`;
  return {
    uid: r.uid,
    title: r.title,
    description: mdToText(r.description),
    location: r.location,
    url: appLink,
    allDay: r.all_day === 1,
    start: r.start_at,
    end: r.end_at,
    startDay: r.start_day,
    endDay: r.end_day,
    tz: r.tz,
    rrule: r.parent_id ? null : r.rrule,
    exdates: r.parent_id ? [] : parseJson<string[]>(r.exdates, []),
    recurrenceId: r.parent_id ? r.recurrence_id : null,
    status: opts.method === "CANCEL" || r.status === "cancelled" ? "CANCELLED" : r.status === "tentative" ? "TENTATIVE" : "CONFIRMED",
    busy: r.busy === 1,
    sequence: r.sequence,
    created: r.created_at,
    updated: r.updated_at,
    organizer: organizerOf(r),
    attendees: opts.guests ? guests(opts.guests) : [],
    alarms: opts.withAlarms ? parseJson<Reminder[]>(r.reminders, []).map((x) => x.min) : [],
    conference: r.conference,
  };
}

/** A series and its overrides (the rows one CalDAV resource holds, one UID). */
export function seriesRows(masterId: string, includeDeleted = false): EvRow[] {
  calDb();
  return sql(`SELECT * FROM cal_events WHERE (id = ? OR parent_id = ?)${includeDeleted ? "" : " AND deleted_at IS NULL"} ORDER BY parent_id IS NOT NULL, start_at`).all(masterId, masterId) as unknown as EvRow[];
}

/** A whole calendar as a feed or a download (guests left out: a feed is read by apps, not people). */
export function calendarIcs(cal: CalRow, now = Date.now()): string {
  calDb();
  const rows = sql("SELECT * FROM cal_events WHERE cal_id = ? AND deleted_at IS NULL ORDER BY parent_id IS NOT NULL, start_at LIMIT 50000").all(cal.id) as unknown as EvRow[];
  return buildIcs({ name: cal.name, method: "PUBLISH", events: rows.filter((r) => r.status !== "cancelled" || r.parent_id).map((r) => outEvent(r)), now });
}

/** One series as a CalDAV body or an invitation (with its guests). */
export function seriesIcs(masterId: string, opts: { method?: "REQUEST" | "CANCEL"; withAlarms?: boolean; includeDeleted?: boolean } = {}): string {
  const rows = seriesRows(masterId, opts.includeDeleted);
  const atts = rows.length ? attendeesOf(rows[0].parent_id ?? rows[0].id) : [];
  const { includeDeleted: _d, ...rest } = opts;
  void _d;
  return buildIcs({ ...(rest.method ? { method: rest.method } : {}), events: rows.map((r) => outEvent(r, { guests: atts, withAlarms: opts.withAlarms, ...(opts.method === "CANCEL" ? { method: "CANCEL" as const } : {}) })) });
}
