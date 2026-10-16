import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { blankNote } from "@/lib/notes/model";
import { acceptPageInvite, createPageInvite } from "@/lib/notes/page-invites";
import { pushNotes } from "@/lib/notes/server-store";
import { createWorkspace } from "@/lib/workspaces";
import { GET } from "@/app/api/eco/[...path]/route";

const person = (name: string) => {
  const r = signInWith({ provider: "dev", subject: `unread-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
};

test("a guest's Inbox badge answers with their own count (no 403 for people a page was shared with)", async () => {
  const owner = person("Owner");
  const guest = person("Guest");
  const outsider = person("Outsider");
  const ws = createWorkspace(owner, "Client work").id;
  const page = blankNote({ kind: "page", title: "Brief" });
  pushNotes(ws, [{ id: page.id, note: page }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  assert.ok(acceptPageInvite(guest, createPageInvite(ws, page.id, owner, "comment").token));
  const ask = (who: string) =>
    GET(new Request(`http://localhost:3100/api/eco/unread?ws=${ws}`, { headers: { cookie: `${sessionCookieName()}=${issueSession(who)}`, host: "localhost:3100" } }), { params: Promise.resolve({ path: ["unread"] }) });
  const g = await ask(guest);
  assert.equal(g.status, 200);
  assert.equal(typeof ((await g.json()) as { unread: number }).unread, "number");
  // Someone with nothing there still gets nothing: a quiet 0 (the badge's own poll), never a count.
  const o = await ask(outsider);
  assert.equal(o.status, 200);
  assert.deepEqual(await o.json(), { unread: 0 });
});
