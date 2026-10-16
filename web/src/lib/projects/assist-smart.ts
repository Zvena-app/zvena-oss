// Smart triage for the assistant: the decision model (src/lib/decide/smart.ts)
// judges an issue's priority as a `score` and its label as a `choice` among
// the team's labels.
//
// - Only when the server has the model configured AND the workspace owner left
//   smart suggestions on (the same switch as reactions: /api/decide {op:"smart"}).
//   Otherwise, or when the model is slow, down, unsure or answers nonsense, the
//   rules answer.
// - What leaves the server: the title and the plain text of the description
//   (at most 2000 characters) of the issue being triaged, and the names and
//   descriptions of the team's labels. Nothing else; never ids of people.
// - Nothing changes: the result is a proposal with a confidence; the
//   person applies it through the normal, permission-checked API.

import { settingsOf } from "../decide/engine";
import { ask, choice, score, smartAvailable, smartConfigured } from "../decide/smart";
import type { Ctx } from "./core";
import { triage } from "./assist";
import { plainText } from "./markdown";
import { listLabels } from "./teams";
import type { Priority } from "./types";

export type SmartState = "unconfigured" | "off" | "on";

/** The model may be asked now in this workspace: set up on the server, not turned off by the owner, not cooling down after failures. */
export function smartOn(wsId: string): boolean {
  return settingsOf(wsId).smart && smartAvailable();
}

/** Whether Projects' assistant may use smart suggestions in this workspace. */
export function smartState(wsId: string): SmartState {
  if (!smartConfigured()) return "unconfigured";
  return settingsOf(wsId).smart ? "on" : "off";
}

/** Below this confidence the model's answer is not shown (the rules answer instead). */
export const MIN_CONFIDENCE = 0.6;

// Low → urgent; the index is the model's score level.
const LEVELS: Priority[] = [4, 3, 2, 1];

export interface Triage {
  priority: Priority | null;
  priorityReason: string | null;
  labels: { id: string; reason: string }[];
  /** Who proposed it: the decision model (with its confidence) or the rules. */
  source: "model" | "rules";
  confidence?: number;
}

export async function triageSmart(ctx: Ctx, input: { title: string; description: string; teamId?: string | null }): Promise<Triage> {
  const rules = triage(ctx, input);
  const fallback: Triage = { ...rules, source: "rules" };
  if (!smartOn(ctx.wsId)) return fallback;

  const labels = listLabels(ctx)
    .filter((l) => !l.isGroup && (!l.teamId || !input.teamId || l.teamId === input.teamId))
    .slice(0, 12);
  const state = { title: input.title.slice(0, 300), description: plainText(input.description, 2000) };
  const labelCriteria: Record<string, string> = { none: "None of these labels fits the issue." };
  for (const l of labels) labelCriteria[l.id] = l.description ? `${l.name}: ${l.description.slice(0, 200)}` : l.name;
  const questions = {
    priority: score("How urgent is this issue for the team that owns it? Judge by user impact, who is blocked and deadlines in the text.", [
      "Low: nice to have; nobody is blocked.",
      "Medium: normal work for an upcoming cycle.",
      "High: important; affects many users or blocks other work.",
      "Urgent: production is down, data is lost, a security hole, or a deadline today.",
    ]),
    ...(labels.length ? { label: choice("Which one of the team's labels fits this issue best?", labelCriteria) } : {}),
  };
  const out = await ask(ctx.wsId, state, questions);
  if (!out) return fallback;

  const result: Triage = { ...rules, source: "model" };
  const p = out.answers.priority;
  const level = Math.round(p.score);
  const pConf = p.probabilities[String(level)] ?? p.confidence;
  let best = 0;
  if (pConf >= MIN_CONFIDENCE && LEVELS[level]) {
    result.priority = LEVELS[level];
    result.priorityReason = `${Math.round(pConf * 100)}%`;
    best = pConf;
  }
  const l = "label" in out.answers ? (out.answers as { label?: { choice: string; confidence: number } }).label : undefined;
  if (l && l.choice !== "none" && l.confidence >= MIN_CONFIDENCE && labels.some((x) => x.id === l.choice)) {
    result.labels = [{ id: l.choice, reason: `${Math.round(l.confidence * 100)}%` }, ...rules.labels.filter((x) => x.id !== l.choice)].slice(0, 5);
    best = Math.max(best, l.confidence);
  }
  // The model was asked but sure of nothing: the rules' proposal, said honestly.
  if (!best) return fallback;
  result.confidence = best;
  return result;
}
