// Notion Forms' conditional logic: a question shows only when an earlier
// question's answer meets its condition. One rule for the public form (what
// to show) and the server (what to require and keep): a hidden question is
// never required and its answer is dropped.

import type { FormCondition } from "./types";

export const FORM_CONDITION_OPS = ["is", "is_not", "filled", "empty"] as const;

export interface LogicQuestion {
  prop: string;
  when?: FormCondition;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);

/** Whether one answer meets a condition (`value`: an option id, or text compared without case). */
export function meets(c: FormCondition, answer: unknown): boolean {
  if (c.op === "filled") return !isEmpty(answer);
  if (c.op === "empty") return isEmpty(answer);
  const want = String(c.value ?? "").trim().toLowerCase();
  const has = Array.isArray(answer)
    ? answer.some((x) => String(x).trim().toLowerCase() === want)
    : typeof answer === "object" && answer !== null && "start" in answer
      ? String((answer as { start: unknown }).start) === want
      : !isEmpty(answer) && String(answer).trim().toLowerCase() === want;
  return c.op === "is" ? has : !has;
}

/** The questions shown for these answers, in order (a condition may only look at an earlier, shown question). */
export function shownQuestions<Q extends LogicQuestion>(questions: readonly Q[], answers: Record<string, unknown>): Set<string> {
  const shown = new Set<string>();
  const before = new Set<string>();
  for (const q of questions) {
    const c = q.when;
    const ok = !c || !before.has(c.prop) ? true : meets(c, shown.has(c.prop) ? answers[c.prop] : undefined);
    if (ok) shown.add(q.prop);
    before.add(q.prop);
  }
  return shown;
}
