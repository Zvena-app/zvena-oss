"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n-react";

// Allow → a one-time code for the extension, handed over in the next page's
// fragment (never sent to a server, never in a log); the extension's content
// script on /clipper/connected takes it and clears the address.
export function ConnectButtons({ state, challenge, client }: { state: string; challenge: string; client: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const allow = async () => {
    setBusy(true);
    setError(false);
    const res = await fetch("/api/clipper/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, challenge, client }) }).catch(() => null);
    const j = res?.ok ? ((await res.json().catch(() => null)) as { code?: string } | null) : null;
    if (!j?.code) {
      setBusy(false);
      setError(true);
      return;
    }
    location.replace(`/clipper/connected#code=${encodeURIComponent(j.code)}&state=${encodeURIComponent(state)}`);
  };
  return (
    <div className="zv-stack">
      {error && (
        <p className="zv-banner zv-banner-error" role="alert">
          {t("common.error")}
        </p>
      )}
      <button type="button" className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block" data-test="clipper-allow" disabled={busy} onClick={() => void allow()}>
        {t("clipper.connect.allow")}
      </button>
      <button type="button" className="zv-btn zv-btn-lg zv-btn-block" disabled={busy} onClick={() => location.replace("/clipper/connected#denied")}>
        {t("common.cancel")}
      </button>
    </div>
  );
}
