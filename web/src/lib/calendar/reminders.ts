// Server-only: event reminders and Calendar's clock.
//
// A reminder fires `min` minutes before an occurrence starts (all-day
// events: before 9:00 on the day, on the owner's wall clock). It reaches
// the calendar's owner and every guest who is a member and has not declined
// — in their Inbox (lib/eco/inbox notify, the one Inbox) or by e-mail, as
// the reminder says. Each occurrence's reminder goes once per person
// (cal_reminders_sent); one missed by more than a few minutes (the server
// was down) is dropped, as Documents' reminders are.
//
// The ticker (startCalendarTicker, from instrumentation.ts) also refreshes
// subscriptions, syncs CalDAV calendars, indexes series a restart left out
// of search and purges old deletions. It stays
// off with ZVENA_MAINTENANCE=off, like the other clocks (tests, stands).

import { notify } from "../eco/inbox";
import { lettersLeave, sendMail } from "../mail";
import { sql } from "../store";
import { localeOf, prefsOf } from "./calendars";
import { syncDue } from "./caldav";
import { calDb } from "./db";
import { sweepUnindexed, whenLine } from "./effects";
import { attendeesOf, parseJson, purgeDeleted, seriesOf, type EvRow } from "./events";
import { expand } from "./rrule";
import { calText } from "./strings";
import { refreshDue } from "./subscriptions";
import { addDays, atMinute, dayOf } from "./tz";
import type { Reminder } from "./types";

/** A reminder this late is dropped, not sent. */
const LATE = 10 * 60_000;
const DAY = 86_400_000;

interface Due {
  row: EvRow;
  occ: string;
  start: number;
  end: number;
  min: number;
  how: Reminder["how"];
}

/** The reminders due in (now - LATE, now], not sent yet. Pure on the store (exported for tests). */
export function dueReminders(now = Date.now()): Due[] {
  calDb();
  const maxLead = 40_320 * 60_000 + DAY;
  const rows = sql(
    `SELECT e.* FROM cal_events e JOIN cal_calendars c ON c.id = e.cal_id AND c.deleted_at IS NULL
     WHERE e.remind_lead > 0 AND e.deleted_at IS NULL AND e.status != 'cancelled'
       AND e.start_at <= ? AND (e.until_at IS NULL OR e.until_at >= ?)
     LIMIT 5000`
  ).all(now + maxLead, now - LATE) as unknown as EvRow[];
  const out: Due[] = [];
  for (const r of rows) {
    const reminders = parseJson<Reminder[]>(r.reminders, []);
    if (!reminders.length) continue;
    const lead = Math.max(...reminders.map((x) => x.min)) * 60_000 + DAY;
    const owner = (sql("SELECT owner_id FROM cal_calendars WHERE id = ?").get(r.cal_id) as { owner_id: string } | undefined)?.owner_id;
    // All-day reminders are at 9:00 on the owner's wall clock.
    const ownerTz = r.all_day === 1 && owner ? prefsOf(owner).tz : r.tz;
    const occs: { key: string; day: string; start: number }[] = [];
    const s = r.parent_id ? null : seriesOf(r);
    if (s) {
      const overridden = new Set((sql("SELECT recurrence_id FROM cal_events WHERE parent_id = ? AND recurrence_id IS NOT NULL").all(r.id) as { recurrence_id: string }[]).map((x) => x.recurrence_id));
      for (const o of expand(s, addDays(dayOf(now - LATE, r.tz), -1), addDays(dayOf(now + lead, r.tz), 1), 500)) if (!overridden.has(o.key)) occs.push(o);
    } else occs.push({ key: r.parent_id ? (r.recurrence_id ?? "") : "", day: r.start_day, start: r.start_at });
    for (const o of occs) {
      const startMs = r.all_day === 1 ? atMinute(o.day, 0, ownerTz) : o.start;
      const anchor = r.all_day === 1 ? atMinute(o.day, 9 * 60, ownerTz) : startMs;
      for (const rem of reminders) {
        const at = anchor - rem.min * 60_000;
        if (at > now || at <= now - LATE) continue;
        out.push({ row: r, occ: o.key || "single", start: startMs, end: startMs + (r.end_at - r.start_at), min: rem.min, how: rem.how });
      }
    }
  }
  return out;
}

/** Who a reminder reaches: the calendar's owner and the member guests who have not declined. */
function recipients(r: EvRow): string[] {
  const owner = (sql("SELECT owner_id FROM cal_calendars WHERE id = ?").get(r.cal_id) as { owner_id: string } | undefined)?.owner_id;
  const out = new Set<string>(owner ? [owner] : []);
  for (const a of attendeesOf(r.parent_id ?? r.id)) if (a.user_id && a.rsvp !== "declined") out.add(a.user_id);
  return [...out];
}

/** Sends the reminders that are due; returns how many went out. */
export function sendDueReminders(now = Date.now()): number {
  let sent = 0;
  for (const d of dueReminders(now)) {
    for (const userId of recipients(d.row)) {
      const claimed = Number(sql("INSERT OR IGNORE INTO cal_reminders_sent (event_id, occ, min, user_id, at) VALUES (?, ?, ?, ?, ?)").run(d.row.id, `${d.occ}|${d.how}`, d.min, userId, now).changes);
      if (!claimed) continue;
      const locale = localeOf(userId);
      const tz = prefsOf(userId).tz;
      const when = whenLine({ ...d.row, start_at: d.start, end_at: d.end }, locale, tz);
      const title = d.row.title || calText(locale, "ev.untitled");
      const to = d.how === "email" ? (sql("SELECT email FROM users WHERE id = ?").get(userId) as { email: string | null } | undefined)?.email : null;
      // By e-mail when a letter can reach them; else (no mail service here, no address) in the Inbox, never lost.
      if (to && lettersLeave()) {
        void sendMail({ to, subject: calText(locale, "mail.reminderSubject", { title, when }), text: [calText(locale, "mail.when", { when }), ...(d.row.conference ? [calText(locale, "mail.join", { url: d.row.conference })] : []), "", calText(locale, "mail.footer")].join("\n") }).catch(() => undefined);
      } else notify(userId, { ws: d.row.ws_id, kind: "reminder", ref: `event:${d.row.parent_id ?? d.row.id}`, part: d.occ !== "single" ? d.occ : undefined, by: null, text: `${title} · ${when}` });
      sent++;
    }
  }
  sql("DELETE FROM cal_reminders_sent WHERE at < ?").run(now - 60 * DAY);
  return sent;
}

let ticking = false;

/** Once per process (instrumentation.ts). */
export function startCalendarTicker(): void {
  if (ticking || process.env.ZVENA_MAINTENANCE === "off") return;
  ticking = true;
  let n = 0;
  const tick = async () => {
    n++;
    try {
      sendDueReminders();
      if (n % 5 === 1) {
        await refreshDue();
        await syncDue();
      }
      if (n % 360 === 1) purgeDeleted();
      // Search rows a restart (or a crash mid-import) left out.
      if (n % 15 === 1) sweepUnindexed();
    } catch (e) {
      console.error(`[calendar] ticker failed (${e instanceof Error ? e.name : "error"})`);
    }
  };
  setTimeout(() => void tick(), 20_000).unref();
  setInterval(() => void tick(), 60_000).unref();
}
