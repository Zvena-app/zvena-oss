"use client";

// A goal is an issue that closes itself: "close when MRR ≥ 1 000". The
// condition is a reaction of the workspace (lib/decide): when the live number
// reaches the target, the issue moves to done and the documents linked to it
// are marked done too. Here it reads as a sentence with a progress bar that
// fills as the number moves.

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Sparkles, Target, X } from "lucide-react";
import { pulse, pulseHeaders } from "@/lib/pulse/client";
import type { EcoKey } from "@/lib/eco/strings";
import { useEt } from "./i18n";
import { useI18n } from "@/lib/i18n-react";
import { intlTag, type Locale } from "@/i18n/locales";
import "./eco.css";

type Op = ">=" | ">" | "<=" | "<" | "=";
interface Metric {
  key: string;
  value: number;
  label: string | null;
  at: number;
  /** Counted from the workspace itself (a database, a chart, a project): it moves by itself. */
  source?: { kind: string } | null;
}
interface Proposal {
  id: string;
  subject: string;
  source: "jev" | "rule";
  confidence: number | null;
  detail: Record<string, string | number | boolean | null>;
}
interface Reaction {
  id: string;
  name: string;
  on: boolean;
  when: { type: string; key?: string };
  if: { kind: string; field?: string; op?: Op; value?: number | string | boolean };
  then: { do: string; issue?: string; from?: string }[];
}

const OPS: Op[] = [">=", ">", "<=", "<", "="];
const OP_TEXT: Record<Op, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "=": "=" };

function fmt(n: number, locale: Locale): string {
  return n.toLocaleString(intlTag(locale), { maximumFractionDigits: 2 });
}

async function decide<T>(ws: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/decide?ws=${encodeURIComponent(ws)}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "content-type": "application/json", ...pulseHeaders() } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

function slug(name: string): string {
  return (
    name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "number"
  );
}

function Progress({ now, target, op }: { now: number | undefined; target: number; op: Op }) {
  if (now === undefined || (op !== ">=" && op !== ">") || target <= 0) return null;
  const pct = Math.max(0, Math.min(1, now / target));
  return (
    <span className="eco-goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={now}>
      <span style={{ width: `${Math.round(pct * 100)}%` }} data-full={pct >= 1 || undefined} />
    </span>
  );
}

export function GoalCondition({ ws, issueId, canEdit }: { ws: string; issueId: string; canEdit: boolean }) {
  const { locale } = useI18n();
  const et = useEt();
  const [data, setData] = useState<{ reactions: Reaction[]; metrics: Metric[]; proposals: Proposal[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const [editing, setEditing] = useState(false);
  const [setting, setSetting] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    decide<{ reactions: Reaction[]; metrics: Metric[]; proposals?: Proposal[] }>(ws)
      .then((d) => setData({ reactions: d.reactions, metrics: d.metrics, proposals: d.proposals ?? [] }))
      .catch(() => setData({ reactions: [], metrics: [], proposals: [] }));
  }, [ws]);
  useEffect(() => {
    load();
    const leave = pulse().join(ws);
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 200);
    };
    // The number moves (a metric) or a rule acted (a decision): the bar follows.
    const offs = [pulse().on("metric", soon), pulse().on("decision", soon), pulse().on("hello", soon)];
    return () => {
      if (t) clearTimeout(t);
      offs.forEach((f) => f());
      leave();
    };
  }, [ws, load]);
  const goals = (data?.reactions ?? []).filter((r) => r.when.type === "metric" && r.if.kind === "compare" && r.then.some((a) => a.do === "issue.done" && a.issue === issueId));
  const metric = (key?: string) => data?.metrics.find((m) => m.key === key);
  const proposal = (data?.proposals ?? []).find((p) => p.subject === `issue:${issueId}`);
  const settle = async (id: string, action: "accept" | "dismiss") => {
    try {
      await decide(ws, { op: "settle", id, action });
    } catch {
      setError(true);
    }
    load();
  };
  // Jev looks for the live number that measures this goal (the title's target, the workspace's numbers).
  const askJev = async () => {
    setAsking(true);
    setNoMatch(false);
    try {
      const r = await decide<{ status: string }>(ws, { op: "findGoal", issue: issueId });
      if (r.status === "none") setNoMatch(true);
    } catch {
      setError(true);
    } finally {
      setAsking(false);
      load();
    }
  };
  const remove = async (id: string) => {
    try {
      await decide(ws, { op: "delete", id });
      load();
    } catch {
      setError(true);
    }
  };
  if (!data || (!goals.length && !canEdit && !proposal)) return null;
  return (
    <div className="eco-goal">
      <div className="eco-related-head">
        <Target size={14} />
        <span>{et("goal")}</span>
      </div>
      {goals.map((g) => {
        const m = metric(g.when.key);
        const target = Number(g.if.value);
        const op = (g.if.op ?? ">=") as Op;
        const reached = m !== undefined && (op === ">=" ? m.value >= target : op === ">" ? m.value > target : op === "<=" ? m.value <= target : op === "<" ? m.value < target : m.value === target);
        return (
          <div key={g.id} className="eco-goal-row" data-reached={reached || undefined}>
            <span className="eco-goal-text">
              {et("goalCloses")} <b>{m?.label || g.when.key}</b> {OP_TEXT[op]} <b>{fmt(target, locale)}</b>
            </span>
            <Progress now={m?.value} target={target} op={op} />
            {canEdit && setting === g.id ? (
              <NowEditor
                ws={ws}
                metricKey={g.when.key ?? ""}
                value={m?.value}
                onDone={() => {
                  setSetting(null);
                  load();
                }}
                onError={() => setError(true)}
              />
            ) : (
              <span className="eco-goal-now">{m ? (reached ? `${et("goalReached")} · ${fmt(m.value, locale)}` : fmt(m.value, locale)) : "—"}</span>
            )}
            {m?.source && <span className="eco-goal-live">{et("goalLive")}</span>}
            {canEdit && setting !== g.id && !m?.source && (
              <button type="button" className="eco-icon-btn" title={et("goalUpdate")} aria-label={et("goalUpdate")} onClick={() => setSetting(g.id)}>
                <Pencil size={13} />
              </button>
            )}
            {canEdit && (
              <button type="button" className="eco-icon-btn" title={et("goalRemove")} aria-label={et("goalRemove")} onClick={() => void remove(g.id)}>
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
      {proposal && goals.length === 0 && (
        <div className="eco-goal-row eco-goal-proposal">
          <Sparkles size={14} aria-hidden />
          <span className="eco-goal-text">
            {et(proposal.source === "jev" ? "goalProposal" : "goalProposalRule", {
              number: String(proposal.detail.number ?? ""),
              op: OP_TEXT[(proposal.detail.op as Op) ?? ">="] ?? "≥",
              target: typeof proposal.detail.target === "number" ? fmt(proposal.detail.target, locale) : "",
            })}
            {proposal.confidence !== null && <span className="eco-goal-now"> · {et("jevSure", { p: Math.round(proposal.confidence * 100) })}</span>}
          </span>
          {canEdit && (
            <>
              <button type="button" className="eco-btn eco-btn-primary" onClick={() => void settle(proposal.id, "accept")}>
                <Check size={13} aria-hidden /> {et("jevAccept")}
              </button>
              <button type="button" className="eco-icon-btn" title={et("jevDismiss")} aria-label={et("jevDismiss")} onClick={() => void settle(proposal.id, "dismiss")}>
                <X size={14} />
              </button>
            </>
          )}
        </div>
      )}
      {canEdit && !editing && goals.length === 0 && (
        <div className="eco-goal-start">
          <button type="button" className="eco-btn eco-btn-ghost" onClick={() => setEditing(true)}>
            <Target size={14} />
            {et("goalAdd")}
          </button>
          {!proposal && (
            <button type="button" className="eco-btn eco-btn-ghost" disabled={asking} onClick={() => void askJev()}>
              <Sparkles size={14} />
              {et("goalAskJev")}
            </button>
          )}
          {noMatch && <span className="eco-related-note">{et("goalJevNone")}</span>}
        </div>
      )}
      {canEdit && editing && (
        <GoalForm
          ws={ws}
          issueId={issueId}
          metrics={data.metrics}
          onDone={() => {
            setEditing(false);
            load();
          }}
          onError={() => setError(true)}
        />
      )}
      {error && <div className="eco-related-note">{et("failed")}</div>}
    </div>
  );
}

/** The live number typed in by hand (when no analytics or script feeds it). */
function NowEditor({ ws, metricKey, value, onDone, onError }: { ws: string; metricKey: string; value: number | undefined; onDone: () => void; onError: () => void }) {
  const et = useEt();
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [busy, setBusy] = useState(false);
  const n = Number(text.replace(/\s/g, "").replace(",", "."));
  const ok = text.trim() !== "" && Number.isFinite(n);
  return (
    <form
      className="eco-goal-set"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || busy) return;
        setBusy(true);
        decide(ws, { op: "metric", key: metricKey, value: n })
          .then(onDone, onError)
          .finally(() => setBusy(false));
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" aria-label={et("goalNow")} autoFocus onKeyDown={(e) => e.key === "Escape" && onDone()} />
      <button type="submit" className="eco-icon-btn" title={et("goalSave")} aria-label={et("goalSave")} disabled={!ok || busy}>
        <Check size={14} />
      </button>
    </form>
  );
}

interface Pickers {
  databases: {
    id: string;
    title: string;
    views: { id: string; name: string; type: string; chart?: { fn: string; prop?: string } }[];
    props: { id: string; name: string; type: string; options?: { id: string; name: string }[] }[];
  }[];
  projects: { id: string; name: string }[];
  calendars?: { id: string; name: string }[];
  mail?: { id: string; name: string; system: boolean }[];
}
type From = "number" | "db" | "project" | "calendar" | "mail";
const FNS = ["count", "sum", "average", "median", "min", "max"] as const;
const MEASURES = ["percent", "done", "total", "open"] as const;
const PERIODS = ["today", "week", "month", "last30", "next7"] as const;
const NUMERIC = new Set(["number", "formula", "rollup"]);

function GoalForm({ ws, issueId, metrics, onDone, onError }: { ws: string; issueId: string; metrics: Metric[]; onDone: () => void; onError: () => void }) {
  const { locale } = useI18n();
  const et = useEt();
  const NEW = "__new__";
  const typed = metrics.filter((m) => !m.source);
  // A number counted from the workspace is the first thing offered: it needs no typing later.
  const [from, setFrom] = useState<From>("db");
  const [key, setKey] = useState(metrics[0]?.key ?? NEW);
  const [name, setName] = useState("");
  const [now, setNow] = useState("");
  const [op, setOp] = useState<Op>(">=");
  const [target, setTarget] = useState("");
  const [docs, setDocs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Pickers | null>(null);
  const [db, setDb] = useState("");
  const [view, setView] = useState("");
  const [fn, setFn] = useState<(typeof FNS)[number]>("count");
  const [prop, setProp] = useState("");
  const [where, setWhere] = useState("");
  const [project, setProject] = useState("");
  const [measure, setMeasure] = useState<(typeof MEASURES)[number]>("percent");
  const [cal, setCal] = useState("");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("week");
  const [calMeasure, setCalMeasure] = useState<"events" | "hours">("events");
  const [match, setMatch] = useState("");
  const [mailView, setMailView] = useState("inbox");
  const [mailMeasure, setMailMeasure] = useState<"unread" | "total">("unread");
  useEffect(() => {
    fetch(`/api/decide?ws=${encodeURIComponent(ws)}&view=pickers`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Pickers>) : Promise.reject(new Error(String(r.status)))))
      .then((p) => {
        setPick(p);
        const first = p.databases[0];
        if (first) setDb(first.id);
        if (p.projects[0]) setProject(p.projects[0].id);
        if (p.calendars?.[0]) setCal(p.calendars[0].id);
        if (p.mail?.[0]) setMailView(p.mail[0].id);
        if (!first) setFrom(p.projects.length ? "project" : "number");
      })
      .catch(() => {
        setPick({ databases: [], projects: [] });
        setFrom("number");
      });
  }, [ws]);
  const base = pick?.databases.find((d) => d.id === db);
  const numbers = (base?.props ?? []).filter((p) => NUMERIC.has(p.type));
  const groups = (base?.props ?? []).flatMap((p) =>
    p.type === "checkbox" ? [{ v: `${p.id}|__on`, label: `${p.name}: ✓` }] : (p.options ?? []).map((o) => ({ v: `${p.id}|${o.id}`, label: `${p.name}: ${o.name}` }))
  );
  // A chart view brings its own calculation (what the chart adds up).
  const chooseView = (id: string) => {
    setView(id);
    const c = base?.views.find((v) => v.id === id)?.chart;
    if (c) {
      setFn((FNS as readonly string[]).includes(c.fn) ? (c.fn as (typeof FNS)[number]) : "count");
      setProp(c.prop ?? "");
    }
  };
  const num = (s: string) => Number(s.replace(/\s/g, "").replace(",", "."));
  const taken = from === "number" && key === NEW && name.trim() !== "" && metrics.some((m) => m.key === slug(name) || (m.label ?? "").trim().toLowerCase() === name.trim().toLowerCase());
  const measured =
    from === "number"
      ? key !== NEW || (name.trim() && Number.isFinite(num(now)) && !taken)
      : from === "db"
        ? Boolean(base) && (fn === "count" || numbers.some((p) => p.id === prop))
        : from === "calendar"
          ? Boolean(cal)
          : from === "mail"
            ? Boolean(pick?.mail?.some((v) => v.id === mailView))
            : Boolean(project);
  const ready = measured && target.trim() !== "" && Number.isFinite(num(target));
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const goal: Record<string, unknown> = { op: "goal", issue: issueId, cmp: op, target: num(target), docs };
      if (from === "number") {
        let metricKey = key;
        if (key === NEW) {
          metricKey = slug(name);
          await decide(ws, { op: "metric", key: metricKey, value: num(now), label: name.trim() });
        }
        goal.key = metricKey;
      } else if (from === "db") {
        const [wp, wk] = where ? where.split("|") : [];
        goal.source = { kind: "docs", db, ...(view ? { view } : {}), fn, ...(fn !== "count" ? { prop } : {}), ...(wp ? { where: { prop: wp, key: wk } } : {}) };
      } else if (from === "calendar") goal.source = { kind: "calendar", cal, period, measure: calMeasure, ...(match.trim() ? { match: match.trim() } : {}) };
      else if (from === "mail") goal.source = { kind: "mail", view: mailView, measure: mailMeasure };
      else goal.source = { kind: "project", project, measure };
      await decide(ws, goal);
      onDone();
    } catch {
      onError();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="eco-goal-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="eco-related-note" style={{ padding: 0 }}>
        {et("goalHint")}
      </p>
      <div className="eco-goal-from" role="radiogroup" aria-label={et("goalFrom")}>
        {(["db", "project", "calendar", "mail", "number"] as From[])
          // Mail only for someone who has a mailbox here.
          .filter((f) => f !== "mail" || (pick?.mail?.length ?? 0) > 0)
          .map((f) => (
            <label key={f} data-on={from === f || undefined}>
              <input type="radio" name={`goal-from-${issueId}`} checked={from === f} onChange={() => setFrom(f)} />
              {et(f === "db" ? "goalFromDb" : f === "project" ? "goalFromProject" : f === "calendar" ? "goalFromCalendar" : f === "mail" ? "goalFromMail" : "goalFromNumber")}
            </label>
          ))}
      </div>
      <div className="eco-goal-fields">
        {from === "number" && (
          <>
            <label>
              <span>{et("goalNumber")}</span>
              <select value={key} onChange={(e) => setKey(e.target.value)}>
                {typed.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label || m.key} ({fmt(m.value, locale)})
                  </option>
                ))}
                <option value={NEW}>{et("goalNewNumber")}</option>
              </select>
            </label>
            {key === NEW && (
              <>
                <label>
                  <span>{et("goalName")}</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="MRR" maxLength={120} aria-invalid={taken || undefined} />
                  {taken && <small className="eco-goal-taken">{et("goalNameTaken")}</small>}
                </label>
                <label>
                  <span>{et("goalNow")}</span>
                  <input value={now} onChange={(e) => setNow(e.target.value)} inputMode="decimal" placeholder="0" />
                </label>
              </>
            )}
          </>
        )}
        {from === "db" &&
          (pick && !pick.databases.length ? (
            <p className="eco-related-note">{et("goalNoDbs")}</p>
          ) : (
            <>
              <label>
                <span>{et("goalDb")}</span>
                <select
                  value={db}
                  onChange={(e) => {
                    setDb(e.target.value);
                    setView("");
                    setProp("");
                    setWhere("");
                  }}
                >
                  {(pick?.databases ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title || et("untitled")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{et("goalView")}</span>
                <select value={view} onChange={(e) => chooseView(e.target.value)}>
                  <option value="">{et("goalViewAll")}</option>
                  {(base?.views ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name || v.type}
                      {v.chart ? " · 📊" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{et("goalCalc")}</span>
                <select value={fn} onChange={(e) => setFn(e.target.value as (typeof FNS)[number])}>
                  {FNS.filter((f) => f === "count" || numbers.length).map((f) => (
                    <option key={f} value={f}>
                      {et(`calc_${f}`)}
                    </option>
                  ))}
                </select>
              </label>
              {fn !== "count" && (
                <label>
                  <span>{et("goalColumn")}</span>
                  <select value={prop} onChange={(e) => setProp(e.target.value)}>
                    <option value="" disabled>
                      …
                    </option>
                    {numbers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {groups.length > 0 && (
                <label>
                  <span>{et("goalOnly")}</span>
                  <select value={where} onChange={(e) => setWhere(e.target.value)}>
                    <option value="">{et("goalOnlyAll")}</option>
                    {groups.map((x) => (
                      <option key={x.v} value={x.v}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          ))}
        {from === "project" &&
          (pick && !pick.projects.length ? (
            <p className="eco-related-note">{et("goalNoProjects")}</p>
          ) : (
            <>
              <label>
                <span>{et("goalProject")}</span>
                <select value={project} onChange={(e) => setProject(e.target.value)}>
                  {(pick?.projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{et("goalMeasure")}</span>
                <select value={measure} onChange={(e) => setMeasure(e.target.value as (typeof MEASURES)[number])}>
                  {MEASURES.map((m) => (
                    <option key={m} value={m}>
                      {et(`measure_${m}`)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ))}
        {from === "calendar" &&
          (pick && !pick.calendars?.length ? (
            <p className="eco-related-note">{et("goalNoCalendars")}</p>
          ) : (
            <>
              <label>
                <span>{et("goalCalendar")}</span>
                <select value={cal} onChange={(e) => setCal(e.target.value)}>
                  {(pick?.calendars ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || et("untitled")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{et("goalPeriod")}</span>
                <select value={period} onChange={(e) => setPeriod(e.target.value as (typeof PERIODS)[number])}>
                  {PERIODS.map((p) => (
                    <option key={p} value={p}>
                      {et(`period_${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{et("goalCalMeasure")}</span>
                <select value={calMeasure} onChange={(e) => setCalMeasure(e.target.value === "hours" ? "hours" : "events")}>
                  <option value="events">{et("calMeasure_events")}</option>
                  <option value="hours">{et("calMeasure_hours")}</option>
                </select>
              </label>
              <label>
                <span>{et("goalMatch")}</span>
                <input value={match} onChange={(e) => setMatch(e.target.value)} maxLength={60} placeholder={et("goalMatchAny")} />
              </label>
            </>
          ))}
        {from === "mail" && (
          <>
            <label>
              <span>{et("goalMailView")}</span>
              <select value={mailView} onChange={(e) => setMailView(e.target.value)}>
                {(pick?.mail ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.system ? et(`mailView_${v.id}` as EcoKey) : v.name || et("untitled")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{et("goalCalMeasure")}</span>
              <select value={mailMeasure} onChange={(e) => setMailMeasure(e.target.value === "total" ? "total" : "unread")}>
                <option value="unread">{et("mailMeasure_unread")}</option>
                <option value="total">{et("mailMeasure_total")}</option>
              </select>
            </label>
            <p className="eco-related-note" style={{ flexBasis: "100%", padding: 0 }}>
              {et("goalMailPrivate")}
            </p>
          </>
        )}
        <label>
          <span>&nbsp;</span>
          <select value={op} onChange={(e) => setOp(e.target.value as Op)} aria-label={et("goalOp")}>
            {OPS.map((o) => (
              <option key={o} value={o}>
                {OP_TEXT[o]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{et("goalTarget")}</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder={from === "project" && measure === "percent" ? "100" : "1000"} />
        </label>
      </div>
      <label className="eco-goal-check">
        <input type="checkbox" checked={docs} onChange={(e) => setDocs(e.target.checked)} />
        {et("goalAlsoDocs")}
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="eco-btn eco-btn-primary" disabled={!ready || busy}>
          {et("goalSave")}
        </button>
        <button type="button" className="eco-btn eco-btn-ghost" onClick={onDone}>
          {et("goalCancel")}
        </button>
      </div>
    </form>
  );
}
