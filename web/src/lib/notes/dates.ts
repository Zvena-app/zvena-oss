// zvena Documents: dates typed in plain words ("@завтра", "@15 октября",
// "@пятница", "@in 3 days") for date mentions. Pure; local calendar dates.

import { intlOf } from "@/i18n/locales";

const pad = (n: number) => String(n).padStart(2, "0");

/** A local calendar date as "YYYY-MM-DD" (toISOString would give the UTC day). */
export function localYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Months later, keeping to the end of a shorter month (Jan 31 + 1 month = Feb 28). */
const addMonths = (d: Date, n: number) => {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
};

const MONTHS: [RegExp, number][] = [
  [/^(янв|jan)/, 0],
  [/^(фев|feb)/, 1],
  [/^(мар|mar)/, 2],
  [/^(апр|apr)/, 3],
  [/^(мая|май|may)/, 4],
  [/^(июн|jun)/, 5],
  [/^(июл|jul)/, 6],
  [/^(авг|aug)/, 7],
  [/^(сен|sep)/, 8],
  [/^(окт|oct)/, 9],
  [/^(ноя|nov)/, 10],
  [/^(дек|dec)/, 11],
];

// Monday = 1 … Sunday = 7 (ISO).
const WEEKDAYS: [RegExp, number][] = [
  [/^(понедельник|пн|monday|mon)$/, 1],
  [/^(вторник|вт|tuesday|tue|tues)$/, 2],
  [/^(среда|среду|ср|wednesday|wed)$/, 3],
  [/^(четверг|чт|thursday|thu|thur|thurs)$/, 4],
  [/^(пятница|пятницу|пт|friday|fri)$/, 5],
  [/^(суббота|субботу|сб|saturday|sat)$/, 6],
  [/^(воскресенье|вс|sunday|sun)$/, 7],
];

const monthOf = (w: string): number | null => MONTHS.find(([re]) => re.test(w))?.[1] ?? null;

function valid(y: number, m: number, d: number): Date | null {
  const out = new Date(y, m, d);
  return out.getFullYear() === y && out.getMonth() === m && out.getDate() === d ? out : null;
}

/** A day/month without a year: this year, or next year if it has passed by more than a month. */
function upcoming(m: number, d: number, today: Date): Date | null {
  const y = today.getFullYear();
  const cur = valid(y, m, d);
  if (!cur) return null;
  return cur.getTime() < addDays(today, -31).getTime() ? valid(y + 1, m, d) : cur;
}

/** "YYYY-MM-DD" for a typed date, or null. `locale` decides 10/11 vs 11/10. */
export function parseHumanDate(input: string, locale = "en", now = new Date()): string | null {
  const s = input.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
  if (!s) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rel: Record<string, number> = { сегодня: 0, today: 0, завтра: 1, tomorrow: 1, вчера: -1, yesterday: -1, послезавтра: 2, позавчера: -2 };
  if (s in rel) return localYmd(addDays(today, rel[s]));

  // "через 3 дня", "in 2 weeks", "3 days ago", "2 недели назад"
  let m = /^(?:через|in)\s+(\d{1,3})\s+(\S+)$/.exec(s) ?? /^(\d{1,3})\s+(\S+)\s+(?:назад|ago)$/.exec(s);
  if (m) {
    const n = Number(m[1]) * (/назад|ago/.test(s) ? -1 : 1);
    const u = m[2];
    if (/^(дн|ден|day)/.test(u)) return localYmd(addDays(today, n));
    if (/^(недел|week)/.test(u)) return localYmd(addDays(today, n * 7));
    if (/^(месяц|month)/.test(u)) return localYmd(addMonths(today, n));
    if (/^(год|лет|year)/.test(u)) return localYmd(addMonths(today, n * 12));
    return null;
  }

  // Weekdays: the next one ("next friday" / "в пятницу" too).
  const wd = s.replace(/^(next|this|в|во|следующ(ий|ую|ее|ая))\s+/, "");
  const w = WEEKDAYS.find(([re]) => re.test(wd));
  if (w) {
    const dow = today.getDay() || 7;
    // The coming one; on that very weekday, a week ahead.
    const diff = (w[1] - dow + 7) % 7 || 7;
    return localYmd(addDays(today, diff));
  }

  // ISO: 2026-10-15
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const d = valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d ? localYmd(d) : null;
  }

  // Numeric: 15.10, 15.10.2026, 15/10/26 (Russian day first; English month first with "/")
  m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/.exec(s);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    if (locale !== "ru" && s.includes("/")) [a, b] = [b, a];
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    const d = year === null ? upcoming(b - 1, a, today) : valid(year, b - 1, a);
    return d ? localYmd(d) : null;
  }

  // Words: "15 октября 2026", "15 oct", "october 15, 2026", "oct 15"
  m = /^(\d{1,2})\s+([a-zа-я]+)\.?(?:\s+(\d{4}))?(?:\s*г\.?)?$/.exec(s);
  let day: number | null = null;
  let mon: number | null = null;
  let year: number | null = null;
  if (m) {
    day = Number(m[1]);
    mon = monthOf(m[2]);
    year = m[3] ? Number(m[3]) : null;
  } else {
    m = /^([a-zа-я]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s);
    if (m) {
      mon = monthOf(m[1]);
      day = Number(m[2]);
      year = m[3] ? Number(m[3]) : null;
    }
  }
  if (day !== null && mon !== null) {
    const d = year === null ? upcoming(mon, day, today) : valid(year, mon, day);
    return d ? localYmd(d) : null;
  }
  return null;
}

/**
 * A typed date with an optional time at the end ("завтра в 7", "пятница
 * 19:30", "tomorrow at 7pm", "в 9 утра", "через 2 часа"): "YYYY-MM-DD" or
 * "YYYY-MM-DDTHH:mm" (local), or null. A bare number is never a time: it
 * needs "в"/"at", minutes ("7:30") or am/pm/утра/вечера/ночи ("3 дня" only
 * after "в", since "через 3 дня" is days). A time alone is today's, or
 * tomorrow's once it has passed.
 */
export function parseHumanDateTime(input: string, locale = "en", now = new Date()): string | null {
  const s = input.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
  if (!s) return null;
  const stamp = (d: Date) => `${localYmd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // "через 2 часа", "in 30 minutes"
  const rel = /^(?:через|in)\s+(\d{1,3})\s+(час|hour|мин|min)\S*$/.exec(s);
  if (rel) return stamp(new Date(now.getTime() + Number(rel[1]) * (/^(час|hour)/.test(rel[2]) ? 3_600_000 : 60_000)));
  const m = /(?:^|\s)(?:(в|во|at)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|утра|дня|вечера|ночи)?$/.exec(s);
  const marker = m?.[1];
  const suffix = m?.[4];
  if (!m || !(marker || m[3] || (suffix && suffix !== "дня"))) return parseHumanDate(s, locale, now);
  let h = Number(m[2]);
  const min = m[3] ? Number(m[3]) : 0;
  if (h > 23 || min > 59) return null;
  if (suffix && /^(pm|p\.m\.|вечера|дня)$/.test(suffix) && h < 12) h += 12;
  if (suffix && /^(am|a\.m\.|утра|ночи)$/.test(suffix) && h === 12) h = 0;
  const rest = s.slice(0, m.index).trim();
  const time = `${pad(h)}:${pad(min)}`;
  if (rest) {
    const day = parseHumanDate(rest, locale, now);
    return day ? `${day}T${time}` : null;
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min);
  return stamp(today.getTime() > now.getTime() ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, min));
}

/**
 * A time typed into the date picker's time field ("7", "7:30", "730",
 * "19.30", "7pm", "7:30 PM", "7 вечера"): "HH:mm", or null. Hours alone are
 * 24-hour unless am/pm (утра/дня/вечера/ночи) says otherwise.
 */
export function parseTimeInput(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  const m = /^(\d{1,2})(?:[:.\s]?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p|утра|дня|вечера|ночи)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (suffix) {
    if (h < 1 || h > 12) return null;
    if (/^(pm|p\.m\.|p|дня|вечера)$/.test(suffix) && h < 12) h += 12;
    if (/^(am|a\.m\.|a|утра|ночи)$/.test(suffix) && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** Whether the interface language writes times on a 12-hour clock (en, hi, bn, ar) or a 24-hour one. */
function twelveHour(locale: string): boolean {
  const hc = new Intl.DateTimeFormat(intlOf(locale), { hour: "numeric" }).resolvedOptions().hourCycle;
  return hc === "h11" || hc === "h12";
}

/** "HH:mm" as the interface shows it: "19:00" where the language uses a 24-hour clock, "7:00 PM" where it uses 12 (never the browser's own locale; Latin digits and AM/PM, so it reads back). */
export function formatTimeLabel(hhmm: string, locale: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  if (!twelveHour(locale)) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
