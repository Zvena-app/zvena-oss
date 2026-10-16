// Server-only: inviting someone to a page by e-mail (Notion's Share → "Add
// people, groups, or emails"). Someone with an account under that address
// gets the level at once (a guest if they are not in the workspace) and a
// letter; anyone else gets a one-use page invite link by e-mail (the guest
// flow at /share/<token>). Each person may send a limited number a day; the
// security journal notes the invitation without the address.

import { config } from "../config";
import { lettersLeave, sendMail } from "../mail";
import { audit, sql } from "../store";
import { roleIn } from "../workspaces";
import { AccessResolver, atLeast, grant } from "./access";
import "../../i18n/server-catalogs";
import { notesT, type NotesKey } from "./i18n";
import { createPageInvite, type InviteLevel } from "./page-invites";

export const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[^\s@<>"',;.]{2,24}$/;
const PER_DAY = 50;

export class InviteMailError extends Error {}

type Sender = typeof sendMail;
let send: Sender = sendMail;
/** Tests read the letters instead of an outbox. */
export function setInviteSenderForTests(fn: Sender): Sender {
  const prev = send;
  send = fn;
  return prev;
}

function letter(locale: string, inviter: string, title: string, url: string, known: boolean): { subject: string; text: string } {
  const t = (key: NotesKey, vars?: Record<string, string>) => notesT(locale, key, vars);
  const page = title || t("page.untitled");
  return {
    subject: t("invite.subject", { inviter, page }),
    text: `${t("invite.shared", { inviter, page })}\n\n${t(known ? "invite.open" : "invite.signUp")}: ${url}\n\n${known ? "" : `${t("invite.once")}\n\n`}— zvena`,
  };
}

/** Invites `email` to a page with `level`; "granted": an account with that address got access, "sent": an invite link went out. */
export interface PageInviteResult {
  /** "granted": an account under that address got access; "sent": an invite link went out; "link": e-mail is not set up, the inviter passes `url` on. */
  status: "granted" | "sent" | "link";
  /** A letter went (or would go) to the address. */
  mailed: boolean;
  /** The invite link, when no letter can carry it. */
  url?: string;
}

/** Invites `email` to a page with `level`. Without a mail service nothing is mailed: an account still gets access, a new address a link for the inviter. */
export async function invitePageByEmail(ws: string, noteId: string, actor: string, rawEmail: string, level: InviteLevel, locale: string, now = Date.now()): Promise<PageInviteResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new InviteMailError("bad email");
  const sent = sql("SELECT COUNT(*) AS n FROM audit WHERE actor = ? AND action = 'page.invite.mail' AND at > ?").get(actor, now - 86_400_000) as { n: number };
  if (Number(sent.n) >= PER_DAY) throw new InviteMailError("daily limit");
  const inviter = (sql("SELECT name FROM users WHERE id = ?").get(actor) as { name: string } | undefined)?.name ?? "zvena";
  const title = String((sql("SELECT json_extract(json, '$.title') AS t FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, noteId) as { t: string | null } | undefined)?.t ?? "").slice(0, 200);
  const known = sql("SELECT id FROM users WHERE lower(email) = ? AND blocked_at IS NULL").get(email) as { id: string } | undefined;
  let status: "granted" | "sent";
  let url: string;
  if (known) {
    // An account: the level now (a member, or a guest of the workspace), and a letter with the page's address.
    if (!atLeast(new AccessResolver(ws, known.id).level(noteId), level)) grant(ws, noteId, known.id, level, actor);
    url = `${config.appUrl}/docs?ws=${encodeURIComponent(ws)}#${noteId}`;
    status = "granted";
  } else {
    const { token } = createPageInvite(ws, noteId, actor, level, { days: 30, maxUses: 1 });
    url = `${config.appUrl}/share/${token}`;
    status = "sent";
  }
  const mailed = lettersLeave();
  if (mailed) {
    const l = letter(locale, inviter, title, url, Boolean(known));
    await send({ to: email, subject: l.subject, text: l.text });
  }
  audit(actor, "page.invite.mail", ws, { level, account: known ? (roleIn(known.id, ws) ? "member" : "guest") : "new", mailed });
  if (!mailed && status === "sent") return { status: "link", mailed, url };
  return { status, mailed };
}
