// Server-only: the state of zvena's parts for /status and /api/health.
// Says nothing about people or content: only whether each part answers.

import { statfs } from "node:fs/promises";
import { notesFilesDir } from "./notes/files";
import { mailConfigured } from "./mail";
import { sql } from "./store";

export type PartState = "ok" | "degraded" | "down" | "off";

export interface Health {
  ok: boolean;
  at: string;
  parts: { web: PartState; database: PartState; files: PartState; design: PartState; mail: PartState };
}

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

async function filesState(): Promise<PartState> {
  try {
    const fs = await statfs(notesFilesDir()).catch(() => statfs("/"));
    const free = Number(fs.bavail) * Number(fs.bsize);
    return free < 2 * 1024 ** 3 ? "degraded" : "ok";
  } catch {
    return "down";
  }
}

export async function health(): Promise<Health> {
  let database: PartState = "ok";
  try {
    sql("SELECT 1").get();
  } catch {
    database = "down";
  }
  const [files, design] = await Promise.all([filesState(), designState()]);
  const parts = { web: "ok" as PartState, database, files, design, mail: (mailConfigured() ? "ok" : "off") as PartState };
  return { ok: database === "ok" && files !== "down" && design !== "down", at: new Date().toISOString(), parts };
}
