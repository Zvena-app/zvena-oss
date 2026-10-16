// zvena Calendar: repeating events (RFC 5545 RRULE). Pure.
//
// The subset every calendar app writes and reads: FREQ DAILY / WEEKLY /
// MONTHLY / YEARLY with INTERVAL, COUNT or UNTIL, BYDAY (with ordinals:
// 2TU, -1FR), BYMONTHDAY (negative from the end), BYMONTH, BYSETPOS and WKST.
// Occurrences are found on calendar days and placed on the wall clock of the
// event's zone, so a 9:00 meeting stays at 9:00 through daylight saving.
//
// An occurrence is named by its original start: "YYYYMMDDTHHMMSSZ" (UTC) for
// timed events, "YYYYMMDD" for all-day ones — the form RECURRENCE-ID and
// EXDATE take in ICS, so overrides and exceptions survive an export.

import { addDays, addMonths, atMinute, daysBetween, daysInMonth, fromWall, parseDay, startOfWeek, weekday, ymd } from "./tz";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export const FREQS: readonly Freq[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

/** A weekday of BYDAY: 0 Sunday … 6 Saturday; `n` the ordinal (2nd, -1 = last). */
export interface ByDay {
  n?: number;
  wd: number;
}

export interface RRule {
  freq: Freq;
  interval: number;
  count?: number;
  /** As written: "YYYYMMDD", "YYYYMMDDTHHMMSSZ" or a floating "YYYYMMDDTHHMMSS". */
  until?: string;
  byDay?: ByDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  bySetPos?: number[];
  wkst?: number;
}

export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

const UNTIL_RE = /^\d{8}(T\d{6}Z?)?$/;

function ints(v: string, min: number, max: number, nonZero = true): number[] | null {
  const out: number[] = [];
  for (const p of v.split(",")) {
    if (!/^[+-]?\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < min || n > max || (nonZero && n === 0)) return null;
    out.push(n);
  }
  return out.length ? out : null;
}

/** A rule from its text ("FREQ=WEEKLY;BYDAY=MO,WE", with or without "RRULE:"), or null. */
export function parseRRule(raw: unknown): RRule | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  const text = raw.trim().replace(/^RRULE:/i, "");
  const r: Partial<RRule> & { interval: number } = { interval: 1 };
  for (const part of text.split(";")) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 1) return null;
    const k = part.slice(0, i).toUpperCase();
    const v = part.slice(i + 1).toUpperCase();
    switch (k) {
      case "FREQ":
        if (!(FREQS as readonly string[]).includes(v)) return null;
        r.freq = v as Freq;
        break;
      case "INTERVAL": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 1000) return null;
        r.interval = n;
        break;
      }
      case "COUNT": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 10_000) return null;
        r.count = n;
        break;
      }
      case "UNTIL":
        if (!UNTIL_RE.test(v)) return null;
        r.until = v;
        break;
      case "BYDAY": {
        const days: ByDay[] = [];
        for (const d of v.split(",")) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
          if (!m) return null;
          const n = m[1] ? Number(m[1]) : undefined;
          if (n !== undefined && (n === 0 || n < -53 || n > 53)) return null;
          days.push({ ...(n !== undefined ? { n } : {}), wd: WEEKDAY_CODES.indexOf(m[2] as (typeof WEEKDAY_CODES)[number]) });
        }
        r.byDay = days;
        break;
      }
      case "BYMONTHDAY": {
        const v2 = ints(v, -31, 31);
        if (!v2) return null;
        r.byMonthDay = v2;
        break;
      }
      case "BYMONTH": {
        const v2 = ints(v, 1, 12);
        if (!v2) return null;
        r.byMonth = v2;
        break;
      }
      case "BYSETPOS": {
        const v2 = ints(v, -366, 366);
        if (!v2) return null;
        r.bySetPos = v2;
        break;
      }
      case "WKST": {
        const i2 = WEEKDAY_CODES.indexOf(v as (typeof WEEKDAY_CODES)[number]);
        if (i2 < 0) return null;
        r.wkst = i2;
        break;
      }
      default:
        // BYHOUR, BYMINUTE, BYWEEKNO, BYYEARDAY…: not something people set in a calendar app.
        return null;
    }
  }
  if (!r.freq || (r.count && r.until)) return null;
  return r as RRule;
}

export function formatRRule(r: RRule): string {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${r.until}`);
  if (r.byDay?.length) parts.push(`BYDAY=${r.byDay.map((d) => `${d.n ?? ""}${WEEKDAY_CODES[d.wd]}`).join(",")}`);
  if (r.byMonthDay?.length) parts.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
  if (r.byMonth?.length) parts.push(`BYMONTH=${r.byMonth.join(",")}`);
  if (r.bySetPos?.length) parts.push(`BYSETPOS=${r.bySetPos.join(",")}`);
  if (r.wkst !== undefined && r.wkst !== 1) parts.push(`WKST=${WEEKDAY_CODES[r.wkst]}`);
  return parts.join(";");
}

/** A rule as stored: normalized text, or null for a rule that is not one. */
export function cleanRRule(raw: unknown): string | null {
  const r = parseRRule(raw);
  return r ? formatRRule(r) : null;
}

// ------------------------------------------------------------ occurrence names

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "YYYYMMDDTHHMMSSZ" of an instant. */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** The name of an occurrence. */
export function occKey(allDay: boolean, day: string, start: number): string {
  return allDay ? day.replace(/-/g, "") : utcStamp(start);
}

export const OCC_RE = /^\d{8}(T\d{6}Z)?$/;

/** The instant (timed) or day (all-day) an occurrence key names. */
export function parseOccKey(key: string): { day: string; ms: number | null } | null {
  if (!OCC_RE.test(key)) return null;
  const day = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
  if (key.length === 8) return { day, ms: null };
  const ms = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)), Number(key.slice(9, 11)), Number(key.slice(11, 13)), Number(key.slice(13, 15)));
  return { day, ms };
}

// ------------------------------------------------------------ expansion

export interface Series {
  /** The first occurrence's day (in the event's zone). */
  startDay: string;
  /** Its time: minutes since midnight on the event's wall clock (0 for all-day). */
  startMinute: number;
  allDay: boolean;
  tz: string;
  rule: RRule;
  /** Occurrence keys that were removed (EXDATE). */
  exdates?: ReadonlySet<string>;
}

export interface Occurrence {
  key: string;
  day: string;
  /** Timed: the instant; all-day: UTC midnight of the day. */
  start: number;
}

/** The last moment the rule allows (inclusive): a day for all-day events, an instant otherwise. */
function untilBound(s: Series): { day: string | null; ms: number | null } {
  const u = s.rule.until;
  if (!u) return { day: null, ms: null };
  const day = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
  if (s.allDay) return { day, ms: null };
  if (u.length === 8) return { day: null, ms: atMinute(day, 1439, s.tz) + 59_999 };
  const p = parseDay(day);
  const w = { ...p, h: Number(u.slice(9, 11)), mi: Number(u.slice(11, 13)), s: Number(u.slice(13, 15)) };
  return { day: null, ms: u.endsWith("Z") ? Date.UTC(p.y, p.m - 1, p.d, w.h, w.mi, w.s) : fromWall(w, s.tz) };
}

function sortedUnique(days: string[]): string[] {
  return [...new Set(days)].sort();
}

function bySetPos(days: string[], pos: number[] | undefined): string[] {
  if (!pos?.length) return days;
  const out: string[] = [];
  for (const p of pos) {
    const d = p > 0 ? days[p - 1] : days[days.length + p];
    if (d) out.push(d);
  }
  return sortedUnique(out);
}

/** Days of a month matching the rule's BYMONTHDAY / BYDAY (ordinals within the month). */
function monthDays(y: number, m: number, r: RRule, anchorDay: number): string[] {
  const dim = daysInMonth(y, m);
  let out: string[] = [];
  if (r.byMonthDay?.length) {
    for (const md of r.byMonthDay) {
      const d = md > 0 ? md : dim + md + 1;
      if (d >= 1 && d <= dim) out.push(ymd(y, m, d));
    }
    if (r.byDay?.length) {
      const wds = new Set(r.byDay.map((b) => b.wd));
      out = out.filter((d) => wds.has(weekday(d)));
    }
  } else if (r.byDay?.length) {
    for (const b of r.byDay) {
      const all: string[] = [];
      for (let d = 1; d <= dim; d++) {
        const day = ymd(y, m, d);
        if (weekday(day) === b.wd) all.push(day);
      }
      if (b.n === undefined) out.push(...all);
      else {
        const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
        if (pick) out.push(pick);
      }
    }
  } else if (anchorDay <= dim) out.push(ymd(y, m, anchorDay));
  return sortedUnique(out);
}

/** Days of a year with BYDAY ordinals counted within the year (no BYMONTH). */
function yearWeekdays(y: number, r: RRule): string[] {
  const out: string[] = [];
  for (const b of r.byDay ?? []) {
    const all: string[] = [];
    for (let d = ymd(y, 1, 1); d.startsWith(`${String(y).padStart(4, "0")}-`); d = addDays(d, 1)) if (weekday(d) === b.wd) all.push(d);
    if (b.n === undefined) out.push(...all);
    else {
      const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
      if (pick) out.push(pick);
    }
  }
  return sortedUnique(out);
}

/** The candidate days of the k-th period of the rule (ascending). */
function periodDays(s: Series, k: number): string[] {
  const r = s.rule;
  const start = parseDay(s.startDay);
  const inMonths = (d: string) => !r.byMonth?.length || r.byMonth.includes(parseDay(d).m);
  switch (r.freq) {
    case "DAILY": {
      const d = addDays(s.startDay, k * r.interval);
      const p = parseDay(d);
      if (!inMonths(d)) return [];
      if (r.byMonthDay?.length && !r.byMonthDay.some((md) => (md > 0 ? md : daysInMonth(p.y, p.m) + md + 1) === p.d)) return [];
      if (r.byDay?.length && !r.byDay.some((b) => b.wd === weekday(d))) return [];
      return [d];
    }
    case "WEEKLY": {
      const wkst = r.wkst ?? 1;
      const base = addDays(startOfWeek(s.startDay, wkst), 7 * k * r.interval);
      const wds = r.byDay?.length ? r.byDay.map((b) => b.wd) : [weekday(s.startDay)];
      const days = sortedUnique(wds.map((wd) => addDays(base, (wd - wkst + 7) % 7))).filter(inMonths);
      return bySetPos(days, r.bySetPos);
    }
    case "MONTHLY": {
      const first = addMonths(ymd(start.y, start.m, 1), k * r.interval);
      const p = parseDay(first);
      if (r.byMonth?.length && !r.byMonth.includes(p.m)) return [];
      return bySetPos(monthDays(p.y, p.m, r, start.d), r.bySetPos);
    }
    case "YEARLY": {
      const y = start.y + k * r.interval;
      let days: string[];
      if (r.byMonth?.length) days = sortedUnique(r.byMonth.flatMap((m) => monthDays(y, m, r, start.d)));
      else if (r.byDay?.length && !r.byMonthDay?.length) days = yearWeekdays(y, r);
      else days = monthDays(y, start.m, r, start.d);
      return bySetPos(days, r.bySetPos);
    }
  }
}

/** How many periods may be skipped before `fromDay` without changing anything (rules without COUNT). */
function skipPeriods(s: Series, fromDay: string): number {
  if (s.rule.count) return 0;
  const gap = daysBetween(s.startDay, fromDay);
  if (gap <= 0) return 0;
  const r = s.rule;
  const per = r.freq === "DAILY" ? r.interval : r.freq === "WEEKLY" ? 7 * r.interval : r.freq === "MONTHLY" ? 28 * r.interval : 365 * r.interval;
  return Math.max(0, Math.floor(gap / per) - 2);
}

const MAX_PERIODS = 200_000;

/**
 * The occurrences whose start day falls in [fromDay, toDay] (in the event's
 * zone), at most `limit`. Exceptions are left out after COUNT is applied, as
 * RFC 5545 says. The first occurrence is always the series' own start.
 */
export function expand(s: Series, fromDay: string, toDay: string, limit = 2000): Occurrence[] {
  const out: Occurrence[] = [];
  const until = untilBound(s);
  const place = (day: string): Occurrence => {
    const start = s.allDay ? Date.UTC(parseDay(day).y, parseDay(day).m - 1, parseDay(day).d) : atMinute(day, s.startMinute, s.tz);
    return { key: occKey(s.allDay, day, start), day, start };
  };
  let n = 0;
  const take = (day: string): boolean => {
    const o = place(day);
    if (until.day !== null && day > until.day) return false;
    if (until.ms !== null && o.start > until.ms) return false;
    n++;
    if (day >= fromDay && day <= toDay && !s.exdates?.has(o.key)) out.push(o);
    return true;
  };
  if (!take(s.startDay)) return out;
  const k0 = skipPeriods(s, fromDay);
  let quietPeriods = 0;
  for (let k = k0; k < MAX_PERIODS; k++) {
    if (s.rule.count && n >= s.rule.count) break;
    if (out.length >= limit) break;
    const days = periodDays(s, k);
    if (!days.length) {
      // A rule that never matches (BYMONTHDAY=31 with BYMONTH=2) must not spin forever.
      if (++quietPeriods > 2000) break;
      continue;
    }
    quietPeriods = 0;
    let done = false;
    for (const d of days) {
      if (d <= s.startDay) continue;
      if (d > toDay && !s.rule.count) {
        done = true;
        break;
      }
      if (s.rule.count && n >= s.rule.count) {
        done = true;
        break;
      }
      if (!take(d)) {
        done = true;
        break;
      }
      if (d > toDay) {
        done = true;
        break;
      }
    }
    if (done) break;
  }
  return out;
}

/** All occurrences from the start through `key` (inclusive), counted: the index of an occurrence in its series (0-based), or -1. */
export function occurrenceIndex(s: Series, key: string): number {
  const at = parseOccKey(key);
  if (!at) return -1;
  const list = expand({ ...s, exdates: undefined }, s.startDay, at.day, 20_000);
  return list.findIndex((o) => o.key === key);
}

/** UNTIL that ends a series just before the occurrence `key` ("this and following" splits it there). */
export function untilBefore(allDay: boolean, key: string): string | null {
  const at = parseOccKey(key);
  if (!at) return null;
  if (allDay || at.ms === null) return addDays(at.day, -1).replace(/-/g, "");
  return utcStamp(at.ms - 1000);
}

/** Whether a series has any occurrence left at all (a split at its first one leaves none). */
export function hasOccurrences(s: Series): boolean {
  const until = untilBound(s);
  if (until.day !== null && until.day < s.startDay) return false;
  if (until.ms !== null && !s.allDay && atMinute(s.startDay, s.startMinute, s.tz) > until.ms) return false;
  return true;
}
