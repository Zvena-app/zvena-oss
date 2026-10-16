"use client";

// Calendar's dialogs: the scope of a change to a repeating event, settings,
// a calendar's settings and sharing (with its secret feed), subscribing by
// URL, importing a file, CalDAV accounts, Docs / Projects layers, scheduling
// links, the time zone converter, "go to" and the keyboard shortcuts.

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, ExternalLink, Plus, RotateCw, Trash2, X } from "lucide-react";
import { Kbd } from "@/components/zvena/ds/Kbd";
import { toast } from "@/components/zvena/ds/toast-store";
import { parseJump } from "@/lib/calendar/natural";
import { addDays, atMinute, dayOf, minuteOfDay, offsetLabel, parseDay, zoneCity } from "@/lib/calendar/tz";
import type { LayerInfo, LinkInfo, Prefs, Scope, WsAccess } from "@/lib/calendar/types";
import { ApiError, calApi } from "./api";
import { useCal, type DialogKind } from "./context";
import { fmtDate, fmtDateLong, fmtDuration, fmtMinute, fmtTime, weekdayShort } from "./format";
import type { CT } from "./i18n";
import { DateField, TimeField, ZonePicker } from "./pickers";
import { ColorDots, copyText, Field, Modal, Switch } from "./ui";

/** A weekday's short name (0 Sunday), from a Sunday in October 2026. */
const weekdayName = (wd: number, locale: string) => weekdayShort(addDays("2026-10-11", wd), locale);

// ------------------------------------------------------------ scope

export function ScopeDialog({ deleting, onPick, t }: { deleting: boolean; onPick: (s: Scope | null) => void; t: CT }) {
  const [scope, setScope] = useState<Scope>("this");
  return (
    <Modal
      title={deleting ? t("scope.delete") : t("scope.edit")}
      onClose={() => onPick(null)}
      footer={
        <>
          <button type="button" className="cal-btn" onClick={() => onPick(null)}>
            {t("c.cancel")}
          </button>
          <button type="button" className={`cal-btn ${deleting ? "cal-btn-danger" : "cal-btn-primary"}`} data-autofocus onClick={() => onPick(scope)} data-testid="scope-ok">
            {deleting ? t("c.delete") : t("c.save")}
          </button>
        </>
      }
    >
      <div className="cal-radios" role="radiogroup" aria-label={deleting ? t("scope.delete") : t("scope.edit")}>
        {(["this", "following", "all"] as const).map((s) => (
          <label key={s} data-testid={`scope-${s}`}>
            <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} />
            {t(`scope.${s}`)}
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ router

export function Dialogs({ d }: { d: DialogKind }) {
  const close = useCal().actions.dialog;
  const onClose = () => close(null);
  switch (d.kind) {
    case "settings":
      return <SettingsDialog onClose={onClose} />;
    case "calendar":
      return <CalendarDialog id={d.id} onClose={onClose} />;
    case "subscribe":
      return <SubscribeDialog onClose={onClose} />;
    case "import":
      return <ImportDialog calId={d.calId} onClose={onClose} />;
    case "caldav":
      return <CalDavDialog onClose={onClose} />;
    case "layer":
      return <LayerDialog onClose={onClose} />;
    case "link":
      return <LinkDialog id={d.id} onClose={onClose} />;
    case "shortcuts":
      return <ShortcutsDialog onClose={onClose} />;
    case "zones":
      return <ZonesDialog onClose={onClose} />;
    case "goto":
      return <GotoDialog onClose={onClose} />;
    case "availability":
      return <AvailabilityDialog onClose={onClose} />;
  }
}

function failed(t: CT, e: unknown) {
  toast(e instanceof ApiError && e.status === 429 ? t("book.rate") : t("ev.failed"), { kind: "error" });
}

// ------------------------------------------------------------ settings

const DURATIONS = [15, 30, 45, 60, 90, 120];

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const c = useCal();
  const { t, prefs, locale } = c;
  const set = (p: Partial<Prefs>) => void c.actions.savePrefs(p);
  return (
    <Modal title={t("set.title")} onClose={onClose} wide footer={<button type="button" className="cal-btn cal-btn-primary" onClick={onClose}>{t("set.done")}</button>}>
      <div className="cal-form">
        <Field label={t("set.tz")}>
          <ZonePicker value={prefs.tz} onChange={(z) => set({ tz: z })} t={t} now={c.now} />
        </Field>
        <Field label={t("set.zones")}>
          <div className="cal-chips">
            {prefs.zones.map((z) => (
              <span key={z} className="cal-chip">
                {zoneCity(z)} <span className="cal-muted">{offsetLabel(c.now, z)}</span>
                <button type="button" className="cal-chip-x" aria-label={t("c.remove")} onClick={() => set({ zones: prefs.zones.filter((x) => x !== z) })}>
                  <X size={11} />
                </button>
              </span>
            ))}
            {prefs.zones.length < 4 && <ZoneAdd onAdd={(z) => set({ zones: [...prefs.zones, z] })} />}
          </div>
        </Field>
        <Field label={t("set.weekStart")}>
          <select className="cal-select" value={prefs.weekStart} onChange={(e) => set({ weekStart: Number(e.target.value) })}>
            <option value={-1}>{t("set.auto")}</option>
            <option value={0}>{t("set.sunday")}</option>
            <option value={1}>{t("set.monday")}</option>
            <option value={6}>{t("set.saturday")}</option>
          </select>
        </Field>
        <Field label={t("set.clock")}>
          <select className="cal-select" value={prefs.hour12 === null ? "auto" : prefs.hour12 ? "12" : "24"} onChange={(e) => set({ hour12: e.target.value === "auto" ? null : e.target.value === "12" })}>
            <option value="auto">{t("set.auto")}</option>
            <option value="12">{t("set.h12")}</option>
            <option value="24">{t("set.h24")}</option>
          </select>
        </Field>
        <Field label={t("set.workHours")}>
          <span className="cal-inline">
            <TimeField minute={prefs.workStart} onChange={(m) => m < prefs.workEnd && set({ workStart: m })} locale={locale} h12={c.h12} label={t("set.workHours")} />
            –
            <TimeField minute={prefs.workEnd} from={prefs.workStart} onChange={(m) => m <= 1440 && set({ workEnd: m })} locale={locale} h12={c.h12} label={t("set.workHours")} />
          </span>
        </Field>
        <Field label={t("set.workDays")}>
          <WeekdayToggles value={prefs.workDays} onChange={(v) => set({ workDays: v })} />
        </Field>
        <Field label={t("view.nDays")}>
          <select className="cal-select" value={prefs.days} onChange={(e) => set({ days: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? t("view.day") : n === 7 ? t("view.week") : t("view.days", { n })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("set.weekends")}>
          <Switch on={prefs.showWeekends} onChange={(v) => set({ showWeekends: v })} label={t("set.weekends")} />
        </Field>
        <Field label={t("set.duration")}>
          <select className="cal-select" value={prefs.defaultDuration} onChange={(e) => set({ defaultDuration: Number(e.target.value) })}>
            {DURATIONS.map((m) => (
              <option key={m} value={m}>
                {t("link.minutes", { n: m })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("set.defaultReminders")}>
          <select className="cal-select" value={prefs.defaultReminders[0]?.min ?? -1} onChange={(e) => set({ defaultReminders: Number(e.target.value) < 0 ? [] : [{ min: Number(e.target.value), how: "inbox" }] })}>
            <option value={-1}>{t("c.none")}</option>
            {[0, 5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? t("ev.atStart") : t("ev.minBefore", { n: m })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("set.dimPast")}>
          <Switch on={prefs.dimPast} onChange={(v) => set({ dimPast: v })} label={t("set.dimPast")} />
        </Field>
        <Field label={t("set.declined")}>
          <Switch on={prefs.showDeclined} onChange={(v) => set({ showDeclined: v })} label={t("set.declined")} />
        </Field>
      </div>
    </Modal>
  );
}

function ZoneAdd({ onAdd }: { onAdd: (z: string) => void }) {
  const c = useCal();
  const [k, setK] = useState(0);
  return (
    <span className="cal-zone-add" key={k}>
      <ZonePicker value="UTC" placeholder={c.t("set.addZone")} onChange={(z) => (onAdd(z), setK(k + 1))} t={c.t} now={c.now} compact />
    </span>
  );
}

function WeekdayToggles({ value, onChange }: { value: readonly number[]; onChange: (v: number[]) => void }) {
  const c = useCal();
  return (
    <div className="cal-wd-toggles" role="group">
      {Array.from({ length: 7 }, (_, i) => (c.weekStart + i) % 7).map((wd) => (
        <button key={wd} type="button" className="cal-wd" aria-pressed={value.includes(wd)} data-on={value.includes(wd) || undefined} title={weekdayName(wd, c.locale)} onClick={() => onChange(value.includes(wd) ? value.filter((x) => x !== wd) : [...value, wd])}>
          {weekdayName(wd, c.locale)}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ calendar settings

const ACCESS: WsAccess[] = ["none", "busy", "view", "edit"];

function CalendarDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const c = useCal();
  const { t } = c;
  const cal = id ? (c.boot.calendars.find((x) => x.id === id) ?? null) : null;
  const owner = !cal || cal.level === "owner";
  const [name, setName] = useState(cal?.name ?? "");
  const [color, setColor] = useState<string | null>(cal?.color ?? null);
  const [description, setDescription] = useState(cal?.description ?? "");
  const [tz, setTz] = useState(cal?.tz ?? c.prefs.tz);
  const [access, setAccess] = useState<WsAccess>(cal?.wsAccess ?? "busy");
  const [feed, setFeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (cal && owner && cal.hasFeed) void calApi<{ url: string | null }>(c.ws, `calendars/${cal.id}/feed`).then((r) => setFeed(r.url)).catch(() => null);
  }, [cal, owner, c.ws]);
  const save = async () => {
    setBusy(true);
    try {
      if (!cal) await calApi(c.ws, "calendars", { body: { name, color: color ?? undefined, description, tz, wsAccess: access } });
      else if (owner) await calApi(c.ws, `calendars/${cal.id}`, { method: "PATCH", body: { name, color: color ?? cal.color, description, tz, wsAccess: access } });
      else await calApi(c.ws, `calendars/${cal.id}`, { method: "PATCH", body: { viewColor: color } });
      await c.actions.reboot();
      c.actions.reload();
      toast(t("cal.saved"), { kind: "success" });
      onClose();
    } catch (e) {
      failed(t, e);
    } finally {
      setBusy(false);
    }
  };
  const share = async (userId: string, level: string | null) => {
    if (!cal) return;
    try {
      await calApi(c.ws, `calendars/${cal.id}/shares/${userId}`, level ? { method: "PUT", body: { level } } : { method: "DELETE" });
      await c.actions.reboot();
    } catch (e) {
      failed(t, e);
    }
  };
  const feedOp = async (method: "POST" | "DELETE") => {
    if (!cal) return;
    const r = await calApi<{ url: string | null }>(c.ws, `calendars/${cal.id}/feed`, { method, ...(method === "POST" ? { body: {} } : {}) }).catch(() => null);
    setFeed(r?.url ?? null);
    await c.actions.reboot();
  };
  const remove = async () => {
    if (!cal || !confirm(t("cal.deleteConfirm", { name: cal.name }))) return;
    try {
      await calApi(c.ws, `calendars/${cal.id}`, { method: "DELETE" });
      await c.actions.reboot();
      c.actions.reload();
      toast(t("cal.deleted"), { kind: "success" });
      onClose();
    } catch (e) {
      failed(t, e);
    }
  };
  const members = c.boot.members.filter((m) => m.id !== c.boot.me.id && !cal?.shares?.some((s) => s.userId === m.id));
  return (
    <Modal
      title={cal ? cal.name : t("cal.new")}
      onClose={onClose}
      wide
      footer={
        <>
          {cal && owner && !cal.isDefault && (
            <button type="button" className="cal-btn cal-btn-danger cal-foot-left" onClick={() => void remove()}>
              <Trash2 size={14} /> {t("cal.delete")}
            </button>
          )}
          <button type="button" className="cal-btn" onClick={onClose}>
            {t("c.cancel")}
          </button>
          <button type="button" className="cal-btn cal-btn-primary" disabled={busy || (owner && !name.trim())} onClick={() => void save()} data-testid="calendar-save">
            {t("c.save")}
          </button>
        </>
      }
    >
      <div className="cal-form">
        {owner ? (
          <>
            <Field label={t("cal.name")}>
              <input className="cal-input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus maxLength={120} />
            </Field>
            <Field label={t("cal.description")}>
              <input className="cal-input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
            </Field>
            <Field label={t("cal.tz")}>
              <ZonePicker value={tz} onChange={setTz} t={t} now={c.now} />
            </Field>
          </>
        ) : (
          <p className="cal-muted">{t("cal.sharedBy", { name: cal?.ownerName ?? "" })}</p>
        )}
        <Field label={t("cal.color")}>
          <ColorDots value={color} onChange={setColor} label={t("cal.color")} />
        </Field>
        {owner && (
          <Field label={t("cal.access")}>
            <select className="cal-select" value={access} onChange={(e) => setAccess(e.target.value as WsAccess)} data-testid="ws-access">
              {ACCESS.map((a) => (
                <option key={a} value={a} disabled={cal?.kind === "ics" && a === "edit"}>
                  {t(`acc.${a}`)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {cal && owner && (
          <div className="cal-subform">
            <h3>{t("cal.share")}</h3>
            {cal.shares?.map((s) => (
              <div key={s.userId} className="cal-share-row">
                <span className="cal-avatar">{s.name.charAt(0).toUpperCase()}</span>
                <span className="cal-grow">{s.name}</span>
                <select className="cal-select" value={s.level} onChange={(e) => void share(s.userId, e.target.value)}>
                  {(["busy", "view", "edit"] as const).filter((l) => cal.kind !== "ics" || l !== "edit").map((l) => (
                    <option key={l} value={l}>
                      {t(`acc.${l}`)}
                    </option>
                  ))}
                </select>
                <button type="button" className="cal-icon-btn" aria-label={t("cal.remove")} onClick={() => void share(s.userId, null)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            {members.length > 0 && (
              <select className="cal-select" value="" onChange={(e) => e.target.value && void share(e.target.value, "view")} aria-label={t("cal.shareWith")}>
                <option value="">{t("cal.shareWith")}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        {cal && owner && (
          <div className="cal-subform">
            <h3>{t("cal.feed")}</h3>
            <p className="cal-muted cal-small">{t("cal.feedHint")}</p>
            {feed ? (
              <>
                <div className="cal-copy-row">
                  <input className="cal-input" readOnly value={feed} aria-label={t("cal.feed")} data-testid="feed-url" onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" className="cal-icon-btn" aria-label={t("c.copy")} onClick={async () => (await copyText(feed)) && toast(t("cal.copied"), { kind: "success" })}>
                    <Copy size={14} />
                  </button>
                </div>
                <div className="cal-chips">
                  <button type="button" className="cal-btn cal-btn-sm" onClick={() => void feedOp("POST")}>
                    <RotateCw size={13} /> {t("cal.feedReset")}
                  </button>
                  <button type="button" className="cal-btn cal-btn-sm" onClick={() => void feedOp("DELETE")}>
                    {t("cal.feedOff")}
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="cal-btn cal-btn-sm" onClick={() => void feedOp("POST")} data-testid="feed-on">
                {t("cal.feedOn")}
              </button>
            )}
          </div>
        )}
        {cal && (
          <div className="cal-chips">
            <a className="cal-btn cal-btn-sm" href={`/api/calendar/calendars/${cal.id}/ics?ws=${encodeURIComponent(c.ws)}`} download data-testid="export-ics">
              <Download size={13} /> {t("cal.export")}
            </a>
            {!cal.readOnly && cal.kind === "local" && (
              <button type="button" className="cal-btn cal-btn-sm" onClick={() => c.actions.dialog({ kind: "import", calId: cal.id })}>
                {t("cal.import")}
              </button>
            )}
            {cal.sourceUrl && <span className="cal-muted cal-small cal-break">{cal.sourceUrl}</span>}
            {cal.syncError && <span className="cal-error cal-small">{t("cal.syncError", { error: cal.syncError })}</span>}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ subscribe / import

function SubscribeDialog({ onClose }: { onClose: () => void }) {
  const c = useCal();
  const { t } = c;
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      await calApi(c.ws, "subscriptions", { body: { url, name: name || undefined } });
      await c.actions.reboot();
      c.actions.reload();
      toast(t("cal.subscribed"), { kind: "success" });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : t("ev.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("cal.subscribe")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cal-btn" onClick={onClose}>
            {t("c.cancel")}
          </button>
          <button type="button" className="cal-btn cal-btn-primary" disabled={busy || !url.trim()} onClick={() => void go()}>
            {t("c.add")}
          </button>
        </>
      }
    >
      <div className="cal-form">
        <p className="cal-muted cal-small">{t("cal.subscribeHint")}</p>
        <Field label={t("cal.subscribeUrl")}>
          <input className="cal-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… .ics" inputMode="url" data-autofocus />
        </Field>
        <Field label={t("cal.name")}>
          <input className="cal-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        {err && <p className="cal-error">{err}</p>}
      </div>
    </Modal>
  );
}

function ImportDialog({ calId, onClose }: { calId?: string; onClose: () => void }) {
  const c = useCal();
  const { t } = c;
  const writable = c.boot.calendars.filter((x) => x.kind === "local" && !x.readOnly);
  const [into, setInto] = useState(calId ?? writable[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const go = async () => {
    const f = file.current?.files?.[0];
    if (!f || !into) return;
    setBusy(true);
    try {
      const r = await calApi<{ added: number; updated: number }>(c.ws, `calendars/${into}/import`, { raw: await f.text() });
      toast(t("cal.imported", { n: r.added + r.updated }), { kind: "success" });
      c.actions.reload();
      onClose();
    } catch (e) {
      failed(t, e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("cal.import")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cal-btn" onClick={onClose}>
            {t("c.cancel")}
          </button>
          <button type="button" className="cal-btn cal-btn-primary" disabled={busy} onClick={() => void go()} data-testid="import-go">
            {t("c.add")}
          </button>
        </>
      }
    >
      <div className="cal-form">
        <Field label={t("cal.importInto")}>
          <select className="cal-select" value={into} onChange={(e) => setInto(e.target.value)}>
            {writable.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <input ref={file} type="file" accept=".ics,text/calendar" className="cal-file" data-testid="import-file" />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ CalDAV

function CalDavDialog({ onClose }: { onClose: () => void }) {
  const c = useCal();
  const { t } = c;
  const [server, setServer] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [account, setAccount] = useState<{ id: string; calendars: { href: string; name: string; color: string }[] } | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; label: string; username: string; calendars: number }[]>([]);
  useEffect(() => {
    void calApi<{ accounts: typeof accounts }>(c.ws, "caldav/accounts").then((r) => setAccounts(r.accounts)).catch(() => null);
  }, [c.ws]);
  const connect = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await calApi<{ accountId: string; calendars: { href: string; name: string; color: string }[] }>(c.ws, "caldav/accounts", { body: { serverUrl: server, username: user, password: pass } });
      setPass("");
      setAccount({ id: r.accountId, calendars: r.calendars });
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : t("ev.failed"));
    } finally {
      setBusy(false);
    }
  };
  const link = async (href: string, name: string, color: string) => {
    if (!account) return;
    setBusy(true);
    try {
      await calApi(c.ws, `caldav/accounts/${account.id}/link`, { body: { href, name, color: color || undefined } });
      setAccount({ ...account, calendars: account.calendars.filter((x) => x.href !== href) });
      await c.actions.reboot();
      c.actions.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : t("ev.failed"));
    } finally {
      setBusy(false);
    }
  };
  const providers = c.boot.providers.filter((p) => p.id === "google" || p.id === "microsoft");
  return (
    <Modal title={t("cal.caldav")} onClose={onClose} wide>
      <div className="cal-form">
        <p className="cal-muted cal-small">{t("cal.caldavHint")}</p>
        {!account ? (
          <>
            <Field label={t("cal.server")}>
              <input className="cal-input" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://caldav.icloud.com" inputMode="url" data-autofocus />
            </Field>
            <Field label={t("cal.username")}>
              <input className="cal-input" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" />
            </Field>
            <Field label={t("cal.password")}>
              <input className="cal-input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
            </Field>
            <div>
              <button type="button" className="cal-btn cal-btn-primary" disabled={busy || !server || !user || !pass} onClick={() => void connect()}>
                {busy ? t("cal.syncing") : t("cal.connect")}
              </button>
            </div>
          </>
        ) : (
          <div className="cal-subform">
            <h3>{t("cal.pickRemote")}</h3>
            {account.calendars.map((r) => (
              <div key={r.href} className="cal-share-row">
                <span className="cal-dot" style={{ background: r.color || "#828282" }} />
                <span className="cal-grow">{r.name}</span>
                <button type="button" className="cal-btn cal-btn-sm" disabled={busy} onClick={() => void link(r.href, r.name, r.color)}>
                  {t("cal.syncThis")}
                </button>
              </div>
            ))}
          </div>
        )}
        {err && <p className="cal-error">{err}</p>}
        {accounts.length > 0 && (
          <div className="cal-subform">
            {accounts.map((a) => (
              <div key={a.id} className="cal-share-row">
                <span className="cal-grow">
                  {a.label} · {a.username}
                </span>
                <button
                  type="button"
                  className="cal-icon-btn"
                  aria-label={t("cal.remove")}
                  onClick={async () => {
                    await calApi(c.ws, `caldav/accounts/${a.id}`, { method: "DELETE" }).catch(() => null);
                    setAccounts(accounts.filter((x) => x.id !== a.id));
                    await c.actions.reboot();
                    c.actions.reload();
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {providers.some((p) => !p.available) && <p className="cal-muted cal-small">{t("cal.oauthLater")}</p>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ layers

function LayerDialog({ onClose }: { onClose: () => void }) {
  const c = useCal();
  const { t } = c;
  const [dbs, setDbs] = useState<{ id: string; title: string; icon: string; props: { id: string; name: string }[] }[] | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [db, setDb] = useState("");
  const [prop, setProp] = useState("");
  const [project, setProject] = useState("");
  useEffect(() => {
    void calApi<{ databases: NonNullable<typeof dbs> }>(c.ws, "docs/databases").then((r) => {
      setDbs(r.databases);
      if (r.databases[0]) {
        setDb(r.databases[0].id);
        setProp(r.databases[0].props[0].id);
      }
    });
    void calApi<{ projects: { id: string; name: string }[] }>(c.ws, "projects/options").then((r) => setProjects(r.projects)).catch(() => null);
  }, [c.ws]);
  const add = async (body: Record<string, unknown>) => {
    try {
      await calApi<{ layers: LayerInfo[] }>(c.ws, "layers", { body });
      await c.actions.reboot();
      c.actions.reload();
      onClose();
    } catch (e) {
      failed(t, e);
    }
  };
  const cur = dbs?.find((d) => d.id === db);
  return (
    <Modal title={t("rail.layers")} onClose={onClose}>
      <div className="cal-form">
        <div className="cal-subform">
          <h3>{t("lay.addDocs")}</h3>
          {dbs && !dbs.length && <p className="cal-muted">{t("lay.noDbs")}</p>}
          {dbs && dbs.length > 0 && (
            <>
              <Field label={t("lay.pickDb")}>
                <select
                  className="cal-select"
                  value={db}
                  data-testid="layer-db"
                  onChange={(e) => {
                    setDb(e.target.value);
                    setProp(dbs.find((d) => d.id === e.target.value)?.props[0]?.id ?? "");
                  }}
                >
                  {dbs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.icon ? `${d.icon} ` : ""}
                      {d.title || t("ev.untitled")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("lay.dateProp")}>
                <select className="cal-select" value={prop} onChange={(e) => setProp(e.target.value)}>
                  {cur?.props.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button type="button" className="cal-btn cal-btn-primary" onClick={() => void add({ kind: "docs", ref: db, prop })} data-testid="layer-add">
                {t("c.add")}
              </button>
            </>
          )}
        </div>
        <div className="cal-subform">
          <h3>{t("lay.addIssues")}</h3>
          <div className="cal-chips">
            <button type="button" className="cal-btn cal-btn-sm" onClick={() => void add({ kind: "issues", ref: "mine" })}>
              {t("lay.myIssues")}
            </button>
            <button type="button" className="cal-btn cal-btn-sm" onClick={() => void add({ kind: "cycles", ref: "all" })}>
              {t("lay.addCycles")}
            </button>
          </div>
          {projects.length > 0 && (
            <Field label={t("lay.addProject")}>
              <span className="cal-inline">
                <select className="cal-select" value={project} onChange={(e) => setProject(e.target.value)}>
                  <option value="">—</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="cal-btn cal-btn-sm" disabled={!project} onClick={() => void add({ kind: "issues", ref: project })}>
                  {t("c.add")}
                </button>
              </span>
            </Field>
          )}
          <p className="cal-muted cal-small">{t("lay.readOnly")}</p>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ scheduling links

const LINK_DURATIONS = [15, 20, 30, 45, 60, 90, 120];
const NOTICES = [0, 60, 120, 240, 720, 1440, 2880];
const WINDOWS = [7, 14, 30, 60, 90];
const BUFFERS = [0, 5, 10, 15, 30];

function LinkDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const c = useCal();
  const { t, locale } = c;
  const cur = id ? (c.boot.links.find((l) => l.id === id) ?? null) : null;
  const own = c.boot.calendars.filter((x) => x.level === "owner");
  const [l, setL] = useState<Omit<LinkInfo, "id" | "url" | "bookings" | "slug"> & { slug: string }>(
    cur ?? {
      slug: "",
      title: t("link.defaultTitle", { name: c.boot.me.name }),
      description: "",
      duration: 30,
      step: 30,
      bufferBefore: 0,
      bufferAfter: 0,
      noticeMin: 240,
      windowDays: 30,
      maxPerDay: 0,
      weekly: { 0: [], 1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]], 4: [[540, 1020]], 5: [[540, 1020]], 6: [] },
      tz: c.prefs.tz,
      calId: own.find((x) => x.isDefault)?.id ?? own[0]?.id ?? "",
      checkCals: [],
      location: "",
      conference: "",
      color: "",
      active: true,
    }
  );
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof l>) => setL({ ...l, ...p });
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...l, ...(cur && l.slug === cur.slug ? { slug: undefined } : l.slug ? {} : { slug: undefined }) };
      const r = await calApi<{ link: LinkInfo }>(c.ws, id ? `links/${id}` : "links", { method: id ? "PATCH" : "POST", body });
      await c.actions.reboot();
      toast(t("link.saved"), { kind: "success", action: { label: t("link.copy"), run: () => void copyText(r.link.url) } });
      if (!id) await copyText(r.link.url);
      onClose();
    } catch (e) {
      toast(e instanceof ApiError && e.code === "slug taken" ? e.code : t("ev.failed"), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!id) return;
    await calApi(c.ws, `links/${id}`, { method: "DELETE" }).catch(() => null);
    await c.actions.reboot();
    onClose();
  };
  const wdName = (wd: number) => weekdayName(wd, locale);
  return (
    <Modal
      title={cur ? t("link.edit") : t("link.new")}
      onClose={onClose}
      wide
      footer={
        <>
          {cur && (
            <button type="button" className="cal-btn cal-btn-danger cal-foot-left" onClick={() => void remove()}>
              <Trash2 size={14} /> {t("link.delete")}
            </button>
          )}
          {cur && (
            <a className="cal-btn" href={cur.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} /> {t("link.open")}
            </a>
          )}
          <button type="button" className="cal-btn cal-btn-primary" disabled={busy || !l.title.trim()} onClick={() => void save()} data-testid="link-save">
            {t("c.save")}
          </button>
        </>
      }
    >
      <div className="cal-form">
        {!c.boot.mailOn && (
          <p className="cal-small cal-muted" role="note">
            {t("link.noMailHint")}
          </p>
        )}
        <Field label={t("link.titleField")}>
          <input className="cal-input" value={l.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} data-autofocus />
        </Field>
        {cur && (
          <Field label={t("link.slug")}>
            <span className="cal-copy-row">
              <span className="cal-muted cal-small">/cal/</span>
              <input className="cal-input" value={l.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} maxLength={48} />
              <button type="button" className="cal-icon-btn" aria-label={t("link.copy")} onClick={async () => (await copyText(cur.url)) && toast(t("link.copied"), { kind: "success" })}>
                <Copy size={14} />
              </button>
            </span>
          </Field>
        )}
        <Field label={t("link.description")}>
          <input className="cal-input" value={l.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} />
        </Field>
        <Field label={t("link.duration")}>
          <select className="cal-select" value={l.duration} onChange={(e) => set({ duration: Number(e.target.value), step: Math.min(Number(e.target.value), 30) })} data-testid="link-duration">
            {LINK_DURATIONS.map((m) => (
              <option key={m} value={m}>
                {t("link.minutes", { n: m })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("link.step")}>
          <select className="cal-select" value={l.step} onChange={(e) => set({ step: Number(e.target.value) })}>
            {[15, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {t("link.minutes", { n: m })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("link.bufferBefore")}>
          <select className="cal-select" value={l.bufferBefore} onChange={(e) => set({ bufferBefore: Number(e.target.value) })}>
            {BUFFERS.map((m) => (
              <option key={m} value={m}>
                {t("link.minutes", { n: m })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("link.bufferAfter")}>
          <select className="cal-select" value={l.bufferAfter} onChange={(e) => set({ bufferAfter: Number(e.target.value) })}>
            {BUFFERS.map((m) => (
              <option key={m} value={m}>
                {t("link.minutes", { n: m })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("link.notice")}>
          <select className="cal-select" value={l.noticeMin} onChange={(e) => set({ noticeMin: Number(e.target.value) })} data-testid="link-notice">
            {NOTICES.map((m) => (
              <option key={m} value={m}>
                {m < 60 ? t("link.minutes", { n: m }) : t("link.hours", { n: m / 60 })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("link.window")}>
          <select className="cal-select" value={l.windowDays} onChange={(e) => set({ windowDays: Number(e.target.value) })}>
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {t("link.days", { n: d })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("link.maxPerDay")}>
          <select className="cal-select" value={l.maxPerDay} onChange={(e) => set({ maxPerDay: Number(e.target.value) })}>
            {[0, 1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t("link.unlimited") : n}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("cal.tz")}>
          <ZonePicker value={l.tz} onChange={(z) => set({ tz: z })} t={t} now={c.now} />
        </Field>
        <div className="cal-subform">
          <h3>{t("link.availability")}</h3>
          {Array.from({ length: 7 }, (_, i) => (c.weekStart + i) % 7).map((wd) => {
            const ranges = l.weekly[wd] ?? [];
            const setRanges = (r: [number, number][]) => set({ weekly: { ...l.weekly, [wd]: r } });
            return (
              <div key={wd} className="cal-hours-row">
                <label className="cal-inline cal-hours-day">
                  <input type="checkbox" checked={ranges.length > 0} onChange={(e) => setRanges(e.target.checked ? [[540, 1020]] : [])} />
                  {wdName(wd)}
                </label>
                <div className="cal-hours-ranges">
                  {ranges.length === 0 && <span className="cal-muted">{t("link.unavailable")}</span>}
                  {ranges.map(([a, b], i) => (
                    <span key={i} className="cal-inline">
                      <TimeField minute={a} onChange={(m) => setRanges(ranges.map((x, j) => (j === i ? [m, Math.max(m + 15, x[1])] : x)))} locale={locale} h12={c.h12} label={t("link.availability")} />
                      –
                      <TimeField minute={b} from={a} onChange={(m) => setRanges(ranges.map((x, j) => (j === i ? [x[0], Math.min(1440, m)] : x)))} locale={locale} h12={c.h12} label={t("link.availability")} />
                      <button type="button" className="cal-icon-btn" aria-label={t("c.remove")} onClick={() => setRanges(ranges.filter((_, j) => j !== i))}>
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                  {ranges.length > 0 && ranges.length < 4 && (
                    <button type="button" className="cal-icon-btn" aria-label={t("link.addRange")} onClick={() => setRanges([...ranges, [Math.min(1380, (ranges[ranges.length - 1]?.[1] ?? 1020) + 60), Math.min(1440, (ranges[ranges.length - 1]?.[1] ?? 1020) + 120)]])}>
                      <Plus size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <Field label={t("link.bookInto")}>
          <select className="cal-select" value={l.calId} onChange={(e) => set({ calId: e.target.value })}>
            {own.filter((x) => x.kind !== "ics").map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("link.checkCals")}>
          <div className="cal-checks">
            {own.map((x) => (
              <label key={x.id} className="cal-inline">
                <input type="checkbox" checked={l.checkCals.length === 0 || l.checkCals.includes(x.id)} onChange={(e) => set({ checkCals: e.target.checked ? [...new Set([...(l.checkCals.length ? l.checkCals : own.map((o) => o.id)), x.id])] : (l.checkCals.length ? l.checkCals : own.map((o) => o.id)).filter((y) => y !== x.id) })} />
                {x.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("link.location")}>
          <input className="cal-input" value={l.conference || l.location} placeholder={t("ev.addConference")} onChange={(e) => (/^https:\/\//i.test(e.target.value) ? set({ conference: e.target.value, location: "" }) : set({ location: e.target.value, conference: "" }))} />
        </Field>
        <Field label={t("link.active")}>
          <Switch on={l.active} onChange={(v) => set({ active: v })} label={t("link.active")} />
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ the rest

const SHORTCUTS: [string[], Parameters<CT>[0]][] = [
  [["T"], "key.today"],
  [["J"], "key.next"],
  [["K"], "key.prev"],
  [["D"], "key.day"],
  [["W"], "key.week"],
  [["M"], "key.month"],
  [["A"], "key.agenda"],
  [["1", "…", "7"], "key.days"],
  [["C"], "key.create"],
  [["G"], "key.goto"],
  [["/"], "key.search"],
  [["⌘", "K"], "key.menu"],
  [["Enter"], "key.open"],
  [["⌘", "D"], "key.duplicate"],
  [["⌫"], "key.delete"],
  [["⌘", "Z"], "key.undo"],
  [["⌘", "J"], "key.join"],
  [["Z"], "key.zones"],
  [[","], "key.settings"],
  [["Esc"], "key.close"],
  [["?"], "key.help"],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useCal();
  return (
    <Modal title={t("nav.shortcuts")} onClose={onClose}>
      <ul className="cal-keys">
        {SHORTCUTS.map(([keys, label]) => (
          <li key={label}>
            <span>{t(label)}</span>
            <Kbd keys={keys} />
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function ZonesDialog({ onClose }: { onClose: () => void }) {
  const c = useCal();
  const { t, locale, prefs } = c;
  const [day, setDay] = useState(c.today);
  const [minute, setMinute] = useState(Math.ceil(minuteOfDay(c.now, c.tz) / 30) * 30 % 1440);
  const [extra, setExtra] = useState<string[]>([]);
  const at = atMinute(day, minute, c.tz);
  const zones = useMemo(() => [...new Set([c.tz, ...prefs.zones, ...extra])], [c.tz, prefs.zones, extra]);
  return (
    <Modal title={t("conv.title")} onClose={onClose} wide>
      <p className="cal-muted cal-small">{t("conv.hint")}</p>
      <div className="cal-inline cal-conv-pick">
        <DateField value={day} onChange={setDay} locale={locale} tz={c.tz} now={c.now} weekStart={c.weekStart} t={t} label={t("ev.when")} />
        <TimeField minute={minute} onChange={(m) => setMinute(m % 1440)} locale={locale} h12={c.h12} label={t("ev.when")} />
        <span className="cal-muted">{zoneCity(c.tz)}</span>
      </div>
      <ul className="cal-conv">
        {zones.map((z) => (
          <li key={z}>
            <span className="cal-conv-city">{zoneCity(z)}</span>
            <span className="cal-muted cal-small">{offsetLabel(at, z)}</span>
            <span className="cal-conv-time">{fmtTime(at, z, locale, c.h12, false)}</span>
            <span className="cal-muted cal-small">{fmtDate(dayOf(at, z), locale)}</span>
            {z !== c.tz && !prefs.zones.includes(z) && prefs.zones.length < 4 && (
              <button type="button" className="cal-btn cal-btn-sm" onClick={() => void c.actions.savePrefs({ zones: [...prefs.zones, z] })}>
                {t("set.addZone")}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="cal-inline">
        <ZonePicker value="UTC" placeholder={t("conv.add")} onChange={(z) => setExtra([...extra, z])} t={t} now={c.now} compact />
      </div>
      <p className="cal-muted cal-small">
        {fmtDateLong(day, locale)} · {fmtMinute(minute, locale, c.h12, false)}
      </p>
    </Modal>
  );
}

function GotoDialog({ onClose }: { onClose: () => void }) {
  const c = useCal();
  const { t } = c;
  const [q, setQ] = useState("");
  const day = q.trim() ? parseJump(q, c.locale, c.now, c.tz) : null;
  return (
    <Modal title={t("nav.goto")} onClose={onClose}>
      <input
        className="cal-input"
        autoFocus
        value={q}
        placeholder={t("nav.gotoHint")}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && day) {
            window.dispatchEvent(new CustomEvent("zvena:cal-goto", { detail: day }));
            onClose();
          }
        }}
        data-testid="goto-input"
      />
      <p className="cal-muted cal-small">{day ? fmtDateLong(day, c.locale) : " "}</p>
    </Modal>
  );
}


// ------------------------------------------------------------ share availability

/**
 * Notion Calendar's "Share availability": the free times of the next days,
 * within working hours, as text to paste in a message, with a scheduling
 * link when there is one. Busy times are the person's own (free/busy).
 */
function AvailabilityDialog({ onClose }: { onClose: () => void }) {
  const c = useCal();
  const { t, prefs, tz, locale, h12, boot } = c;
  const [days, setDays] = useState(5);
  const [min, setMin] = useState(Math.max(30, prefs.defaultDuration));
  const [link, setLink] = useState(boot.links[0]?.id ?? "");
  const [busy, setBusy] = useState<{ start: number; end: number }[] | null>(null);
  // Memoized: a fresh fallback array on every render would recompute dayList, and
  // the free/busy fetch below that depends on it would run again after every answer.
  const work = useMemo(() => (prefs.workDays.length ? prefs.workDays : [1, 2, 3, 4, 5]), [prefs.workDays]);
  // The next `days` working days, today first (its past hours left out).
  const dayList = useMemo(() => {
    const out: string[] = [];
    for (let d = c.today, i = 0; out.length < days && i < 31; d = addDays(d, 1), i++) {
      const p = parseDay(d);
      if (work.includes(new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay())) out.push(d);
    }
    return out;
  }, [c.today, days, work]);
  useEffect(() => {
    if (!dayList.length) return;
    const from = atMinute(dayList[0], 0, tz);
    const to = atMinute(addDays(dayList[dayList.length - 1], 1), 0, tz);
    let live = true;
    void calApi<{ users: { busy: { start: number; end: number; allDay: boolean; startDay: string; endDay: string }[] }[] }>(c.ws, "freebusy", { query: { from, to, users: boot.me.id, tz } })
      .then((r) => live && setBusy((r.users[0]?.busy ?? []).map((b) => (b.allDay ? { start: atMinute(b.startDay, 0, tz), end: atMinute(b.endDay, 0, tz) } : { start: b.start, end: b.end }))))
      .catch(() => live && setBusy([]));
    return () => {
      live = false;
    };
  }, [c.ws, dayList, tz, boot.me.id]);
  const slots = useMemo(() => {
    if (!busy) return null;
    return dayList.map((day) => {
      let from = atMinute(day, prefs.workStart, tz);
      const end = atMinute(day, prefs.workEnd, tz);
      if (day === c.today) from = Math.max(from, Math.ceil(c.now / 1_800_000) * 1_800_000);
      const free: [number, number][] = [];
      let at = from;
      for (const b of [...busy].filter((x) => x.end > from && x.start < end).sort((x, y) => x.start - y.start)) {
        if (b.start > at) free.push([at, Math.min(b.start, end)]);
        at = Math.max(at, b.end);
      }
      if (at < end) free.push([at, end]);
      return { day, free: free.filter(([a, b]) => b - a >= min * 60_000) };
    });
  }, [busy, dayList, prefs.workStart, prefs.workEnd, tz, c.today, c.now, min]);
  const chosen = boot.links.find((l) => l.id === link);
  const text = slots
    ? [
        t("avail.lead"),
        ...slots.filter((s) => s.free.length).map((s) => `${fmtDate(s.day, locale)}: ${s.free.map(([a, b]) => `${fmtTime(a, tz, locale, h12)} – ${fmtTime(b, tz, locale, h12)}`).join(", ")}`),
        `(${zoneCity(tz)}, ${offsetLabel(c.now, tz)})`,
        ...(chosen ? ["", t("avail.book", { url: chosen.url })] : []),
      ].join("\n")
    : "";
  return (
    <Modal title={t("avail.title")} onClose={onClose} footer={<button type="button" className="cal-btn cal-btn-primary" disabled={!slots} onClick={() => (copyText(text), toast(t("avail.copied")), onClose())} data-testid="avail-copy"><Copy size={14} />{t("avail.copy")}</button>}>
      <div className="cal-form">
        <Field label={t("avail.days")}>
          <select className="cal-input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {t("avail.nDays", { n })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("avail.min")}>
          <select className="cal-input" value={min} onChange={(e) => setMin(Number(e.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((n) => (
              <option key={n} value={n}>
                {fmtDuration(n, locale)}
              </option>
            ))}
          </select>
        </Field>
        {boot.links.length > 0 && (
          <Field label={t("avail.link")}>
            <select className="cal-input" value={link} onChange={(e) => setLink(e.target.value)}>
              <option value="">{t("avail.noLink")}</option>
              {boot.links.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        <pre className="cal-avail" data-testid="avail-text">{slots ? text : t("avail.loading")}</pre>
      </div>
    </Modal>
  );
}
