// The optional decision model (an RLHF architecture and model) behind smart
// suggestions and automations: typed questions about a small piece of state,
// answered with calibrated probabilities instead of text. Server-only; the
// browser never talks to it (CSP connect-src 'self').
//
//   POST $ZVENA_AI_URL   Authorization: Bearer $ZVENA_AI_KEY
//   { model?, state, questions: { <id>: noul | choice | score } }
//   → { model, answers: { <id>: … }, usage }
//
// Off unless both ZVENA_AI_URL and ZVENA_AI_KEY are set (no endpoint is built
// in). Then it works in every workspace whose owner has not turned it off
// (engine.ts settingsOf). Every call names its workspace and that switch is
// checked here, before the request and again when the answer arrives, so no
// caller can send a workspace's text while it is off there. Without a
// registered switch (setWorkspaceGate) nothing is sent at all. Built for speed
// and for failing safe: a time budget (default 1.5 s; answers take 70–500 ms),
// one retry on 429/529 while the budget lasts, a short cache of identical
// questions, a cap on the answer's size (ZVENA_AI_MAX_RESPONSE_BYTES, read as
// a stream: a provider cannot make the server buffer more), and a breaker
// that stops calling for a minute after repeated failures. Every failure returns null and the caller carries on without a
// decision; nothing waits on the model or breaks because of it.
//
// No SDK on purpose: one fetch, no dependency to audit or update.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readBodyCapped } from "../safe-json";
import { sql, store, tx } from "../store";

/** Instructions and criteria may be text or structured. */
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

export interface SmartResult<Qs extends Record<string, Question>> {
  answers: { [K in keyof Qs]: AnswerOf<Qs[K]> };
  /** The versioned model that answered (server-side only; never sent to a browser). */
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

const CACHE_MAX = 500;

interface SmartState {
  cache: Map<string, { at: number; value: Omit<SmartResult<Record<string, Question>>, "ms" | "cached"> }>;
  failures: number;
  openUntil: number;
  calls: number;
  errors: number;
  totalMs: number;
}
const KEY = Symbol.for("zvena.decide.smart");
const g = globalThis as unknown as Record<symbol, SmartState | undefined>;
const st: SmartState = (g[KEY] ??= { cache: new Map(), failures: 0, openUntil: 0, calls: 0, errors: 0, totalMs: 0 });

function settings() {
  return {
    // Both the endpoint and the key, or nothing is ever sent.
    key: (process.env.ZVENA_AI_URL?.trim() && process.env.ZVENA_AI_KEY?.trim()) || "",
    // Unset: the request names no model and the provider's default answers.
    model: process.env.ZVENA_AI_MODEL?.trim() || "",
    timeoutMs: Number(process.env.ZVENA_AI_TIMEOUT_MS) || 1500,
    endpoint: process.env.ZVENA_AI_URL?.trim() || "",
  };
}

/** Whether the model can be asked at all (it is configured and the breaker is closed). */
export function smartAvailable(now = Date.now()): boolean {
  return Boolean(settings().key) && now >= st.openUntil;
}

export function smartConfigured(): boolean {
  return Boolean(settings().key);
}

/** Counters for /status and the decisions page. */
export function smartStats() {
  return { configured: smartConfigured(), calls: st.calls, errors: st.errors, avgMs: st.calls ? Math.round(st.totalMs / st.calls) : 0, breakerOpen: Date.now() < st.openUntil };
}

/** The switch in a workspace whose owner has not chosen: on unless ZVENA_AI_DEFAULT=off (opt-in). */
export function smartDefault(): boolean {
  return process.env.ZVENA_AI_DEFAULT?.trim().toLowerCase() !== "off";
}

/** Whether a workspace allows the model; engine.ts registers it (its owner's switch). Absent: off everywhere. */
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

// The spending budget: every question costs money, so the server asks at most
// ZVENA_AI_DAILY_QUESTIONS questions a day in all and ZVENA_AI_WS_DAILY_QUESTIONS
// for one workspace (UTC days), ZVENA_AI_DAILY_PER_OWNER for all the
// workspaces one person owns (many workspaces must not add up to the whole
// server's budget), and never sends a state bigger than ZVENA_AI_MAX_BYTES. The counts live in the database (smart_budget), so a
// restart or a second process does not hand out a new day's budget; the check
// and the take are one transaction. What is charged, per call of ask():
//   - one per question asked, once: a retry after 429/529 is the same question;
//   - an answer from the cache is free;
//   - a request that went out and then failed or timed out stays charged (the
//     provider may have answered and billed it; refunds would let a failing
//     provider be asked without end); only a call that sent nothing at all
//     gives its questions back;
//   - over budget: null, like any other failure, and nothing is taken —
//     callers already carry on without a decision.
// Rows older than a week are pruned (once a day per process).
const BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS smart_budget (
  day TEXT NOT NULL,                 -- UTC, YYYY-MM-DD
  ws TEXT NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (day, ws)
);
CREATE TABLE IF NOT EXISTS smart_budget_owner (
  day TEXT NOT NULL,
  owner TEXT NOT NULL,               -- the workspace's owner when the questions were asked
  used INTEGER NOT NULL,
  PRIMARY KEY (day, owner)
);`;
const BUDGET_KEEP_DAYS = 7;
interface Budget {
  /** The database handle the table was made on. */
  db: DatabaseSync | null;
  /** The last day old rows were pruned. */
  pruned: string;
}
const BUDGET_KEY = Symbol.for("zvena.smart.budget");
const gb = globalThis as unknown as Record<symbol, Budget | undefined>;
const budget: Budget = (gb[BUDGET_KEY] ??= { db: null, pruned: "" });

function limits() {
  const n = (name: string, def: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 && process.env[name]?.trim() ? Math.floor(v) : def;
  };
  const perWs = n("ZVENA_AI_WS_DAILY_QUESTIONS", 1_000);
  return {
    total: n("ZVENA_AI_DAILY_QUESTIONS", 20_000),
    perWs,
    perOwner: n("ZVENA_AI_DAILY_PER_OWNER", 2 * perWs),
    maxBytes: n("ZVENA_AI_MAX_BYTES", 32_768),
    maxResponseBytes: n("ZVENA_AI_MAX_RESPONSE_BYTES", 262_144),
  };
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

function budgetTable(now: number): void {
  const d = store();
  if (budget.db !== d) {
    d.exec(BUDGET_SCHEMA);
    budget.db = d;
  }
  const day = dayOf(now);
  if (budget.pruned !== day) {
    budget.pruned = day;
    const old = dayOf(now - BUDGET_KEEP_DAYS * 86_400_000);
    sql("DELETE FROM smart_budget WHERE day < ?").run(old);
    sql("DELETE FROM smart_budget_owner WHERE day < ?").run(old);
  }
}

/** What spend() took: `owner` is whose share it also came from (null: a workspace with no owner on record). */
interface Spent {
  owner: string | null;
}

/** Takes `n` questions from today's budget for `ws` (and its owner); null (and nothing taken) when it would go over. */
function spend(ws: string, n: number, now: number): Spent | null {
  budgetTable(now);
  const day = dayOf(now);
  const lim = limits();
  // BEGIN IMMEDIATE: no other writer between the check and the take.
  return tx(() => {
    const c = sql("SELECT COALESCE(SUM(used), 0) AS total, COALESCE(SUM(CASE WHEN ws = ? THEN used END), 0) AS mine FROM smart_budget WHERE day = ?").get(ws, day) as { total: number; mine: number };
    if (Number(c.total) + n > lim.total || Number(c.mine) + n > lim.perWs) return null;
    // Counted per owner, not summed over their workspaces now: deleting or handing over a
    // workspace does not hand out a new share.
    const owner = (sql("SELECT owner_id FROM workspaces WHERE id = ?").get(ws) as { owner_id: string } | undefined)?.owner_id ?? null;
    if (owner) {
      const o = sql("SELECT used FROM smart_budget_owner WHERE day = ? AND owner = ?").get(day, owner) as { used: number } | undefined;
      if (Number(o?.used ?? 0) + n > lim.perOwner) return null;
      sql("INSERT INTO smart_budget_owner (day, owner, used) VALUES (?, ?, ?) ON CONFLICT(day, owner) DO UPDATE SET used = used + excluded.used").run(day, owner, n);
    }
    sql("INSERT INTO smart_budget (day, ws, used) VALUES (?, ?, ?) ON CONFLICT(day, ws) DO UPDATE SET used = used + excluded.used").run(day, ws, n);
    return { owner };
  });
}

/** Gives back what spend() took on `day` when nothing was sent. */
function refund(ws: string, spent: Spent, n: number, day: string): void {
  sql("UPDATE smart_budget SET used = MAX(0, used - ?) WHERE day = ? AND ws = ?").run(n, day, ws);
  if (spent.owner) sql("UPDATE smart_budget_owner SET used = MAX(0, used - ?) WHERE day = ? AND owner = ?").run(n, day, spent.owner);
}

/** Today's spending, for /status and tests. */
export function smartBudget(now = Date.now()) {
  budgetTable(now);
  const day = dayOf(now);
  const lim = limits();
  const used = Number((sql("SELECT COALESCE(SUM(used), 0) AS used FROM smart_budget WHERE day = ?").get(day) as { used: number }).used);
  return { day, used, limit: lim.total, perWorkspace: lim.perWs, perOwner: lim.perOwner };
}

/** The answer's body as JSON, read with a cap (a lying or missing Content-Length cannot make it bigger); null past it or when it is not JSON. */
async function answerJson(res: Response, maxBytes: number): Promise<unknown> {
  const body = await readBodyCapped(res, maxBytes);
  if (!body.ok) {
    // Too big by its Content-Length: the body was never read; let the connection go.
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Asks the model the questions about `state`, on behalf of workspace `ws`. Returns
 * null when it is off (not configured, or the workspace's owner turned it off), slow,
 * down, or the answer is malformed; the caller decides what that means
 * (usually: no automatic action).
 */
export async function ask<Qs extends Record<string, Question>>(ws: string, state: unknown, questions: Qs, opts: AskOptions = {}): Promise<SmartResult<Qs> | null> {
  const cfg = settings();
  const t0 = Date.now();
  if (!cfg.key || t0 < st.openUntil || !allowed(ws)) return null;
  const body = JSON.stringify({ ...(cfg.model ? { model: cfg.model } : {}), state, questions });
  const cacheMs = opts.cacheMs ?? 10 * 60_000;
  const hash = createHash("sha256").update(body).digest("base64url");
  const hit = cacheMs > 0 ? st.cache.get(hash) : undefined;
  if (hit && t0 - hit.at < cacheMs) return { ...(hit.value as Omit<SmartResult<Qs>, "ms" | "cached">), ms: 0, cached: true };
  const lim = limits();
  if (Buffer.byteLength(body) > lim.maxBytes) return null;
  const cost = Math.max(1, Object.keys(questions).length);
  const spent = spend(ws, cost, t0);
  if (!spent) return null;
  let sent = 0;

  const deadline = t0 + (opts.timeoutMs ?? cfg.timeoutMs);
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left < 50) break;
    try {
      sent++;
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(left),
      });
      if (res.status === 429 || res.status === 529) {
        await res.body?.cancel().catch(() => undefined);
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 150, Math.max(0, deadline - Date.now() - 100)));
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        break;
      }
      const out = (await answerJson(res, lim.maxResponseBytes)) as { model?: unknown; answers?: unknown; usage?: unknown } | null;
      if (!out || typeof out !== "object") break;
      const answers = validAnswers(out.answers, questions);
      if (!answers) break;
      const value = {
        answers: answers as SmartResult<Qs>["answers"],
        model: typeof out.model === "string" ? out.model.slice(0, 60) : cfg.model || "default",
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
        st.cache.set(hash, { at: Date.now(), value: value as Omit<SmartResult<Record<string, Question>>, "ms" | "cached"> });
      }
      return { ...value, ms, cached: false };
    } catch {
      // Timeout or network: give up for this call (the budget stays spent: the request may have been billed).
      break;
    }
  }
  // Nothing went out at all (the time budget was gone before the first try): the questions are given back.
  if (!sent) refund(ws, spent, cost, dayOf(t0));
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

/**
 * Test hook: forget the cache, the counters and the breaker — what a restart
 * forgets — and, unless `budget: false`, today's spending in the database too.
 */
export function resetSmart(opts: { budget?: boolean } = {}): void {
  st.cache.clear();
  st.failures = 0;
  st.openUntil = 0;
  st.calls = 0;
  st.errors = 0;
  st.totalMs = 0;
  budget.db = null;
  budget.pruned = "";
  if (opts.budget !== false) {
    budgetTable(Date.now());
    sql("DELETE FROM smart_budget").run();
    sql("DELETE FROM smart_budget_owner").run();
  }
}
