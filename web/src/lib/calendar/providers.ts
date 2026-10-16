// Server-only: where a calendar's events come from. One interface for every
// source, so the API, the ticker and the interface treat them alike:
//
//   ics        an iCal address, read-only (lib/calendar/subscriptions.ts)
//   caldav     a CalDAV account with an app-specific password, two-way
//              (lib/calendar/caldav.ts)
//   google     Google Calendar     } need OAuth client credentials, which this
//   microsoft  Outlook / Microsoft } server does not have yet: listed, unavailable
//
// Adding Google or Microsoft later:
//   1. an OAuth app (Google Cloud / Entra ID) with the calendar scope
//      (https://www.googleapis.com/auth/calendar.events, Calendars.ReadWrite),
//      its id and secret in GOOGLE_CALENDAR_CLIENT_ID / _SECRET (or
//      MS_CALENDAR_CLIENT_ID / _SECRET) — separate from sign-in's app;
//   2. a connect route doing the authorization-code flow with PKCE and
//      offline access (lib/enterprise/sso.ts shows the pattern), keeping the refresh
//      token sealed in cal_accounts.secret (seal(), aad "<provider>:<id>"),
//      provider = "google" | "microsoft";
//   3. `sync` here: events.list with a syncToken (Google) or a delta query
//      (Graph) into applyImported (lib/calendar/subscriptions.ts), and
//      dirty rows out through events.insert / patch / delete, If-Match on
//      the etag, as caldav.ts does;
//   4. calendars of kind "google" / "microsoft" (cal_calendars.kind's CHECK
//      gets a migration step in lib/calendar/db.ts).

import { calRow } from "./access";
import { syncCalendar } from "./caldav";
import { refreshSubscription } from "./subscriptions";

export type ProviderId = "ics" | "caldav" | "google" | "microsoft";

export interface CalendarProvider {
  id: ProviderId;
  /** Usable on this server now. */
  available(): boolean;
  /** Changes made in zvena go back to the source. */
  writable: boolean;
  /** Brings the source's events in (and sends local changes out, when writable). */
  sync(calId: string): Promise<{ ok: boolean; error?: string }>;
}

const unavailable = (id: ProviderId): CalendarProvider => ({
  id,
  available: () => false,
  writable: true,
  sync: async () => ({ ok: false, error: "not configured on this server" }),
});

export const PROVIDERS: readonly CalendarProvider[] = [
  { id: "ics", available: () => true, writable: false, sync: (calId) => refreshSubscription(calId) },
  { id: "caldav", available: () => true, writable: true, sync: (calId) => syncCalendar(calId) },
  unavailable("google"),
  unavailable("microsoft"),
];

export function providerOf(id: ProviderId): CalendarProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Syncs a calendar with its source now (local calendars have none). */
export async function syncNow(calId: string): Promise<{ ok: boolean; error?: string }> {
  const cal = calRow(calId);
  if (!cal || cal.kind === "local") return { ok: false, error: "no source" };
  return providerOf(cal.kind)?.sync(calId) ?? { ok: false, error: "no source" };
}
