// Server-only: Mail's background work, started once per server process
// (instrumentation.ts): every mailbox's sync worker (worker.ts) and a clock
// every 5 seconds for what is due — messages leaving the outbox (undo send,
// send later) and snoozed conversations coming back — plus, now and then,
// files left behind by drafts. ZVENA_MAIL_SYNC=off keeps it all off.

import { wakeSnoozed } from "./actions";
import { cleanupUploads } from "./attachments";
import { mailDb } from "./schema";
import { sql } from "../store";
import { sendDue } from "./send";
import { startWorkers, syncEnabled } from "./worker";

let lastCleanup = 0;
let sending = false;

export function mailTick(now = Date.now()): void {
  mailDb();
  wakeSnoozed(now);
  if (!sending) {
    sending = true;
    void sendDue(now).finally(() => (sending = false));
  }
  if (now - lastCleanup > 3600_000) {
    lastCleanup = now;
    void cleanupUploads(now).catch(() => undefined);
  }
}

export function startMail(): void {
  if (!syncEnabled()) return;
  try {
    // A message the server was sending when it stopped may or may not have left: its person decides (Try again).
    mailDb();
    sql("UPDATE mail_outbox SET state = 'failed', error = 'interrupted' WHERE state = 'sending'").run();
  } catch {
    // The store is not ready (a build step).
  }
  startWorkers(() => mailTick());
}
