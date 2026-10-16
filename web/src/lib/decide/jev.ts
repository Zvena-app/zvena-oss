// Jev (TypeSafe AI's "System One" decision model): typed questions about a
// small piece of state, answered with calibrated probabilities instead of
// text. Server-only; the browser never talks to it (CSP connect-src 'self').
//
//   POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer TYPESAFE_API_KEY
//   { model, state, questions: { <id>: noul | choice | score } }
//   → { model, answers: { <id>: … }, usage }
//
// Works wherever TYPESAFE_API_KEY is set, in every workspace whose owner has not
// turned it off (engine.ts settingsOf). Every call names its workspace and that
// switch is checked here, before the request and again when the answer arrives,
// so no caller can send a workspace's text while Jev is off there. Without a
// registered switch (setWorkspaceGate) nothing is sent at all. Built for speed and for failing safe:
// a time budget (default 1.5 s; Jev answers in 70–500 ms), one retry on 429/529
// while the budget lasts, a short cache of identical questions, and a breaker
// that stops calling for a minute after repeated failures. Every failure
// returns null and the caller carries on without a decision; nothing
// waits on Jev or breaks because of it.
//
// No SDK on purpose: one fetch, no dependency to audit or update.

import { createHash } from "node:crypto";

/** Instructions and criteria may be text or structured (TypeSafe "advanced primitives"). */
export type Instr = string | Record<string, unknown> | unknown[] | null;

export type NoulQ = { type: "noul"; instructions: Instr; criteria?: { true?: Instr; false?: Instr } };
export type ChoiceQ<O extends string = string> = { type: "choice"; instructions: Instr; criteria: Record<O, Instr> };
export type ScoreQ = { type: "score"; instructions: Instr; criteria: Instr[] };
export type Question = NoulQ | ChoiceQ | ScoreQ;

export type NoulA = { type: "noul"; noul: number };
export type ChoiceA<O extends string = string> = { type: "choice"; choice: O; probabilities: Record<O, number>; confidence: number };
export type ScoreA = { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export type AnswerOf<Q> = Q extends NoulQ ? NoulA : Q extends ChoiceQ<infer O> ? ChoiceA<O> : Q extends ScoreQ ? ScoreA : never;

/** Yes / no: the answer is the probability of yes (0–1). */
export const noul = (instructions: Instr, criteria?: NoulQ["criteria"]): NoulQ => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });
/** One of the named options (description or null for each). */
export const choice = <O extends string>(instructions: Instr, criteria: Record<O, Instr>): ChoiceQ<O> => ({ type: "choice", instructions, criteria });
/** A level on an ordered scale, low to high (2–10 levels). */
export const score = (instructions: Instr, criteria: Instr[]): ScoreQ => ({ type: "score", instructions, criteria });

export interface JevResult<Qs extends Record<string, Question>> {
  answers: { [K in keyof Qs]: AnswerOf<Qs[K]> };
  /** The versioned model that answered (jev-1.13.0…). */
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
  cached: boolean;
}

export interface AskOptions {
  /** Total time budget including a retry (ms). */
  timeoutMs?: number;
  /** Reuse an identical question's answer for this long (ms; 0 = never). */
  cacheMs?: number;
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const CACHE_MAX = 500;

interface JevState {
  cache: Map<string, { at: number; value: Omit<JevResult<Record<string, Question>>, "ms" | "cached"> }>;
  failures: number;
  openUntil: number;
  calls: number;
  errors: number;
  totalMs: number;
}
const KEY = Symbol.for("zvena.jev");
const g = globalThis as unknown as Record<symbol, JevState | undefined>;
const st: JevState = (g[KEY] ??= { cache: new Map(), failures: 0, openUntil: 0, calls: 0, errors: 0, totalMs: 0 });

function settings() {
  return {
    key: process.env.TYPESAFE_API_KEY?.trim() || "",
    model: process.env.ZVENA_JEV_MODEL?.trim() || "jev-latest",
    timeoutMs: Number(process.env.ZVENA_JEV_TIMEOUT_MS) || 1500,
    endpoint: process.env.ZVENA_JEV_URL?.trim() || ENDPOINT,
  };
}

/** Whether Jev can be asked at all (a key is configured and the breaker is closed). */
export function jevAvailable(now = Date.now()): boolean {
  return Boolean(settings().key) && now >= st.openUntil;
}

export function jevConfigured(): boolean {
  return Boolean(settings().key);
}

/** Counters for /status and the decisions page. */
export function jevStats() {
  return { configured: jevConfigured(), calls: st.calls, errors: st.errors, avgMs: st.calls ? Math.round(st.totalMs / st.calls) : 0, breakerOpen: Date.now() < st.openUntil };
}

/** Jev's state in a workspace whose owner has not chosen: on unless ZVENA_JEV_DEFAULT=off (opt-in). */
export function jevDefault(): boolean {
  return process.env.ZVENA_JEV_DEFAULT?.trim().toLowerCase() !== "off";
}

/** Whether a workspace allows Jev; engine.ts registers it (its owner's switch). Absent: Jev is off everywhere. */
let workspaceGate: ((ws: string) => boolean) | null = null;
export function setWorkspaceGate(fn: ((ws: string) => boolean) | null): void {
  workspaceGate = fn;
}
function allowed(ws: string): boolean {
  if (!ws || !workspaceGate) return false;
  try {
    return workspaceGate(ws);
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks Jev the questions about `state`, on behalf of workspace `ws`. Returns
 * null when Jev is off (no key, or the workspace's owner turned it off), slow,
 * down, or the answer is malformed; the caller decides what that means
 * (usually: no automatic action).
 */
export async function ask<Qs extends Record<string, Question>>(ws: string, state: unknown, questions: Qs, opts: AskOptions = {}): Promise<JevResult<Qs> | null> {
  const cfg = settings();
  const t0 = Date.now();
  if (!cfg.key || t0 < st.openUntil || !allowed(ws)) return null;
  const body = JSON.stringify({ model: cfg.model, state, questions });
  const cacheMs = opts.cacheMs ?? 10 * 60_000;
  const hash = createHash("sha256").update(body).digest("base64url");
  const hit = cacheMs > 0 ? st.cache.get(hash) : undefined;
  if (hit && t0 - hit.at < cacheMs) return { ...(hit.value as Omit<JevResult<Qs>, "ms" | "cached">), ms: 0, cached: true };

  const deadline = t0 + (opts.timeoutMs ?? cfg.timeoutMs);
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left < 50) break;
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(left),
      });
      if (res.status === 429 || res.status === 529) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 150, Math.max(0, deadline - Date.now() - 100)));
        continue;
      }
      if (!res.ok) break;
      const out = (await res.json()) as { model?: unknown; answers?: unknown; usage?: unknown };
      const answers = validAnswers(out.answers, questions);
      if (!answers) break;
      const value = {
        answers: answers as JevResult<Qs>["answers"],
        model: typeof out.model === "string" ? out.model.slice(0, 60) : cfg.model,
        usage: validUsage(out.usage),
      };
      const ms = Date.now() - t0;
      st.calls++;
      st.totalMs += ms;
      st.failures = 0;
      // Turned off while the question was out: the answer is not used.
      if (!allowed(ws)) return null;
      if (cacheMs > 0) {
        if (st.cache.size >= CACHE_MAX) st.cache.delete(st.cache.keys().next().value as string);
        st.cache.set(hash, { at: Date.now(), value: value as Omit<JevResult<Record<string, Question>>, "ms" | "cached"> });
      }
      return { ...value, ms, cached: false };
    } catch {
      // Timeout or network: give up for this call (the budget is spent).
      break;
    }
  }
  st.calls++;
  st.errors++;
  st.totalMs += Date.now() - t0;
  // Five failures in a row: stop calling for a minute, so nothing pays for an outage.
  if (++st.failures >= 5) {
    st.openUntil = Date.now() + 60_000;
    st.failures = 0;
  }
  return null;
}

const prob = (x: unknown): x is number => typeof x === "number" && x >= 0 && x <= 1;

function validProbs(p: unknown, keys: string[]): Record<string, number> | null {
  if (!p || typeof p !== "object") return null;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = (p as Record<string, unknown>)[k];
    out[k] = prob(v) ? v : 0;
  }
  return out;
}

/** The answers, checked against the questions asked (an API answer is untrusted input). */
function validAnswers(raw: unknown, questions: Record<string, Question>): Record<string, NoulA | ChoiceA | ScoreA> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, NoulA | ChoiceA | ScoreA> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = (raw as Record<string, Record<string, unknown> | undefined>)[id];
    if (!a || typeof a !== "object") return null;
    if (q.type === "noul") {
      if (!prob(a.noul)) return null;
      out[id] = { type: "noul", noul: a.noul };
    } else if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      if (typeof a.choice !== "string" || !options.includes(a.choice)) return null;
      const probabilities = validProbs(a.probabilities, options);
      if (!probabilities) return null;
      out[id] = { type: "choice", choice: a.choice, probabilities, confidence: prob(a.confidence) ? a.confidence : probabilities[a.choice] };
    } else {
      const levels = q.criteria.map((_, i) => String(i));
      if (typeof a.score !== "number" || !Number.isFinite(a.score)) return null;
      const probabilities = validProbs(a.probabilities, levels);
      if (!probabilities) return null;
      const legend: Record<string, string> = {};
      for (const l of levels) {
        const v = (a.legend as Record<string, unknown> | undefined)?.[l];
        legend[l] = typeof v === "string" ? v.slice(0, 500) : "";
      }
      out[id] = { type: "score", score: Math.min(Math.max(a.score, 0), levels.length - 1), legend, probabilities, confidence: prob(a.confidence) ? a.confidence : 0 };
    }
  }
  return out;
}

function validUsage(u: unknown): { input_tokens: number; output_tokens: number } {
  const r = (u ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);
  return { input_tokens: n(r.input_tokens), output_tokens: n(r.output_tokens) };
}

/** Test hook: forget the cache, the counters and the breaker. */
export function resetJev(): void {
  st.cache.clear();
  st.failures = 0;
  st.openUntil = 0;
  st.calls = 0;
  st.errors = 0;
  st.totalMs = 0;
}
