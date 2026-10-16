// Goals that set themselves up. Server-only.
//
// An issue whose title states a target for a number — "Reach 1,000 sign-ups",
// "MRR $10k", "Cut churn below 3%" — is a goal. When it is made (or when a
// person asks from its Goal panel), Jev links it to the workspace's live
// number that measures it, so it closes by itself when the number gets there:
//
//   1. the title's numbers are read by rules (1,000 · 10k · 2.5M · 3%), years
//      and quarters are not targets;
//   2. Jev decides in one call: is this a goal on a number, which of the live
//      numbers measures it, which of the title's numbers is the target, and
//      whether the number should grow to it or fall to it;
//   3. sure (≥ AUTO): the goal is set at once, with the creator's rights, and
//      the journal keeps it with Undo; fairly sure (≥ SUGGEST): a proposal the
//      creator accepts in one click (the issue's Goal panel, the Inbox);
//   4. Jev off, slow or unsure: the rules propose only when exactly one
//      number's name appears in the title — never set anything themselves.
//
// What goes to Jev: the issue's title, and the names and current values of
// the live numbers the creator may see. Nothing else (the fields are fixed in ./jev.ts).

import { notify } from "../eco/inbox";
import { ctxFor } from "../projects/core";
import { onChange } from "../projects/events";
import { getIssueBrief } from "../projects/issues";
import { spend } from "../projects/autopilot";
import { listStatuses } from "../projects/teams";
import { metricsOf, reactionsOf, saveReaction, settingsOf } from "./engine";
import { goalIssueOf, goalReaction, type GoalOp } from "./goals";
import { ask, choice, jevAvailable, noul } from "./jev";
import { pendingFor, recordHub } from "./journal";
import { visibleMetrics } from "./sources";

/** Set the goal at once from these confidences. */
export const AUTO = 0.85;
/** Propose it from these. */
export const SUGGEST = 0.6;
const MAX_NUMBERS = 12;
const MAX_TARGETS = 6;

export interface Target {
  value: number;
  /** As written ("$10k", "1,000"). */
  text: string;
}

const MULT: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, тыс: 1e3, млн: 1e6, млрд: 1e9 };

/** The numbers a title may aim at: amounts with thousands separators, decimals, k/M suffixes, percents. Years and quarters are left out. */
export function targetsIn(title: string): Target[] {
  const out: Target[] = [];
  const re = /(^|[^\p{L}\p{N}])([$€£¥₽]\s?)?(\d{1,3}(?:[,   ]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s?(k|K|m|M|b|B|тыс|млн|млрд|%)?(?![\p{L}\p{N}])/gu;
  for (const m of title.matchAll(re)) {
    const raw = m[3];
    const grouped = /[,   ]\d{3}/.test(raw) && !/[.,]\d{1,2}$/.test(raw);
    const n = grouped ? Number(raw.replace(/[,   ]/g, "")) : Number(raw.replace(",", "."));
    if (!Number.isFinite(n)) continue;
    const suffix = m[4] ?? "";
    // "#12" is an issue or a rank ("Q4", "v2" never match: a letter is glued to them).
    if (m[1] === "#") continue;
    // A bare four-digit year (2026) is a date, not a target.
    if (!m[2] && !suffix && Number.isInteger(n) && n >= 1900 && n <= 2100 && !grouped) continue;
    const value = suffix === "%" ? n : n * (MULT[suffix] ?? 1);
    out.push({ value, text: `${m[2] ?? ""}${raw}${suffix}`.trim() });
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

/** Whether the words say the number should fall (cut, reduce, below, under…); otherwise it should grow. */
export function fallsTo(title: string): boolean {
  return /\b(cut|reduce|lower|decrease|drop|below|under|less than|at most|max(imum)?|down to|shrink|minimi[sz]e)\b|сократить|снизить|уменьшить|ниже|меньше|не более/iu.test(title);
}

function words(s: string): Set<string> {
  return new Set((s.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !/^\d+$/.test(w)));
}

export type Outcome = { status: "applied" | "pending"; decision: string } | { status: "none"; why: "not a goal" | "no numbers" | "no target" | "already" | "unsure" | "forbidden" };

/**
 * Links an issue to the live number that measures it, for the person `by`
 * (the creator, or whoever asked): at once when Jev is sure, as a proposal
 * when it is fairly sure.
 */
export async function proposeGoal(ws: string, issueId: string, by: string): Promise<Outcome> {
  let ctx;
  let issue;
  try {
    ctx = ctxFor(by, ws, "edit");
    issue = getIssueBrief(ctx, issueId);
  } catch {
    return { status: "none", why: "forbidden" };
  }
  const cat = listStatuses(ctx).find((s) => s.id === issue.statusId)?.category;
  if (cat === "completed" || cat === "canceled") return { status: "none", why: "not a goal" };
  if (reactionsOf(ws).some((r) => goalIssueOf(r) === issueId)) return { status: "none", why: "already" };
  const pending = pendingFor(ws, `issue:${issueId}`, "goal");
  if (pending) return { status: "pending", decision: pending };
  const targets = targetsIn(issue.title);
  if (!targets.length) return { status: "none", why: "no target" };
  // Mail numbers are their owner's own business: never offered to Jev.
  const metrics = visibleMetrics(ws, by, metricsOf(ws))
    .filter((m) => !m.key.startsWith("mail:"))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_NUMBERS);
  if (!metrics.length) return { status: "none", why: "no numbers" };

  const subject = `issue:${issueId}`;
  const make = (key: string, op: GoalOp, target: number) => goalReaction({ issue: issueId, key, op, target });

  if (settingsOf(ws).jev && jevAvailable() && spend(ws)) {
    const criteria: Record<string, string> = { none: "None of these numbers measures the goal." };
    metrics.forEach((m, i) => (criteria[`n${i}`] = `${m.label || m.key} (now ${m.value})`));
    const questions = {
      goal: noul("Is this issue a goal to bring a number to a target — for example, reach 1,000 sign-ups, or cut costs below 5,000 — rather than a task, a bug or a plain idea?"),
      number: choice("Which of the workspace's live numbers measures progress toward this goal?", criteria),
      direction: choice("To meet the goal, should the number grow until it reaches the target, or fall until it is at or below it?", {
        up: "Grow: the goal is met when the number is at or above the target.",
        down: "Fall: the goal is met when the number is at or below the target.",
      }),
      ...(targets.length > 1 ? { target: choice("Which number in the title is the goal's target value?", Object.fromEntries(targets.map((t, i) => [`t${i}`, t.text]))) } : {}),
    };
    const out = await ask(ws, { title: issue.title }, questions);
    if (out) {
      const a = out.answers as unknown as {
        goal: { noul: number };
        number: { choice: string; probabilities: Record<string, number>; confidence: number };
        direction: { choice: "up" | "down"; probabilities: Record<string, number>; confidence: number };
        target?: { choice: string; probabilities: Record<string, number>; confidence: number };
      };
      const idx = a.number.choice === "none" ? -1 : Number(a.number.choice.slice(1));
      const metric = metrics[idx];
      const tIdx = a.target ? Number(a.target.choice.slice(1)) : 0;
      const target = targets[tIdx];
      const conf = Math.min(a.goal.noul, a.number.probabilities[a.number.choice] ?? a.number.confidence, a.target ? (a.target.probabilities[a.target.choice] ?? a.target.confidence) : 1);
      if (!metric || !target || conf < SUGGEST) return { status: "none", why: metric ? "unsure" : "not a goal" };
      const op: GoalOp = a.direction.choice === "down" ? "<=" : ">=";
      const reaction = make(metric.key, op, target.value);
      if (conf >= AUTO) {
        const saved = saveReaction(ws, reaction, by);
        if ("error" in saved) return { status: "none", why: "forbidden" };
        const decision = recordHub(ws, { subject, source: "jev", mode: "auto", status: "applied", payload: { kind: "goal", reaction: saved, issue: issueId }, reaction: saved.id, confidence: conf, model: out.model, ms: out.ms, by });
        return { status: "applied", decision };
      }
      const decision = recordHub(ws, { subject, source: "jev", mode: "suggest", status: "pending", payload: { kind: "goal", reaction, issue: issueId }, confidence: conf, model: out.model, ms: out.ms, by });
      notify(by, { ws, kind: "jev", ref: subject, by: null, text: `${metric.label || metric.key} ${op === "<=" ? "≤" : "≥"} ${target.text}` });
      return { status: "pending", decision };
    }
  }

  // Without Jev: propose only when exactly one number is named in the title.
  const title = words(issue.title);
  const named = metrics.filter((m) => {
    const w = words(m.label || m.key.replace(/[._:-]+/g, " "));
    return w.size > 0 && [...w].every((x) => title.has(x));
  });
  if (named.length !== 1 || targets.length !== 1) return { status: "none", why: "unsure" };
  const reaction = make(named[0].key, fallsTo(issue.title) ? "<=" : ">=", targets[0].value);
  const decision = recordHub(ws, { subject, source: "rule", mode: "suggest", status: "pending", payload: { kind: "goal", reaction, issue: issueId }, by });
  notify(by, { ws, kind: "jev", ref: subject, by: null, text: `${named[0].label || named[0].key} ${fallsTo(issue.title) ? "≤" : "≥"} ${targets[0].text}` });
  return { status: "pending", decision };
}

const KEY = Symbol.for("zvena.decide.autogoal");
const g = globalThis as unknown as Record<symbol, { running: Set<Promise<unknown>> } | undefined>;

/** Starts looking at new issues (once per process; hub.ts). */
export function startAutogoal(enabled: (ws: string) => boolean): void {
  if (g[KEY]) return;
  const running = new Set<Promise<unknown>>();
  g[KEY] = { running };
  onChange((c) => {
    if (c.entity !== "issue" || !c.created || c.quiet || c.via || c.deleted || !enabled(c.ws)) return;
    const p = proposeGoal(c.ws, c.id, c.by).catch(() => undefined);
    running.add(p);
    void p.finally(() => running.delete(p));
  });
}

/** Test hook: wait until what was started is finished. */
export async function autogoalIdle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  const st = g[KEY];
  while (st && st.running.size) await Promise.all([...st.running]);
}
