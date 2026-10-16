// Server-only: e-mail. Resend's API when RESEND_API_KEY is set (MAIL_FROM is
// the sender on a domain verified in Resend), otherwise an SMTP server
// (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM).
// Without either, letters are written as .eml files to ZVENA_MAIL_OUTBOX
// (the test stand) or dropped. Addresses and texts are never written to logs.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";

export interface Letter {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML version (the text one is always sent too). */
  html?: string;
  /** Files sent along (Calendar's .ics invitations): small text files only. */
  attachments?: { filename: string; content: string; contentType: string }[];
}

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

/**
 * Letters reach people: a mail service, or a stand's outbox (letters kept on
 * disk to read). Off: whatever would be mailed must say so, and hand the
 * person a link instead where there is one.
 */
export function lettersLeave(): boolean {
  return mailConfigured() || Boolean(process.env.ZVENA_MAIL_OUTBOX);
}

/** Letters can actually leave the server (Resend or SMTP). */
export function mailConfigured(): boolean {
  return config.resend.enabled || smtpConfigured();
}

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=`;
}

async function toOutbox(letter: Letter): Promise<"outbox" | "skipped"> {
  const dir = process.env.ZVENA_MAIL_OUTBOX;
  if (!dir) return "skipped";
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.eml`;
  const from = config.resend.enabled ? config.resend.from : process.env.SMTP_FROM || "zvena <noreply@zvena.local>";
  const head = `From: ${from}\r\nTo: ${letter.to}\r\nSubject: ${encodeHeader(letter.subject)}\r\n`;
  let eml = `${head}Content-Type: text/plain; charset=utf-8\r\n\r\n${letter.text}\r\n`;
  if (letter.attachments?.length) {
    const b = `zvena-${Math.random().toString(36).slice(2, 12)}`;
    const parts = [`--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${letter.text}\r\n`];
    for (const a of letter.attachments)
      parts.push(`--${b}\r\nContent-Type: ${a.contentType}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(a.content).toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n`);
    eml = `${head}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n${parts.join("")}--${b}--\r\n`;
  }
  await writeFile(join(dir, name), eml, { mode: 0o600 });
  return "outbox";
}

async function viaResend(letter: Letter): Promise<"sent" | "failed"> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${config.resend.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: config.resend.from,
        to: [letter.to],
        subject: letter.subject,
        text: letter.text,
        ...(letter.html ? { html: letter.html } : {}),
        ...(letter.attachments?.length ? { attachments: letter.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64"), content_type: a.contentType })) } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return "sent";
    console.error(`[mail] resend refused the letter (HTTP ${res.status})`);
    return "failed";
  } catch (e) {
    console.error(`[mail] resend unreachable (${e instanceof Error ? e.name : "error"})`);
    return "failed";
  }
}

async function viaSmtp(letter: Letter): Promise<"sent" | "failed"> {
  try {
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(process.env.SMTP_PORT || 587);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === "1" || port === 465,
      requireTLS: port === 587,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: letter.to,
      subject: letter.subject,
      text: letter.text,
      ...(letter.html ? { html: letter.html } : {}),
      ...(letter.attachments?.length ? { attachments: letter.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
    });
    return "sent";
  } catch (e) {
    console.error(`[mail] smtp send failed (${e instanceof Error ? e.name : "error"})`);
    return "failed";
  }
}

export async function sendMail(letter: Letter): Promise<"sent" | "outbox" | "skipped" | "failed"> {
  if (config.resend.enabled) return viaResend(letter);
  if (smtpConfigured()) return viaSmtp(letter);
  return toOutbox(letter);
}

/** A note to the moderators (ZVENA_ADMIN_EMAIL), if one is configured. */
export async function sendAdminMail(subject: string, text: string): Promise<void> {
  const to = (process.env.ZVENA_ADMIN_EMAIL || "").trim();
  if (to) await sendMail({ to, subject, text });
}
