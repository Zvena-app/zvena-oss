// Server-only: who may do what with a calendar. Every read and write of
// Calendar goes through here (the API, cards, search, the live stream).
//
//   - Only members of the workspace (not Documents' page guests) have calendars there.
//   - A calendar's owner may do everything with it.
//   - Someone it is shared with gets that level (free/busy, view, edit); the
//     workspace's other members get the calendar's general access (none,
//     free/busy, view, edit) — the better of the two.
//   - A member whose workspace role cannot edit (commenter, viewer) never
//     edits someone else's calendar.
//   - Subscriptions (ICS) are read-only for everyone, their owner too.
//   - A guest of an event sees that event (and answers it) whatever the calendar.

import { sql } from "../store";
import { can, roleIn, type Role } from "../workspaces";
import { calDb } from "./db";
import type { CalKind, CalLevel, WsAccess } from "./types";

export interface CalRow {
  id: string;
  ws_id: string;
  owner_id: string;
  name: string;
  color: string;
  description: string;
  tz: string;
  kind: CalKind;
  is_default: number;
  ws_access: WsAccess;
  source_url: string | null;
  account_id: string | null;
  remote_href: string | null;
  remote_tag: string | null;
  synced_at: number | null;
  sync_error: string | null;
  feed_hash: string | null;
  feed_token: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const RANK: Record<CalLevel, number> = { busy: 1, view: 2, edit: 3, owner: 4 };
export const atLeast = (l: CalLevel | null | undefined, need: CalLevel): boolean => Boolean(l && RANK[l] >= RANK[need]);

export function calRow(id: unknown): CalRow | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) return null;
  calDb();
  return (sql("SELECT * FROM cal_calendars WHERE id = ? AND deleted_at IS NULL").get(id) as CalRow | undefined) ?? null;
}

/** One person's view of one workspace's calendars, for any number of checks. */
export class CalAccess {
  readonly role: Role | null;
  private shares = new Map<string, Exclude<CalLevel, "owner">>();

  constructor(
    readonly userId: string,
    readonly ws: string
  ) {
    calDb();
    this.role = roleIn(userId, ws);
    if (this.role) {
      for (const r of sql("SELECT s.cal_id, s.level FROM cal_shares s JOIN cal_calendars c ON c.id = s.cal_id WHERE s.user_id = ? AND c.ws_id = ?").all(userId, ws) as { cal_id: string; level: Exclude<CalLevel, "owner"> }[])
        this.shares.set(r.cal_id, r.level);
    }
  }

  get member(): boolean {
    return this.role !== null;
  }

  level(cal: Pick<CalRow, "id" | "ws_id" | "owner_id" | "ws_access" | "deleted_at">): CalLevel | null {
    if (!this.role || cal.ws_id !== this.ws || cal.deleted_at) return null;
    if (cal.owner_id === this.userId) return "owner";
    const shared = this.shares.get(cal.id) ?? null;
    const general = cal.ws_access === "none" ? null : cal.ws_access;
    let best: CalLevel | null = shared && general ? (RANK[shared] >= RANK[general] ? shared : general) : (shared ?? general);
    if (best === "edit" && !can.edit(this.role)) best = "view";
    return best;
  }

  canRead(cal: CalRow | null): boolean {
    return Boolean(cal) && atLeast(this.level(cal as CalRow), "view");
  }

  canWrite(cal: CalRow | null): boolean {
    return Boolean(cal) && cal!.kind !== "ics" && atLeast(this.level(cal as CalRow), "edit");
  }

  /** Whether the person is a guest of an event (or of its series). */
  invitedTo(eventId: string): boolean {
    if (!this.role) return false;
    return Boolean(sql("SELECT 1 FROM cal_attendees WHERE event_id = ? AND user_id = ?").get(eventId, this.userId));
  }
}

export interface EventRef {
  id: string;
  cal_id: string;
  parent_id: string | null;
  ws_id: string;
  deleted_at: number | null;
}

/** May this person open this event (read its calendar, or be its guest)? */
export function canSeeEvent(acc: CalAccess, ev: EventRef | null): boolean {
  if (!ev || ev.deleted_at || ev.ws_id !== acc.ws) return false;
  if (acc.canRead(calRow(ev.cal_id))) return true;
  return acc.invitedTo(ev.parent_id ?? ev.id);
}

export function eventRef(id: string): EventRef | null {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
  calDb();
  return (sql("SELECT id, cal_id, parent_id, ws_id, deleted_at FROM cal_events WHERE id = ?").get(id) as EventRef | undefined) ?? null;
}

// ------------------------------------------------------------ the live stream

const TTL = 10_000;
const cache = new Map<string, { at: number; acc: CalAccess }>();

/** A person's access, reused for a few seconds (the stream asks once per person per event). */
export function accessOf(userId: string, ws: string): CalAccess {
  const k = `${userId}|${ws}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.acc;
  const acc = new CalAccess(userId, ws);
  cache.set(k, { at: Date.now(), acc });
  if (cache.size > 10_000) cache.clear();
  return acc;
}

/** Forgets cached access (after a share changes, so the stream follows at once). */
export function forgetAccess(): void {
  cache.clear();
}

/**
 * A "calendar" poke names a calendar (ref) and the events that changed
 * (refs). It reaches whoever can see that calendar at all (free/busy
 * included: their overlays change too) or is a guest of one of the events.
 */
export function calendarPulseVisible(userId: string, e: { ws: string; ref?: string; refs?: string[] }): boolean {
  const acc = accessOf(userId, e.ws);
  if (!acc.member) return false;
  const cal = e.ref ? (sql("SELECT id, ws_id, owner_id, ws_access, deleted_at FROM cal_calendars WHERE id = ?").get(e.ref) as CalRow | undefined) : undefined;
  if (cal && acc.level({ ...cal, deleted_at: null }) !== null) return true;
  return (e.refs ?? []).some((id) => acc.invitedTo(id));
}

/** May this person know about this event key (links pokes, cards)? */
export function eventKeyVisible(userId: string, ws: string, eventId: string): boolean {
  const ev = eventRef(eventId);
  // An event that no longer exists tells nothing.
  if (!ev) return true;
  return canSeeEvent(accessOf(userId, ws), ev);
}
