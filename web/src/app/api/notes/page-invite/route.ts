import { config } from "@/lib/config";
import { guestAllowed, guestsDisabled } from "@/lib/enterprise/security";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { docsPresence, levelOf } from "@/lib/notes/access";
import { acceptPageInvite, createPageInvite, isInviteLevel, previewPageInvite, revokePageInvite } from "@/lib/notes/page-invites";
import { InviteMailError, invitePageByEmail } from "@/lib/notes/invite-mail";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { parseAcceptLanguage, readLocale } from "@/lib/locale-server";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { sql } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Whether the address belongs to a member of the workspace (an invite to them adds no guest). */
function memberByEmail(ws: string, email: string): boolean {
  return Boolean(sql("SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.ws_id = ? AND u.email = ? COLLATE NOCASE").get(ws, email.trim()));
}

// Page invite links: people outside the workspace join one page (and what is under it) as guests.
// POST ?ws=&id= { op: "create", level, days?, maxUses? } → { url, invite }   (full access; the link is shown once)
// POST ?ws=&id= { op: "revoke", inviteId }               → { ok }            (full access)
// POST ?ws=&id= { op: "email", email, level }            → { status: "granted" | "sent" }  (full access; a letter goes out)
// POST          { op: "accept", token }                  → { ws, noteId, level }  (anyone signed in)

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-share");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "sign in required");
  const p = await readJsonCapped(req, 4_000);
  const body = p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
  if (body.op === "accept") {
    if (typeof body.token !== "string") return fail(400, "bad request");
    // A workspace without guests (Settings → Security) lets only its members in by a page link.
    const inv = previewPageInvite(body.token);
    if (inv && !guestAllowed(inv.ws, me.user.id)) return fail(403, "guests are disabled in this workspace");
    const r = acceptPageInvite(me.user.id, body.token);
    return r ? json(r) : fail(404, "invalid or expired");
  }
  const u = new URL(req.url);
  const ws = u.searchParams.get("ws") ?? "";
  const id = u.searchParams.get("id") ?? "";
  if (!NOTE_ID_RE.test(id) || !docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  if (levelOf(ws, me.user.id, id) !== "full") return fail(403, "forbidden");
  try {
    if (body.op === "create" && isInviteLevel(body.level)) {
      if (guestsDisabled(ws)) return fail(403, "guests are disabled in this workspace");
      const { token, invite } = createPageInvite(ws, id, me.user.id, body.level, {
        ...(typeof body.days === "number" ? { days: body.days } : {}),
        ...(typeof body.maxUses === "number" ? { maxUses: body.maxUses } : {}),
      });
      return json({ url: `${config.appUrl}/share/${token}`, invite });
    }
    if (body.op === "revoke" && typeof body.inviteId === "string") return json({ ok: revokePageInvite(ws, id, body.inviteId, me.user.id) });
    if (body.op === "email" && typeof body.email === "string" && isInviteLevel(body.level)) {
      if (guestsDisabled(ws) && !memberByEmail(ws, body.email)) return fail(403, "guests are disabled in this workspace");
      const mailLimit = rateLimited(req, "notes-invite-mail", 10);
      if (mailLimit) return mailLimit;
      // The letter speaks the inviter's interface language (English by default).
      const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
      return json(await invitePageByEmail(ws, id, me.user.id, body.email, body.level, locale));
    }
  } catch (e) {
    if (e instanceof InviteMailError) return fail(e.message === "bad email" ? 400 : 429, e.message);
    return fail(429, "too many invites");
  }
  return fail(400, "bad request");
}
