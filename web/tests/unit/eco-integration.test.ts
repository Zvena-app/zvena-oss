// The ecosystem across products, on the merged tree: Documents' people and
// notifications, Projects' mentions and assignments, the shared Inbox, Home's
// "Mentions", and links that follow every product's own write path.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { inboxOf, unreadOf } from "@/lib/eco/inbox";
import { indexIssue, indexNote, startEco } from "@/lib/eco/indexer";
import { backlinksOf, linksOf } from "@/lib/eco/links";
import { myDay } from "@/lib/eco/myday";
import { relatedOf } from "@/lib/eco/related";
import "@/lib/notes/reactions";
import { pushNotes } from "@/lib/notes/server-store";
import { sanitizeNote } from "@/lib/notes/model";
import type { Note } from "@/lib/notes/types";
import { ctxFor } from "@/lib/projects/core";
import { createIssue } from "@/lib/projects/issues";
import { addComment } from "@/lib/projects/social";
import { createTeam } from "@/lib/projects/teams";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
}

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `ei-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Nora");
const mate = person("Theo");
const ws = createWorkspace(owner, "Collective").id;
acceptInvite(mate, createInvite(owner, ws, "editor").token);
const team = createTeam(ctxFor(owner, ws, "edit"), { name: "Core", key: "COR" }, "en");
const viewer = (userId: string) => ({ userId, wsId: ws, locale: "en" as const });

let n = 0;
function note(fields: Partial<Note> & { title: string }): Note {
  const now = Date.now();
  const id = `ei${String(++n).padStart(30, "0")}`;
  return sanitizeNote({ id, kind: "page", parentId: null, icon: "", cover: null, content: [], order: n, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, ...fields }) as Note;
}
const mention = (userId: string) => ({ type: "mention", props: { userId } });
const para = (...inline: unknown[]) => ({ id: `blk${++n}`, type: "paragraph", props: {}, content: inline, children: [] });

test("an @mention in a document reaches the person's Inbox, and Home lists where they are mentioned", async () => {
  startEco();
  const before = unreadOf(viewer(mate));
  const page = note({ title: "Offsite plan", content: [para({ type: "text", text: "Booking: ", styles: {} }, mention(mate))] });
  pushNotes(ws, [{ id: page.id, note: page }], { by: owner, quotaLeft: Infinity, author: "Nora" });
  await until(() => unreadOf(viewer(mate)) > before);
  const box = await inboxOf(viewer(mate));
  const item = box.items.find((i) => i.card?.key === `note:${page.id}`);
  assert.ok(item, "the mention is in Theo's Inbox");
  assert.equal(item.kind, "mention");
  assert.equal(item.actor?.name, "Nora");
  assert.match(item.url, /&b=blk\d+$/, "it opens at the block");
  // The ecosystem links the page to the person.
  await until(() => backlinksOf(ws, `user:${mate}`).some((l) => l.src === `note:${page.id}`));
  const day = await myDay(viewer(mate));
  assert.ok(day.mentions.some((c) => c.key === `note:${page.id}`), "Home: where Theo is mentioned");
  // Nora is not told about her own mention of someone else.
  assert.equal((await inboxOf(viewer(owner))).items.filter((i) => i.card?.key === `note:${page.id}`).length, 0);
});

test("a Person property assigns in Documents; the Inbox says so, and the row is linked to the person", async () => {
  const db = note({
    title: "Launch tasks",
    kind: "database",
    db: {
      properties: [
        { id: "title", name: "Task", type: "title" },
        { id: "own", name: "Owner", type: "person" },
      ],
      views: [],
    },
  } as Partial<Note> & { title: string });
  pushNotes(ws, [{ id: db.id, note: db }], { by: owner, quotaLeft: Infinity, author: "Nora" });
  indexNote(ws, db.id);
  const row = note({ title: "Press kit", parentId: db.id, props: { own: [mate] } });
  pushNotes(ws, [{ id: row.id, note: row }], { by: owner, quotaLeft: Infinity, author: "Nora" });
  await until(() => linksOf(ws, `note:${row.id}`).some((l) => l.dst === `user:${mate}`));
  assert.ok(linksOf(ws, `note:${row.id}`).some((l) => l.dst === `user:${mate}` && l.via === "relation"));
  const box = await inboxOf(viewer(mate));
  assert.ok(box.items.some((i) => i.card?.key === `note:${row.id}` && i.kind === "assigned"), JSON.stringify(box.items.map((i) => [i.kind, i.card?.title])));
});

test("Projects: an @mention in an issue comment links the issue to the person; assignments notify through Projects", async () => {
  const ctx = ctxFor(owner, ws, "edit");
  const issue = createIssue(ctx, { teamId: team.id, title: "Venue contract", assigneeId: mate });
  addComment(ctx, issue.id, { body: `[@ id="${mate}" label="Theo"] please sign` });
  indexIssue(ws, issue.id);
  assert.ok(linksOf(ws, `issue:${issue.id}`).some((l) => l.dst === `user:${mate}` && l.via === "mention"));
  const day = await myDay(viewer(mate));
  assert.ok(day.issues.some((c) => c.key === `issue:${issue.id}`), "Theo's open issues");
  assert.ok(day.mentions.some((c) => c.key === `issue:${issue.id}`), "…and the issue that mentions him");
  const box = await inboxOf(viewer(mate));
  assert.ok(box.items.some((i) => i.id.startsWith("pj:") && i.card?.key === `issue:${issue.id}`), "Projects' own notification, in the same Inbox");
});

test("a document links an issue and the issue sees it; the person's mentions and links stay within the workspace", async () => {
  const ctx = ctxFor(owner, ws, "edit");
  const issue = createIssue(ctx, { teamId: team.id, title: "Catering" });
  const page = note({ title: "Menu", content: [para({ type: "link", href: `/projects/issue/${issue.identifier}`, content: [{ type: "text", text: issue.identifier, styles: {} }] })] });
  pushNotes(ws, [{ id: page.id, note: page }], { by: mate, quotaLeft: Infinity, author: "Theo" });
  await until(() => backlinksOf(ws, `issue:${issue.id}`).some((l) => l.src === `note:${page.id}`));
  const rel = await relatedOf(viewer(owner), `issue:${issue.id}`);
  assert.deepEqual(
    rel.items.map((i) => [i.card.title, i.dir]),
    [["Menu", "in"]]
  );
  // Someone outside the workspace mentioned in a page is not linked (not a member).
  const stranger = person("Stranger");
  const page2 = note({ title: "Guest list", content: [para(mention(stranger))] });
  pushNotes(ws, [{ id: page2.id, note: page2 }], { by: owner, quotaLeft: Infinity, author: "Nora" });
  await until(() => linksOf(ws, `note:${page2.id}`).length === 0 && false, 300);
  assert.deepEqual(linksOf(ws, `note:${page2.id}`), []);
});
