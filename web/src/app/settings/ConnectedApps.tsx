"use client";

import { useEffect, useState } from "react";
import { Scissors } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { intlTag } from "@/i18n/locales";

interface Connection {
  id: string;
  client: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const BROWSER: Record<string, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari" };

/** Settings → Connected apps: the Web Clippers connected to the account, each revocable on its own. */
export function ConnectedApps() {
  const { t, locale } = useI18n();
  const [list, setList] = useState<Connection[] | null>(null);
  useEffect(() => {
    void fetch("/api/clipper/connections", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ connections: Connection[] }>) : { connections: [] }))
      .then((j) => setList(j.connections))
      .catch(() => setList([]));
  }, []);
  const date = (at: number) => new Date(at).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="zv-card" id="apps">
      <h2>{t("settings.apps")}</h2>
      <p className="zv-muted zv-small" style={{ marginTop: 0 }}>
        {t("settings.appsHint")}
      </p>
      {list && list.length === 0 && <p className="zv-small">{t("settings.appsNone")}</p>}
      {list?.map((c) => (
        <div key={c.id} className="zv-actions" style={{ justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--ui-border)" }} data-test="clipper-connection">
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Scissors size={16} />
            <div>
              <div>{t("settings.appsClipper", { browser: BROWSER[c.client] ?? t("settings.appsBrowser") })}</div>
              <div className="zv-muted zv-small">
                {t("settings.appsSince", { date: date(c.createdAt) })}
                {c.lastUsedAt ? ` · ${t("settings.appsUsed", { date: date(c.lastUsedAt) })}` : ""}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="zv-btn"
            onClick={async () => {
              const r = await fetch(`/api/clipper/connections?id=${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch(() => null);
              if (r?.ok) setList((l) => (l ?? []).filter((x) => x.id !== c.id));
            }}
          >
            {t("settings.appsDisconnect")}
          </button>
        </div>
      ))}
    </div>
  );
}
