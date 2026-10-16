"use client";

// Settings → Guests (Notion's): people outside the workspace with pages of
// it, what each can open, and "Remove" (app/api/ws/guests).

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n-react";
import type { GuestRow } from "@/lib/enterprise/guests";
import { api } from "./parts";

export function GuestsPanel({ ws }: { ws: string }) {
  const { t } = useI18n();
  const tk = (k: string, v?: Record<string, string | number>) => t(k as Parameters<typeof t>[0], v);
  const [rows, setRows] = useState<GuestRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ guests: GuestRow[] }>("GET", `/api/ws/guests?ws=${encodeURIComponent(ws)}`);
    setFailed(!r.ok);
    if (r.ok) setRows(r.data.guests);
  }, [ws]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const remove = async (g: GuestRow) => {
    if (!window.confirm(tk("settings.guests.confirm", { name: g.name }))) return;
    setBusy(g.id);
    const r = await api("POST", `/api/ws/guests?ws=${encodeURIComponent(ws)}`, { op: "remove", userId: g.id });
    setBusy(null);
    if (r.ok) setRows((x) => (x ?? []).filter((y) => y.id !== g.id));
    else setFailed(true);
  };
  return (
    <>
      {failed && <p className="zst-error" role="alert">{t("common.error")}</p>}
      <div className="zst-table-wrap">
        <table className="zst-table" data-test="guests-table">
          <thead>
            <tr>
              <th>{tk("settings.guests.person")}</th>
              <th>{tk("settings.guests.pages")}</th>
              <th aria-label={tk("settings.guests.remove")} />
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((g) => (
              <tr key={g.id}>
                <td>
                  <div>{g.name}</div>
                  {g.email && <div className="zst-muted">{g.email}</div>}
                </td>
                <td>
                  {g.pages.map((p) => (
                    <div key={p.id}>
                      {p.title === null ? <span className="zst-muted">{tk("settings.analytics.noAccess")}</span> : <a href={`/docs?ws=${encodeURIComponent(ws)}#${p.id}`}>{p.title || tk("settings.analytics.untitled")}</a>}
                      <span className="zst-muted"> · {tk(`settings.guests.level.${p.level}`)}</span>
                    </div>
                  ))}
                </td>
                <td style={{ textAlign: "end" }}>
                  <button type="button" className="zst-btn zst-btn-danger zst-btn-sm" disabled={busy === g.id} onClick={() => void remove(g)} data-test="guest-remove">
                    {tk("settings.guests.remove")}
                  </button>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={3} className="zst-muted">
                  {tk("settings.guests.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
