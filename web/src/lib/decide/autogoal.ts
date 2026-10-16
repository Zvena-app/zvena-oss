// Goals that set themselves up. Server-only.
//
// An issue whose title states a target for a number — "Reach 1,000 sign-ups",
// "MRR $10k", "Cut churn below 3%" — is a goal. When it is made (or when a
// person asks from its Goal panel), it is linked to the workspace's live
// number that measures it, so it closes by itself when the number gets there:
//
//   1. the title's numbers are read by rules (1,000 · 10k · 2.5M · 3%), years
//      and quarters are not targets;
//   2. the decision model decides in one call: is this a goal on a number, which of the live
//      numbers measures it, which of the title's numbers is the target, and
//      whether the number should grow to it or fall to it;
//   3. sure (≥ AUTO) about every part of it — that it is a goal, the number,
//      the target and the direction — the goal is set at once, with the
//      creator's rights, and the journal keeps it with Undo; fairly sure
//      (≥ SUGGEST): a proposal the creator accepts in one click (the issue's
//      Goal panel, the Inbox). The confidence is the weakest part's. Never at
//      once (a proposal at most) when the title's own words disagree with the
//      model on the direction ("reduce", "below") or the target ("from 5% to
//      3%"), or when the goal would be met the moment it is set (a wrong
//      direction would close the issue right away); the words win then, and
//      the person confirms. The title is read again when the answer arrives:
//      changed meanwhile, the answer is dropped and the question asked once
//      more about the new title;
//   4. smart suggestions off, the model slow or unsure: the rules propose only when exactly one
//      number's name appears in the title — never set anything themselves.
//
// What goes to the model: the issue's title, and the names and current values of
// the live numbers the creator may see. Nothing else (see /legal/privacy#suggestions).

import { notify } from "../eco/inbox";
import { ctxFor } from "../projects/core";
import { onChange } from "../projects/events";
import { getIssueBrief } from "../projects/issues";
import { spend } from "../projects/autopilot";
import { listStatuses } from "../projects/teams";
import { metricsOf, reactionsOf, saveReaction, settingsOf } from "./engine";
import { goalIssueOf, goalReaction, type GoalOp } from "./goals";
import { compare } from "./model";
import { ask, choice, noul, smartAvailable } from "./smart";
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
  /** Where it starts and ends in the title. */
  start: number;
  end: number;
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
    const start = (m.index ?? 0) + m[1].length;
    out.push({ value, text: `${m[2] ?? ""}${raw}${suffix}`.trim(), start, end: (m.index ?? 0) + m[0].length });
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

// The direction words: a comparison ("below 3%", "at least 500") says more than a verb ("reduce", "reach").
const FALL_CMP = /\b(below|under|less than|fewer than|at most|no more than|max(imum)?|down to)\b|ниже|меньше|не более/iu;
const GROW_CMP = /\b(above|over|more than|at least|no less than|exceed(s|ing)?)\b|выше|больше|не менее/iu;
const FALL_VERB = /\b(cut|reduce|lower|decrease|drop|shrink|minimi[sz]e)\b|сократить|снизить|уменьшить/iu;
const GROW_VERB = /\b(grow|increase|raise|boost|reach|hit|double|triple|maximi[sz]e|get to)\b|увеличить|достичь/iu;

/** "from 5% to 3%" (or "5% → 3%"): the indexes of the number it starts from and of the target. */
function fromTo(title: string, targets: Target[]): { from: number; to: number } | null {
  for (let i = 1; i < targets.length; i++) {
    const between = title.slice(targets[i - 1].end, targets[i].start);
    if (/^\s*(to|→|->|–|—)\s*$/iu.test(between) && (/\bfrom\s*$/iu.test(title.slice(0, targets[i - 1].start)) || /^\s*(→|->)\s*$/u.test(between))) return { from: i - 1, to: i };
  }
  return null;
}

/**
 * Which way the title's own words say the number should go: "down" (cut,
 * reduce, below…), "up" (grow, reach, at least…), "both" when they disagree
 * (then the words decide nothing), or null when they say nothing.
 */
export function directionIn(title: string, targets: Target[] = targetsIn(title)): "up" | "down" | "both" | null {
  const one = (down: boolean, up: boolean): "up" | "down" | "both" | null => (down && up ? "both" : down ? "down" : up ? "up" : null);
  let dir = one(FALL_CMP.test(title), GROW_CMP.test(title));
  if (!dir) dir = one(FALL_VERB.test(title), GROW_VERB.test(title));
  const ft = fromTo(title, targets);
  const moves: "up" | "down" | null = ft && targets[ft.to].value !== targets[ft.from].value ? (targets[ft.to].value < targets[ft.from].value ? "down" : "up") : null;
  if (!moves) return dir;
  return !dir || dir === moves ? moves : "both";
}

/** Which of the title's numbers its words make the target ("from $10k to $15k": $15k), or null when they do not say. */
export function targetIn(title: string, targets: Target[] = targetsIn(title)): number | null {
  if (targets.length === 1) return 0;
  return fromTo(title, targets)?.to ?? null;
}

/** Whether the words say the number should fall (cut, reduce, below, under…); otherwise it should grow. */
export function fallsTo(title: string): boolean {
  return directionIn(title) === "down";
}

function words(s: string): Set<string> {
  return new Set((s.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !/^\d+$/.test(w)));
}

export type Outcome =
  | { status: "applied" | "pending"; decision: string }
  | { status: "none"; why: "not a goal" | "no numbers" | "no target" | "already" | "unsure" | "forbidden" | "changed" };

type Issue = ReturnType<typeof getIssueBrief>;

/** The issue as it is now, for `by`, or why there is nothing to do for it. */
function current(ws: string, issueId: string, by: string): { issue: Issue } | Outcome {
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
  return { issue };
}

/** The live numbers the model may hear about for `by` (the newest first). */
function numbersFor(ws: string, by: string) {
  // Mail numbers are their owner's own business: never offered to the model.
  return visibleMetrics(ws, by, metricsOf(ws))
    .filter((m) => !m.key.startsWith("mail:"))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_NUMBERS);
}

/**
 * Links an issue to the live number that measures it, for the person `by`
 * (the creator, or whoever asked): at once when the model is sure, as a proposal
 * when it is fairly sure. `again`: whether a title changed while the question was
 * out is asked about once more (the second round does not).
 */
export async function proposeGoal(ws: string, issueId: string, by: string, again = true): Promise<Outcome> {
  const now = current(ws, issueId, by);
  if ("status" in now) return now;
  const { issue } = now;
  const targets = targetsIn(issue.title);
  if (!targets.length) return { status: "none", why: "no target" };
  const metrics = numbersFor(ws, by);
  if (!metrics.length) return { status: "none", why: "no numbers" };

  const subject = `issue:${issueId}`;
  const make = (key: string, op: GoalOp, target: number) => goalReaction({ issue: issueId, key, op, target });
  // What the title's own words say about the direction and the target.
  const wordsDir = directionIn(issue.title, targets);
  const wordsTarget = targetIn(issue.title, targets);

  if (settingsOf(ws).smart && smartAvailable() && spend(ws)) {
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
      // The question was out for a while: the issue is read again, and an answer about a title
      // that has changed since is not used (it is asked once more about the new one).
      const after = current(ws, issueId, by);
      if ("status" in after) return after;
      if (after.issue.title !== issue.title) return again ? proposeGoal(ws, issueId, by, false) : { status: "none", why: "changed" };
      const a = out.answers as unknown as {
        goal: { noul: number };
        number: { choice: string; probabilities: Record<string, number>; confidence: number };
        direction: { choice: "up" | "down"; probabilities: Record<string, number>; confidence: number };
        target?: { choice: string; probabilities: Record<string, number>; confidence: number };
      };
      const p = (x: { choice: string; probabilities: Record<string, number>; confidence: number }) => x.probabilities[x.choice] ?? x.confidence;
      const idx = a.number.choice === "none" ? -1 : Number(a.number.choice.slice(1));
      // The number as it is now (still there, still visible to `by`).
      const metric = metrics[idx] && numbersFor(ws, by).find((m) => m.key === metrics[idx].key);
      // Every part of the decision counts, and the weakest one decides: is it a goal, which
      // number, which target, which way. Where the title's words say it too and agree,
      // the part is at least worth a proposal; where they disagree, the words win and a
      // person confirms (a proposal at most).
      const parts: number[] = [a.goal.noul, p(a.number)];
      let tIdx = 0;
      if (a.target) {
        const picked = Number(a.target.choice.slice(1));
        tIdx = wordsTarget ?? picked;
        parts.push(wordsTarget === null ? p(a.target) : wordsTarget === picked ? Math.max(p(a.target), SUGGEST) : SUGGEST);
      }
      let dir: "up" | "down" = a.direction.choice === "down" ? "down" : "up";
      if (wordsDir === "up" || wordsDir === "down") {
        parts.push(wordsDir === dir ? Math.max(p(a.direction), SUGGEST) : SUGGEST);
        dir = wordsDir;
      } else parts.push(wordsDir === "both" ? Math.min(p(a.direction), SUGGEST) : p(a.direction));
      const target = targets[tIdx];
      const op: GoalOp = dir === "down" ? "<=" : ">=";
      // A goal already met when it is set closes its issue at once: most likely a wrong direction or target.
      if (metric && target && compare(metric.value, op, target.value)) parts.push(SUGGEST);
      const conf = Math.min(...parts);
      if (!metric || !target || conf < SUGGEST) return { status: "none", why: metric ? "unsure" : "not a goal" };
      const reaction = make(metric.key, op, target.value);
      if (conf >= AUTO) {
        const saved = saveReaction(ws, reaction, by);
        if ("error" in saved) return { status: "none", why: "forbidden" };
        const decision = recordHub(ws, { subject, source: "model", mode: "auto", status: "applied", payload: { kind: "goal", reaction: saved, issue: issueId }, reaction: saved.id, confidence: conf, model: out.model, ms: out.ms, by });
        return { status: "applied", decision };
      }
      const decision = recordHub(ws, { subject, source: "model", mode: "suggest", status: "pending", payload: { kind: "goal", reaction, issue: issueId }, confidence: conf, model: out.model, ms: out.ms, by });
      notify(by, { ws, kind: "proposal", ref: subject, by: null, text: `${metric.label || metric.key} ${op === "<=" ? "≤" : "≥"} ${target.text}` });
      return { status: "pending", decision };
    }
  }

  // Without the model: propose only when exactly one number is named in the title, the words
  // leave one target, and they do not contradict themselves on the direction.
  const title = words(issue.title);
  const named = metrics.filter((m) => {
    const w = words(m.label || m.key.replace(/[._:-]+/g, " "));
    return w.size > 0 && [...w].every((x) => title.has(x));
  });
  if (named.length !== 1 || wordsTarget === null || wordsDir === "both") return { status: "none", why: "unsure" };
  const falls = wordsDir === "down";
  const reaction = make(named[0].key, falls ? "<=" : ">=", targets[wordsTarget].value);
  const decision = recordHub(ws, { subject, source: "rule", mode: "suggest", status: "pending", payload: { kind: "goal", reaction, issue: issueId }, by });
  notify(by, { ws, kind: "proposal", ref: subject, by: null, text: `${named[0].label || named[0].key} ${falls ? "≤" : "≥"} ${targets[wordsTarget].text}` });
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
