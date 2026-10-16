"use client";

// Calendar's block in the shared rail: the next event (Notion Calendar's
// menu-bar item), the mini month, "Meet with…", the calendars with their
// color toggles, Docs and Projects layers, and scheduling links.

import { useMemo, useState, type CSSProperties } from "react";
import { Copy, Database, Eye, Link2, ListTodo, MoreHorizontal, Plus, RefreshCcw, RotateCw, Settings2, Upload, Video, X } from "lucide-react";
import { toast } from "@/components/zvena/ds/toast-store";
import type { CalendarInfo, EventItem, LayerInfo, LinkInfo } from "@/lib/calendar/types";
import { calApi } from "./api";
import { useCal } from "./context";
import { fmtIn, fmtTime } from "./format";
import { joinUrl, nextEvent } from "./model";
import { MiniMonth } from "./pickers";
import { copyText, Menu, Popover, type MenuItem } from "./ui";

export interface RailProps {
  items: readonly EventItem[];
  /** The coming week (the "next" card). */
  upcoming: readonly EventItem[];
  anchor: string;
  visible: readonly string[];
  onPick: (day: string) => void;
  meetWith: readonly string[];
  setMeetWith: (ids: string[]) => void;
}

export function Rail({ items, upcoming, anchor, visible, onPick, meetWith, setMeetWith }: RailProps) {
  const c = useCal();
  const { t, boot } = c;
  const [month, setMonth] = useState(anchor);
  const [lastAnchor, setLastAnchor] = useState(anchor);
  if (anchor !== lastAnchor) {
    setLastAnchor(anchor);
    setMonth(anchor);
  }
  const marks = useMemo(() => new Set(items.filter((e) => !c.cals.get(e.calId)?.hidden).map((e) => e.startDay)), [items, c.cals]);
  const mine = boot.calendars.filter((x) => x.level === "owner" && x.kind !== "ics");
  const subs = boot.calendars.filter((x) => x.level === "owner" && x.kind === "ics");
  const shared = boot.calendars.filter((x) => x.level !== "owner");
  return (
    <div className="cal-rail">
      <NextUp items={upcoming} />
      <MiniMonth month={month} onMonth={setMonth} selected={new Set(visible)} today={c.today} onPick={onPick} weekStart={c.weekStart} locale={c.locale} marks={marks} t={t} />
      <MeetWith ids={meetWith} onChange={setMeetWith} />
      <Group title={t("rail.mine")} add={<AddMenu />}>
        {mine.map((x) => (
          <CalRow key={x.id} cal={x} />
        ))}
      </Group>
      {shared.length > 0 && (
        <Group title={t("rail.shared")}>
          {shared.map((x) => (
            <CalRow key={x.id} cal={x} />
          ))}
        </Group>
      )}
      {subs.length > 0 && (
        <Group title={t("rail.subscriptions")}>
          {subs.map((x) => (
            <CalRow key={x.id} cal={x} />
          ))}
        </Group>
      )}
      <Group title={t("rail.layers")} add={<button type="button" className="cal-icon-btn" aria-label={t("lay.addDocs")} title={t("lay.addDocs")} onClick={() => c.actions.dialog({ kind: "layer" })}><Plus size={14} /></button>}>
        {boot.layers.map((l) => (
          <LayerRow key={`${l.kind}:${l.ref}`} layer={l} />
        ))}
      </Group>
      <Group title={t("rail.links")} add={<button type="button" className="cal-icon-btn" aria-label={t("rail.newLink")} title={t("rail.newLink")} onClick={() => c.actions.dialog({ kind: "link", id: null })} data-testid="new-link"><Plus size={14} /></button>}>
        {boot.links.map((l) => (
          <LinkRow key={l.id} link={l} />
        ))}
        <button type="button" className="cal-rail-action" onClick={() => c.actions.dialog({ kind: "availability" })} data-testid="share-availability">
          <Copy size={14} />
          {t("avail.title")}
        </button>
      </Group>
    </div>
  );
}

function Group({ title, add, children }: { title: string; add?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cal-group">
      <div className="cal-group-head">
        <span>{title}</span>
        {add}
      </div>
      <div className="cal-group-body">{children}</div>
    </div>
  );
}

function NextUp({ items }: { items: readonly EventItem[] }) {
  const c = useCal();
  const { t } = c;
  const next = nextEvent(items.filter((e) => !c.cals.get(e.calId)?.hidden), c.now);
  if (!next) return <div className="cal-next cal-next-empty">{t("rail.noUpcoming")}</div>;
  const join = joinUrl(next);
  const live = next.start <= c.now;
  return (
    <button type="button" className="cal-next" style={{ "--ev": next.color ?? c.cals.get(next.calId)?.color } as CSSProperties} onClick={() => c.actions.open({ kind: "event", id: next.id, occ: next.occ })} data-testid="next-event">
      <span className="cal-next-when">{live ? t("rail.now") : fmtIn(next.start, c.now, c.locale)}</span>
      <span className="cal-next-title">{next.title || t("ev.untitled")}</span>
      <span className="cal-next-time">
        {fmtTime(next.start, c.tz, c.locale, c.h12)} – {fmtTime(next.end, c.tz, c.locale, c.h12)}
      </span>
      {join && (
        <a className="cal-btn cal-btn-primary cal-btn-sm cal-next-join" href={join} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          <Video size={13} aria-hidden /> {t("ev.join")}
        </a>
      )}
    </button>
  );
}

function MeetWith({ ids, onChange }: { ids: readonly string[]; onChange: (ids: string[]) => void }) {
  const c = useCal();
  const { t } = c;
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const others = c.boot.members.filter((m) => m.id !== c.boot.me.id);
  if (!others.length) return null;
  const hits = others.filter((m) => !ids.includes(m.id) && (!q || m.name.toLowerCase().includes(q.toLowerCase()) || m.email?.toLowerCase().includes(q.toLowerCase()))).slice(0, 6);
  return (
    <div className="cal-meet">
      <input ref={setInput} className="cal-input" value={q} placeholder={t("rail.meetWith")} aria-label={t("rail.meetWithHint")} onFocus={() => setFocus(true)} onChange={(e) => setQ(e.target.value)} />
      {focus && hits.length > 0 && input && (
        <Popover anchor={input} onClose={() => setFocus(false)} width={240} role="listbox" label={t("rail.meetWith")}>
          <div className="cal-menu">
            {hits.map((m) => (
              <button key={m.id} type="button" className="cal-menu-item" onClick={() => (onChange([...ids, m.id].slice(0, 8)), setQ(""), setFocus(false))}>
                <span className="cal-avatar">{m.name.charAt(0).toUpperCase()}</span>
                <span className="cal-menu-label">{m.name}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
      {ids.length > 0 && (
        <div className="cal-chips">
          {ids.map((id, i) => {
            const m = c.boot.members.find((x) => x.id === id);
            return (
              <span key={id} className="cal-chip" style={{ "--ev": OVERLAY_COLORS[i % OVERLAY_COLORS.length] } as CSSProperties}>
                <span className="cal-dot" style={{ background: OVERLAY_COLORS[i % OVERLAY_COLORS.length] }} />
                {m?.name ?? id}
                <button type="button" className="cal-chip-x" aria-label={t("c.remove")} onClick={() => onChange(ids.filter((x) => x !== id))}>
                  <X size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const OVERLAY_COLORS = ["#9b51e0", "#f2994a", "#27ae60", "#eb5757", "#2d9cdb", "#e86aa6", "#828282", "#f2c94c"];

function AddMenu() {
  const c = useCal();
  const { t, actions } = c;
  const [open, setOpen] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" className="cal-icon-btn" aria-label={t("rail.addCalendar")} title={t("rail.addCalendar")} onClick={(e) => setOpen(e.currentTarget)} data-testid="add-calendar">
        <Plus size={14} />
      </button>
      {open && (
        <Menu
          anchor={open}
          onClose={() => setOpen(null)}
          width={250}
          items={[
            { key: "new", label: t("cal.new"), icon: <Plus size={14} />, run: () => actions.dialog({ kind: "calendar", id: null }) },
            { key: "sub", label: t("cal.subscribe"), icon: <Link2 size={14} />, run: () => actions.dialog({ kind: "subscribe" }) },
            { key: "imp", label: t("cal.import"), icon: <Upload size={14} />, run: () => actions.dialog({ kind: "import" }) },
            { key: "dav", label: t("cal.caldav"), icon: <RefreshCcw size={14} />, run: () => actions.dialog({ kind: "caldav" }) },
            "sep",
            { key: "lay", label: t("lay.addDocs"), icon: <Database size={14} />, run: () => actions.dialog({ kind: "layer" }) },
          ]}
        />
      )}
    </>
  );
}

function CalRow({ cal }: { cal: CalendarInfo }) {
  const c = useCal();
  const { t, actions } = c;
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const items: (MenuItem | "sep")[] = [
    {
      key: "only",
      label: t("rail.only"),
      icon: <Eye size={14} />,
      run: async () => {
        for (const other of c.boot.calendars) if ((other.id === cal.id) === other.hidden) await actions.setHidden(other, other.id !== cal.id);
      },
    },
    { key: "settings", label: t("cal.settings"), icon: <Settings2 size={14} />, run: () => actions.dialog({ kind: "calendar", id: cal.id }) },
  ];
  if (cal.level === "owner" && cal.kind !== "local")
    items.push({
      key: "sync",
      label: t("cal.refresh"),
      icon: <RotateCw size={14} />,
      run: async () => {
        await calApi(c.ws, `calendars/${cal.id}/sync`, { body: {} }).catch(() => null);
        await actions.reboot();
        actions.reload();
      },
    });
  return (
    <div className="cal-item" data-hidden={cal.hidden || undefined}>
      <button type="button" role="checkbox" aria-checked={!cal.hidden} className="cal-check" style={{ "--ev": cal.color } as CSSProperties} aria-label={t("rail.toggle", { name: cal.name })} onClick={() => void actions.setHidden(cal, !cal.hidden)} />
      <span className="cal-item-name" title={cal.ownerName && cal.level !== "owner" ? t("cal.sharedBy", { name: cal.ownerName }) : cal.name}>
        {cal.name}
        {cal.syncError && <span className="cal-item-warn" title={t("cal.syncError", { error: cal.syncError })}>!</span>}
      </span>
      <button type="button" className="cal-icon-btn cal-item-more" aria-label={t("rail.options")} onClick={(e) => setOpen(e.currentTarget)}>
        <MoreHorizontal size={14} />
      </button>
      {open && <Menu anchor={open} onClose={() => setOpen(null)} items={items} align="end" />}
    </div>
  );
}

function LayerRow({ layer }: { layer: LayerInfo }) {
  const c = useCal();
  const { t } = c;
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const name = layer.kind === "issues" && layer.ref === "mine" ? t("lay.myIssues") : layer.kind === "cycles" ? t("lay.cycles") : layer.name || t("ev.untitled");
  const patch = async (body: Record<string, unknown>, method = "PATCH") => {
    await calApi(c.ws, `layers/${layer.kind}/${layer.ref}`, { method, ...(method === "PATCH" ? { body } : {}) }).catch(() => null);
    await c.actions.reboot();
    c.actions.reload();
  };
  return (
    <div className="cal-item" data-hidden={layer.hidden || undefined}>
      <button type="button" role="checkbox" aria-checked={!layer.hidden} className="cal-check" style={{ "--ev": layer.color } as CSSProperties} aria-label={t("rail.toggle", { name })} onClick={() => void patch({ hidden: !layer.hidden })} />
      <span className="cal-item-name">
        {layer.kind === "docs" ? <span aria-hidden>{layer.icon || "🗂️"} </span> : <ListTodo size={12} aria-hidden />} {name}
      </span>
      <button type="button" className="cal-icon-btn cal-item-more" aria-label={t("rail.options")} onClick={(e) => setOpen(e.currentTarget)}>
        <MoreHorizontal size={14} />
      </button>
      {open && <Menu anchor={open} onClose={() => setOpen(null)} align="end" items={[{ key: "rm", label: t("lay.remove"), icon: <X size={14} />, danger: true, run: () => void patch({}, "DELETE") }]} />}
    </div>
  );
}

function LinkRow({ link }: { link: LinkInfo }) {
  const c = useCal();
  const { t } = c;
  return (
    <div className="cal-item" data-hidden={!link.active || undefined}>
      <Link2 size={13} className="cal-item-icon" aria-hidden />
      <button type="button" className="cal-item-name cal-item-btn" onClick={() => c.actions.dialog({ kind: "link", id: link.id })}>
        {link.title}
      </button>
      <button
        type="button"
        className="cal-icon-btn cal-item-more"
        aria-label={t("link.copy")}
        title={t("link.copy")}
        onClick={async () => {
          if (await copyText(link.url)) toast(t("link.copied"), { kind: "success" });
        }}
      >
        <Copy size={13} />
      </button>
    </div>
  );
}
