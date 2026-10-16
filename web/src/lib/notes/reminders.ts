// zvena Documents: date reminders (Notion's "Remind" on dates). A whole-day
// date reminds at 9:00 local time on the day or a set number of days
// before; a date with a time ("YYYY-MM-DDTHH:mm", local wall time) at the
// time or minutes/hours before it. Pure: the app checks the list while it
// is open (a toast, and a system notification when allowed).

import type { DbSchema, Note } from "./types";

export const REMINDERS = ["day", "1d", "2d", "1w", "at", "5m", "10m", "15m", "30m", "1h", "2h"] as const;
export type Reminder = (typeof REMINDERS)[number];

/** The choices for a whole day, and for a date with a time (Notion's lists). */
export const DAY_REMINDERS: readonly Reminder[] = ["day", "1d", "2d", "1w"];
export const TIME_REMINDERS: readonly Reminder[] = ["at", "5m", "10m", "15m", "30m", "1h", "2h", "1d", "2d"];

const DAYS_BEFORE: Partial<Record<Reminder, number>> = { day: 0, "1d": 1, "2d": 2, "1w": 7 };
const MINUTES_BEFORE: Partial<Record<Reminder, number>> = { at: 0, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "1h": 60, "2h": 120 };

export const isReminder = (v: unknown): v is Reminder => typeof v === "string" && (REMINDERS as readonly string[]).includes(v);

/** The instant of a wall-clock time in a time zone (`wall` holds its parts as if they were UTC). */
export function zonedTime(wall: number, tz: string): number {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return wall;
  }
  const offset = (t: number) => {
    const p = fmt.formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - t;
  };
  // Twice: the offset at the guess may differ from the one at the answer (a DST change in between).
  const first = wall - offset(wall);
  return wall - offset(first);
}

/** A date value's time ("07:00"), or null for a whole day. */
export function dateTimePart(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(date)?.[1] ?? null;
}

/**
 * When a reminder for a date ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm") fires.
 * Days before: 9:00 local ("on the day" never after the event's own time).
 * Minutes before: from the time; on a whole day, 9:00 that day.
 */
export function fireTime(date: string, remind: Reminder, tz?: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  // In the browser: its own clock; on the server: the time zone of whoever set the reminder.
  const wall = (yy: number, mm: number, dd: number, h: number, mi = 0) => (tz ? zonedTime(Date.UTC(yy, mm, dd, h, mi), tz) : new Date(yy, mm, dd, h, mi).getTime());
  const at = m[4] === undefined ? null : wall(y, mo, d, Number(m[4]), Number(m[5]));
  const before = MINUTES_BEFORE[remind];
  if (before !== undefined) return at === null ? wall(y, mo, d, 9) : at - before * 60_000;
  const nine = wall(y, mo, d - (DAYS_BEFORE[remind] ?? 0), 9);
  return remind === "day" && at !== null ? Math.min(nine, at) : nine;
}

/** The reminder to keep when a date gains or loses its time. */
export function reminderFor(remind: string | undefined, timed: boolean): Reminder | undefined {
  if (!isReminder(remind)) return undefined;
  if (timed) return remind === "day" ? "at" : remind === "1w" ? "2d" : remind;
  return MINUTES_BEFORE[remind] !== undefined ? "day" : remind;
}

export interface PendingReminder {
  /** Stable per note, place, date and setting (a fired reminder is not shown twice). */
  key: string;
  noteId: string;
  /** "YYYY-MM-DD", or "YYYY-MM-DDTHH:mm" for a mention with a time. */
  date: string;
  remind: Reminder;
  at: number;
  /** A mention's block in words without its dates ("Visit to the doctor"); rows use their title. */
  text?: string;
}

/** A block's text without its mentions, one line. */
function blockText(content: unknown[]): string {
  return (content as { type?: string; text?: string; content?: unknown }[])
    .map((c) => (c?.type === "text" ? (c.text ?? "") : c?.type === "link" && Array.isArray(c.content) ? blockText(c.content) : " "))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[\s·,—-]+|[\s·,—-]+$/g, "")
    .trim();
}

function mentionReminders(blocks: unknown, noteId: string, out: PendingReminder[], depth = 0, tz?: string): void {
  if (!Array.isArray(blocks) || depth > 40) return;
  for (const raw of blocks) {
    const b = raw as { content?: unknown; children?: unknown; props?: Record<string, unknown> };
    if (!b || typeof b !== "object") continue;
    if (Array.isArray(b.content)) {
      for (const c of b.content as { type?: string; props?: Record<string, unknown>; content?: unknown }[]) {
        if (c?.type === "mention" && typeof c.props?.date === "string" && c.props.date && isReminder(c.props.remind)) {
          const at = fireTime(c.props.date, c.props.remind, tz);
          if (at !== null) out.push({ key: `${noteId}:m:${c.props.date}:${c.props.remind}`, noteId, date: c.props.date, remind: c.props.remind, at, text: blockText(b.content).slice(0, 120) || undefined });
        }
      }
    }
    if (Array.isArray(b.children)) mentionReminders(b.children, noteId, out, depth + 1, tz);
  }
}

/** Every reminder in the workspace: date mentions in pages and date properties of rows. */
export function collectReminders(notes: Iterable<Note>, schemaOf: (dbId: string) => DbSchema | undefined, tz?: string): PendingReminder[] {
  const out: PendingReminder[] = [];
  const all = [...notes];
  const byId = new Map(all.map((n) => [n.id, n]));
  // Only the root of a trashed subtree carries trashedAt: its pages and rows stay quiet too.
  const gone = new Map<string, boolean>();
  const inTrash = (id: string): boolean => {
    const path: string[] = [];
    let res = false;
    for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      const known = gone.get(cur.id);
      if (known !== undefined) {
        res = known;
        break;
      }
      if (cur.trashedAt !== null) {
        res = true;
        break;
      }
      if (path.includes(cur.id)) break;
      path.push(cur.id);
    }
    for (const x of path) gone.set(x, res);
    return res;
  };
  for (const n of all) {
    if (n.trashedAt !== null || n.template || inTrash(n.id)) continue;
    mentionReminders(n.content, n.id, out, 0, tz);
    if (!n.props || !n.parentId) continue;
    const schema = schemaOf(n.parentId);
    for (const p of schema?.properties ?? []) {
      if (p.type !== "date") continue;
      const v = n.props[p.id] as { start?: unknown; remind?: unknown } | undefined;
      if (!v || typeof v.start !== "string" || !isReminder(v.remind)) continue;
      const at = fireTime(v.start, v.remind, tz);
      // The time is part of the key: moving it later the same day reminds again.
      if (at !== null) out.push({ key: `${n.id}:${p.id}:${v.start.slice(0, 16)}:${v.remind}`, noteId: n.id, date: v.start.slice(0, 16), remind: v.remind, at });
    }
  }
  // The same date and setting twice on a page is one reminder (keys are what "shown" remembers).
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(r.key) && Boolean(seen.add(r.key))).sort((a, b) => a.at - b.at);
}

/** Reminders to show now: due, not older than `late` (missed while closed), not shown yet. */
export function dueReminders(list: readonly PendingReminder[], now: number, shown: ReadonlySet<string>, late = 12 * 3_600_000): PendingReminder[] {
  return list.filter((r) => r.at <= now && now - r.at <= late && !shown.has(r.key));
}

/**
 * Dates a Markdown import brings as "@2026-10-16" or
 * "@2026-10-16T07:00", optionally followed by "🔔" and a reminder code
 * ("🔔", "🔔1h", "🔔1d"), become date mentions — chips with the reminder.
 */
const DATE_TOKEN = /@(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)(?: ?🔔(at|5m|10m|15m|30m|1h|2h|day|1d|2d|1w)?)?/gu;

/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" naming a real day and time. */
function realDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
  return m[4] === undefined || (Number(m[4]) < 24 && Number(m[5]) < 60);
}

type InlineNode = { type?: string; text?: string; styles?: Record<string, unknown>; content?: unknown; props?: Record<string, unknown> };

function linkInline(content: unknown): unknown {
  if (!Array.isArray(content)) {
    if (typeof content === "string" && content.includes("@")) return linkInline([{ type: "text", text: content, styles: {} }]);
    return content;
  }
  const out: unknown[] = [];
  for (const raw of content as InlineNode[]) {
    if (raw?.type !== "text" || typeof raw.text !== "string" || !raw.text.includes("@") || raw.styles?.code) {
      out.push(raw?.type === "link" ? { ...raw, content: raw.content } : raw);
      continue;
    }
    let last = 0;
    for (const m of raw.text.matchAll(DATE_TOKEN)) {
      const date = m[1];
      if (!realDate(date)) continue;
      const timed = date.length > 10;
      const code = m[0].includes("🔔") ? (m[2] ?? (timed ? "at" : "day")) : "";
      const remind = code ? (reminderFor(code, timed) ?? "") : "";
      if (m.index > last) out.push({ ...raw, text: raw.text.slice(last, m.index) });
      out.push({ type: "mention", props: { noteId: "", date, remind } });
      last = m.index + m[0].length;
    }
    if (last === 0) out.push(raw);
    else if (last < raw.text.length) out.push({ ...raw, text: raw.text.slice(last) });
  }
  return out;
}

export function linkDateTokens<T>(blocks: T[]): T[] {
  return blocks.map((raw) => {
    const b = raw as { content?: unknown; children?: unknown[]; type?: string };
    if (!b || typeof b !== "object") return raw;
    const next: Record<string, unknown> = { ...b };
    if (b.type !== "codeBlock" && b.content !== undefined && (Array.isArray(b.content) || typeof b.content === "string")) next.content = linkInline(b.content);
    if (Array.isArray(b.children) && b.children.length) next.children = linkDateTokens(b.children);
    return next as T;
  });
}
