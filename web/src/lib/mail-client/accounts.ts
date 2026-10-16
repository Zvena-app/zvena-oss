// Server-only: connecting a mailbox, changing it, disconnecting it.
//
// Connecting signs in to both servers before anything is stored: a wrong
// password or server never becomes an account. The password is sealed at
// once (crypto.ts) and never comes back to the browser — a person who wants
// to change it types a new one.

import { newId, sql, tx } from "../store";
import { dropAllUploads } from "./attachments";
import { seal } from "./crypto";
import { checkEndpoint, MailGuardError, type Security } from "./guard";
import { connectImap, failureOf } from "./imap";
import { forgetToken, presetOf, type MailSecret } from "./providers";
import { sanitizeHtml } from "./sanitize";
import { mailDb } from "./schema";
import { smtpTransport } from "./send";
import { accountsOf, ownAccount, type AccountRow } from "./store";
import { ensureWorker, stopWorker } from "./worker";

export const MAX_ACCOUNTS = 10;
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[^\s@<>"',;.]{2,24}$/;

export class AccountError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

export interface ConnectInput {
  preset?: unknown;
  email?: unknown;
  name?: unknown;
  username?: unknown;
  password?: unknown;
  imap?: { host?: unknown; port?: unknown; security?: unknown };
  smtp?: { host?: unknown; port?: unknown; security?: unknown };
}

interface Servers {
  imap: { host: string; port: number; security: Security };
  smtp: { host: string; port: number; security: Security };
}

function serversOf(input: ConnectInput, presetId: string): Servers {
  const p = presetOf(presetId);
  if (!p) throw new AccountError(400, "bad preset");
  try {
    if (p.imap && p.smtp) return { imap: checkEndpoint("imap", p.imap.host, p.imap.port, p.imap.security), smtp: checkEndpoint("smtp", p.smtp.host, p.smtp.port, p.smtp.security) };
    return { imap: checkEndpoint("imap", input.imap?.host, input.imap?.port, input.imap?.security), smtp: checkEndpoint("smtp", input.smtp?.host, input.smtp?.port, input.smtp?.security) };
  } catch (e) {
    if (e instanceof MailGuardError) throw new AccountError(400, e.code);
    throw e;
  }
}

/** Signs in to IMAP and SMTP with these settings; throws AccountError with what failed. */
async function verify(row: AccountRow): Promise<{ gmail: boolean }> {
  let gmail = false;
  try {
    const c = await connectImap(row);
    gmail = c.capabilities.has("X-GM-EXT-1");
    await c.logout().catch(() => c.close());
  } catch (e) {
    throw new AccountError(422, `imap:${failureOf(e).error}`);
  }
  try {
    const t = await smtpTransport(row);
    await t.verify();
    t.close();
  } catch (e) {
    const code = (e as { code?: string; responseCode?: number } | null)?.code;
    throw new AccountError(422, `smtp:${code === "EAUTH" ? "auth" : failureOf(e).error}`);
  }
  return { gmail };
}

/** Connects a mailbox for the person (both servers checked first). */
export async function connectAccount(userId: string, input: ConnectInput): Promise<AccountRow> {
  mailDb();
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!EMAIL_RE.test(email)) throw new AccountError(400, "bad email");
  const presetId = typeof input.preset === "string" ? input.preset : "custom";
  const typed = typeof input.password === "string" ? input.password : "";
  // App passwords are shown in groups ("abcd efgh ijkl mnop"); the spaces are not part of them.
  const password = presetId !== "custom" && /^[a-z0-9]{4}( [a-z0-9]{4}){3,5}$/i.test(typed.trim()) ? typed.replace(/\s+/g, "") : typed;
  if (!password || password.length > 1000) throw new AccountError(400, "password required");
  if (accountsOf(userId).length >= MAX_ACCOUNTS) throw new AccountError(409, "too many accounts");
  if (accountsOf(userId).some((a) => a.email.toLowerCase() === email.toLowerCase())) throw new AccountError(409, "already connected");
  const preset = presetOf(presetId);
  const servers = serversOf(input, presetId);
  const username = typeof input.username === "string" && input.username.trim() ? input.username.trim().slice(0, 320) : email;
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const id = newId(12);
  const secret: MailSecret = { password };
  const row: AccountRow = {
    id,
    user_id: userId,
    email,
    name,
    provider: preset?.id ?? "custom",
    auth: "password",
    username,
    secret: seal(secret, { accountId: id, userId }),
    imap_host: servers.imap.host,
    imap_port: servers.imap.port,
    imap_tls: servers.imap.security,
    smtp_host: servers.smtp.host,
    smtp_port: servers.smtp.port,
    smtp_tls: servers.smtp.security,
    saves_sent: preset?.savesSent ? 1 : 0,
    gmail: 0,
    signature: "",
    color: "",
    state: "new",
    error: null,
    synced_at: null,
    position: accountsOf(userId).length,
    created_at: Date.now(),
  };
  const { gmail } = await verify(row);
  row.gmail = gmail ? 1 : 0;
  if (gmail) row.saves_sent = 1;
  // Checked again now: two connects at once both passed the checks above while the servers answered.
  tx(() => {
    if (accountsOf(userId).length >= MAX_ACCOUNTS) throw new AccountError(409, "too many accounts");
    if (accountsOf(userId).some((a) => a.email.toLowerCase() === email.toLowerCase())) throw new AccountError(409, "already connected");
    sql(
    `INSERT INTO mail_accounts (id, user_id, email, name, provider, auth, username, secret, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, saves_sent, gmail, signature, color, state, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.user_id, row.email, row.name, row.provider, row.auth, row.username, row.secret, row.imap_host, row.imap_port, row.imap_tls, row.smtp_host, row.smtp_port, row.smtp_tls, row.saves_sent, row.gmail, "", "", "new", row.position, row.created_at);
  });
  ensureWorker(id);
  return row;
}

/** A signature as stored: HTML through the same sanitizer as received mail (no remote images). */
export function cleanSignature(html: string): string {
  return sanitizeHtml(html.slice(0, 20_000), { images: true, proxy: (u) => (u.startsWith("https://") ? u : null) }).html;
}

/** Name, signature, color; a new password (checked against the servers first). */
export async function updateAccount(userId: string, id: string, v: { name?: unknown; signature?: unknown; color?: unknown; password?: unknown }): Promise<AccountRow> {
  const a = ownAccount(userId, id);
  if (!a) throw new AccountError(404, "not found");
  if (typeof v.name === "string") sql("UPDATE mail_accounts SET name = ? WHERE id = ?").run(v.name.replace(/\s+/g, " ").trim().slice(0, 120), id);
  if (typeof v.signature === "string") sql("UPDATE mail_accounts SET signature = ? WHERE id = ?").run(cleanSignature(v.signature), id);
  if (typeof v.color === "string" && /^(#[0-9a-f]{6})?$/i.test(v.color)) sql("UPDATE mail_accounts SET color = ? WHERE id = ?").run(v.color, id);
  if (typeof v.password === "string" && v.password) {
    const secret = seal({ password: v.password.slice(0, 1000) } satisfies MailSecret, { accountId: id, userId });
    await verify({ ...a, secret });
    sql("UPDATE mail_accounts SET secret = ?, state = 'new', error = NULL WHERE id = ?").run(secret, id);
    forgetToken(id);
    stopWorker(id);
    ensureWorker(id);
  }
  return ownAccount(userId, id) as AccountRow;
}

/**
 * A zvena account is being deleted: its mailboxes' workers stop and the files
 * waiting in its drafts go. The rows themselves — mail, credentials, views,
 * contacts — go with the account (the mail_user_gone trigger, schema.ts).
 */
export async function forgetMailOf(userId: string): Promise<void> {
  mailDb();
  for (const a of accountsOf(userId)) {
    stopWorker(a.id);
    forgetToken(a.id);
  }
  await dropAllUploads(userId);
}

/** Disconnects a mailbox: its worker stops, its mail, credentials and ecosystem traces go. Nothing on the mail server changes. */
export function removeAccount(userId: string, id: string): boolean {
  const a = ownAccount(userId, id);
  if (!a) return false;
  stopWorker(id);
  forgetToken(id);
  tx(() => {
    const threads = sql("SELECT DISTINCT 'mail:' || thread_id AS k FROM mail_messages WHERE account_id = ?").all(id) as { k: string }[];
    const keys = JSON.stringify(threads.map((t) => t.k));
    sql("DELETE FROM eco_links WHERE src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?))").run(keys, keys);
    sql("DELETE FROM eco_inbox WHERE user_id = ? AND ref IN (SELECT value FROM json_each(?))").run(userId, keys);
    sql("DELETE FROM mail_drafts WHERE user_id = ? AND account_id = ?").run(userId, id);
    sql("DELETE FROM mail_accounts WHERE id = ? AND user_id = ?").run(id, userId);
  });
  return true;
}
