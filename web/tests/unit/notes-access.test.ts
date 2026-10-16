import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { docsPresence, grant, levelOf, pageAccess, revoke, setRestricted } from "@/lib/notes/access";
import { levelIn, sectionOf } from "@/lib/notes/access-client";
import { blankNote } from "@/lib/notes/model";
import { acceptPageInvite, createPageInvite, previewPageInvite } from "@/lib/notes/page-invites";
import { pullNotes, pushNotes, validShareSnapshot } from "@/lib/notes/server-store";
import { addTeamspaceMember, createTeamspace, joinTeamspace, teamspacesOf, updateTeamspace } from "@/lib/notes/teamspaces";
import type { Note } from "@/lib/notes/types";
import { listen, type PulseEvent } from "@/lib/pulse/bus";
import { acceptInvite, createInvite, createWorkspace, removeMember } from "@/lib/workspaces";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `acc-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}

/** A team: owner Olga, editors Anna and Boris, commenter Kira, viewer Vova. */
function team() {
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

const as = (ws: string, userId: string, notes: Note[]) => pushNotes(ws, notes.map((x) => ({ id: x.id, note: x })), { by: userId, quotaLeft: Infinity, author: userId, access: { userId } });
const del = (ws: string, userId: string, id: string) => pushNotes(ws, [{ id, deleted: true }], { by: userId, quotaLeft: Infinity, access: { userId } });
const visible = (ws: string, userId: string, since = 0) => {
  const p = pullNotes(ws, since, userId);
  return { ids: p.notes.map((x) => x.id), deleted: p.deleted, cursor: p.cursor, notes: p.notes };
};

test("access: the workspace's pages go by role; outsiders see nothing", () => {
  const t = team();
  const outsider = person("Out");
  const page = blankNote({ kind: "page", title: "Handbook" });
  assert.deepEqual(as(t.ws, t.anna, [page]).saved, [page.id]);
  assert.equal(levelOf(t.ws, t.olga, page.id), "full");
  assert.equal(levelOf(t.ws, t.boris, page.id), "edit");
  assert.equal(levelOf(t.ws, t.kira, page.id), "comment");
  assert.equal(levelOf(t.ws, t.vova, page.id), "view");
  assert.equal(levelOf(t.ws, outsider, page.id), null);
  assert.equal(docsPresence(outsider, t.ws), null);
  assert.deepEqual(visible(t.ws, t.vova).ids, [page.id]);
  assert.equal(visible(t.ws, t.vova).notes[0].access?.level, "view");
  // A viewer cannot write, a commenter only comments.
  assert.equal(as(t.ws, t.vova, [{ ...page, title: "x" }]).rejected[0]?.reason, "forbidden");
  as(t.ws, t.kira, [{ ...page, title: "Hacked", comments: [{ id: "c1", text: "Typo in §2", at: 1, author: "Kira" }] }]);
  const stored = visible(t.ws, t.olga).notes.find((x) => x.id === page.id);
  assert.equal(stored?.title, "Handbook");
  assert.equal(stored?.comments?.[0]?.text, "Typo in §2");
  // Sub-pages inherit; a viewer cannot add one.
  const sub = blankNote({ kind: "page", title: "Onboarding", parentId: page.id });
  assert.equal(as(t.ws, t.vova, [sub]).rejected[0]?.reason, "forbidden");
  assert.deepEqual(as(t.ws, t.boris, [sub]).saved, [sub.id]);
  assert.equal(levelOf(t.ws, t.kira, sub.id), "comment");
});

test("access: Private pages are their creator's only, even for the owner", () => {
  const t = team();
  const mine = blankNote({ kind: "page", title: "Diary", space: "private" });
  as(t.ws, t.anna, [mine]);
  const child = blankNote({ kind: "page", title: "Monday", parentId: mine.id });
  as(t.ws, t.anna, [child]);
  const seen = visible(t.ws, t.anna);
  assert.equal(seen.notes.find((x) => x.id === mine.id)?.space, `private:${t.anna}`);
  for (const u of [t.olga, t.boris, t.vova]) {
    assert.equal(levelOf(t.ws, u, mine.id), null);
    assert.deepEqual(visible(t.ws, u).ids.filter((id) => id === mine.id || id === child.id), []);
  }
  // Another member cannot claim it, write it or delete it.
  assert.equal(as(t.ws, t.boris, [{ ...mine, title: "Mine now", space: "private" }]).rejected[0]?.reason, "forbidden");
  assert.equal(del(t.ws, t.boris, child.id).rejected[0]?.reason, "forbidden");
  // Nobody can put a page into someone else's Private.
  const sneaky = blankNote({ kind: "page", title: "Planted", space: `private:${t.anna}` });
  as(t.ws, t.boris, [sneaky]);
  assert.equal(levelOf(t.ws, t.anna, sneaky.id), null);
  assert.equal(levelOf(t.ws, t.boris, sneaky.id), "full");
});

test("access: sharing a page gives its subtree; revoking takes it back from devices", () => {
  const t = team();
  const mine = blankNote({ kind: "page", title: "Plan", space: "private" });
  const child = blankNote({ kind: "page", title: "Budget", parentId: mine.id });
  as(t.ws, t.anna, [mine, child]);
  const before = visible(t.ws, t.boris);
  grant(t.ws, mine.id, t.boris, "comment", t.anna);
  const after = visible(t.ws, t.boris, before.cursor);
  assert.deepEqual(after.ids.sort(), [child.id, mine.id].sort());
  const root = after.notes.find((x) => x.id === mine.id);
  assert.equal(root?.access?.level, "comment");
  assert.equal(root?.access?.shared, true);
  assert.equal(after.notes.find((x) => x.id === child.id)?.access?.shared, undefined);
  // Others still see nothing.
  assert.equal(levelOf(t.ws, t.olga, mine.id), null);
  assert.deepEqual(pageAccess(t.ws, mine.id).grants.map((g) => [g.userId, g.level]), [[t.boris, "comment"]]);
  revoke(t.ws, mine.id, t.boris);
  const gone = visible(t.ws, t.boris, after.cursor);
  assert.deepEqual(gone.deleted.sort(), [child.id, mine.id].sort());
  assert.equal(levelOf(t.ws, t.boris, child.id), null);
});

test("access: a restricted page shuts out the workspace; grants below raise or lower", () => {
  const t = team();
  const wiki = blankNote({ kind: "page", title: "Wiki" });
  const hr = blankNote({ kind: "page", title: "Salaries", parentId: wiki.id });
  const pub = blankNote({ kind: "page", title: "Holidays", parentId: hr.id });
  as(t.ws, t.anna, [wiki, hr, pub]);
  const cur = visible(t.ws, t.boris).cursor;
  setRestricted(t.ws, hr.id, true, t.anna);
  assert.equal(levelOf(t.ws, t.anna, hr.id), "full");
  assert.equal(levelOf(t.ws, t.olga, hr.id), "full");
  assert.equal(levelOf(t.ws, t.boris, hr.id), null);
  assert.equal(levelOf(t.ws, t.boris, pub.id), null);
  assert.equal(levelOf(t.ws, t.boris, wiki.id), "edit");
  assert.deepEqual(visible(t.ws, t.boris, cur).deleted.sort(), [hr.id, pub.id].sort());
  // A grant deeper down reopens just that page, at the level given.
  grant(t.ws, pub.id, t.vova, "edit", t.anna);
  assert.equal(levelOf(t.ws, t.vova, pub.id), "edit");
  assert.equal(levelOf(t.ws, t.vova, hr.id), null);
  // …and can lower an editor on a sub-page of a page they edit.
  const notes = blankNote({ kind: "page", title: "Notes", parentId: wiki.id });
  as(t.ws, t.anna, [notes]);
  grant(t.ws, notes.id, t.boris, "view", t.anna);
  assert.equal(levelOf(t.ws, t.boris, notes.id), "view");
  setRestricted(t.ws, hr.id, false, t.anna);
  assert.equal(levelOf(t.ws, t.boris, hr.id), "edit");
});

test("access: teamspaces — open, closed and private", () => {
  const t = team();
  const ts = createTeamspace(t.ws, t.anna, { name: "Design", privacy: "closed" });
  const brief = blankNote({ kind: "page", title: "Brief", space: `ts:${ts.id}` });
  // Only its members create top-level pages there.
  assert.equal(as(t.ws, t.boris, [brief]).rejected[0]?.reason, "forbidden");
  assert.deepEqual(as(t.ws, t.anna, [brief]).saved, [brief.id]);
  assert.equal(levelOf(t.ws, t.boris, brief.id), null);
  assert.equal(levelOf(t.ws, t.olga, brief.id), "full");
  assert.ok(teamspacesOf(t.ws, t.boris).some((x) => x.id === ts.id));
  // Open: everyone views, members edit; joining makes one a member.
  updateTeamspace(t.ws, ts.id, t.anna, { privacy: "open" });
  assert.equal(levelOf(t.ws, t.boris, brief.id), "view");
  assert.equal(as(t.ws, t.boris, [{ ...brief, title: "x" }]).rejected[0]?.reason, "forbidden");
  joinTeamspace(t.ws, ts.id, t.boris);
  assert.equal(levelOf(t.ws, t.boris, brief.id), "edit");
  assert.equal(levelOf(t.ws, t.vova, brief.id), "view");
  // Private: not even listed for others.
  updateTeamspace(t.ws, ts.id, t.anna, { privacy: "private" });
  assert.equal(teamspacesOf(t.ws, t.vova).some((x) => x.id === ts.id), false);
  assert.equal(levelOf(t.ws, t.vova, brief.id), null);
  addTeamspaceMember(t.ws, ts.id, t.anna, t.vova);
  assert.equal(levelOf(t.ws, t.vova, brief.id), "view");
});

test("access: moving a page needs full access when it changes who reads it", () => {
  const t = team();
  const page = blankNote({ kind: "page", title: "Roadmap" });
  const child = blankNote({ kind: "page", title: "Q4", parentId: page.id });
  as(t.ws, t.anna, [page, child]);
  // An editor cannot hide a shared page in their Private…
  assert.equal(as(t.ws, t.anna, [{ ...page, space: "private" }]).rejected[0]?.reason, "forbidden");
  // …nor make it a child of its own sub-page.
  assert.equal(as(t.ws, t.anna, [{ ...page, parentId: child.id }]).rejected[0]?.reason, "forbidden");
  const cur = visible(t.ws, t.boris).cursor;
  // The owner (full access) can; everyone else loses it.
  assert.deepEqual(as(t.ws, t.olga, [{ ...page, space: "private" }]).saved, [page.id]);
  assert.equal(levelOf(t.ws, t.olga, child.id), "full");
  assert.equal(levelOf(t.ws, t.anna, child.id), null);
  assert.deepEqual(visible(t.ws, t.boris, cur).deleted.sort(), [child.id, page.id].sort());
});

test("access: guests join one page through a link and see only its subtree", () => {
  const t = team();
  const guest = person("Guest");
  const wiki = blankNote({ kind: "page", title: "Wiki" });
  const brief = blankNote({ kind: "page", title: "Client brief", parentId: wiki.id });
  const spec = blankNote({ kind: "page", title: "Spec", parentId: brief.id });
  const other = blankNote({ kind: "page", title: "Internal" });
  as(t.ws, t.anna, [wiki, brief, spec, other]);
  // Anna manages the brief (full access there): she may invite.
  grant(t.ws, brief.id, t.anna, "full", t.olga);
  const { token } = createPageInvite(t.ws, brief.id, t.anna, "comment");
  const { token: second } = createPageInvite(t.ws, brief.id, t.anna, "view");
  assert.equal(previewPageInvite(token)?.title, "Client brief");
  assert.equal(previewPageInvite("x".repeat(24)), null);
  const r = acceptPageInvite(guest, token);
  assert.equal(r?.noteId, brief.id);
  assert.deepEqual(docsPresence(guest, t.ws), { role: null, guest: true });
  const seen = visible(t.ws, guest);
  assert.deepEqual(seen.ids.sort(), [brief.id, spec.id].sort());
  assert.equal(seen.notes.find((x) => x.id === brief.id)?.access?.shared, true);
  // Comment yes, edit no, nothing at the top level.
  assert.equal(as(t.ws, guest, [{ ...spec, title: "x" }]).rejected.length, 0);
  assert.equal(visible(t.ws, t.anna).notes.find((x) => x.id === spec.id)?.title, "Spec");
  assert.equal(as(t.ws, guest, [blankNote({ kind: "page", title: "Mine" })]).rejected[0]?.reason, "forbidden");
  assert.equal(as(t.ws, guest, [blankNote({ kind: "page", title: "Mine", space: "private" })]).rejected[0]?.reason, "forbidden");
  // A link is only as good as its creator's say: without full access there, theirs stop working.
  assert.ok(previewPageInvite(second));
  revoke(t.ws, brief.id, t.anna);
  assert.equal(levelOf(t.ws, t.anna, brief.id) === "full", false);
  assert.equal(previewPageInvite(second), null);
  assert.equal(acceptPageInvite(person("Late"), second), null);
  // A member who is removed loses their grants too (no backdoor as a "guest").
  grant(t.ws, other.id, t.boris, "full", t.anna);
  removeMember(t.olga, t.ws, t.boris);
  assert.equal(docsPresence(t.boris, t.ws), null);
});

test("access: public copies carry no user ids (section, creator, editor)", () => {
  const page = blankNote({ kind: "page", title: "Pub", space: "private:user-abc-1", createdBy: "user-abc-1", editedBy: "user-abc-2", access: { level: "full" } });
  const snap = validShareSnapshot({ notes: [page], rootId: page.id });
  const root = snap?.notes[0];
  assert.equal(root?.space, undefined);
  assert.equal(root?.createdBy, undefined);
  assert.equal(root?.editedBy, undefined);
  assert.equal(root?.access, undefined);
});

test("access in the browser: pulled levels, local pages by parent or section, sidebar sections", () => {
  const me = { id: "user-me-1", role: "editor" as const };
  const shared = blankNote({ kind: "page", title: "Spec", parentId: "missing-parent", access: { level: "comment", shared: true } });
  const local = blankNote({ kind: "page", title: "Draft", parentId: shared.id });
  const mine = blankNote({ kind: "page", title: "Diary", space: `private:${me.id}` });
  const theirs = blankNote({ kind: "page", title: "Hers", space: "private:someone-2" });
  const team = blankNote({ kind: "page", title: "Brief", space: "ts:teamspace-1" });
  const general = blankNote({ kind: "page", title: "Wiki" });
  const byId = new Map([shared, local, mine, theirs, team, general].map((x) => [x.id, x]));
  assert.equal(levelIn(shared.id, byId, me), "comment");
  assert.equal(levelIn(local.id, byId, me), "comment");
  assert.equal(levelIn(mine.id, byId, me), "full");
  assert.equal(levelIn(theirs.id, byId, me), null);
  assert.equal(levelIn(general.id, byId, me), "edit");
  assert.equal(levelIn(general.id, byId, { id: me.id, role: "viewer" }), "view");
  assert.equal(levelIn(general.id, byId, null), "full");
  assert.deepEqual(sectionOf(shared, byId, me), { kind: "shared" });
  assert.equal(sectionOf(local, byId, me), null);
  assert.deepEqual(sectionOf(mine, byId, me), { kind: "private" });
  assert.deepEqual(sectionOf(theirs, byId, me), { kind: "shared" });
  assert.deepEqual(sectionOf(team, byId, me), { kind: "teamspace", id: "teamspace-1" });
  assert.deepEqual(sectionOf(general, byId, me), { kind: "workspace" });
});

test("access: a page whose parent is not on the server is its creator's until the parent arrives", () => {
  const t = team();
  const parent = blankNote({ kind: "page", title: "Parent", space: "private" });
  const child = blankNote({ kind: "page", title: "Early child", parentId: parent.id });
  as(t.ws, t.anna, [child]);
  assert.equal(levelOf(t.ws, t.anna, child.id), "edit");
  assert.equal(levelOf(t.ws, t.boris, child.id), null);
  as(t.ws, t.anna, [parent]);
  assert.equal(levelOf(t.ws, t.anna, child.id), "full");
  assert.equal(levelOf(t.ws, t.boris, child.id), null);
});

test("access: a revoke pokes devices to pull at once, naming no page", async () => {
  const t = team();
  const mine = blankNote({ kind: "page", title: "Plan", space: "private" });
  as(t.ws, t.anna, [mine]);
  grant(t.ws, mine.id, t.boris, "edit", t.anna);
  const heard: PulseEvent[] = [];
  const off = listen(t.ws, (e) => void heard.push(e));
  try {
    revoke(t.ws, mine.id, t.boris);
    await new Promise((r) => setTimeout(r, 20));
    const pokes = heard.filter((e) => e.type === "notes");
    assert.equal(pokes.length, 1);
    assert.equal(pokes[0].ref, undefined);
    assert.equal(pokes[0].refs, undefined);
    // Sharing (nobody loses anything) needs no poke: the notes' own stamps carry it.
    heard.length = 0;
    grant(t.ws, mine.id, t.boris, "comment", t.anna);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(heard.filter((e) => e.type === "notes").length, 0);
  } finally {
    off();
  }
});
