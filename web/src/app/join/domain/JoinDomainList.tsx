"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n-react";

export function JoinDomainList({ workspaces, next }: { workspaces: { id: string; name: string; meta: string }[]; next: string }) {
  const { t } = useI18n();
  const [joined, setJoined] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = Object.keys(joined).at(-1);
  return (
    <div className="zv-stack">
      {error && <p className="zv-banner zv-banner-error">{error}</p>}
      {workspaces.map((w) => (
        <div key={w.id} className="zv-actions" style={{ justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--zv-border)" }} data-join-ws={w.id}>
          <span>
            <strong>{w.name}</strong>
            <br />
            <span className="zv-muted zv-small">{w.meta}</span>
          </span>
          {joined[w.id] ? (
            <span className="zv-badge zv-badge-accent">{t("joinDomain.joined")}</span>
          ) : (
            <button
              type="button"
              className="zv-btn zv-btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const res = await fetch("/api/join/domain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ws: w.id }) }).catch(() => null);
                if (res?.ok) setJoined((j) => ({ ...j, [w.id]: true }));
                else setError(t("common.error"));
                setBusy(false);
              }}
            >
              {t("joinDomain.join")}
            </button>
          )}
        </div>
      ))}
      <a className="zv-btn zv-btn-lg zv-btn-block" href={last ? `/home?ws=${encodeURIComponent(last)}` : next} data-test="join-continue">
        {t("joinDomain.continue")}
      </a>
    </div>
  );
}
