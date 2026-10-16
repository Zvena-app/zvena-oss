import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { securityOf, updateSecurity } from "@/lib/enterprise/security";
import { formServable, shareServable } from "@/lib/enterprise/site-domains";
import { blankNote } from "@/lib/notes/model";
import { createPageInvite } from "@/lib/notes/page-invites";
import { grant } from "@/lib/notes/access";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace, roleIn } from "@/lib/workspaces";

const V = "2026-10-13";
let n = 0;

function person(name: string, email?: string): { id: string; cookie: string } {
  const r = signInWith({ provider: "dev", subject: `sec-${name}-${++n}`, name }, V);
  assert.ok(r.ok);
  const id = r.ok ? r.user.id : "";
  if (email) sql("UPDATE users SET email = ? WHERE id = ?").run(email, id);
  return { id, cookie: `${sessionCookieName()}=${issueSession(id)}` };
}

function team() {
  const owner = person("Owner", `owner${n}@team.test`);
  const editor = person("Editor", `editor${n}@team.test`);
  const viewer = person("Viewer");
  const ws = createWorkspace(owner.id, `Security ${n}`).id;
  acceptInvite(editor.id, createInvite(owner.id, ws, "editor").token);
  acceptInvite(viewer.id, createInvite(owner.id, ws, "viewer").token);
  return { ws, owner, editor, viewer };
}

function page(ws: string, by: string, title = "Plan"): Note {
  const p = blankNote({ kind: "page", title });
  pushNotes(ws, [{ id: p.id, note: p }], { by, quotaLeft: Infinity, author: by, access: { userId: by } });
  return p;
}

/** Calls a route handler as the browser would (same origin, a session cookie). */
async function call(mod: Record<string, unknown>, method: string, path: string, cookie: string, body?: unknown, headers: Record<string, string> = {}) {
  const fn = mod[method] as (req: Request, ctx?: unknown) => Promise<Response>;
  const res = await fn(
    new Request(`http://localhost:3100${path}`, {
      method,
      headers: { cookie, origin: "http://localhost:3100", host: "localhost:3100", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
  return res;
}

test("security settings: owners only, same-origin changes, unknown fields ignored, each change audited", async () => {
  const sec = await import("@/app/api/ws/security/route");
  const t = team();
  assert.equal((await call(sec, "GET", `/api/ws/security?ws=${t.ws}`, t.editor.cookie)).status, 403);
  assert.equal((await call(sec, "PATCH", `/api/ws/security?ws=${t.ws}`, t.editor.cookie, { disablePublish: true })).status, 403);
  assert.equal((await call(sec, "PATCH", `/api/ws/security?ws=${t.ws}`, t.owner.cookie, { disablePublish: true }, { origin: "https://evil.example" })).status, 403);
  const r = await call(sec, "PATCH", `/api/ws/security?ws=${t.ws}`, t.owner.cookie, { disableGuests: true, disableExport: "yes", bogus: 1, joinRole: "owner" });
  assert.equal(r.status, 200);
  const s = ((await r.json()) as { settings: Record<string, unknown> }).settings;
  assert.deepEqual([s.disableGuests, s.disableExport, s.joinRole, "bogus" in s], [true, false, "editor", false]);
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'security.update' AND target = ? AND meta LIKE '%disableGuests%'").get(t.ws));
});

test("disable publishing: Publish to web and public forms are refused, and published pages stop being served", async () => {
  const share = await import("@/app/api/notes/share/route");
  const form = await import("@/app/api/notes/form/route");
  const t = team();
  const p = page(t.ws, t.owner.id);
  const pub = await call(share, "POST", `/api/notes/share?ws=${t.ws}`, t.owner.cookie, { noteId: p.id, snapshot: { notes: [p], rootId: p.id } });
  assert.equal(pub.status, 200);
  const id = ((await pub.json()) as { id: string }).id;
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'page.publish' AND target = ?").get(t.ws), "the workspace's audit log has it");
  assert.equal((await call(share, "GET", `/api/notes/share?id=${id}`, "")).status, 200);
  updateSecurity(t.ws, t.owner.id, { disablePublish: true });
  const again = await call(share, "POST", `/api/notes/share?ws=${t.ws}`, t.owner.cookie, { noteId: p.id, snapshot: { notes: [p], rootId: p.id } });
  assert.equal(again.status, 403);
  assert.equal(shareServable(id), false);
  assert.equal((await call(share, "GET", `/api/notes/share?id=${id}`, "")).status, 404);
  const db = blankNote({ kind: "database", title: "Signups" });
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [{ id: "v1", name: "Form", type: "form" } as never] };
  pushNotes(t.ws, [{ id: db.id, note: db }], { by: t.owner.id, quotaLeft: Infinity, author: t.owner.id, access: { userId: t.owner.id } });
  assert.equal((await call(form, "POST", `/api/notes/form?ws=${t.ws}`, t.owner.cookie, { dbId: db.id, viewId: "v1" })).status, 403);
  // Back on: the same page is served again (it was kept, not deleted).
  updateSecurity(t.ws, t.owner.id, { disablePublish: false });
  assert.equal(shareServable(id), true);
  const opened = await call(form, "POST", `/api/notes/form?ws=${t.ws}`, t.owner.cookie, { dbId: db.id, viewId: "v1" });
  assert.equal(opened.status, 200);
  const formId = ((await opened.json()) as { id: string }).id;
  updateSecurity(t.ws, t.owner.id, { disablePublish: true });
  assert.equal(formServable(formId), false);
  const answer = await import("@/app/api/notes/form/[id]/route");
  const res = await answer.POST(new Request(`http://localhost:3100/api/notes/form/${formId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: {} }) }), { params: Promise.resolve({ id: formId }) });
  assert.equal(res.status, 404);
});

test("disable guests: invite links, e-mail invites and grants to people outside the workspace are refused", async () => {
  const inv = await import("@/app/api/notes/page-invite/route");
  const acc = await import("@/app/api/notes/access/route");
  const t = team();
  const p = page(t.ws, t.owner.id);
  // A link made while guests were allowed…
  const { token } = createPageInvite(t.ws, p.id, t.owner.id, "view");
  const outsider = person("Outsider", "outsider@else.test");
  const guest = person("Guest");
  grant(t.ws, p.id, guest.id, "view", t.owner.id);
  updateSecurity(t.ws, t.owner.id, { disableGuests: true });
  const q = `/api/notes/page-invite?ws=${t.ws}&id=${p.id}`;
  assert.equal((await call(inv, "POST", q, t.owner.cookie, { op: "create", level: "view" })).status, 403);
  assert.equal((await call(inv, "POST", q, t.owner.cookie, { op: "email", email: "someone@else.test", level: "view" })).status, 403);
  assert.equal((await call(inv, "POST", q, t.owner.cookie, { op: "email", email: "outsider@else.test", level: "view" })).status, 403);
  // …admits no outsider now, but still a member.
  assert.equal((await call(inv, "POST", "/api/notes/page-invite", outsider.cookie, { op: "accept", token })).status, 403);
  assert.equal((await call(inv, "POST", "/api/notes/page-invite", t.viewer.cookie, { op: "accept", token })).status, 200);
  // A member by e-mail is not a guest.
  const editorMail = (sql("SELECT email FROM users WHERE id = ?").get(t.editor.id) as { email: string }).email;
  assert.equal((await call(inv, "POST", q, t.owner.cookie, { op: "email", email: editorMail, level: "comment" })).status, 200);
  // The Share menu: more access for an existing guest is refused; members are fine.
  const aq = `/api/notes/access?ws=${t.ws}&id=${p.id}`;
  // (Turning guests off already took the guest's access away; any new grant to them is refused.)
  assert.ok([400, 403].includes((await call(acc, "POST", aq, t.owner.cookie, { op: "grant", userId: guest.id, level: "edit" })).status));
  assert.equal((await call(acc, "POST", aq, t.owner.cookie, { op: "grant", userId: t.viewer.id, level: "edit" })).status, 200);
});

test("disable moving pages out: Move to another workspace is refused", async () => {
  const mv = await import("@/app/api/notes/move-workspace/route");
  const t = team();
  const other = createWorkspace(t.owner.id, `Elsewhere ${n}`).id;
  const p = page(t.ws, t.owner.id);
  updateSecurity(t.ws, t.owner.id, { disableMoveOut: true });
  const r = await call(mv, "POST", "/api/notes/move-workspace", t.owner.cookie, { from: t.ws, to: other, noteId: p.id });
  assert.equal(r.status, 403);
  assert.ok(sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(t.ws, p.id), "still where it was");
});

test("disable export: the account export leaves the workspace's documents out (owners excepted)", async () => {
  const ex = await import("@/app/api/export/route");
  const t = team();
  page(t.ws, t.owner.id, "Secret roadmap");
  updateSecurity(t.ws, t.owner.id, { disableExport: true });
  const read = async (cookie: string) => Buffer.from(await (await call(ex, "GET", "/api/export", cookie)).arrayBuffer()).toString("latin1");
  const editorZip = await read(t.editor.cookie);
  assert.ok(editorZip.includes("EXPORT-DISABLED.txt"));
  assert.ok(!editorZip.includes(`-${t.ws.slice(0, 6)}/documents.json`));
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'export.blocked' AND target = ? AND actor = ?").get(t.ws, t.editor.id));
  // The account's own entry (shown in every workspace's log) says how many withheld, not which.
  const own = sql("SELECT meta FROM audit WHERE action = 'data.export' AND actor = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(t.editor.id) as { meta: string | null } | undefined;
  assert.deepEqual(JSON.parse(own?.meta ?? "null"), { withheld: 1 });
  const ownerZip = await read(t.owner.cookie);
  assert.ok(ownerZip.includes(`-${t.ws.slice(0, 6)}/documents.json`));
  // Docs hides its page export from the same people (the session says so).
  const { sessionUser } = await import("@/lib/session");
  const as = (id: string) => sessionUser({ id, name: "x" } as never, t.ws, null, "Personal");
  assert.equal(as(t.editor.id).ws.noExport, true);
  assert.equal(as(t.owner.id).ws.noExport, undefined);
});

test("allow members to invite: off, only the owner invites; on, editors too (never viewers)", async () => {
  const invites = await import("@/app/api/ws/invites/route");
  const share = await import("@/app/api/ws/share/route");
  const t = team();
  const q = `/api/ws/invites?ws=${t.ws}`;
  assert.equal(securityOf(t.ws).membersCanInvite, false);
  assert.equal((await call(invites, "POST", q, t.editor.cookie, { role: "viewer" })).status, 403);
  assert.equal((await call(invites, "POST", q, t.owner.cookie, { role: "viewer" })).status, 200);
  updateSecurity(t.ws, t.owner.id, { membersCanInvite: true });
  const r = await call(invites, "POST", q, t.editor.cookie, { role: "editor" });
  assert.equal(r.status, 200);
  const token = String(((await r.json()) as { url: string }).url).split("/join/")[1];
  const newcomer = person("Newcomer");
  assert.equal(acceptInvite(newcomer.id, token)?.role, "editor");
  assert.equal(roleIn(newcomer.id, t.ws), "editor");
  assert.equal((await call(invites, "POST", q, t.viewer.cookie, { role: "viewer" })).status, 403);
  // Revoking links stays the owner's.
  assert.equal((await call(invites, "DELETE", q, t.editor.cookie, { id: "x" })).status, 403);
  const info = (await (await call(share, "GET", `/api/ws/share?ws=${t.ws}`, t.editor.cookie)).json()) as { canInvite: boolean };
  assert.equal(info.canInvite, true);
  updateSecurity(t.ws, t.owner.id, { membersCanInvite: false });
  assert.equal((await call(share, "POST", `/api/ws/share?ws=${t.ws}`, t.editor.cookie, { emails: "x@y.test", role: "viewer" })).status, 403);
});

test("disable guests: everyone outside the workspace loses the pages shared with them", async () => {
  const { grant, levelOf } = await import("@/lib/notes/access");
  const t = team();
  const p = page(t.ws, t.owner.id, "Client brief");
  const guest = person("Guest", `guest${n}@outside.test`);
  grant(t.ws, p.id, guest.id, "comment", t.owner.id);
  assert.equal(levelOf(t.ws, guest.id, p.id), "comment");
  updateSecurity(t.ws, t.owner.id, { disableGuests: true });
  assert.equal(levelOf(t.ws, guest.id, p.id), null, "the guest's access is gone");
  assert.equal(levelOf(t.ws, t.editor.id, p.id) !== null, true, "members keep theirs");
});

test("require SSO: the members it covers sign in again (their sessions end), owners keep theirs", async () => {
  const { saveSso } = await import("@/lib/enterprise/sso");
  const t = team();
  sql("INSERT INTO ent_domains (ws, domain, token, created_by, created_at, verified_at) VALUES (?, 'team.test', 'x', ?, ?, ?) ON CONFLICT DO NOTHING").run(t.ws, t.owner.id, Date.now(), Date.now());
  const sessions = (id: string) => Number((sql("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(id) as { n: number }).n);
  assert.ok(sessions(t.editor.id) > 0 && sessions(t.owner.id) > 0);
  saveSso(t.ws, t.owner.id, { kind: "oidc", enabled: true, enforced: true, provider: { issuer: "https://idp.example.com", clientId: "zvena", clientSecret: "s3cret-s3cret" } });
  assert.equal(sessions(t.editor.id), 0, "the editor at team.test signs in again, through SSO");
  assert.ok(sessions(t.owner.id) > 0, "the owner keeps the break-glass session");
});
