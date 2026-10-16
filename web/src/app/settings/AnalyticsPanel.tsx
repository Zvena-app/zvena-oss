"use client";

// Settings → Analytics (Notion's workspace analytics): how many members were
// active, page views, edits and new pages over 7, 28 or 90 days, a chart per
// day, the most read and edited pages and each member's activity
// (app/api/ws/analytics).

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n-react";
import { intlTag } from "@/i18n/locales";
import type { WorkspaceAnalytics } from "@/lib/notes/ws-analytics";
import { api } from "./parts";

const SPANS = [7, 28, 90] as const;
type Metric = "views" | "edits" | "active";

const W = 640;
const H = 150;
const PAD = 24;

function Chart({ values, locale, now }: { values: number[]; locale: Parameters<typeof intlTag>[0]; now: number }) {
  const max = Math.max(1, ...values);
  const bw = (W - PAD * 2) / values.length;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const day = (back: number) => new Date(now - back * 86_400_000).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short" });
  return (
    <svg className="zst-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-hidden>
      <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} className="zst-chart-grid" />
      <line x1={PAD} x2={W - PAD} y1={y(max)} y2={y(max)} className="zst-chart-grid" />
      <text x={PAD - 6} y={y(max) + 4} textAnchor="end" className="zst-chart-axis">
        {max}
      </text>
      <text x={PAD - 6} y={y(0) + 4} textAnchor="end" className="zst-chart-axis">
        0
      </text>
      {values.map((v, i) => (
        <rect key={i} x={PAD + i * bw + bw * 0.15} width={Math.max(1, bw * 0.7)} y={y(v)} height={Math.max(0, y(0) - y(v))} rx={Math.min(3, bw * 0.2)} className="zst-chart-bar">
          <title>{`${day(values.length - 1 - i)}: ${v}`}</title>
        </rect>
      ))}
      <text x={PAD} y={H - 4} className="zst-chart-axis">
        {day(values.length - 1)}
      </text>
      <text x={W - PAD} y={H - 4} textAnchor="end" className="zst-chart-axis">
        {day(0)}
      </text>
    </svg>
  );
}

export function AnalyticsPanel({ ws }: { ws: string }) {
  const { t, locale } = useI18n();
  const [span, setSpan] = useState<(typeof SPANS)[number]>(28);
  const [metric, setMetric] = useState<Metric>("views");
  const [data, setData] = useState<WorkspaceAnalytics | null>(null);
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await api<WorkspaceAnalytics>("GET", `/api/ws/analytics?ws=${encodeURIComponent(ws)}&span=${span}&tz=${-new Date().getTimezoneOffset()}`);
      if (!live) return;
      setFailed(!r.ok);
      if (r.ok) {
        setData(r.data);
        setAt(Date.now());
      }
    })();
    return () => {
      live = false;
    };
  }, [ws, span]);

  const tk = (k: string, v?: Record<string, string | number>) => t(k as Parameters<typeof t>[0], v);
  const num = (n: number) => n.toLocaleString(intlTag(locale));
  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short", year: "numeric" }) : "—");
  const stats: { key: string; value: number; metric?: Metric }[] = data
    ? [
        { key: "active", value: data.active, metric: "active" },
        { key: "views", value: data.views, metric: "views" },
        { key: "edits", value: data.edits, metric: "edits" },
        { key: "created", value: data.created },
      ]
    : [];

  return (
    <>
      <div className="zst-filters">
        <label className="zst-field">
          <span className="zst-label">{t("settings.audit.range")}</span>
          <select className="zst-select" value={span} onChange={(e) => setSpan(Number(e.target.value) as (typeof SPANS)[number])} data-test="analytics-span">
            {SPANS.map((d) => (
              <option key={d} value={d}>
                {tk(`settings.analytics.span.${d}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {failed && <p className="zst-error" role="alert">{t("common.error")}</p>}
      {data && (
        <>
          <div className="zst-stats" data-test="analytics-stats">
            {stats.map((s) => (
              <button
                type="button"
                key={s.key}
                className="zst-stat"
                aria-pressed={s.metric ? metric === s.metric : undefined}
                disabled={!s.metric}
                onClick={() => s.metric && setMetric(s.metric)}
              >
                <span className="zst-stat-value">{num(s.value)}</span>
                <span className="zst-stat-label">{s.key === "active" ? tk("settings.analytics.activeOf", { n: num(data.members) }) : tk(`settings.analytics.${s.key}`)}</span>
              </button>
            ))}
          </div>
          <section className="zst-section">
            <div className="zst-section-head">
              <h2 className="zst-section-title">{tk(`settings.analytics.chart.${metric}`)}</h2>
            </div>
            <Chart values={data.days[metric]} locale={locale} now={at} />
          </section>
          <section className="zst-section">
            <div className="zst-section-head">
              <h2 className="zst-section-title">{t("settings.analytics.pages")}</h2>
            </div>
            <div className="zst-table-wrap">
              <table className="zst-table" data-test="analytics-pages">
                <thead>
                  <tr>
                    <th>{t("settings.analytics.page")}</th>
                    <th>{t("settings.analytics.views")}</th>
                    <th>{t("settings.analytics.viewers")}</th>
                    <th>{t("settings.analytics.edits")}</th>
                    <th>{t("settings.analytics.lastEdited")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pages.map((p) => (
                    <tr key={p.id}>
                      <td>{p.title === null ? <span className="zst-muted">{t("settings.analytics.noAccess")}</span> : <a href={`/docs?ws=${encodeURIComponent(ws)}#${p.id}`}>{p.title || t("settings.analytics.untitled")}</a>}</td>
                      <td>{num(p.views)}</td>
                      <td>{num(p.viewers)}</td>
                      <td>{num(p.edits)}</td>
                      <td className="zst-nowrap">{when(p.editedAt)}</td>
                    </tr>
                  ))}
                  {data.pages.length === 0 && (
                    <tr>
                      <td colSpan={5} className="zst-muted">
                        {t("settings.analytics.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="zst-section">
            <div className="zst-section-head">
              <h2 className="zst-section-title">{t("settings.analytics.members")}</h2>
            </div>
            <div className="zst-table-wrap">
              <table className="zst-table" data-test="analytics-members">
                <thead>
                  <tr>
                    <th>{t("settings.audit.person")}</th>
                    <th>{t("settings.analytics.lastActive")}</th>
                    <th>{t("settings.analytics.views")}</th>
                    <th>{t("settings.analytics.edits")}</th>
                    <th>{t("settings.analytics.created")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="zst-nowrap">{when(p.activeAt)}</td>
                      <td title={p.views === null ? t("settings.analytics.viewsOff") : undefined}>{p.views === null ? "—" : num(p.views)}</td>
                      <td>{num(p.edits)}</td>
                      <td>{num(p.created)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
