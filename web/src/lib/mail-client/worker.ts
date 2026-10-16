// Server-only: one sync worker per mailbox, for as long as the server runs.
//
//   connect → list folders → sync them → IDLE on the folder new mail lands in
//   new mail ("exists")  → that folder is synced at once
//   every 2 minutes      → the other folders that changed (STATUS UIDNEXT)
//   every 10 minutes     → a full pass (flags, deletions made elsewhere)
//   a server without IDLE is polled the same way (imapflow's NOOP)
//   a dropped connection → reconnect with backoff (5 s doubling to 15 min;
//                          a refused password waits 30 min, or a new one)
//
// A second, short-lived connection runs what people do (texts, attachments,
// flags, moves, drafts) so a long sync never makes a click wait.
//
// Workers start with the server (instrumentation.ts → startMail) and when a
// person opens Mail (ensureWorker); ZVENA_MAIL_SYNC=off keeps them off. One
// process owns them (like the store): they hang off globalThis.

import type { ImapFlow } from "imapflow";
import { sql } from "../store";
import { connectImap, discoverFolders, failureOf, fetchBody, runOp, syncedFolders, syncFolder, watchedFolder, bodyDays, type OpArg } from "./imap";
import { mailChanged, notifyFresh } from "./events";
import { accountById, pruneBodies, setAccountState, type AccountRow } from "./store";
import { mailDb } from "./schema";

const BACKOFF_MIN = 5_000;
const BACKOFF_MAX = 15 * 60_000;
const AUTH_WAIT = 30 * 60_000;
const POLL_MS = 2 * 60_000;
const FULL_MS = 10 * 60_000;
const INTERACTIVE_IDLE_MS = 90_000;
/** Background text fetches per pass. */
const BODIES_PER_PASS = 40;
const MAX_OP_TRIES = 8;

export function syncEnabled(): boolean {
  return process.env.ZVENA_MAIL_SYNC !== "off";
}

const sleep = (ms: number, signal: { stopped: boolean; wake?: () => void }) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    (t as { unref?: () => void }).unref?.();
    function done() {
      clearTimeout(t);
      signal.wake = undefined;
      resolve();
    }
    signal.wake = done;
  });

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class AccountWorker {
  stopped = false;
  wake?: () => void;
  private client: ImapFlow | null = null;
  private fast: ImapFlow | null = null;
  private fastTimer: ReturnType<typeof setTimeout> | null = null;
  private fastLock = new Mutex();
  private syncLock = new Mutex();
  private failures = 0;
  private lastFull = 0;
  private dirty = new Set<string>();
  private opsRunning = false;

  constructor(readonly accountId: string) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
    for (const c of [this.client, this.fast]) {
      try {
        c?.close();
      } catch {
        // Already closed.
      }
    }
    this.client = null;
    this.fast = null;
  }

  /** Sync now (the person pressed refresh, a password was updated). */
  poke(): void {
    this.failures = 0;
    this.lastFull = 0;
    this.wake?.();
    if (this.client?.usable) void this.syncAll(true).catch(() => undefined);
  }

  private account(): AccountRow | null {
    const a = accountById(this.accountId);
    if (!a) this.stop();
    return a;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const acct = this.account();
      if (!acct) return;
      try {
        setAccountState(acct.id, "syncing", null);
        const client = await connectImap(acct, { idle: true });
        if (this.stopped) {
          client.close();
          return;
        }
        this.client = client;
        await discoverFolders(client, acct);
        await this.syncAll(true);
        const up = Date.now();
        await this.watch(client);
        // A server that drops the connection right after a sync (connection limits) backs off like any failure.
        if (Date.now() - up > 5 * 60_000) this.failures = 0;
        else this.failures++;
      } catch (e) {
        if (this.stopped) return;
        const f = failureOf(e);
        setAccountState(acct.id, f.state, f.error);
        mailChanged(acct.user_id, acct.id);
        this.failures++;
      } finally {
        try {
          this.client?.close();
        } catch {
          // Already closed.
        }
        this.client = null;
      }
      if (this.stopped) return;
      const a = accountById(this.accountId);
      const wait = a?.state === "auth" ? AUTH_WAIT : Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** Math.min(this.failures, 12));
      await sleep(wait * (0.8 + Math.random() * 0.4), this);
    }
  }

  /** IDLE until the connection drops; folders sync as their mail arrives. */
  private async watch(client: ImapFlow): Promise<void> {
    const acct = this.account();
    if (!acct) return;
    const idlePath = watchedFolder(acct);
    await client.mailboxOpen(idlePath, { readOnly: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onExists = (e: { path?: string }) => {
      this.dirty.add(e.path ?? idlePath);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void this.syncDirty().catch(() => undefined), 400);
    };
    client.on("exists", onExists);
    client.on("flags", onExists);
    client.on("expunge", onExists);
    const poll = setInterval(() => void this.syncAll(Date.now() - this.lastFull > FULL_MS).catch(() => undefined), POLL_MS);
    // Mail that arrived while other folders were syncing (no EXISTS reached us then): one look now.
    onExists({ path: idlePath });
    try {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        const check = setInterval(() => {
          if (this.stopped) {
            clearInterval(check);
            resolve();
          }
        }, 1000);
        client.once("close", () => clearInterval(check));
      });
    } finally {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      client.off("exists", onExists);
      client.off("flags", onExists);
      client.off("expunge", onExists);
    }
  }

  private async syncDirty(): Promise<void> {
    const paths = [...this.dirty];
    this.dirty.clear();
    await this.syncLock.run(async () => {
      const acct = this.account();
      const client = this.client;
      if (!acct || !client?.usable) return;
      const folders = syncedFolders(acct).filter((f) => paths.includes(f.path));
      await this.syncFolders(client, acct, folders, true);
    });
  }

  /** Every synced folder; `full`: flags and deletions too. */
  async syncAll(full: boolean): Promise<void> {
    await this.syncLock.run(async () => {
      const acct = this.account();
      const client = this.client;
      if (!acct || !client?.usable) return;
      await this.syncFolders(client, acct, syncedFolders(acct), full);
      if (full) this.lastFull = Date.now();
      setAccountState(acct.id, "ok", null, Date.now());
      void this.drainOps();
      void this.fetchBodies().catch(() => undefined);
    });
  }

  private async syncFolders(client: ImapFlow, acct: AccountRow, folders: ReturnType<typeof syncedFolders>, full: boolean): Promise<void> {
    let changed = false;
    const fresh: { n: number; threadId: string }[] = [];
    for (const f of folders) {
      if (this.stopped || !client.usable) return;
      try {
        const r = await syncFolder(client, acct, f, full);
        changed ||= r.changed;
        fresh.push(...r.fresh);
      } catch (e) {
        // A folder that cannot be opened (deleted meanwhile) does not stop the others.
        if (!client.usable) throw e;
      }
    }
    try {
      await client.mailboxOpen(watchedFolder(acct), { readOnly: true });
    } catch {
      // The connection is going away; the loop reconnects.
    }
    if (fresh.length) notifyFresh(acct, fresh);
    if (changed || fresh.length) mailChanged(acct.user_id, acct.id, fresh.length);
  }

  /** Texts of recent mail, newest first, so search finds them and opening is instant. */
  private async fetchBodies(): Promise<void> {
    const acct = this.account();
    if (!acct) return;
    const since = Date.now() - bodyDays() * 86_400_000;
    const rows = sql("SELECT n, folder, uid, text_part, html_part FROM mail_messages WHERE account_id = ? AND body = 0 AND uid > 0 AND date >= ? AND size < 5000000 ORDER BY date DESC LIMIT ?").all(acct.id, since, BODIES_PER_PASS) as {
      n: number;
      folder: string;
      uid: number;
      text_part: string | null;
      html_part: string | null;
    }[];
    if (!rows.length) return;
    await this.withFast(async (c) => {
      for (const r of rows) {
        if (this.stopped) return;
        await fetchBody(c, { ...r, n: Number(r.n), uid: Number(r.uid) });
      }
    });
    pruneBodies(acct.user_id);
    // The list's previews come from the texts: open tabs refresh.
    mailChanged(acct.user_id, acct.id);
  }

  /** The connection for what people do (opened on demand, closed when idle). */
  async withFast<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    return this.fastLock.run(async () => {
      if (this.fastTimer) clearTimeout(this.fastTimer);
      if (!this.fast?.usable) {
        const acct = this.account();
        if (!acct) throw new Error("account gone");
        try {
          this.fast?.close();
        } catch {
          // Already closed.
        }
        this.fast = await connectImap(acct);
      }
      try {
        return await fn(this.fast);
      } finally {
        this.fastTimer = setTimeout(() => {
          try {
            this.fast?.close();
          } catch {
            // Already closed.
          }
          this.fast = null;
        }, INTERACTIVE_IDLE_MS);
        (this.fastTimer as { unref?: () => void }).unref?.();
      }
    });
  }

  /** Carries waiting changes to the server, oldest first. */
  async drainOps(): Promise<void> {
    if (this.opsRunning || this.stopped) return;
    this.opsRunning = true;
    try {
      for (let round = 0; round < 20; round++) {
        const acct = this.account();
        if (!acct) return;
        const ops = sql("SELECT id, kind, arg, tries FROM mail_ops WHERE account_id = ? AND next_at <= ? ORDER BY id LIMIT 20").all(acct.id, Date.now()) as { id: number; kind: string; arg: string; tries: number }[];
        if (!ops.length) return;
        let changed = false;
        await this.withFast(async (c) => {
          for (const op of ops) {
            let out: "done" | "retry" = "retry";
            try {
              const arg = JSON.parse(op.arg) as OpArg;
              // Drafts build MIME messages (compose.ts): loaded when one is waiting.
              out = op.kind.startsWith("draft-") ? await (await import("./drafts")).runDraftOp(acct, op.kind, arg, c) : await runOp(c, acct, op.kind, arg);
            } catch (e) {
              if (!c.usable) throw e;
              out = "retry";
            }
            if (out === "done" || op.tries + 1 >= MAX_OP_TRIES) {
              sql("DELETE FROM mail_ops WHERE id = ?").run(op.id);
              changed = true;
            } else sql("UPDATE mail_ops SET tries = tries + 1, next_at = ? WHERE id = ?").run(Date.now() + 2_000 * 2 ** op.tries, op.id);
          }
        });
        if (changed) mailChanged(acct.user_id, acct.id);
      }
    } catch {
      // The server is away: the ops wait for the next pass.
    } finally {
      this.opsRunning = false;
    }
  }
}

// --- The registry ------------------------------------------------------------------

interface Registry {
  workers: Map<string, AccountWorker>;
  ticker: ReturnType<typeof setInterval> | null;
}
const KEY = Symbol.for("zvena.mail.workers");
const g = globalThis as unknown as Record<symbol, Registry | undefined>;
const reg: Registry = (g[KEY] ??= { workers: new Map(), ticker: null });

/** The account's worker, started if it is not running. */
export function ensureWorker(accountId: string): AccountWorker | null {
  if (!syncEnabled()) return null;
  let w = reg.workers.get(accountId);
  if (w && !w.stopped) return w;
  if (!accountById(accountId)) return null;
  w = new AccountWorker(accountId);
  reg.workers.set(accountId, w);
  w.start();
  return w;
}

export function workerOf(accountId: string): AccountWorker | null {
  const w = reg.workers.get(accountId);
  return w && !w.stopped ? w : null;
}

export function stopWorker(accountId: string): void {
  reg.workers.get(accountId)?.stop();
  reg.workers.delete(accountId);
}

/** Every worker of the process (tests). */
export function stopAllWorkers(): void {
  for (const id of [...reg.workers.keys()]) stopWorker(id);
  if (reg.ticker) clearInterval(reg.ticker);
  reg.ticker = null;
}

/**
 * Runs an IMAP command for an account: on its worker's second connection,
 * or (sync off, a test) on a connection of its own.
 */
export async function withImap<T>(acct: AccountRow, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const w = ensureWorker(acct.id);
  if (w) return w.withFast(fn);
  const c = await connectImap(acct);
  try {
    return await fn(c);
  } finally {
    try {
      await c.logout();
    } catch {
      c.close();
    }
  }
}

/** Queues a change for the server and starts carrying it. */
export function enqueueOp(accountId: string, kind: string, messageIds: string[], arg: OpArg, delayMs = 0): void {
  mailDb();
  const now = Date.now();
  sql("INSERT INTO mail_ops (account_id, kind, message_ids, arg, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(accountId, kind, JSON.stringify(messageIds), JSON.stringify(arg), now + delayMs, now);
  const w = ensureWorker(accountId);
  if (w) {
    if (delayMs > 0) setTimeout(() => void w.drainOps(), delayMs + 50).unref?.();
    else void w.drainOps();
  }
}

/** Starts every account's worker and the clock (once per process). */
export function startWorkers(tick: () => void): void {
  if (!syncEnabled()) return;
  if (!reg.ticker) {
    reg.ticker = setInterval(() => {
      try {
        tick();
      } catch (e) {
        console.error(`[mail] tick failed (${e instanceof Error ? e.name : "error"})`);
      }
    }, 5_000);
    (reg.ticker as { unref?: () => void }).unref?.();
  }
  try {
    mailDb();
    for (const r of sql("SELECT id FROM mail_accounts").all() as { id: string }[]) ensureWorker(r.id);
  } catch {
    // The store is not ready (a build step): requests start the workers later.
  }
}
