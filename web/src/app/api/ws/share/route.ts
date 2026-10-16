import { canInvite } from "@/lib/enterprise/security";
import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { parseAcceptLanguage, readLocale } from "@/lib/locale-server";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { inviteByEmail, MAX_SHARE_EMAILS, parseEmails, SHARE_ROLES, type ShareRole } from "@/lib/share";
import { sql } from "@/lib/store";
import { membersOf } from "@/lib/workspaces";
import { lettersLeave } from "@/lib/mail";

export const dynamic = "force-dynamic";

// Share (design system: one Share button for docs, projects and designs).
// GET  ?ws=                                  → { workspace: {id,name,personal}, role, members }   (any member)
// POST ?ws= { emails, role, what? }          → { results: [{email,status}], bad: [...] }          (owner)
//
// The invites themselves are ordinary workspace invites (lib/workspaces):
// one single-use link per address, valid 14 days, sent by mail. A personal
// workspace cannot be shared; the dialog offers to start a team instead.

function wsRow(id: string): { id: string; name: string; personal: number } | undefined {
  return sql("SELECT id, name, personal FROM workspaces WHERE id = ?").get(id) as { id: string; name: string; personal: number } | undefined;
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  const role = access(me.user.id, ws, "read");
  if (!role) return fail(403, "forbidden");
  const row = wsRow(ws as string);
  if (!row) return fail(404, "not found");
  return json({ workspace: { id: row.id, name: row.name, personal: row.personal === 1 }, role, canInvite: canInvite(me.user.id, row.id), members: membersOf(row.id), mailOn: lettersLeave() });
}

/** Invitations by e-mail one person may send in a day. */
const DAILY_INVITES = 100;

export async function POST(req: Request) {
  const rl = rateLimited(req, "ws-invite");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!canInvite(me.user.id, ws)) return fail(403, "forbidden");
  const row = wsRow(ws as string);
  if (!row) return fail(404, "not found");
  if (row.personal) return fail(400, "personal workspaces cannot be shared");
  const p = await readJsonCapped(req, 8_000);
  const body = (p.ok ? p.value : {}) as { emails?: unknown; role?: unknown; what?: unknown };
  if (!(SHARE_ROLES as readonly unknown[]).includes(body.role)) return fail(400, "bad role");
  const { ok, bad: badEmails } = parseEmails(body.emails);
  if (ok.length === 0) return json({ results: [], bad: badEmails }, 400);
  if (ok.length > MAX_SHARE_EMAILS) return fail(400, "too many addresses");
  // A durable daily cap on letters to addresses (single-use invites made by mail), whatever the rate limiter remembers.
  const today = Number((sql("SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND max_uses = 1 AND created_at > ?").get(me.user.id, Date.now() - 86_400_000) as { n: number }).n);
  if (today + ok.length > DAILY_INVITES) return fail(429, "daily limit");
  // People already in the workspace need no invite.
  const known = new Set(
    (sql("SELECT LOWER(u.email) AS e FROM members m JOIN users u ON u.id = m.user_id WHERE m.ws_id = ? AND u.email IS NOT NULL").all(row.id) as { e: string }[]).map((r) => r.e)
  );
  const send = ok.filter((e) => !known.has(e));
  const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
  const what = typeof body.what === "string" ? body.what.trim().slice(0, 120) || undefined : undefined;
  const results = await inviteByEmail({ actor: me.user.id, actorName: me.user.name, wsId: row.id, wsName: row.name, role: body.role as ShareRole, emails: send, what, locale });
  return json({ results: [...results, ...ok.filter((e) => known.has(e)).map((email) => ({ email, status: "member" as const }))], bad: badEmails });
}
