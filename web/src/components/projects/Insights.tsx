"use client";

// Insights: how the work flows (Linear's Insights). Four numbers, the flow of
// issues created and completed per week, the median cycle time, and what is
// open now by status, assignee, priority and label — each bar opens those
// issues. Charts are plain SVG: thin marks, one axis, a legend for two series,
// a tooltip on hover and focus, and a table view of the same numbers.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChartColumnBig, Table2 } from "lucide-react";
import type { Insights as Data } from "@/lib/projects/insights";
import { api, useLookups, useQuery } from "./data";
import { PriorityIcon, StatusIcon } from "./icons";
import { useT } from "./i18n";
import { navigate, setParams, useLoc } from "./router";
import { Avatar, Empty, ErrorState, LoadingRows, UnassignedIcon, useFormat } from "./ui";

const RANGES = [4, 12, 26] as const;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A rounded-up "nice" maximum for an axis, and its ticks. */
function scale(max: number): number[] {
  const top = max <= 4 ? 4 : max <= 10 ? 10 : Math.ceil(max / 5) * 5;
  const step = top / 4;
  return [0, step, step * 2, step * 3, top].map((v) => Math.round(v * 10) / 10);
}

function Tip({ x, children }: { x: number; children: ReactNode }) {
  return (
    <div className="pj-ins-tip" style={{ left: x }} role="status">
      {children}
    </div>
  );
}

/** Created vs completed per week: grouped bars on one axis, legend above, a tooltip per week. */
function FlowChart({ d, label }: { d: Data; label: (i: number) => string }) {
  const { t } = useT();
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = 200;
  const pad = { l: 32, r: 8, t: 8, b: 24 };
  const n = d.periods.length;
  const ticks = scale(Math.max(1, ...d.created, ...d.completed));
  const top = ticks[ticks.length - 1];
  const band = (w - pad.l - pad.r) / n;
  const bw = Math.max(2, Math.min(14, (band - 6) / 2 - 1));
  const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / top);
  const every = n > 13 ? 4 : n > 6 ? 2 : 1;
  return (
    <div ref={ref} className="pj-ins-chart" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={h} role="group" aria-label={t("ins.flow")}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} className="pj-ins-grid" />
            <text x={pad.l - 6} y={y(v)} className="pj-ins-axis" textAnchor="end" dominantBaseline="middle">
              {v}
            </text>
          </g>
        ))}
        {d.periods.map((p, i) => {
          const x0 = pad.l + band * i + band / 2;
          return (
            <g key={p} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} role="img" aria-label={`${label(i)}: ${t("ins.created")} ${d.created[i]}, ${t("ins.completed")} ${d.completed[i]}`}>
              <rect x={pad.l + band * i} y={pad.t} width={band} height={h - pad.t - pad.b} className="pj-ins-hit" data-on={hover === i || undefined} />
              {d.created[i] > 0 && <rect x={x0 - bw - 1} y={y(d.created[i])} width={bw} height={y(0) - y(d.created[i])} rx={Math.min(4, bw / 2)} className="pj-ins-s2" />}
              {d.completed[i] > 0 && <rect x={x0 + 1} y={y(d.completed[i])} width={bw} height={y(0) - y(d.completed[i])} rx={Math.min(4, bw / 2)} className="pj-ins-s1" />}
              {i % every === n % every && (
                <text x={x0} y={h - 6} className="pj-ins-axis" textAnchor="middle">
                  {label(i)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={pad.l} x2={w - pad.r} y1={y(0)} y2={y(0)} className="pj-ins-base" />
      </svg>
      {hover !== null && (
        <Tip x={Math.min(w - 150, Math.max(0, pad.l + band * hover + band / 2 - 70))}>
          <b>{t("ins.weekTo", { date: label(hover) })}</b>
          <span>
            <i className="pj-ins-key pj-ins-s2" /> {t("ins.created")} <b>{d.created[hover]}</b>
          </span>
          <span>
            <i className="pj-ins-key pj-ins-s1" /> {t("ins.completed")} <b>{d.completed[hover]}</b>
          </span>
        </Tip>
      )}
    </div>
  );
}

/** Median cycle time per week: one line, dots where there is a value, a crosshair tooltip. */
function CycleChart({ d, label }: { d: Data; label: (i: number) => string }) {
  const { t } = useT();
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = 160;
  const pad = { l: 32, r: 8, t: 10, b: 24 };
  const n = d.periods.length;
  const vals = d.cycleDays.map((v) => v ?? 0);
  const ticks = scale(Math.max(1, ...vals));
  const top = ticks[ticks.length - 1];
  const step = (w - pad.l - pad.r) / n;
  const x = (i: number) => pad.l + step * i + step / 2;
  const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / top);
  const pts = d.cycleDays.map((v, i) => (v === null ? null : ([x(i), y(v)] as const)));
  // A gap where a week has no completed work (the line does not invent a value).
  let path = "";
  let pen = false;
  for (const p of pts) {
    if (!p) {
      pen = false;
      continue;
    }
    path += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  const every = n > 13 ? 4 : n > 6 ? 2 : 1;
  return (
    <div
      ref={ref}
      className="pj-ins-chart"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.floor((e.clientX - r.left - pad.l) / step);
        setHover(i >= 0 && i < n ? i : null);
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={w} height={h} role="img" aria-label={t("ins.cycle")}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} className="pj-ins-grid" />
            <text x={pad.l - 6} y={y(v)} className="pj-ins-axis" textAnchor="end" dominantBaseline="middle">
              {v}
            </text>
          </g>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={y(0)} className="pj-ins-cross" />}
        <path d={path} className="pj-ins-line" />
        {pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={hover === i ? 5 : 4} className="pj-ins-dot" />)}
        {d.periods.map((_, i) =>
          i % every === n % every ? (
            <text key={i} x={x(i)} y={h - 6} className="pj-ins-axis" textAnchor="middle">
              {label(i)}
            </text>
          ) : null
        )}
        <line x1={pad.l} x2={w - pad.r} y1={y(0)} y2={y(0)} className="pj-ins-base" />
      </svg>
      {hover !== null && (
        <Tip x={Math.min(w - 150, Math.max(0, x(hover) - 70))}>
          <b>{t("ins.weekTo", { date: label(hover) })}</b>
          <span>{d.cycleDays[hover] === null ? t("ins.noneDone") : t("ins.days", { n: String(d.cycleDays[hover]) })}</span>
        </Tip>
      )}
    </div>
  );
}

/** Open issues by one field: rows with a thin bar each; a click opens those issues. */
function Breakdown({ title, rows, total }: { title: string; rows: { key: string; label: ReactNode; count: number; to: string }[]; total: number }) {
  const { t } = useT();
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="pj-ins-card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="pj-muted pj-small">{t("ins.nothingOpen")}</p>
      ) : (
        <ul className="pj-ins-bars">
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" className="pj-ins-bar-row" onClick={() => navigate(r.to)} title={t("ins.openThese")}>
                <span className="pj-ins-bar-label">{r.label}</span>
                <span className="pj-ins-bar-track" aria-hidden>
                  <span className="pj-ins-s1" style={{ width: `${(r.count / max) * 100}%` }} />
                </span>
                <span className="pj-ins-bar-n">
                  {r.count}
                  <small> · {Math.round((r.count / Math.max(1, total)) * 100)}%</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function InsightsScreen() {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const loc = useLoc();
  const team = loc.params.get("team") ?? "";
  const project = loc.params.get("project") ?? "";
  const weeks = Number(loc.params.get("weeks")) || 12;
  const [table, setTable] = useState(false);
  const [today] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const { data, error, loading, reload } = useQuery<Data>(`insights:${team}:${project}:${weeks}`, () =>
    api<Data>("insights", { query: { team: team || undefined, project: project || undefined, weeks: String(weeks), today } })
  );
  const label = (i: number) => (data ? f.day(data.periods[i]) : "");
  // Drill-down: the list of those open issues, within the same team/project.
  const scope = `${team ? `&team=${team}` : ""}${project ? `&project=${project}` : ""}`;
  const to = (k: string, v: string) => `/issues?${k}=${encodeURIComponent(v)}${scope}`;

  const tile = (name: string, value: ReactNode, hint?: string) => (
    <div className="pj-ins-tile">
      <span className="pj-ins-tile-name">{name}</span>
      <span className="pj-ins-tile-value">{value}</span>
      {hint && <span className="pj-ins-tile-hint">{hint}</span>}
    </div>
  );
  const days = (v: number | null) => (v === null ? "—" : t("ins.days", { n: String(v) }));

  return (
    <div className="pj-screen pj-insights">
      <header className="pj-head">
        <div className="pj-head-title">
          <ChartColumnBig size={16} />
          <h1>{t("ins.title")}</h1>
        </div>
      </header>
      <div className="pj-screen-body">
        <div className="pj-ins-filters" role="group" aria-label={t("ins.scope")}>
          <select className="pj-select" value={team} aria-label={t("f.team")} onChange={(e) => setParams({ team: e.target.value || null })}>
            <option value="">{t("ins.allTeams")}</option>
            {L.b.teams
              .filter((x) => !x.archivedAt)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
          <select className="pj-select" value={project} aria-label={t("f.project")} onChange={(e) => setParams({ project: e.target.value || null })}>
            <option value="">{t("ins.allProjects")}</option>
            {L.b.projects
              .filter((x) => !x.archivedAt)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
          <select className="pj-select" value={weeks} aria-label={t("ins.range")} onChange={(e) => setParams({ weeks: e.target.value === "12" ? null : e.target.value })}>
            {RANGES.map((r) => (
              <option key={r} value={r}>
                {t("ins.weeks", { n: String(r) })}
              </option>
            ))}
          </select>
          <button type="button" className="pj-btn pj-btn-sm" aria-pressed={table} onClick={() => setTable((v) => !v)}>
            <Table2 size={14} />
            {t("ins.table")}
          </button>
        </div>
        {error ? (
          <ErrorState onRetry={reload} />
        ) : loading || !data ? (
          <LoadingRows rows={8} />
        ) : data.open === 0 && data.createdInRange === 0 && data.completedInRange === 0 ? (
          <Empty icon={<ChartColumnBig size={22} />} title={t("ins.empty")} hint={t("ins.emptyHint")} />
        ) : (
          <>
            <div className="pj-ins-tiles">
              {tile(t("ins.open"), data.open)}
              {tile(t("ins.completedIn"), data.completedInRange, t("ins.createdIn", { n: String(data.createdInRange) }))}
              {tile(t("ins.medianCycle"), days(data.medianCycleDays), t("ins.cycleHint"))}
              {tile(t("ins.medianLead"), days(data.medianLeadDays), t("ins.leadHint"))}
            </div>
            <section className="pj-ins-card">
              <div className="pj-ins-card-head">
                <h2>{t("ins.flow")}</h2>
                <span className="pj-ins-legend">
                  <span>
                    <i className="pj-ins-key pj-ins-s2" /> {t("ins.created")}
                  </span>
                  <span>
                    <i className="pj-ins-key pj-ins-s1" /> {t("ins.completed")}
                  </span>
                </span>
              </div>
              {table ? (
                <table className="pj-ins-table">
                  <thead>
                    <tr>
                      <th>{t("ins.week")}</th>
                      <th>{t("ins.created")}</th>
                      <th>{t("ins.completed")}</th>
                      <th>{t("ins.cycle")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.periods.map((p, i) => (
                      <tr key={p}>
                        <td>{label(i)}</td>
                        <td>{data.created[i]}</td>
                        <td>{data.completed[i]}</td>
                        <td>{days(data.cycleDays[i])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <FlowChart d={data} label={label} />
              )}
            </section>
            {!table && (
              <section className="pj-ins-card">
                <h2>{t("ins.cycle")}</h2>
                <CycleChart d={data} label={label} />
              </section>
            )}
            <div className="pj-ins-grid2">
              <Breakdown
                title={t("ins.byStatus")}
                total={data.open}
                rows={data.byStatus.map((r) => {
                  const s = L.status.get(r.id);
                  return {
                    key: r.id,
                    label: (
                      <>
                        {s && <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} size={13} />} {s?.name ?? "—"}
                      </>
                    ),
                    count: r.count,
                    to: to("status", r.id),
                  };
                })}
              />
              <Breakdown
                title={t("ins.byAssignee")}
                total={data.open}
                rows={data.byAssignee.map((r) => {
                  const p = r.id ? L.person.get(r.id) : null;
                  return {
                    key: r.id ?? "none",
                    label: (
                      <>
                        {p ? <Avatar name={p.name} id={p.id} size={16} src={p.avatar} /> : <UnassignedIcon size={16} />} {p ? p.name : t("i.unassigned")}
                      </>
                    ),
                    count: r.count,
                    to: to("assignee", r.id ?? "none"),
                  };
                })}
              />
              <Breakdown
                title={t("ins.byPriority")}
                total={data.open}
                rows={data.byPriority.map((r) => ({
                  key: String(r.priority),
                  label: (
                    <>
                      <PriorityIcon priority={r.priority as 0} size={13} /> {t(`prio.${r.priority as 0}`)}
                    </>
                  ),
                  count: r.count,
                  to: to("priority", String(r.priority)),
                }))}
              />
              <Breakdown
                title={t("ins.byLabel")}
                total={data.open}
                rows={data.byLabel.map((r) => {
                  const l = L.label.get(r.id);
                  return {
                    key: r.id,
                    label: (
                      <>
                        <span className="pj-dot" style={{ background: l?.color ?? "var(--zv-border-2)" }} /> {l?.name ?? "—"}
                      </>
                    ),
                    count: r.count,
                    to: to("label", r.id),
                  };
                })}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
