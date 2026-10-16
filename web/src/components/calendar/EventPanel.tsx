"use client";

// The event panel on the right (Notion Calendar's event sidebar): every field
// of an event, saved as it changes; a repeating event asks this / following /
// all. A new event (dragged on the grid) is a draft until it gets a title or
// any other change. Guests, reminders, the place (found through our maps
// proxy), the video call, a rich description (Markdown, Projects' editor),
// Docs pages attached and meeting notes, and what the event is Related to.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlarmClock, AlignLeft, Bell, CalendarDays, Check, Copy, ExternalLink, FileText, FilePlus2, ListTodo, MapPin, MoreHorizontal, Plus, Search, Trash2, Users, Video, X } from "lucide-react";
import { MarkdownEditor } from "@/components/projects/Editor";
import type { Person } from "@/lib/projects/types";
import { LinkPopover, Related } from "@/components/eco/Related";
import { toast } from "@/components/zvena/ds/toast-store";
import { addDays, atMinute, dayOf, daysBetween, minuteOfDay, offsetLabel } from "@/lib/calendar/tz";
import type { EventDetail, LayerItem, Reminder } from "@/lib/calendar/types";
import { calApi } from "./api";
import { useCal, type Draft, type Patch, type PanelTarget } from "./context";
import { fmtDate, fmtTime } from "./format";
import { joinUrl } from "./model";
import { DateField, TimeField, ZonePicker } from "./pickers";
import { describeRule, RepeatField } from "./Repeat";
import { ColorDots, Menu, Popover, Switch } from "./ui";

type Ev = (EventDetail & { isNew?: false }) | (Draft & { isNew: true; id?: undefined; occ: null; recurring: boolean; canEdit: true; attendeesFull?: undefined });

const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

function draftToEv(d: Draft): Ev {
  return { ...d, isNew: true, occ: null, recurring: Boolean(d.rrule), canEdit: true };
}

export function EventPanel({ target }: { target: PanelTarget }) {
  const c = useCal();
  const { t, locale, actions } = c;
  // A saved event is loaded here; a draft lives in the app (the grid draws it too).
  const [loaded, setLoaded] = useState<EventDetail | null>(null);
  const [error, setError] = useState(false);
  const [notify, setNotify] = useState(true);
  const titleRef = useRef<HTMLInputElement>(null);
  const eventId = target.kind === "event" ? target.id : null;
  const eventOcc = target.kind === "event" ? target.occ : null;

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const r = await calApi<{ event: EventDetail }>(c.ws, `events/${eventId}`, { query: { occ: eventOcc } });
      setLoaded(r.event);
      setError(false);
    } catch {
      setError(true);
    }
  }, [c.ws, eventId, eventOcc]);
  // The panel is mounted per event (CalendarApp keys it): one load, then writes answer with the event.
  useEffect(() => {
    const tm = setTimeout(() => void load(), 0);
    return () => clearTimeout(tm);
  }, [load]);
  useEffect(() => {
    if (target.kind !== "draft") return;
    const tm = setTimeout(() => titleRef.current?.focus(), 30);
    return () => clearTimeout(tm);
  }, [target.kind]);
  const ev: Ev | null = target.kind === "draft" ? draftToEv(target.draft) : loaded;
  const setEv = (e: Ev) => {
    if (!e.isNew) setLoaded(e);
  };

  if (target.kind === "layer") return <LayerPanel item={target.item} />;
  if (error)
    return (
      <aside className="cal-panel" aria-label={t("ev.open")}>
        <PanelHead onClose={() => actions.open(null)} />
        <p className="cal-panel-empty">{t("app.error")}</p>
      </aside>
    );
  if (!ev) return <aside className="cal-panel cal-panel-loading" aria-busy="true" />;

  const editable = ev.isNew || ev.canEdit;
  const cal = c.cals.get(ev.calId);
  const color = ev.color ?? cal?.color ?? "#2f80ed";
  const tz = c.tz;
  const startDay = ev.allDay ? ev.startDay : dayOf(ev.start, tz);
  const endDayIncl = ev.allDay ? addDays(ev.endDay, -1) : dayOf(Math.max(ev.start, ev.end - 1), tz);
  const startMin = ev.allDay ? 0 : minuteOfDay(ev.start, tz);
  const endMin = ev.allDay ? 0 : startMin + Math.round((ev.end - ev.start) / 60_000);

  /** One change: a draft keeps it locally; a saved event is written (scope asked when it repeats). */
  const commit = async (patch: Patch, local: Partial<Ev> = {}) => {
    if (ev.isNew) {
      actions.editDraft({ ...(patch as Partial<Draft>), ...(local as Partial<Draft>) });
      return;
    }
    setEv({ ...ev, ...(patch as Partial<EventDetail>), ...local } as Ev);
    const saved = await actions.update(ev, patch, { notify });
    if (saved) setEv(saved);
    else void load();
  };

  const setTimes = (startMs: number, endMs: number) => commit({ start: startMs, end: endMs, tz: ev.tz || tz });
  const setDays = (sd: string, ed: string) => commit({ allDay: true, startDay: sd, endDay: ed });

  const save = async (over: Partial<Draft> = {}) => {
    if (!ev.isNew) return;
    const x = { ...ev, ...over };
    const d: Draft = { calId: x.calId, title: x.title, allDay: x.allDay, start: x.start, end: x.end, startDay: x.startDay, endDay: x.endDay, tz: x.tz, rrule: x.rrule, location: x.location, place: x.place, conference: x.conference, description: x.description, color: x.color, reminders: x.reminders, attendees: x.attendees, busy: x.busy };
    await actions.create(d, { notify });
  };

  const join = joinUrl(ev);
  const writable = [...c.cals.values()].filter((x) => !x.readOnly && (x.level === "owner" || x.level === "edit"));
  const people: Person[] = c.boot.members.map((m) => ({ id: m.id, name: m.name, avatar: null, role: "editor" }));
  const attendees = ev.isNew ? ev.attendees.map((a) => ({ email: a.email ?? "", userId: a.userId, name: a.name, rsvp: "needs-action" as const })) : ev.attendees;

  return (
    <aside className="cal-panel" aria-label={ev.isNew ? t("ev.new") : t("ev.open")} style={{ "--ev": color } as CSSProperties} data-testid="event-panel">
      <PanelHead
        onClose={() => {
          // A draft with anything in it is kept (the title may not have left its field yet).
          const title = titleRef.current?.value.trim() ?? ev.title;
          if (ev.isNew && (title || ev.description || ev.location || ev.attendees.length)) void save({ title }).then(() => actions.open(null));
          else actions.open(null);
        }}
        menu={!ev.isNew ? <EventMenu ev={ev} /> : undefined}
      />
      <div className="cal-panel-body">
        <div className="cal-panel-title">
          <span className="cal-panel-swatch" aria-hidden />
          <input
            ref={titleRef}
            className="cal-title-input"
            placeholder={ev.isNew ? t("ev.new") : t("ev.untitled")}
            aria-label={t("ev.title")}
            readOnly={!editable}
            defaultValue={ev.title}
            key={`title-${ev.id ?? "new"}-${ev.occ ?? ""}-${ev.isNew ? "d" : ev.updatedAt}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const v = e.currentTarget.value.trim();
                if (ev.isNew) void save({ title: v });
                else if (v !== ev.title) void commit({ title: v });
                e.currentTarget.blur();
              }
              if (e.key === "Escape") e.currentTarget.blur();
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (ev.isNew) actions.editDraft({ title: v });
              else if (v !== ev.title && editable) void commit({ title: v });
            }}
          />
        </div>

        {!ev.isNew && ev.invited && <div className="cal-panel-note">{ev.organizer ? t("inv.from", { name: ev.organizer.name }) : t("ev.invited")}</div>}
        {!ev.isNew && !editable && !ev.invited && <div className="cal-panel-note">{t("ev.readOnly")}</div>}
        {!ev.isNew && ev.canRsvp && (
          <div className="cal-rsvp" role="group" aria-label={t("ev.going")}>
            <span>{t("ev.going")}</span>
            {(["accepted", "declined", "tentative"] as const).map((a) => (
              <button key={a} type="button" className="cal-chip" aria-pressed={ev.rsvp === a} data-on={ev.rsvp === a || undefined} onClick={async () => setEv((await actions.rsvp(ev, a)) ?? ev)}>
                {t(`rsvp.${a}`)}
              </button>
            ))}
          </div>
        )}

        <section className="cal-sec">
          <div className="cal-sec-icon">
            <CalendarDays size={15} />
          </div>
          <div className="cal-sec-main">
            <div className="cal-when">
              {ev.allDay ? (
                <>
                  <DateField value={startDay} label={t("ev.when")} onChange={(d) => setDays(d, addDays(d, daysBetween(ev.startDay, ev.endDay)))} locale={locale} tz={tz} now={c.now} weekStart={c.weekStart} t={t} disabled={!editable} />
                  {endDayIncl !== startDay || editable ? (
                    <>
                      <span className="cal-muted">{t("ev.to")}</span>
                      <DateField value={endDayIncl} label={t("ev.to")} onChange={(d) => d >= startDay && setDays(startDay, addDays(d, 1))} locale={locale} tz={tz} now={c.now} weekStart={c.weekStart} t={t} disabled={!editable} />
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <DateField
                    value={startDay}
                    label={t("ev.when")}
                    onChange={(d) => {
                      const s = atMinute(d, startMin, tz);
                      void setTimes(s, s + (ev.end - ev.start));
                    }}
                    locale={locale}
                    tz={tz}
                    now={c.now}
                    weekStart={c.weekStart}
                    t={t}
                    disabled={!editable}
                  />
                  <TimeField
                    minute={startMin}
                    label={t("ev.when")}
                    locale={locale}
                    h12={c.h12}
                    disabled={!editable}
                    onChange={(m) => {
                      const s = atMinute(startDay, m % 1440, tz);
                      void setTimes(s, s + (ev.end - ev.start));
                    }}
                  />
                  <span className="cal-muted">–</span>
                  <TimeField minute={endMin} label={t("ev.to")} from={startMin} locale={locale} h12={c.h12} disabled={!editable} onChange={(m) => void setTimes(ev.start, atMinute(startDay, m, tz))} />
                  {endDayIncl !== startDay && <span className="cal-muted">{fmtDate(endDayIncl, locale)}</span>}
                </>
              )}
            </div>
            <div className="cal-when-opts">
              <label className="cal-inline">
                <Switch
                  on={ev.allDay}
                  label={t("ev.allDay")}
                  disabled={!editable}
                  onChange={(on) => {
                    if (on) void setDays(startDay, addDays(endDayIncl, 1));
                    else {
                      const s = atMinute(startDay, Math.max(c.prefs.workStart, 9 * 60), tz);
                      void commit({ allDay: false, start: s, end: s + c.prefs.defaultDuration * 60_000, tz: ev.tz || tz });
                    }
                  }}
                />
                {t("ev.allDay")}
              </label>
              {!ev.allDay && <ZonePicker value={ev.tz || tz} onChange={(z) => commit({ tz: z })} t={t} now={c.now} disabled={!editable} compact />}
            </div>
            {!ev.allDay && ev.tz && ev.tz !== tz && (
              <div className="cal-muted cal-small">
                {fmtTime(ev.start, ev.tz, locale, c.h12, false)} – {fmtTime(ev.end, ev.tz, locale, c.h12, false)} {offsetLabel(ev.start, ev.tz)}
              </div>
            )}
            <RepeatField rule={ev.isNew ? ev.rrule : ev.rrule} day={startDay} onChange={(r) => commit({ rrule: r }, { recurring: Boolean(r) } as Partial<Ev>)} locale={locale} t={t} disabled={!editable || Boolean(!ev.isNew && ev.seriesId !== ev.id)} tz={tz} now={c.now} weekStart={c.weekStart} />
          </div>
        </section>

        <section className="cal-sec">
          <div className="cal-sec-icon">
            <span className="cal-dot" style={{ background: cal?.color }} />
          </div>
          <div className="cal-sec-main">
            {editable && writable.length > 1 ? (
              <select className="cal-select" value={ev.calId} aria-label={t("ev.calendar")} onChange={(e) => commit({ calId: e.target.value })}>
                {writable.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            ) : (
              <span>{cal?.name ?? ""}</span>
            )}
            {editable && (
              <div className="cal-color-row">
                <button type="button" className="cal-chip" data-on={ev.color === null || undefined} onClick={() => commit({ color: null })}>
                  {t("ev.calendarColor")}
                </button>
                <ColorDots value={ev.color} onChange={(col) => commit({ color: col })} label={t("ev.color")} />
              </div>
            )}
          </div>
        </section>

        <GuestsField attendees={attendees} organizer={ev.isNew ? null : ev.organizer} editable={editable} notify={notify} setNotify={setNotify} onChange={(list) => commit({ attendees: list.map((a) => (a.userId ? { userId: a.userId } : { email: a.email })) }, ev.isNew ? ({ attendees: list } as Partial<Ev>) : {})} />

        <LocationField value={ev.location} place={ev.place} editable={editable} onChange={(location, place) => commit({ location, place })} />

        <section className="cal-sec">
          <div className="cal-sec-icon">
            <Video size={15} />
          </div>
          <div className="cal-sec-main cal-sec-row">
            {editable ? (
              <input
                className="cal-input cal-input-flat"
                defaultValue={ev.conference}
                key={`conf-${ev.conference}`}
                placeholder={t("ev.addConference")}
                aria-label={t("ev.conference")}
                inputMode="url"
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if (v === ev.conference) return;
                  if (v && !/^https:\/\/\S+$/i.test(v)) return toast(t("ev.failed"), { kind: "error" });
                  void commit({ conference: v });
                }}
              />
            ) : (
              <span className="cal-muted">{ev.conference || "—"}</span>
            )}
            {join && (
              <a className="cal-btn cal-btn-primary cal-btn-sm" href={join} target="_blank" rel="noopener noreferrer">
                {t("ev.join")}
              </a>
            )}
          </div>
        </section>

        <RemindersField value={ev.reminders} editable={editable} onChange={(r) => commit({ reminders: r })} />

        <section className="cal-sec">
          <div className="cal-sec-icon">
            <AlarmClock size={15} />
          </div>
          <div className="cal-sec-main">
            <select className="cal-select" value={ev.busy ? "busy" : "free"} disabled={!editable} aria-label={t("ev.showAs")} onChange={(e) => commit({ busy: e.target.value === "busy" })}>
              <option value="busy">{t("ev.busy")}</option>
              <option value="free">{t("ev.free")}</option>
            </select>
          </div>
        </section>

        <section className="cal-sec cal-sec-desc">
          <div className="cal-sec-icon">
            <AlignLeft size={15} />
          </div>
          <div className="cal-sec-main pj-app-lite">
            <MarkdownEditor
              key={`desc-${ev.id ?? "new"}-${ev.occ ?? ""}`}
              value={ev.description}
              editable={editable}
              people={people}
              placeholder={t("ev.addDescription")}
              label={t("ev.description")}
              toolbar
              onBlur={(md) => {
                if (md !== ev.description) void commit({ description: md });
              }}
            />
          </div>
        </section>

        {!ev.isNew && <DocsField ev={ev} onEvent={setEv} />}
        {!ev.isNew && (
          <div className="cal-related">
            <Related ws={c.ws} refKey={`event:${ev.seriesId}`} canEdit={ev.canEdit} collapsible defaultOpen={false} title={t("ev.related")} />
          </div>
        )}
        {!ev.isNew && ev.recurring && <div className="cal-muted cal-small cal-panel-rule">{describeRule(ev.rrule, startDay, locale, t)}</div>}
      </div>
      {ev.isNew && (
        <div className="cal-panel-foot">
          <button type="button" className="cal-btn" onClick={() => actions.open(null)}>
            {t("c.cancel")}
          </button>
          <button type="button" className="cal-btn cal-btn-primary" onClick={() => void save()} data-testid="save-event">
            {t("c.save")}
          </button>
        </div>
      )}
    </aside>
  );
}

function PanelHead({ onClose, menu }: { onClose: () => void; menu?: React.ReactNode }) {
  const { t } = useCal();
  return (
    <div className="cal-panel-head">
      {menu}
      <button type="button" className="cal-icon-btn" aria-label={t("ev.close")} onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

function EventMenu({ ev }: { ev: EventDetail }) {
  const c = useCal();
  const { t, actions } = c;
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const issue = async () => {
    try {
      const r = await calApi<{ card: { url: string; sub?: string } }>(c.ws, `events/${ev.id}/issue`, { body: { occ: ev.occ } });
      toast(`${t("ev.issueCreated")}${r.card.sub ? ` · ${r.card.sub}` : ""}`, { kind: "success", action: { label: t("c.open"), run: () => (location.href = r.card.url) } });
    } catch {
      toast(t("ev.failed"), { kind: "error" });
    }
  };
  return (
    <>
      <button type="button" className="cal-icon-btn" aria-label={t("ev.more")} onClick={(e) => setOpen(e.currentTarget)}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <Menu
          anchor={open}
          align="end"
          onClose={() => setOpen(null)}
          items={[
            { key: "dup", label: t("ev.duplicate"), icon: <Copy size={14} />, hint: "⌘D", run: () => void actions.duplicate(ev) },
            { key: "link", label: t("ev.copyLink"), icon: <ExternalLink size={14} />, run: () => actions.copyLink(ev) },
            { key: "issue", label: t("ev.turnIntoIssue"), icon: <ListTodo size={14} />, disabled: !c.boot.ws.canEdit, run: () => void issue() },
            "sep",
            { key: "del", label: t("ev.delete"), icon: <Trash2 size={14} />, danger: true, disabled: !ev.canEdit, hint: "⌫", run: () => void actions.remove(ev) },
          ]}
        />
      )}
    </>
  );
}

function GuestsField({ attendees, organizer, editable, onChange, notify, setNotify }: { attendees: { email: string; userId?: string; name: string; rsvp: string }[]; organizer: { id: string; name: string } | null; editable: boolean; onChange: (list: { email: string; userId?: string; name: string }[]) => void; notify: boolean; setNotify: (v: boolean) => void }) {
  const c = useCal();
  const { t } = c;
  const [q, setQ] = useState("");
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [focus, setFocus] = useState(false);
  const taken = useMemo(() => new Set(attendees.map((a) => a.userId ?? a.email)), [attendees]);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return c.boot.members.filter((m) => m.id !== c.boot.me.id && !taken.has(m.id) && (m.name.toLowerCase().includes(s) || m.email?.toLowerCase().includes(s))).slice(0, 6);
  }, [q, c.boot.members, c.boot.me.id, taken]);
  const add = (a: { email: string; userId?: string; name: string }) => {
    onChange([...attendees, a]);
    setQ("");
  };
  const tryEmail = () => {
    const s = q.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && !taken.has(s)) add({ email: s, name: "" });
  };
  if (!editable && !attendees.length) return null;
  return (
    <section className="cal-sec">
      <div className="cal-sec-icon">
        <Users size={15} />
      </div>
      <div className="cal-sec-main">
        {organizer && attendees.length > 0 && (
          <div className="cal-guest">
            <span className="cal-avatar">{organizer.name.charAt(0).toUpperCase()}</span>
            <span className="cal-guest-name">{organizer.name}</span>
            <span className="cal-muted cal-small">{t("ev.organizer")}</span>
          </div>
        )}
        {attendees.map((a) => (
          <div key={a.userId ?? a.email} className="cal-guest" data-rsvp={a.rsvp}>
            <span className="cal-avatar">{(a.name || a.email).charAt(0).toUpperCase()}</span>
            <span className="cal-guest-name">{a.name || a.email}</span>
            <span className="cal-muted cal-small">{t(`rsvp.${a.rsvp}` as "rsvp.accepted")}</span>
            {editable && (
              <button type="button" className="cal-icon-btn" aria-label={t("c.remove")} onClick={() => onChange(attendees.filter((x) => x !== a))}>
                <X size={13} />
              </button>
            )}
          </div>
        ))}
        {editable && (
          <div className="cal-guest-add">
            <input
              ref={setInput}
              className="cal-input cal-input-flat"
              value={q}
              placeholder={t("ev.addGuests")}
              aria-label={t("ev.guests")}
              onFocus={() => setFocus(true)}
              onBlur={() => setTimeout(() => setFocus(false), 150)}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  if (hits[0]) add({ email: hits[0].email ?? "", userId: hits[0].id, name: hits[0].name });
                  else tryEmail();
                }
              }}
            />
            {focus && hits.length > 0 && input && (
              <Popover anchor={input} onClose={() => setFocus(false)} width={280} role="listbox" label={t("ev.guests")}>
                <div className="cal-menu">
                  {hits.map((m) => (
                    <button key={m.id} type="button" className="cal-menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => add({ email: m.email ?? "", userId: m.id, name: m.name })}>
                      <span className="cal-avatar">{m.name.charAt(0).toUpperCase()}</span>
                      <span className="cal-menu-label">{m.name}</span>
                      {m.email && <span className="cal-menu-hint">{m.email}</span>}
                    </button>
                  ))}
                </div>
              </Popover>
            )}
          </div>
        )}
        {editable && attendees.some((a) => !a.userId) && c.boot.mailOn && (
          <label className="cal-inline cal-small">
            <Switch on={notify} onChange={setNotify} label={t("ev.notifyGuests")} />
            {t("ev.notifyGuests")}
          </label>
        )}
        {attendees.some((a) => !a.userId) && !c.boot.mailOn && (
          <p className="cal-small cal-muted" role="note">
            {t("ev.noMailGuests")}
          </p>
        )}
      </div>
    </section>
  );
}

function reminderLabel(min: number, t: ReturnType<typeof useCal>["t"]): string {
  if (min === 0) return t("ev.atStart");
  if (min < 60) return t("ev.minBefore", { n: min });
  if (min < 1440) return t("ev.hBefore", { n: Math.round(min / 60) });
  return t("ev.dBefore", { n: Math.round(min / 1440) });
}

function RemindersField({ value, editable, onChange }: { value: Reminder[]; editable: boolean; onChange: (r: Reminder[]) => void }) {
  const { t, boot } = useCal();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  if (!editable && !value.length) return null;
  return (
    <section className="cal-sec">
      <div className="cal-sec-icon">
        <Bell size={15} />
      </div>
      <div className="cal-sec-main cal-chips">
        {value.map((r, i) => (
          <span key={`${r.min}-${r.how}`} className="cal-chip">
            {reminderLabel(r.min, t)}
            {editable ? (
              <button
                type="button"
                className="cal-chip-mode"
                // No mail service here: reminders come to the Inbox (the server falls back too).
                disabled={!boot.mailOn && r.how === "inbox"}
                title={!boot.mailOn ? t("ev.noMailReminders") : undefined}
                onClick={() => onChange(value.map((x, j) => (j === i ? { ...x, how: x.how === "inbox" ? "email" : "inbox" } : x)))}
              >
                {r.how === "email" ? (boot.mailOn ? t("ev.byEmail") : t("ev.byEmailOff")) : t("ev.inInbox")}
              </button>
            ) : (
              <span className="cal-muted"> · {r.how === "email" ? t("ev.byEmail") : t("ev.inInbox")}</span>
            )}
            {editable && (
              <button type="button" className="cal-chip-x" aria-label={t("c.remove")} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {editable && value.length < 5 && (
          <button type="button" className="cal-chip cal-chip-add" onClick={(e) => setOpen(e.currentTarget)}>
            <Plus size={12} /> {t("ev.addReminder")}
          </button>
        )}
        {open && (
          <Menu anchor={open} onClose={() => setOpen(null)} width={200} items={REMINDER_CHOICES.filter((m) => !value.some((v) => v.min === m)).map((m) => ({ key: String(m), label: reminderLabel(m, t), run: () => onChange([...value, { min: m, how: "inbox" }]) }))} />
        )}
      </div>
    </section>
  );
}

interface Place {
  name: string;
  address?: string;
  lat: number;
  lng: number;
}

/** Slippy-map tile of a point (our own /api/maps proxy: no third party sees who looks). */
function tileOf(lat: number, lng: number, z = 15): { x: number; y: number; z: number; px: number; py: number } {
  const n = 2 ** z;
  const xf = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x: Math.floor(xf), y: Math.floor(yf), z, px: (xf % 1) * 256, py: (yf % 1) * 256 };
}

function LocationField({ value, place, editable, onChange }: { value: string; place: { name: string; lat: number; lng: number } | null; editable: boolean; onChange: (v: string, place: { name: string; lat: number; lng: number } | null) => void }) {
  const c = useCal();
  const { t } = c;
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [results, setResults] = useState<Place[] | null>(null);
  const find = async () => {
    const q = input?.value.trim() ?? "";
    if (q.length < 2) return;
    try {
      const r = await fetch(`/api/maps/search?q=${encodeURIComponent(q)}&lang=${c.locale}`).then((x) => (x.ok ? x.json() : { results: [] }));
      setResults((r as { results: Place[] }).results ?? []);
    } catch {
      setResults([]);
    }
  };
  if (!editable && !value) return null;
  const tile = place ? tileOf(place.lat, place.lng) : null;
  return (
    <section className="cal-sec">
      <div className="cal-sec-icon">
        <MapPin size={15} />
      </div>
      <div className="cal-sec-main">
        <div className="cal-sec-row">
          {editable ? (
            <input
              ref={setInput}
              className="cal-input cal-input-flat"
              defaultValue={value}
              key={`loc-${value}`}
              placeholder={t("ev.addLocation")}
              aria-label={t("ev.location")}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void find())}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v !== value) onChange(v, null);
              }}
            />
          ) : (
            <span>{value}</span>
          )}
          {editable && (
            <button type="button" className="cal-icon-btn" aria-label={t("ev.findPlace")} title={t("ev.findPlace")} onClick={() => void find()}>
              <Search size={14} />
            </button>
          )}
        </div>
        {results && input && (
          <Popover anchor={input} onClose={() => setResults(null)} width={320} label={t("ev.findPlace")}>
            <div className="cal-menu">
              {results.length === 0 && <div className="cal-menu-empty">{t("cmd.empty")}</div>}
              {results.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  className="cal-menu-item"
                  onClick={() => {
                    setResults(null);
                    onChange(r.address ? `${r.name}, ${r.address}`.slice(0, 500) : r.name, { name: r.name, lat: r.lat, lng: r.lng });
                  }}
                >
                  <MapPin size={14} />
                  <span className="cal-menu-label">{r.name}</span>
                  {r.address && <span className="cal-menu-hint">{r.address}</span>}
                </button>
              ))}
            </div>
          </Popover>
        )}
        {place && tile && (
          <a className="cal-map" href={`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}#map=16/${place.lat}/${place.lng}`} target="_blank" rel="noopener noreferrer" aria-label={t("ev.openMap")}>
            {/* Our own tile proxy (same origin), already the right size. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/maps/tile/${tile.z}/${tile.x}/${tile.y}`} alt="" width={256} height={256} style={{ left: `calc(50% - ${tile.px}px)`, top: `calc(50% - ${tile.py}px)` }} />
            <span className="cal-map-pin" aria-hidden />
            <span className="cal-map-label">
              {t("ev.openMap")} <ExternalLink size={11} />
            </span>
          </a>
        )}
      </div>
    </section>
  );
}

function DocsField({ ev, onEvent }: { ev: EventDetail; onEvent: (e: EventDetail) => void }) {
  const c = useCal();
  const { t } = c;
  const [pick, setPick] = useState<HTMLElement | null>(null);
  const notes = async () => {
    try {
      const r = await calApi<{ url: string; event: EventDetail }>(c.ws, `events/${ev.id}/notes`, { body: { occ: ev.occ } });
      if (r.event) onEvent(r.event);
      toast(t("ev.notesCreated"), { kind: "success", action: { label: t("c.open"), run: () => window.open(r.url, "_blank", "noopener") } });
      window.open(r.url, "_blank", "noopener");
    } catch {
      toast(t("ev.failed"), { kind: "error" });
    }
  };
  return (
    <section className="cal-sec">
      <div className="cal-sec-icon">
        <FileText size={15} />
      </div>
      <div className="cal-sec-main">
        {ev.docs.map((d) => (
          <div key={d.id} className="cal-doc">
            <a href={d.url} target="_blank" rel="noopener noreferrer">
              <span aria-hidden>{d.icon || "📄"}</span> {d.title || t("ev.untitled")}
            </a>
            {ev.canEdit && (
              <button
                type="button"
                className="cal-icon-btn"
                aria-label={t("c.remove")}
                onClick={async () => {
                  const r = await calApi<{ event: EventDetail }>(c.ws, `events/${ev.id}/docs/${d.id}`, { method: "DELETE", query: { occ: ev.occ } }).catch(() => null);
                  if (r) onEvent(r.event);
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
        <div className="cal-chips">
          <button type="button" className="cal-chip cal-chip-add" onClick={() => void notes()} data-testid="meeting-notes">
            <FilePlus2 size={12} /> {t("ev.meetingNotes")}
          </button>
          {ev.canEdit && (
            <button type="button" className="cal-chip cal-chip-add" onClick={(e) => setPick(e.currentTarget)}>
              <Plus size={12} /> {t("ev.attachPage")}
            </button>
          )}
        </div>
        {pick && (
          <LinkPopover
            ws={c.ws}
            anchor={pick}
            kinds={["note"]}
            exclude={ev.docs.map((d) => `note:${d.id}`)}
            placeholder={t("ev.attachPage")}
            onClose={() => setPick(null)}
            onPick={async (card) => {
              setPick(null);
              const r = await calApi<{ event: EventDetail }>(c.ws, `events/${ev.id}/docs`, { body: { noteId: card.key.slice(5), occ: ev.occ } }).catch(() => null);
              if (r) onEvent(r.event);
              else toast(t("ev.failed"), { kind: "error" });
            }}
          />
        )}
      </div>
    </section>
  );
}

function LayerPanel({ item }: { item: LayerItem }) {
  const c = useCal();
  const { t, locale } = c;
  const day = item.start.slice(0, 10);
  return (
    <aside className="cal-panel" aria-label={item.title} style={{ "--ev": item.color } as CSSProperties}>
      <PanelHead onClose={() => c.actions.open(null)} />
      <div className="cal-panel-body">
        <div className="cal-panel-title">
          <span className="cal-panel-swatch" aria-hidden />
          <h2 className="cal-title-input">{item.title || t("ev.untitled")}</h2>
        </div>
        <section className="cal-sec">
          <div className="cal-sec-icon">
            <CalendarDays size={15} />
          </div>
          <div className="cal-sec-main">
            {fmtDate(day, locale)}
            {item.start.length > 10 && ` · ${item.start.slice(11)}`}
            {item.end && item.end.slice(0, 10) !== day && ` – ${fmtDate(item.end.slice(0, 10), locale)}`}
          </div>
        </section>
        {item.sub && (
          <section className="cal-sec">
            <div className="cal-sec-icon">{item.kind === "doc" ? <FileText size={15} /> : <ListTodo size={15} />}</div>
            <div className="cal-sec-main">{item.sub}</div>
          </section>
        )}
        {!item.canEdit && item.kind !== "doc" && <p className="cal-panel-note">{t("lay.readOnly")}</p>}
        <a className="cal-btn" href={item.url}>
          <Check size={14} aria-hidden /> {t("c.open")}
        </a>
      </div>
    </aside>
  );
}
