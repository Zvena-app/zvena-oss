"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n-react";

const REASONS = ["illegal", "harassment", "violence", "children", "selfharm", "personal", "copyright", "fraud", "spam", "other"] as const;

export function ReportForm({ initialUrl }: { initialUrl: string }) {
  const { t } = useI18n();
  const [url, setUrl] = useState(initialUrl);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("illegal");
  const [details, setDetails] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  if (state === "sent") return <p className="zv-banner">{t("report.sent")}</p>;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setState("busy");
        const res = await fetch("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, reason, details, contact }) }).catch(() => null);
        setState(res?.ok ? "sent" : "error");
      }}
    >
      {state === "error" && <p className="zv-banner zv-banner-error">{t("common.error")}</p>}
      <label className="zv-field">
        <span className="zv-label">{t("report.target")}</span>
        <input className="zv-input" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/n/…" />
      </label>
      <label className="zv-field">
        <span className="zv-label">{t("report.reason")}</span>
        <select className="zv-select" value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`report.reason.${r}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="zv-field">
        <span className="zv-label">{t("report.details")}</span>
        <textarea className="zv-textarea" value={details} maxLength={4000} onChange={(e) => setDetails(e.target.value)} />
      </label>
      <label className="zv-field">
        <span className="zv-label">{t("report.contact")}</span>
        <input className="zv-input" value={contact} maxLength={300} onChange={(e) => setContact(e.target.value)} />
      </label>
      <button type="submit" className="zv-btn zv-btn-primary zv-btn-block" disabled={state === "busy" || !url.trim()}>
        {t("report.send")}
      </button>
    </form>
  );
}
