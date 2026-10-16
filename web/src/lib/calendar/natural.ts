// zvena Calendar: "go to" in plain words — "next fri", "tomorrow", "dec 24",
// "in 2 weeks", "next month", "2026-03-01". Pure. Documents' date parser
// (lib/notes/dates.ts) reads the words; this adds what a calendar needs on
// top (weeks and months, "+3d"), and reads "today" on the calendar's own
// zone rather than the device's.

import { parseHumanDate, parseHumanDateTime } from "../notes/dates";
import { intlOf } from "@/i18n/locales";
import { addDays, addMonths, isDay, startOfMonth, wallOf } from "./tz";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A Date whose local fields read the wall clock of `tz` (what Documents' parser expects). */
function localNow(now: number, tz: string): Date {
  const w = wallOf(now, tz);
  return new Date(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
}

const pad = (n: number) => String(n).padStart(2, "0");

const EN_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const localCache = new Map<string, [string, string][]>();

/**
 * The language's own words for days, months, today and tomorrow, as the
 * English ones the parser reads ("viernes" → "fri", "24 déc." → "24 dec",
 * "mañana" → "tomorrow"). From Intl, so every language of the interface gets them.
 */
function localWords(locale: string): [string, string][] {
  const hit = localCache.get(locale);
  if (hit) return hit;
  const out: [string, string][] = [];
  try {
    const tag = intlOf(locale);
    const strip = (w: string) => w.toLocaleLowerCase(tag).replace(/[.,]/g, "").trim();
    for (const style of ["long", "short"] as const) {
      const wd = new Intl.DateTimeFormat(tag, { weekday: style, timeZone: "UTC" });
      // 2026-10-11 is a Sunday.
      for (let i = 0; i < 7; i++) out.push([strip(wd.format(new Date(Date.UTC(2026, 9, 11 + i)))), EN_WEEKDAYS[i]]);
      const mo = new Intl.DateTimeFormat(tag, { month: style, timeZone: "UTC" });
      for (let i = 0; i < 12; i++) out.push([strip(mo.format(new Date(Date.UTC(2026, i, 15)))), MONTHS[i]]);
    }
    const rtf = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
    out.push([strip(rtf.format(0, "day")), "today"], [strip(rtf.format(1, "day")), "tomorrow"], [strip(rtf.format(-1, "day")), "yesterday"]);
  } catch {
    // An engine without these: English words only.
  }
  // Longer words first ("septembre" before "sept"); never an empty or digit-only word.
  const clean = out.filter(([w]) => w.length > 1 && !/^\d+$/.test(w)).sort((a, b) => b[0].length - a[0].length);
  localCache.set(locale, clean);
  return clean;
}

function toEnglish(s: string, locale: string): string {
  if (locale === "en" || locale === "ru") return s;
  let out = s;
  for (const [w, en] of localWords(locale)) {
    const i = out.indexOf(w);
    if (i >= 0 && (i === 0 || /[\s\d]/.test(out[i - 1])) && (i + w.length === out.length || /[\s\d.,]/.test(out[i + w.length]))) out = `${out.slice(0, i)}${en}${out.slice(i + w.length)}`;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The day a typed phrase names, in the calendar's zone; null when it names none. */
export function parseJump(input: string, locale: string, now: number, tz: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, " ");
  const s = toEnglish(raw, locale);
  if (!s) return null;
  const w = wallOf(now, tz);
  const today = `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  if (isDay(s)) return s;
  let m = /^([+-])(\d{1,3})\s*(d|w|m|y)?$/.exec(s);
  if (m) {
    const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    const u = m[3] ?? "d";
    return u === "d" ? addDays(today, n) : u === "w" ? addDays(today, n * 7) : u === "m" ? addMonths(today, n) : addMonths(today, n * 12);
  }
  m = /^(next|last|previous|prev|this)\s+(week|month|year)$/.exec(s);
  if (m) {
    const n = m[1] === "this" ? 0 : m[1] === "next" ? 1 : -1;
    return m[2] === "week" ? addDays(today, n * 7) : m[2] === "month" ? startOfMonth(addMonths(today, n)) : addMonths(today, n * 12);
  }
  // A month on its own: its first day (this year, or next once it has passed).
  m = /^([a-z]{3,9})(?:\s+(\d{4}))?$/.exec(s);
  if (m) {
    const i = MONTHS.indexOf(m[1].slice(0, 3));
    if (i >= 0 && (m[1].length === 3 || "january february march april may june july august september october november december".split(" ")[i].startsWith(m[1]))) {
      const y = m[2] ? Number(m[2]) : i + 1 < w.m ? w.y + 1 : w.y;
      return `${y}-${pad(i + 1)}-01`;
    }
  }
  return parseHumanDate(s, locale, localNow(now, tz));
}

/** A day and maybe a time ("tomorrow 3pm", "fri at 10"): "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in the calendar's zone. */
export function parseWhen(input: string, locale: string, now: number, tz: string): string | null {
  return parseJump(input, locale, now, tz) ?? parseHumanDateTime(input, locale, localNow(now, tz));
}
