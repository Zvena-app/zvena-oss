// Notion's date filters: a day given relative to today ("Today", "One week
// ago"…) or exactly, and "Is relative to today" ranges (past / this / next
// week, month, year). Pure; local calendar dates as "YYYY-MM-DD".

import { localYmd } from "./dates";

export const DATE_TOKENS = ["today", "tomorrow", "yesterday", "week_ago", "week_from_now", "month_ago", "month_from_now"] as const;
export type DateToken = (typeof DATE_TOKENS)[number];
export const WITHIN_TOKENS = ["past_week", "past_month", "past_year", "this_week", "this_month", "this_year", "next_week", "next_month", "next_year"] as const;
export type WithinToken = (typeof WITHIN_TOKENS)[number];

const at = (d: Date, days: number, months = 0) => {
  const last = new Date(d.getFullYear(), d.getMonth() + months + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + months, Math.min(d.getDate(), last) + days);
};

export const isDateToken = (v: string): v is DateToken => (DATE_TOKENS as readonly string[]).includes(v);
export const isWithinToken = (v: string): v is WithinToken => (WITHIN_TOKENS as readonly string[]).includes(v);

/** The day a filter value stands for: a token relative to `now`, else the date as written. */
export function filterDay(v: string, now = new Date()): string {
  switch (v) {
    case "today":
      return localYmd(now);
    case "tomorrow":
      return localYmd(at(now, 1));
    case "yesterday":
      return localYmd(at(now, -1));
    case "week_ago":
      return localYmd(at(now, -7));
    case "week_from_now":
      return localYmd(at(now, 7));
    case "month_ago":
      return localYmd(at(now, 0, -1));
    case "month_from_now":
      return localYmd(at(now, 0, 1));
    default:
      return v;
  }
}

/** First and last day (inclusive) of a relative range; weeks start on Monday. */
export function withinDays(t: WithinToken, now = new Date()): [string, string] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = at(today, -((today.getDay() + 6) % 7));
  switch (t) {
    case "past_week":
      return [localYmd(at(today, -7)), localYmd(today)];
    case "past_month":
      return [localYmd(at(today, 0, -1)), localYmd(today)];
    case "past_year":
      return [localYmd(at(today, 0, -12)), localYmd(today)];
    case "next_week":
      return [localYmd(today), localYmd(at(today, 7))];
    case "next_month":
      return [localYmd(today), localYmd(at(today, 0, 1))];
    case "next_year":
      return [localYmd(today), localYmd(at(today, 0, 12))];
    case "this_week":
      return [localYmd(monday), localYmd(at(monday, 6))];
    case "this_month":
      return [localYmd(new Date(today.getFullYear(), today.getMonth(), 1)), localYmd(new Date(today.getFullYear(), today.getMonth() + 1, 0))];
    case "this_year":
      return [`${today.getFullYear()}-01-01`, `${today.getFullYear()}-12-31`];
  }
}
