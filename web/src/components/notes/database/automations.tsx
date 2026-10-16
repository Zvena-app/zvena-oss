"use client";

// Database automations panel (Notion's ⚡): a list with on/off switches, the
// last run of each, and an editor for "When …" and "Do …". The same action
// editor sets up a Button property ("When clicked") and a template's repeat.
// Signed-in workspaces run automations on the server (lib/notes/automations-server.ts).

import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, Bell, CircleHelp, FilePlus2, Link2, Pencil, Plus, Repeat, Sparkles, Trash2, Webhook, X, Zap } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { Menu, Popover } from "../ui";
import { PagePicker, SETTABLE, ValueField, isDb } from "../ButtonEditor";
import { displayTitle, shortId } from "@/lib/notes/model";
import { MAX_AUTOMATIONS, type AutoAction, type AutoJev, type Automation, type AutoTrigger } from "@/lib/notes/automations";
import { people, subscribePeople } from "@/lib/notes/people";
import { relativeTime } from "@/lib/notes/i18n";
import type { DbProperty, Note, PropValue } from "@/lib/notes/types";
import { intlOf } from "@/i18n/locales";
import { useMondayFirst } from "../prefs";

/** Properties a "when … changes" trigger can watch. */
const WATCHABLE = new Set<DbProperty["type"]>(["title", "text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "email", "phone", "files", "person", "place"]);

type Schedule = Extract<AutoTrigger, { type: "schedule" }>;
type ActionType = AutoAction["type"];

/** What runs on the server (automations); buttons also open things and ask first. */
export const SERVER_ACTIONS: readonly ActionType[] = ["set", "addPage", "notify", "webhook"];
export const BUTTON_ACTIONS: readonly ActionType[] = ["set", "addPage", "notify", "webhook", "openPage", "openUrl", "confirm"];

const usePeople = () => useSyncExternalStore(subscribePeople, people, people);

const weekdayShort = (locale: string, wd: number) => new Intl.DateTimeFormat(intlOf(locale), { weekday: "short" }).format(new Date(Date.UTC(2026, 0, 4 + wd)));
const monthName = (locale: string, m: number) => new Intl.DateTimeFormat(intlOf(locale), { month: "long" }).format(new Date(Date.UTC(2026, m - 1, 15)));
const todayYmd = () => new Date().toLocaleDateString("sv-SE");

function scheduleLabel(ctl: DbCtl, tr: Schedule): string {
  const { t, locale } = ctl.api;
  const n = tr.interval ?? 1;
  let s =
    n > 1
      ? t("auto.everyN", { n, unit: t(`auto.unit.${tr.every}`), at: tr.at })
      : t(tr.every === "day" ? "auto.everyDay" : tr.every === "week" ? "auto.everyWeek" : tr.every === "month" ? "auto.everyMonth" : "auto.everyYear", { at: tr.at });
  if (tr.every === "week") s += ` · ${(tr.weekdays ?? (tr.weekday !== undefined ? [tr.weekday] : [1])).map((d) => weekdayShort(locale, d)).join(", ")}`;
  if (tr.every === "month") s += ` · ${tr.monthday ?? 1}`;
  if (tr.every === "year") s += ` · ${tr.monthday ?? 1} ${monthName(locale, tr.month ?? 1)}`;
  return s;
}

function triggerLabel(ctl: DbCtl, tr: AutoTrigger): string {
  const { t } = ctl.api;
  if (tr.type === "added") return t("auto.whenAdded");
  if (tr.type === "schedule") return scheduleLabel(ctl, tr);
  const p = ctl.schema?.properties.find((x) => x.id === tr.prop);
  const v = tr.value ? (tr.value === "checked" ? t("auto.checked") : tr.value === "unchecked" ? t("auto.unchecked") : (p?.options?.find((o) => o.id === tr.value)?.name ?? "")) : "";
  return v ? t("auto.whenSetTo", { prop: p?.name ?? "?", value: v }) : t("auto.whenEdited", { prop: p?.name ?? "?" });
}

/** An action complete enough to save. */
const usable = (x: AutoAction) =>
  x.type === "set" ||
  x.type === "confirm" ||
  (x.type === "notify" && x.to.length > 0) ||
  (x.type === "webhook" && /^https:\/\/\S+/i.test(x.url)) ||
  (x.type === "addPage" && Boolean(x.dbId)) ||
  (x.type === "openPage" && Boolean(x.noteId)) ||
  (x.type === "openUrl" && /^(https?:|mailto:)\S+/i.test(x.url));

export function actionLabel(ctl: DbCtl, a: AutoAction): string {
  const { t, snap } = ctl.api;
  if (a.type === "set") return t("auto.doSet", { prop: ctl.schema?.properties.find((x) => x.id === a.prop)?.name ?? "?" });
  if (a.type === "notify") return t("auto.doNotify");
  if (a.type === "webhook") return t("auto.doWebhook");
  if (a.type === "openPage" || a.type === "openUrl") return t("auto.doOpen");
  if (a.type === "confirm") return t("auto.doConfirm");
  const db = snap.byId.get(a.dbId);
  return t("auto.doAdd", { db: db?.title || t("db.untitled") });
}

function newAction(ctl: DbCtl, type: ActionType): AutoAction {
  const settable = (ctl.schema?.properties ?? []).filter((p) => SETTABLE.has(p.type));
  switch (type) {
    case "set":
      return { type, prop: settable[0]?.id ?? "title", value: null };
    case "addPage":
      return { type, dbId: "", title: "" };
    case "notify":
      return { type, to: [], text: "" };
    case "webhook":
      return { type, url: "" };
    case "openPage":
      return { type, noteId: "" };
    case "openUrl":
      return { type, url: "" };
    case "confirm":
      return { type, text: "" };
  }
}

// ---------------------------------------------------------------------------
// "Do": actions

/** Who a notification goes to: people, the people of a Person property, the creator or the editor. */
function NotifyField({ ctl, value, onChange }: { ctl: DbCtl; value: Extract<AutoAction, { type: "notify" }>; onChange: (v: AutoAction) => void }) {
  const { t } = ctl.api;
  const members = usePeople();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const personProps = (ctl.schema?.properties ?? []).filter((p) => p.type === "person");
  const label = (target: string): string => {
    if (target === "creator") return t("auto.creator");
    if (target === "editor") return t("auto.editor");
    if (target.startsWith("prop:")) return t("auto.peopleIn", { prop: personProps.find((p) => p.id === target.slice(5))?.name ?? "?" });
    return members.find((m) => m.id === target)?.name ?? "?";
  };
  const add = (target: string) => {
    if (!value.to.includes(target)) onChange({ ...value, to: [...value.to, target] });
    setMenu(null);
  };
  const choices = [
    { key: "creator", label: t("auto.creator") },
    { key: "editor", label: t("auto.editor") },
    ...personProps.map((p) => ({ key: `prop:${p.id}`, label: t("auto.peopleIn", { prop: p.name }) })),
    ...members.map((m) => ({ key: m.id, label: m.name })),
  ].filter((c) => !value.to.includes(c.key));
  return (
    <div className="nt-auto-row">
      <span className="nt-auto-verb">{t("auto.actNotify")}</span>
      {value.to.map((target) => (
        <span key={target} className="nt-chip">
          {label(target)}
          <button type="button" className="nt-btn-reset" aria-label={t("button.removeStep")} onClick={() => onChange({ ...value, to: value.to.filter((x) => x !== target) })}>
            <X size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="nt-chip nt-btn-reset" onClick={(e) => setMenu(e.currentTarget)}>
        <Plus />
        {t("auto.notifyAdd")}
      </button>
      <input className="nt-input" value={value.text} maxLength={280} placeholder={t("auto.notifyMessage")} onChange={(e) => onChange({ ...value, text: e.target.value })} />
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          <Menu width={240} onClose={() => setMenu(null)} groups={[{ key: "p", items: choices.map((c) => ({ key: c.key, label: c.label, onSelect: () => add(c.key) })) }]} />
        </Popover>
      )}
    </div>
  );
}

function ActionRow({ ctl, x, onChange }: { ctl: DbCtl; x: AutoAction; onChange: (v: AutoAction) => void }) {
  const { t, snap } = ctl.api;
  const props = ctl.schema?.properties ?? [];
  const settable = props.filter((p) => SETTABLE.has(p.type) || p.type === "title");
  switch (x.type) {
    case "set":
      return (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("auto.actSet")}</span>
          <select className="nt-fsel" value={x.prop} onChange={(e) => onChange({ type: "set", prop: e.target.value, value: null })}>
            {settable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {(() => {
            const p = props.find((y) => y.id === x.prop);
            if (!p) return null;
            if (p.type === "title") return <input className="nt-input" value={typeof x.value === "string" ? x.value : ""} onChange={(e) => onChange({ ...x, value: e.target.value })} />;
            return <ValueField prop={p} value={x.value ?? undefined} onChange={(v) => onChange({ ...x, value: (v ?? null) as PropValue })} />;
          })()}
        </div>
      );
    case "addPage": {
      const templates = x.dbId ? snap.list.filter((n) => n.parentId === x.dbId && n.template && n.trashedAt === null) : [];
      return (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("auto.actAdd")}</span>
          <PagePicker value={x.dbId} filter={isDb} placeholder={t("button.pickDb")} onPick={(dbId) => onChange({ ...x, dbId, templateId: undefined })} />
          <input className="nt-input" value={x.title} placeholder={t("button.pageTitle")} onChange={(e) => onChange({ ...x, title: e.target.value })} />
          {templates.length > 0 && (
            <select className="nt-fsel" value={x.templateId ?? ""} aria-label={t("button.template")} onChange={(e) => onChange({ ...x, templateId: e.target.value || undefined })}>
              <option value="">{t("button.noTemplate")}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {displayTitle(tpl, t("page.untitled"))}
                </option>
              ))}
            </select>
          )}
        </div>
      );
    }
    case "notify":
      return <NotifyField ctl={ctl} value={x} onChange={onChange} />;
    case "webhook":
      return (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("auto.actWebhook")}</span>
          <input className="nt-input" type="url" inputMode="url" value={x.url} placeholder="https://…" onChange={(e) => onChange({ ...x, url: e.target.value.trim() })} />
          <small className="nt-auto-note" style={{ border: 0, margin: 0, padding: 0, flexBasis: "100%" }}>
            {t("auto.webhookHint")}
          </small>
        </div>
      );
    case "openPage":
      return (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("button.step.openPage")}</span>
          <PagePicker value={x.noteId} filter={(n: Note) => n.kind === "page" || n.kind === "database"} placeholder={t("button.pickPage")} onPick={(noteId) => onChange({ ...x, noteId })} />
        </div>
      );
    case "openUrl":
      return (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("button.step.openUrl")}</span>
          <input className="nt-input" type="url" inputMode="url" value={x.url} placeholder="https://…" onChange={(e) => onChange({ ...x, url: e.target.value.trim() })} />
        </div>
      );
    case "confirm":
      return (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("button.step.confirm")}</span>
          <input className="nt-input" value={x.text} maxLength={300} placeholder={t("button.confirmDefault")} onChange={(e) => onChange({ ...x, text: e.target.value })} />
        </div>
      );
  }
}

const ACTION_META: Record<ActionType, { label: "auto.actSetLong" | "auto.actAddLong" | "auto.actNotifyLong" | "auto.actWebhookLong" | "button.step.openPage" | "button.step.openUrl" | "button.step.confirm"; icon: React.ReactNode }> = {
  set: { label: "auto.actSetLong", icon: <Pencil /> },
  addPage: { label: "auto.actAddLong", icon: <FilePlus2 /> },
  notify: { label: "auto.actNotifyLong", icon: <Bell /> },
  webhook: { label: "auto.actWebhookLong", icon: <Webhook /> },
  openPage: { label: "button.step.openPage", icon: <ArrowUpRight /> },
  openUrl: { label: "button.step.openUrl", icon: <Link2 /> },
  confirm: { label: "button.step.confirm", icon: <CircleHelp /> },
};

/** The "Do" list: one card per action, "+ Add action". */
export function ActionsEditor({ ctl, actions, onChange, allow }: { ctl: DbCtl; actions: AutoAction[]; onChange: (next: AutoAction[]) => void; allow: readonly ActionType[] }) {
  const { t } = ctl.api;
  const [add, setAdd] = useState<HTMLElement | null>(null);
  return (
    <>
      {actions.map((x, i) => (
        <div key={i} className="nt-auto-action">
          <ActionRow ctl={ctl} x={x} onChange={(v) => onChange(actions.map((y, j) => (j === i ? v : y)))} />
          <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("button.removeStep")} title={t("button.removeStep")} onClick={() => onChange(actions.filter((_, j) => j !== i))}>
            <X />
          </button>
        </div>
      ))}
      <button type="button" className="nt-advf-add nt-btn-reset" onClick={(e) => setAdd(e.currentTarget)}>
        <Plus />
        {t("auto.addAction")}
      </button>
      {add && (
        <Popover anchor={add} onClose={() => setAdd(null)}>
          <Menu
            width={240}
            onClose={() => setAdd(null)}
            groups={[
              {
                key: "a",
                items: allow.map((type) => ({ key: type, label: t(ACTION_META[type].label), icon: ACTION_META[type].icon, onSelect: () => (onChange([...actions, newAction(ctl, type)]), setAdd(null)) })),
              },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

export const cleanList = (actions: AutoAction[]) => actions.filter(usable);

// ---------------------------------------------------------------------------
// "When": a recurring schedule

/** Every N days / weeks (on weekdays) / months (on a day) / years, at a time, from a date. */
export function ScheduleFields({ ctl, value, onChange }: { ctl: DbCtl; value: Schedule; onChange: (v: Schedule) => void }) {
  const { t, locale } = ctl.api;
  const days = value.weekdays ?? (value.weekday !== undefined ? [value.weekday] : [1]);
  const set = (patch: Partial<Schedule>) => onChange({ ...value, ...patch });
  // The week as the calendar shows it (the language's region, or the person's setting).
  const order = useMondayFirst(locale) ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  return (
    <>
      <div className="nt-auto-row">
        <span className="nt-auto-verb">{t("auto.repeatEvery")}</span>
        <input className="nt-input" type="number" min={1} max={99} style={{ flex: "0 0 64px" }} value={value.interval ?? 1} onChange={(e) => set({ interval: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })} />
        <select className="nt-fsel" value={value.every} onChange={(e) => set({ every: e.target.value as Schedule["every"] })}>
          {(["day", "week", "month", "year"] as const).map((u) => (
            <option key={u} value={u}>
              {t(`auto.unit.${u}`)}
            </option>
          ))}
        </select>
      </div>
      {value.every === "week" && (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("auto.onDays")}</span>
          {order.map((d) => {
            const on = days.includes(d);
            return (
              <button
                key={d}
                type="button"
                className="nt-chip nt-btn-reset nt-auto-day"
                aria-pressed={on}
                data-on={on || undefined}
                onClick={() => {
                  const next = on ? days.filter((x) => x !== d) : [...days, d].sort();
                  if (next.length) set({ weekdays: next, weekday: undefined });
                }}
              >
                {weekdayShort(locale, d)}
              </button>
            );
          })}
        </div>
      )}
      {value.every === "year" && (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("auto.inMonth")}</span>
          <select className="nt-fsel" value={value.month ?? 1} onChange={(e) => set({ month: Number(e.target.value) })}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {monthName(locale, m)}
              </option>
            ))}
          </select>
        </div>
      )}
      {(value.every === "month" || value.every === "year") && (
        <div className="nt-auto-row">
          <span className="nt-auto-verb">{t("auto.onDay")}</span>
          <select className="nt-fsel" value={value.monthday ?? 1} onChange={(e) => set({ monthday: Number(e.target.value) })}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="nt-auto-row">
        <span className="nt-auto-verb">{t("auto.at")}</span>
        <input className="nt-input" type="time" style={{ flex: "0 0 110px" }} value={value.at} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && set({ at: e.target.value })} />
        <span className="nt-auto-verb">{t("auto.starting")}</span>
        <input className="nt-input" type="date" style={{ flex: "0 0 150px" }} value={value.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
      </div>
    </>
  );
}

const defaultSchedule = (): Schedule => ({ type: "schedule", every: "week", at: "09:00", weekdays: [1], from: todayYmd() });

/** The workspace's time zone for schedules (signed in only; changed for the whole workspace). */
function TzField({ ctl, tz, onTz }: { ctl: DbCtl; tz: string | null; onTz: (tz: string) => void }) {
  const { t } = ctl.api;
  const ws = ctl.api.user?.ws.id;
  if (!ws || !tz) return null;
  const zones = (() => {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return all.includes(tz) ? all : [tz, ...all];
  })();
  const change = async (next: string) => {
    const r = await fetch(`/api/notes/automations?ws=${encodeURIComponent(ws)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz: next }), credentials: "same-origin" }).catch(() => null);
    if (r?.ok) onTz(next);
  };
  return (
    <div className="nt-auto-row">
      <span className="nt-auto-verb">{t("auto.tz")}</span>
      <select className="nt-fsel" value={tz} disabled={ctl.readOnly} onChange={(e) => void change(e.target.value)}>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Only if Jev agrees"

/** Columns never sent to Jev: they name or reach a person, hold no words, or are computed from other pages and columns (lib/decide/docs-jev.ts says the same). */
const NOT_FOR_JEV = new Set<DbProperty["type"]>(["person", "created_by", "last_edited_by", "email", "phone", "button", "files", "formula", "rollup", "relation"]);

function JevField({ ctl, value, onChange }: { ctl: DbCtl; value: AutoJev | undefined; onChange: (v: AutoJev | undefined) => void }) {
  const { t } = ctl.api;
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const props = (ctl.schema?.properties ?? []).filter((p) => !NOT_FOR_JEV.has(p.type));
  const on = value !== undefined;
  const v: AutoJev = value ?? { question: "", fields: props.filter((p) => p.type === "title").map((p) => p.id) };
  const choices = props.filter((p) => !v.fields.includes(p.id));
  return (
    <div className="nt-auto-jev" data-on={on || undefined}>
      <label className="nt-auto-row nt-auto-jev-toggle">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? v : undefined)} />
        <Sparkles size={14} aria-hidden />
        <span>{t("auto.jevIf")}</span>
      </label>
      {on && (
        <>
          <div className="nt-auto-row">
            <input className="nt-input" value={v.question} maxLength={500} placeholder={t("auto.jevQuestion")} aria-label={t("auto.jevIf")} onChange={(e) => onChange({ ...v, question: e.target.value })} />
          </div>
          <div className="nt-auto-row">
            <span className="nt-auto-verb">{t("auto.jevFields")}</span>
            {v.fields.map((id) => (
              <span key={id} className="nt-chip">
                {props.find((p) => p.id === id)?.name ?? "?"}
                <button type="button" className="nt-btn-reset" aria-label={t("button.removeStep")} onClick={() => onChange({ ...v, fields: v.fields.filter((x) => x !== id) })}>
                  <X size={12} />
                </button>
              </span>
            ))}
            {choices.length > 0 && v.fields.length < 12 && (
              <button type="button" className="nt-chip nt-btn-reset" onClick={(e) => setMenu(e.currentTarget)}>
                <Plus />
                {t("auto.jevFieldsAdd")}
              </button>
            )}
          </div>
          <label className="nt-auto-row">
            <input type="checkbox" checked={v.confirm === true} onChange={(e) => onChange({ ...v, confirm: e.target.checked || undefined })} />
            <span>{t("auto.jevConfirm")}</span>
          </label>
          <small className="nt-auto-note" style={{ border: 0, margin: 0, padding: 0 }}>
            {t("auto.jevHint")}
          </small>
          {menu && (
            <Popover anchor={menu} onClose={() => setMenu(null)}>
              <Menu
                width={220}
                onClose={() => setMenu(null)}
                groups={[{ key: "p", items: choices.map((p) => ({ key: p.id, label: p.name, onSelect: () => (onChange({ ...v, fields: [...v.fields, p.id] }), setMenu(null)) })) }]}
              />
            </Popover>
          )}
        </>
      )}
    </div>
  );
}

/** A Jev condition complete enough to save (or none). */
const jevReady = (j: AutoJev | undefined) => !j || (j.question.trim() !== "" && j.fields.length > 0);

// ---------------------------------------------------------------------------
// The automation editor and the panel

function Editor({ ctl, initial, tz, onTz, onDone }: { ctl: DbCtl; initial: Automation; tz: string | null; onTz: (tz: string) => void; onDone: (a: Automation | null) => void }) {
  const { t } = ctl.api;
  const props = ctl.schema?.properties ?? [];
  const [a, setA] = useState<Automation>(initial);
  const watched = a.trigger.type === "edited" ? props.find((p) => p.id === (a.trigger as { prop: string }).prop) : undefined;
  return (
    <div className="nt-auto-edit">
      <input className="nt-input nt-auto-name" autoFocus value={a.name} maxLength={200} placeholder={t("auto.namePlaceholder")} onChange={(e) => setA({ ...a, name: e.target.value })} />
      <div className="nt-menu-label">{t("auto.when")}</div>
      <div className="nt-auto-row">
        <select
          className="nt-fsel"
          value={a.trigger.type}
          onChange={(e) =>
            setA({
              ...a,
              trigger: e.target.value === "added" ? { type: "added" } : e.target.value === "schedule" ? defaultSchedule() : { type: "edited", prop: props.find((p) => WATCHABLE.has(p.type))?.id ?? "title" },
            })
          }
        >
          <option value="added">{t("auto.trigAdded")}</option>
          <option value="edited">{t("auto.trigEdited")}</option>
          <option value="schedule">{t("auto.trigSchedule")}</option>
        </select>
        {a.trigger.type === "edited" && (
          <>
            <select className="nt-fsel" value={a.trigger.prop} onChange={(e) => setA({ ...a, trigger: { type: "edited", prop: e.target.value } })}>
              {props
                .filter((p) => WATCHABLE.has(p.type))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            {watched && (watched.options || watched.type === "checkbox") && (
              <select className="nt-fsel" value={a.trigger.value ?? ""} onChange={(e) => setA({ ...a, trigger: { type: "edited", prop: watched.id, ...(e.target.value ? { value: e.target.value } : {}) } })}>
                <option value="">{t("auto.anyChange")}</option>
                {watched.type === "checkbox" ? (
                  <>
                    <option value="checked">{t("auto.checked")}</option>
                    <option value="unchecked">{t("auto.unchecked")}</option>
                  </>
                ) : (
                  (watched.options ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {t("auto.setTo", { value: o.name })}
                    </option>
                  ))
                )}
              </select>
            )}
          </>
        )}
      </div>
      {a.trigger.type === "schedule" && (
        <>
          <ScheduleFields ctl={ctl} value={a.trigger} onChange={(trigger) => setA({ ...a, trigger })} />
          <TzField ctl={ctl} tz={tz} onTz={onTz} />
        </>
      )}
      {/* Jev judges a page: not a schedule, and only where a server runs it (signed in). */}
      {a.trigger.type !== "schedule" && ctl.api.user && <JevField ctl={ctl} value={a.jev} onChange={(jev) => setA({ ...a, jev })} />}
      <div className="nt-menu-label">{t("auto.do")}</div>
      {/* A schedule has no page of its own: nothing to edit or open. */}
      <ActionsEditor ctl={ctl} actions={a.actions} onChange={(actions) => setA({ ...a, actions })} allow={a.trigger.type === "schedule" ? SERVER_ACTIONS.filter((x) => x !== "set") : SERVER_ACTIONS} />
      <div className="nt-auto-foot">
        <button type="button" className="nt-btn nt-btn-reset" onClick={() => onDone(null)}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="nt-btn nt-btn-primary nt-btn-reset"
          disabled={!a.actions.some(usable) || !jevReady(a.jev)}
          onClick={() => {
            const { jev, ...rest } = a;
            onDone({ ...rest, ...(jev && a.trigger.type !== "schedule" ? { jev: { ...jev, question: jev.question.trim() } } : {}), actions: cleanList(a.actions) });
          }}
        >
          {t("auto.save")}
        </button>
      </div>
    </div>
  );
}

interface Run {
  automationId: string;
  at: number;
  runs: number;
  ok: boolean;
  error?: string;
  nextAt?: number;
}

/** The server's word on a database's automations: last runs, next times, the time zone. */
function useRuns(ctl: DbCtl): { runs: Map<string, Run>; tz: string | null; setTz: (tz: string) => void } {
  const ws = ctl.api.user?.ws.id;
  const dbId = ctl.db?.id;
  const [state, setState] = useState<{ runs: Map<string, Run>; tz: string | null }>({ runs: new Map(), tz: null });
  useEffect(() => {
    if (!ws || !dbId) return;
    let live = true;
    void fetch(`/api/notes/automations?ws=${encodeURIComponent(ws)}&db=${encodeURIComponent(dbId)}`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ tz: string; runs: Run[] }>) : null))
      .then((j) => {
        if (live && j) setState({ tz: j.tz, runs: new Map(j.runs.map((r) => [r.automationId, r])) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ws, dbId]);
  return { ...state, setTz: (tz) => setState((s) => ({ ...s, tz })) };
}

function runText(ctl: DbCtl, r: Run | undefined, scheduled: boolean): string {
  const { t, locale } = ctl.api;
  if (r?.error) return t("auto.failed", { error: r.error });
  const parts: string[] = [];
  if (r?.at) parts.push(t("auto.lastRun", { when: relativeTime(t, locale, r.at) }));
  if (scheduled && r?.nextAt) parts.push(t("auto.nextRun", { when: new Date(r.nextAt).toLocaleString(intlOf(locale), { dateStyle: "medium", timeStyle: "short" }) }));
  return parts.join(" · ") || t("auto.neverRan");
}

export function AutomationsPanel({ ctl, anchor, onClose }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const list = ctl.schema?.automations ?? [];
  const [editing, setEditing] = useState<Automation | null>(null);
  const { runs, tz, setTz } = useRuns(ctl);
  const signedIn = Boolean(ctl.api.user);
  const save = (next: Automation[]) => ctl.updateSchema((s) => ({ ...s, automations: next.length ? next : undefined }));
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" className="nt-auto-pop">
      {editing ? (
        <Editor
          ctl={ctl}
          initial={editing}
          tz={tz}
          onTz={setTz}
          onDone={(a) => {
            if (a) save(list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]);
            setEditing(null);
          }}
        />
      ) : (
        <div className="nt-auto-list">
          <div className="nt-auto-title">
            <Zap />
            {t("auto.title")}
          </div>
          {list.length === 0 && <p className="nt-auto-empty">{t("auto.empty")}</p>}
          {list.map((a) => {
            const run = runs.get(a.id);
            return (
              <div key={a.id} className="nt-auto-item" data-off={!a.on || undefined}>
                <button type="button" role="switch" aria-checked={a.on} aria-label={t("auto.toggle")} className="nt-switch nt-btn-reset" disabled={ctl.readOnly} onClick={() => save(list.map((x) => (x.id === a.id ? { ...x, on: !x.on } : x)))}>
                  <span />
                </button>
                <div className="nt-auto-item-text" role="button" tabIndex={0} onClick={() => !ctl.readOnly && setEditing(a)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !ctl.readOnly && (e.preventDefault(), setEditing(a))}>
                  <b>
                    {a.trigger.type === "schedule" && <Repeat size={12} style={{ marginInlineEnd: 4, verticalAlign: -1 }} />}
                    {a.name || t("auto.untitled")}
                  </b>
                  <small>
                    {triggerLabel(ctl, a.trigger)}
                    {a.jev ? ` · ${t("auto.withJev")}` : ""} → {a.actions.map((x) => actionLabel(ctl, x)).join(", ")}
                  </small>
                  {signedIn && (
                    <small className="nt-auto-run" data-error={run?.error ? true : undefined}>
                      {runText(ctl, run, a.trigger.type === "schedule")}
                    </small>
                  )}
                </div>
                {!ctl.readOnly && (
                  <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("auto.delete")} title={t("auto.delete")} onClick={() => save(list.filter((x) => x.id !== a.id))}>
                    <Trash2 />
                  </button>
                )}
              </div>
            );
          })}
          {list.length < MAX_AUTOMATIONS && !ctl.readOnly && (
            <button
              type="button"
              className="nt-advf-add nt-btn-reset"
              onClick={() => setEditing({ id: shortId(), name: "", on: true, trigger: { type: "added" }, actions: [newAction(ctl, "set")] })}
            >
              <Plus />
              {t("auto.new")}
            </button>
          )}
          <p className="nt-auto-note">{signedIn ? t("auto.noteServer") : t("auto.noteGuest")}</p>
        </div>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Button property: "When clicked"

export function ButtonSetup({ ctl, prop, anchor, onClose }: { ctl: DbCtl; prop: DbProperty; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const [label, setLabel] = useState(prop.button?.label ?? "");
  const [actions, setActions] = useState<AutoAction[]>(prop.button?.actions ?? []);
  const done = () => {
    ctl.updateProp(prop.id, { button: { label: label.trim().slice(0, 100), actions: cleanList(actions) } });
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={done} placement="bottom-start" className="nt-auto-pop">
      <div className="nt-auto-edit">
        <div className="nt-menu-label">{t("auto.buttonLabel")}</div>
        <input className="nt-input nt-auto-name" autoFocus value={label} maxLength={100} placeholder={prop.name || t("auto.buttonDefault")} onChange={(e) => setLabel(e.target.value)} />
        <div className="nt-menu-label">{t("button.whenClicked")}</div>
        <ActionsEditor ctl={ctl} actions={actions} onChange={setActions} allow={BUTTON_ACTIONS} />
        <div className="nt-auto-foot">
          <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" onClick={done}>
            {t("button.done")}
          </button>
        </div>
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// A database template's repeat (Notion: template ••• → Repeat)

/** The automation that repeats a template, if any. */
export const repeatIdOf = (tplId: string) => `repeat-${tplId}`.slice(0, 40);

export function RepeatSetup({ ctl, template, anchor, onClose }: { ctl: DbCtl; template: Note; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const id = repeatIdOf(template.id);
  const list = ctl.schema?.automations ?? [];
  const existing = list.find((a) => a.id === id);
  const [trigger, setTrigger] = useState<Schedule>(existing?.trigger.type === "schedule" ? existing.trigger : defaultSchedule());
  const { tz, setTz } = useRuns(ctl);
  const dbId = ctl.db?.id ?? "";
  const write = (next: Automation[]) => ctl.updateSchema((s) => ({ ...s, automations: next.length ? next : undefined }));
  const save = () => {
    const a: Automation = { id, name: t("auto.repeatName", { name: displayTitle(template, t("page.untitled")) }), on: true, trigger, actions: [{ type: "addPage", dbId, title: "", templateId: template.id }] };
    write(existing ? list.map((x) => (x.id === id ? a : x)) : [...list, a]);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="right-start" className="nt-auto-pop">
      <div className="nt-auto-edit">
        <div className="nt-auto-title">
          <Repeat />
          {t("auto.repeat")}
        </div>
        <p className="nt-auto-empty">{t("auto.repeatHint")}</p>
        <ScheduleFields ctl={ctl} value={trigger} onChange={setTrigger} />
        <TzField ctl={ctl} tz={tz} onTz={setTz} />
        <div className="nt-auto-foot">
          {existing && (
            <button type="button" className="nt-btn nt-btn-reset" onClick={() => (write(list.filter((x) => x.id !== id)), onClose())}>
              {t("auto.repeatOff")}
            </button>
          )}
          <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" onClick={save}>
            {t("auto.save")}
          </button>
        </div>
      </div>
    </Popover>
  );
}
