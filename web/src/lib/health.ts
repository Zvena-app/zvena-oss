// Server-only: the state of zvena's parts for /status and /api/health.
// Says nothing about people or content: only whether each part answers.
//
// Two answers from one look:
// - `ok` is readiness, for machines (the HTTP status of /api/health: the
//   container's healthcheck, deploy/scripts' wait_healthy, monitor.sh and the
//   release scripts): false only when a part zvena cannot serve without is
//   down (the database, the files volume, Design). A full disk or a mail
//   problem leaves it true — a restart would not help, and nothing should
//   roll back or loop over it.
// - `status` is what people read on /status: anything short of every part
//   working shows, from "degraded" up to "major outage".

import { constants } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import { minFreeBytes, notesFilesDir } from "./notes/files";
import { mailCheck, mailConfigured, refreshSmtpCheck } from "./mail";
import { sql } from "./store";

/** "unverified": set up, but nothing has shown yet that it works (mail). */
export type PartState = "ok" | "degraded" | "down" | "off" | "unverified";
export type Overall = "operational" | "degraded" | "partial_outage" | "major_outage";

export interface Parts {
  web: PartState;
  database: PartState;
  files: PartState;
  design: PartState;
  mail: PartState;
}

export interface Health {
  ok: boolean;
  status: Overall;
  at: string;
  parts: Parts;
}

// The parts without which nothing of zvena works: one of them down is a major outage.
const CORE: (keyof Parts)[] = ["web", "database", "files"];

// How long a mail check (a letter that went or did not, an SMTP login) stays the answer.
const MAIL_EVIDENCE_MS = 24 * 3600_000;

async function designState(): Promise<PartState> {
  const base = (process.env.PENPOT_MGMT_URL || "").replace(/\/+$/, "");
  if (!base) return "off";
  try {
    const res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

/**
 * The files volume itself (ZVENA_FILES_DIR, created at start): missing, not a
 * directory or not writable is down; less free space than uploads need
 * (ZVENA_MIN_FREE_BYTES — below it uploads are refused, reading still works)
 * is degraded.
 */
export async function filesState(dir = notesFilesDir(), minFree = minFreeBytes()): Promise<PartState> {
  try {
    if (!(await stat(dir)).isDirectory()) return "down";
    await access(dir, constants.W_OK);
  } catch {
    return "down";
  }
  try {
    const fs = await statfs(dir);
    return Number(fs.bavail) * Number(fs.bsize) < minFree ? "degraded" : "ok";
  } catch {
    // No statfs here: uploads go ahead too.
    return "ok";
  }
}

/**
 * Mail as far as it is known: off without a mail service; otherwise the last
 * evidence of the past day (a letter accepted, refused or held back by the
 * budget, or an SMTP login) — ok or degraded; none: "unverified".
 */
export function mailState(now = Date.now()): PartState {
  if (!mailConfigured()) return "off";
  const c = mailCheck();
  if (!c || now - c.at > MAIL_EVIDENCE_MS) return "unverified";
  return c.ok ? "ok" : "degraded";
}

/** Readiness (see the top of this file). */
export function readyOf(parts: Parts): boolean {
  return parts.database === "ok" && parts.files !== "down" && parts.design !== "down";
}

/** What /status says overall. */
export function overallOf(parts: Parts): Overall {
  const all = Object.entries(parts) as [keyof Parts, PartState][];
  if (all.some(([k, v]) => v === "down" && CORE.includes(k))) return "major_outage";
  if (all.some(([, v]) => v === "down")) return "partial_outage";
  if (all.some(([, v]) => v === "degraded")) return "degraded";
  return "operational";
}

export async function health(): Promise<Health> {
  let database: PartState = "ok";
  try {
    sql("SELECT 1").get();
  } catch {
    database = "down";
  }
  // SMTP: a login check in the background when nothing newer tells (its answer shows next time).
  refreshSmtpCheck();
  const [files, design] = await Promise.all([filesState(), designState()]);
  const parts: Parts = { web: "ok", database, files, design, mail: mailState() };
  return { ok: readyOf(parts), status: overallOf(parts), at: new Date().toISOString(), parts };
}
