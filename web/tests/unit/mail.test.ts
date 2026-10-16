// zvena Mail, the parts that need no mail server: credentials at rest, the
// address guard, the HTML sanitizer, threading, view filters, the search
// language, and who may see what (accounts, conversations, the ecosystem's
// cards, search, pulse and Inbox) — and that a deleted account leaves no mail.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { seal, unseal } from "@/lib/mail-client/crypto";
import { checkEndpoint, MailGuardError, resolveEndpoint } from "@/lib/mail-client/guard";
import { sanitizeHtml, textToHtml, htmlToPlain } from "@/lib/mail-client/sanitize";
import { baseSubject, cleanMsgId, parseIdList, replyReferences, threadKeys } from "@/lib/mail-client/threading";
import { BOX, cleanFilter, compileFilter, ftsOwner, matches, parseSearch, type ViewFilter } from "@/lib/mail-client/views";
import { mailDb } from "@/lib/mail-client/schema";
import { listThreads, matchableOf, labelIdsOf, ownAccount, ownMessage, threadOf, upsertMessage, type IncomingMessage, type MessageRow } from "@/lib/mail-client/store";
import { applyAction } from "@/lib/mail-client/actions";
import { inertMarkdown } from "@/lib/mail-client/docs";
import { mailText } from "@/lib/mail-client/strings";
import { newId, sql } from "@/lib/store";
import { createWorkspace, acceptInvite, createInvite } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `mail-${name}`, name, email: `${name.toLowerCase()}@people.test`, emailVerified: true }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

/** An account row straight in the table (no server to check it against). */
function fakeAccount(userId: string, email: string): string {
  mailDb();
  const id = newId(12);
  sql(
    `INSERT INTO mail_accounts (id, user_id, email, name, provider, auth, username, secret, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, created_at)
     VALUES (?, ?, ?, '', 'custom', 'password', ?, ?, 'imap.example.com', 993, 'tls', 'smtp.example.com', 465, 'tls', ?)`
  ).run(id, userId, email, email, seal({ password: "secret-pw" }, { accountId: id, userId }), Date.now());
  sql("INSERT INTO mail_folders (account_id, path, name, role) VALUES (?, 'INBOX', 'INBOX', 'inbox'), (?, 'Archive', 'Archive', 'archive'), (?, 'Trash', 'Trash', 'trash')").run(id, id, id);
  return id;
}

let uid = 1;
function msg(accountId: string, m: Partial<IncomingMessage> & { msgid: string }): IncomingMessage {
  return {
    accountId,
    folder: "INBOX",
    uid: uid++,
    inReplyTo: "",
    references: [],
    subject: "Hello",
    from: { name: "Ann", address: "ann@example.com" },
    to: [{ name: "", address: "me@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    date: Date.now() - 60_000 * (1000 - uid),
    boxes: BOX.inbox,
    seen: false,
    flagged: false,
    answered: false,
    size: 1000,
    unsubscribe: "",
    attachments: [],
    labels: [],
    text: "Hi there",
    ...m,
  };
}

// --- Credentials -------------------------------------------------------------------

test("a sealed password opens only for its account and owner, and never once tampered with", () => {
  const ctx = { accountId: "acct-1234", userId: "user-1234" };
  const s = seal({ password: "app pass 123" }, ctx);
  assert.match(s, /^v1\.[A-Za-z0-9_-]+$/);
  assert.ok(!s.includes("app pass"), "nothing readable in the sealed value");
  assert.deepEqual(unseal(s, ctx), { password: "app pass 123" });
  assert.equal(unseal(s, { ...ctx, accountId: "acct-other" }), null, "copied into another account: does not open");
  assert.equal(unseal(s, { ...ctx, userId: "user-other" }), null, "another owner: does not open");
  const raw = Buffer.from(s.slice(3), "base64url");
  raw[raw.length - 1] ^= 1;
  assert.equal(unseal(`v1.${raw.toString("base64url")}`, ctx), null, "a flipped bit: does not open");
  assert.notEqual(seal({ password: "x" }, ctx), seal({ password: "x" }, ctx), "a fresh IV every time");
  const secret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "f".repeat(64);
  try {
    assert.equal(unseal(s, ctx), null, "another key: does not open");
  } finally {
    process.env.AUTH_SECRET = secret;
  }
});

// --- The address guard (SSRF) ------------------------------------------------------

test("mail servers must be public hosts on mail ports, with TLS (outside a test stand)", async () => {
  delete process.env.ZVENA_STAND;
  const bad = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof MailGuardError && e.code === code);
  bad(() => checkEndpoint("imap", "127.0.0.1", 993, "tls"), "blocked address");
  bad(() => checkEndpoint("imap", "10.1.2.3", 993, "tls"), "blocked address");
  bad(() => checkEndpoint("imap", "169.254.169.254", 993, "tls"), "blocked address");
  bad(() => checkEndpoint("imap", "[::1]", 993, "tls"), "bad host");
  bad(() => checkEndpoint("imap", "::ffff:127.0.0.1", 993, "tls"), "blocked address");
  bad(() => checkEndpoint("imap", "localhost", 993, "tls"), "blocked address");
  bad(() => checkEndpoint("smtp", "mail.internal", 465, "tls"), "blocked address");
  bad(() => checkEndpoint("imap", "imap.example.com", 22, "tls"), "bad port");
  bad(() => checkEndpoint("smtp", "smtp.example.com", 6379, "tls"), "bad port");
  bad(() => checkEndpoint("imap", "imap.example.com", 143, "none"), "insecure");
  bad(() => checkEndpoint("imap", "bad host!", 993, "tls"), "bad host");
  assert.deepEqual(checkEndpoint("imap", "IMAP.Gmail.com.", 993, "tls"), { host: "imap.gmail.com", port: 993, security: "tls" });
  await assert.rejects(resolveEndpoint("127.0.0.1"), (e: unknown) => e instanceof MailGuardError && e.code === "blocked address");
  await assert.rejects(resolveEndpoint("localhost"), (e: unknown) => e instanceof MailGuardError);
  process.env.ZVENA_STAND = "test";
  try {
    assert.equal(checkEndpoint("imap", "127.0.0.1", 3963, "none").port, 3963, "a test stand may use its local test server");
    assert.equal((await resolveEndpoint("127.0.0.1")).address, "127.0.0.1");
  } finally {
    delete process.env.ZVENA_STAND;
  }
});

// --- The sanitizer -----------------------------------------------------------------

test("received HTML loses scripts, handlers, forms, frames and dangerous links", () => {
  const dirty = `<html><head><title>x</title><script>alert(1)</script><style>p{color:red} @import url(https://evil/x.css); .b{background:url(https://track/p.gif)}</style></head>
  <body onload="steal()"><p onclick="x()" style="color:blue;background:url('https://track/bg.png')">Hi <b>there</b></p>
  <a href="javascript:alert(1)">bad</a> <a href="java&#x09;script:alert(1)">bad2</a> <a href="https://ok.example/path?a=1&b=2">good</a>
  <img src="https://track.example/pixel.gif" width=1 height=1><img src="cid:logo@x"><img src="data:image/png;base64,iVBORw0KGgo=">
  <form action="https://evil/"><input name="pw"><button>Go</button></form><iframe src="https://evil/"></iframe>
  <svg><script>alert(2)</script></svg><object data="x"></object><base href="https://evil/"><meta http-equiv="refresh" content="0;url=https://evil/">
  <div style="width: expression(alert(1))">x</div><table background="https://track/t.gif"><tr><td>cell</td></tr></table><noscript>ns</noscript></body></html>`;
  const out = sanitizeHtml(dirty, { images: false, cid: (c) => (c === "logo@x" ? "/api/mail/att/abc123?inline=1" : null) });
  const h = out.html;
  for (const bad of ["<script", "alert(1)", "onload", "onclick", "javascript:", "<form", "<input", "<iframe", "<svg", "<object", "<base", "<meta", "expression(", "@import", "track.example", "track/", "https://evil"]) assert.ok(!h.includes(bad), `no ${bad} in ${h}`);
  assert.ok(h.includes('<a href="https://ok.example/path?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">good</a>'));
  assert.ok(h.includes('src="/api/mail/att/abc123?inline=1"'), "inline parts come from the message itself");
  assert.ok(h.includes("data:image/png;base64,"), "embedded images stay");
  assert.ok(h.includes("<style>p{color:red}"), "the message's own styles stay");
  assert.ok(h.includes("<b>there</b>") && h.includes("<td>cell</td>"));
  assert.equal(out.remote, 4, "the pixel, two CSS backgrounds and the table background were held back");
  const shown = sanitizeHtml('<img src="https://cdn.example/a.png"><p style="background:url(https://cdn.example/b.png)">x</p>', { images: true, proxy: (u) => `/api/mail/img?u=${encodeURIComponent(u)}` });
  assert.ok(shown.html.includes('src="/api/mail/img?u=https%3A%2F%2Fcdn.example%2Fa.png"'), "allowed images go through the proxy");
  assert.ok(shown.html.includes("url(&quot;/api/mail/img?u=https%3A%2F%2Fcdn.example%2Fb.png&quot;)"));
  assert.ok(!shown.html.includes('"https://cdn.example'), "never the sender's own address");
  // CSS escapes and image-set() are no way around it.
  const sneaky = sanitizeHtml(`<p style="background:u\\72l(https://t.example/x)">a</p><p style="background-image:image-set('https://t.example/y' 1x)">b</p>`, { images: false });
  assert.ok(!sneaky.html.includes("t.example"), sneaky.html);
  assert.ok(!sanitizeHtml("<p>a<script>b", { images: false }).html.includes("b"), "an unclosed script swallows nothing into the output");
});

test("CSS cannot name a resource the sanitizer did not check, and links to zvena only open pages", () => {
  // A quoted url() holding ")" or the other quote: read to its real end, rewritten (dropped here).
  for (const css of [`background:url("/new?kind=table&x=)")`, `background:url('/new?a="b")')`, `background:url( "https://t.example/x)" )`, `background:url(/new?x=1`, `background:image("/new")`, `cursor:src("/x")`]) {
    const h = sanitizeHtml(`<div style='${css}'>x</div><style>.a{${css}}</style>`, { images: true, proxy: () => null }).html;
    assert.ok(!h.includes("/new") && !h.includes("t.example") && !/\bsrc\(|image\(/.test(h), `${css} → ${h}`);
  }
  const ok = sanitizeHtml(`<p style="background:url('https://cdn.example/a(1).png')">x</p>`, { images: true, proxy: (u) => `/api/mail/img?u=${encodeURIComponent(u)}` }).html;
  assert.ok(ok.includes('url(&quot;/api/mail/img?u=https%3A%2F%2Fcdn.example%2Fa%281%29.png&quot;)'), ok);
  const own = "https://zvena.example.com";
  const links = sanitizeHtml('<a href="https://zvena.example.com/new?kind=design">a</a><a href="https://zvena.example.com/docs?ws=x#p-1">b</a><a href="https://zvena.example.com/api/mail/boot?ws=x">c</a><a href="https://elsewhere.example/new">d</a>', { images: false, ownOrigin: own }).html;
  assert.ok(!links.includes("zvena.example.com/new") && !links.includes("/api/mail"), "zvena addresses that act on a visit are not links");
  assert.ok(links.includes('href="https://zvena.example.com/docs?ws=x#p-1"') && links.includes('href="https://elsewhere.example/new"'));
  assert.ok(!textToHtml("go https://zvena.example.com/new?kind=table now", own).includes("<a "), "plain text too");
});

test("plain text becomes safe HTML with links; HTML becomes readable text", () => {
  const h = textToHtml("Hi <b>Ann</b> & co\nsee https://example.com/a?b=1.\n> quoted line");
  assert.ok(h.includes("Hi &lt;b&gt;Ann&lt;/b&gt; &amp; co"));
  assert.ok(h.includes('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a?b=1</a>.'));
  assert.ok(h.includes('<blockquote class="zv-quote">quoted line<br></blockquote>'));
  assert.equal(htmlToPlain("<style>x{}</style><p>One</p><p>Two &amp; three</p>"), "One\n\nTwo & three");
});

// --- Threading ---------------------------------------------------------------------

test("Message-IDs and references are read leniently", () => {
  assert.equal(cleanMsgId(" <abc@x.com> "), "abc@x.com");
  assert.equal(cleanMsgId("abc@x.com"), "abc@x.com");
  assert.equal(cleanMsgId("<a b@x>"), "");
  assert.deepEqual(parseIdList("<a@x> <b@x>\r\n <a@x>"), ["a@x", "b@x"]);
  assert.deepEqual(parseIdList("a@x, b@x"), ["a@x", "b@x"]);
  assert.deepEqual(threadKeys({ msgid: "<c@x>", inReplyTo: "<b@x>", references: ["a@x", "b@x", "c@x"], gmThread: "123" }), { own: ["c@x", "gm:123"], refs: ["a@x", "b@x", "gm:123"] });
  assert.deepEqual(replyReferences({ msgid: "c@x", references: ["a@x", "b@x"] }), ["a@x", "b@x", "c@x"]);
  assert.equal(baseSubject("Re: RE: Fwd: AW: [2] Re[3]: Plans"), "[2] Re[3]: Plans");
  assert.equal(baseSubject("Re: Fwd: Plans"), "Plans");
});

test("conversations are joined by what messages name, in any order, and merged when one bridges two", () => {
  const me = person("Thea");
  const acct = fakeAccount(me, "thea@example.com");
  // A reply arrives before the message it answers; then its sibling; then the parent.
  const reply = upsertMessage(me, msg(acct, { msgid: "b@x", inReplyTo: "a@x", references: ["a@x"], subject: "Re: Plan" }));
  const sibling = upsertMessage(me, msg(acct, { msgid: "c@x", inReplyTo: "a@x", references: ["a@x"], subject: "Re: Plan" }));
  const parent = upsertMessage(me, msg(acct, { msgid: "a@x", subject: "Plan" }));
  assert.equal(sibling.threadId, reply.threadId, "two replies to one (missing) message are one conversation");
  assert.equal(parent.threadId, reply.threadId, "the parent joins its replies");
  // Same subject, nothing in common: two conversations (no guessing by subject).
  const other = upsertMessage(me, msg(acct, { msgid: "z@x", subject: "Plan" }));
  assert.notEqual(other.threadId, reply.threadId);
  // A message from outside naming unrelated conversations (References are the sender's to write) sews nothing together.
  const crafted = upsertMessage(me, msg(acct, { msgid: "evil@x", references: ["a@x", "z@x"], subject: "Totally unrelated" }));
  assert.ok(crafted.threadId !== reply.threadId && crafted.threadId !== other.threadId, "a crafted References header joins nothing");
  assert.notEqual(threadOf(me, reply.threadId)?.id, threadOf(me, other.threadId)?.id);
  // A direct answer joins its conversation even under another subject.
  const renamed = upsertMessage(me, msg(acct, { msgid: "d@x", inReplyTo: "a@x", references: ["a@x"], subject: "New subject, same talk" }));
  assert.equal(renamed.threadId, reply.threadId);
  // Two separate conversations about the same thing, then a message that answers both: one.
  const p = upsertMessage(me, msg(acct, { msgid: "p@x", subject: "Plan B" }));
  const q = upsertMessage(me, msg(acct, { msgid: "q@x", subject: "plan b" }));
  const ws = createWorkspace(me, "Thea").id;
  sql("INSERT INTO eco_links (ws_id, src, part, dst, via, created_by, created_at) VALUES (?, ?, '', 'note:abcdef', 'converted', ?, 1)").run(ws, `mail:${q.threadId}`, me);
  const bridge = upsertMessage(me, msg(acct, { msgid: "r@x", references: ["p@x", "q@x"], subject: "Re: Plan B" }));
  assert.equal(bridge.threadId, p.threadId);
  assert.equal(threadOf(me, q.threadId), null, "the merged conversation is gone…");
  assert.equal(threadOf(me, p.threadId)?.messages.length, 3, "…its messages are in the other");
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM eco_links WHERE src = ?").get(`mail:${p.threadId}`) as { n: number }).n), 1, "its links moved along");
  // The same message seen again (another sync) is not a new one.
  assert.equal(upsertMessage(me, { ...msg(acct, { msgid: "a@x" }), uid: 999_001, folder: "Archive", boxes: 0 }).threadId, parent.threadId, "a copy in another folder joins too");
  assert.equal(threadOf(me, parent.threadId)?.messages.length, 4, "and the conversation shows it once");
});

// --- Views -------------------------------------------------------------------------

test("view filters mean the same in SQL and in memory", () => {
  const me = person("Vera");
  const acct = fakeAccount(me, "vera@example.com");
  const now = Date.now();
  const rows = [
    msg(acct, { msgid: "v1@x", subject: "Invoice 42", from: { name: "Billing", address: "billing@shop.com" }, attachments: [{ part: "2", filename: "i.pdf", type: "application/pdf", size: 10, inline: false }] }),
    msg(acct, { msgid: "v2@x", subject: "Lunch?", from: { name: "Bob", address: "bob@friends.org" }, seen: true, flagged: true }),
    msg(acct, { msgid: "v3@x", subject: "Weekly digest", from: { name: "News", address: "news@media.com" }, boxes: 0 }),
    msg(acct, { msgid: "v4@x", subject: "Spammy", boxes: BOX.spam }),
    msg(acct, { msgid: "v5@x", subject: "Report", from: { name: "Me", address: "vera@example.com" }, to: [{ name: "Boss", address: "boss@corp.com" }], boxes: BOX.sent, seen: true }),
    msg(acct, { msgid: "v6@x", subject: "Later", text: "the quarterly numbers" }),
  ];
  const ids = rows.map((r) => upsertMessage(me, r).id);
  // One snoozed.
  sql("UPDATE mail_messages SET snoozed_until = ? WHERE id = ?").run(now + 3600_000, ids[5]);
  const filters: ViewFilter[] = [
    { box: "inbox" },
    { box: "inbox", unread: true },
    { box: "any", starred: true },
    { box: "archive" },
    { box: "spam" },
    { box: "sent" },
    { box: "any", snoozed: true },
    { box: "any", from: "shop.com" },
    { box: "any", to: "boss@" },
    { box: "inbox", subject: "invoice" },
    { box: "any", attachment: true },
    { box: "any", text: "quarterly" },
    { box: "any", text: "lunch" },
  ];
  const all = ids.map((id) => ownMessage(me, id) as MessageRow);
  const labels = labelIdsOf(all.map((r) => Number(r.n)));
  for (const f of filters) {
    const inSql = new Set(listThreads(me, f, { now }).threads.map((t) => t.subject));
    const inJs = new Set(all.filter((r) => matches(matchableOf(r, labels.get(Number(r.n)) ?? []), f, now)).map((r) => r.subject.replace(/^Re: /, "")));
    assert.deepEqual([...inSql].sort(), [...inJs].sort(), JSON.stringify(f));
  }
  assert.deepEqual(listThreads(me, { box: "inbox" }, { now }).threads.map((t) => t.subject).sort(), ["Invoice 42", "Lunch?"].sort(), "snoozed and archived mail is not in the inbox; spam never is");
  assert.deepEqual(cleanFilter({ box: "nope", from: 5, labels: ["ok-label-1", "<bad>"], unread: "yes", after: -3 }), { labels: ["ok-label-1"] }, "unknown and bad values are dropped");
  const { where, params } = compileFilter({ from: "a%'_\\b" });
  assert.ok(!where.includes("a%'"), "values are parameters, never SQL");
  assert.ok(params.includes("%a\\%'\\_\\\\b%"));
});

test("the search box reads operators, quoted values and plain words", () => {
  const p = parseSearch('from:anna "board meeting" has:attachment is:unread in:archive label:"Q3 plans" before:2026-10-01 subject:budget hello');
  assert.equal(p.filter.from, "anna");
  assert.equal(p.filter.attachment, true);
  assert.equal(p.filter.unread, true);
  assert.equal(p.filter.box, "archive");
  assert.equal(p.filter.subject, "budget");
  assert.equal(p.filter.before, Date.UTC(2026, 9, 1));
  assert.deepEqual(p.labelNames, ["Q3 plans"]);
  assert.equal(p.filter.text, "board meeting hello");
  assert.equal(parseSearch("hello").filter.box, "any", "search looks everywhere but spam and trash");
});

// --- Who sees what -----------------------------------------------------------------

test("mail is its owner's only: accounts, conversations, actions, cards, search, pulse", async () => {
  const owner = person("Olga");
  const other = person("Otto");
  const ws = createWorkspace(owner, "Shared office").id;
  acceptInvite(other, createInvite(owner, ws, "editor").token);
  const acct = fakeAccount(owner, "olga@example.com");
  const m = upsertMessage(owner, msg(acct, { msgid: "secret@x", subject: "Salary zanzibar", text: "very private zanzibar" }));
  assert.ok(ownAccount(owner, acct));
  assert.equal(ownAccount(other, acct), null, "another person's account is not found");
  assert.equal(ownMessage(other, m.id), null);
  assert.equal(threadOf(other, m.threadId), null);
  assert.equal(applyAction(other, { threads: [m.threadId], messages: [m.id] }, "trash"), 0, "nor can they act on it");
  // A bulk move gives every message its own local UID (no clash in the folder).
  const many = Array.from({ length: 80 }, (_, i) => upsertMessage(owner, msg(acct, { msgid: `bulk-${i}@x`, subject: `Bulk ${i}` })).threadId);
  assert.equal(applyAction(owner, { threads: many }, "archive"), 80);
  assert.equal(listThreads(owner, { box: "archive" }).threads.filter((t) => t.subject.startsWith("Bulk")).length, 50, "all archived (a page of 50 listed)");
  assert.equal(ownMessage(owner, m.id)?.boxes, BOX.inbox, "it stays where it was");
  const { cardsFor } = await import("@/lib/eco/cards");
  const { searchAll } = await import("@/lib/eco/search");
  const { keyVisible, registerEcoFilters } = await import("@/lib/eco/visibility");
  const { visibleTo } = await import("@/lib/pulse/bus");
  const v = (userId: string) => ({ userId, wsId: ws, locale: "en" as const });
  assert.equal((await cardsFor(v(owner), [`mail:${m.threadId}`])).length, 1, "its owner gets its card");
  assert.equal((await cardsFor(v(other), [`mail:${m.threadId}`])).length, 0, "nobody else does, in a shared workspace too");
  assert.ok((await searchAll(v(owner), "zanzibar")).hits.some((h) => h.key === `mail:${m.threadId}`), "zvena's search finds one's own mail");
  assert.ok(!(await searchAll(v(other), "zanzibar")).hits.some((h) => h.kind === "mail"), "and never anyone else's");
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM eco_search WHERE body LIKE '%zanzibar%' OR title LIKE '%zanzibar%'").get() as { n: number }).n), 0, "mail is never in the shared index");
  assert.equal(keyVisible(owner, ws, `mail:${m.threadId}`), true);
  assert.equal(keyVisible(other, ws, `mail:${m.threadId}`), false);
  registerEcoFilters();
  const poke = { id: 1, ws, type: "mail" as const, ref: owner, at: Date.now(), data: { account: acct } };
  assert.equal(visibleTo(owner, poke), true, "the live poke reaches its owner");
  assert.equal(visibleTo(other, poke), false, "and nobody else");
  const { restricted } = await import("@/lib/eco/visibility");
  assert.equal(restricted(ws, `mail:${m.threadId}`), true, "a mail key travels in a poke of its own");
  // Notifications: kind "mail", about the conversation, to its owner.
  const { notify, inboxOf } = await import("@/lib/eco/inbox");
  notify(owner, { ws, kind: "mail", ref: `mail:${m.threadId}`, by: null, text: "Ann: Salary" });
  notify(other, { ws, kind: "mail", ref: `mail:${m.threadId}`, by: null, text: "Ann: Salary" });
  assert.equal((await inboxOf(v(owner))).items.filter((i) => i.kind === "mail").length, 1);
  assert.equal((await inboxOf(v(other))).items.filter((i) => i.kind === "mail").length, 0, "a notification about someone else's mail shows nothing");
});

test("a deleted account takes its mailboxes, credentials, mail and the ecosystem's traces of it", async () => {
  const gone = person("Gil");
  const ws = createWorkspace(gone, "Gil's").id;
  const acct = fakeAccount(gone, "gil@example.com");
  const m = upsertMessage(gone, msg(acct, { msgid: "gil@x", subject: "Bye", text: "goodbye body" }));
  sql("INSERT INTO eco_links (ws_id, src, part, dst, via, created_by, created_at) VALUES (?, ?, '', 'note:abcdefgh', 'converted', ?, 1)").run(ws, `mail:${m.threadId}`, gone);
  sql("INSERT INTO mail_views (id, user_id, name, filter, created_at) VALUES ('view-gil-1', ?, 'V', '{}', 1)").run(gone);
  const { deleteAccount } = await import("@/lib/account");
  await deleteAccount(gone);
  for (const t of ["mail_accounts", "mail_messages", "mail_views", "mail_contacts", "mail_labels"]) assert.equal(Number((sql(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(gone) as { n: number }).n), 0, t);
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM mail_folders WHERE account_id = ?").get(acct) as { n: number }).n), 0, "folders");
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM mail_fts WHERE mail_fts MATCH 'goodbye'").get() as { n: number }).n), 0, "the full-text index");
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM eco_links WHERE src = ?").get(`mail:${m.threadId}`) as { n: number }).n), 0, "links from the mail");
});

test("text copied out of a mail stays inert in Markdown", () => {
  const s = inertMarkdown("[click](https://evil) @everyone <b>hi</b> ![x](y) # head");
  assert.ok(!/(^|[^\\])\[/.test(s) && !/(^|[^\\])</.test(s), s);
  assert.equal(mailText("ru", "compose.send"), "Отправить");
  assert.equal(mailText("xx", "compose.send"), "Send");
  assert.equal(mailText("en", "toast.scheduled", { when: "tomorrow" }), "Scheduled for tomorrow");
});

test("search matches only the searcher's own mail, inside the index (never everyone's mail filtered afterwards)", () => {
  const a = person("Searcher-A");
  const b = person("Searcher-B");
  upsertMessage(a, msg(fakeAccount(a, "a@search.example"), { msgid: "s1@x", subject: "Pelican budget" }));
  upsertMessage(b, msg(fakeAccount(b, "b@search.example"), { msgid: "s2@x", subject: "Pelican budget" }));
  const mine = listThreads(a, { box: "any", text: "pelican" }).threads;
  assert.equal(mine.length, 1);
  // The index itself answers per owner: B's row never comes out of a match for A.
  const rows = sql(`SELECT rowid FROM mail_fts WHERE mail_fts MATCH ?`).all(`owner : "${ftsOwner(a)}" AND {subject people body} : ("pelican"*)`) as { rowid: number }[];
  assert.equal(rows.length, 1);
  // A word that happens to be a prefix of an owner token finds nothing through the owner column.
  assert.equal(listThreads(a, { box: "any", text: ftsOwner(a).slice(0, 4) }).threads.length, 0);
});
