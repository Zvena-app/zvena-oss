// zvena Calendar's tables. Server-only. Created on first use (the store
// opens without them) as numbered steps recorded in `kv` ('cal:schema'), the
// way the ecosystem's are; add new steps at the end.
//
//   cal_calendars   a person's calendars in a workspace: their own, an ICS
//                   subscription (read-only) or a CalDAV calendar (two-way)
//   cal_shares      a calendar shared with a member (free/busy, view, edit)
//   cal_events      events; an override of one occurrence of a repeating
//                   event is a row of its own (parent_id + recurrence_id)
//   cal_attendees   guests by e-mail or member, with their answer
//   cal_prefs       each person's settings (zones, week start, work hours…)
//   cal_view        each person's look of a calendar (hidden, own color)
//   cal_layers      Docs databases and Projects shown as layers
//   cal_links       scheduling links (Share availability) and their bookings
//   cal_accounts    CalDAV accounts (the app password sealed, lib/calendar/seal.ts)
//   cal_reminders_sent  which reminder of which occurrence went to whom
//
// Deleting an account removes the person's calendars, events, answers and
// settings (cal_user_gone, next to the ecosystem's eco_user_gone); a hard
// delete of an event takes its search row, links and notifications along
// (cal_events_gone). Workspaces cascade.

import type { DatabaseSync } from "node:sqlite";
import { ecoDb } from "../eco/schema";

/** Search rows of events live in the ecosystem's index above this rowid (documents use small ones). */
export const EVENT_ROWID_BASE = 2 ** 50;

const V1 = `
CREATE TABLE IF NOT EXISTS cal_calendars (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL DEFAULT 'UTC',
  kind TEXT NOT NULL DEFAULT 'local' CHECK (kind IN ('local', 'ics', 'caldav')),
  is_default INTEGER NOT NULL DEFAULT 0,
  -- What the workspace's other members get: nothing, free/busy, the events, or editing.
  ws_access TEXT NOT NULL DEFAULT 'busy' CHECK (ws_access IN ('none', 'busy', 'view', 'edit')),
  source_url TEXT,
  account_id TEXT,
  remote_href TEXT,
  remote_tag TEXT,
  synced_at INTEGER,
  sync_error TEXT,
  -- The secret ICS feed: an HMAC to find it by, and the token sealed so its owner can see the address again.
  feed_hash TEXT UNIQUE,
  feed_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS cal_calendars_ws ON cal_calendars(ws_id, owner_id);
CREATE TABLE IF NOT EXISTS cal_shares (
  cal_id TEXT NOT NULL REFERENCES cal_calendars(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('busy', 'view', 'edit')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (cal_id, user_id)
);
CREATE INDEX IF NOT EXISTS cal_shares_user ON cal_shares(user_id);
CREATE TABLE IF NOT EXISTS cal_events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  cal_id TEXT NOT NULL REFERENCES cal_calendars(id) ON DELETE CASCADE,
  ws_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  parent_id TEXT,
  recurrence_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  place TEXT,
  conference TEXT NOT NULL DEFAULT '',
  color TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  start_day TEXT NOT NULL,
  end_day TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'UTC',
  rrule TEXT,
  exdates TEXT NOT NULL DEFAULT '[]',
  -- The end of the last occurrence (NULL: repeats forever).
  until_at INTEGER,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  busy INTEGER NOT NULL DEFAULT 1,
  reminders TEXT NOT NULL DEFAULT '[]',
  remind_lead INTEGER NOT NULL DEFAULT 0,
  docs TEXT NOT NULL DEFAULT '[]',
  organizer_id TEXT,
  booking_id TEXT,
  remote_href TEXT,
  remote_etag TEXT,
  -- Changed here and not yet sent to the CalDAV server.
  dirty INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS cal_events_range ON cal_events(cal_id, start_at);
CREATE INDEX IF NOT EXISTS cal_events_uid ON cal_events(cal_id, uid);
CREATE INDEX IF NOT EXISTS cal_events_parent ON cal_events(parent_id);
CREATE INDEX IF NOT EXISTS cal_events_remind ON cal_events(remind_lead, start_at) WHERE remind_lead > 0 AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS cal_attendees (
  event_id TEXT NOT NULL REFERENCES cal_events(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  user_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  rsvp TEXT NOT NULL DEFAULT 'needs-action' CHECK (rsvp IN ('needs-action', 'accepted', 'declined', 'tentative')),
  -- E-mail guests answer through a link: its HMAC.
  token_hash TEXT UNIQUE,
  invited_at INTEGER,
  responded_at INTEGER,
  PRIMARY KEY (event_id, email)
);
CREATE INDEX IF NOT EXISTS cal_attendees_user ON cal_attendees(user_id);
CREATE TABLE IF NOT EXISTS cal_prefs (
  user_id TEXT PRIMARY KEY,
  -- '' until the person saves settings once.
  json TEXT NOT NULL DEFAULT '',
  -- The interface language they last used (letters and Inbox lines to them).
  locale TEXT NOT NULL DEFAULT 'en',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cal_view (
  user_id TEXT NOT NULL,
  cal_id TEXT NOT NULL REFERENCES cal_calendars(id) ON DELETE CASCADE,
  hidden INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  PRIMARY KEY (user_id, cal_id)
);
CREATE TABLE IF NOT EXISTS cal_layers (
  user_id TEXT NOT NULL,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('docs', 'issues', 'cycles')),
  ref TEXT NOT NULL,
  prop TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ws_id, kind, ref)
);
CREATE TABLE IF NOT EXISTS cal_links (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration INTEGER NOT NULL,
  step INTEGER NOT NULL,
  buffer_before INTEGER NOT NULL DEFAULT 0,
  buffer_after INTEGER NOT NULL DEFAULT 0,
  notice_min INTEGER NOT NULL DEFAULT 240,
  window_days INTEGER NOT NULL DEFAULT 30,
  max_per_day INTEGER NOT NULL DEFAULT 0,
  weekly TEXT NOT NULL,
  tz TEXT NOT NULL,
  cal_id TEXT NOT NULL,
  check_cals TEXT NOT NULL DEFAULT '[]',
  location TEXT NOT NULL DEFAULT '',
  conference TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cal_links_user ON cal_links(ws_id, user_id);
CREATE TABLE IF NOT EXISTS cal_bookings (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES cal_links(id) ON DELETE CASCADE,
  event_id TEXT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  tz TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'canceled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cal_bookings_link ON cal_bookings(link_id, start_at);
CREATE INDEX IF NOT EXISTS cal_bookings_email ON cal_bookings(email, created_at);
CREATE TABLE IF NOT EXISTS cal_accounts (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  server_url TEXT NOT NULL,
  username TEXT NOT NULL,
  secret TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS cal_reminders_sent (
  event_id TEXT NOT NULL,
  occ TEXT NOT NULL,
  min INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (event_id, occ, min, user_id)
);
CREATE INDEX IF NOT EXISTS cal_reminders_sent_at ON cal_reminders_sent(at);
CREATE TRIGGER IF NOT EXISTS cal_events_gone AFTER DELETE ON cal_events BEGIN
  DELETE FROM eco_search WHERE rowid = ${EVENT_ROWID_BASE} + old.seq;
  DELETE FROM eco_links WHERE ws_id = old.ws_id AND (src = 'event:' || old.id OR dst = 'event:' || old.id);
  DELETE FROM eco_parts WHERE ws_id = old.ws_id AND src = 'event:' || old.id;
  DELETE FROM eco_inbox WHERE ws_id = old.ws_id AND ref = 'event:' || old.id;
  DELETE FROM cal_reminders_sent WHERE event_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS cal_user_gone AFTER DELETE ON users BEGIN
  DELETE FROM cal_events WHERE cal_id IN (SELECT id FROM cal_calendars WHERE owner_id = old.id);
  DELETE FROM cal_calendars WHERE owner_id = old.id;
  DELETE FROM cal_shares WHERE user_id = old.id;
  DELETE FROM cal_view WHERE user_id = old.id;
  DELETE FROM cal_layers WHERE user_id = old.id;
  DELETE FROM cal_prefs WHERE user_id = old.id;
  DELETE FROM cal_accounts WHERE user_id = old.id;
  DELETE FROM cal_links WHERE user_id = old.id;
  DELETE FROM cal_attendees WHERE user_id = old.id;
  DELETE FROM cal_reminders_sent WHERE user_id = old.id;
  UPDATE cal_events SET organizer_id = NULL WHERE organizer_id = old.id;
  UPDATE cal_events SET created_by = NULL WHERE created_by = old.id;
  UPDATE cal_events SET updated_by = NULL WHERE updated_by = old.id;
END;
`;

// All-day events were never blocking booking slots; they now block when busy, and are free unless
// set busy — the ones made before keep blocking nothing.
const V2 = `
UPDATE cal_events SET busy = 0 WHERE all_day = 1;
`;

const MIGRATIONS: readonly string[] = [V1, V2];

const KEY = Symbol.for("zvena.calendar.schema");
const g = globalThis as unknown as Record<symbol, DatabaseSync | undefined>;

function migrate(d: DatabaseSync): void {
  const row = d.prepare("SELECT v FROM kv WHERE k = 'cal:schema'").get() as { v: string } | undefined;
  let v = row ? Number(row.v) || 0 : 0;
  while (v < MIGRATIONS.length) {
    d.exec("BEGIN IMMEDIATE");
    try {
      d.exec(MIGRATIONS[v]);
      v++;
      d.prepare("INSERT INTO kv (k, v) VALUES ('cal:schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(v));
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}

/** The store with Calendar's tables (and the ecosystem's, which its triggers clean) up to date. */
export function calDb(): DatabaseSync {
  // The ecosystem's tables first: the triggers above delete from them.
  const d = ecoDb();
  if (g[KEY] !== d) {
    migrate(d);
    g[KEY] = d;
  }
  return d;
}
