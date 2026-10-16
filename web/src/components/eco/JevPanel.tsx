"use client";

// Jev on Home: what runs the workspace by itself, in one place.
//
//   goals     every goal with where its number stands (a bar that fills as
//             the chart, the project or the number moves) — met ones ticked;
//   waiting   what Jev proposes and a person settles in one click;
//   done      what Jev did lately (goals met, goals linked, parents closed,
//             fields of new issues filled), each with Undo where it can;
//   switches  the owner decides what exact rules do by themselves.
//
// Everything follows the pulse: a number moving, a goal closing or a
// proposal arriving redraws the panel without a reload.

import { useCallback, useEffect, useState } from "react";
import { Check, CircleCheck, Settings2, Sparkles, Target, Undo2, X } from "lucide-react";
import { pulse, pulseHeaders } from "@/lib/pulse/client";
import { useI18n } from "@/lib/i18n-react";
import { intlTag, type Locale } from "@/i18n/locales";
import type { EcoKey } from "@/lib/eco/strings";
import { parseRefKey, refHref } from "@/lib/eco/refs";
import { useEt } from "./i18n";
import "./eco.css";

type Op = ">=" | ">" | "<=" | "<" | "=";
const OP_TEXT: Record<Op, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "=": "=" };

interface Goal {
  reaction: string;
  issue: { id: string; identifier: string; title: string; done: boolean };
  key: string;
  label: string | null;
  value: number | null;
  op: Op;
  target: number;
  met: boolean;
  progress: number | null;
  byJev: boolean;
}
interface Item {
  id: string;
  at: number;
  kind: "goal_met" | "goal_linked" | "parent_done" | "parent_reopened" | "issue_flow" | "automation" | "rule" | "autopilot";
  source: "jev" | "rule";
  status: string;
  confidence: number | null;
  subject: string;
  title: string;
  detail: Record<string, string | number | boolean | null>;
  canUndo: boolean;
  canResolve: boolean;
}
interface Data {
  overview: { jev: { configured: boolean; on: boolean; breakerOpen: boolean }; rules: { parents: boolean; goals: boolean; design: boolean; calendar: boolean }; ingest: boolean };
  goals: Goal[];
  activity: Item[];
  week: number;
}

async function call<T>(ws: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/decide?ws=${encodeURIComponent(ws)}${body ? "" : "&view=jev"}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "content-type": "application/json", ...pulseHeaders() } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

const fmt = (n: number, locale: Locale) => n.toLocaleString(intlTag(locale), { maximumFractionDigits: 2 });

function href(ws: string, subject: string, ident?: string): string | undefined {
  const r = parseRefKey(subject);
  return r ? refHref(r, ws, ident ? { ident } : {}) : undefined;
}

/** One line of the journal in words: what was done, to what. */
function sentence(et: ReturnType<typeof useEt>, it: Item, locale: Locale): string {
  const d = it.detail;
  const n = (v: unknown) => (typeof v === "number" ? fmt(v, locale) : String(v ?? ""));
  switch (it.kind) {
    case "goal_met":
      return et("jevActGoalMet", { title: String(d.issue ?? it.title) });
    case "goal_linked":
      return et(it.status === "pending" ? "jevActGoalProposed" : "jevActGoalLinked", { title: it.title, number: String(d.number ?? ""), op: OP_TEXT[(d.op as Op) ?? ">="] ?? "≥", target: n(d.target) });
    case "parent_done":
      return et("jevActParentDone", { title: it.title });
    case "parent_reopened":
      return et("jevActParentReopened", { title: it.title });
    case "issue_flow":
      if (d.why === "event_moved") return et("jevActEventMoved", { title: it.title, date: typeof d.due === "string" ? new Date(`${d.due}T12:00:00`).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short" }) : "" });
      return et(d.why === "thread_reopened" ? "jevActThreadReopened" : "jevActThreadResolved", { title: it.title });
    case "automation": {
      const name = String(d.automation || "⚡");
      if (it.status === "pending") return et("jevActAutomationWaits", { name, title: it.title });
      return et(d.scheduled ? "jevActAutomationScheduled" : "jevActAutomation", { name, title: it.title });
    }
    case "autopilot": {
      const field = et(`jevField_${String(d.field)}` as EcoKey);
      return et(it.status === "open" ? "jevActSuggests" : "jevActFilled", { field, title: it.title });
    }
    default:
      return et("jevActRule", { title: it.title });
  }
}

export function JevPanel({ ws, canEdit, owner }: { ws: string; canEdit: boolean; owner: boolean }) {
  const { locale } = useI18n();
  const et = useEt();
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [gear, setGear] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const load = useCallback(() => {
    call<Data>(ws)
      .then((d) => {
        setData(d);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [ws]);
  useEffect(() => {
    load();
    const leave = pulse().join(ws);
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 250);
    };
    const offs = [pulse().on("metric", soon), pulse().on("decision", soon), pulse().on("projects", soon), pulse().on("hello", soon)];
    return () => {
      if (t) clearTimeout(t);
      offs.forEach((f) => f());
      leave();
    };
  }, [ws, load]);

  const act = async (id: string, action: "accept" | "dismiss" | "undo") => {
    setBusy(id);
    try {
      await call(ws, { op: "settle", id, action });
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
      load();
    }
  };
  const setRule = async (patch: Partial<Data["overview"]["rules"]>) => {
    try {
      await call(ws, { op: "hub", ...patch });
    } catch {
      setFailed(true);
    }
    load();
  };

  const ingest = async (make: boolean) => {
    try {
      const r = await call<{ token?: string }>(ws, { op: make ? "token" : "untoken" });
      setKey(make ? (r.token ?? null) : null);
    } catch {
      setFailed(true);
    }
    load();
  };

  if (!data) return failed ? null : <section className="eco-jev" aria-busy="true" aria-label={et("jevTitle")} />;
  const { jev, rules } = data.overview;
  const waiting = data.activity.filter((a) => a.canResolve);
  const done = data.activity.filter((a) => !a.canResolve && (a.status === "applied" || a.status === "accepted" || a.status === "undone")).slice(0, 6);
  const week = data.week;
  const state = !jev.configured ? et("jevUnconfigured") : !jev.on ? et("jevOff") : jev.breakerOpen ? et("jevResting") : et("jevOn");
  const open = data.goals.filter((g) => !g.issue.done);
  const met = data.goals.filter((g) => g.issue.done).slice(0, 3);

  return (
    <section className="eco-jev" aria-labelledby="eh-jev">
      <div className="eco-jev-head">
        <span className="eco-jev-mark" aria-hidden>
          <Sparkles size={14} />
        </span>
        <h2 id="eh-jev">{et("jevTitle")}</h2>
        <span className="eco-jev-state" data-on={(jev.configured && jev.on) || undefined}>
          {state}
        </span>
        {week > 0 && <span className="eco-jev-week">{et("jevWeek", { n: week })}</span>}
        {owner && (
          <button type="button" className="eco-icon-btn" aria-expanded={gear} aria-label={et("jevSettings")} title={et("jevSettings")} onClick={() => setGear((v) => !v)}>
            <Settings2 size={14} />
          </button>
        )}
      </div>
      {owner && gear && (
        <div className="eco-jev-settings" role="group" aria-label={et("jevSettings")}>
          <label>
            <input type="checkbox" checked={rules.goals} onChange={(e) => void setRule({ goals: e.target.checked })} />
            {et("jevAutoGoals")}
          </label>
          <label>
            <input type="checkbox" checked={rules.parents} onChange={(e) => void setRule({ parents: e.target.checked })} />
            {et("jevParents")}
          </label>
          <label>
            <input type="checkbox" checked={rules.design} onChange={(e) => void setRule({ design: e.target.checked })} />
            {et("jevDesign")}
          </label>
          <label>
            <input type="checkbox" checked={rules.calendar} onChange={(e) => void setRule({ calendar: e.target.checked })} />
            {et("jevCalendar")}
          </label>
          <div className="eco-jev-ingest">
            <b>{et("jevIngest")}</b>
            <p className="eco-jev-empty">{et("jevIngestHint")}</p>
            {key && (
              <>
                <p className="eco-jev-empty">{et("jevIngestShown")}</p>
                <pre className="eco-jev-code" data-test="jev-ingest-example">{`curl -X POST ${typeof location === "undefined" ? "" : location.origin}/api/pulse/ingest \\
  -H "Authorization: Bearer ${key}" \\
  -H "content-type: application/json" \\
  -d '{"metric":"signups","value":120,"label":"Signups"}'`}</pre>
              </>
            )}
            <span className="eco-jev-acts">
              <button type="button" className="eco-btn eco-btn-ghost" onClick={() => void ingest(true)}>
                {et("jevIngestNew")}
              </button>
              {(data.overview.ingest || key) && (
                <button type="button" className="eco-btn eco-btn-ghost" onClick={() => void ingest(false)}>
                  {et("jevIngestRevoke")}
                </button>
              )}
            </span>
          </div>
        </div>
      )}

      <div className="eco-jev-block">
        <h3>
          <Target size={13} aria-hidden /> {et("jevGoals")}
        </h3>
        {open.length === 0 && met.length === 0 ? (
          <p className="eco-jev-empty">{et("jevGoalsEmpty")}</p>
        ) : (
          <ul className="eco-jev-goals">
            {[...open, ...met].map((g) => (
              <li key={g.reaction} data-met={g.issue.done || undefined}>
                <a className="eco-jev-goal-title" href={href(ws, `issue:${g.issue.id}`, g.issue.identifier)}>
                  {g.issue.done ? <CircleCheck size={14} aria-hidden /> : <Target size={14} aria-hidden />}
                  <span className="eco-jev-id">{g.issue.identifier}</span>
                  <span className="eco-jev-text">{g.issue.title}</span>
                  {g.byJev && <span className="eco-jev-chip">{et("jevByJev")}</span>}
                </a>
                <span className="eco-jev-goal-num">
                  {g.label || g.key} {g.value === null ? "—" : fmt(g.value, locale)} {OP_TEXT[g.op]} {fmt(g.target, locale)}
                </span>
                {g.progress !== null && (
                  <span className="eco-goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(g.progress * 100)} aria-label={g.issue.title}>
                    <span style={{ width: `${Math.round(g.progress * 100)}%` }} data-full={g.progress >= 1 || undefined} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {waiting.length > 0 && (
        <div className="eco-jev-block">
          <h3>{et("jevWaiting", { n: waiting.length })}</h3>
          <ul className="eco-jev-items">
            {waiting.slice(0, 5).map((it) => (
              <li key={it.id}>
                <a href={href(ws, it.subject)} className="eco-jev-text">
                  {sentence(et, it, locale)}
                </a>
                {it.confidence !== null && <span className="eco-jev-sure">{et("jevSure", { p: Math.round(it.confidence * 100) })}</span>}
                {canEdit && (
                  <span className="eco-jev-acts">
                    <button type="button" className="eco-btn eco-btn-primary" disabled={busy === it.id} onClick={() => void act(it.id, "accept")}>
                      <Check size={13} aria-hidden /> {et("jevAccept")}
                    </button>
                    <button type="button" className="eco-icon-btn" disabled={busy === it.id} aria-label={et("jevDismiss")} title={et("jevDismiss")} onClick={() => void act(it.id, "dismiss")}>
                      <X size={14} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="eco-jev-block">
        <h3>{et("jevRecent")}</h3>
        {done.length === 0 ? (
          <p className="eco-jev-empty">{et("jevRecentEmpty")}</p>
        ) : (
          <ul className="eco-jev-items">
            {done.map((it) => (
              <li key={it.id} data-undone={it.status === "undone" || undefined}>
                <a href={href(ws, it.subject)} className="eco-jev-text">
                  {sentence(et, it, locale)}
                </a>
                <time className="eco-jev-when" dateTime={new Date(it.at).toISOString()}>
                  {new Date(it.at).toLocaleTimeString(intlTag(locale), { hour: "2-digit", minute: "2-digit" })}
                </time>
                {it.status === "undone" ? (
                  <span className="eco-jev-sure">{et("jevUndone")}</span>
                ) : (
                  canEdit &&
                  it.canUndo && (
                    <button type="button" className="eco-icon-btn" disabled={busy === it.id} aria-label={et("jevUndo")} title={et("jevUndo")} onClick={() => void act(it.id, "undo")}>
                      <Undo2 size={14} />
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {failed && <p className="eco-jev-empty">{et("failed")}</p>}
    </section>
  );
}
