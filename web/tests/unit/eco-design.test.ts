import "./env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { EcoError, type Actor } from "@/lib/eco/actions";
import { commentThread, designMentions, followIssueForThread, indexDesignFile, issueFromComment, wsOfTeam, type DesignThread } from "@/lib/eco/design";
import { cardsFor } from "@/lib/eco/cards";
import { backlinksOf, linksOf } from "@/lib/eco/links";
import { relatedOf } from "@/lib/eco/related";
import { designLogin } from "@/lib/penpot";
import { ctxFor } from "@/lib/projects/core";
import { createIssue, issueDescription } from "@/lib/projects/issues";
import { createTeam } from "@/lib/projects/teams";
import { pushNotes } from "@/lib/notes/server-store";
import { sanitizeNote } from "@/lib/notes/model";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

// A stand-in for Design's management API: threads and frames of one team.
const TEAM = "7e2a0c1d-0000-4000-8000-000000000001";
const OTHER_TEAM = "7e2a0c1d-0000-4000-8000-000000000002";
const FILE = "7e2a0c1d-0000-4000-8000-0000000000f1";
const FRAME = "7e2a0c1d-0000-4000-8000-0000000000a1";
const THREAD = "7e2a0c1d-0000-4000-8000-0000000000c1";
const FOREIGN_THREAD = "7e2a0c1d-0000-4000-8000-0000000000c2";
const threads: DesignThread[] = [];
const seen: { action: string; body: Record<string, unknown> }[] = [];

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const action = (req.url ?? "").split("/").pop() ?? "";
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    seen.push({ action, body });
    const send = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.headers["x-shared-key"] !== "test-key") return send(403, {});
    if (action === "comment-thread") {
      const t = threads.find((x) => x.id === body.threadId);
      return t ? send(200, t) : send(404, {});
    }
    if (action === "resolve-comment-thread") return send(200, { id: body.threadId, isResolved: body.resolved !== false });
    if (action === "file-comments") return send(200, { teamId: TEAM, threads: threads.filter((t) => t.fileId === body.fileId) });
    if (action === "frames") return send(200, { name: "Landing", teamId: TEAM, revn: 7, frames: [{ id: FRAME, name: "Hero", pageId: "p1", pageName: "Page 1", width: 1440, height: 900 }] });
    send(404, {});
  });
});
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.PENPOT_MGMT_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PENPOT_MGMT_KEY = "test-key";
});
after(() => {
  server.close();
  delete process.env.PENPOT_MGMT_URL;
  delete process.env.PENPOT_MGMT_KEY;
});

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `ecod-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Dana");
const viewer = person("Vic");
const ws = createWorkspace(owner, "Agency").id;
acceptInvite(viewer, createInvite(owner, ws, "viewer").token);
sql("UPDATE workspaces SET penpot_team_id = ? WHERE id = ?").run(TEAM, ws);
const team = createTeam(ctxFor(owner, ws, "edit"), { name: "Web", key: "WEB" }, "en");
const actor = (userId: string): Actor => ({ userId, name: "x", wsId: ws, locale: "en" });

threads.push(
  { id: THREAD, fileId: FILE, frameId: FRAME, pageId: "p1", teamId: TEAM, fileName: "Landing", frameName: "Hero", comments: [{ id: "m1", content: "The headline is too long\nkeep it under 8 words" }, { id: "m2", content: "agreed" }] },
  { id: FOREIGN_THREAD, fileId: FILE, frameId: FRAME, teamId: OTHER_TEAM, comments: [{ id: "m3", content: "someone else's" }] }
);

test("Design's team finds its workspace", () => {
  assert.equal(wsOfTeam(TEAM), ws);
  assert.equal(wsOfTeam(OTHER_TEAM), null);
  assert.equal(wsOfTeam("not-a-uuid"), null);
});

test("a design comment becomes an issue that quotes it and is linked to the frame", async () => {
  const thread = await commentThread(owner, THREAD);
  assert.equal(thread?.frameName, "Hero");
  assert.equal(seen.at(-1)?.body.email, designLogin(owner), "read as the person");
  const card = await issueFromComment(actor(owner), { thread: THREAD });
  assert.equal(card.title, "The headline is too long", "the first line is the title");
  const issueId = card.key.slice("issue:".length);
  const md = issueDescription(ctxFor(owner, ws, "read"), issueId);
  assert.match(md, /^From a comment on \[Hero\]\(\/design\?ws=.+&file=.+&frame=.+\)/);
  assert.match(md, /> keep it under 8 words/);
  assert.deepEqual(
    linksOf(ws, `design:${FILE}/${FRAME}`).map((l) => [l.dst, l.via]),
    [[card.key, "converted"]]
  );
  // The issue lists the frame, with its live picture; the file lists its frame's issue too.
  const rel = await relatedOf(actor(viewer), card.key);
  const frame = rel.items.find((i) => i.card.kind === "design");
  assert.equal(frame?.card.title, "Hero");
  assert.match(frame?.card.image ?? "", /\/api\/design\/frame-image\?ws=.+&file=.+&frame=.+&v=7$/);
  assert.ok((await relatedOf(actor(viewer), `design:${FILE}`)).items.some((i) => i.card.key === card.key));
});

test("a comment of another team, a missing one, or a viewer cannot make issues", async () => {
  const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof EcoError ? e.status : String(e)));
  assert.equal(await code(issueFromComment(actor(owner), { thread: FOREIGN_THREAD })), 404);
  assert.equal(await code(issueFromComment(actor(owner), { thread: "7e2a0c1d-0000-4000-8000-0000000000ff" })), 404);
  assert.equal(await code(issueFromComment(actor(viewer), { thread: THREAD })), 403);
});

test("links written in design comments become the frame's links", async () => {
  const issue = createIssue(ctxFor(owner, ws, "edit"), { teamId: team.id, title: "Hero copy" });
  const now = Date.now();
  const note = sanitizeNote({ id: "ecod000000000000000000000000doc1", kind: "page", title: "Brand voice", parentId: null, icon: "", cover: null, content: [], order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null })!;
  pushNotes(ws, [{ id: note.id, note }], { by: owner, quotaLeft: Infinity });
  threads.push({ id: "7e2a0c1d-0000-4000-8000-0000000000c3", fileId: FILE, frameId: FRAME, teamId: TEAM, comments: [{ id: "m4", content: `tracked in /projects/issue/${issue.identifier} — tone per http://localhost:3100/docs#${note.id}` }] });
  await indexDesignFile(ws, FILE);
  const out = linksOf(ws, `design:${FILE}/${FRAME}`).filter((l) => l.via === "link").map((l) => l.dst).sort();
  assert.deepEqual(out, [`issue:${issue.id}`, `note:${note.id}`].sort());
  assert.ok(backlinksOf(ws, `issue:${issue.id}`).some((l) => l.src === `design:${FILE}/${FRAME}`));
  // The design shows up on the issue.
  const [card] = await cardsFor(actor(viewer), [`design:${FILE}/${FRAME}`]);
  assert.equal(card?.sub, "Landing · Page 1");
  // The thread is resolved and deleted: its links go.
  threads.splice(threads.length - 1, 1);
  await indexDesignFile(ws, FILE);
  assert.deepEqual(
    linksOf(ws, `design:${FILE}/${FRAME}`).filter((l) => l.via === "link"),
    []
  );
});

test("one thread, one issue; closing it resolves the thread in Design, reopening reopens it", async () => {
  const { updateIssue } = await import("@/lib/projects/issues");
  const { listStatuses } = await import("@/lib/projects/teams");
  const first = await issueFromComment(actor(owner), { thread: THREAD });
  const again = await issueFromComment(actor(owner), { thread: THREAD });
  assert.equal(again.key, first.key, "asked again, the same issue");
  const id = first.key.slice("issue:".length);
  const ctx = ctxFor(owner, ws, "edit");
  const done = listStatuses(ctx).find((s) => s.category === "completed")!;
  const todo = listStatuses(ctx).find((s) => s.category === "unstarted")!;
  updateIssue(ctx, id, { statusId: done.id });
  await followIssueForThread(ws, id, owner);
  const resolve = seen.filter((x) => x.action === "resolve-comment-thread");
  assert.deepEqual(resolve.at(-1)?.body, { email: designLogin(owner), threadId: THREAD, resolved: true });
  const n = resolve.length;
  await followIssueForThread(ws, id, owner);
  assert.equal(seen.filter((x) => x.action === "resolve-comment-thread").length, n, "already resolved: no second call");
  updateIssue(ctx, id, { statusId: todo.id });
  await followIssueForThread(ws, id, owner);
  assert.equal(seen.filter((x) => x.action === "resolve-comment-thread").at(-1)?.body.resolved, false);
});

test("people mentioned in a Design comment hear it in their Inbox; outsiders and the author do not", async () => {
  const { inboxOf } = await import("@/lib/eco/inbox");
  const stranger = person("Stray");
  const n = await designMentions(ws, { file: FILE, thread: THREAD, comment: "m2", logins: [designLogin(viewer), designLogin(owner), designLogin(stranger)], by: owner });
  assert.equal(n, 2, "the viewer and the stranger are asked; the author is skipped");
  const items = (await inboxOf({ userId: viewer, wsId: ws, locale: "en" })).items;
  assert.ok(items.some((i) => i.kind === "mention" && i.card?.key === `design:${FILE}/${FRAME}`), "the viewer has it");
  assert.equal((await inboxOf({ userId: stranger, wsId: ws, locale: "en" })).items.length, 0, "not a member: nothing");
  assert.equal((await inboxOf({ userId: owner, wsId: ws, locale: "en" })).items.filter((i) => i.kind === "mention").length, 0, "the author: nothing");
});
