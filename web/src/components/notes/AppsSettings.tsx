"use client";

// Settings → Apps in Documents: Notion's "Open links in desktop app" (this
// browser's choice, lib/apps.ts), installing zvena as an app on this device
// (the browser's install offer, kept by components/zvena/ServiceWorker.tsx),
// and the Web Clipper (its connections live in the account settings).

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { inDesktopApp, installState, onInstallChange, opensInDesktop, promptInstall, setOpensInDesktop } from "@/lib/apps";
import { useNotes } from "./context";

const noop = () => () => {};
// Turn on when the desktop app can be downloaded (a public release of clients/desktop).
const DESKTOP_PUBLISHED = false;

export function AppsSettings() {
  const { t, user } = useNotes();
  const [links, setLinks] = useState(false);
  // A browser-only choice: read after hydration.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setLinks(opensInDesktop()), []);
  const install = useSyncExternalStore(onInstallChange, installState, () => "unavailable" as const);
  const desktop = useSyncExternalStore(noop, inDesktopApp, () => false);
  const row = (title: string, hint: string, control: ReactNode) => (
    <div className="nt-settings-row">
      <div>
        <div>{title}</div>
        <div style={{ fontSize: 12, color: "var(--nt-text-2)" }}>{hint}</div>
      </div>
      {control}
    </div>
  );
  return (
    <>
      <h2>{t("settings.apps")}</h2>
      {/* The desktop app (clients/desktop) has no public download yet: its rows show only inside it. */}
      {DESKTOP_PUBLISHED &&
        !desktop &&
        row(
          t("settings.desktopLinks"),
          t("settings.desktopLinksHint"),
          <button
            type="button"
            role="switch"
            aria-checked={links}
            aria-label={t("settings.desktopLinks")}
            data-test="desktop-links"
            className="nt-switch nt-btn-reset"
            onClick={() => {
              setOpensInDesktop(!links);
              setLinks(!links);
            }}
          >
            <span />
          </button>
        )}
      {(DESKTOP_PUBLISHED || desktop) && row(t("settings.desktopApp"), t("settings.desktopAppHint"), null)}
      {!desktop &&
        row(
          t("settings.install"),
          install === "unavailable" ? `${t("settings.installHint")} ${t("settings.installManual")}` : t("settings.installHint"),
          install === "installed" ? (
            <span style={{ fontSize: 13, color: "var(--nt-text-2)" }}>{t("settings.installed")}</span>
          ) : install === "available" ? (
            <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" onClick={() => void promptInstall()}>
              {t("settings.installButton")}
            </button>
          ) : null
        )}
      {user &&
        row(
          t("settings.clipper"),
          t("settings.clipperHint"),
          <a className="nt-btn nt-btn-plain nt-btn-sm" href="/settings#apps">
            {t("settings.clipperManage")}
          </a>
        )}
    </>
  );
}
