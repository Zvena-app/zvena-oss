"use client";

// Mail's dialogs: a view (Notion Mail's filters), connecting a mailbox,
// saving a conversation to Documents, turning it into a Projects issue.

import { useEffect, useState } from "react";
import { ExternalLink, FileText, Lock } from "lucide-react";
import { eco } from "@/components/eco/client";
import { toast, Switch } from "@/components/zvena/ds";
import { PRESETS, presetForEmail, type MailPreset, type PresetId } from "@/lib/mail-client/providers";
import type { MailAccount, MailThread, MailView } from "@/lib/mail-client/types";
import type { Box, ViewFilter } from "@/lib/mail-client/views";
import { api, go, loadBoot, MailApiError, refreshAll, useMail } from "./data";
import { useMt } from "./i18n";
import { Dialog } from "./ui";
import type { MailKey } from "@/lib/mail-client/strings";

// --- Views -------------------------------------------------------------------------

export function ViewDialog({ id, onClose }: { id?: string; onClose: () => void }) {
  const { t } = useMt();
  const boot = useMail((s) => s.boot);
  const existing = id ? boot?.views.find((v) => v.id === id && !v.system) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [icon, setIcon] = useState(existing?.icon ?? "");
  const [f, setF] = useState<ViewFilter>(existing?.filter ?? { box: "inbox" });
  const [notify, setNotify] = useState(existing?.notify ?? false);
  const [tab, setTab] = useState(existing ? (boot?.prefs.tabs ?? []).includes(existing.id) : true);
  const [busy, setBusy] = useState(false);
  if (!boot) return null;
  const set = (patch: Partial<ViewFilter>) => setF((x) => ({ ...x, ...patch }));
  const text = (k: "from" | "to" | "subject" | "text", label: string, placeholder: string) => (
    <label className="zm-field">
      <span>{label}</span>
      <input className="zv-input" value={f[k] ?? ""} placeholder={placeholder} onChange={(e) => set({ [k]: e.target.value || undefined })} />
    </label>
  );
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      let viewId = existing?.id;
      if (existing) await api(`views/${existing.id}`, { method: "PATCH", json: { name, icon, filter: f, notify } });
      else viewId = (await api<{ view: MailView }>("views", { method: "POST", json: { name, icon, filter: f, notify } })).view.id;
      const tabs = (boot.prefs.tabs ?? []).filter((x) => x !== viewId);
      await api("prefs", { method: "PATCH", json: { tabs: tab && viewId ? [...tabs, viewId] : tabs } });
      await loadBoot();
      onClose();
      if (viewId) go({ list: { view: viewId } });
    } catch {
      toast(t("err.generic"), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!existing) return;
    await api(`views/${existing.id}`, { method: "DELETE" }).catch(() => undefined);
    await api("prefs", { method: "PATCH", json: { tabs: boot.prefs.tabs.filter((x) => x !== existing.id) } }).catch(() => undefined);
    await loadBoot();
    onClose();
    go({ list: { view: "inbox" } });
  };
  const boxes: { id: Box; label: MailKey }[] = [
    { id: "inbox", label: "view.inbox" },
    { id: "any", label: "viewEdit.everywhere" },
    { id: "archive", label: "view.archive" },
    { id: "sent", label: "view.sent" },
  ];
  return (
    <Dialog
      title={existing ? t("view.edit") : t("view.new")}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <button type="button" className="zv-btn zv-btn-danger" onClick={() => void remove()}>
              {t("view.delete")}
            </button>
          )}
          <span className="zm-bar-fill" />
          <button type="button" className="zv-btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="button" className="zv-btn zv-btn-primary" disabled={!name.trim() || busy} onClick={() => void save()}>
            {existing ? t("save") : t("view.create")}
          </button>
        </>
      }
    >
      <p className="zm-hint">{t("viewEdit.lead")}</p>
      <div className="zm-field-row">
        <label className="zm-field zm-field-icon">
          <span>{t("viewEdit.icon")}</span>
          <input className="zv-input" value={icon} maxLength={4} placeholder="📌" onChange={(e) => setIcon(e.target.value)} />
        </label>
        <label className="zm-field" style={{ flex: 1 }}>
          <span>{t("viewEdit.name")}</span>
          <input className="zv-input" value={name} autoFocus placeholder={t("viewEdit.namePlaceholder")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        </label>
      </div>
      <label className="zm-field">
        <span>{t("viewEdit.where")}</span>
        <select className="zm-select" value={f.box ?? "inbox"} onChange={(e) => set({ box: e.target.value as Box })}>
          {boxes.map((b) => (
            <option key={b.id} value={b.id}>
              {t(b.label)}
            </option>
          ))}
        </select>
      </label>
      {text("from", t("viewEdit.from"), t("viewEdit.fromPlaceholder"))}
      {text("to", t("viewEdit.to"), t("viewEdit.toPlaceholder"))}
      {text("subject", t("viewEdit.subject"), "")}
      {text("text", t("viewEdit.words"), "")}
      <div className="zm-field-row">
        <label className="zm-field" style={{ flex: 1 }}>
          <span>{t("viewEdit.label")}</span>
          <select className="zm-select" value={f.labels?.[0] ?? ""} onChange={(e) => set({ labels: e.target.value ? [e.target.value] : undefined })}>
            <option value="">{t("viewEdit.anyLabel")}</option>
            {boot.labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {boot.accounts.length > 1 && (
          <label className="zm-field" style={{ flex: 1 }}>
            <span>{t("viewEdit.account")}</span>
            <select className="zm-select" value={f.account ?? ""} onChange={(e) => set({ account: e.target.value || undefined })}>
              <option value="">{t("viewEdit.allAccounts")}</option>
              {boot.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="zm-checks">
        <label>
          <Switch checked={f.unread === true} label={t("viewEdit.unread")} onChange={(on) => set({ unread: on || undefined })} /> {t("viewEdit.unread")}
        </label>
        <label>
          <Switch checked={f.starred === true} label={t("viewEdit.starred")} onChange={(on) => set({ starred: on || undefined })} /> {t("viewEdit.starred")}
        </label>
        <label>
          <Switch checked={f.attachment === true} label={t("viewEdit.attachment")} onChange={(on) => set({ attachment: on || undefined })} /> {t("viewEdit.attachment")}
        </label>
      </div>
      <div className="zm-checks">
        <label>
          <Switch checked={tab} label={t("viewEdit.tab")} onChange={setTab} /> {t("viewEdit.tab")}
        </label>
        <label>
          <Switch checked={notify} label={t("viewEdit.notify")} onChange={setNotify} /> {t("viewEdit.notify")}
        </label>
      </div>
    </Dialog>
  );
}

// --- Connecting a mailbox ------------------------------------------------------------

const ERRORS: Record<string, MailKey> = {
  "imap:auth": "connect.err.auth",
  "smtp:auth": "connect.err.smtpAuth",
  "imap:unresolved": "connect.err.host",
  "smtp:unresolved": "connect.err.host",
  "imap:unreachable": "connect.err.unreachable",
  "smtp:unreachable": "connect.err.unreachable",
  "imap:timeout": "connect.err.unreachable",
  "smtp:timeout": "connect.err.unreachable",
  "imap:certificate": "connect.err.certificate",
  "smtp:certificate": "connect.err.certificate",
  "imap:blocked address": "connect.err.blocked",
  "smtp:blocked address": "connect.err.blocked",
  "blocked address": "connect.err.blocked",
  "bad host": "connect.err.host",
  "bad port": "connect.err.port",
  insecure: "connect.err.insecure",
  "bad email": "connect.err.email",
  "already connected": "connect.err.already",
  "too many accounts": "connect.err.tooMany",
  "password required": "connect.err.password",
};

export function ConnectDialog({ onClose, initial }: { onClose: () => void; initial?: PresetId }) {
  const { t } = useMt();
  const [preset, setPreset] = useState<MailPreset | null>(initial ? (PRESETS.find((p) => p.id === initial) ?? null) : null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [imap, setImap] = useState({ host: "", port: 993, security: "tls" });
  const [smtp, setSmtp] = useState({ host: "", port: 465, security: "tls" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const custom = preset?.id === "custom";
  const connect = async () => {
    if (busy || !preset) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ account: MailAccount }>("accounts", { method: "POST", json: { preset: preset.id, email, name, password, ...(custom ? { imap, smtp, username: username || undefined } : {}) } });
      toast(t("connect.done", { email: r.account.email }), { kind: "success" });
      await loadBoot();
      onClose();
      go({ list: { view: "inbox" } });
      setTimeout(refreshAll, 2500);
    } catch (e) {
      const code = e instanceof MailApiError ? e.code : "";
      setError(t(ERRORS[code] ?? (e instanceof MailApiError && e.status === 429 ? "connect.err.rate" : "connect.err.generic")));
    } finally {
      setBusy(false);
    }
  };
  if (!preset) {
    return (
      <Dialog title={t("connect.title")} onClose={onClose} width={560}>
        <p className="zm-hint">{t("connect.lead")}</p>
        <div className="zm-providers">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="zm-provider" onClick={() => setPreset(p)}>
              <span className="zm-provider-mark" data-provider={p.id} aria-hidden>
                {p.id === "custom" ? "@" : p.name.charAt(0)}
              </span>
              <span>{p.id === "custom" ? t("connect.other") : p.name}</span>
            </button>
          ))}
        </div>
        <p className="zm-hint zm-hint-small">
          <Lock size={12} /> {t("connect.privacy")}
        </p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={custom ? t("connect.other") : t("connect.with", { provider: preset.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="zv-btn zv-btn-ghost" onClick={() => setPreset(null)}>
            {t("back")}
          </button>
          <span className="zm-bar-fill" />
          <button type="button" className="zv-btn zv-btn-primary" disabled={busy || !email || !password} onClick={() => void connect()}>
            {busy ? t("connect.checking") : t("connect.connect")}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <label className="zm-field">
          <span>{t("connect.email")}</span>
          <input
            className="zv-input"
            type="email"
            autoFocus
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              // Typing a Gmail address on the "Other" form switches nothing, but a bare preset form hints the right one.
              if (!custom && presetForEmail(e.target.value).id !== "custom" && presetForEmail(e.target.value).id !== preset.id && e.target.value.includes("@")) setPreset(presetForEmail(e.target.value));
            }}
          />
        </label>
        <label className="zm-field">
          <span>{t("connect.name")}</span>
          <input className="zv-input" value={name} autoComplete="name" placeholder={t("connect.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="zm-field">
          <span>{custom ? t("connect.password") : t("connect.appPassword")}</span>
          <input className="zv-input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {preset.appPasswordUrl && (
          <p className="zm-hint zm-hint-small">
            {t("connect.appPasswordHint", { provider: preset.name })}{" "}
            <a href={preset.appPasswordUrl} target="_blank" rel="noopener noreferrer">
              {t("connect.appPasswordLink")} <ExternalLink size={11} />
            </a>
          </p>
        )}
        {preset.id === "outlook" && (
          <p className="zm-hint" role="note">
            {t("connect.outlookNote")}{" "}
            <a href="/help#mail" target="_blank" rel="noopener noreferrer">
              {t("connect.learnMore")} <ExternalLink size={11} />
            </a>
          </p>
        )}
        {custom && (
          <>
            <label className="zm-field">
              <span>{t("connect.username")}</span>
              <input className="zv-input" value={username} placeholder={email} autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
            </label>
            <ServerFields title={t("connect.imap")} v={imap} onChange={setImap} ports={[993, 143]} />
            <ServerFields title={t("connect.smtp")} v={smtp} onChange={setSmtp} ports={[465, 587]} />
          </>
        )}
        {error && (
          <p className="zm-error" role="alert">
            {error}
          </p>
        )}
        <p className="zm-hint zm-hint-small">
          <Lock size={12} /> {t("connect.privacy")}
        </p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function ServerFields({ title, v, onChange, ports }: { title: string; v: { host: string; port: number; security: string }; onChange: (v: { host: string; port: number; security: string }) => void; ports: number[] }) {
  const stand = useMail((s) => s.boot?.stand ?? false);
  const { t } = useMt();
  return (
    <fieldset className="zm-server">
      <legend>{title}</legend>
      <div className="zm-field-row">
        <label className="zm-field" style={{ flex: 2 }}>
          <span>{t("connect.host")}</span>
          <input className="zv-input" value={v.host} placeholder={ports[0] === 993 ? "imap.example.com" : "smtp.example.com"} onChange={(e) => onChange({ ...v, host: e.target.value.trim() })} />
        </label>
        <label className="zm-field" style={{ flex: 1 }}>
          <span>{t("connect.port")}</span>
          <input className="zv-input" type="number" value={v.port} onChange={(e) => onChange({ ...v, port: Number(e.target.value) })} />
        </label>
        <label className="zm-field" style={{ flex: 1 }}>
          <span>{t("connect.security")}</span>
          <select className="zm-select" value={v.security} onChange={(e) => onChange({ ...v, security: e.target.value, port: e.target.value === "tls" ? ports[0] : ports[1] })}>
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            {stand && <option value="none">{t("connect.noTls")}</option>}
          </select>
        </label>
      </div>
    </fieldset>
  );
}

// --- Documents and Projects ------------------------------------------------------------

/** Saves a conversation to Documents: a private page, a sub-page, or a row of a database. */
export function DocsDialog({ thread, onClose }: { thread: MailThread; onClose: () => void }) {
  const { t } = useMt();
  const ws = useMail((s) => s.ws);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ key: string; title: string; sub?: string }[]>([]);
  const [parent, setParent] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    const tm = setTimeout(() => {
      void eco
        .search(ws, q, ac.signal)
        .then((r) => setHits(r.hits.filter((h) => h.kind === "note").slice(0, 8)))
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(tm);
      ac.abort();
    };
  }, [q, ws]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ noteId: string; url: string }>("docs", { method: "POST", json: { thread: thread.id, ws, ...(parent ? { parent: parent.id } : {}) } });
      onClose();
      toast(t("docs.saved"), { kind: "success", action: { label: t("open"), run: () => (location.href = r.url) } });
    } catch (e) {
      toast(e instanceof MailApiError && e.status === 403 ? t("docs.forbidden") : t("err.generic"), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("docs.save")}
      onClose={onClose}
      footer={
        <>
          <span className="zm-bar-fill" />
          <button type="button" className="zv-btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="button" className="zv-btn zv-btn-primary" disabled={busy} onClick={() => void save()}>
            {t("docs.saveHere")}
          </button>
        </>
      }
    >
      <p className="zm-hint">{t("docs.lead")}</p>
      <div className="zm-choice" data-on={!parent || undefined} onClick={() => setParent(null)} role="radio" aria-checked={!parent} tabIndex={0}>
        <Lock size={15} />
        <span>
          <strong>{t("docs.private")}</strong>
          <span className="zm-hint-small">{t("docs.privateHint")}</span>
        </span>
      </div>
      <input className="zv-input" value={q} placeholder={t("docs.findParent")} onChange={(e) => setQ(e.target.value)} style={{ marginTop: 8 }} />
      <div className="zm-choices">
        {hits.map((h) => (
          <div key={h.key} className="zm-choice" data-on={parent?.id === h.key.slice(5) || undefined} onClick={() => setParent({ id: h.key.slice(5), title: h.title })} role="radio" aria-checked={parent?.id === h.key.slice(5)} tabIndex={0}>
            <FileText size={15} />
            <span>
              <strong>{h.title || t("untitled")}</strong>
              {h.sub && <span className="zm-hint-small">{h.sub}</span>}
            </span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function IssueDialog({ thread, onClose }: { thread: MailThread; onClose: () => void }) {
  const { t } = useMt();
  const ws = useMail((s) => s.ws);
  const [title, setTitle] = useState(thread.subject);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const r = await api<{ card: { url: string; sub?: string; title: string } }>("issue", { method: "POST", json: { thread: thread.id, ws, title } });
      onClose();
      toast(t("issue.made", { id: r.card.sub ?? r.card.title }), { kind: "success", action: { label: t("open"), run: () => (location.href = r.card.url) } });
    } catch (e) {
      toast(e instanceof MailApiError && e.status === 403 ? t("issue.forbidden") : t("err.generic"), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("issue.make")}
      onClose={onClose}
      footer={
        <>
          <span className="zm-bar-fill" />
          <button type="button" className="zv-btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="button" className="zv-btn zv-btn-primary" disabled={busy || !title.trim()} onClick={() => void make()}>
            {t("issue.create")}
          </button>
        </>
      }
    >
      <p className="zm-hint">{t("issue.lead")}</p>
      <label className="zm-field">
        <span>{t("issue.title")}</span>
        <input className="zv-input" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void make()} />
      </label>
    </Dialog>
  );
}
