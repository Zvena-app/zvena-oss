// Server-only: integration webhooks (Notion's). After a write is committed
// (after-push reaction) every integration of the workspace with a webhook
// gets the events it subscribed to — for pages it can see — as a signed
// HTTPS POST. Delivery never blocks the write: events wait in memory, are
// sent through the SSRF guard of lib/web-read.ts and retried with backoff.

import { createHmac, randomUUID } from "node:crypto";
import https from "node:https";
import { onAfterPush, type NoteChange, type PushContext } from "../after-push";
import { allowedUrl, safeLookup } from "../../web-read";
import { sql } from "../../store";
import type { Note } from "../types";
import { AccessResolver } from "../access";
import { connectorsOf, listIntegrations, webhookSecretOf, type Integration, type WebhookEvent } from "./integrations";
import { toUuid } from "./space";

export interface WebhookPayload {
  id: string;
  timestamp: string;
  workspace_id: string;
  integration_id: string;
  type: WebhookEvent;
  authors: { id: string; type: "person" | "bot" | "system" }[];
  entity: { id: string; type: "page" | "database" | "data_source" | "comment" };
  data: Record<string, unknown>;
  attempt_number: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The events one saved change makes (Notion's names). */
export function eventsOf(c: NoteChange): { type: WebhookEvent; entity: WebhookPayload["entity"]; data: Record<string, unknown> }[] {
  const out: { type: WebhookEvent; entity: WebhookPayload["entity"]; data: Record<string, unknown> }[] = [];
  const n = c.after ?? c.before;
  if (!n || n.synced) return out;
  const isDb = n.kind === "database";
  const entity = { id: toUuid(n.id), type: isDb ? ("database" as const) : ("page" as const) };
  const parent = n.parentId ? { id: toUuid(n.parentId) } : { type: "workspace" };
  const trashedNow = c.after && c.after.trashedAt !== null && (!c.before || c.before.trashedAt === null);
  // Every database note is also a data source (Notion API 2025-09-03): its database is itself, or the one it sits in.
  const source = { id: toUuid(n.id), type: "data_source" as const };
  const sourceParent = n.db?.dataSource && n.parentId ? { id: toUuid(n.parentId), type: "database" } : { id: toUuid(n.id), type: "database" };
  if (!c.after || trashedNow) {
    out.push({ type: isDb ? "database.deleted" : "page.deleted", entity, data: { parent } });
    if (isDb) out.push({ type: "data_source.deleted", entity: source, data: { parent: sourceParent } });
    return out;
  }
  const a = c.after;
  const b = c.before;
  if (!b) {
    out.push({ type: isDb ? "database.created" : "page.created", entity, data: { parent } });
    if (isDb) out.push({ type: "data_source.created", entity: source, data: { parent: sourceParent } });
  } else if (isDb) {
    if (!same(a.db?.properties, b.db?.properties) || a.title !== b.title) out.push({ type: "database.schema_updated", entity, data: { parent } });
    if (!same(a.db?.properties, b.db?.properties)) out.push({ type: "data_source.schema_updated", entity: source, data: { parent: sourceParent } });
  } else {
    if (!same(a.content, b.content)) out.push({ type: "page.content_updated", entity, data: { parent } });
    if (a.title !== b.title || !same(a.props, b.props) || a.icon !== b.icon || !same(a.cover, b.cover)) out.push({ type: "page.properties_updated", entity, data: { parent } });
  }
  const before = new Set((b?.comments ?? []).map((x) => x.id));
  for (const cm of a.comments ?? []) {
    if (!before.has(cm.id) && !cm.suggestion) out.push({ type: "comment.created", entity: { id: cm.id, type: "comment" }, data: { page_id: toUuid(a.id), ...(cm.thread ? { discussion_id: cm.thread } : {}) } });
  }
  return out;
}

/** Whether the integration may see the note: it or a page above it is connected (read from the stored notes). */
/** Whether the integration sees the note: under a connected page, and readable by whoever connected it. */
function canSee(ws: string, roots: Map<string, string>, note: Note | null, memo: Map<string, Note | null>): boolean {
  let cur: Note | null = note;
  for (let depth = 0; cur && depth < 100; depth++) {
    const connector = roots.get(cur.id);
    if (connector !== undefined) return !note || !connector || new AccessResolver(ws, connector).level(note.id) !== null;
    const pid: string | null = cur.parentId;
    if (!pid) return false;
    if (!memo.has(pid)) {
      const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, pid) as { json: string | null } | undefined;
      let n: Note | null = null;
      try {
        n = JSON.parse(r?.json ?? "null") as Note | null;
      } catch {
        n = null;
      }
      memo.set(pid, n);
    }
    cur = memo.get(pid) ?? null;
  }
  return false;
}

function authorOf(by: string): WebhookPayload["authors"][number] {
  if (by.startsWith("integration:")) return { id: toUuid(by.slice("integration:".length)), type: "bot" };
  if (by === "form" || by.startsWith("automation:")) return { id: by, type: "system" };
  return { id: by, type: "person" };
}

// --- Queue and delivery ----------------------------------------------------------

interface Job {
  url: string;
  integration: string;
  payload: WebhookPayload;
  attempt: number;
}

const KEY = Symbol.for("zvena.api.webhookQueue");
const g = globalThis as unknown as Record<symbol, { jobs: Job[]; busy: boolean; send: Sender } | undefined>;

export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<number>;

/** The real sender: HTTPS only, default port, every address checked at connect time, 5 s, no redirects. */
export const httpsSender: Sender = (raw, body, headers) =>
  new Promise((resolve) => {
    const u = allowedUrl(raw);
    if (!u || u.protocol !== "https:") return resolve(0);
    const req = https.request(u, { method: "POST", lookup: safeLookup, timeout: 5000, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
    req.end(body);
  });

const queue = (g[KEY] ??= { jobs: [], busy: false, send: httpsSender });
const MAX_QUEUE = 1000;
const BACKOFF = [1_000, 10_000, 60_000];

/** Test hook: replaces the sender (and returns the queue). */
export function setSender(send: Sender): Job[] {
  queue.send = send;
  return queue.jobs;
}

/** "sha256=<hex>" of the body with the integration's signing secret. */
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Sends one job; failed jobs come back later, up to 4 attempts in all. */
export async function deliver(job: Job): Promise<boolean> {
  const secret = webhookSecretOf(job.integration);
  if (!secret) return false;
  const payload = { ...job.payload, attempt_number: job.attempt };
  const body = JSON.stringify(payload);
  const status = await queue.send(job.url, body, {
    "content-type": "application/json",
    "user-agent": "zvena-webhooks/1",
    "x-zvena-event": payload.type,
    "x-zvena-delivery": payload.id,
    "x-zvena-signature": signature(secret, body),
  });
  if (status >= 200 && status < 300) return true;
  if (job.attempt <= BACKOFF.length) {
    const wait = BACKOFF[job.attempt - 1];
    setTimeout(() => {
      queue.jobs.push({ ...job, attempt: job.attempt + 1 });
      void drain();
    }, wait).unref?.();
  }
  return false;
}

async function drain(): Promise<void> {
  if (queue.busy) return;
  queue.busy = true;
  try {
    while (queue.jobs.length) {
      const job = queue.jobs.shift() as Job;
      await deliver(job).catch(() => false);
    }
  } finally {
    queue.busy = false;
  }
}

/** Test hook: sends what is waiting now (retries scheduled for later stay scheduled). */
export async function flushWebhooks(): Promise<void> {
  for (let i = 0; i < 50 && (queue.jobs.length || queue.busy); i++) {
    await drain();
    if (queue.busy) await new Promise((r) => setTimeout(r, 10));
  }
}

function enqueue(job: Job): void {
  if (queue.jobs.length >= MAX_QUEUE) queue.jobs.shift();
  queue.jobs.push(job);
  setImmediate(() => void drain());
}

/** The reaction: events of a committed write for every subscribed integration that can see the note. */
export function webhookReaction(changes: readonly NoteChange[], ctx: PushContext, list: Integration[] = listIntegrations(ctx.ws)): number {
  const hooked = list.filter((i) => i.webhook && i.webhook.events.length);
  if (!hooked.length) return 0;
  const memo = new Map<string, Note | null>();
  for (const c of changes) memo.set(c.id, c.after ?? c.before);
  let queued = 0;
  for (const i of hooked) {
    // An integration does not hear its own writes.
    if (ctx.by === `integration:${i.id}`) continue;
    const roots = connectorsOf(i.id);
    for (const c of changes) {
      const note = c.after ?? c.before;
      if (!canSee(ctx.ws, roots, note, memo)) continue;
      for (const e of eventsOf(c)) {
        if (!i.webhook?.events.includes(e.type)) continue;
        enqueue({
          url: i.webhook.url,
          integration: i.id,
          attempt: 1,
          payload: { id: randomUUID(), timestamp: new Date().toISOString(), workspace_id: ctx.ws, integration_id: toUuid(i.id), type: e.type, authors: [authorOf(ctx.by)], entity: e.entity, data: e.data, attempt_number: 1 },
        });
        queued += 1;
      }
    }
  }
  return queued;
}

onAfterPush("api-webhooks", (changes, ctx) => void webhookReaction(changes, ctx));
