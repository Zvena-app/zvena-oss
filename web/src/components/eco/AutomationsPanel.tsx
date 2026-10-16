"use client";

// Automations on Home: what runs in the workspace by itself, in one place.
//
//   goals     every goal with where its number stands (a bar that fills as
//             the chart, the project or the number moves) — met ones ticked;
//   waiting   suggestions a person settles in one click;
//   done      what was done automatically lately (goals met, goals linked, parents closed,
//             fields of new issues filled), each with Undo where it can;
//   switches  the owner decides what exact rules do by themselves.
//
// Everything follows the pulse: a number moving, a goal closing or a
// proposal arriving redraws the panel without a reload.

import { useCallback, useEffect, useState } from "react";
import { Check, CircleCheck, Settings2, Target, Undo2, X } from "lucide-react";
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
}
interface Item {
  id: string;
  at: number;
  kind: "goal_met" | "goal_linked" | "parent_done" | "parent_reopened" | "issue_flow" | "automation" | "rule" | "autopilot";
  source: "model" | "rule";
  status: string;
  confidence: number | null;
  subject: string;
  title: string;
  detail: Record<string, string | number | boolean | null>;
  canUndo: boolean;
  canResolve: boolean;
}
interface Data {
  overview: { rules: { parents: boolean; goals: boolean; design: boolean; calendar: boolean }; ingest: boolean };
  goals: Goal[];
  activity: Item[];
}

async function call<T>(ws: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/decide?ws=${encodeURIComponent(ws)}${body ? "" : "&view=hub"}`, {
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
      return et("autoActGoalMet", { title: String(d.issue ?? it.title) });
    case "goal_linked":
      return et(it.status === "pending" ? "autoActGoalProposed" : "autoActGoalLinked", { title: it.title, number: String(d.number ?? ""), op: OP_TEXT[(d.op as Op) ?? ">="] ?? "≥", target: n(d.target) });
    case "parent_done":
      return et("autoActParentDone", { title: it.title });
    case "parent_reopened":
      return et("autoActParentReopened", { title: it.title });
    case "issue_flow":
      if (d.why === "event_moved") return et("autoActEventMoved", { title: it.title, date: typeof d.due === "string" ? new Date(`${d.due}T12:00:00`).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short" }) : "" });
      return et(d.why === "thread_reopened" ? "autoActThreadReopened" : "autoActThreadResolved", { title: it.title });
    case "automation": {
      const name = String(d.automation || "⚡");
      if (it.status === "pending") return et("autoActAutomationWaits", { name, title: it.title });
      return et(d.scheduled ? "autoActAutomationScheduled" : "autoActAutomation", { name, title: it.title });
    }
    case "autopilot": {
      const field = et(`autoField_${String(d.field)}` as EcoKey);
      return et(it.status === "open" ? "autoActSuggests" : "autoActFilled", { field, title: it.title });
    }
    default:
      return et("autoActRule", { title: it.title });
  }
}

export function AutomationsPanel({ ws, canEdit, owner }: { ws: string; canEdit: boolean; owner: boolean }) {
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

  if (!data) return failed ? null : <section className="eco-hub" aria-busy="true" aria-label={et("autoTitle")} />;
  const { rules } = data.overview;
  const waiting = data.activity.filter((a) => a.canResolve);
  const done = data.activity.filter((a) => !a.canResolve && (a.status === "applied" || a.status === "accepted" || a.status === "undone")).slice(0, 6);
  const open = data.goals.filter((g) => !g.issue.done);
  const met = data.goals.filter((g) => g.issue.done).slice(0, 3);

  return (
    <section className="eco-hub" aria-labelledby="eh-hub">
      <div className="eco-hub-head">
        <h2 id="eh-hub">{et("autoTitle")}</h2>
        {owner && (
          <button type="button" className="eco-icon-btn" aria-expanded={gear} aria-label={et("autoSettings")} title={et("autoSettings")} onClick={() => setGear((v) => !v)}>
            <Settings2 size={14} />
          </button>
        )}
      </div>
      {owner && gear && (
        <div className="eco-hub-settings" role="group" aria-label={et("autoSettings")}>
          <label>
            <input type="checkbox" checked={rules.goals} onChange={(e) => void setRule({ goals: e.target.checked })} />
            {et("autoLinkGoals")}
          </label>
          <label>
            <input type="checkbox" checked={rules.parents} onChange={(e) => void setRule({ parents: e.target.checked })} />
            {et("autoParents")}
          </label>
          <label>
            <input type="checkbox" checked={rules.design} onChange={(e) => void setRule({ design: e.target.checked })} />
            {et("autoDesign")}
          </label>
          <label>
            <input type="checkbox" checked={rules.calendar} onChange={(e) => void setRule({ calendar: e.target.checked })} />
            {et("autoCalendar")}
          </label>
          <div className="eco-hub-ingest">
            <b>{et("autoIngest")}</b>
            <p className="eco-hub-empty">{et("autoIngestHint")}</p>
            {key && (
              <>
                <p className="eco-hub-empty">{et("autoIngestShown")}</p>
                <pre className="eco-hub-code" data-test="ingest-example">{`curl -X POST ${typeof location === "undefined" ? "" : location.origin}/api/pulse/ingest \\
  -H "Authorization: Bearer ${key}" \\
  -H "content-type: application/json" \\
  -d '{"metric":"signups","value":120,"label":"Signups"}'`}</pre>
              </>
            )}
            <span className="eco-hub-acts">
              <button type="button" className="eco-btn eco-btn-ghost" onClick={() => void ingest(true)}>
                {et("autoIngestNew")}
              </button>
              {(data.overview.ingest || key) && (
                <button type="button" className="eco-btn eco-btn-ghost" onClick={() => void ingest(false)}>
                  {et("autoIngestRevoke")}
                </button>
              )}
            </span>
          </div>
        </div>
      )}

      <div className="eco-hub-block">
        <h3>
          <Target size={13} aria-hidden /> {et("autoGoals")}
        </h3>
        {open.length === 0 && met.length === 0 ? (
          <p className="eco-hub-empty">{et("autoGoalsEmpty")}</p>
        ) : (
          <ul className="eco-hub-goals">
            {[...open, ...met].map((g) => (
              <li key={g.reaction} data-met={g.issue.done || undefined}>
                <a className="eco-hub-goal-title" href={href(ws, `issue:${g.issue.id}`, g.issue.identifier)}>
                  {g.issue.done ? <CircleCheck size={14} aria-hidden /> : <Target size={14} aria-hidden />}
                  <span className="eco-hub-id">{g.issue.identifier}</span>
                  <span className="eco-hub-text">{g.issue.title}</span>
                </a>
                <span className="eco-hub-goal-num">
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
        <div className="eco-hub-block">
          <h3>{et("autoWaiting", { n: waiting.length })}</h3>
          <ul className="eco-hub-items">
            {waiting.slice(0, 5).map((it) => (
              <li key={it.id}>
                <a href={href(ws, it.subject)} className="eco-hub-text">
                  {sentence(et, it, locale)}
                </a>
                {it.confidence !== null && <span className="eco-hub-sure">{et("autoSure", { p: Math.round(it.confidence * 100) })}</span>}
                {canEdit && (
                  <span className="eco-hub-acts">
                    <button type="button" className="eco-btn eco-btn-primary" disabled={busy === it.id} onClick={() => void act(it.id, "accept")}>
                      <Check size={13} aria-hidden /> {et("autoAccept")}
                    </button>
                    <button type="button" className="eco-icon-btn" disabled={busy === it.id} aria-label={et("autoDismiss")} title={et("autoDismiss")} onClick={() => void act(it.id, "dismiss")}>
                      <X size={14} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="eco-hub-block">
        <h3>{et("autoRecent")}</h3>
        {done.length === 0 ? (
          <p className="eco-hub-empty">{et("autoRecentEmpty")}</p>
        ) : (
          <ul className="eco-hub-items">
            {done.map((it) => (
              <li key={it.id} data-undone={it.status === "undone" || undefined}>
                <a href={href(ws, it.subject)} className="eco-hub-text">
                  {sentence(et, it, locale)}
                </a>
                <time className="eco-hub-when" dateTime={new Date(it.at).toISOString()}>
                  {new Date(it.at).toLocaleTimeString(intlTag(locale), { hour: "2-digit", minute: "2-digit" })}
                </time>
                {it.status === "undone" ? (
                  <span className="eco-hub-sure">{et("autoUndone")}</span>
                ) : (
                  canEdit &&
                  it.canUndo && (
                    <button type="button" className="eco-icon-btn" disabled={busy === it.id} aria-label={et("autoUndo")} title={et("autoUndo")} onClick={() => void act(it.id, "undo")}>
                      <Undo2 size={14} />
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {failed && <p className="eco-hub-empty">{et("failed")}</p>}
    </section>
  );
}
