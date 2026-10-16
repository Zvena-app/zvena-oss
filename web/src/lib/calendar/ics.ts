// zvena Calendar: iCalendar (RFC 5545) files and feeds, read and written.
// Pure (browser, server, tests).
//
// Reading takes what other calendars send: subscriptions (Google's secret
// address, Outlook's published calendars, sports and holiday feeds), an
// imported .ics file, CalDAV event bodies, invitations. Times come in UTC,
// with a TZID (IANA names, Windows names, Mozilla's prefixed ones) or
// floating; a zone nobody knows falls back to the calendar's own.
//
// Writing makes the secret feed, the .ics download, CalDAV bodies and the
// invitations a booking sends: lines folded at 75 octets, text escaped, each
// zone used described by a VTIMEZONE so any client places the times right.

import { formatRRule, OCC_RE, parseRRule } from "./rrule";
import { addDays, atMinute, daysInMonth, dayNumber, fromWall, offsetOf, parseDay, validTimeZone, wallOf, weekday, ymd } from "./tz";

export interface IcsTime {
  day: string;
  /** Minutes since midnight; absent for a DATE value (all-day). */
  minute?: number;
  second?: number;
  utc?: boolean;
  /** The TZID parameter as written. */
  tzid?: string;
}

export interface IcsPerson {
  email: string;
  name?: string;
  /** NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE */
  partstat?: string;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  start: IcsTime;
  end?: IcsTime;
  /** DURATION in ms (when there is no DTEND). */
  duration?: number;
  rrule?: string;
  exdates: IcsTime[];
  recurrenceId?: IcsTime;
  status: string;
  transparent: boolean;
  sequence: number;
  organizer?: IcsPerson;
  attendees: IcsPerson[];
  /** Minutes before the start of each display/e-mail alarm. */
  alarms: number[];
  conference: string;
  color: string;
}

export interface IcsCalendar {
  name: string;
  /** X-WR-TIMEZONE: the zone of floating times. */
  tz: string;
  method: string;
  events: IcsEvent[];
}

/** At most this many events are read from one file (a feed of 20 years of holidays stays bounded). */
export const ICS_MAX_EVENTS = 20_000;

// ------------------------------------------------------------ reading

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(raw: string): Line | null {
  // name *(";" param) ":" value — a colon inside a quoted parameter is not the separator.
  let i = 0;
  let quoted = false;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) break;
  }
  if (i >= raw.length) return null;
  const head = raw.slice(0, i);
  const value = raw.slice(i + 1);
  const parts: string[] = [];
  let cur = "";
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const name = (parts.shift() ?? "").toUpperCase();
  if (!/^[A-Z0-9-]{1,60}$/.test(name)) return null;
  const params: Record<string, string> = {};
  for (const p of parts) {
    const j = p.indexOf("=");
    if (j < 1) continue;
    params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function parseTimeValue(v: string, params: Record<string, string>): IcsTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const day = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  if (day !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  if (!m[4] || params.VALUE === "DATE") return { day };
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (h > 23 || mi > 59) return null;
  return { day, minute: h * 60 + mi, second: Number(m[6] ?? 0), ...(m[7] ? { utc: true } : params.TZID ? { tzid: params.TZID } : {}) };
}

/** "P1DT2H", "-PT15M", "P2W" in ms, or null. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || v.trim().endsWith("T") || /^[+-]?P$/.test(v.trim())) return null;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86_400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function mailto(v: string): string {
  const e = v.replace(/^mailto:/i, "").trim().toLowerCase();
  return /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/.test(e) ? e : "";
}

function person(l: Line): IcsPerson | null {
  const email = mailto(l.value) || mailto(l.params.EMAIL ?? "");
  if (!email) return null;
  const name = (l.params.CN ?? "").trim().slice(0, 200);
  return { email, ...(name ? { name } : {}), ...(l.params.PARTSTAT ? { partstat: l.params.PARTSTAT.toUpperCase() } : {}) };
}

function blankEvent(): IcsEvent {
  return { uid: "", summary: "", description: "", location: "", url: "", start: { day: "1970-01-01" }, exdates: [], status: "CONFIRMED", transparent: false, sequence: 0, attendees: [], alarms: [], conference: "", color: "" };
}

/** A calendar file, as much of it as makes sense (broken events are skipped, never the whole file). */
export function parseIcs(text: string): IcsCalendar {
  const cal: IcsCalendar = { name: "", tz: "", method: "", events: [] };
  const stack: string[] = [];
  let ev: (IcsEvent & { _start?: boolean }) | null = null;
  let alarm: { trigger: number | null; action: string } | null = null;
  for (const raw of unfold(text)) {
    if (!raw.trim()) continue;
    const l = parseLine(raw);
    if (!l) continue;
    if (l.name === "BEGIN") {
      const what = l.value.trim().toUpperCase();
      stack.push(what);
      if (what === "VEVENT" && stack.length === 2) ev = blankEvent();
      else if (what === "VALARM" && ev) alarm = { trigger: null, action: "" };
      continue;
    }
    if (l.name === "END") {
      const what = stack.pop();
      if (what === "VEVENT" && ev) {
        if (ev.uid && ev._start && cal.events.length < ICS_MAX_EVENTS) {
          delete ev._start;
          cal.events.push(ev);
        }
        ev = null;
      } else if (what === "VALARM" && ev && alarm) {
        if (alarm.trigger !== null && alarm.trigger <= 0 && alarm.trigger > -40 * 86_400_000 && ev.alarms.length < 5) ev.alarms.push(Math.round(-alarm.trigger / 60_000));
        alarm = null;
      }
      continue;
    }
    const where = stack[stack.length - 1];
    if (where === "VCALENDAR" && stack.length === 1) {
      if (l.name === "X-WR-CALNAME" || l.name === "NAME") cal.name = unescapeText(l.value).slice(0, 200);
      else if (l.name === "X-WR-TIMEZONE") cal.tz = l.value.trim();
      else if (l.name === "METHOD") cal.method = l.value.trim().toUpperCase();
      continue;
    }
    if (where === "VALARM" && alarm) {
      if (l.name === "TRIGGER" && l.params.VALUE !== "DATE-TIME" && (l.params.RELATED ?? "START").toUpperCase() === "START") alarm.trigger = parseDuration(l.value);
      else if (l.name === "ACTION") alarm.action = l.value.trim().toUpperCase();
      continue;
    }
    if (where !== "VEVENT" || !ev) continue;
    const text2 = () => unescapeText(l.value);
    switch (l.name) {
      case "UID":
        ev.uid = l.value.trim().slice(0, 300);
        break;
      case "SUMMARY":
        ev.summary = text2().replace(/\s+/g, " ").trim().slice(0, 500);
        break;
      case "DESCRIPTION":
        ev.description = text2().slice(0, 20_000);
        break;
      case "LOCATION":
        ev.location = text2().replace(/\s+/g, " ").trim().slice(0, 500);
        break;
      case "URL":
        ev.url = l.value.trim().slice(0, 2000);
        break;
      case "DTSTART": {
        const t = parseTimeValue(l.value, l.params);
        if (t) {
          ev.start = t;
          ev._start = true;
        }
        break;
      }
      case "DTEND": {
        const t = parseTimeValue(l.value, l.params);
        if (t) ev.end = t;
        break;
      }
      case "DURATION": {
        const d = parseDuration(l.value);
        if (d !== null && d >= 0) ev.duration = d;
        break;
      }
      case "RRULE":
        if (parseRRule(l.value)) ev.rrule = l.value.trim();
        break;
      case "EXDATE":
        for (const v of l.value.split(",")) {
          const t = parseTimeValue(v, l.params);
          if (t && ev.exdates.length < 2000) ev.exdates.push(t);
        }
        break;
      case "RECURRENCE-ID": {
        const t = parseTimeValue(l.value, l.params);
        if (t) ev.recurrenceId = t;
        break;
      }
      case "STATUS":
        ev.status = l.value.trim().toUpperCase();
        break;
      case "TRANSP":
        ev.transparent = l.value.trim().toUpperCase() === "TRANSPARENT";
        break;
      case "SEQUENCE":
        ev.sequence = Math.max(0, Math.min(1_000_000, Number(l.value) || 0));
        break;
      case "ORGANIZER": {
        const p = person(l);
        if (p) ev.organizer = p;
        break;
      }
      case "ATTENDEE": {
        const p = person(l);
        if (p && ev.attendees.length < 200) ev.attendees.push(p);
        break;
      }
      case "CONFERENCE":
      case "X-GOOGLE-CONFERENCE":
      case "X-MICROSOFT-SKYPETEAMSMEETINGURL":
        if (!ev.conference) ev.conference = l.value.trim().slice(0, 2000);
        break;
      case "COLOR":
        ev.color = l.value.trim().slice(0, 40);
        break;
    }
  }
  return cal;
}

// Windows zone names (Outlook, Exchange) → IANA, for the zones people meet in most.
const WINDOWS_ZONES: Record<string, string> = {
  "Dateline Standard Time": "Etc/GMT+12",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Eastern Standard Time": "America/New_York",
  "SA Pacific Standard Time": "America/Bogota",
  "Atlantic Standard Time": "America/Halifax",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires",
  "UTC": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Egypt Standard Time": "Africa/Cairo",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Israel Standard Time": "Asia/Jerusalem",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arab Standard Time": "Asia/Riyadh",
  "Arabian Standard Time": "Asia/Dubai",
  "Iran Standard Time": "Asia/Tehran",
  "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Kolkata",
  "Nepal Standard Time": "Asia/Kathmandu",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "SE Asia Standard Time": "Asia/Bangkok",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
};

/** An IANA zone for a TZID as other apps write it, or null. */
export function ianaOf(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const t = tzid.trim();
  if (validTimeZone(t as unknown)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  // "/mozilla.org/20050126_1/America/New_York", "/citadel.org/…/Europe/Paris"
  const parts = t.split("/").filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    const tail = parts.slice(-n).join("/");
    if (validTimeZone(tail)) return tail;
  }
  return null;
}

export interface Placed {
  allDay: boolean;
  day: string;
  /** Timed: the instant; all-day: UTC midnight of `day`. */
  ms: number;
  /** The zone the time was written in (all-day and floating: `fallback`). */
  tz: string;
}

/** An ICS time on the timeline (floating and unknown zones read in `fallback`). */
export function placeTime(t: IcsTime, fallback: string): Placed {
  const p = parseDay(t.day);
  if (t.minute === undefined) return { allDay: true, day: t.day, ms: Date.UTC(p.y, p.m - 1, p.d), tz: fallback };
  const w = { ...p, h: Math.floor(t.minute / 60), mi: t.minute % 60, s: t.second ?? 0 };
  if (t.utc) return { allDay: false, day: t.day, ms: Date.UTC(p.y, p.m - 1, p.d, w.h, w.mi, w.s), tz: "UTC" };
  const tz = ianaOf(t.tzid) ?? fallback;
  return { allDay: false, day: t.day, ms: fromWall(w, tz), tz };
}

/** The occurrence key an EXDATE or RECURRENCE-ID names, for a series in `tz`. */
export function occKeyOf(t: IcsTime, allDay: boolean, tz: string): string {
  if (allDay || t.minute === undefined) return t.day.replace(/-/g, "");
  const p = placeTime(t, tz);
  const d = new Date(p.ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// ------------------------------------------------------------ writing

export interface IcsOutEvent {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  url?: string;
  allDay: boolean;
  /** Timed events. */
  start: number;
  end: number;
  /** All-day events: first day and the day after the last (exclusive). */
  startDay: string;
  endDay: string;
  tz: string;
  rrule?: string | null;
  exdates?: readonly string[];
  /** An override of one occurrence of the series with the same UID. */
  recurrenceId?: string | null;
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  busy?: boolean;
  sequence?: number;
  created?: number;
  updated?: number;
  organizer?: IcsPerson;
  attendees?: readonly IcsPerson[];
  alarms?: readonly number[];
  conference?: string;
}

const encoder = new TextEncoder();

/** Folds one content line at 75 octets (never inside a UTF-8 character). */
export function fold(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    const max = out.length ? 74 : 75;
    if (bytes + n > max) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function escapeText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const basicDay = (day: string) => day.replace(/-/g, "");
const utcBasic = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const localBasic = (ms: number, tz: string) => {
  const w = wallOf(ms, tz);
  return `${pad(w.y, 4)}${pad(w.m)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}`;
};
const offsetText = (min: number) => `${min < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;

/** The moments a zone changes its offset in a year (at most a few). */
function transitions(tz: string, year: number): { at: number; from: number; to: number }[] {
  const out: { at: number; from: number; to: number }[] = [];
  let t = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  let o = offsetOf(t, tz);
  while (t < end && out.length < 6) {
    const next = t + 86_400_000;
    const o2 = offsetOf(next, tz);
    if (o2 !== o) {
      let lo = t;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
        if (offsetOf(mid, tz) === o) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: o, to: o2 });
      o = o2;
    }
    t = next;
  }
  return out;
}

/** VTIMEZONE lines for a zone, its rules as of `year` (yearly rules, as every client expects). */
export function vtimezone(tz: string, year: number): string[] {
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  const changes = transitions(tz, year);
  if (changes.length !== 2) {
    const o = offsetOf(Date.UTC(year, 6, 1), tz);
    lines.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${offsetText(o)}`, `TZOFFSETTO:${offsetText(o)}`, "END:STANDARD");
  } else {
    for (const c of changes) {
      // The wall time just before the change, in the old offset.
      const local = c.at + c.from * 60_000;
      const d = new Date(local);
      const m = d.getUTCMonth() + 1;
      const dom = d.getUTCDate();
      const wd = d.getUTCDay();
      const n = dom + 7 > daysInMonth(year, m) ? -1 : Math.ceil(dom / 7);
      // The same rule's day in 1970, where the description starts.
      let day1970 = 1;
      const all: number[] = [];
      for (let x = 1; x <= daysInMonth(1970, m); x++) if (weekday(ymd(1970, m, x)) === wd) all.push(x);
      day1970 = n > 0 ? all[n - 1] : all[all.length - 1];
      const kind = c.to > c.from ? "DAYLIGHT" : "STANDARD";
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:1970${pad(m)}${pad(day1970)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`,
        `RRULE:FREQ=YEARLY;BYMONTH=${m};BYDAY=${n}${["SU", "MO", "TU", "WE", "TH", "FR", "SA"][wd]}`,
        `TZOFFSETFROM:${offsetText(c.from)}`,
        `TZOFFSETTO:${offsetText(c.to)}`,
        `END:${kind}`
      );
    }
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

function personLine(name: "ORGANIZER" | "ATTENDEE", p: IcsPerson, extra = ""): string {
  const cn = p.name ? `;CN="${p.name.replace(/["\r\n\\]/g, "")}"` : "";
  return `${name}${cn}${extra}:mailto:${p.email}`;
}

function eventLines(e: IcsOutEvent, now: number): string[] {
  const zoned = !e.allDay && e.tz !== "UTC" && validTimeZone(e.tz);
  const when = (prop: string, ms: number) => (zoned ? `${prop};TZID=${e.tz}:${localBasic(ms, e.tz)}` : `${prop}:${utcBasic(ms)}`);
  const lines = ["BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${utcBasic(now)}`];
  if (e.recurrenceId && OCC_RE.test(e.recurrenceId)) lines.push(e.recurrenceId.length === 8 ? `RECURRENCE-ID;VALUE=DATE:${e.recurrenceId}` : `RECURRENCE-ID:${e.recurrenceId}`);
  if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${basicDay(e.startDay)}`, `DTEND;VALUE=DATE:${basicDay(e.endDay)}`);
  else lines.push(when("DTSTART", e.start), when("DTEND", e.end));
  if (e.rrule) {
    const r = parseRRule(e.rrule);
    if (r) lines.push(`RRULE:${formatRRule(r)}`);
  }
  for (const x of e.exdates ?? []) if (OCC_RE.test(x)) lines.push(x.length === 8 ? `EXDATE;VALUE=DATE:${x}` : `EXDATE:${x}`);
  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  if (e.conference) lines.push(`CONFERENCE;VALUE=URI:${e.conference}`);
  lines.push(`STATUS:${e.status ?? "CONFIRMED"}`, `TRANSP:${e.busy === false ? "TRANSPARENT" : "OPAQUE"}`, `SEQUENCE:${e.sequence ?? 0}`);
  if (e.created) lines.push(`CREATED:${utcBasic(e.created)}`);
  if (e.updated) lines.push(`LAST-MODIFIED:${utcBasic(e.updated)}`);
  if (e.organizer) lines.push(personLine("ORGANIZER", e.organizer));
  for (const a of e.attendees ?? []) lines.push(personLine("ATTENDEE", a, `;ROLE=REQ-PARTICIPANT;PARTSTAT=${a.partstat ?? "NEEDS-ACTION"};RSVP=TRUE`));
  for (const min of e.alarms ?? []) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(e.title)}`, `TRIGGER:-PT${Math.max(0, Math.round(min))}M`, "END:VALARM");
  lines.push("END:VEVENT");
  return lines;
}

/** A whole calendar file (CRLF lines). `method`: PUBLISH for feeds, REQUEST / CANCEL for invitations. */
export function buildIcs(opts: { name?: string; method?: "PUBLISH" | "REQUEST" | "CANCEL"; events: readonly IcsOutEvent[]; now?: number }): string {
  const now = opts.now ?? Date.now();
  const year = new Date(now).getUTCFullYear();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//zvena//Calendar//EN", "CALSCALE:GREGORIAN"];
  if (opts.method) lines.push(`METHOD:${opts.method}`);
  if (opts.name) lines.push(`X-WR-CALNAME:${escapeText(opts.name)}`, `NAME:${escapeText(opts.name)}`);
  const zones = [...new Set(opts.events.filter((e) => !e.allDay && e.tz !== "UTC" && validTimeZone(e.tz)).map((e) => e.tz))];
  for (const z of zones) lines.push(...vtimezone(z, year));
  for (const e of opts.events) lines.push(...eventLines(e, now));
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------ reading into events

/** An event read from a file, placed on the timeline (what the store keeps). */
export interface ImportedEvent {
  uid: string;
  title: string;
  description: string;
  location: string;
  conference: string;
  allDay: boolean;
  start: number;
  end: number;
  startDay: string;
  endDay: string;
  tz: string;
  rrule: string | null;
  exdates: string[];
  /** The occurrence this one replaces (RECURRENCE-ID), as a key. */
  recurrenceId: string | null;
  cancelled: boolean;
  busy: boolean;
  sequence: number;
  attendees: IcsPerson[];
  organizer?: IcsPerson;
  alarms: number[];
}

/** The events of a parsed file on the timeline; `fallback` is the zone of floating times. */
export function importEvents(cal: IcsCalendar, fallback: string): ImportedEvent[] {
  const floating = ianaOf(cal.tz) ?? fallback;
  const out: ImportedEvent[] = [];
  for (const e of cal.events) {
    const s = placeTime(e.start, floating);
    let endDay = s.day;
    let end = s.ms;
    if (s.allDay) {
      const ed = e.end && e.end.minute === undefined ? e.end.day : null;
      const days = ed ? Math.max(1, dayNumber(ed) - dayNumber(s.day)) : e.duration ? Math.max(1, Math.round(e.duration / 86_400_000)) : 1;
      endDay = addDays(s.day, Math.min(days, 366));
    } else {
      end = e.end ? placeTime(e.end, s.tz).ms : s.ms + (e.duration ?? 0);
      if (end < s.ms) end = s.ms;
      // An event longer than a few weeks is a broken file, not a meeting.
      end = Math.min(end, s.ms + 31 * 86_400_000);
    }
    const tz = s.allDay ? floating : s.tz === "UTC" && !e.start.utc ? floating : s.tz;
    const rrule = e.rrule && !e.recurrenceId ? e.rrule : null;
    out.push({
      uid: e.uid,
      title: e.summary,
      description: e.description,
      location: e.location,
      conference: e.conference || (/^https:\/\//i.test(e.url) ? e.url : ""),
      allDay: s.allDay,
      start: s.allDay ? atMinute(s.day, 0, "UTC") : s.ms,
      end: s.allDay ? atMinute(endDay, 0, "UTC") : end,
      startDay: s.day,
      endDay,
      tz,
      rrule,
      exdates: rrule ? e.exdates.map((x) => occKeyOf(x, s.allDay, tz)) : [],
      recurrenceId: e.recurrenceId ? occKeyOf(e.recurrenceId, s.allDay, tz) : null,
      cancelled: e.status === "CANCELLED",
      busy: !e.transparent,
      sequence: e.sequence,
      attendees: e.attendees,
      ...(e.organizer ? { organizer: e.organizer } : {}),
      alarms: e.alarms,
    });
  }
  return out;
}
