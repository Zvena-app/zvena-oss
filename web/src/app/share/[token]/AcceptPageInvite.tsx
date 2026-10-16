"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n-react";
import { hardNavigate } from "@/lib/hard-nav";

export function AcceptPageInvite({ token, label }: { token: string; label: string }) {
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
          const res = await fetch("/api/notes/page-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "accept", token }) }).catch(() => null);
          const data = (await res?.json().catch(() => ({}))) as { ws?: string; noteId?: string };
          if (res?.ok && data.ws && data.noteId) hardNavigate(`/docs?ws=${encodeURIComponent(data.ws)}#${encodeURIComponent(data.noteId)}`);
          else {
            setError(res?.status === 404 ? t("join.invalid") : t("common.error"));
            setBusy(false);
          }
        }}
      >
        {label}
      </button>
    </div>
  );
}
