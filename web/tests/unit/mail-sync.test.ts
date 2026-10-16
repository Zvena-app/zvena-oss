// zvena Mail against a real (local, in-memory) IMAP + SMTP server
// (tests/mail-server.cjs): connecting, the sync worker with IDLE, threads,
// bodies and attachments, actions carried to the server, sending (undo,
// the Sent copy), snooze, drafts in the Drafts folder, notifications for
// views, Docs and Projects conversions, disconnecting — and Gmail's labels.
import "./env";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { signInWith } from "@/lib/auth";
import { connectAccount, removeAccount } from "@/lib/mail-client/accounts";
import { applyAction, wakeSnoozed } from "@/lib/mail-client/actions";
import { attachmentContent } from "@/lib/mail-client/attachments";
import { renderBody } from "@/lib/mail-client/body";
import { cleanDraft } from "@/lib/mail-client/compose";
import { issueFromThread, saveThreadToDocs } from "@/lib/mail-client/docs";
import { draftFromMessage, saveDraft } from "@/lib/mail-client/drafts";
import { createView, setPrefs } from "@/lib/mail-client/prefs";
import { cancelSend, outboxOf, queueSend, sendDue } from "@/lib/mail-client/send";
import { listThreads, ownAccount, threadOf } from "@/lib/mail-client/store";
import { stopAllWorkers, workerOf } from "@/lib/mail-client/worker";
import { sql } from "@/lib/store";
import { createWorkspace } from "@/lib/workspaces";

process.env.ZVENA_STAND = "test";

interface TestServer {
  imapPort: number;
  smtpPort: number;
  deliver: (m: Record<string, unknown>, path?: string, props?: Record<string, unknown>) => { uid: number };
  list: (path: string) => { uid: number; subject: string; flags: string[]; labels: string[] }[] | null;
  close: () => Promise<void>;
}
const { startMailServer } = require(join(process.cwd(), "tests/mail-server.cjs")) as { startMailServer: (o?: { gmail?: boolean }) => Promise<TestServer> };

const servers: TestServer[] = [];
after(async () => {
  stopAllWorkers();
  for (const s of servers) await s.close();
});

async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `sync-${name}`, name, email: `${name.toLowerCase()}@people.test`, emailVerified: true }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

const inbox = (userId: string) => listThreads(userId, { box: "inbox" }).threads;

test("a mailbox connects, syncs, hears new mail at once, and carries changes back", async () => {
  const srv = await startMailServer();
  servers.push(srv);
  const me = person("Sam");
  const ws = createWorkspace(me, "Sam's office").id;
  setPrefs(me, { ws });
  srv.deliver({
    from: "Ann Example <ann@example.com>",
    subject: "Quarterly plan",
    messageId: "plan-1@example.com",
    text: "Here is the plan. https://example.com/plan",
    html: '<p>Here is the <b>plan</b>.</p><img src="https://tracker.example/open.gif"><script>alert(1)</script>',
    attachment: { name: "plan.txt", type: "text/plain", content: "the attached plan" },
  });

  // Wrong password: nothing is stored.
  await assert.rejects(
    connectAccount(me, { preset: "custom", email: "testuser@example.com", password: "nope", imap: { host: "127.0.0.1", port: srv.imapPort, security: "none" }, smtp: { host: "127.0.0.1", port: srv.smtpPort, security: "none" } }),
    (e: unknown) => (e as { code?: string }).code === "imap:auth"
  );
  const acct = await connectAccount(me, { preset: "custom", email: "testuser@example.com", name: "Sam", password: "testpass", imap: { host: "127.0.0.1", port: srv.imapPort, security: "none" }, smtp: { host: "127.0.0.1", port: srv.smtpPort, security: "none" } });
  assert.ok(!JSON.stringify(sql("SELECT * FROM mail_accounts WHERE id = ?").get(acct.id)).includes("testpass"), "the password is stored sealed");
  const first = await until(() => inbox(me).find((t) => t.subject === "Quarterly plan"), "the first sync");
  assert.equal(first.attachment, true);
  assert.equal(first.unread, true);

  // New mail while the worker IDLEs: here within moments, in the same conversation.
  createView(me, { name: "From Ann", filter: { box: "inbox", from: "ann@" }, notify: true });
  srv.deliver({ from: "Ann Example <ann@example.com>", subject: "Re: Quarterly plan", messageId: "plan-2@example.com", inReplyTo: "plan-1@example.com", references: ["plan-1@example.com"], text: "One more thing." });
  await until(() => threadOf(me, first.id)?.messages.length === 2, "IDLE brought the reply into the conversation");
  await until(() => sql("SELECT 1 FROM eco_inbox WHERE user_id = ? AND kind = 'mail' AND ref = ?").get(me, `mail:${first.id}`), "a notification for a view with notifications on");

  // The body: sanitized, remote images held back; the attachment comes from the server.
  const t = threadOf(me, first.id)!;
  const m1 = t.messages[0];
  const body = await renderBody(me, m1.id, {});
  assert.ok(body && body.html.includes("<b>plan</b>") && !body.html.includes("<script") && !body.html.includes("tracker.example"));
  assert.equal(body?.blocked, 1);
  const shown = await renderBody(me, m1.id, { images: true });
  assert.ok(shown?.html.includes("/api/mail/img?u=https%3A%2F%2Ftracker.example%2Fopen.gif&amp;s="), "allowed images come through the proxy");
  // A message that is not a draft never opens as one (its remote pictures would load in the composer).
  assert.equal(await draftFromMessage(me, m1.id), null);
  const att = await attachmentContent(me, m1.attachments[0].id);
  assert.equal(att?.content.toString(), "the attached plan");
  assert.equal(await attachmentContent(person("Mallory"), m1.attachments[0].id), null, "another person cannot download it");

  // Read, star, archive: here at once, then on the server.
  applyAction(me, { threads: [first.id] }, "read");
  applyAction(me, { threads: [first.id] }, "star");
  assert.equal(inbox(me).find((x) => x.id === first.id)?.unread, false);
  await until(() => srv.list("INBOX")?.every((x) => x.flags.includes("\\Seen")), "\\Seen on the server");
  await until(() => srv.list("INBOX")?.some((x) => x.flags.includes("\\Flagged")), "\\Flagged on the server");
  applyAction(me, { threads: [first.id] }, "archive");
  assert.ok(!inbox(me).some((x) => x.id === first.id), "archived: out of the inbox at once");
  assert.ok(listThreads(me, { box: "archive" }).threads.some((x) => x.id === first.id));
  await until(() => srv.list("Archive")?.length === 2 && srv.list("INBOX")?.length === 0, "moved to Archive on the server");
  await until(() => !sql("SELECT 1 FROM mail_messages WHERE thread_id = ? AND uid < 0", ).get(first.id), "the local copies got their new UIDs");

  // Send a reply: no undo delay → leaves now; the SMTP server files it into INBOX; a copy lands in Sent.
  setPrefs(me, { undoSeconds: 0 });
  const reply = cleanDraft({ accountId: acct.id, to: [{ name: "Ann", address: "ann@example.com" }], subject: "Re: Quarterly plan", html: `<p>Thanks! See <a href="http://localhost:3100/docs?ws=${ws}#plan-abcdef0123456789abcdef0123456789">the doc</a></p>`, mode: "reply", replyTo: t.messages[1].id, threadId: first.id }, "draft-reply-1");
  await queueSend(me, "Sam", { draft: reply, ws });
  await sendDue();
  await until(() => srv.list("INBOX")?.some((x) => x.subject === "Re: Quarterly plan"), "the reply went through SMTP");
  await until(() => srv.list("Sent")?.some((x) => x.subject === "Re: Quarterly plan"), "a copy was filed in Sent");
  assert.equal(threadOf(me, first.id)?.messages.length, 3, "the reply shows in the conversation at once");
  assert.ok(sql("SELECT 1 FROM eco_links WHERE ws_id = ? AND src = ? AND dst = 'note:abcdef0123456789abcdef0123456789'").get(ws, `mail:${first.id}`), "the Docs link in the reply is a link of the conversation");
  assert.equal(outboxOf(me).length, 0);

  // Undo send: the message never leaves, the draft comes back.
  setPrefs(me, { undoSeconds: 10 });
  const before = srv.list("INBOX")?.length;
  const queued = await queueSend(me, "Sam", { draft: cleanDraft({ accountId: acct.id, to: ["bob@example.com"], subject: "Oops", html: "<p>wrong</p>", mode: "new" }, "draft-oops-1") });
  assert.ok(queued.sendAt > Date.now() + 8000);
  assert.equal(cancelSend(me, queued.id)?.subject, "Oops");
  await sendDue(Date.now() + 60_000);
  assert.equal(srv.list("INBOX")?.length, before, "nothing was sent");
  assert.ok(sql("SELECT 1 FROM mail_drafts WHERE id = 'draft-oops-1' AND user_id = ?").get(me), "the draft is back");

  // Drafts reach the server's Drafts folder.
  saveDraft(me, "draft-oops-1", { accountId: acct.id, to: ["bob@example.com"], subject: "Oops v2", html: "<p>better</p>", mode: "new" });
  sql("UPDATE mail_ops SET next_at = 0 WHERE kind = 'draft-save'").run();
  await workerOf(acct.id)?.drainOps();
  await until(() => srv.list("Drafts")?.some((x) => x.subject === "Oops v2" && x.flags.includes("\\Draft")), "the draft in Drafts");

  // Snooze: gone from the inbox until its time, then back on top, unread.
  // The test server files what it is sent into INBOX: the reply comes back into the conversation, in the inbox.
  const newest = await until(() => inbox(me).find((x) => x.id === first.id), "the reply sync");
  applyAction(me, { threads: [newest.id] }, "read");
  applyAction(me, { threads: [newest.id] }, "snooze", { until: Date.now() + 1000 });
  assert.ok(!inbox(me).some((x) => x.id === newest.id));
  assert.ok(listThreads(me, { box: "any", snoozed: true }).threads.some((x) => x.id === newest.id));
  wakeSnoozed(Date.now() + 2000);
  const back = inbox(me).find((x) => x.id === newest.id);
  assert.ok(back?.unread, "back in the inbox, unread");

  // Save to Docs and turn into an issue: written with the person's access, inert, linked.
  const saved = await saveThreadToDocs({ userId: me, wsId: ws, locale: "en", name: "Sam" }, first.id, null);
  const note = JSON.parse((sql("SELECT json FROM notes WHERE ws = ? AND id = ?").get(ws, saved.noteId) as { json: string }).json) as { title: string; space?: string; content: unknown[] };
  assert.equal(note.title, "Quarterly plan");
  assert.equal(note.space, `private:${me}`, "saved among the person's private pages");
  assert.ok(JSON.stringify(note.content).includes("Here is the plan"));
  assert.ok(sql("SELECT 1 FROM eco_links WHERE ws_id = ? AND src = ? AND dst = ? AND via = 'converted'").get(ws, `mail:${first.id}`, `note:${saved.noteId}`));
  const card = await issueFromThread({ userId: me, wsId: ws, locale: "en" }, { thread: first.id });
  assert.equal(card.kind, "issue");
  const issueId = card.key.slice(6);
  const desc = (sql("SELECT description FROM pj_issues WHERE id = ?").get(issueId) as { description: string }).description;
  assert.ok(desc.includes(`/mail/thread/${first.id}`) && !desc.includes("https://example.com/plan"), "the quote is inert (its link is escaped)");
  assert.ok(sql("SELECT 1 FROM eco_links WHERE ws_id = ? AND src = ? AND dst = ? AND via = 'converted'").get(ws, `mail:${first.id}`, `issue:${issueId}`));
  await assert.rejects(saveThreadToDocs({ userId: person("Eve"), wsId: ws, locale: "en", name: "Eve" }, first.id, null), "another person cannot save someone's mail");

  // Disconnect: the worker stops, the mail and the password go; the server keeps its mail.
  assert.ok(removeAccount(me, acct.id));
  assert.equal(ownAccount(me, acct.id), null);
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?").get(acct.id) as { n: number }).n), 0);
  assert.equal(workerOf(acct.id), null);
  assert.ok((srv.list("Archive")?.length ?? 0) >= 2);
});

test("Gmail is synced through All Mail with labels; archiving removes \\Inbox", async () => {
  const srv = await startMailServer({ gmail: true });
  servers.push(srv);
  const me = person("Gail");
  srv.deliver({ from: "Hal <hal@example.com>", subject: "Gmail hello", messageId: "g-1@example.com", text: "hi" });
  srv.deliver({ from: "Hal <hal@example.com>", subject: "Already archived", messageId: "g-2@example.com", text: "old" }, undefined, { "X-GM-LABELS": ["Receipts"] });
  const acct = await connectAccount(me, { preset: "custom", email: "testuser@example.com", password: "testpass", imap: { host: "127.0.0.1", port: srv.imapPort, security: "none" }, smtp: { host: "127.0.0.1", port: srv.smtpPort, security: "none" } });
  assert.equal(ownAccount(me, acct.id)?.gmail, 1, "Gmail's extensions are recognized");
  const t = await until(() => inbox(me).find((x) => x.subject === "Gmail hello"), "the Gmail inbox");
  const archived = await until(() => listThreads(me, { box: "archive" }).threads.find((x) => x.subject === "Already archived"), "All Mail without \\Inbox is archived");
  assert.equal(archived.labels.length, 1, "Gmail labels are labels");
  applyAction(me, { threads: [t.id] }, "archive");
  await until(() => srv.list("[Gmail]/All Mail")?.find((x) => x.subject === "Gmail hello" && !x.labels.includes("\\Inbox")), "\\Inbox removed on the server");
  assert.equal(srv.list("[Gmail]/All Mail")?.length, 2, "nothing was copied or moved");
  removeAccount(me, acct.id);
});
