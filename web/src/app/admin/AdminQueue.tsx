"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n-react";
import { intlTag } from "@/i18n/locales";
import type { Report } from "@/lib/reports";

export function AdminQueue({ fresh, done }: { fresh: Report[]; done: Report[] }) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const fmt = (ts: number) => new Date(ts).toLocaleString(intlTag(locale));
  const act = async (id: string, action: "removed" | "rejected") => {
    setBusy(id);
    const res = await fetch("/api/admin/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action, note: notes[id] ?? "" }) }).catch(() => null);
    if (res?.ok) location.reload();
    else {
      alert(t("common.error"));
      setBusy(null);
    }
  };
  return (
    <>
      <h2 style={{ fontSize: 20, marginBottom: 12 }}>{t("admin.new")}</h2>
      {fresh.length === 0 ? (
        <div className="zv-empty">{t("admin.empty")}</div>
      ) : (
        fresh.map((r) => (
          <div className="zv-card" key={r.id}>
            <div className="zv-actions" style={{ justifyContent: "space-between" }}>
              <span className="zv-badge zv-badge-accent">{t(`report.reason.${r.reason}`)}</span>
              <span className="zv-muted zv-small">
                {r.kind} · {fmt(r.createdAt)}
              </span>
            </div>
            <p style={{ wordBreak: "break-all" }}>
              <a href={r.url} target="_blank" rel="noopener noreferrer nofollow">
                {r.url}
              </a>
            </p>
            {r.details && <p style={{ whiteSpace: "pre-wrap" }}>{r.details}</p>}
            {r.contact && <p className="zv-muted zv-small">Contact: {r.contact}</p>}
            <input className="zv-input" placeholder="Moderator note" value={notes[r.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} style={{ marginBottom: 10 }} />
            <div className="zv-actions">
              <button type="button" className="zv-btn zv-btn-danger" disabled={busy === r.id} onClick={() => void act(r.id, "removed")}>
                {t("admin.remove")}
              </button>
              <button type="button" className="zv-btn" disabled={busy === r.id} onClick={() => void act(r.id, "rejected")}>
                {t("admin.reject")}
              </button>
            </div>
          </div>
        ))
      )}
      <h2 style={{ fontSize: 20, margin: "32px 0 12px" }}>{t("admin.done")}</h2>
      {done.length === 0 ? (
        <div className="zv-empty">{t("admin.empty")}</div>
      ) : (
        <div className="zv-table-wrap">
          <table className="zv-table">
            <thead>
              <tr>
                <th>Decision</th>
                <th>Reason</th>
                <th>Link</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {done.map((r) => (
                <tr key={r.id}>
                  <td>{r.status === "removed" ? t("admin.remove") : t("admin.reject")}</td>
                  <td>{t(`report.reason.${r.reason}`)}</td>
                  <td style={{ wordBreak: "break-all" }}>{r.url}</td>
                  <td>{r.resolvedAt ? fmt(r.resolvedAt) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
