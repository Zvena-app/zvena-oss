// A workspace's guests (people some pages are shared with) have an Inbox there
// too, as in Notion: about those pages only, and only while they can open them.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { inboxOf, notify, unreadOf } from "@/lib/eco/inbox";
import { revoke } from "@/lib/notes/access";
import { blankNote } from "@/lib/notes/model";
import { acceptPageInvite, createPageInvite } from "@/lib/notes/page-invites";
import { pushNotes } from "@/lib/notes/server-store";
import { createWorkspace } from "@/lib/workspaces";
import { GET, POST } from "@/app/api/eco/[...path]/route";

const person = (name: string) => {
  const r = signInWith({ provider: "dev", subject: `guest-inbox-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
};

const owner = person("Owner");
const guest = person("Guest");
const outsider = person("Outsider");
const ws = createWorkspace(owner, "Agency").id;
const brief = blankNote({ kind: "page", title: "Brief" });
const secret = blankNote({ kind: "page", title: "Rates" });
pushNotes(ws, [{ id: brief.id, note: brief }, { id: secret.id, note: secret }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
assert.ok(acceptPageInvite(guest, createPageInvite(ws, brief.id, owner, "comment").token));
const as = (userId: string) => ({ userId, wsId: ws, locale: "en" as const });

test("a guest hears about a page shared with them — never about other pages or other products", async () => {
  notify(guest, { ws, kind: "mention", ref: `note:${brief.id}`, by: owner, text: "please review" });
  notify(guest, { ws, kind: "mention", ref: `note:${secret.id}`, by: owner, text: "not theirs" });
  notify(guest, { ws, kind: "assigned", ref: "issue:abcdefgh12", by: owner });
  notify(outsider, { ws, kind: "mention", ref: `note:${brief.id}`, by: owner });
  const box = await inboxOf(as(guest));
  assert.deepEqual(
    box.items.map((i) => i.card?.key),
    [`note:${brief.id}`]
  );
  assert.equal(box.items[0].actor?.name, "Owner");
  assert.equal(unreadOf(as(guest)), 1);
  assert.equal((await inboxOf(as(outsider))).items.length, 0, "someone with nothing there hears nothing");
});

test("the guest's Inbox works through the API (read, mark read); an outsider gets 403", async () => {
  const cookie = (who: string) => `${sessionCookieName()}=${issueSession(who)}`;
  const get = (who: string, route: string) =>
    GET(new Request(`http://localhost:3100/api/eco/${route}?ws=${ws}`, { headers: { cookie: cookie(who), host: "localhost:3100" } }), { params: Promise.resolve({ path: [route] }) });
  const list = await get(guest, "inbox");
  assert.equal(list.status, 200);
  const items = ((await list.json()) as { items: { id: string }[] }).items;
  assert.equal(items.length, 1);
  assert.equal((await get(outsider, "inbox")).status, 403);
  const mark = await POST(
    new Request(`http://localhost:3100/api/eco/inbox?ws=${ws}`, {
      method: "POST",
      headers: { cookie: cookie(guest), host: "localhost:3100", origin: "http://localhost:3100", "content-type": "application/json" },
      body: JSON.stringify({ ids: [items[0].id], action: "read" }),
    }),
    { params: Promise.resolve({ path: ["inbox"] }) }
  );
  assert.equal(mark.status, 200);
  assert.equal(((await mark.json()) as { unread: number }).unread, 0);
});

test("when the page is no longer shared with them, its notifications are gone from the guest's Inbox", async () => {
  notify(guest, { ws, kind: "comment", ref: `note:${brief.id}`, by: owner, text: "a new comment" });
  assert.equal(unreadOf(as(guest)), 1);
  assert.ok(revoke(ws, brief.id, guest));
  assert.equal(unreadOf(as(guest)), 0);
  assert.equal((await inboxOf(as(guest))).items.length, 0);
  notify(guest, { ws, kind: "mention", ref: `note:${brief.id}`, by: owner });
  assert.equal(unreadOf(as(guest)), 0, "and nothing new arrives about it");
});

test("an @mention of a guest in a page shared with them reaches their Inbox; in a page they can't open it doesn't", async () => {
  await import("@/lib/notes/notify-people");
  const plan = blankNote({ kind: "page", title: "Launch plan" });
  const internal = blankNote({ kind: "page", title: "Internal notes" });
  const mention = (n: typeof plan) => ({ ...n, content: [{ id: `b-${n.id.slice(0, 6)}`, type: "paragraph", props: {}, content: [{ type: "text", text: "Over to ", styles: {} }, { type: "mention", props: { userId: guest } }], children: [] }] });
  pushNotes(ws, [{ id: plan.id, note: plan }, { id: internal.id, note: internal }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  assert.ok(acceptPageInvite(guest, createPageInvite(ws, plan.id, owner, "edit").token));
  const before = unreadOf(as(guest));
  pushNotes(ws, [{ id: plan.id, note: mention(plan) as typeof plan }, { id: internal.id, note: mention(internal) as typeof internal }], { by: owner, quotaLeft: Infinity, access: { userId: owner }, author: "Owner" });
  const end = Date.now() + 3000;
  while (unreadOf(as(guest)) === before && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  const keys = (await inboxOf(as(guest))).items.map((i) => i.card?.key);
  assert.ok(keys.includes(`note:${plan.id}`), "the shared page's mention arrived");
  assert.ok(!keys.includes(`note:${internal.id}`), "the other page's mention did not");
});
