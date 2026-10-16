"use client";

import { useEffect, useState } from "react";
import { Download, LogOut, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { formatBytes, writeLangCookie, type Locale } from "@/lib/i18n";
import { LOCALES, LOCALE_INFO } from "@/i18n/locales";
import type { Usage } from "@/lib/storage";
import { Email } from "@/components/zvena/Email";
import { ConnectedApps } from "./ConnectedApps";
import { hardNavigate } from "@/lib/hard-nav";

type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const s = JSON.parse(localStorage.getItem("zvena-settings") || "null") as { theme?: Theme } | null;
    return s?.theme ?? "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  try {
    const s = (JSON.parse(localStorage.getItem("zvena-settings") || "null") as Record<string, unknown> | null) ?? {};
    localStorage.setItem("zvena-settings", JSON.stringify({ ...s, theme }));
  } catch {
    // Private mode: this page view only.
  }
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

const PROVIDER: Record<string, string> = { email: "Email link", dev: "Test sign-in", sso: "SSO" };

export function SettingsPanel({ name: initialName, email, usage, identities }: { name: string; email?: string; usage: Usage; identities: string[] }) {
  const { t, locale, setLocale } = useI18n();
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  // The stored theme lives in this browser only (read after hydration).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setTheme(readTheme()), []);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pct = usage.quota ? Math.min(100, Math.round((usage.total / usage.quota) * 100)) : 0;
  const b = (n: number) => formatBytes(n, locale);

  return (
    <>
      {error && (
        <p className="zv-banner zv-banner-error" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </p>
      )}
      <div className="zv-card">
        <h2>{t("settings.profile")}</h2>
        <form
          className="zv-actions"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaved(false);
            const res = await fetch("/api/auth/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => null);
            if (res?.ok) setSaved(true);
            else setError(t("common.error"));
          }}
        >
          <label className="zv-sr" htmlFor="zv-name">
            {t("settings.name")}
          </label>
          <input id="zv-name" className="zv-input" style={{ flex: 1, minWidth: 200 }} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="zv-btn" disabled={!name.trim()}>
            {saved ? t("settings.saved") : t("settings.save")}
          </button>
        </form>
        <div className="zv-actions" style={{ marginTop: 16 }}>
          <label className="zv-field" style={{ margin: 0 }}>
            <span className="zv-label">{t("settings.language")}</span>
            <select
              className="zv-select"
              value={locale}
              onChange={(e) => {
                const l = e.target.value as Locale;
                writeLangCookie(l);
                setLocale(l);
                location.reload();
              }}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_INFO[l].native}
                </option>
              ))}
            </select>
          </label>
          <label className="zv-field" style={{ margin: 0 }}>
            <span className="zv-label">{t("settings.theme")}</span>
            <select
              className="zv-select"
              value={theme}
              onChange={(e) => {
                const v = e.target.value as Theme;
                setTheme(v);
                applyTheme(v);
              }}
            >
              <option value="system">{t("settings.theme.system")}</option>
              <option value="light">{t("settings.theme.light")}</option>
              <option value="dark">{t("settings.theme.dark")}</option>
            </select>
          </label>
        </div>
        <p className="zv-small" style={{ margin: "16px 0 0" }}>
          <a href="/welcome?next=%2Fsettings" data-test="settings-welcome">
            {t("settings.welcome")}
          </a>
        </p>
      </div>

      <div className="zv-card">
        <h2>{t("settings.signins")}</h2>
        {email && (
          <p className="zv-muted zv-small" style={{ margin: "0 0 10px" }}>
            <Email address={email} link={false} />
          </p>
        )}
        <div className="zv-actions">
          {identities.map((p) => (
            <span key={p} className="zv-badge zv-badge-accent">
              {PROVIDER[p] ?? p}
            </span>
          ))}
        </div>
      </div>

      <div className="zv-card">
        <h2>{t("settings.storage")}</h2>
        <div className="zv-meter" data-full={pct >= 100 || undefined} role="progressbar" aria-label={t("settings.storage")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="zv-small" style={{ margin: "8px 0 0" }}>
          {t("settings.storageOf", { used: b(usage.total), quota: b(usage.quota) })}
        </p>
        <p className="zv-muted zv-small" style={{ margin: "4px 0 0" }}>
          {t("settings.storage.docs")}: {b(usage.notes)} · {t("settings.storage.files")}: {b(usage.files)} · {t("settings.storage.design")}: {b(usage.design)}
        </p>
      </div>

      <ConnectedApps />

      <div className="zv-card">
        <h2>{t("settings.data")}</h2>
        <p className="zv-muted zv-small" style={{ marginTop: 0 }}>
          {t("settings.exportHint")}
        </p>
        <div className="zv-actions">
          <a className="zv-btn zv-btn-primary" href="/api/export" download>
            <Download />
            {t("settings.export")}
          </a>
          <button
            type="button"
            className="zv-btn"
            onClick={async () => {
              await fetch("/api/auth/logout-all", { method: "POST" }).catch(() => null);
              hardNavigate("/");
            }}
          >
            <LogOut />
            {t("settings.sessions")}
          </button>
        </div>
      </div>

      <div className="zv-card">
        <h2>{t("settings.delete")}</h2>
        <p className="zv-muted zv-small" style={{ marginTop: 0 }}>
          {t("settings.deleteHint")}
        </p>
        <label className="zv-field">
          <span className="zv-label">{t("settings.deleteConfirm")}</span>
          <input className="zv-input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </label>
        <button
          type="button"
          className="zv-btn zv-btn-danger"
          disabled={busy || ![t("settings.deleteWord"), "DELETE"].includes(confirm.trim().toUpperCase())}
          onClick={async () => {
            setBusy(true);
            const res = await fetch("/api/auth/account", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm }) }).catch(() => null);
            if (res?.ok) {
              alert(t("settings.deleted"));
              hardNavigate("/");
            } else {
              setError(t("common.error"));
              setBusy(false);
            }
          }}
        >
          <Trash2 />
          {t("settings.delete")}
        </button>
      </div>

      <p className="zv-muted zv-small">
        {t("settings.legal")}: <a href="/legal/privacy">{t("footer.privacy")}</a> · <a href="/legal/terms">{t("footer.terms")}</a> · <a href="/legal/cookies">{t("footer.cookies")}</a>
      </p>
    </>
  );
}
