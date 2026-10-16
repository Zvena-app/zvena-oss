"use client";

// What every part of Calendar shares: the bootstrap (calendars, layers,
// links, members), settings, the clock, the language, and the actions that
// write (each one asks "this / following / all" for a repeating event,
// shows a toast with Undo, and refreshes what changed).

import { createContext, useContext } from "react";
import type { Bootstrap, CalendarInfo, EventDetail, EventItem, LayerItem, Prefs, Reminder, Scope } from "@/lib/calendar/types";
import type { CT } from "./i18n";

export interface Draft {
  calId: string;
  title: string;
  allDay: boolean;
  start: number;
  end: number;
  startDay: string;
  endDay: string;
  tz: string;
  rrule: string | null;
  location: string;
  place: { name: string; lat: number; lng: number } | null;
  conference: string;
  description: string;
  color: string | null;
  reminders: Reminder[];
  attendees: { email?: string; userId?: string; name: string }[];
  busy: boolean;
}

/** What an edit changes (the API's field names). */
export type Patch = Partial<{
  calId: string;
  title: string;
  allDay: boolean;
  start: number;
  end: number;
  startDay: string;
  endDay: string;
  tz: string;
  rrule: string | null;
  location: string;
  place: Draft["place"];
  conference: string;
  description: string;
  color: string | null;
  reminders: Reminder[];
  attendees: { email?: string; userId?: string }[];
  busy: boolean;
}>;

export type PanelTarget = { kind: "event"; id: string; occ: string | null } | { kind: "draft"; draft: Draft } | { kind: "layer"; item: LayerItem };

export interface CalActions {
  /** Saves a draft as a new event. */
  create: (d: Draft, opts?: { notify?: boolean }) => Promise<EventDetail | null>;
  /** Changes the open draft (the panel's fields, the grid's drag). */
  editDraft: (p: Partial<Draft>) => void;
  /** Changes an event; asks the scope for repeating events (or uses `scope`). Null when cancelled or failed. */
  update: (e: Pick<EventDetail, "id" | "occ" | "recurring" | "title">, patch: Patch, opts?: { scope?: Scope; notify?: boolean; toast?: string }) => Promise<EventDetail | null>;
  remove: (e: Pick<EventDetail, "id" | "occ" | "recurring" | "title">) => Promise<boolean>;
  duplicate: (e: Pick<EventItem, "id" | "occ">) => Promise<void>;
  rsvp: (e: Pick<EventItem, "id" | "occ">, answer: "accepted" | "declined" | "tentative") => Promise<EventDetail | null>;
  copyLink: (e: Pick<EventItem, "id" | "occ">) => void;
  open: (t: PanelTarget | null) => void;
  reload: () => void;
  /** Bootstrap again (calendars, layers or links changed). */
  reboot: () => Promise<void>;
  savePrefs: (p: Partial<Prefs>) => Promise<void>;
  setHidden: (cal: CalendarInfo, hidden: boolean) => Promise<void>;
  dialog: (d: DialogKind | null) => void;
}

export type DialogKind =
  | { kind: "settings" }
  | { kind: "calendar"; id: string | null }
  | { kind: "subscribe" }
  | { kind: "import"; calId?: string }
  | { kind: "caldav" }
  | { kind: "layer" }
  | { kind: "link"; id: string | null }
  | { kind: "shortcuts" }
  | { kind: "zones" }
  | { kind: "goto" }
  | { kind: "availability" };

export interface CalState {
  ws: string;
  boot: Bootstrap;
  prefs: Prefs;
  cals: ReadonlyMap<string, CalendarInfo>;
  t: CT;
  locale: string;
  tz: string;
  now: number;
  today: string;
  h12: boolean;
  weekStart: number;
  narrow: boolean;
  actions: CalActions;
}

export const CalContext = createContext<CalState | null>(null);

export function useCal(): CalState {
  const c = useContext(CalContext);
  if (!c) throw new Error("Calendar context missing");
  return c;
}
