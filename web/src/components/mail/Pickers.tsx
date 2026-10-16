"use client";

// Small pickers: when a snoozed conversation comes back, when a message
// leaves (Send later), and labels (add one, or move the conversation into a
// folder / label). Times are local and named in the interface language.

import { useState } from "react";
import { Archive, CalendarClock, Inbox as InboxIcon, Plus, Tag } from "lucide-react";
import type { MailLabel } from "@/lib/mail-client/types";
import { act, api, getState, loadBoot, useMail } from "./data";
import { fullDate } from "./format";
import { useMt } from "./i18n";
import { Dot, Menu, Popover, type Anchor, type MenuItem } from "./ui";

/** Today or a later day at a given hour (local time). */
function at(days: number, hour: number, from = new Date()): number {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** The next given weekday (0 Sunday … 6 Saturday) at an hour. */
function nextWeekday(day: number, hour: number, from = new Date()): number {
  const d = new Date(from);
  const add = ((day - d.getDay() + 7) % 7) || 7;
  return at(add, hour, d);
}

export function snoozeOptions(now = new Date()): { id: string; at: number }[] {
  const out: { id: string; at: number }[] = [];
  if (now.getHours() < 17) out.push({ id: "laterToday", at: at(0, 18, now) });
  out.push({ id: "tomorrow", at: at(1, 8, now) });
  if (now.getDay() !== 6 && now.getDay() !== 0) out.push({ id: "weekend", at: nextWeekday(6, 9, now) });
  out.push({ id: "nextWeek", at: nextWeekday(1, 8, now) });
  return out;
}

function TimeMenu({ anchor, onClose, onPick, options, title }: { anchor: Anchor; onClose: () => void; onPick: (at: number) => void; options: { id: string; label: string; at: number }[]; title: string }) {
  const { t, locale } = useMt();
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => {
    const d = new Date(at(1, 9));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const items: MenuItem[] = [
    ...options.map((o) => ({ id: o.id, label: o.label, hint: fullDate(o.at, locale), run: () => onPick(o.at) })),
    { id: "custom", label: t("time.custom"), icon: <CalendarClock size={15} />, keep: true, run: () => setCustom(true) },
  ];
  return (
    <Popover anchor={anchor} onClose={onClose} width={300} label={title}>
      <div className="zm-pop-title">{title}</div>
      {custom ? (
        <form
          className="zm-time-form"
          onSubmit={(e) => {
            e.preventDefault();
            const ms = new Date(value).getTime();
            if (Number.isFinite(ms) && ms > Date.now()) {
              onClose();
              onPick(ms);
            }
          }}
        >
          <input type="datetime-local" className="zv-input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus aria-label={t("time.custom")} />
          <button type="submit" className="zv-btn zv-btn-primary zv-btn-sm">
            {t("ok")}
          </button>
        </form>
      ) : (
        <Menu items={items} onClose={onClose} />
      )}
    </Popover>
  );
}

export function SnoozePicker({ anchor, onClose, onPick }: { anchor: Anchor; onClose: () => void; onPick: (at: number) => void }) {
  const { t } = useMt();
  const labels: Record<string, string> = { laterToday: t("time.laterToday"), tomorrow: t("time.tomorrow"), weekend: t("time.weekend"), nextWeek: t("time.nextWeek") };
  return <TimeMenu anchor={anchor} onClose={onClose} onPick={onPick} title={t("act.snoozeUntil")} options={snoozeOptions().map((o) => ({ ...o, label: labels[o.id] }))} />;
}

export function SendLaterPicker({ anchor, onClose, onPick }: { anchor: Anchor; onClose: () => void; onPick: (at: number) => void }) {
  const { t } = useMt();
  const now = new Date();
  const options = [
    { id: "tomorrowMorning", label: t("time.tomorrowMorning"), at: at(1, 8, now) },
    { id: "tomorrowAfternoon", label: t("time.tomorrowAfternoon"), at: at(1, 13, now) },
    { id: "monday", label: t("time.mondayMorning"), at: nextWeekday(1, 8, now) },
  ];
  return <TimeMenu anchor={anchor} onClose={onClose} onPick={onPick} title={t("compose.sendLater")} options={options} />;
}

/**
 * Labels for conversations: zvena's own labels (any mailbox) and the
 * mailbox's own (folders, Gmail labels). "Move" files the conversation there
 * and takes it out of the inbox.
 */
export function LabelPicker({ anchor, threads, move, onClose }: { anchor: Anchor; threads: string[]; move: boolean; onClose: () => void }) {
  const { t } = useMt();
  const boot = useMail((s) => s.boot);
  const [q, setQ] = useState("");
  if (!boot) return null;
  const s = getState();
  const summaries = Object.values(s.lists).flatMap((l) => l.threads).filter((x) => threads.includes(x.id));
  const accounts = new Set([...summaries.flatMap((x) => x.accounts), ...threads.flatMap((id) => s.threads[id]?.messages.map((m) => m.accountId) ?? [])]);
  const have = new Set([...summaries.flatMap((x) => x.labels), ...threads.flatMap((id) => s.threads[id]?.labels ?? [])]);
  const usable = boot.labels.filter((l) => l.kind === "manual" || (l.accountId && accounts.has(l.accountId)));
  const shown = usable.filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()));
  const create = async () => {
    const name = q.trim();
    if (!name) return;
    const r = await api<{ label: MailLabel }>("labels", { method: "POST", json: { name } });
    onClose();
    await act(move ? "move" : "label", threads, { label: r.label.id });
    void loadBoot();
  };
  const items: MenuItem[] = [
    ...(move
      ? [
          { id: "inbox", label: t("view.inbox"), icon: <InboxIcon size={15} />, run: () => void act("inbox", threads) },
          { id: "archive", label: t("view.archive"), icon: <Archive size={15} />, run: () => void act("archive", threads) },
        ]
      : []),
    ...shown.map((l) => ({
      id: l.id,
      label: l.name,
      icon: l.kind === "manual" ? <Dot color={l.color} /> : <Tag size={15} />,
      checked: !move && have.has(l.id),
      run: () => void act(move ? "move" : have.has(l.id) ? "unlabel" : "label", threads, { label: l.id }),
    })),
    ...(q.trim() && !usable.some((l) => l.name.toLowerCase() === q.trim().toLowerCase()) ? [{ id: "new", label: t("label.create", { name: q.trim() }), icon: <Plus size={15} />, run: () => void create() }] : []),
  ];
  return (
    <Popover anchor={anchor} onClose={onClose} width={280} label={move ? t("act.move") : t("act.label")}>
      <div className="zm-pop-title">{move ? t("act.moveTo") : t("act.labelAs")}</div>
      <input className="zm-menu-search" autoFocus value={q} placeholder={t("label.search")} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
          // Type, Enter: the first match (or the new label).
          if (e.key !== "Enter" || !items.length) return;
          e.preventDefault();
          const first = items.find((it) => it.id !== "inbox" && it.id !== "archive") ?? items[0];
          if (first.id !== "new") onClose();
          first.run();
        }} />
      <Menu items={items} onClose={onClose} empty={t("label.none")} />
    </Popover>
  );
}
