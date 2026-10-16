import { notify } from "@/lib/eco/inbox";
import { guestAllowed } from "@/lib/enterprise/security";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { AccessResolver, docsPresence, grant, grantGroup, isLevel, pageAccess, revoke, revokeGroup, setRestricted } from "@/lib/notes/access";
import { groupOf } from "@/lib/notes/groups";
import { answerRequest, requestsOf } from "@/lib/notes/access-requests";
import { pageInvitesOf } from "@/lib/notes/page-invites";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { audit, sql } from "@/lib/store";
import { lettersLeave } from "@/lib/mail";

export const dynamic = "force-dynamic";

// The Share menu of a page (Notion): who has access and at what level.
// GET  ?ws=&id=                                    → { level, restricted, restrictedFrom, grants, invites?, owner }  (anyone who can read the page)
// POST ?ws=&id= { op: "general", restricted }      → { ok }   "Only people invited" on / off   (full access)
// POST ?ws=&id= { op: "grant", userId, level }     → { ok }   a member or guest of the workspace (full access)
// POST ?ws=&id= { op: "revoke", userId }           → { ok }                                    (full access, or oneself)
// POST ?ws=&id= { op: "grant", groupId, level }    → { ok }   a group of the workspace          (full access)
// POST ?ws=&id= { op: "revoke", groupId }          → { ok }                                    (full access)
// POST ?ws=&id= { op: "approve", userId, level }   → { ok }   a pending "Request access"         (full access)
// POST ?ws=&id= { op: "decline", userId }          → { ok }

function names(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const r = sql("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | undefined;
    if (r) out.set(id, r.name);
  }
  return out;
}

function target(req: Request): { ws: string; id: string } | null {
  const u = new URL(req.url);
  const ws = u.searchParams.get("ws") ?? "";
  const id = u.searchParams.get("id") ?? "";
  return NOTE_ID_RE.test(id) && ws ? { ws, id } : null;
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-share");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const t = target(req);
  if (!t || !docsPresence(me.user.id, t.ws)) return fail(403, "forbidden");
  const res = new AccessResolver(t.ws, me.user.id);
  const level = res.level(t.id);
  if (!level) return fail(404, "not found");
  const a = pageAccess(t.ws, t.id);
  const who = names(a.grants.map((g) => g.userId));
  const ownerRow = sql("SELECT w.owner_id, u.name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ?").get(t.ws) as { owner_id: string; name: string } | undefined;
  return json({
    level,
    restricted: a.restricted,
    restrictedFrom: a.restrictedFrom,
    space: res.rootSpace(t.id),
    grants: a.grants.map((g) => ({ ...g, name: who.get(g.userId) ?? "" })),
    // Groups are the workspace's: a guest sees only that a group has access, by name.
    groups: a.groups,
    ...(ownerRow ? { owner: { userId: ownerRow.owner_id, name: ownerRow.name } } : {}),
    // Live invite links (their tokens were shown once, when made).
    ...(level === "full" ? { invites: pageInvitesOf(t.ws, t.id), requests: requestsOf(t.ws, t.id) } : {}),
    // Whether invitations by e-mail can reach anyone here (else the inviter gets the link).
    mailOn: lettersLeave(),
  });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-share");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const t = target(req);
  if (!t || !docsPresence(me.user.id, t.ws)) return fail(403, "forbidden");
  const p = await readJsonCapped(req, 4_000);
  const body = p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
  const level = new AccessResolver(t.ws, me.user.id).level(t.id);
  const own = body.op === "revoke" && body.userId === me.user.id;
  if (level !== "full" && !own) return fail(403, "forbidden");
  if (!sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(t.ws, t.id)) return fail(404, "not found");
  try {
    if (body.op === "general" && typeof body.restricted === "boolean") {
      setRestricted(t.ws, t.id, body.restricted, me.user.id);
      audit(me.user.id, body.restricted ? "page.restrict" : "page.open", t.ws);
      return json({ ok: true });
    }
    if (body.op === "approve" && typeof body.userId === "string" && isLevel(body.level)) {
      return json({ ok: answerRequest(t.ws, t.id, body.userId, me.user.id, body.level) });
    }
    if (body.op === "decline" && typeof body.userId === "string") {
      return json({ ok: answerRequest(t.ws, t.id, body.userId, me.user.id, null) });
    }
    if (body.op === "grant" && typeof body.groupId === "string" && isLevel(body.level)) {
      if (!groupOf(t.ws, body.groupId)) return fail(400, "no such group");
      grantGroup(t.ws, t.id, body.groupId, body.level, me.user.id);
      audit(me.user.id, "page.grant.group", t.ws, { level: body.level });
      return json({ ok: true });
    }
    if (body.op === "revoke" && typeof body.groupId === "string") {
      const ok = revokeGroup(t.ws, t.id, body.groupId);
      if (ok) audit(me.user.id, "page.revoke.group", t.ws);
      return json({ ok });
    }
    if (body.op === "grant" && typeof body.userId === "string" && isLevel(body.level)) {
      // Members of the workspace, or people already its guests (others join through an invite link).
      if (!docsPresence(body.userId, t.ws)) return fail(400, "not in workspace");
      if (!guestAllowed(t.ws, body.userId)) return fail(403, "guests are disabled in this workspace");
      grant(t.ws, t.id, body.userId, body.level, me.user.id);
      audit(me.user.id, "page.grant", t.ws, { level: body.level });
      // Their Inbox says a page was shared with them (the ecosystem's Inbox).
      const title = (sql("SELECT json_extract(json, '$.title') AS t FROM notes WHERE ws = ? AND id = ?").get(t.ws, t.id) as { t: string | null } | undefined)?.t ?? "";
      notify(body.userId, { ws: t.ws, kind: "invite", ref: `note:${t.id}`, by: me.user.id, text: String(title).slice(0, 280) });
      return json({ ok: true });
    }
    if (body.op === "revoke" && typeof body.userId === "string") {
      const ok = revoke(t.ws, t.id, body.userId);
      if (ok) audit(me.user.id, "page.revoke", t.ws);
      return json({ ok });
    }
  } catch {
    return fail(503, "unavailable");
  }
  return fail(400, "bad request");
}
