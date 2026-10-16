"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n-react";

export function JoinButton({ token, label }: { token: string; label: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="zv-stack">
      {error && <p className="zv-banner zv-banner-error">{error}</p>}
      <button
        type="button"
        className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await fetch("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => null);
          const data = (await res?.json().catch(() => ({}))) as { wsId?: string; error?: string };
          if (res?.ok && data.wsId) location.href = `/home?ws=${encodeURIComponent(data.wsId)}`;
          else {
            setError(res?.status === 410 ? t("join.invalid") : t("common.error"));
            setBusy(false);
          }
        }}
      >
        {label}
      </button>
    </div>
  );
}
