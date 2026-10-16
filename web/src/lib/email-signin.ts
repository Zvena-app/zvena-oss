// Server-only: sign-in with a one-time e-mail link (or the 6-digit code in
// the same letter, for when the letter is read on another device).
//
// The token and the code are stored only as HMACs, live 15 minutes and are
// used once; five wrong codes void the letter. The link opens a page with a
// "Continue" button instead of signing in on GET, so mail scanners that
// follow links cannot use it up. The answer to "send me a link" never says
// whether an account exists: the same letter both signs in and signs up.

import { randomBytes, randomInt } from "node:crypto";
import { mac, safeEqual } from "./auth";
import { config } from "./config";
import { sendMail } from "./mail";
import { safeNext } from "./oauth";
import { sql, sweepExpired } from "./store";

const TTL = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Letters per address per hour and per day (on top of the per-IP rate limit). */
const PER_ADDRESS_HOUR = 5;
const PER_ADDRESS_DAY = 12;

/**
 * Letters sent per address, kept apart from email_signin: those rows go when
 * they expire (15 minutes), are used or are voided by wrong codes, so they
 * cannot count an hour. Only a keyed hash of the address is kept, for a day.
 */
let logReady = false;
function sentLog(): void {
  if (logReady) return;
  sql("CREATE TABLE IF NOT EXISTS email_signin_sent (who TEXT NOT NULL, at INTEGER NOT NULL)").run();
  sql("CREATE INDEX IF NOT EXISTS email_signin_sent_who ON email_signin_sent(who, at)").run();
  logReady = true;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  // Deliberately simple: one @, a dot in the domain, no spaces or angle brackets.
  if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(e)) return null;
  return e;
}

/** "anna.smith@example.com" → "an•••@example.com" (shown on the "check your inbox" page). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local.slice(0, Math.min(2, local.length))}•••@${domain}`;
}

export type StartResult = { ok: true; email: string; token: string; code: string; ref: string } | { ok: false; error: "invalid" | "too-many" };

/** Creates a sign-in for `email` (the letter is sent by sendSignInLetter). */
export function createEmailSignIn(rawEmail: unknown, opts: { next: string; guest: string | null }): StartResult {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: "invalid" };
  sweepExpired();
  sentLog();
  const who = mac("email-sent", email);
  const now0 = Date.now();
  sql("DELETE FROM email_signin_sent WHERE at < ?").run(now0 - 86_400_000);
  const counts = sql("SELECT COUNT(*) AS day, SUM(at > ?) AS hour FROM email_signin_sent WHERE who = ? AND at > ?").get(now0 - 3600_000, who, now0 - 86_400_000) as { day: number; hour: number | null };
  if (Number(counts.hour ?? 0) >= PER_ADDRESS_HOUR || Number(counts.day) >= PER_ADDRESS_DAY) return { ok: false, error: "too-many" };
  sql("INSERT INTO email_signin_sent (who, at) VALUES (?, ?)").run(who, now0);
  const token = randomBytes(32).toString("base64url");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = mac("email-link", token);
  const ref = randomBytes(16).toString("base64url");
  const now = Date.now();
  sql("INSERT INTO email_signin (id, ref, email, code, next, guest, attempts, created_at, exp) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)").run(
    id,
    ref,
    email,
    mac("email-code", `${id}:${code}`),
    safeNext(opts.next),
    opts.guest,
    now,
    now + TTL
  );
  return { ok: true, email, token, code, ref };
}

export function signInLink(token: string): string {
  return `${config.appUrl}/signin/email?token=${encodeURIComponent(token)}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The letter: a button, the code, and why it came. Plain and HTML. */
export function signInLetter(email: string, token: string, code: string): { subject: string; text: string; html: string } {
  const link = signInLink(token);
  const host = new URL(config.appUrl).host;
  const subject = `Your zvena sign-in code: ${code}`;
  const text = [
    "Sign in to zvena",
    "",
    `Click the link below to sign in as ${email}:`,
    link,
    "",
    `Or enter this code on the sign-in page: ${code}`,
    "",
    "The link and the code work once and expire in 15 minutes.",
    "If you didn't try to sign in, you can safely ignore this email — nobody can get in without it.",
    "",
    `— zvena · ${host}`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#faf9f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141413">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#faf9f5;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:14px;border:1px solid #e6e3da;padding:32px">
<tr><td style="font-size:22px;font-weight:700;color:#000000;padding-bottom:24px"><img src="${esc(config.appUrl)}/brand/zvena-logo-email.png" width="117" height="20" alt="zvena." style="display:block;border:0;outline:none;height:20px;width:117px"></td></tr>
<tr><td style="font-size:20px;font-weight:600;padding-bottom:8px">Sign in to zvena</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#5e5d59;padding-bottom:24px">Click the button to sign in as <strong style="color:#141413">${esc(email)}</strong>.</td></tr>
<tr><td style="padding-bottom:24px"><a href="${esc(link)}" style="display:inline-block;background:#000000;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">Sign in to zvena</a></td></tr>
<tr><td style="font-size:14px;color:#5e5d59;padding-bottom:6px">Or enter this code on the sign-in page:</td></tr>
<tr><td style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;letter-spacing:6px;font-weight:700;padding-bottom:24px">${code}</td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#6f6e69;border-top:1px solid #eeece5;padding-top:16px">The link and the code work once and expire in 15 minutes. If you didn't try to sign in, you can safely ignore this email.</td></tr>
</table>
<p style="font-size:12px;color:#6f6e69;margin:16px 0 0">zvena · <a href="${esc(config.appUrl)}" style="color:#6f6e69">${esc(host)}</a></p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

export async function sendSignInLetter(email: string, token: string, code: string): Promise<boolean> {
  const l = signInLetter(email, token, code);
  const r = await sendMail({ to: email, subject: l.subject, text: l.text, html: l.html, kind: "signin" });
  return r === "sent" || r === "outbox";
}

interface Row {
  id: string;
  email: string;
  code: string;
  next: string | null;
  guest: string | null;
  attempts: number;
  exp: number;
}

const REF_RE = /^[A-Za-z0-9_-]{20,24}$/;

/** The address behind a "check your inbox" page, while its letter is live. */
export function peekRef(ref: unknown): { email: string } | null {
  if (typeof ref !== "string" || !REF_RE.test(ref)) return null;
  const row = sql("SELECT email, exp FROM email_signin WHERE ref = ?").get(ref) as { email: string; exp: number } | undefined;
  return row && row.exp > Date.now() ? { email: row.email } : null;
}

/** Who a link is for, without using it (the "Continue as …" page). */
export function peekLink(token: unknown): { email: string } | null {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const row = sql("SELECT email, exp FROM email_signin WHERE id = ?").get(mac("email-link", token)) as { email: string; exp: number } | undefined;
  return row && row.exp > Date.now() ? { email: row.email } : null;
}

export type Consumed = { ok: true; email: string; next: string; guest: string | null } | { ok: false; error: "expired" | "wrong-code" };

/** Uses a link token (one time). */
export function consumeLink(token: unknown): Consumed {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return { ok: false, error: "expired" };
  const id = mac("email-link", token);
  const row = sql("SELECT id, email, code, next, guest, attempts, exp FROM email_signin WHERE id = ?").get(id) as Row | undefined;
  sql("DELETE FROM email_signin WHERE id = ?").run(id);
  if (!row || row.exp < Date.now()) return { ok: false, error: "expired" };
  // Signed in: the other letters to the address are void too.
  sql("DELETE FROM email_signin WHERE email = ?").run(row.email);
  return { ok: true, email: row.email, next: safeNext(row.next), guest: row.guest };
}

/** Uses the code typed on the "check your inbox" page of letter `ref`. */
export function consumeCode(ref: unknown, rawCode: unknown): Consumed {
  const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
  if (typeof ref !== "string" || !REF_RE.test(ref)) return { ok: false, error: "expired" };
  const row = sql("SELECT id, email, code, next, guest, attempts, exp FROM email_signin WHERE ref = ?").get(ref) as Row | undefined;
  if (!row || row.exp < Date.now()) return { ok: false, error: "expired" };
  if (!/^\d{6}$/.test(code) || !safeEqual(mac("email-code", `${row.id}:${code}`), row.code)) {
    if (row.attempts + 1 >= MAX_ATTEMPTS) sql("DELETE FROM email_signin WHERE id = ?").run(row.id);
    else sql("UPDATE email_signin SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    return { ok: false, error: row.attempts + 1 >= MAX_ATTEMPTS ? "expired" : "wrong-code" };
  }
  // A code signs in once and also voids the other letters to the address.
  sql("DELETE FROM email_signin WHERE email = ?").run(row.email);
  return { ok: true, email: row.email, next: safeNext(row.next), guest: row.guest };
}
