"use client";

// zvena Calendar — the app at /calendar, inside zvena's one frame (Shell),
// built like Notion Calendar: day / week (1–7 days) / month / agenda views,
// drag to create, move and resize, the event panel on the right, ⌘K, the
// keyboard shortcuts, several time zones, teammates' free/busy, Docs and
// Projects layers, scheduling links. Live: the pulse ("calendar", and
// "notes" / "projects" for layers) brings other people's changes in.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Plus, Search, Settings } from "lucide-react";
import { Shell } from "@/components/zvena/ds/Shell";
import { isTyping, overlayOpen } from "@/components/zvena/ds/keys";
import { toast } from "@/components/zvena/ds/toast-store";
import { pulse } from "@/lib/pulse/client";
import { addDays, atMinute, dayOf, localZone, minuteOfDay, validTimeZone } from "@/lib/calendar/tz";
import type { Bootstrap, CalendarInfo, EventDetail, EventItem, InitialCalendar, LayerItem, Prefs, Scope, ViewKind } from "@/lib/calendar/types";
import type { SessionUser } from "@/lib/session";
import { AgendaView } from "./AgendaView";
import { calApi } from "./api";
import { CalContext, type CalActions, type CalState, type DialogKind, type Draft, type PanelTarget, type Patch } from "./context";
import { isoWeek, rangeTitle, uses12h, weekStartOf } from "./format";
import { useCt } from "./i18n";
import { eventItem, eventLink, itemKey, joinUrl, layerItem, narrowDays, nextEvent, step, visibleDays, type GridItem, type ViewState } from "./model";
import { MonthView } from "./MonthView";
import { OVERLAY_COLORS, Rail } from "./Rail";
import { TimeGrid, type BusyOverlay, type MoveTarget } from "./TimeGrid";
import { copyText } from "./ui";
import "@/components/projects/projects.css";
import "./calendar.css";
import { lazyComponent, lazyPart, preloadWhenIdle } from "@/lib/lazy-part";
import { loadEditor, preloadEditor } from "@/components/projects/Editor";

// What opens on demand — the event panel (with its text editor), the dialogs,
// ⌘K — loads as chunks of its own: at once when the address opens an event or
// a new one, else once the calendar is idle, so opening them does not wait.
const panelPart = lazyPart(() => import("./EventPanel"));
const dialogsPart = lazyPart(() => import("./dialogs"));
const menuPart = lazyPart(() => import("./CommandMenu"));
const EventPanel = lazyComponent(panelPart, (m) => m.EventPanel, <aside className="cal-panel" aria-busy="true" />);
const Dialogs = lazyComponent(dialogsPart, (m) => m.Dialogs);
const ScopeDialog = lazyComponent(dialogsPart, (m) => m.ScopeDialog);
const CommandMenu = lazyComponent(menuPart, (m) => m.CommandMenu);
if (typeof window !== "undefined" && /[?&](event|new)=/.test(location.search)) {
  void panelPart.load().catch(() => {});
  preloadEditor("now");
}

export interface CalendarInitial {
  date?: string;
  view?: ViewKind;
  event?: string;
  occ?: string;
  create?: boolean;
}

const VIEWS: ViewKind[] = ["day", "week", "month", "agenda"];

const NARROW = "(max-width: 720px)";

/** A phone-sized screen (the day view, a full-screen panel). */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(NARROW);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia(NARROW).matches,
    () => false
  );
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// The last bootstrap of this tab: Calendar opened again after another section
// (the rail routes on the client) draws from it at once and freshens it.
let lastBoot: { ws: string; user: string; boot: Bootstrap } | null = null;

export function CalendarApp({ user, initial, data, dataAt = 0 }: { user: SessionUser; initial: CalendarInitial; data?: InitialCalendar | null; dataAt?: number }) {
  const { t, locale } = useCt();
  const ws = user.ws.id;
  // The page brought the bootstrap and the first view's events (app/calendar/page.tsx).
  const fromPage = data && data.boot.ws.id === ws && data.boot.me.id === user.id ? data : null;
  const [boot, setBootState] = useState<Bootstrap | null>(() => (lastBoot && lastBoot.ws === ws && lastBoot.user === user.id ? lastBoot.boot : null));
  const setBoot = useCallback(
    (b: Bootstrap) => {
      lastBoot = { ws, user: user.id, boot: b };
      setBootState(b);
    },
    [ws, user.id]
  );
  const [bootError, setBootError] = useState(false);
  const loadBoot = useCallback(async () => {
    try {
      const b = await calApi<Bootstrap>(ws, "bootstrap", { query: { tz: localZone() } });
      // First visit: the calendar keeps the browser's own zone.
      if (!b.prefsSaved) {
        const z = localZone();
        const r = await calApi<{ prefs: Prefs }>(ws, "prefs", { method: "PUT", body: { tz: validTimeZone(z) ? z : "UTC" } }).catch(() => null);
        if (r) b.prefs = r.prefs;
      }
      setBoot(b);
      setBootError(false);
    } catch {
      setBootError(true);
    }
  }, [ws, setBoot]);
  // The page's copy shows before the first paint (no round trip); the bootstrap is
  // fetched again only when that copy is old (a prefetched page, kept up to 30 s)
  // or missing (a first visit, which sends the browser's zone).
  useLayoutEffect(() => {
    // Hydration renders what the server did (loading); the copy shows right after, before paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromPage) setBoot(fromPage.boot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (fromPage && Date.now() - dataAt < 5_000) return;
    const tm = setTimeout(() => void loadBoot(), 0);
    return () => clearTimeout(tm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadBoot]);

  if (!boot)
    return (
      <Shell user={user} section="calendar" palette={false} createHotkey={false} fill>
        <div className="cal-app cal-app-loading">{bootError ? <button type="button" className="cal-btn" onClick={() => void loadBoot()}>{t("app.retry")}</button> : <span className="cal-muted">{t("app.loading")}</span>}</div>
      </Shell>
    );
  return <Calendar user={user} boot={boot} setBoot={setBoot} reboot={loadBoot} initial={initial} first={fromPage} t={t} locale={locale} />;
}

function Calendar({ user, boot, setBoot, reboot, initial, first, t, locale }: { user: SessionUser; boot: Bootstrap; setBoot: (b: Bootstrap) => void; reboot: () => Promise<void>; initial: CalendarInitial; first: InitialCalendar | null; t: ReturnType<typeof useCt>["t"]; locale: string }) {
  const ws = user.ws.id;
  const narrow = useNarrow();
  const now = useNow();
  const prefs = boot.prefs;
  const tz = prefs.tz;
  const today = dayOf(now, tz);
  const weekStart = weekStartOf(prefs, locale);
  const h12 = uses12h(locale, prefs.hour12);
  const cals = useMemo(() => new Map(boot.calendars.map((c) => [c.id, c])), [boot.calendars]);
  const [vs, setVs] = useState<ViewState>(() => ({ view: initial.view && VIEWS.includes(initial.view) ? initial.view : prefs.view, anchor: initial.date ?? dayOf(Date.now(), tz) }));
  const days = useMemo(() => visibleDays(vs, prefs, weekStart, narrow), [vs, prefs, weekStart, narrow]);
  // On a phone the week view is three days from the anchor (model.narrowDays).
  const view: ViewKind = vs.view;

  // ------------------------------------------------------------ data
  const from = atMinute(addDays(days[0], -1), 0, tz);
  const to = atMinute(addDays(days[days.length - 1], 2), 0, tz);
  // The page's events when they are this view's range (a phone's narrower week is not).
  const [seeded] = useState(() => (first?.events && first.events.from === from && first.events.to === to && first.events.tz === tz ? first.events : null));
  const [items, setItems] = useState<EventItem[]>(() => seeded?.items ?? []);
  const [layers, setLayers] = useState<LayerItem[]>(() => seeded?.layers ?? []);
  // Moves shown at once, before the server answers (dropped with the next load).
  const [pending, setPending] = useState<Map<string, Partial<EventItem>>>(new Map());
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => setRev((r) => r + 1), []);
  // Ranges already read (this one, and the ones either side, read ahead once it
  // is in): "next" and "previous" draw at once. A copy counts while no change
  // came in since (rev) and for a minute; an older one shows until the fresh one lands.
  const ranges = useRef(new Map<string, { rev: number; at: number; items: EventItem[]; layers: LayerItem[] }>());
  const near = useMemo(
    () =>
      ([-1, 1] as const).map((dir) => {
        const d = visibleDays({ ...vs, anchor: step(vs, dir, prefs, narrow) }, prefs, weekStart, narrow);
        return { from: atMinute(addDays(d[0], -1), 0, tz), to: atMinute(addDays(d[d.length - 1], 2), 0, tz) };
      }),
    [vs, prefs, weekStart, narrow, tz]
  );
  const nearRef = useRef(near);
  useLayoutEffect(() => {
    nearRef.current = near;
  });
  const skipLoad = useRef(seeded !== null);
  const lastKey = useRef("");
  useEffect(() => {
    const cache = ranges.current;
    const keyOf = (f: number, t: number) => `${f}|${t}|${tz}`;
    const fresh = (k: string) => {
      const c = cache.get(k);
      return c && c.rev === rev && Date.now() - c.at < 60_000 ? c : null;
    };
    const ctl = new AbortController();
    const read = (f: number, t: number) => calApi<{ items: EventItem[]; layers: LayerItem[] }>(ws, "events", { query: { from: f, to: t, tz }, signal: ctl.signal }).then((r) => {
      cache.set(keyOf(f, t), { rev, at: Date.now(), items: r.items, layers: r.layers });
      if (cache.size > 12) cache.delete(cache.keys().next().value as string);
      return r;
    });
    const key = keyOf(from, to);
    // Read ahead when the range moved (a change coming in refreshes this range only).
    const moved = lastKey.current !== key;
    lastKey.current = key;
    const ahead = () => {
      if (moved) for (const n of nearRef.current) if (!fresh(keyOf(n.from, n.to))) void read(n.from, n.to).catch(() => undefined);
    };
    if (skipLoad.current && seeded) {
      skipLoad.current = false;
      cache.set(key, { rev, at: Date.now(), items: seeded.items, layers: seeded.layers });
      const tm = setTimeout(ahead, 1500);
      return () => {
        clearTimeout(tm);
        ctl.abort();
      };
    }
    skipLoad.current = false;
    const have = fresh(key) ?? cache.get(key);
    if (have) {
      setItems(have.items);
      setLayers(have.layers);
    }
    if (have && fresh(key)) {
      ahead();
      return () => ctl.abort();
    }
    void read(from, to)
      .then((r) => {
        setItems(r.items);
        setLayers(r.layers);
        setPending(new Map());
        ahead();
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [ws, from, to, tz, rev, seeded]);

  // The coming week, whatever the view shows (the rail's "next" card, ⌘J).
  const [upSeed] = useState(() => (first?.upcoming && first.upcoming.from > Date.now() - 3_660_000 && first.events?.tz === tz ? first.upcoming.items : null));
  const [upcoming, setUpcoming] = useState<EventItem[]>(() => upSeed ?? []);
  const skipUpcoming = useRef(upSeed !== null);
  useEffect(() => {
    if (skipUpcoming.current) {
      skipUpcoming.current = false;
      return;
    }
    const ctl = new AbortController();
    const start = Date.now() - 3_600_000;
    void calApi<{ items: EventItem[] }>(ws, "events", { query: { from: start, to: start + 8 * 86_400_000, tz, layers: "0" }, signal: ctl.signal })
      .then((r) => setUpcoming(r.items))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [ws, tz, rev]);

  // Live: other people's changes (and this person's other tabs). The page's copy was
  // read before this tab listened: one fetch confirms it, when the stream says hello
  // (it opens now) or at once when the stream is already open (another section opened it).
  const confirmPage = useRef(seeded !== null || upSeed !== null);
  useEffect(() => preloadWhenIdle([panelPart, { load: loadEditor }, dialogsPart, menuPart]), []);
  useEffect(() => {
    const leave = pulse().join(ws);
    let tm: ReturnType<typeof setTimeout> | null = null;
    const soon = (ms: number) => {
      if (tm) clearTimeout(tm);
      tm = setTimeout(reload, ms);
    };
    const offs = [
      pulse().on("calendar", (m) => {
        soon(150);
        if (m.ref && !cals.has(m.ref)) void reboot();
      }),
      pulse().on("notes", () => boot.layers.some((l) => l.kind === "docs" && !l.hidden) && soon(800)),
      pulse().on("projects", () => boot.layers.some((l) => l.kind !== "docs" && !l.hidden) && soon(800)),
      pulse().on("hello", () => {
        confirmPage.current = false;
        soon(50);
      }),
    ];
    if (confirmPage.current && pulse().live()) {
      confirmPage.current = false;
      soon(50);
    }
    return () => {
      if (tm) clearTimeout(tm);
      offs.forEach((f) => f());
      leave();
    };
  }, [ws, reload, reboot, cals, boot.layers]);

  // Teammates' free/busy ("Meet with").
  const [meetWith, setMeetWith] = useState<string[]>([]);
  const [overlays, setOverlays] = useState<BusyOverlay[]>([]);
  const overlaysOn = meetWith.length > 0 && view !== "month" && view !== "agenda";
  useEffect(() => {
    if (!overlaysOn) return;
    const ctl = new AbortController();
    void calApi<{ users: { id: string; name: string; busy: BusyOverlay["busy"] }[] }>(ws, "freebusy", { query: { users: meetWith.join(","), from, to, tz }, signal: ctl.signal })
      .then((r) => setOverlays(r.users.map((u) => ({ userId: u.id, name: u.name, busy: u.busy, color: OVERLAY_COLORS[meetWith.indexOf(u.id) % OVERLAY_COLORS.length] }))))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [meetWith, ws, from, to, tz, overlaysOn, rev]);

  // ------------------------------------------------------------ panel, dialogs, undo
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  // zvena's Settings links here with ?settings: Calendar's own settings open (and the link is tidied).
  useEffect(() => {
    const u = new URL(location.href);
    if (!u.searchParams.has("settings")) return;
    u.searchParams.delete("settings");
    history.replaceState(history.state, "", u.toString());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDialog({ kind: "settings" });
  }, []);
  const [cmd, setCmd] = useState(false);
  const [scopeAsk, setScopeAsk] = useState<{ deleting: boolean; resolve: (s: Scope | null) => void } | null>(null);
  const undoStack = useRef<{ token: string; label: string }[]>([]);
  const askScope = (deleting: boolean) => new Promise<Scope | null>((resolve) => setScopeAsk({ deleting, resolve }));

  const doUndo = useCallback(
    async (token: string) => {
      undoStack.current = undoStack.current.filter((u) => u.token !== token);
      try {
        await calApi(ws, "undo", { body: { token } });
        toast(t("c.undone"));
        reload();
      } catch {
        toast(t("ev.failed"), { kind: "error" });
      }
    },
    [ws, t, reload]
  );
  const remember = useCallback(
    (token: string | undefined, label: string) => {
      if (!token) return;
      undoStack.current = [...undoStack.current.slice(-19), { token, label }];
      toast(label, { kind: "success", undo: () => doUndo(token) });
    },
    [doUndo]
  );
  const failed = useCallback(() => toast(t("ev.failed"), { kind: "error" }), [t]);

  const actions: CalActions = useMemo(() => {
    const a: CalActions = {
      create: async (d, opts) => {
        try {
          const r = await calApi<{ event: EventDetail; undo: string }>(ws, "events", { body: { ...d, notify: opts?.notify !== false } });
          remember(r.undo, t("ev.created"));
          reload();
          setPanel({ kind: "event", id: r.event.id, occ: null });
          setSelected(itemKey(r.event));
          return r.event;
        } catch {
          failed();
          return null;
        }
      },
      update: async (e, patch, opts) => {
        let scope = opts?.scope;
        if (e.recurring && !scope) {
          scope = (await askScope(false)) ?? undefined;
          if (!scope) return null;
        }
        try {
          const r = await calApi<{ event: EventDetail | null; undo: string }>(ws, `events/${e.id}`, { method: "PATCH", body: { ...patch, scope: scope ?? "this", occ: e.occ, notify: opts?.notify !== false } });
          remember(r.undo, opts?.toast ?? t("ev.saved"));
          reload();
          if (r.event && (r.event.id !== e.id || r.event.occ !== e.occ)) setPanel((p) => (p?.kind === "event" && p.id === e.id ? { kind: "event", id: r.event!.id, occ: r.event!.occ } : p));
          return r.event;
        } catch {
          failed();
          reload();
          return null;
        }
      },
      remove: async (e) => {
        let scope: Scope | null = "this";
        if (e.recurring) scope = await askScope(true);
        if (!scope) return false;
        try {
          const r = await calApi<{ undo: string }>(ws, `events/${e.id}`, { method: "DELETE", query: { scope, occ: e.occ } });
          remember(r.undo, t("ev.deleted"));
          setPanel((p) => (p?.kind === "event" && p.id === e.id ? null : p));
          setSelected(null);
          reload();
          return true;
        } catch {
          failed();
          return false;
        }
      },
      duplicate: async (e) => {
        try {
          const r = await calApi<{ event: EventDetail; undo: string }>(ws, `events/${e.id}/duplicate`, { body: { occ: e.occ } });
          remember(r.undo, t("ev.duplicated"));
          reload();
          if (r.event) {
            setPanel({ kind: "event", id: r.event.id, occ: null });
            setSelected(itemKey(r.event));
          }
        } catch {
          failed();
        }
      },
      editDraft: (p) => setPanel((cur) => (cur?.kind === "draft" ? { kind: "draft", draft: { ...cur.draft, ...p } } : cur)),
      rsvp: async (e, answer) => {
        try {
          const r = await calApi<{ event: EventDetail }>(ws, `events/${e.id}/rsvp`, { body: { rsvp: answer, occ: e.occ } });
          reload();
          return r.event;
        } catch {
          failed();
          return null;
        }
      },
      copyLink: (e) => {
        void copyText(eventLink(location.origin, ws, e)).then((ok) => ok && toast(t("ev.linkCopied"), { kind: "success" }));
      },
      open: (target) => {
        setPanel(target);
        if (!target) setSelected(null);
        else if (target.kind === "event") setSelected(`${target.id}|${target.occ ?? ""}`);
      },
      reload,
      reboot,
      savePrefs: async (p) => {
        setBoot({ ...boot, prefs: { ...boot.prefs, ...p } });
        try {
          const r = await calApi<{ prefs: Prefs }>(ws, "prefs", { method: "PUT", body: p });
          setBoot({ ...boot, prefs: r.prefs });
        } catch {
          failed();
        }
      },
      setHidden: async (cal: CalendarInfo, hidden: boolean) => {
        setBoot({ ...boot, calendars: boot.calendars.map((c) => (c.id === cal.id ? { ...c, hidden } : c)) });
        await calApi(ws, `calendars/${cal.id}`, { method: "PATCH", body: { hidden } }).catch(failed);
      },
      dialog: setDialog,
    };
    return a;
  }, [ws, t, reload, reboot, remember, failed, boot, setBoot]);

  // ------------------------------------------------------------ what the views draw
  const writableDefault = useMemo(() => boot.calendars.find((c) => c.isDefault && c.level === "owner") ?? boot.calendars.find((c) => !c.readOnly), [boot.calendars]);
  const draft = panel?.kind === "draft" ? panel.draft : null;
  const gridItems = useMemo<GridItem[]>(() => {
    const out: GridItem[] = [];
    for (const e of items) {
      const cal = cals.get(e.calId);
      if (cal ? cal.hidden : false) continue;
      if (!cal && !e.invited) continue;
      if (e.rsvp === "declined" && !prefs.showDeclined) continue;
      const over = pending.get(itemKey(e));
      out.push(eventItem(over ? { ...e, ...over } : e));
    }
    const shown = new Set(boot.layers.filter((l) => !l.hidden).map((l) => `${l.kind}:${l.ref}`));
    for (const l of layers) {
      if (!shown.has(l.layer)) continue;
      const it = layerItem(l, tz);
      if (it) out.push(it);
    }
    if (draft) {
      const fake: EventItem = { id: "draft", occ: null, calId: draft.calId, title: draft.title || t("ev.new"), allDay: draft.allDay, start: draft.start, end: draft.end, startDay: draft.startDay, endDay: draft.endDay, tz: draft.tz, color: draft.color, location: "", conference: "", recurring: false, busy: true, status: "confirmed", guests: 0, canEdit: false };
      out.push({ ...eventItem(fake), key: "draft|" });
    }
    return out;
  }, [items, layers, cals, prefs.showDeclined, pending, boot.layers, tz, draft, t]);

  const makeDraft = useCallback(
    (r: MoveTarget): Draft | null => {
      const cal = writableDefault;
      if (!cal) return null;
      const timed = "start" in r;
      return {
        calId: cal.id,
        title: "",
        allDay: !timed,
        start: timed ? r.start : atMinute(r.startDay, 0, "UTC"),
        end: timed ? r.end : atMinute(r.endDay, 0, "UTC"),
        startDay: timed ? dayOf(r.start, tz) : r.startDay,
        endDay: timed ? dayOf(r.end, tz) : r.endDay,
        tz,
        rrule: null,
        location: "",
        place: null,
        conference: "",
        description: "",
        color: null,
        reminders: timed ? prefs.defaultReminders : [],
        attendees: [],
        busy: timed,
      };
    },
    [writableDefault, tz, prefs.defaultReminders]
  );
  const onCreate = useCallback(
    (r: MoveTarget) => {
      const d = makeDraft(r);
      if (d) {
        setSelected("draft|");
        setPanel({ kind: "draft", draft: d });
      }
    },
    [makeDraft]
  );
  const createAt = useCallback(
    (day?: string) => {
      const d = day ?? (vs.anchor === today ? today : vs.anchor);
      const minute = d === today ? Math.ceil((minuteOfDay(now, tz) + 1) / 30) * 30 : Math.max(prefs.workStart, 9 * 60);
      const start = atMinute(d, Math.min(minute, 23 * 60 + 30), tz);
      if (day && day !== today && day !== vs.anchor) setVs((s) => ({ ...s, anchor: day }));
      onCreate({ start, end: start + prefs.defaultDuration * 60_000 });
    },
    [vs.anchor, today, now, tz, prefs.workStart, prefs.defaultDuration, onCreate]
  );

  const onSelect = useCallback((it: GridItem) => {
    setSelected(it.key);
    if (it.kind === "event") {
      if (it.event.id === "draft") return;
      setPanel({ kind: "event", id: it.event.id, occ: it.event.occ });
    } else setPanel({ kind: "layer", item: it.layer });
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  const wallText = (ms: number) => `${dayOf(ms, tz)}T${pad(Math.floor(minuteOfDay(ms, tz) / 60))}:${pad(minuteOfDay(ms, tz) % 60)}`;
  const onMove = useCallback(
    async (it: GridItem, to: MoveTarget) => {
      if (it.kind === "layer") {
        const l = it.layer;
        let start: string;
        let end: string | undefined;
        if ("start" in to) {
          start = wallText(to.start);
          end = l.end ? wallText(to.end) : undefined;
        } else {
          start = to.startDay;
          end = l.end ? addDays(to.endDay, -1) : undefined;
        }
        const write = (s: string, e: string | undefined) => calApi(ws, `docs/rows/${l.key.slice(4)}`, { method: "PATCH", body: { dbId: l.dbId, propId: l.propId, start: s, end: e } });
        try {
          await write(start, end);
          // Undo writes the row's old date back (through Documents again).
          toast(t("lay.rowMoved"), {
            kind: "success",
            undo: async () => {
              await write(l.start, l.end).catch(failed);
              reload();
            },
          });
        } catch {
          failed();
        }
        reload();
        return;
      }
      const e = it.event;
      if (e.id === "draft" && panel?.kind === "draft") {
        const d = panel.draft;
        setPanel({ kind: "draft", draft: "start" in to ? { ...d, start: to.start, end: to.end, startDay: dayOf(to.start, tz), endDay: dayOf(to.end, tz) } : { ...d, startDay: to.startDay, endDay: to.endDay } });
        return;
      }
      const patch: Patch = "start" in to ? { start: to.start, end: to.end } : { allDay: true, startDay: to.startDay, endDay: to.endDay };
      const key = itemKey(e);
      setPending((m) => new Map(m).set(key, "start" in to ? { start: to.start, end: to.end, startDay: dayOf(to.start, tz), endDay: dayOf(to.end, tz) } : { startDay: to.startDay, endDay: to.endDay }));
      const saved = await actions.update(e, patch, { toast: t("ev.moved") });
      if (!saved)
        setPending((m) => {
          const n = new Map(m);
          n.delete(key);
          return n;
        });
      else if (panel?.kind === "event" && panel.id === e.id) setPanel({ kind: "event", id: saved.id, occ: saved.occ });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, tz, t, actions, panel, reload, failed]
  );

  // ------------------------------------------------------------ navigation
  const goto = useCallback((day: string) => setVs((s) => ({ ...s, anchor: day })), []);
  const setView = useCallback(
    (v: ViewKind) => {
      setVs((s) => ({ ...s, view: v }));
      void actions.savePrefs({ view: v });
    },
    [actions]
  );
  const move = useCallback((dir: 1 | -1) => setVs((s) => ({ ...s, anchor: step(s, dir, prefs, narrow) })), [prefs, narrow]);
  const joinNext = useCallback(() => {
    const n = nextEvent(upcoming.filter((e) => joinUrl(e) && !cals.get(e.calId)?.hidden), now);
    const url = n ? joinUrl(n) : null;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [upcoming, cals, now]);

  // The address follows the view (a link opens the same place).
  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set("date", vs.anchor);
    u.searchParams.set("view", vs.view);
    if (panel?.kind === "event") u.searchParams.set("event", panel.id);
    else u.searchParams.delete("event");
    u.searchParams.delete("occ");
    u.searchParams.delete("new");
    history.replaceState(history.state, "", u.toString());
  }, [vs, panel]);

  // A link to an event (?event=…), or "New event" from the workspace's ⌘K (?new=1).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (initial.event) {
      void calApi<{ event: EventDetail }>(ws, `events/${initial.event}`, { query: { occ: initial.occ } })
        .then((r) => {
          goto(r.event.allDay ? r.event.startDay : dayOf(r.event.start, tz));
          setPanel({ kind: "event", id: r.event.id, occ: r.event.occ });
          setSelected(itemKey(r.event));
        })
        .catch(() => undefined);
    } else if (initial.create) setTimeout(() => createAt(), 0);
  }, [initial, ws, tz, goto, createAt]);

  useEffect(() => {
    const on = (e: Event) => goto((e as CustomEvent<string>).detail);
    window.addEventListener("zvena:cal-goto", on);
    return () => window.removeEventListener("zvena:cal-goto", on);
  }, [goto]);

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setCmd((v) => !v);
        return;
      }
      if (e.defaultPrevented || isTyping(e.target)) return;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        const last = undoStack.current[undoStack.current.length - 1];
        if (last) {
          e.preventDefault();
          void doUndo(last.token);
        }
        return;
      }
      if (overlayOpen(document)) return;
      const sel = selected ? gridItems.find((g) => g.key === selected) : null;
      const selEvent = sel?.kind === "event" && sel.event.id !== "draft" ? sel.event : null;
      if (mod && e.key.toLowerCase() === "d") {
        if (selEvent) {
          e.preventDefault();
          void actions.duplicate(selEvent);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        joinNext();
        return;
      }
      if (mod || e.altKey) return;
      const k = e.key;
      const handled = () => e.preventDefault();
      if (k === "Escape") {
        if (panel || selected) {
          setPanel(null);
          setSelected(null);
          handled();
        }
        return;
      }
      if ((k === "Delete" || k === "Backspace") && selEvent?.canEdit) return (handled(), void actions.remove(selEvent));
      if (k === "Enter" && sel) return (handled(), onSelect(sel));
      switch (k.toLowerCase()) {
        case "t":
          return (handled(), goto(today));
        case "d":
          return (handled(), setView("day"));
        case "w":
          return (handled(), setView("week"));
        case "m":
          return (handled(), setView("month"));
        case "a":
          return (handled(), setView("agenda"));
        case "j":
        case "arrowright":
        case "n":
          return (handled(), move(1));
        case "k":
        case "arrowleft":
        case "p":
          return (handled(), move(-1));
        case "c":
          return (handled(), createAt());
        case "g":
          return (handled(), setDialog({ kind: "goto" }));
        case "/":
          return (handled(), setCmd(true));
        case "?":
          return (handled(), setDialog({ kind: "shortcuts" }));
        case "z":
          return (handled(), setDialog({ kind: "zones" }));
        case ",":
          return (handled(), setDialog({ kind: "settings" }));
      }
      if (/^[1-7]$/.test(k)) {
        handled();
        const n = Number(k);
        void actions.savePrefs({ days: n });
        setVs((s) => ({ ...s, view: n === 1 ? "day" : "week" }));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selected, gridItems, panel, actions, doUndo, goto, setView, move, createAt, joinNext, onSelect, today]);

  // ------------------------------------------------------------ drawing
  const state: CalState = { ws, boot, prefs, cals, t, locale, tz, now, today, h12, weekStart, narrow, actions };
  const title = view === "month" ? rangeTitle(addDays(days[0], 7), addDays(days[0], 7), locale) : rangeTitle(days[0], days[days.length - 1], locale);
  const common = { tz, locale, h12, items: gridItems, cals, prefs, now, today, selected, t, onSelect, onCreate, onMove: (it: GridItem, to: MoveTarget) => void onMove(it, to), onDay: (d: string) => setVs({ view: "day", anchor: d }) };

  return (
    <CalContext.Provider value={state}>
      <Shell
        user={user}
        section="calendar"
        palette={false}
        createHotkey={false}
        onSearch={() => setCmd(true)}
        fill
        sectionTitle={t("app.name")}
        sectionNav={<Rail items={items} upcoming={upcoming} anchor={vs.anchor} visible={days} onPick={(d) => goto(d)} meetWith={meetWith} setMeetWith={setMeetWith} />}
      >
        <div className="cal-app" data-view={view}>
          <header className="cal-head">
            <h1 className="cal-head-title">
              <span>{title.main}</span> <span className="cal-head-year">{title.year}</span>
              {view !== "month" && view !== "agenda" && <span className="cal-head-week">{t("c.week", { n: isoWeek(days[0]) })}</span>}
            </h1>
            <div className="cal-head-nav">
              <button type="button" className="cal-btn cal-btn-sm" onClick={() => goto(today)} title="T" data-testid="today">
                {t("nav.today")}
              </button>
              <button type="button" className="cal-icon-btn" aria-label={t("nav.prev")} title="K" onClick={() => move(-1)} data-testid="prev">
                <ChevronLeft size={18} className="cal-flip" />
              </button>
              <button type="button" className="cal-icon-btn" aria-label={t("nav.next")} title="J" onClick={() => move(1)} data-testid="next">
                <ChevronRight size={18} className="cal-flip" />
              </button>
            </div>
            <div className="cal-head-end">
              <button type="button" className="cal-icon-btn" aria-label={t("nav.search")} title="⌘K" onClick={() => setCmd(true)}>
                <Search size={16} />
              </button>
              <div className="cal-seg" role="tablist" aria-label={t("view.week")}>
                {VIEWS.filter((v) => !narrow || v !== "week" || narrowDays(prefs) > 1).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} data-on={view === v || undefined} onClick={() => setView(v)} data-testid={`view-${v}`}>
                    {v === "week" && (narrow || prefs.days < 7) ? t("view.days", { n: narrow ? narrowDays(prefs) : prefs.days }) : t(`view.${v}`)}
                  </button>
                ))}
              </div>
              <button type="button" className="cal-icon-btn" aria-label={t("nav.settings")} title="," onClick={() => setDialog({ kind: "settings" })}>
                <Settings size={16} />
              </button>
            </div>
          </header>
          <div className="cal-body">
            <div className="cal-view">
              {(view === "day" || view === "week") && <TimeGrid {...common} days={days} zones={prefs.zones} overlays={overlaysOn ? overlays : []} />}
              {view === "month" && <MonthView {...common} days={days} anchor={vs.anchor} />}
              {view === "agenda" && <AgendaView days={days} items={gridItems} tz={tz} locale={locale} h12={h12} cals={cals} now={now} today={today} selected={selected} t={t} onSelect={onSelect} />}
            </div>
            {!panel && (
              <button type="button" className="cal-fab" aria-label={t("ev.new")} title="C" onClick={() => createAt()} data-testid="fab-new">
                <Plus size={22} />
              </button>
            )}
            {panel && <EventPanel key={panel.kind === "event" ? `${panel.id}|${panel.occ ?? ""}` : panel.kind === "layer" ? panel.item.key : "draft"} target={panel} />}
          </div>
        </div>
      </Shell>
      {cmd && <CommandMenu onClose={() => setCmd(false)} onGoto={goto} onView={setView} onCreate={createAt} onToday={() => goto(today)} onJoin={joinNext} />}
      {dialog && <Dialogs d={dialog} />}
      {scopeAsk && (
        <ScopeDialog
          deleting={scopeAsk.deleting}
          t={t}
          onPick={(s) => {
            scopeAsk.resolve(s);
            setScopeAsk(null);
          }}
        />
      )}
    </CalContext.Provider>
  );
}
