// Server-only: attachments both ways. Received ones stay on the mail server
// and are downloaded when someone opens one (never cached on disk); files
// attached in the composer wait in ZVENA_FILES_DIR/mail-uploads/<user>/
// until the message is sent (then they go) or for a week without a draft.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, sql } from "../store";
import { MAX_ATTACHMENTS_BYTES, uploadsDir } from "./compose";
import { openPart } from "./imap";
import { mailDb } from "./schema";
import { accountById, attachmentsOf, messageRowByN, ownAttachment, type MessageRow } from "./store";
import { withImap } from "./worker";
import type { DraftAttachment } from "./types";

/** Files waiting in drafts, per person. */
export function uploadsQuota(): number {
  const v = Number(process.env.ZVENA_MAIL_UPLOADS_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200 * 1024 ** 2;
}

async function readAll(s: import("node:stream").Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of s) {
    const b: Buffer = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** A part of one of the person's messages, downloaded from the mail server (capped). */
export async function readPart(userId: string, row: MessageRow, part: string, max = MAX_ATTACHMENTS_BYTES * 2): Promise<Buffer | null> {
  const acct = accountById(row.account_id);
  if (!acct || acct.user_id !== userId || Number(row.uid) <= 0) return null;
  return withImap(acct, async (c) => {
    const p = await openPart(c, row.folder, Number(row.uid), part, max + 1);
    if (!p) return null;
    try {
      return await readAll(p.content, max);
    } finally {
      p.release();
    }
  }).catch(() => null);
}

/** One of the person's attachments with its content, or null. */
export async function attachmentContent(userId: string, id: unknown): Promise<{ filename: string; type: string; content: Buffer } | null> {
  const a = ownAttachment(userId, id);
  if (!a) return null;
  const row = messageRowByN(Number(a.message_n));
  if (!row || row.user_id !== userId) return null;
  const content = await readPart(userId, row, a.part);
  return content ? { filename: a.filename, type: a.type, content } : null;
}

/** The attachments of a forwarded message that go along (only its own, capped together). */
export async function forwardedParts(userId: string, orig: MessageRow, ids: readonly string[]): Promise<{ filename: string; type: string; content: Buffer }[]> {
  const want = new Set(ids);
  const out: { filename: string; type: string; content: Buffer }[] = [];
  let total = 0;
  for (const a of attachmentsOf(Number(orig.n))) {
    if (!want.has(a.id)) continue;
    const content = await readPart(userId, orig, a.part, MAX_ATTACHMENTS_BYTES);
    if (!content) continue;
    total += content.length;
    if (total > MAX_ATTACHMENTS_BYTES) break;
    out.push({ filename: a.filename, type: a.type, content });
  }
  return out;
}

export class UploadError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

const SAFE_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

/** Keeps a file the person attached in the composer. */
export async function saveUpload(userId: string, file: { name: string; type: string; bytes: Uint8Array }): Promise<DraftAttachment> {
  mailDb();
  const size = file.bytes.byteLength;
  if (size > MAX_ATTACHMENTS_BYTES) throw new UploadError(413, "file too big");
  const used = Number((sql("SELECT COALESCE(SUM(size), 0) AS b FROM mail_uploads WHERE user_id = ?").get(userId) as { b: number }).b);
  if (used + size > uploadsQuota()) throw new UploadError(507, "uploads full");
  const id = newId(12);
  const filename = (file.name || "file").replace(/[\u0000-\u001f\u007f/\\]+/g, "_").slice(0, 200);
  const type = SAFE_TYPE.test(file.type) ? file.type.toLowerCase() : "application/octet-stream";
  const dir = join(uploadsDir(), userId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, id), file.bytes, { mode: 0o600 });
  sql("INSERT INTO mail_uploads (id, user_id, filename, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, filename, type, size, Date.now());
  return { id, filename, type, size };
}

/** Files no draft or queued message holds any more, after a week. */
export async function cleanupUploads(now = Date.now()): Promise<number> {
  mailDb();
  const old = sql("SELECT id, user_id FROM mail_uploads WHERE created_at < ?").all(now - 7 * 86_400_000) as { id: string; user_id: string }[];
  let n = 0;
  for (const u of old) {
    const held =
      sql("SELECT 1 FROM mail_drafts WHERE user_id = ? AND json LIKE ?").get(u.user_id, `%"${u.id}"%`) || sql("SELECT 1 FROM mail_outbox WHERE user_id = ? AND draft LIKE ?").get(u.user_id, `%"${u.id}"%`);
    if (held) continue;
    sql("DELETE FROM mail_uploads WHERE id = ?").run(u.id);
    await rm(join(uploadsDir(), u.user_id, u.id), { force: true }).catch(() => undefined);
    n++;
  }
  return n;
}

/** Every file of a person (their account is being deleted). */
export async function dropAllUploads(userId: string): Promise<void> {
  await rm(join(uploadsDir(), userId), { recursive: true, force: true }).catch(() => undefined);
}
