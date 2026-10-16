import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { grant, grantGroup, levelOf, pageAccess, revokeGroup, setRestricted } from "@/lib/notes/access";
import { addGroupMember, createGroup, deleteGroup, groupsOf, removeGroupMember } from "@/lib/notes/groups";
import { blankNote } from "@/lib/notes/model";
import { pullNotes, pushNotes } from "@/lib/notes/server-store";
import { addTeamspaceGroup, createTeamspace, teamspacesOf } from "@/lib/notes/teamspaces";
import type { Note } from "@/lib/notes/types";
import { acceptInvite, createInvite, createWorkspace, removeMember } from "@/lib/workspaces";

let n = 0;
export function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `r2-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}

/** A team: owner Olga, editors Anna and Boris, commenter Kira, viewer Vova. */
export function team() {
  const olga = person("Olga");
  const anna = person("Anna");
  const boris = person("Boris");
  const kira = person("Kira");
  const vova = person("Vova");
  const ws = createWorkspace(olga, `Team ${n}`).id;
  for (const [u, role] of [
    [anna, "editor"],
    [boris, "editor"],
    [kira, "commenter"],
    [vova, "viewer"],
  ] as const)
    assert.ok(acceptInvite(u, createInvite(olga, ws, role).token));
  return { ws, olga, anna, boris, kira, vova };
}

export const as = (ws: string, userId: string, notes: Note[], fields?: string[]) =>
  pushNotes(ws, notes.map((x) => ({ id: x.id, note: x, ...(fields ? { fields } : {}) })), { by: userId, quotaLeft: Infinity, author: userId, access: { userId } });
export const visible = (ws: string, userId: string, since = 0) => {
  const p = pullNotes(ws, since, userId);
  return { ids: p.notes.map((x) => x.id), deleted: p.deleted, cursor: p.cursor, notes: p.notes };
};

test("groups: a page shared with a group opens to its members, and to them only", () => {
  const t = team();
  const page = blankNote({ kind: "page", title: "Design reviews" });
  as(t.ws, t.olga, [page]);
  setRestricted(t.ws, page.id, true, t.olga);
  assert.equal(levelOf(t.ws, t.anna, page.id), null);
  const g = createGroup(t.ws, t.olga, "Design");
  addGroupMember(t.ws, g.id, t.olga, t.anna);
  assert.equal(levelOf(t.ws, t.anna, page.id), null);
  grantGroup(t.ws, page.id, g.id, "comment", t.olga);
  assert.equal(levelOf(t.ws, t.anna, page.id), "comment");
  assert.equal(levelOf(t.ws, t.boris, page.id), null);
  // The best of one's own grant and the group's on the same page.
  grant(t.ws, page.id, t.anna, "edit", t.olga);
  assert.equal(levelOf(t.ws, t.anna, page.id), "edit");
  grantGroup(t.ws, page.id, g.id, "full", t.olga);
  assert.equal(levelOf(t.ws, t.anna, page.id), "full");
  assert.deepEqual(
    pageAccess(t.ws, page.id).groups.map((x) => [x.name, x.level, x.members]),
    [["Design", "full", 1]]
  );
  revokeGroup(t.ws, page.id, g.id);
  assert.equal(levelOf(t.ws, t.anna, page.id), "edit");
});

test("groups: joining or leaving a group reaches devices (pull and revocations)", () => {
  const t = team();
  const page = blankNote({ kind: "page", title: "Roadmap" });
  as(t.ws, t.olga, [page]);
  setRestricted(t.ws, page.id, true, t.olga);
  const g = createGroup(t.ws, t.olga, "Leads");
  grantGroup(t.ws, page.id, g.id, "view", t.olga);
  const before = visible(t.ws, t.boris);
  assert.ok(!before.ids.includes(page.id));
  addGroupMember(t.ws, g.id, t.olga, t.boris);
  const joined = visible(t.ws, t.boris, before.cursor);
  assert.ok(joined.ids.includes(page.id), "the page is pulled after joining the group");
  removeGroupMember(t.ws, g.id, t.olga, t.boris);
  const left = visible(t.ws, t.boris, joined.cursor);
  assert.ok(left.deleted.includes(page.id), "the page is dropped after leaving the group");
  // Deleting the group takes its access away too.
  addGroupMember(t.ws, g.id, t.olga, t.boris);
  assert.equal(levelOf(t.ws, t.boris, page.id), "view");
  deleteGroup(t.ws, g.id, t.olga);
  assert.equal(levelOf(t.ws, t.boris, page.id), null);
  assert.equal(groupsOf(t.ws).length, 0);
});

test("groups: a group in a teamspace makes its members members; guests and ex-members cannot be in groups", () => {
  const t = team();
  const ts = createTeamspace(t.ws, t.olga, { name: "Marketing", privacy: "closed" });
  const page = blankNote({ kind: "page", title: "Campaign", space: `ts:${ts.id}` });
  as(t.ws, t.olga, [page]);
  assert.equal(levelOf(t.ws, t.anna, page.id), null);
  const g = createGroup(t.ws, t.olga, "Marketers");
  addGroupMember(t.ws, g.id, t.olga, t.anna);
  addTeamspaceGroup(t.ws, ts.id, t.olga, g.id);
  // A member through the group, at her workspace role.
  assert.equal(levelOf(t.ws, t.anna, page.id), "edit");
  assert.equal(teamspacesOf(t.ws, t.anna).find((x) => x.id === ts.id)?.role, "member");
  const outsider = person("Out");
  assert.throws(() => addGroupMember(t.ws, g.id, t.olga, outsider));
  // Leaving the workspace leaves its groups.
  removeMember(t.olga, t.ws, t.anna);
  assert.deepEqual(groupsOf(t.ws)[0].members, []);
});

test("request access: the page's full-access people hear of it; approving grants, declining does not", async () => {
  const { answerRequest, requestAccess, requestsOf, setRequestNotifierForTests } = await import("@/lib/notes/access-requests");
  const t = team();
  const outsider = person("Petr");
  const page = blankNote({ kind: "page", title: "Budget" });
  as(t.ws, t.olga, [page]);
  setRestricted(t.ws, page.id, true, t.olga);
  const told: { to: string; text?: string; by: string | null }[] = [];
  const prev = setRequestNotifierForTests((to, n) => told.push({ to, text: n.text, by: n.by }));
  try {
    assert.equal(requestAccess(t.ws, page.id, t.anna), "requested");
    assert.deepEqual(told, [{ to: t.olga, text: "requests access", by: t.anna }]);
    // Asking again the same day does not ring again; someone who can read is told so.
    requestAccess(t.ws, page.id, t.anna);
    assert.equal(told.length, 1);
    assert.equal(requestAccess(t.ws, page.id, t.olga), "has");
    // A page that does not exist answers the same (links reveal nothing).
    assert.equal(requestAccess(t.ws, "nonexistent1", t.anna), "requested");
    // Someone outside the workspace may ask too; approving makes them a guest.
    requestAccess(t.ws, page.id, outsider);
    assert.deepEqual(requestsOf(t.ws, page.id).map((r) => r.userId).sort(), [t.anna, outsider].sort());
    assert.ok(answerRequest(t.ws, page.id, outsider, t.olga, "view"));
    assert.equal(levelOf(t.ws, outsider, page.id), "view");
    assert.ok(answerRequest(t.ws, page.id, t.anna, t.olga, null));
    assert.equal(levelOf(t.ws, t.anna, page.id), null);
    assert.equal(requestsOf(t.ws, page.id).length, 0);
    assert.equal(told.at(-1)?.to, outsider);
  } finally {
    setRequestNotifierForTests(prev);
  }
});

test("invite by e-mail: an account gets access at once, anyone else a one-use guest link; limits apply", async () => {
  const { invitePageByEmail, setInviteSenderForTests } = await import("@/lib/notes/invite-mail");
  const { sql } = await import("@/lib/store");
  const { acceptPageInvite } = await import("@/lib/notes/page-invites");
  const t = team();
  const page = blankNote({ kind: "page", title: "Launch plan" });
  as(t.ws, t.olga, [page]);
  setRestricted(t.ws, page.id, true, t.olga);
  const letters: { to: string; subject: string; text: string }[] = [];
  const prev = setInviteSenderForTests(async (l) => (letters.push(l), "outbox"));
  try {
    // Someone with an account under that address (here outside the workspace): a guest at once.
    const known = person("Mira");
    sql("UPDATE users SET email = ? WHERE id = ?").run("mira@example.com", known);
    assert.equal((await invitePageByEmail(t.ws, page.id, t.olga, " Mira@Example.com ", "comment", "en")).status, "granted");
    assert.equal(levelOf(t.ws, known, page.id), "comment");
    assert.equal(letters[0].to, "mira@example.com");
    assert.match(letters[0].subject, /Launch plan/);
    // A new address: a link that works once.
    assert.equal((await invitePageByEmail(t.ws, page.id, t.olga, "new@example.org", "view", "ru")).status, "sent");
    const token = /\/share\/([A-Za-z0-9_-]+)/.exec(letters[1].text)?.[1] as string;
    assert.ok(token, letters[1].text);
    assert.match(letters[1].subject, /приглашает/);
    const newcomer = person("Newcomer");
    assert.equal(acceptPageInvite(newcomer, token)?.level, "view");
    assert.equal(acceptPageInvite(person("Second"), token), null, "one use only");
    // Any interface language: a letter in Spanish.
    assert.equal((await invitePageByEmail(t.ws, page.id, t.olga, "otra@example.org", "view", "es")).status, "sent");
    assert.match(letters[2].subject, /te invitó a «Launch plan»/);
    await assert.rejects(invitePageByEmail(t.ws, page.id, t.olga, "not an email", "view", "en"));
    // No mail service (and no outbox): nothing is mailed; an account still gets access, a new address is a link for the inviter.
    const outbox = process.env.ZVENA_MAIL_OUTBOX;
    delete process.env.ZVENA_MAIL_OUTBOX;
    try {
      const before = letters.length;
      const off = await invitePageByEmail(t.ws, page.id, t.olga, "nomail@example.org", "view", "en");
      assert.equal(off.status, "link");
      assert.equal(off.mailed, false);
      assert.match(off.url ?? "", /\/share\/[A-Za-z0-9_-]+$/);
      const known2 = person("Nomail");
      sql("UPDATE users SET email = ? WHERE id = ?").run("known-nomail@example.com", known2);
      const granted = await invitePageByEmail(t.ws, page.id, t.olga, "known-nomail@example.com", "view", "en");
      assert.deepEqual([granted.status, granted.mailed, granted.url], ["granted", false, undefined]);
      assert.equal(letters.length, before, "no letter was even tried");
    } finally {
      process.env.ZVENA_MAIL_OUTBOX = outbox;
    }
    // The journal keeps no address.
    const meta = sql("SELECT meta FROM audit WHERE action = 'page.invite.mail' ORDER BY at DESC LIMIT 1").get() as { meta: string };
    assert.ok(!meta.meta.includes("@"));
  } finally {
    setInviteSenderForTests(prev);
  }
});

test("move to another workspace: the subtree lands in the mover's Private there, leaves the source, takes its files and link", async () => {
  const { movePageToWorkspace } = await import("@/lib/notes/move-workspace");
  const { sql } = await import("@/lib/store");
  const { recordFile } = await import("@/lib/storage");
  const { saveNoteShare, readNoteShare, validShareSnapshot } = await import("@/lib/notes/server-store");
  const t = team();
  const other = createWorkspace(t.anna, `Anna's own ${n}`).id;
  const file = `${"c".repeat(40)}.png`;
  recordFile({ kind: "user", id: t.olga }, file, 1234);
  const page = blankNote({ kind: "page", title: "Spec", content: [{ type: "image", props: { url: `/api/notes/file/${file}` } }] });
  const child = blankNote({ kind: "page", title: "Details", parentId: page.id });
  const db = blankNote({ kind: "database", title: "Tasks", parentId: page.id });
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [] };
  const row = blankNote({ kind: "page", title: "Task 1", parentId: db.id });
  as(t.ws, t.anna, [page, child, db, row]);
  // A viewer of the page cannot move it; Anna has edit, not full, on the workspace's page.
  assert.equal((await movePageToWorkspace(t.ws, other, page.id, t.vova, "Vova")).ok, false);
  assert.equal((await movePageToWorkspace(t.ws, other, page.id, t.anna, "Anna")).ok, false);
  // The owner moves it into a workspace she is in (Anna invites her as an editor).
  assert.ok(acceptInvite(t.olga, createInvite(t.anna, other, "editor").token));
  const snap = validShareSnapshot({ notes: [page], rootId: page.id });
  assert.ok(snap);
  const shareId = saveNoteShare(t.ws, t.olga, page.id, snap);
  const r = await movePageToWorkspace(t.ws, other, page.id, t.olga, "Olga");
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ok && r.moved, 4);
  // In the destination: the same ids, the root in Olga's Private, the tree intact.
  const there = pullNotes(other, 0, t.olga).notes;
  assert.deepEqual(new Set(there.map((x) => x.id)), new Set([page.id, child.id, db.id, row.id]));
  assert.equal(there.find((x) => x.id === page.id)?.space, `private:${t.olga}`);
  assert.equal(there.find((x) => x.id === row.id)?.parentId, db.id);
  // Gone from the source for everyone.
  const here = pullNotes(t.ws, 0);
  assert.ok(![page.id, child.id, db.id, row.id].some((id) => here.notes.some((x) => x.id === id)));
  assert.ok(here.deleted.includes(page.id));
  // The destination's owner (Anna) now pays for the image; the public link still works.
  assert.equal(sql("SELECT COUNT(*) AS n FROM files WHERE name = ? AND owner_id = ?").get(file, t.anna)?.n, 1);
  assert.equal(readNoteShare(shareId)?.snapshot.rootId, page.id);
  // Moving back into a workspace that already has those ids gets new ones.
  const again = await movePageToWorkspace(other, t.ws, page.id, t.olga, "Olga");
  assert.ok(again.ok && again.id !== page.id, JSON.stringify(again));
});
