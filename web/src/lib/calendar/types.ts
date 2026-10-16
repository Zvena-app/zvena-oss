// zvena Calendar: what the server and the browser exchange. Pure types and
// a few shared constants.

/** What a person may do with a calendar: its owner, editing, reading, or only free/busy. */
export type CalLevel = "owner" | "edit" | "view" | "busy";
/** What the workspace's other members get by default. */
export type WsAccess = "none" | "busy" | "view" | "edit";
export type CalKind = "local" | "ics" | "caldav";
export type Rsvp = "needs-action" | "accepted" | "declined" | "tentative";
export type Scope = "this" | "following" | "all";
export type ViewKind = "day" | "week" | "month" | "agenda";

export const RSVPS: readonly Rsvp[] = ["needs-action", "accepted", "declined", "tentative"];
export const WS_ACCESS: readonly WsAccess[] = ["none", "busy", "view", "edit"];

/** Notion Calendar's palette (light tints and dark text come from the stylesheet). */
export const CAL_COLORS = ["#2f80ed", "#eb5757", "#f2994a", "#f2c94c", "#27ae60", "#2d9cdb", "#9b51e0", "#e86aa6", "#6fcf97", "#56ccf2", "#bb6bd9", "#828282"] as const;
export const DEFAULT_COLOR = CAL_COLORS[0];
export const COLOR_RE = /^#[0-9a-f]{6}$/;

export interface Reminder {
  /** Minutes before the start (all-day events: before 9:00 on the day). */
  min: number;
  how: "inbox" | "email";
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  description: string;
  tz: string;
  kind: CalKind;
  isDefault: boolean;
  wsAccess: WsAccess;
  level: CalLevel;
  ownerId: string;
  ownerName: string;
  /** Hidden in this person's view (their own toggle). */
  hidden: boolean;
  /** Subscriptions are read-only; so is a calendar shared for viewing. */
  readOnly: boolean;
  /** The owner only: where a subscription comes from, how it last synced. */
  sourceUrl?: string;
  syncedAt?: number | null;
  syncError?: string | null;
  /** The owner only: who else has it. */
  shares?: { userId: string; name: string; level: Exclude<CalLevel, "owner"> }[];
  hasFeed?: boolean;
}

export interface Attendee {
  email: string;
  userId?: string;
  name: string;
  rsvp: Rsvp;
  organizer?: boolean;
}

/** One occurrence on the grid. */
export interface EventItem {
  id: string;
  /** The occurrence of a repeating event (its original start), or null. */
  occ: string | null;
  calId: string;
  title: string;
  allDay: boolean;
  start: number;
  end: number;
  /** All-day: first day and the day after the last. */
  startDay: string;
  endDay: string;
  tz: string;
  color: string | null;
  location: string;
  conference: string;
  recurring: boolean;
  busy: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  /** The viewer's answer, when they are a guest. */
  rsvp?: Rsvp;
  guests: number;
  canEdit: boolean;
  /** Shown because the viewer is a guest (not a reader of its calendar). */
  invited?: boolean;
}

export interface EventDoc {
  id: string;
  title: string;
  icon: string;
  url: string;
}

export interface EventDetail extends EventItem {
  /** The series it belongs to (the event itself unless it is an override). */
  seriesId: string;
  rrule: string | null;
  description: string;
  reminders: Reminder[];
  attendees: Attendee[];
  docs: EventDoc[];
  place: { name: string; lat: number; lng: number } | null;
  organizer: { id: string; name: string } | null;
  canRsvp: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A row of a Docs database, a Projects due date or cycle on the calendar. */
export interface LayerItem {
  kind: "doc" | "issue" | "cycle";
  /** Unique on the grid: "doc:<row>", "issue:<id>", "cycle:<id>". */
  key: string;
  layer: string;
  title: string;
  /** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (Docs dates are on the viewer's wall clock). */
  start: string;
  end?: string;
  url: string;
  color: string;
  /** Docs rows the viewer may edit (dragging changes the date). Projects is read-only here. */
  canEdit: boolean;
  dbId?: string;
  propId?: string;
  sub?: string;
}

export interface LayerInfo {
  kind: "docs" | "issues" | "cycles";
  ref: string;
  prop: string;
  name: string;
  color: string;
  hidden: boolean;
  icon?: string;
}

export interface Prefs {
  /** The primary zone (the grid's). */
  tz: string;
  /** More zones shown side by side. */
  zones: string[];
  /** -1: the language's custom; 0 Sunday, 1 Monday, 6 Saturday. */
  weekStart: number;
  /** null: the language's custom. */
  hour12: boolean | null;
  workStart: number;
  workEnd: number;
  workDays: number[];
  /** Days in the week view (1–7). */
  days: number;
  view: ViewKind;
  showWeekends: boolean;
  defaultDuration: number;
  defaultReminders: Reminder[];
  dimPast: boolean;
  showDeclined: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  tz: "UTC",
  zones: [],
  weekStart: -1,
  hour12: null,
  workStart: 9 * 60,
  workEnd: 17 * 60,
  workDays: [1, 2, 3, 4, 5],
  days: 7,
  view: "week",
  showWeekends: true,
  defaultDuration: 30,
  defaultReminders: [{ min: 10, how: "inbox" }],
  dimPast: true,
  showDeclined: true,
};

export interface LinkInfo {
  id: string;
  slug: string;
  url: string;
  title: string;
  description: string;
  duration: number;
  step: number;
  bufferBefore: number;
  bufferAfter: number;
  noticeMin: number;
  windowDays: number;
  maxPerDay: number;
  weekly: Record<number, [number, number][]>;
  tz: string;
  calId: string;
  checkCals: string[];
  location: string;
  conference: string;
  color: string;
  active: boolean;
  bookings: number;
}

export interface Member {
  id: string;
  name: string;
  email?: string;
}

export interface Bootstrap {
  me: Member;
  ws: { id: string; name: string; canEdit: boolean };
  prefs: Prefs;
  /** False until the person saved settings once (the browser then sends its zone). */
  prefsSaved: boolean;
  calendars: CalendarInfo[];
  layers: LayerInfo[];
  links: LinkInfo[];
  members: Member[];
  providers: { id: string; available: boolean; writable: boolean }[];
  mailOn: boolean;
}

/**
 * What the calendar page sends along (lib/calendar/api.ts initialCalendar): the
 * bootstrap, and the events of the view it expects the app to open first and
 * of the coming week (the app uses those when its own range is the same).
 */
export interface InitialCalendar {
  boot: Bootstrap;
  events?: { from: number; to: number; tz: string; items: EventItem[]; layers: LayerItem[] };
  upcoming?: { from: number; items: EventItem[] };
}

/** An answer of a write: the event as stored, and how to put things back (⌘Z). */
export interface WriteResult {
  event?: EventDetail;
  undo?: string;
}
