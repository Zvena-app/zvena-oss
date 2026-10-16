import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { designForIssue, docFor, docForIssue, EcoError, issueFromDoc, link, setIssueDone, teamFor, unlink, type Actor } from "@/lib/eco/actions";
import { cardsFor } from "@/lib/eco/cards";
import { refsInMarkdown, refsInNote } from "@/lib/eco/extract";
import { indexIssue, indexNote, indexWorkspace, startEco, stopEco } from "@/lib/eco/indexer";
import { backlinksOf, linksOf } from "@/lib/eco/links";
import { parseRefKey, refFromUrl, refHref, refKey } from "@/lib/eco/refs";
import { relatedOf } from "@/lib/eco/related";
import { searchAll } from "@/lib/eco/search";
import { issueList, projectOptions } from "@/lib/eco/lists";
import { inboxOf, markInbox, notify, unreadOf } from "@/lib/eco/inbox";
import { pushNotes } from "@/lib/notes/server-store";
import { sanitizeNote } from "@/lib/notes/model";
import type { Note } from "@/lib/notes/types";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, deleteIssues, getIssueBrief } from "@/lib/projects/issues";
import { addComment, deleteComment } from "@/lib/projects/social";
import { createProject } from "@/lib/projects/planning";
import { createTeam, listStatuses, setTeamMember } from "@/lib/projects/teams";
import { listen, type PulseEvent } from "@/lib/pulse/bus";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

const O = { app: "http://localhost:3100", design: "http://localhost:3110" };
const FILE = "0b1e8a4c-1111-4222-8333-944455556666";
const FRAME = "0b1e8a4c-aaaa-4bbb-8ccc-dddeeeefff00";
/** Waits until `ok()` holds (parallel test runs are slow), at most `ms`. */
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ refs (pure)

test("ref keys round-trip and reject anything else", () => {
  for (const key of ["note:abcdef12", "issue:Xy_-0123", "project:p0000001", `design:${FILE}`, `design:${FILE}/${FRAME}`, "user:u_abcdef"]) {
    const r = parseRefKey(key);
    assert.ok(r, key);
    assert.equal(refKey(r!), key);
  }
  for (const bad of ["", "note:", "note:a b", "team:abcdef12", "design:not-a-uuid", `design:${FILE}/${FRAME}/x`, `design:${FILE}/zzz`, 42, null]) assert.equal(parseRefKey(bad), null, String(bad));
});

test("zvena's own addresses become refs; other links do not", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(refFromUrl(`/docs?ws=abc#Plan-${id}`, O), { kind: "note", id });
  assert.deepEqual(refFromUrl(`http://localhost:3100/notes#${id}`, O), { kind: "note", id });
  assert.deepEqual(refFromUrl("/n/share_12345", O), { kind: "note-share", id: "share_12345" });
  assert.deepEqual(refFromUrl(`/design?ws=x&file=${FILE}`, O), { kind: "design", file: FILE });
  assert.deepEqual(refFromUrl(`/design?ws=x&file=${FILE}&frame=${FRAME}`, O), { kind: "design", file: FILE, frame: FRAME });
  assert.deepEqual(refFromUrl(`http://localhost:3110/#/workspace?team-id=${FRAME}&file-id=${FILE}&page-id=${FRAME}&board-id=${FRAME}`, O), { kind: "design", file: FILE, frame: FRAME });
  assert.deepEqual(refFromUrl(`http://localhost:3110/#/view?file-id=${FILE}&page-id=${FRAME}`, O), { kind: "design", file: FILE });
  assert.deepEqual(refFromUrl("/projects/issue/zvn-12?ws=a", O), { kind: "issue-ident", ident: "ZVN-12" });
  assert.deepEqual(refFromUrl("/projects/team/ZVN/active?peek=ZVN-7", O), { kind: "issue-ident", ident: "ZVN-7" });
  assert.deepEqual(refFromUrl("/projects/project/proj_00001?ws=a", O), { kind: "project", id: "proj_00001" });
  for (const no of ["https://example.com/docs#" + id, "/docs", "/projects/issue/not an id", "javascript:alert(1)", "http://localhost:3110/#/dashboard", "", "/home"]) assert.equal(refFromUrl(no, O), null, no);
  assert.equal(refHref({ kind: "issue", id: "x" }, "ws1", { ident: "ZVN-1" }), "/projects/issue/ZVN-1?ws=ws1");
});

test("a page's mentions, links, live blocks and relations are found, once each", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const found = refsInNote(
    {
      content: [
        { type: "paragraph", content: [{ type: "text", text: "see " }, { type: "mention", props: { noteId: "page_000001" } }, { type: "link", href: "/projects/issue/ZVN-3", content: [{ type: "text", text: "ZVN-3" }] }] },
        { type: "design", props: { fileId: FILE, frameId: FRAME } },
        { type: "issue", props: { issueId: "issue_00001" } },
        { type: "bookmark", props: { url: `/docs#${id}` } },
        { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "link", href: "/projects/project/proj_00001", content: [] }]] }] } },
        { type: "bulletListItem", content: [], children: [{ type: "paragraph", content: [{ type: "mention", props: { noteId: "page_000001" } }] }] },
        { type: "page", props: { noteId: "child_00001" } },
      ],
      props: { rel: ["row_000001", "row_000002"], tags: ["opt1"] },
    },
    O,
    ["rel"]
  );
  assert.deepEqual(
    found.map((f) => `${f.via} ${JSON.stringify(f.raw)}`),
    [
      `mention {"kind":"note","id":"page_000001"}`,
      `link {"kind":"issue-ident","ident":"ZVN-3"}`,
      `embed {"kind":"design","file":"${FILE}","frame":"${FRAME}"}`,
      `embed {"kind":"issue","id":"issue_00001"}`,
      `link {"kind":"note","id":"${id}"}`,
      `link {"kind":"project","id":"proj_00001"}`,
      `relation {"kind":"note","id":"row_000001"}`,
      `relation {"kind":"note","id":"row_000002"}`,
    ]
  );
});

test("Markdown links, angle links and bare URLs to zvena are found", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const md = `Spec: [the plan](/docs?ws=a#Plan-${id}). Mock-up <http://localhost:3110/#/workspace?file-id=${FILE}>, related http://localhost:3100/projects/issue/ZVN-9. [ext](https://example.com) and [@ id="u1" label="Ann"]`;
  assert.deepEqual(
    refsInMarkdown(md, O).map((f) => JSON.stringify(f.raw)),
    [`{"kind":"note","id":"${id}"}`, `{"kind":"design","file":"${FILE}"}`, `{"kind":"issue-ident","ident":"ZVN-9"}`]
  );
  assert.deepEqual(refsInMarkdown(undefined, O), []);
});

// ------------------------------------------------------------ the server side

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `eco-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

const owner = person("Olivia");
const editor = person("Alex");
const viewer = person("Vera");
const ws = createWorkspace(owner, "Studio").id;
for (const [who, role] of [
  [editor, "editor"],
  [viewer, "viewer"],
] as const)
  acceptInvite(who, createInvite(owner, ws, role).token);

const actor = (userId: string, name = "Someone"): Actor => ({ userId, name, wsId: ws, locale: "en" });
const team = createTeam(ctxFor(owner, ws, "edit"), { name: "Studio", key: "STU" }, "en");
setTeamMember(ctxFor(owner, ws, "manage"), team.id, editor, "member");

let n = 0;
function page(title: string, content: unknown[], extra: Partial<Note> = {}): Note {
  const now = Date.now();
  const id = `eco${String(++n).padStart(29, "0")}`;
  const note = sanitizeNote({ id, kind: "page", title, parentId: null, icon: "", cover: null, content, order: n, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, ...extra });
  assert.ok(note, title);
  const res = pushNotes(ws, [{ id, note: note! }], { by: editor, quotaLeft: Infinity });
  assert.deepEqual(res.saved, [id]);
  return note!;
}

const para = (...inline: unknown[]) => ({ id: `b${++n}`, type: "paragraph", props: {}, content: inline, children: [] });
const text = (t: string) => ({ type: "text", text: t, styles: {} });

test("saving a page indexes its links live, both ways", async () => {
  startEco();
  const events: PulseEvent[] = [];
  const stop = listen(ws, (e) => events.push(e));
  try {
    const issue = createIssue(ctxFor(editor, ws, "edit"), { teamId: team.id, title: "Ship the onboarding" });
    const target = page("Research notes", [para(text("raw findings about onboarding"))]);
    const doc = page("Onboarding plan", [para(text("Read "), { type: "mention", props: { noteId: target.id } }, text(" then do "), { type: "link", href: `/projects/issue/${issue.identifier}`, content: [text(issue.identifier)] })]);
    await until(() => linksOf(ws, `note:${doc.id}`).length === 2 && events.some((e) => e.type === "links"));
    const out = linksOf(ws, `note:${doc.id}`).map((l) => `${l.via} ${l.dst}`).sort();
    assert.deepEqual(out, [`link issue:${issue.id}`, `mention note:${target.id}`]);
    assert.deepEqual(
      backlinksOf(ws, `issue:${issue.id}`).map((l) => l.src),
      [`note:${doc.id}`]
    );
    assert.ok(events.some((e) => e.type === "links" && (e.ref === `issue:${issue.id}` || e.refs?.includes(`issue:${issue.id}`))), "the issue's panel is poked");

    // From the issue's side, the page shows up as "in".
    const rel = await relatedOf(actor(viewer), `issue:${issue.id}`);
    assert.deepEqual(
      rel.items.map((i) => [i.card.title, i.dir, i.via]),
      [["Onboarding plan", "in", "link"]]
    );

    // Editing the page so it no longer mentions the research drops that link.
    pushNotes(ws, [{ id: doc.id, note: { ...doc, content: [para(text("nothing here"))], updatedAt: Date.now() } }], { by: editor, quotaLeft: Infinity });
    await until(() => linksOf(ws, `note:${doc.id}`).length === 0);
    assert.deepEqual(linksOf(ws, `note:${doc.id}`), []);
    assert.deepEqual(backlinksOf(ws, `note:${target.id}`), []);
  } finally {
    stop();
  }
});

test("issue descriptions and comments link to documents; deleted comments unlink", async () => {
  const doc = page("Spec v2", [para(text("the spec"))]);
  const ctx = ctxFor(editor, ws, "edit");
  const issue = createIssue(ctx, { teamId: team.id, title: "Build it", description: `See [the spec](/docs?ws=${ws}#Spec-v2-${doc.id})` });
  indexIssue(ws, issue.id);
  assert.deepEqual(
    linksOf(ws, `issue:${issue.id}`).map((l) => [l.part, l.dst]),
    [["", `note:${doc.id}`]]
  );
  const other = page("Design review", []);
  const c = addComment(ctx, issue.id, { body: `Notes in [review](http://localhost:3100/docs#${other.id})` });
  indexIssue(ws, issue.id);
  assert.ok(linksOf(ws, `issue:${issue.id}`).some((l) => l.part === `c:${c.id}` && l.dst === `note:${other.id}`));
  deleteComment(ctx, c.id);
  indexIssue(ws, issue.id);
  assert.ok(!linksOf(ws, `issue:${issue.id}`).some((l) => l.dst === `note:${other.id}`));
  const rel = await relatedOf(actor(editor), `note:${doc.id}`);
  assert.deepEqual(
    rel.items.map((i) => [i.card.kind, i.card.sub, i.dir]),
    [["issue", issue.identifier, "in"]]
  );
});

test("cards follow each product's rules: private teams, trash, hidden notes", async () => {
  const privateTeam = createTeam(ctxFor(owner, ws, "edit"), { name: "Secret", key: "SEC", private: true }, "en");
  const secret = createIssue(ctxFor(owner, ws, "edit"), { teamId: privateTeam.id, title: "Secret plan" });
  const open = createIssue(ctxFor(owner, ws, "edit"), { teamId: team.id, title: "Open plan" });
  const trashed = page("Old idea", [], { trashedAt: Date.now() });
  const child = page("Under the old idea", [], { parentId: trashed.id });
  const template = page("Template", [], { template: true });
  const fine = page("Fine page", []);
  for (const id of [trashed.id, child.id, template.id, fine.id]) indexNote(ws, id);
  const keys = [`issue:${secret.id}`, `issue:${open.id}`, `note:${trashed.id}`, `note:${child.id}`, `note:${template.id}`, `note:${fine.id}`, "note:missing00", `design:${FILE}`];
  assert.deepEqual(
    (await cardsFor(actor(owner), keys)).map((c) => c.title),
    ["Secret plan", "Open plan", "Fine page"]
  );
  assert.deepEqual(
    (await cardsFor(actor(viewer), keys)).map((c) => c.title),
    ["Open plan", "Fine page"]
  );
  const [card] = await cardsFor(actor(viewer), [`issue:${open.id}`]);
  assert.equal(card.sub, open.identifier);
  assert.equal(card.status?.category, "unstarted");
  assert.equal(card.url, `/projects/issue/${open.identifier}?ws=${ws}`);
});

test("a line of a document becomes an issue that links back; its checkbox is the issue's status", async () => {
  const doc = page("Launch checklist", [para(text("Write the announcement"))]);
  const card = await issueFromDoc(actor(editor, "Alex"), { note: doc.id, title: "  Write   the announcement ", assigneeId: "me" });
  assert.equal(card.title, "Write the announcement");
  assert.equal(card.assignee?.id, editor);
  const issueId = card.key.slice("issue:".length);
  const brief = getIssueBrief(ctxFor(editor, ws, "read"), issueId);
  assert.equal(brief.teamId, team.id, "the person's own team");
  indexIssue(ws, issueId);
  const rel = await relatedOf(actor(editor), `note:${doc.id}`);
  const row = rel.items.find((i) => i.card.key === card.key);
  assert.ok(row, "the doc lists the issue");
  assert.equal(row.via, "converted");
  // …and the issue's description points back at the doc.
  assert.ok(linksOf(ws, card.key).some((l) => l.dst === `note:${doc.id}` && l.via === "link"));

  const done = await setIssueDone(actor(editor), issueId, true);
  assert.equal(done.status?.category, "completed");
  const undone = await setIssueDone(actor(editor), issueId, false);
  assert.equal(undone.status?.category, "unstarted");

  await assert.rejects(issueFromDoc(actor(viewer), { note: doc.id, title: "Nope" }), (e: unknown) => e instanceof EcoError && e.status === 403);
  await assert.rejects(issueFromDoc(actor(editor), { note: "nope000000", title: "Nope" }), (e: unknown) => e instanceof EcoError && e.status === 404);
  await assert.rejects(issueFromDoc(actor(editor), { note: doc.id, title: "   " }), (e: unknown) => e instanceof EcoError && e.status === 400);
});

test("an issue gets a document that starts with the live issue", async () => {
  const issue = createIssue(ctxFor(editor, ws, "edit"), { teamId: team.id, title: "Pricing page" });
  const { noteId, url } = await docForIssue(actor(editor, "Alex"), issue.id);
  assert.match(url, new RegExp(`^/docs\\?ws=${ws}#Pricing-page-${noteId}$`));
  await until(() => linksOf(ws, `note:${noteId}`).some((l) => l.via === "embed"));
  const rel = await relatedOf(actor(viewer), `issue:${issue.id}`);
  assert.deepEqual(
    rel.items.map((i) => [i.card.title, i.via]),
    [["Pricing page", "converted"]]
  );
  // The page's issue block is itself a link to the issue.
  assert.ok(linksOf(ws, `note:${noteId}`).some((l) => l.dst === `issue:${issue.id}` && l.via === "embed"));
  await assert.rejects(designForIssue(actor(editor), issue.id), (e: unknown) => e instanceof EcoError && e.status === 503, "Design is off in tests");
});

test("people link and unlink things by hand", async () => {
  const a = page("Brand book", []);
  const project = createProject(ctxFor(owner, ws, "edit"), { name: "Rebrand", teamIds: [team.id] });
  indexNote(ws, a.id);
  assert.equal(await link(actor(editor), `note:${a.id}`, `project:${project.id}`), true);
  assert.equal(await link(actor(editor), `note:${a.id}`, `project:${project.id}`), false, "already linked");
  const rel = await relatedOf(actor(viewer), `project:${project.id}`);
  assert.deepEqual(
    rel.items.map((i) => [i.card.title, i.manual, i.dir]),
    [["Brand book", true, "in"]]
  );
  await assert.rejects(link(actor(editor), `note:${a.id}`, "note:missing00"), (e: unknown) => e instanceof EcoError && e.status === 404);
  assert.equal(unlink(actor(editor), `project:${project.id}`, `note:${a.id}`), true, "either way round");
  assert.deepEqual((await relatedOf(actor(viewer), `project:${project.id}`)).items, []);
});

test("one search finds documents by their text and issues by their title", async () => {
  const doc = page("Quarterly goals", [para(text("Grow weekly active teams to forty"))]);
  indexNote(ws, doc.id);
  const issue = createIssue(ctxFor(editor, ws, "edit"), { teamId: team.id, title: "Forty active teams dashboard" });
  const res = await searchAll(actor(viewer), "forty");
  const keys = res.hits.map((h) => h.key);
  assert.ok(keys.includes(`issue:${issue.id}`), "issue by title");
  assert.ok(keys.includes(`note:${doc.id}`), "doc by body text");
  const hit = res.hits.find((h) => h.key === `note:${doc.id}`)!;
  assert.match(hit.snippet ?? "", /forty/i);
  // Two letters: titles only.
  assert.ok((await searchAll(actor(viewer), "Qu")).hits.some((h) => h.key === `note:${doc.id}`));
  // Nothing typed: recent things.
  assert.ok((await searchAll(actor(viewer), "")).hits.length > 0);
});

test("teamFor picks the person's team, or makes the first one for an editor", () => {
  assert.equal(teamFor(ctxFor(editor, ws, "edit"), "en"), team.id);
  const fresh = createWorkspace(person("Fresh owner"), "Fresh Co");
  const ctx = ctxFor(fresh.ownerId, fresh.id, "edit");
  const id = teamFor(ctx, "en");
  assert.equal(teamFor(ctx, "en"), id, "made once");
  assert.ok(listStatuses(ctx).some((s) => s.teamId === id && s.category === "completed"));
});

test("a workspace indexed from scratch finds the links that were there before", async () => {
  stopEco();
  const target = page("Target", []);
  const before = page("Written while the indexer slept", [para({ type: "mention", props: { noteId: target.id } })]);
  await tick(150);
  assert.deepEqual(linksOf(ws, `note:${before.id}`), []);
  await indexWorkspace(ws);
  assert.deepEqual(
    linksOf(ws, `note:${before.id}`).map((l) => l.dst),
    [`note:${target.id}`]
  );
});

test("Projects' own change hook reaches the pulse, and the indexer follows it", async () => {
  startEco();
  const events: PulseEvent[] = [];
  const stop = listen(ws, (e) => events.push(e));
  try {
    const doc = page("Live spec", []);
    await tick(40);
    const ctx = ctxFor(editor, ws, "edit");
    const issue = createIssue(ctx, { teamId: team.id, title: "Wire it", description: `[spec](/docs#${doc.id})` });
    await until(() => backlinksOf(ws, `note:${doc.id}`).length > 0 && events.some((e) => e.type === "projects" && e.ref === issue.id));
    assert.ok(events.some((e) => e.type === "projects" && e.ref === issue.id && e.data?.entity === "issue"));
    assert.deepEqual(
      backlinksOf(ws, `note:${doc.id}`).map((l) => l.src),
      [`issue:${issue.id}`],
      "indexed without being asked"
    );
    const c = addComment(ctx, issue.id, { body: "no links" });
    await until(() => events.some((e) => e.data?.entity === "comment" && e.data?.id === c.id));
    assert.ok(events.some((e) => e.type === "projects" && e.ref === issue.id && e.data?.entity === "comment" && e.data?.id === c.id));
    deleteIssues(ctx, [issue.id]);
    await until(() => backlinksOf(ws, `note:${doc.id}`).length === 0);
    assert.deepEqual(backlinksOf(ws, `note:${doc.id}`), [], "a deleted issue's links go");
  } finally {
    stop();
  }
});

test("@people in documents and issues are refs too", () => {
  const found = refsInNote({ content: [para({ type: "mention", props: { userId: "user_000001" } })], props: { owner: ["user_000002"] } }, O, [], ["owner"]);
  assert.deepEqual(
    found.map((f) => `${f.via} ${JSON.stringify(f.raw)}`),
    [`mention {"kind":"user","id":"user_000001"}`, `relation {"kind":"user","id":"user_000002"}`]
  );
  assert.deepEqual(
    refsInMarkdown(`ping [@ id="user_000003" label="Ann"] please`, O).map((f) => JSON.stringify(f.raw)),
    [`{"kind":"user","id":"user_000003"}`]
  );
});

test("one Inbox: Documents' notifications and Projects' together", async () => {
  const doc = page("Kickoff notes", []);
  indexNote(ws, doc.id);
  const v = actor(viewer);
  const before = unreadOf(v);
  notify(viewer, { ws, kind: "mention", ref: `note:${doc.id}`, part: "blk1", by: editor, text: "  @Vera can you   review?  " });
  notify(viewer, { ws, kind: "mention", ref: `note:${doc.id}`, part: "blk1", by: editor, text: "second ping" });
  notify(editor, { ws, kind: "mention", ref: `note:${doc.id}`, by: editor });
  notify(person("Outsider"), { ws, kind: "mention", ref: `note:${doc.id}`, by: editor });
  assert.equal(unreadOf(v), before + 1, "refreshed, not repeated; not for oneself or outsiders");
  // Projects: being assigned an issue notifies through Projects' own inbox.
  const issue = createIssue(ctxFor(editor, ws, "edit"), { teamId: team.id, title: "Review kickoff", assigneeId: viewer });
  const box = await inboxOf(v);
  const fromDocs = box.items.find((i) => i.id.startsWith("eco:"))!;
  assert.equal(fromDocs.kind, "mention");
  assert.equal(fromDocs.card?.title, "Kickoff notes");
  assert.equal(fromDocs.text, "second ping");
  assert.equal(fromDocs.actor?.name, "Alex");
  assert.match(fromDocs.url, /&b=blk1$/);
  const fromProjects = box.items.find((i) => i.id.startsWith("pj:") && i.card?.key === `issue:${issue.id}`);
  assert.ok(fromProjects, "Projects' notification is in the same list");
  assert.equal(fromProjects.kind, "assigned");
  assert.equal(box.unread, unreadOf(v));
  assert.ok(markInbox(v, [fromDocs.id, fromProjects.id], "read") >= 2);
  assert.equal(unreadOf(v), box.unread - 2);
  markInbox(v, "all", "archive");
  assert.equal((await inboxOf(v)).items.length, 0);
  assert.ok((await inboxOf(v, { archived: true })).items.length >= 2);
});

test("a project is one folder: its page in Documents lists its issues live, and the project lists the page", async () => {
  const ctx = ctxFor(owner, ws, "edit");
  const project = createProject(ctx, { name: "Website relaunch", teamIds: [team.id] });
  createIssue(ctx, { teamId: team.id, title: "New homepage", projectId: project.id, priority: 1 });
  const done = createIssue(ctx, { teamId: team.id, title: "Old pages audit", projectId: project.id });
  await setIssueDone(actor(owner), done.id, true);
  createIssue(ctx, { teamId: team.id, title: "Not in the project" });
  const { noteId } = await docFor(actor(owner, "Olivia"), `project:${project.id}`);
  await until(() => linksOf(ws, `note:${noteId}`).some((l) => l.via === "embed"));
  // The page opens with the project's live list, and that makes it the project's page.
  assert.ok(linksOf(ws, `note:${noteId}`).some((l) => l.dst === `project:${project.id}` && l.via === "embed"));
  const rel = await relatedOf(actor(viewer), `project:${project.id}`);
  assert.deepEqual(
    rel.items.map((i) => [i.card.kind, i.card.title]),
    [["note", "Website relaunch"]]
  );
  assert.deepEqual(
    (await issueList(actor(viewer), { project: project.id })).map((c) => c.title),
    ["New homepage"]
  );
  assert.deepEqual(
    (await issueList(actor(viewer), { project: project.id, done: true })).map((c) => c.title).sort(),
    ["New homepage", "Old pages audit"]
  );
  assert.deepEqual(await issueList(actor(viewer), {}), [], "a project or 'mine' is needed");
  assert.ok(projectOptions(actor(viewer)).some((p) => p.id === project.id));
  await assert.rejects(docFor(actor(viewer), `project:${project.id}`), (e: unknown) => e instanceof EcoError && e.status === 403);
  await assert.rejects(docFor(actor(owner), "project:nope000000"), (e: unknown) => e instanceof EcoError && e.status === 404);
});

test("Calendar's Projects layer: a due-date window is applied before the limit (a hundred issues ahead never hide one due in it)", async () => {
  const ctx = ctxFor(owner, ws, "edit");
  const project = createProject(ctx, { name: "Crowded", teamIds: [team.id] });
  for (let i = 0; i < 105; i++) createIssue(ctx, { teamId: team.id, title: `Busy ${i}`, projectId: project.id, priority: 1 });
  createIssue(ctx, { teamId: team.id, title: "Due in April", projectId: project.id, priority: 4, dueDate: "2027-04-10" });
  const cards = await issueList(actor(viewer), { project: project.id, limit: 100, dueFrom: "2027-04-01", dueTo: "2027-04-30" });
  assert.deepEqual(cards.map((c) => c.title), ["Due in April"]);
});
