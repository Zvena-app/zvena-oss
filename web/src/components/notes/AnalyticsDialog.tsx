"use client";

// Page analytics (Notion's): total views and unique viewers with a 28-day
// chart, who created and last edited the page, who viewed and edited it.
// Views are members opening the page (counted once per person per 30
// minutes, lib/notes/versions.ts); names never leave the workspace.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useNotes } from "./context";
import { Modal } from "./ui";
import { Avatar, whoName } from "./history-render";
import { fetchStats, type PageStats } from "@/lib/notes/history-client";
import { relativeTime } from "@/lib/notes/i18n";
import type { Note } from "@/lib/notes/types";
import { intlOf } from "@/i18n/locales";

const W = 560;
const H = 140;
const PAD = 22;

/** `now`: when the numbers were fetched (the last value is that day). */
function Sparkline({ values, locale, now }: { values: number[]; locale: string; now: number }) {
  const max = Math.max(1, ...values);
  const step = (W - PAD * 2) / Math.max(1, values.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const pts = values.map((v, i) => `${PAD + i * step},${y(v)}`);
  const day = (back: number) => new Date(now - back * 86_400_000).toLocaleDateString(intlOf(locale), { day: "numeric", month: "short" });
  return (
    <div className="nt-chart-box nt-analytics-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-hidden>
        <line className="nt-chart-grid" x1={PAD} x2={W - PAD} y1={y(max)} y2={y(max)} />
        <line className="nt-chart-grid" x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} />
        <text className="nt-chart-axis" x={PAD - 6} y={y(max) + 4} textAnchor="end">
          {max}
        </text>
        <text className="nt-chart-axis" x={PAD - 6} y={y(0) + 4} textAnchor="end">
          0
        </text>
        <polygon className="nt-analytics-area" points={`${PAD},${y(0)} ${pts.join(" ")} ${PAD + (values.length - 1) * step},${y(0)}`} />
        <polyline className="nt-chart-line" points={pts.join(" ")} />
        <text className="nt-chart-axis" x={PAD} y={H - 4}>
          {day(values.length - 1)}
        </text>
        <text className="nt-chart-axis" x={W - PAD} y={H - 4} textAnchor="end">
          {day(0)}
        </text>
      </svg>
    </div>
  );
}

export function AnalyticsDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const api = useNotes();
  const { t, locale, user } = api;
  const ws = user?.ws.id ?? null;
  const [stats, setStats] = useState<(PageStats & { at: number }) | null>(null);
  const [failed, setFailed] = useState(false);
  const [metric, setMetric] = useState<"views" | "unique">("views");
  useEffect(() => {
    if (!ws) return;
    let live = true;
    fetchStats(ws, note.id).then(
      (s) => live && setStats({ ...s, at: Date.now() }),
      () => live && setFailed(true)
    );
    return () => {
      live = false;
    };
  }, [ws, note.id]);
  const when = (at: number) => relativeTime(t, locale, at);
  const created = new Date(note.createdAt).toLocaleDateString(intlOf(locale), { day: "numeric", month: "long", year: "numeric" });
  return (
    <Modal onClose={onClose} label={t("analytics.title")} className="nt-analytics">
      <div className="nt-tpl-preview-head">
        <b style={{ fontSize: 14 }}>{t("analytics.title")}</b>
        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="nt-analytics-body">
        {failed && <p className="nt-hist-empty">{t("toast.loadFailed")}</p>}
        {!stats && !failed && <p className="nt-hist-empty">{t("app.loading")}</p>}
        {stats && (
          <>
            <div className="nt-analytics-stats" role="tablist">
              <button type="button" role="tab" aria-selected={metric === "views"} className="nt-analytics-stat nt-btn-reset" data-on={metric === "views" || undefined} onClick={() => setMetric("views")}>
                <span>{t("analytics.views")}</span>
                <b>{stats.views}</b>
              </button>
              <button type="button" role="tab" aria-selected={metric === "unique"} className="nt-analytics-stat nt-btn-reset" data-on={metric === "unique" || undefined} onClick={() => setMetric("unique")}>
                <span>{t("analytics.unique")}</span>
                <b>{stats.viewers}</b>
              </button>
            </div>
            <div className="nt-menu-label">{t("analytics.last28")}</div>
            <Sparkline values={metric === "views" ? stats.days : stats.uniqueDays} locale={locale} now={stats.at} />
            <div className="nt-menu-meta nt-analytics-meta">
              <div>{t("analytics.createdBy", { name: whoName(t, note.createdBy), when: created })}</div>
              {note.editedBy && <div>{t("analytics.editedBy", { name: whoName(t, note.editedBy), when: when(note.updatedAt) })}</div>}
            </div>
            {stats.editors.length > 0 && (
              <>
                <div className="nt-menu-label">{t("analytics.editors")}</div>
                {stats.editors.map((e) => (
                  <div key={e.id} className="nt-analytics-person">
                    <Avatar name={e.name} />
                    <span className="nt-analytics-name">{e.name || t("history.someone")}</span>
                    <span className="nt-analytics-when">
                      {t("analytics.editsN", { n: e.versions })} · {when(e.at)}
                    </span>
                  </div>
                ))}
              </>
            )}
            <div className="nt-menu-label">{t("analytics.viewers")}</div>
            {stats.recentViewers.length === 0 && <p className="nt-hist-empty">{t("analytics.none")}</p>}
            {stats.recentViewers.map((v) => (
              <div key={v.id} className="nt-analytics-person">
                <Avatar name={v.name} />
                <span className="nt-analytics-name">{v.name || t("history.someone")}</span>
                <span className="nt-analytics-when">
                  {t("analytics.viewsN", { n: v.views })} · {when(v.at)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
