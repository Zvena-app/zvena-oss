// Regressions of the ecosystem's security and correctness audit: each test is
// one way things went wrong before, kept from coming back.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { saveReaction, startReactions } from "@/lib/decide/engine";
import { EcoError, issueFromDoc, type Actor } from "@/lib/eco/actions";
import { refsInMarkdown } from "@/lib/eco/extract";
import { indexNote, startEco } from "@/lib/eco/indexer";
import { linksOf } from "@/lib/eco/links";
import { refFromUrl } from "@/lib/eco/refs";
import { relatedOf } from "@/lib/eco/related";
import { pushNotes } from "@/lib/notes/server-store";
import { sanitizeNote } from "@/lib/notes/model";
import type { Note } from "@/lib/notes/types";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, queryIssues, updateIssue } from "@/lib/projects/issues";
import { createProject } from "@/lib/projects/planning";
import { createTeam, listStatuses } from "@/lib/projects/teams";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace, setRole } from "@/lib/workspaces";

const O = { app: "http://localhost:3100", design: "http://localhost:3110" };

async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `sec-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Owen");
const editor = person("Eve");
const ws = createWorkspace(owner, "Secure").id;
acceptInvite(editor, createInvite(owner, ws, "editor").token);
const pub = createTeam(ctxFor(owner, ws, "edit"), { name: "Public", key: "PUB" }, "en");
const secret = createTeam(ctxFor(owner, ws, "edit"), { name: "Secret", key: "SEC", private: true }, "en");
const actor = (userId: string): Actor => ({ userId, name: "x", wsId: ws, locale: "en" });
const titles = (userId: string, q: string) => queryIssues(ctxFor(userId, ws, "read"), { filter: { q }, display: { group: "none" }, limit: 50 }).groups.flatMap((g) => g.items.map((i) => i.title));

let n = 0;
function page(title: string, content: unknown[], extra: Partial<Note> = {}): Note {
  const now = Date.now();
  const id = `sec${String(++n).padStart(29, "0")}`;
  const note = sanitizeNote({ id, kind: "page", title, parentId: null, icon: "", cover: null, content, order: n, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, ...extra }) as Note;
  pushNotes(ws, [{ id, note }], { by: owner, quotaLeft: Infinity });
  return note;
}

test("crafted Markdown is read in linear time (no catastrophic backtracking)", () => {
  for (const md of ['[@ id="aaaaaa"'.repeat(30_000), "](".repeat(80_000), "[".repeat(100_000)]) {
    const t = performance.now();
    refsInMarkdown(md, O);
    assert.ok(performance.now() - t < 500, `${md.slice(0, 12)}… took ${Math.round(performance.now() - t)} ms`);
  }
});

test("a malformed link names nothing instead of breaking indexing; a link from another workspace names nothing", () => {
  assert.equal(refFromUrl("/docs#%zz-abc", O), null);
  assert.deepEqual(refFromUrl("/projects/issue/SEC-1?ws=otherWorkspace1", O), { kind: "issue-ident", ident: "SEC-1", ws: "otherWorkspace1" });
  const p = page("Copied link", [{ id: "b1", type: "paragraph", props: {}, content: [{ type: "link", href: "/projects/issue/PUB-1?ws=otherWorkspace1", content: [] }], children: [] }]);
  createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "Our PUB-1" });
  indexNote(ws, p.id);
  assert.deepEqual(linksOf(ws, `note:${p.id}`), [], "PUB-1 of another workspace is not our PUB-1");
});

test("a rule never reads a private team's issues for an editor outside it", async () => {
  startReactions();
  startEco();
  saveReaction(ws, { id: "leak-rule-1", when: { type: "projects", entity: "issue" }, if: { kind: "compare", field: "Title", op: "<", value: "zzz" }, then: [{ do: "issue.create", title: "zzz seen {Identifier} {Title}", teamId: pub.id }] }, editor);
  const hidden = createIssue(ctxFor(owner, ws, "edit"), { teamId: secret.id, title: "Acquisition talks" });
  updateIssue(ctxFor(owner, ws, "edit"), hidden.id, { priority: 1 });
  await sleep(300);
  assert.deepEqual(titles(owner, "Acquisition").filter((t) => t.startsWith("zzz")), [], "nothing of the private issue was copied");
  sql("DELETE FROM dz_reactions WHERE id = 'leak-rule-1'");
});

test("a rule that creates issues on issue changes does not feed itself", async () => {
  startReactions();
  // Projects' changes reach the pulse through the ecosystem's glue (started with the indexer).
  startEco();
  const project = createProject(ctxFor(owner, ws, "edit"), { name: "QA", teamIds: [pub.id] });
  saveReaction(ws, { id: "loop-rule-1", when: { type: "projects", entity: "issue", project: project.id }, if: { kind: "always" }, then: [{ do: "issue.create", title: "QA: {Title}", teamId: pub.id, projectId: project.id }] }, owner);
  createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "Checkout", projectId: project.id });
  await sleep(600);
  const made = titles(owner, "QA:");
  assert.ok(made.length >= 1 && made.length <= 3, `follow-ups: ${JSON.stringify(made)}`);
  await sleep(400);
  assert.equal(titles(owner, "QA:").length, made.length, "and no more keep coming");
  sql("DELETE FROM dz_reactions WHERE id = 'loop-rule-1'");
});

test("a rule stops acting when its author can no longer edit", async () => {
  startReactions();
  const goal = createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "Ship v2" });
  saveReaction(ws, { id: "demoted-rule-1", when: { type: "metric", key: "ship" }, if: { kind: "compare", field: "value", op: ">=", value: 1 }, then: [{ do: "issue.done", issue: goal.id }] }, editor);
  setRole(owner, ws, editor, "viewer");
  const { putMetric } = await import("@/lib/decide/engine");
  putMetric(ws, "ship", 5, null, "ingest");
  await sleep(300);
  const cat = listStatuses(ctxFor(owner, ws, "read")).find((s) => s.id === createIssueStatus(goal.id))?.category;
  assert.notEqual(cat, "completed", "a viewer's rule does nothing — and never as the owner");
  setRole(owner, ws, editor, "editor");
});

function createIssueStatus(id: string): string {
  return (sql("SELECT status_id FROM pj_issues WHERE id = ?").get(id) as { status_id: string }).status_id;
}

test("goal → done follows what holds the goal, not what mentions it", async () => {
  startReactions();
  startEco();
  const goal = createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "1k users" });
  const now = Date.now();
  const db = sanitizeNote({ id: "secdb0000000000000000000000kr001", kind: "database", title: "OKRs", parentId: null, icon: "", cover: null, content: [], order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "st", name: "Status", type: "status", options: [{ id: "todo", name: "Todo", color: "default", group: "todo" }, { id: "done", name: "Done", color: "green", group: "done" }] }], views: [] } }) as Note;
  const holds = sanitizeNote({ id: "secrow000000000000000000000holds", kind: "page", title: "KR holds the goal", parentId: db.id, icon: "", cover: null, content: [{ id: "x1", type: "issue", props: { issueId: goal.id }, children: [] }], props: { st: "todo" }, order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null }) as Note;
  const mentions = sanitizeNote({ id: "secrow0000000000000000000mentio", kind: "page", title: "Report mentions it", parentId: db.id, icon: "", cover: null, content: [{ id: "x2", type: "paragraph", props: {}, content: [{ type: "link", href: `/projects/issue/${goal.identifier}`, content: [] }], children: [] }], props: { st: "todo" }, order: 2, favorite: false, createdAt: now, updatedAt: now, trashedAt: null }) as Note;
  pushNotes(ws, [{ id: db.id, note: db }, { id: holds.id, note: holds }, { id: mentions.id, note: mentions }], { by: owner, quotaLeft: Infinity });
  await until(() => linksOf(ws, `note:${mentions.id}`).length > 0 && linksOf(ws, `note:${holds.id}`).length > 0);
  saveReaction(ws, { id: "follow-rule-1", when: { type: "metric", key: "users" }, if: { kind: "compare", field: "value", op: ">=", value: 1000 }, then: [{ do: "issue.done", issue: goal.id }, { do: "links.done", from: `issue:${goal.id}` }] }, owner);
  const { putMetric } = await import("@/lib/decide/engine");
  putMetric(ws, "users", 1200, null, "ingest");
  const st = (id: string) => (JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, id) as { json: string }).json) as Note).props?.st;
  await until(() => st(holds.id) === "done");
  assert.equal(st(holds.id), "done", "the key result holding the goal is done");
  assert.equal(st(mentions.id), "todo", "the report that only mentions it is not");
});

test("issues cannot be filed into a project the person cannot see; Related of a hidden issue is empty", async () => {
  const hiddenProject = createProject(ctxFor(owner, ws, "edit"), { name: "Secret project", teamIds: [secret.id] });
  const doc = page("Plan", []);
  await assert.rejects(issueFromDoc(actor(editor), { note: doc.id, title: "Sneak", projectId: hiddenProject.id }), (e: unknown) => e instanceof EcoError && e.status === 404);
  const hidden = createIssue(ctxFor(owner, ws, "edit"), { teamId: secret.id, title: "Hidden one" });
  const linking = page("Links to hidden", [{ id: "y1", type: "issue", props: { issueId: hidden.id }, children: [] }]);
  indexNote(ws, linking.id);
  assert.deepEqual((await relatedOf(actor(editor), `issue:${hidden.id}`)).items, [], "nothing about the hidden issue");
  assert.equal((await relatedOf(actor(owner), `issue:${hidden.id}`)).items.length, 1, "its members see it");
});

test("a big push (80 notes) is indexed whole", async () => {
  startEco();
  const now = Date.now();
  const items = Array.from({ length: 80 }, (_, i) => {
    const id = `secbulk${String(i).padStart(25, "0")}`;
    return { id, note: sanitizeNote({ id, kind: "page", title: `Bulk ${i}`, parentId: null, icon: "", cover: null, content: [], order: i, favorite: false, createdAt: now, updatedAt: now, trashedAt: null }) as Note };
  });
  pushNotes(ws, items, { by: owner, quotaLeft: Infinity });
  const count = () => Number((sql("SELECT COUNT(*) AS n FROM eco_docs WHERE ws_id = ? AND title LIKE 'Bulk %'").get(ws) as { n: number }).n);
  await until(() => count() === 80);
  assert.equal(count(), 80);
});

test("after a lost poke (a restart), the catch-up indexes what changed and prunes what is gone", async () => {
  const { stopEco, catchUp, indexWorkspace } = await import("@/lib/eco/indexer");
  const { backlinksOf } = await import("@/lib/eco/links");
  await indexWorkspace(ws);
  stopEco(); // the indexer is down: pokes go nowhere
  const target = createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "Missed while down" });
  const p = page("Written while down", [{ id: "z1", type: "issue", props: { issueId: target.id }, children: [] }]);
  // As if the poke had been lost: no trace of the save in the index, and the mark from before it.
  const stamp = (sql("SELECT stamp FROM notes WHERE ws = ? AND id = ?").get(ws, p.id) as { stamp: number }).stamp;
  sql("DELETE FROM eco_links WHERE ws_id = ? AND src = ?").run(ws, `note:${p.id}`);
  sql("DELETE FROM eco_docs WHERE ws_id = ? AND note_id = ?").run(ws, p.id);
  sql("UPDATE eco_index SET notes_stamp = ? WHERE ws_id = ?").run(stamp - 1, ws);
  assert.deepEqual(linksOf(ws, `note:${p.id}`), []);
  await catchUp(ws);
  assert.ok(linksOf(ws, `note:${p.id}`).some((l) => l.dst === `issue:${target.id}`), "the catch-up found the save by its stamp");
  // Deleted forever while down: the catch-up drops its catalog entry and links.
  pushNotes(ws, [{ id: p.id, deleted: true }], { by: owner, quotaLeft: Infinity });
  await catchUp(ws);
  assert.deepEqual(linksOf(ws, `note:${p.id}`), []);
  assert.equal(sql("SELECT 1 FROM eco_docs WHERE ws_id = ? AND note_id = ?").get(ws, p.id), undefined);
  // An issue removed behind the indexer's back: its links are pruned.
  const doomed = createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "Doomed" });
  const holder = page("Holds doomed", [{ id: "z2", type: "issue", props: { issueId: doomed.id }, children: [] }]);
  await catchUp(ws);
  assert.ok(backlinksOf(ws, `issue:${doomed.id}`).length > 0);
  sql("DELETE FROM pj_issues WHERE id = ?").run(doomed.id);
  const { prune } = await import("@/lib/eco/indexer");
  prune(ws);
  assert.deepEqual(linksOf(ws, `issue:${doomed.id}`), [], "nothing from a gone issue");
  void holder;
  startEco();
});

test("removing a relation property re-indexes the database's rows", async () => {
  startEco();
  const now = Date.now();
  const other = page("Other page", []);
  const dbNote = sanitizeNote({ id: "secdb00000000000000000000rel001", kind: "database", title: "Linked", parentId: null, icon: "", cover: null, content: [], order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "rel", name: "Related", type: "relation", relation: { dbId: "secdb00000000000000000000rel001" } }], views: [] } }) as Note;
  const row = sanitizeNote({ id: "secrow0000000000000000000rel011", kind: "page", title: "Row", parentId: dbNote.id, icon: "", cover: null, content: [], props: { rel: [other.id] }, order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null }) as Note;
  pushNotes(ws, [{ id: dbNote.id, note: dbNote }, { id: row.id, note: row }], { by: owner, quotaLeft: Infinity });
  await until(() => linksOf(ws, `note:${row.id}`).some((l) => l.via === "relation"));
  assert.ok(linksOf(ws, `note:${row.id}`).some((l) => l.dst === `note:${other.id}` && l.via === "relation"));
  const without = { ...dbNote, db: { ...dbNote.db!, properties: dbNote.db!.properties.filter((p) => p.id !== "rel") }, updatedAt: Date.now() };
  pushNotes(ws, [{ id: dbNote.id, note: without }], { by: owner, quotaLeft: Infinity });
  await until(() => !linksOf(ws, `note:${row.id}`).some((l) => l.via === "relation"));
  assert.deepEqual(linksOf(ws, `note:${row.id}`).filter((l) => l.via === "relation"), [], "the row's relation links went with the property");
});

test("a deleted account leaves no trace in links", async () => {
  const gone = person("Leaving");
  acceptInvite(gone, createInvite(owner, ws, "editor").token);
  const p = page("Mentions the leaver", [{ id: "u1", type: "paragraph", props: {}, content: [{ type: "mention", props: { userId: gone } }], children: [] }]);
  indexNote(ws, p.id);
  assert.ok(linksOf(ws, `note:${p.id}`).some((l) => l.dst === `user:${gone}`));
  const { deleteAccount } = await import("@/lib/account");
  await deleteAccount(gone);
  assert.deepEqual(linksOf(ws, `note:${p.id}`).filter((l) => l.dst === `user:${gone}`), []);
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM eco_links WHERE created_by = ?").get(gone) as { n: number }).n), 0);
});

test("the live stream tells a private team's moves to its members only", async () => {
  startEco();
  const { visibleTo, listen } = await import("@/lib/pulse/bus");
  const seen: import("@/lib/pulse/bus").PulseEvent[] = [];
  const stop = listen(ws, (e) => seen.push(e));
  try {
    const hidden = createIssue(ctxFor(owner, ws, "edit"), { teamId: secret.id, title: "Board memo" });
    const open = createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "Public memo" });
    page("Points at the memo", [{ id: "v1", type: "issue", props: { issueId: hidden.id }, children: [] }]);
    await until(() => seen.some((e) => e.type === "links" && (e.ref === `issue:${hidden.id}` || e.refs?.includes(`issue:${hidden.id}`))));
    const pj = seen.find((e) => e.type === "projects" && e.ref === hidden.id)!;
    const pjOpen = seen.find((e) => e.type === "projects" && e.ref === open.id)!;
    const lk = seen.find((e) => e.type === "links" && e.ref === `issue:${hidden.id}`)!;
    assert.ok(pj && lk, "the private issue's pokes exist on the server");
    assert.equal(lk.refs, undefined, "a private key travels in a poke of its own");
    assert.equal(visibleTo(editor, pj), false, "not sent to someone outside the private team");
    assert.equal(visibleTo(editor, lk), false);
    assert.equal(visibleTo(owner, pj), true, "sent to its members");
    assert.equal(visibleTo(owner, lk), true);
    assert.equal(visibleTo(editor, pjOpen), true, "public teams' pokes go to everyone");
  } finally {
    stop();
  }
});

test("a Private page (Documents' page access) stays private in cards, search, Related and the live stream", async () => {
  startEco();
  const { cardsFor } = await import("@/lib/eco/cards");
  const { searchAll } = await import("@/lib/eco/search");
  const { visibleTo, listen } = await import("@/lib/pulse/bus");
  const seen: import("@/lib/pulse/bus").PulseEvent[] = [];
  const stop = listen(ws, (e) => seen.push(e));
  try {
    const issue = createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "Shared issue" });
    const diary = page("Owen's salary notes zebra", [{ id: "p1", type: "issue", props: { issueId: issue.id }, children: [] }], { space: `private:${owner}` } as Partial<Note>);
    indexNote(ws, diary.id);
    assert.equal((await cardsFor(actor(owner), [`note:${diary.id}`])).length, 1, "its owner sees it");
    assert.equal((await cardsFor(actor(editor), [`note:${diary.id}`])).length, 0, "another member does not");
    assert.ok(!(await searchAll(actor(editor), "zebra")).hits.some((h) => h.key === `note:${diary.id}`), "not in their search");
    assert.ok((await searchAll(actor(owner), "zebra")).hits.some((h) => h.key === `note:${diary.id}`));
    assert.ok(!(await relatedOf(actor(editor), `issue:${issue.id}`)).items.some((i) => i.card.key === `note:${diary.id}`), "not in Related of the issue it holds");
    await until(() => seen.some((e) => e.type === "links" && e.ref === `note:${diary.id}`));
    const poke = seen.find((e) => e.type === "links" && e.ref === `note:${diary.id}`)!;
    assert.equal(visibleTo(editor, poke), false, "its link poke is not sent to others");
    assert.equal(visibleTo(owner, poke), true);
  } finally {
    stop();
  }
});

test("a private team's issue lends its title to no workspace page: its document goes to the maker's Private section", async () => {
  const { docFor } = await import("@/lib/eco/actions");
  const { cardsFor } = await import("@/lib/eco/cards");
  const hidden = createIssue(ctxFor(owner, ws, "edit"), { teamId: secret.id, title: "SECRET acquisition" });
  const made = await docFor(actor(owner), `issue:${hidden.id}`);
  const stored = JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, made.noteId) as { json: string }).json) as Note;
  assert.equal(stored.space, `private:${owner}`);
  indexNote(ws, made.noteId);
  assert.equal((await cardsFor(actor(editor), [`note:${made.noteId}`])).length, 0, "another member does not see it");
  // A public team's issue still gets a workspace page.
  const open = createIssue(ctxFor(owner, ws, "edit"), { teamId: pub.id, title: "Open spec" });
  const shared = await docFor(actor(owner), `issue:${open.id}`);
  const sharedNote = JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, shared.noteId) as { json: string }).json) as Note;
  assert.equal(sharedNote.space ?? null, null);
});

test("an issue made from a Private page names no title of it; from a workspace page it does", async () => {
  const diary = page("Owen private salary review", [], { space: `private:${owner}` } as Partial<Note>);
  indexNote(ws, diary.id);
  await issueFromDoc(actor(owner), { note: diary.id, title: "Follow up", teamId: pub.id });
  const fromPrivate = queryIssues(ctxFor(editor, ws, "read"), { filter: { q: "salary" }, display: { group: "none" }, limit: 5 });
  assert.equal(fromPrivate.total, 0, "the private page's title is not searchable through the issue");
  const wiki = page("Team wiki onboarding", []);
  indexNote(ws, wiki.id);
  await issueFromDoc(actor(owner), { note: wiki.id, title: "Update wiki", teamId: pub.id });
  assert.ok(titles(editor, "onboarding").includes("Update wiki"));
});

test("search: others' private pages never crowd out the shared ones", async () => {
  const { searchAll, recent } = await import("@/lib/eco/search");
  for (let i = 0; i < 30; i++) indexNote(ws, page(`quokka private ${i}`, [], { space: `private:${owner}` } as Partial<Note>).id);
  const shared = page("quokka shared plan", []);
  indexNote(ws, shared.id);
  for (let i = 0; i < 10; i++) indexNote(ws, page(`newer private ${i}`, [], { space: `private:${owner}` } as Partial<Note>).id);
  assert.ok((await searchAll(actor(editor), "quokka")).hits.some((h) => h.key === `note:${shared.id}`));
  assert.ok((await recent(actor(editor))).some((h) => h.key === `note:${shared.id}`));
});
