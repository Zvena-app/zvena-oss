// Dates, sizes and the drafts a reply, a reply-all and a forward start from.
// Pure (browser and tests). Dates go through Intl in the interface language.

import { intlOf } from "@/i18n/locales";
import { forwardSubject, replySubject } from "@/lib/mail-client/threading";
import type { Addr, Draft, MailMessage } from "@/lib/mail-client/types";
import { mailText } from "@/lib/mail-client/strings";

/** The list's date: the time today, the day this year, the full date before. */
export function listDate(at: number, locale: string, now = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const tag = intlOf(locale);
  if (d.toDateString() === n.toDateString()) return new Intl.DateTimeFormat(tag, { hour: "numeric", minute: "2-digit" }).format(d);
  if (d.getFullYear() === n.getFullYear()) return new Intl.DateTimeFormat(tag, { month: "short", day: "numeric" }).format(d);
  return new Intl.DateTimeFormat(tag, { dateStyle: "short" }).format(d);
}

/** A message's date in full (the reading pane). */
export function fullDate(at: number, locale: string): string {
  return new Intl.DateTimeFormat(intlOf(locale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
}

export function sizeText(bytes: number, locale: string): string {
  const f = (v: number, unit: "kilobyte" | "megabyte" | "byte") => new Intl.NumberFormat(intlOf(locale), { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: v < 10 ? 1 : 0 }).format(v);
  if (bytes < 1024) return f(bytes, "byte");
  if (bytes < 1024 * 1024) return f(bytes / 1024, "kilobyte");
  return f(bytes / 1024 / 1024, "megabyte");
}

export const addrText = (a: Addr) => (a.name ? `${a.name} <${a.address}>` : a.address);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The original under a reply or a forward, as quoted HTML. */
export function quoteHtml(m: MailMessage, locale: string, forward: boolean): string {
  const text = esc(m.text ?? m.snippet ?? "").replace(/\r?\n/g, "<br>");
  if (forward) {
    const head = [
      `---------- ${esc(mailText(locale, "compose.forwarded"))} ----------`,
      `${esc(mailText(locale, "from"))}: ${esc(addrText(m.from))}`,
      `${esc(mailText(locale, "date"))}: ${esc(fullDate(m.date, locale))}`,
      `${esc(mailText(locale, "subject"))}: ${esc(m.subject)}`,
      `${esc(mailText(locale, "to"))}: ${esc(m.to.map(addrText).join(", "))}`,
    ].join("<br>");
    return `<div>${head}<br><br>${text}</div>`;
  }
  // The sentence is escaped with its {placeholders}, then filled with escaped values.
  const line = esc(mailText(locale, "compose.wrote")).replace("{date}", esc(fullDate(m.date, locale))).replace("{who}", esc(addrText(m.from)));
  return `<div>${line}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${text}</blockquote>`;
}

/** The draft of a reply, a reply to all or a forward of one message. */
export function draftFor(mode: "reply" | "replyAll" | "forward", m: MailMessage, mine: ReadonlySet<string>, id: string): Draft {
  const me = (a: Addr) => mine.has(a.address.toLowerCase());
  let to: Addr[] = [];
  let cc: Addr[] = [];
  if (mode !== "forward") {
    // A reply to one's own message goes to its recipients again.
    to = m.mine ? m.to : m.replyTo.length ? m.replyTo : [m.from];
    if (mode === "replyAll") {
      const seen = new Set(to.map((a) => a.address.toLowerCase()));
      cc = [...m.to, ...m.cc].filter((a) => !me(a) && !seen.has(a.address.toLowerCase()) && (seen.add(a.address.toLowerCase()), true));
    }
    to = to.filter((a) => !me(a) || m.mine);
  }
  return {
    id,
    accountId: m.accountId,
    to,
    cc,
    bcc: [],
    subject: mode === "forward" ? forwardSubject(m.subject) : replySubject(m.subject),
    html: "",
    attachments: [],
    replyTo: m.id,
    mode,
    threadId: m.threadId,
    updatedAt: Date.now(),
  };
}

/** Parses typed addresses ("Ann <ann@x.com>, bob@y.com"). */
export function parseAddrs(raw: string): Addr[] {
  const out: Addr[] = [];
  for (const part of raw.split(/[,;\n]+/)) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(.*?)<([^<>\s]+@[^<>\s]+)>$/.exec(s);
    if (m) out.push({ name: m[1].replace(/^"|"$/g, "").trim(), address: m[2].trim() });
    else out.push({ name: "", address: s.replace(/^mailto:/i, "") });
  }
  return out;
}

export const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[^\s@<>"',;.]{2,24}$/;
