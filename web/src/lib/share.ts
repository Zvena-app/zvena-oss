// "Share" (design system: one Share button in every doc, project and
// design): invite people to the workspace by e-mail, in one step, with a
// role. Each address gets its own single-use invite link (valid 14 days) in
// a letter; nothing else is stored. Server-only.

import { dt, type DsKey } from "@/components/zvena/ds/i18n";
import { dirOf, isLocale } from "@/i18n/locales";
import { config } from "./config";
import { defang } from "./calendar/defang";
import { lettersLeave, sendMail } from "./mail";
import { createInvite, type Role } from "./workspaces";

export const SHARE_ROLES = ["editor", "commenter", "viewer"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export const MAX_SHARE_EMAILS = 20;
const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

/** The addresses typed into Share (comma, space or newline separated), cleaned and without duplicates. */
export function parseEmails(raw: unknown): { ok: string[]; bad: string[] } {
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  const ok: string[] = [];
  const bad: string[] = [];
  for (const s of list) {
    const e = s.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) bad.push(s.trim().slice(0, 80));
    else if (!ok.includes(e)) ok.push(e);
  }
  return { ok, bad };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const CAN: Record<ShareRole, DsKey> = { editor: "letterCanEdit", commenter: "letterCanComment", viewer: "letterCanView" };

/** The invitation letter, in the inviter's interface language. */
export function inviteLetter(o: { from: string; workspace: string; role: ShareRole; link: string; what?: string; locale: string }): { subject: string; text: string; html: string } {
  const t = (k: DsKey, v?: Record<string, string | number>) => dt(o.locale, k, v);
  const host = new URL(config.appUrl).host;
  // What people typed (their name, the workspace's, the thing shared) reaches any address from zvena's sender: no live links in it.
  o = { ...o, from: defang(o.from) || "zvena", workspace: defang(o.workspace), ...(o.what ? { what: defang(o.what) } : {}) };
  const subject = t("letterSubject", { from: o.from, ws: o.workspace });
  const lead = o.what ? t("letterLeadWhat", { from: o.from, what: o.what, ws: o.workspace, can: t(CAN[o.role]) }) : t("letterLead", { from: o.from, ws: o.workspace, can: t(CAN[o.role]) });
  const button = t("letterButton");
  const note = t("letterNote");
  const text = [lead, "", o.link, "", note, "", `— zvena · ${host}`].join("\n");
  const html = `<!doctype html><html dir="${isLocale(o.locale) ? dirOf(o.locale) : "ltr"}"><body style="margin:0;padding:0;background:#f5f5f5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e1e1e">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f5;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:13px;border:1px solid #e6e6e6;padding:28px">
<tr><td style="font-size:16px;font-weight:700;letter-spacing:-0.03em;color:#1e1e1e;padding-bottom:18px">zvena</td></tr>
<tr><td style="font-size:18px;font-weight:600;letter-spacing:-0.012em;padding-bottom:8px">${esc(subject)}</td></tr>
<tr><td style="font-size:14px;line-height:1.55;color:#6b6b6b;padding-bottom:22px">${esc(lead)}</td></tr>
<tr><td style="padding-bottom:22px"><a href="${esc(o.link)}" style="display:inline-block;background:#0b72cc;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:6px">${esc(button)}</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#707070;border-top:1px solid #e6e6e6;padding-top:14px">${esc(note)}</td></tr>
</table>
<p style="font-size:11px;color:#707070;margin:14px 0 0">zvena · <a href="${esc(config.appUrl)}" style="color:#707070">${esc(host)}</a></p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

/** "link": e-mail is not set up on this server — the inviter gets the person's own link to pass on. */
export type ShareResult = { email: string; status: "sent" | "queued" | "failed" | "link"; link?: string };

/**
 * One single-use invite per address, sent by mail. "queued" means the letter
 * is in the outbox (no mail service configured); the link still works.
 */
export async function inviteByEmail(o: { actor: string; actorName: string; wsId: string; wsName: string; role: ShareRole; emails: string[]; what?: string; locale: string }): Promise<ShareResult[]> {
  const out: ShareResult[] = [];
  for (const email of o.emails.slice(0, MAX_SHARE_EMAILS)) {
    const { token } = createInvite(o.actor, o.wsId, o.role as Exclude<Role, "owner">, { days: 14, maxUses: 1 });
    const link = `${config.appUrl}/join/${token}`;
    const l = inviteLetter({ from: o.actorName, workspace: o.wsName, role: o.role, link, what: o.what, locale: o.locale });
    let r: Awaited<ReturnType<typeof sendMail>> = "failed";
    try {
      r = await sendMail({ to: email, subject: l.subject, text: l.text, html: l.html });
    } catch {
      r = "failed";
    }
    // No mail service: nothing leaves, so the inviter is handed the link instead of a silent "failed".
    if (r !== "sent" && !lettersLeave()) out.push({ email, status: "link", link });
    else out.push({ email, status: r === "sent" ? "sent" : r === "outbox" ? "queued" : "failed" });
  }
  return out;
}
