"use client";

// Goals on a Documents chart (database chart view). Under the chart: each goal
// set on it, with where the chart stands, filling as rows change; and "Set a
// goal": a target for the whole chart or one of its bars. The goal is an issue
// in Projects (linked to the database) that closes by itself when the chart
// gets there — the chart's number is counted on the server as the rows change
// (lib/decide/sources.ts), so nobody has to open the page for it to happen.

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, Target } from "lucide-react";
import { pulse, pulseHeaders } from "@/lib/pulse/client";
import { refHref } from "@/lib/eco/refs";
import { useI18n } from "@/lib/i18n-react";
import { intlTag } from "@/i18n/locales";
import { Popover } from "@/components/notes/ui";
import { useEt } from "./i18n";
import "./eco.css";

type Op = ">=" | "<=";
interface Goal {
  reaction: string;
  issue: { id: string; identifier: string; title: string; done: boolean };
  value: number | null;
  op: string;
  target: number;
  met: boolean;
  progress: number | null;
  source: { kind: string; db?: string; view?: string; where?: { prop: string; key: string } } | null;
}

async function post<T>(ws: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/decide?ws=${encodeURIComponent(ws)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...pulseHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

export function ChartGoals({
  ws,
  db,
  view,
  chartName,
  xProp,
  bars,
  canEdit,
  format,
}: {
  ws: string;
  db: string;
  view: string;
  chartName: string;
  /** The chart's X property: a bar is one of its groups. */
  xProp: string | null;
  bars: { key: string; label: string }[];
  canEdit: boolean;
  format: (n: number) => string;
}) {
  const et = useEt();
  const { locale } = useI18n();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const load = useCallback(() => {
    fetch(`/api/decide?ws=${encodeURIComponent(ws)}&view=goals`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ goals: Goal[] }>) : { goals: [] }))
      .then((d) => setGoals(d.goals.filter((g) => g.source?.kind === "docs" && g.source.db === db && g.source.view === view)))
      .catch(() => setGoals([]));
  }, [ws, db, view]);
  useEffect(() => {
    load();
    const leave = pulse().join(ws);
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 300);
    };
    const offs = [pulse().on("metric", soon), pulse().on("decision", soon), pulse().on("hello", soon)];
    return () => {
      if (t) clearTimeout(t);
      offs.forEach((f) => f());
      leave();
    };
  }, [ws, load]);

  if (!goals.length && !canEdit) return null;
  const barName = (g: Goal) => (g.source?.where ? (bars.find((b) => b.key === g.source?.where?.key)?.label ?? "") : "");
  return (
    <div className="eco-chart-goals eco-root" data-test="chart-goals">
      {goals.map((g) => (
        <a key={g.reaction} className="eco-chart-goal" data-met={g.issue.done || undefined} href={refHref({ kind: "issue", id: g.issue.id }, ws, { ident: g.issue.identifier })}>
          {g.issue.done ? <CircleCheck size={14} aria-hidden /> : <Target size={14} aria-hidden />}
          <span className="eco-hub-id">{g.issue.identifier}</span>
          <span className="eco-chart-goal-text">
            {barName(g) ? `${barName(g)}: ` : ""}
            {g.value === null ? "—" : format(g.value)} {g.op === "<=" ? "≤" : g.op === "<" ? "<" : g.op === ">" ? ">" : "≥"} {format(g.target)}
            {g.issue.done ? ` · ${et("goalReached")}` : ""}
          </span>
          {g.progress !== null && (
            <span className="eco-goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(g.progress * 100)} aria-label={g.issue.title}>
              <span style={{ width: `${Math.round(g.progress * 100)}%` }} data-full={g.progress >= 1 || undefined} />
            </span>
          )}
        </a>
      ))}
      {canEdit && (
        <button type="button" className="eco-btn eco-btn-ghost eco-chart-goal-add" data-test="chart-goal-add" onClick={(e) => setAnchor(e.currentTarget)}>
          <Target size={14} aria-hidden /> {et("chartGoal")}
        </button>
      )}
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <GoalForm
            ws={ws}
            db={db}
            view={view}
            chartName={chartName}
            xProp={xProp}
            bars={bars}
            locale={intlTag(locale)}
            onDone={() => {
              setAnchor(null);
              load();
            }}
          />
        </Popover>
      )}
    </div>
  );
}

function GoalForm({ ws, db, view, chartName, xProp, bars, locale, onDone }: { ws: string; db: string; view: string; chartName: string; xProp: string | null; bars: { key: string; label: string }[]; locale: string; onDone: () => void }) {
  const et = useEt();
  const [bar, setBar] = useState("");
  const [op, setOp] = useState<Op>(">=");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const n = Number(target.replace(/\s/g, "").replace(",", "."));
  const ok = target.trim() !== "" && Number.isFinite(n);
  const what = bar ? `${chartName} · ${bars.find((b) => b.key === bar)?.label ?? ""}` : chartName;
  const suggested = ok ? et("chartGoalTitle", { chart: what || et("chartGoalChart"), op: op === ">=" ? "≥" : "≤", target: n.toLocaleString(locale) }) : "";
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(false);
    try {
      await post(ws, { op: "chartGoal", db, view, cmp: op, target: n, title: title.trim() || suggested, locale: document.documentElement.lang || "en", ...(bar && xProp ? { bar: { prop: xProp, key: bar } } : {}) });
      onDone();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="eco-goal-form eco-chart-goal-form eco-root"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="eco-related-note" style={{ padding: 0 }}>
        {et("chartGoalHint")}
      </p>
      <div className="eco-goal-fields">
        {bars.length > 0 && xProp && (
          <label>
            <span>{et("chartGoalBar")}</span>
            <select value={bar} onChange={(e) => setBar(e.target.value)}>
              <option value="">{et("chartGoalWhole")}</option>
              {bars.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>&nbsp;</span>
          <select value={op} onChange={(e) => setOp(e.target.value as Op)} aria-label={et("goalOp")}>
            <option value=">=">≥</option>
            <option value="<=">≤</option>
          </select>
        </label>
        <label>
          <span>{et("goalTarget")}</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="1000" autoFocus data-test="chart-goal-target" />
        </label>
      </div>
      <label className="eco-chart-goal-name">
        <span>{et("chartGoalName")}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={suggested || chartName} maxLength={300} />
      </label>
      {error && <div className="eco-related-note">{et("failed")}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="eco-btn eco-btn-primary" disabled={!ok || busy} data-test="chart-goal-save">
          {et("chartGoalCreate")}
        </button>
        <button type="button" className="eco-btn eco-btn-ghost" onClick={onDone}>
          {et("goalCancel")}
        </button>
      </div>
    </form>
  );
}
