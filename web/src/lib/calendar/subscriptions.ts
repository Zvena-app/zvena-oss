// Server-only: calendars from elsewhere by their iCal address, and .ics files.
//
// A subscription is fetched by the server only, through the SSRF guard of
// lib/web-read.ts (public http(s) addresses, safe DNS at connect time,
// redirects re-checked, size and time caps), and refreshed every half hour
// (on its own when the calendar is opened, and by the ticker). It is
// read-only: what the source says replaces what was there.
//
// An imported file adds its events to a calendar the person may write (an
// event already there with the same UID is updated, nothing is removed).

import { fetchFile, allowedUrl, type FetchedFile } from "../web-read";
import { newId, sql, tx } from "../store";
import { CalAccess, calRow, type CalRow } from "./access";
import { calendarInfo, createCalendar } from "./calendars";
import { calDb } from "./db";
import { CalError, putRow, type EvRow } from "./events";
import { importEvents, parseIcs, type ImportedEvent } from "./ics";
import { cleanRRule } from "./rrule";
import { afterWrite } from "./effects";
import type { CalendarInfo } from "./types";

/** A source is refreshed this often (and at most this often on demand). */
export const REFRESH_EVERY = 30 * 60_000;
const MIN_REFRESH = 60_000;
const MAX_BYTES = 10_000_000;

export type Fetcher = (url: string, opts: { accept: string; maxBytes: number; timeoutMs: number }) => Promise<FetchedFile | null>;
const guarded: Fetcher = (url, opts) => fetchFile(url, opts);

/** The http(s) address of a subscription ("webcal://" is what calendar apps hand out), or null. */
export function cleanSourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  const s = raw.trim().replace(/^webcals?:\/\//i, "https://");
  const u = allowedUrl(s);
  return u ? u.toString() : null;
}

/** The row an imported event becomes (overrides are tied to their series afterwards). */
function rowOf(cal: CalRow, ev: ImportedEvent, prev: EvRow | undefined, now: number, opts: { keepReminders: boolean }): Omit<EvRow, "seq"> {
  const id = prev?.id ?? newId(12);
  return {
    id,
    cal_id: cal.id,
    ws_id: cal.ws_id,
    uid: ev.uid,
    parent_id: null,
    recurrence_id: ev.recurrenceId,
    title: ev.title,
    description: ev.description,
    location: ev.location,
    place: prev?.place ?? null,
    conference: /^https:\/\//i.test(ev.conference) ? ev.conference : "",
    color: prev?.color ?? null,
    all_day: ev.allDay ? 1 : 0,
    start_at: ev.start,
    end_at: ev.end,
    start_day: ev.startDay,
    end_day: ev.allDay ? ev.endDay : ev.endDay,
    tz: ev.tz,
    rrule: ev.rrule ? cleanRRule(ev.rrule) : null,
    exdates: JSON.stringify([...new Set(ev.exdates)].slice(0, 2000)),
    until_at: null,
    status: ev.cancelled ? "cancelled" : "confirmed",
    busy: ev.busy ? 1 : 0,
    reminders: opts.keepReminders ? JSON.stringify(ev.alarms.slice(0, 5).map((min) => ({ min, how: "inbox" }))) : (prev?.reminders ?? "[]"),
    remind_lead: opts.keepReminders && ev.alarms.length ? Math.max(...ev.alarms) + 1 : (prev?.remind_lead ?? 0),
    docs: prev?.docs ?? "[]",
    organizer_id: prev?.organizer_id ?? null,
    booking_id: prev?.booking_id ?? null,
    remote_href: prev?.remote_href ?? null,
    remote_etag: prev?.remote_etag ?? null,
    sequence: ev.sequence,
    created_by: prev?.created_by ?? null,
    updated_by: null,
    created_at: prev?.created_at ?? now,
    updated_at: now,
    deleted_at: null,
  };
}

export interface ApplyResult {
  added: number;
  updated: number;
  removed: number;
  seriesIds: string[];
}

/**
 * Puts imported events into a calendar. `replace`: the calendar becomes
 * exactly the source (subscriptions); otherwise events are added or updated
 * by UID. `extra` stamps each row (CalDAV: its resource and etag).
 */
export function applyImported(cal: CalRow, events: readonly ImportedEvent[], opts: { replace: boolean; keepReminders: boolean; now?: number; extra?: (ev: ImportedEvent) => Partial<EvRow> }): ApplyResult {
  calDb();
  const now = opts.now ?? Date.now();
  const existing = sql("SELECT * FROM cal_events WHERE cal_id = ? AND deleted_at IS NULL").all(cal.id) as unknown as EvRow[];
  const byKey = new Map(existing.map((r) => [`${r.uid}|${r.recurrence_id ?? ""}`, r]));
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let removed = 0;
  const touched = new Set<string>();
  tx(() => {
    // Series first, so overrides find their master.
    const sorted = [...events].sort((a, b) => Number(Boolean(a.recurrenceId)) - Number(Boolean(b.recurrenceId)));
    const masters = new Map<string, string>();
    for (const r of existing) if (!r.recurrence_id) masters.set(r.uid, r.id);
    for (const ev of sorted) {
      if (!ev.uid) continue;
      const key = `${ev.uid}|${ev.recurrenceId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = byKey.get(key);
      const row = { ...rowOf(cal, ev, prev, now, opts), ...(opts.extra?.(ev) ?? {}) } as Omit<EvRow, "seq">;
      if (ev.recurrenceId) {
        const master = masters.get(ev.uid);
        // An override of a series the source does not have: shown as an event of its own.
        row.parent_id = master ?? null;
        if (!master) row.recurrence_id = null;
      } else masters.set(ev.uid, row.id);
      // Unchanged rows stay untouched (no needless reindex or poke).
      if (prev && sameRow(prev, row)) continue;
      putRow(row);
      touched.add(row.parent_id ?? row.id);
      if (prev) updated++;
      else added++;
    }
    if (opts.replace) {
      for (const r of existing) {
        if (seen.has(`${r.uid}|${r.recurrence_id ?? ""}`)) continue;
        sql("DELETE FROM cal_events WHERE id = ?").run(r.id);
        removed++;
      }
    }
  });
  return { added, updated, removed, seriesIds: [...touched] };
}

const FIELDS = ["title", "description", "location", "conference", "all_day", "start_at", "end_at", "start_day", "end_day", "tz", "rrule", "exdates", "status", "busy", "sequence", "parent_id", "recurrence_id", "remote_etag"] as const;
function sameRow(a: EvRow, b: Omit<EvRow, "seq">): boolean {
  return FIELDS.every((k) => (a[k] ?? null) === (b[k] ?? null));
}

/** Fetches a subscription now and replaces its events (null error = success). */
export async function refreshSubscription(calId: string, fetcher: Fetcher = guarded, now = Date.now()): Promise<{ ok: boolean; error?: string; result?: ApplyResult }> {
  const cal = calRow(calId);
  if (!cal || cal.kind !== "ics" || !cal.source_url) return { ok: false, error: "not a subscription" };
  // Claim the refresh first: overlapping ticks never fetch twice.
  const claimed = Number(sql("UPDATE cal_calendars SET synced_at = ? WHERE id = ? AND (synced_at IS NULL OR synced_at < ?)").run(now, calId, now - MIN_REFRESH).changes);
  if (!claimed) return { ok: true };
  let file: FetchedFile | null = null;
  try {
    file = await fetcher(cal.source_url, { accept: "text/calendar, text/plain;q=0.9, */*;q=0.5", maxBytes: MAX_BYTES, timeoutMs: 20_000 });
  } catch {
    file = null;
  }
  const fail = (error: string) => {
    sql("UPDATE cal_calendars SET sync_error = ? WHERE id = ?").run(error, calId);
    return { ok: false, error };
  };
  if (!file) return fail("unreachable");
  if (file.truncated) return fail("too large");
  const text = file.body.toString("utf8");
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4000))) return fail("not a calendar");
  const parsed = parseIcs(text);
  const result = applyImported(cal, importEvents(parsed, cal.tz), { replace: true, keepReminders: false, now });
  sql("UPDATE cal_calendars SET sync_error = NULL, name = CASE WHEN name = '' THEN ? ELSE name END, updated_at = ? WHERE id = ?").run(parsed.name.slice(0, 120), now, calId);
  if (result.seriesIds.length || result.removed) afterWrite({ ws: cal.ws_id, by: null, seriesIds: result.seriesIds.slice(0, 500), calIds: [cal.id], notifyGuests: false });
  return { ok: true, result };
}

/** A new subscription: made now, filled right after (its first fetch decides its name when none was given). */
export async function subscribe(acc: CalAccess, input: { url?: unknown; name?: unknown; color?: unknown }, fetcher: Fetcher = guarded): Promise<CalendarInfo> {
  const url = cleanSourceUrl(input.url);
  if (!url) throw new CalError(400, "bad url");
  const dup = sql("SELECT id FROM cal_calendars WHERE ws_id = ? AND owner_id = ? AND source_url = ? AND deleted_at IS NULL").get(acc.ws, acc.userId, url) as { id: string } | undefined;
  if (dup) throw new CalError(409, "already subscribed");
  const host = new URL(url).hostname.replace(/^www\./, "");
  const cal = createCalendar(acc, { name: typeof input.name === "string" && input.name.trim() ? input.name : host, color: input.color, wsAccess: "none" }, { kind: "ics", source_url: url });
  const res = await refreshSubscription(cal.id, fetcher);
  // A first fetch that fails still leaves the subscription (it shows the error and retries).
  void res;
  return calendarInfo(acc, calRow(cal.id) as CalRow);
}

/** Subscriptions whose source is due again (the ticker; at most a few per tick). */
export async function refreshDue(now = Date.now(), fetcher: Fetcher = guarded): Promise<number> {
  calDb();
  const due = sql("SELECT id FROM cal_calendars WHERE kind = 'ics' AND deleted_at IS NULL AND (synced_at IS NULL OR synced_at < ?) ORDER BY synced_at LIMIT 10").all(now - REFRESH_EVERY) as { id: string }[];
  let n = 0;
  for (const d of due) if ((await refreshSubscription(d.id, fetcher, now)).ok) n++;
  return n;
}

/** Subscriptions of a workspace a person is looking at, refreshed in the background when stale. */
export function refreshStale(cals: readonly CalRow[], now = Date.now()): void {
  for (const c of cals) if (c.kind === "ics" && (!c.synced_at || now - c.synced_at > REFRESH_EVERY)) void refreshSubscription(c.id, guarded, now).catch(() => undefined);
}

/** An .ics file into a calendar the person may write. */
export function importFile(acc: CalAccess, calId: unknown, text: string): ApplyResult {
  const cal = calRow(calId);
  if (!cal || !acc.canRead(cal)) throw new CalError(404, "calendar not found");
  if (!acc.canWrite(cal) || cal.kind !== "local") throw new CalError(403, "read only");
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4000))) throw new CalError(400, "not a calendar file");
  const events = importEvents(parseIcs(text), cal.tz).slice(0, 5000);
  const result = applyImported(cal, events, { replace: false, keepReminders: true });
  if (result.seriesIds.length) afterWrite({ ws: cal.ws_id, by: acc.userId, seriesIds: result.seriesIds, calIds: [cal.id], notifyGuests: false });
  return result;
}
