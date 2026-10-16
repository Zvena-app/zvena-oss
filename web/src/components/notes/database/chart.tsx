"use client";

// Chart view (Notion Charts): columns, bars, a line or a donut over a
// database — rows grouped by a property (X), counted or summed (Y), and
// optionally split into series by another property ("Group by": stacked
// columns and bars, a line per series); a line can add up as it goes.

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BarChart3, ChartColumn, ChartLine, ChartPie, ChevronDown } from "lucide-react";
import { Menu, Popover } from "../ui";
import { PropIcon } from "./cells";
import type { DbCtl } from "./useDatabase";
import { canGroupBy, formatNumber, groupRowsFor } from "@/lib/notes/db";
import { calcColumn } from "@/lib/notes/compute";
import type { ChartSpec, DbProperty, NoteColor } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { currentWorkspace } from "@/lib/notes/workspace";
import { ChartGoals } from "@/components/eco/ChartGoal";
import { useNotesMaybe } from "../context";

const HEIGHTS = { small: 240, medium: 340, large: 480 } as const;
const PALETTE = ["#2383e2", "#5e9fe8", "#9065b0", "#d9730d", "#448361", "#cb912f", "#c14c8a", "#d44c47", "#337ea9", "#9f6b53"];
const colorOf = (c: NoteColor | undefined, i: number) => (c && c !== "default" ? `var(--nt-c-${c})` : PALETTE[i % PALETTE.length]);

/** A stack's segments, each starting where the one before it ended (negative shares draw nothing). */
function stack(parts: Part[]): (Part & { from: number })[] {
  let at = 0;
  return parts.map((p) => {
    const v = Math.max(0, p.value);
    const seg = { ...p, value: v, from: at };
    at += v;
    return seg;
  });
}

/** 0, a round step, …, covering max (≈5 ticks). */
function niceTicks(max: number, integer: boolean): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  // Counts never get fractional ticks.
  if (integer) step = Math.max(1, Math.ceil(step));
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

interface Datum {
  key: string;
  label: string;
  value: number;
  color: string;
  /** The series' shares of this X group (with "Group by"), in series order. */
  parts?: Part[];
}

interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
  /** The X group it belongs to (for the tooltip). */
  of?: string;
}

function Picker({ label, value, icon, children }: { label: string; value: string; icon?: ReactNode; children: (close: () => void, el: HTMLElement) => ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" className="nt-db-tool nt-btn-reset nt-chart-pick" onClick={(e) => setEl(e.currentTarget)}>
        <span className="nt-chart-pick-label">{label}</span>
        {icon}
        <span>{value}</span>
        <ChevronDown size={12} />
      </button>
      {el && children(() => setEl(null), el)}
    </>
  );
}

export function ChartView({ ctl }: { ctl: DbCtl }) {
  const { t, locale, snap } = ctl.api;
  // zvena: goals on the chart (components/eco/ChartGoal.tsx), for a signed-in workspace only.
  const notes = useNotesMaybe();
  const ws = notes?.user ? currentWorkspace() : "";
  const view = ctl.view;
  const props = ctl.schema?.properties ?? [];
  const spec: ChartSpec = view?.chart ?? { type: "column" };
  const xProp = props.find((p) => p.id === spec.x && canGroupBy(p)) ?? props.find((p) => p.type === "status" || p.type === "select") ?? props.find((p) => canGroupBy(p));
  const yProp = (spec.y?.fn ?? "count") === "count" ? undefined : props.find((p) => p.id === spec.y?.prop && (p.type === "number" || p.type === "formula" || p.type === "rollup"));
  // A sum over a deleted property falls back to counting rows (and says so).
  const yFn = yProp ? (spec.y?.fn ?? "count") : "count";
  // Series ("Group by"): not for a donut, never the X property itself.
  const gProp = spec.type === "donut" ? undefined : props.find((p) => p.id === spec.group && p.id !== xProp?.id && canGroupBy(p));
  const cumulative = spec.type === "line" && !!spec.cumulative;
  const H = HEIGHTS[spec.height ?? "medium"];
  const numProps = props.filter((p) => p.type === "number" || p.type === "formula" || p.type === "rollup");
  const set = (patch: Partial<ChartSpec>) => ctl.updateView({ chart: { ...spec, ...patch } });
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [tip, setTip] = useState<{ x: number; y: number; d: Part } | null>(null);
  const tipAt = (e: React.MouseEvent, d: Part) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setTip({ x: Math.min(e.clientX - r.left, r.width - 160), y: e.clientY - r.top, d });
  };

  // The box exists only once there is an X property.
  const hasX = Boolean(xProp);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasX]);

  const { data, series } = useMemo<{ data: Datum[]; series: Part[] }>(() => {
    if (!xProp) return { data: [], series: [] };
    const labels = (p: DbProperty) => ({ none: t("db.noGroup", { prop: p.name }), checked: t("db.checked"), unchecked: t("db.unchecked") });
    const measure = (rows: DbCtl["rows"]) => {
      if (yFn === "count" || !yProp) return rows.length;
      const v = calcColumn(yFn, rows, yProp, snap.byId, locale);
      return typeof v === "number" ? v : 0;
    };
    const groups = groupRowsFor(ctl.rows, xProp, labels(xProp), locale);
    // The series, in the group property's own order, each with one color throughout.
    const series: Part[] = gProp
      ? groupRowsFor(ctl.rows, gProp, labels(gProp), locale)
          .filter((g) => g.rows.length > 0)
          .map((g, i) => ({ key: g.key, label: g.label, value: 0, color: colorOf(g.option?.color, i) }))
      : [];
    const out = groups
      .map((g, i) => {
        const value = measure(g.rows);
        let parts: Part[] | undefined;
        if (gProp) {
          const split = new Map(groupRowsFor(g.rows, gProp, labels(gProp), locale).map((x) => [x.key, x.rows] as const));
          parts = series.map((sr) => ({ ...sr, value: split.get(sr.key)?.length ? measure(split.get(sr.key) ?? []) : 0, of: g.label }));
        }
        return { key: g.key, label: g.label, value: parts ? parts.reduce((a, b) => a + b.value, 0) : value, color: colorOf(g.option?.color, i), parts, empty: g.key === "__none" };
      })
      // The "No …" bucket only when it has rows.
      .filter((d) => !(d.empty && d.value === 0 && yFn === "count") && !(d.empty && groups.find((g) => g.key === d.key)?.rows.length === 0));
    if (spec.omitZero) for (let i = out.length - 1; i >= 0; i--) if (out[i].value === 0) out.splice(i, 1);
    if (spec.sort === "asc") out.sort((a, b) => a.value - b.value);
    if (spec.sort === "desc") out.sort((a, b) => b.value - a.value);
    if (cumulative) {
      // A running total along the X order (per series, too).
      let run = 0;
      const runs = new Map<string, number>();
      for (const d of out) {
        run += d.value;
        d.value = run;
        for (const p of d.parts ?? []) {
          const v = (runs.get(p.key) ?? 0) + p.value;
          runs.set(p.key, v);
          p.value = v;
        }
      }
    }
    return { data: out, series };
  }, [ctl.rows, xProp, gProp, yFn, yProp, spec.sort, spec.omitZero, cumulative, snap.byId, locale, t]);

  const fmt = (v: number) => (yProp ? formatNumber(Math.round(v * 100) / 100, yProp.numberFormat, locale, yProp.decimals) : String(v));
  const typeIcon = { column: <ChartColumn size={14} />, bar: <BarChart3 size={14} />, line: <ChartLine size={14} />, donut: <ChartPie size={14} /> }[spec.type];
  const yLabel = yFn === "count" ? t("chart.count") : `${t(`rollup.fn.${yFn}` as NotesKey)} · ${yProp?.name ?? "—"}`;

  const toolbar = (
    <div className="nt-chart-bar">
      <Picker label={t("chart.type")} value={t(`chart.${spec.type}` as NotesKey)} icon={typeIcon}>
        {(close, el) => (
          <Popover anchor={el} onClose={close}>
            <Menu
              width={200}
              onClose={close}
              groups={[{ key: "t", items: (["column", "bar", "line", "donut"] as const).map((k) => ({ key: k, label: t(`chart.${k}` as NotesKey), checked: spec.type === k, onSelect: () => (set({ type: k }), close()) })) }]}
            />
          </Popover>
        )}
      </Picker>
      <Picker label={t("chart.x")} value={xProp?.name ?? "—"} icon={xProp ? <PropIcon type={xProp.type} size={14} /> : undefined}>
        {(close, el) => (
          <Popover anchor={el} onClose={close}>
            <Menu
              width={220}
              onClose={close}
              groups={[{ key: "x", items: props.filter(canGroupBy).map((p: DbProperty) => ({ key: p.id, label: p.name, icon: <PropIcon type={p.type} />, checked: p.id === xProp?.id, onSelect: () => (set({ x: p.id }), close()) })) }]}
            />
          </Popover>
        )}
      </Picker>
      <Picker label={t("chart.y")} value={yLabel}>
        {(close, el) => (
          <Popover anchor={el} onClose={close}>
            <Menu
              width={240}
              onClose={close}
              groups={[
                { key: "c", items: [{ key: "count", label: t("chart.count"), checked: yFn === "count", onSelect: () => (set({ y: { fn: "count" } }), close()) }] },
                ...numProps.map((p) => ({
                  key: p.id,
                  label: p.name,
                  items: (["sum", "average", "median", "min", "max"] as const).map((fn) => ({
                    key: `${p.id}:${fn}`,
                    label: t(`rollup.fn.${fn}` as NotesKey),
                    checked: yFn === fn && yProp?.id === p.id,
                    onSelect: () => (set({ y: { fn, prop: p.id } }), close()),
                  })),
                })),
              ]}
            />
          </Popover>
        )}
      </Picker>
      {spec.type !== "donut" && (
        <Picker label={t("chart.group")} value={gProp?.name ?? t("db.calcNone")} icon={gProp ? <PropIcon type={gProp.type} size={14} /> : undefined}>
          {(close, el) => (
            <Popover anchor={el} onClose={close}>
              <Menu
                width={220}
                onClose={close}
                groups={[
                  {
                    key: "g",
                    items: [
                      { key: "__none", label: t("db.calcNone"), checked: !gProp, onSelect: () => (set({ group: undefined }), close()) },
                      ...props
                        .filter((p) => canGroupBy(p) && p.id !== xProp?.id)
                        .map((p: DbProperty) => ({ key: p.id, label: p.name, icon: <PropIcon type={p.type} />, checked: p.id === gProp?.id, onSelect: () => (set({ group: p.id }), close()) })),
                    ],
                  },
                ]}
              />
            </Popover>
          )}
        </Picker>
      )}
      <Picker label={t("chart.sort")} value={t(`chart.sort.${spec.sort ?? "x"}` as NotesKey)}>
        {(close, el) => (
          <Popover anchor={el} onClose={close}>
            <Menu
              width={200}
              onClose={close}
              groups={[{ key: "s", items: (["x", "desc", "asc"] as const).map((k) => ({ key: k, label: t(`chart.sort.${k}` as NotesKey), checked: (spec.sort ?? "x") === k, onSelect: () => (set({ sort: k }), close()) })) }]}
            />
          </Popover>
        )}
      </Picker>
      <button type="button" className="nt-db-tool nt-btn-reset" data-on={spec.labels || undefined} onClick={() => set({ labels: !spec.labels })}>
        {t("chart.labels")}
      </button>
      <Picker label={t("chart.height")} value={t(`chart.height.${spec.height ?? "medium"}` as NotesKey)}>
        {(close, el) => (
          <Popover anchor={el} onClose={close}>
            <Menu
              width={180}
              onClose={close}
              groups={[{ key: "h", items: (["small", "medium", "large"] as const).map((k) => ({ key: k, label: t(`chart.height.${k}` as NotesKey), checked: (spec.height ?? "medium") === k, onSelect: () => (set({ height: k === "medium" ? undefined : k }), close()) })) }]}
            />
          </Popover>
        )}
      </Picker>
      <button type="button" className="nt-db-tool nt-btn-reset" data-on={spec.omitZero || undefined} onClick={() => set({ omitZero: !spec.omitZero || undefined })}>
        {t("chart.omitZero")}
      </button>
      {spec.type === "line" && (
        <button type="button" className="nt-db-tool nt-btn-reset" data-on={spec.cumulative || undefined} data-test="chart-cumulative" onClick={() => set({ cumulative: !spec.cumulative || undefined })}>
          {t("chart.cumulative")}
        </button>
      )}
    </div>
  );

  if (!xProp) return <div className="nt-panel-empty">{t("chart.noProps")}</div>;

  const total = data.reduce((s, d) => s + d.value, 0);
  // Stacked columns and bars reach their group's total; separate lines, their own values.
  const max = Math.max(0, ...data.map((d) => (gProp && spec.type === "line" ? Math.max(0, ...(d.parts ?? []).map((p) => p.value)) : d.value)));
  const ticks = niceTicks(max, yFn === "count" || data.every((d) => Number.isInteger(d.value)));
  const top = ticks[ticks.length - 1] || 1;
  let chart: ReactNode = null;

  if (!data.length) chart = <div className="nt-panel-empty">{t("db.noResults")}</div>;
  else if (spec.type === "donut") {
    const r = Math.min(130, (Math.min(w, 520) - 40) / 2);
    const cx = r + 20;
    const cy = H / 2;
    // Slice angles, accumulated up front (no mutation inside render callbacks).
    const p = (a: number, rr: number) => `${cx + rr * Math.cos(a)} ${cy + rr * Math.sin(a)}`;
    const inner = r * 0.62;
    const arcs: { d: Datum; path: string; frac: number }[] = [];
    let a0 = -Math.PI / 2;
    for (const d of data) {
      const frac = total ? d.value / total : 0;
      const a1 = a0 + frac * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const path =
        frac >= 0.9999
          ? `M ${p(0, r)} A ${r} ${r} 0 1 1 ${p(Math.PI, r)} A ${r} ${r} 0 1 1 ${p(0, r)} M ${p(0, inner)} A ${inner} ${inner} 0 1 0 ${p(Math.PI, inner)} A ${inner} ${inner} 0 1 0 ${p(0, inner)} Z`
          : `M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, inner)} A ${inner} ${inner} 0 ${large} 0 ${p(a0, inner)} Z`;
      arcs.push({ d, path, frac });
      a0 = a1;
    }
    chart = (
      <div className="nt-chart-donut">
        <svg width={cx * 2} height={H} role="img" aria-label={view?.name}>
          {arcs.map(({ d, path }) => (
            <path key={d.key} d={path} fill={d.color} fillRule="evenodd" className="nt-chart-mark" onMouseMove={(e) => tipAt(e, d)} onMouseLeave={() => setTip(null)} />
          ))}
          <text x={cx} y={cy - 4} textAnchor="middle" className="nt-chart-total">
            {fmt(total)}
          </text>
          <text x={cx} y={cy + 16} textAnchor="middle" className="nt-chart-axis">
            {yFn === "count" ? t("chart.total") : yProp?.name}
          </text>
        </svg>
        <div className="nt-chart-legend">
          {arcs.map(({ d, frac }) => (
            <div key={d.key} className="nt-chart-legend-row">
              <span className="nt-chart-dot" style={{ background: d.color }} />
              <span className="nt-chart-legend-label">{d.label}</span>
              <span className="nt-chart-legend-value">
                {fmt(d.value)} · {Math.round(frac * 100)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  } else if (spec.type === "bar") {
    const left = Math.min(180, Math.max(80, ...data.map((d) => d.label.length * 7 + 16)));
    const rowH = 28;
    const h = data.length * rowH + 34;
    const plot = w - left - 40;
    chart = (
      <svg width={w} height={h} role="img" aria-label={view?.name}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={left + (v / top) * plot} x2={left + (v / top) * plot} y1={4} y2={h - 26} className="nt-chart-grid" />
            <text x={left + (v / top) * plot} y={h - 8} textAnchor="middle" className="nt-chart-axis">
              {fmt(v)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const y = 6 + i * rowH;
          // Negative sums draw no bar (a negative SVG width is an error).
          const bw = Math.max(d.value > 0 ? 2 : 0, (d.value / top) * plot, 0);
          return (
            <g key={d.key}>
              <text x={left - 8} y={y + rowH / 2} textAnchor="end" dominantBaseline="middle" className="nt-chart-label">
                {d.label.length > 24 ? `${d.label.slice(0, 23)}…` : d.label}
              </text>
              {d.parts ? (
                stack(d.parts).map((p) => (
                  <rect key={p.key} x={left + (p.from / top) * plot} y={y + 4} width={Math.max(0, (p.value / top) * plot)} height={rowH - 8} fill={p.color} className="nt-chart-mark" data-series={p.key} onMouseMove={(e) => tipAt(e, p)} onMouseLeave={() => setTip(null)} />
                ))
              ) : (
                <rect x={left} y={y + 4} width={bw} height={rowH - 8} rx={3} fill={d.color} className="nt-chart-mark" onMouseMove={(e) => tipAt(e, d)} onMouseLeave={() => setTip(null)} />
              )}
              {spec.labels && (
                <text x={left + bw + 6} y={y + rowH / 2} dominantBaseline="middle" className="nt-chart-value">
                  {fmt(d.value)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    );
  } else {
    const left = 48;
    const plotW = w - left - 16;
    const step = plotW / data.length;
    const slanted = data.length > 8 || data.some((d) => d.label.length * 7 > step);
    // Slanted labels need room below the axis.
    const longest = Math.min(18, Math.max(...data.map((d) => d.label.length)));
    const bottom = slanted ? Math.min(110, 30 + longest * 4.2) : 44;
    const plotH = H - bottom - 16;
    const yOf = (v: number) => 16 + plotH - (v / top) * plotH;
    chart = (
      <svg width={w} height={H} role="img" aria-label={view?.name}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={left} x2={w - 16} y1={yOf(v)} y2={yOf(v)} className="nt-chart-grid" />
            <text x={left - 8} y={yOf(v)} textAnchor="end" dominantBaseline="middle" className="nt-chart-axis">
              {fmt(v)}
            </text>
          </g>
        ))}
        {spec.type === "line" && gProp && (
          <>
            {series.map((sr, si) => (
              <path key={sr.key} d={`M ${data.map((d, i) => `${left + step * i + step / 2} ${yOf(d.parts?.[si]?.value ?? 0)}`).join(" L ")}`} className="nt-chart-line" style={{ stroke: sr.color }} data-series={sr.key} />
            ))}
          </>
        )}
        {spec.type === "line" && !gProp && (
          <>
            <path d={`M ${data.map((d, i) => `${left + step * i + step / 2} ${yOf(d.value)}`).join(" L ")} L ${left + step * (data.length - 1) + step / 2} ${yOf(0)} L ${left + step / 2} ${yOf(0)} Z`} className="nt-chart-area" />
            <path d={`M ${data.map((d, i) => `${left + step * i + step / 2} ${yOf(d.value)}`).join(" L ")}`} className="nt-chart-line" />
          </>
        )}
        {data.map((d, i) => {
          const x = left + step * i + step / 2;
          const bw = Math.min(56, step * 0.62);
          const label = d.label.length > 18 ? `${d.label.slice(0, 17)}…` : d.label;
          return (
            <g key={d.key}>
              {spec.type === "column" && d.parts ? (
                stack(d.parts).map((p) => (
                  <rect key={p.key} x={x - bw / 2} y={yOf(p.from + p.value)} width={bw} height={Math.max(0, yOf(p.from) - yOf(p.from + p.value))} fill={p.color} className="nt-chart-mark" data-series={p.key} onMouseMove={(e) => tipAt(e, p)} onMouseLeave={() => setTip(null)} />
                ))
              ) : spec.type === "column" ? (
                <rect x={x - bw / 2} y={yOf(d.value)} width={bw} height={Math.max(0, yOf(0) - yOf(d.value))} rx={3} fill={d.color} className="nt-chart-mark" onMouseMove={(e) => tipAt(e, d)} onMouseLeave={() => setTip(null)} />
              ) : d.parts ? (
                d.parts.map((p) => <circle key={p.key} cx={x} cy={yOf(p.value)} r={3.5} className="nt-chart-point" style={{ stroke: p.color }} onMouseMove={(e) => tipAt(e, p)} onMouseLeave={() => setTip(null)} />)
              ) : (
                <circle cx={x} cy={yOf(d.value)} r={4} className="nt-chart-point" onMouseMove={(e) => tipAt(e, d)} onMouseLeave={() => setTip(null)} />
              )}
              {spec.labels && (
                <text x={x} y={yOf(d.value) - 6} textAnchor="middle" className="nt-chart-value">
                  {fmt(d.value)}
                </text>
              )}
              <text x={x} y={H - bottom + 16} textAnchor={slanted ? "end" : "middle"} transform={slanted ? `rotate(-30 ${x} ${H - bottom + 16})` : undefined} className="nt-chart-label">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  return (
    <div className="nt-chart">
      {/* The chart settings are the shared view's: not for read-only members or a locked database. */}
      {!ctl.locked && toolbar}
      <div className="nt-chart-box" ref={box}>
        {chart}
        {tip && (
          <div className="nt-chart-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
            <span className="nt-chart-dot" style={{ background: tip.d.color }} />
            <b>{tip.d.of ? `${tip.d.of} · ${tip.d.label}` : tip.d.label}</b>
            <span>{fmt(tip.d.value)}</span>
          </div>
        )}
      </div>
      {ws && ctl.host && view && (
        <ChartGoals ws={ws} db={ctl.host.id} view={view.id} chartName={view.name} xProp={xProp.id} bars={data.map((d) => ({ key: d.key, label: d.label }))} canEdit={!ctl.api.readOnly} format={fmt} />
      )}
      {gProp && series.length > 0 && (
        <div className="nt-chart-legend nt-chart-legend-row-wrap" data-test="chart-legend">
          {series.map((sr) => (
            <span key={sr.key} className="nt-chart-legend-row">
              <span className="nt-chart-dot" style={{ background: sr.color }} />
              <span className="nt-chart-legend-label">{sr.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
