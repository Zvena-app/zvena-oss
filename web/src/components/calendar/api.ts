"use client";

// The browser's side of /api/calendar: JSON in and out, the workspace in
// every call, this tab's pulse id on writes (its own echo is skipped).

import { pulseHeaders } from "@/lib/pulse/client";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

export async function calApi<T = unknown>(ws: string, path: string, opts: { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null>; raw?: BodyInit; signal?: AbortSignal } = {}): Promise<T> {
  const q = new URLSearchParams({ ws });
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) q.set(k, String(v));
  const method = opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? "POST" : "GET");
  const res = await fetch(`/api/calendar/${path}?${q.toString()}`, {
    method,
    headers: { ...(method !== "GET" ? pulseHeaders() : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : opts.raw !== undefined ? { "content-type": "text/calendar" } : {}) },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}
