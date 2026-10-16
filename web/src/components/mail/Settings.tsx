"use client";

// Mail's settings: mailboxes (name, signature, a new app password, sync now,
// disconnect), notifications per view, the views shown as tabs, snippets,
// undo send, images, the reading pane and density.

import { useState } from "react";
import { AlertCircle, ArrowLeft, Bell, CheckCircle2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Switch, toast } from "@/components/zvena/ds";
import type { MailAccount, MailPrefs, MailSnippet } from "@/lib/mail-client/types";
import type { SystemView } from "@/lib/mail-client/views";
import { api, getState, go, loadBoot, MailApiError, useMail } from "./data";
import { ConnectDialog } from "./Dialogs";
import { intlOf } from "@/i18n/locales";
import { fullDate } from "./format";
import { useMt } from "./i18n";
import { Dialog } from "./ui";

export function SettingsScreen() {
  const { t, locale } = useMt();
  const boot = useMail((s) => s.boot);
  const [connect, setConnect] = useState(false);
  const [edit, setEdit] = useState<MailAccount | null>(null);
  const [snippet, setSnippet] = useState<MailSnippet | "new" | null>(null);
  if (!boot) return null;
  const prefs = boot.prefs;
  const setPref = async (p: Partial<MailPrefs>) => {
    await api("prefs", { method: "PATCH", json: p }).catch(() => toast(t("err.generic"), { kind: "error" }));
    await loadBoot();
  };
  const notify = async (id: string, on: boolean) => {
    await api(`views/${encodeURIComponent(id)}`, { method: "PATCH", json: { notify: on } }).catch(() => toast(t("err.generic"), { kind: "error" }));
    await loadBoot();
  };
  const viewName = (v: { id: string; name: string; system: boolean }) => (v.system ? t(`view.${v.id as SystemView}`) : v.name);
  return (
    <div className="zm-settings">
      <header className="zm-settings-head">
        <button type="button" className="zm-icon-btn" onClick={() => go({ list: getState().route.list })} aria-label={t("back")}>
          <ArrowLeft size={16} />
        </button>
        <h1>{t("settings.title")}</h1>
      </header>

      <section className="zm-settings-section" aria-labelledby="zm-s-accounts">
        <h2 id="zm-s-accounts">{t("settings.accounts")}</h2>
        {boot.accounts.map((a) => (
          <div key={a.id} className="zm-account">
            <span className="zm-account-state" data-state={a.state}>
              {a.state === "ok" ? <CheckCircle2 size={16} /> : a.state === "auth" || a.state === "error" ? <AlertCircle size={16} /> : <RefreshCw size={16} />}
            </span>
            <span className="zm-account-main">
              <strong>{a.name ? `${a.name} <${a.email}>` : a.email}</strong>
              <span className="zm-hint-small">
                {a.state === "auth"
                  ? t("account.authFailed")
                  : a.state === "error"
                    ? t("account.error", { error: a.error ?? "" })
                    : a.state === "ok" && a.syncedAt
                      ? t("account.synced", { when: fullDate(a.syncedAt, locale) })
                      : t("account.syncing")}
              </span>
            </span>
            <button type="button" className="zv-btn zv-btn-sm" onClick={() => void api(`accounts/${a.id}/sync`, { method: "POST", json: {} }).then(() => toast(t("account.syncStarted")))}>
              {t("account.syncNow")}
            </button>
            <button type="button" className="zv-btn zv-btn-sm" onClick={() => setEdit(a)}>
              {t("account.edit")}
            </button>
          </div>
        ))}
        <button type="button" className="zv-btn" onClick={() => setConnect(true)}>
          <Plus size={14} /> {t("account.add")}
        </button>
      </section>

      <section className="zm-settings-section" aria-labelledby="zm-s-notify">
        <h2 id="zm-s-notify">{t("settings.notifications")}</h2>
        <p className="zm-hint">{t("settings.notificationsLead")}</p>
        {boot.views
          .filter((v) => v.id !== "trash" && v.id !== "spam" && v.id !== "sent" && v.id !== "drafts" && v.id !== "archive")
          .map((v) => (
            <label key={v.id} className="zm-toggle-row">
              <Bell size={14} />
              <span>{viewName(v)}</span>
              <Switch checked={v.notify} label={viewName(v)} onChange={(on) => void notify(v.id, on)} />
            </label>
          ))}
      </section>

      <section className="zm-settings-section" aria-labelledby="zm-s-tabs">
        <h2 id="zm-s-tabs">{t("settings.tabs")}</h2>
        <p className="zm-hint">{t("settings.tabsLead")}</p>
        {boot.views
          .filter((v) => v.id !== "trash" && v.id !== "spam")
          .map((v) => (
            <label key={v.id} className="zm-toggle-row">
              <span>{viewName(v)}</span>
              <Switch checked={prefs.tabs.includes(v.id)} label={viewName(v)} onChange={(on) => void setPref({ tabs: on ? [...prefs.tabs, v.id] : prefs.tabs.filter((x) => x !== v.id) })} />
            </label>
          ))}
      </section>

      <section className="zm-settings-section" aria-labelledby="zm-s-snippets">
        <h2 id="zm-s-snippets">{t("settings.snippets")}</h2>
        <p className="zm-hint">{t("settings.snippetsLead")}</p>
        {boot.snippets.map((s) => (
          <div key={s.id} className="zm-toggle-row">
            <span>{s.name}</span>
            <button type="button" className="zv-btn zv-btn-sm" onClick={() => setSnippet(s)}>
              {t("edit")}
            </button>
          </div>
        ))}
        <button type="button" className="zv-btn" onClick={() => setSnippet("new")}>
          <Plus size={14} /> {t("snippets.new")}
        </button>
      </section>

      <section className="zm-settings-section" aria-labelledby="zm-s-general">
        <h2 id="zm-s-general">{t("settings.general")}</h2>
        <label className="zm-toggle-row">
          <span>{t("settings.undo")}</span>
          <select className="zm-select" value={prefs.undoSeconds} onChange={(e) => void setPref({ undoSeconds: Number(e.target.value) })}>
            {[0, 5, 10, 20, 30].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t("settings.undoOff") : new Intl.NumberFormat(intlOf(locale), { style: "unit", unit: "second", unitDisplay: "long" }).format(n)}
              </option>
            ))}
          </select>
        </label>
        <label className="zm-toggle-row">
          <span>{t("settings.pane")}</span>
          <select className="zm-select" value={prefs.pane} onChange={(e) => void setPref({ pane: e.target.value as MailPrefs["pane"] })}>
            <option value="split">{t("settings.paneSplit")}</option>
            <option value="full">{t("settings.paneFull")}</option>
          </select>
        </label>
        <label className="zm-toggle-row">
          <span>{t("settings.density")}</span>
          <select className="zm-select" value={prefs.density} onChange={(e) => void setPref({ density: e.target.value as MailPrefs["density"] })}>
            <option value="compact">{t("settings.compact")}</option>
            <option value="comfortable">{t("settings.comfortable")}</option>
          </select>
        </label>
        <label className="zm-toggle-row">
          <span>
            {t("settings.images")}
            <span className="zm-hint-small">{t("settings.imagesHint")}</span>
          </span>
          <Switch checked={prefs.alwaysImages} label={t("settings.images")} onChange={(on) => void setPref({ alwaysImages: on })} />
        </label>
      </section>

      {connect && <ConnectDialog onClose={() => setConnect(false)} />}
      {edit && <AccountDialog account={edit} onClose={() => setEdit(null)} />}
      {snippet && <SnippetDialog snippet={snippet === "new" ? null : snippet} onClose={() => setSnippet(null)} />}
    </div>
  );
}

function AccountDialog({ account, onClose }: { account: MailAccount; onClose: () => void }) {
  const { t } = useMt();
  const [name, setName] = useState(account.name);
  const [signature, setSignature] = useState(() => account.signature.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const save = async () => {
    setBusy(true);
    try {
      await api(`accounts/${account.id}`, { method: "PATCH", json: { name, signature: esc(signature).replace(/\n/g, "<br>"), ...(password ? { password } : {}) } });
      await loadBoot();
      onClose();
      toast(t("saved"));
    } catch (e) {
      toast(e instanceof MailApiError && e.code.endsWith(":auth") ? t("connect.err.auth") : t("err.generic"), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api(`accounts/${account.id}`, { method: "DELETE" }).catch(() => undefined);
    await loadBoot();
    onClose();
    toast(t("account.removed", { email: account.email }));
  };
  return (
    <Dialog
      title={account.email}
      onClose={onClose}
      footer={
        <>
          {confirm ? (
            <button type="button" className="zv-btn zv-btn-danger" onClick={() => void remove()}>
              <Trash2 size={14} /> {t("account.removeConfirm")}
            </button>
          ) : (
            <button type="button" className="zv-btn zv-btn-danger" onClick={() => setConfirm(true)}>
              {t("account.remove")}
            </button>
          )}
          <span className="zm-bar-fill" />
          <button type="button" className="zv-btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="button" className="zv-btn zv-btn-primary" disabled={busy} onClick={() => void save()}>
            {t("save")}
          </button>
        </>
      }
    >
      {confirm && <p className="zm-error">{t("account.removeHint")}</p>}
      <label className="zm-field">
        <span>{t("connect.name")}</span>
        <input className="zv-input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="zm-field">
        <span>{t("account.signature")}</span>
        <textarea className="zv-input zm-textarea" rows={4} value={signature} onChange={(e) => setSignature(e.target.value)} />
      </label>
      <label className="zm-field">
        <span>{t("account.newPassword")}</span>
        <input className="zv-input" type="password" autoComplete="off" value={password} placeholder={t("account.newPasswordHint")} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <p className="zm-hint zm-hint-small">
        {t("account.servers", { imap: `${account.imap.host}:${account.imap.port}`, smtp: `${account.smtp.host}:${account.smtp.port}` })}
      </p>
    </Dialog>
  );
}

function SnippetDialog({ snippet, onClose }: { snippet: MailSnippet | null; onClose: () => void }) {
  const { t } = useMt();
  const [name, setName] = useState(snippet?.name ?? "");
  const [text, setText] = useState(() => (snippet?.html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const save = async () => {
    const html = text
      .split(/\n{2,}/)
      .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
    try {
      if (snippet) await api(`snippets/${snippet.id}`, { method: "PATCH", json: { name, html } });
      else await api("snippets", { method: "POST", json: { name, html } });
      await loadBoot();
      onClose();
    } catch {
      toast(t("err.generic"), { kind: "error" });
    }
  };
  const remove = async () => {
    if (snippet) await api(`snippets/${snippet.id}`, { method: "DELETE" }).catch(() => undefined);
    await loadBoot();
    onClose();
  };
  return (
    <Dialog
      title={snippet ? t("snippets.edit") : t("snippets.new")}
      onClose={onClose}
      footer={
        <>
          {snippet && (
            <button type="button" className="zv-btn zv-btn-danger" onClick={() => void remove()}>
              {t("delete")}
            </button>
          )}
          <span className="zm-bar-fill" />
          <button type="button" className="zv-btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="button" className="zv-btn zv-btn-primary" disabled={!name.trim()} onClick={() => void save()}>
            {t("save")}
          </button>
        </>
      }
    >
      <label className="zm-field">
        <span>{t("snippets.name")}</span>
        <input className="zv-input" value={name} autoFocus placeholder={t("snippets.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="zm-field">
        <span>{t("snippets.text")}</span>
        <textarea className="zv-input zm-textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
    </Dialog>
  );
}
