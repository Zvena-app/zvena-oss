import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { guestsOf, removeGuest } from "@/lib/enterprise/guests";
import { grant, pageLevel } from "@/lib/notes/access";
import { blankNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";
import { GET, POST } from "@/app/api/ws/guests/route";

let n = 0;
const person = (name: string) => {
  const r = signInWith({ provider: "dev", subject: `wsg-${name}-${++n}`, name }, "2026-10-15");
  assert.ok(r.ok);
  return r.user.id;
};
const cookie = (uid: string) => `${sessionCookieName()}=${issueSession(uid)}`;

test("Settings → Guests: who outside the workspace has which pages; removing one takes them all; owners only", async () => {
  const owner = person("Owner");
  const mate = person("Mate");
  const guest = person("Guest");
  const ws = createWorkspace(owner, `Guests ${n}`).id;
  assert.ok(acceptInvite(mate, createInvite(owner, ws, "editor").token));
  const shared = blankNote({ kind: "page", title: "Roadmap" });
  const mine = blankNote({ kind: "page", title: "Mate's notes", space: `private:${mate}` });
  pushNotes(ws, [{ id: shared.id, note: shared }], { by: owner, quotaLeft: Infinity });
  pushNotes(ws, [{ id: mine.id, note: mine }], { by: mate, quotaLeft: Infinity });
  grant(ws, shared.id, guest, "edit", owner);
  grant(ws, mine.id, guest, "view", mate);
  grant(ws, shared.id, mate, "full", owner);
  const list = guestsOf(ws, owner);
  assert.equal(list.length, 1, "members with grants are no guests");
  assert.equal(list[0].id, guest);
  assert.deepEqual(list[0].pages.map((p) => [p.title, p.level]).sort(), [["Roadmap", "edit"], [null, "view"]].sort(), "a Private page is listed without its title");
  // Only owners: a member is refused.
  const get = (uid: string) => GET(new Request(`http://localhost/api/ws/guests?ws=${ws}`, { headers: { cookie: cookie(uid) } }));
  assert.equal((await get(mate)).status, 403);
  assert.equal((await get(owner)).status, 200);
  const post = (uid: string, b: unknown) => POST(new Request(`http://localhost/api/ws/guests?ws=${ws}`, { method: "POST", headers: { cookie: cookie(uid), host: "localhost:3100", origin: "http://localhost:3100", "content-type": "application/json" }, body: JSON.stringify(b) }));
  assert.equal((await post(owner, { op: "remove", userId: mate })).status, 404, "a member is not removed as a guest");
  assert.equal((await post(owner, { op: "remove", userId: guest })).status, 200);
  assert.equal(pageLevel(guest, ws, shared.id), null);
  assert.equal(pageLevel(guest, ws, mine.id), null);
  assert.equal(guestsOf(ws, owner).length, 0);
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'guest.remove' AND target = ?").get(ws));
  assert.equal(removeGuest(ws, owner, guest), false);
});
