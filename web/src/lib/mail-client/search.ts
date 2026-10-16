// Server-only: searching one person's mail (their own full-text index only:
// mail is never in the ecosystem's shared index, so nobody else can find it).

import { sql } from "../store";
import { mailDb } from "./schema";
import { listThreads } from "./store";
import type { ThreadSummary } from "./types";
import { parseSearch, type ViewFilter } from "./views";

/** The search box's query as a filter, its label:name terms turned into the person's label ids. */
export function searchFilter(userId: string, q: string): ViewFilter {
  const { filter, labelNames } = parseSearch(q);
  if (labelNames.length) {
    const ids = labelNames.flatMap((name) => (sql("SELECT id FROM mail_labels WHERE user_id = ? AND lower(name) = lower(?)").all(userId, name) as { id: string }[]).map((r) => r.id));
    // A label that does not exist matches nothing (not everything).
    filter.labels = ids.length ? ids : ["-none-"];
  }
  return filter;
}

export function searchThreads(userId: string, q: string, opts: { limit?: number; offset?: number } = {}): { threads: ThreadSummary[]; more: boolean } {
  mailDb();
  if (!q.trim()) return { threads: [], more: false };
  return listThreads(userId, searchFilter(userId, q), opts);
}

/** For zvena's ⌘K search: the person's best few conversations. */
export function searchMailThreads(userId: string, q: string, limit: number): { id: string; snippet?: string }[] {
  try {
    if (!sql("SELECT 1 FROM kv WHERE k = 'mail:schema'").get()) return [];
    if (!sql("SELECT 1 FROM mail_accounts WHERE user_id = ? LIMIT 1").get(userId)) return [];
    return searchThreads(userId, q, { limit }).threads.map((t) => ({ id: t.id, snippet: t.snippet || undefined }));
  } catch {
    return [];
  }
}
