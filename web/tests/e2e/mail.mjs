// zvena Mail, end to end, against the local test mailbox (tests/mail-server.cjs
// on the host: IMAP 3963, SMTP 3964, control http://127.0.0.1:3965):
//   connect it through the dialog; mail arrives; read a conversation (its
//   body in a sandboxed frame, remote images held back); reply (R, ⌘Enter);
//   archive (E); snooze (H); a view of one's own; search (/); ⌘K; Save to
//   Docs (a private page linked back); the phone layout; no foreign hosts.
//
//   node tests/mail-server.cjs &   (before; the stand runs with ZVENA_STAND=test)
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const CTL = process.env.MAIL_CTL || "http://127.0.0.1:3965";
const IMAP_PORT = Number(process.env.MAIL_IMAP_PORT || 3963);
const SMTP_PORT = Number(process.env.MAIL_SMTP_PORT || 3964);
const RUN = Math.random().toString(36).slice(2, 7);
const deliver = (m) => fetch(`${CTL}/deliver`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) }).then((r) => r.json());
const mailbox = (path) => fetch(`${CTL}/mailbox?path=${encodeURIComponent(path)}`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(250);
  }
}

const browser = await launch();
const ctx = await context(browser);
const post = (path, data) => ctx.request.post(`${BASE}${path}`, { data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));
const patch = (path, data) => ctx.request.patch(`${BASE}${path}`, { data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));

let page;
try {
  // Mail waiting in the mailbox before it is connected.
  await deliver({ from: "Ann Example <ann@example.com>", subject: `Roadmap ${RUN}`, messageId: `roadmap-${RUN}@example.com`, text: `The roadmap for ${RUN} is attached in spirit.`, html: `<p>The <b>roadmap</b> for ${RUN}.</p><img src="https://tracker.example/pixel.gif">` });
  await deliver({ from: "Bob Builder <bob@example.org>", subject: `Lunch ${RUN}`, messageId: `lunch-${RUN}@example.org`, text: "Lunch on Friday? zucchini" });
  await deliver({ from: "Cara News <news@example.net>", subject: `Digest ${RUN}`, messageId: `digest-${RUN}@example.net`, text: "This week in news." });

  page = await ctx.newPage();
  await devSignIn(page, `Mia Mail ${RUN}`);
  const ws = (await post("/api/ws", { name: `Mail desk ${RUN}` })).body.workspace.id;
  check("workspace made", Boolean(ws));
  await page.goto(`${BASE}/mail?ws=${ws}`);
  await page.waitForSelector(".zm-welcome", { timeout: 20000 });
  check("Mail is a section of the shared rail", (await page.locator('.zv-side a[aria-current="page"]', { hasText: "Mail" }).count()) === 1);

  // 1. Connect the test mailbox through the dialog (Other: IMAP / SMTP).
  await page.locator(".zm-provider", { hasText: "Other" }).first().click();
  await page.locator('.zm-dialog input[type="email"]').fill("testuser@example.com");
  await page.locator(".zm-dialog .zm-field", { hasText: "Your name" }).locator("input").fill("Mia");
  await page.locator('.zm-dialog input[type="password"]').fill("testpass");
  const servers = page.locator(".zm-dialog fieldset.zm-server");
  for (const [i, port] of [
    [0, IMAP_PORT],
    [1, SMTP_PORT],
  ]) {
    const f = servers.nth(i);
    await f.locator("select").selectOption("none");
    await f.locator(".zm-field", { hasText: "Server" }).locator("input").fill("127.0.0.1");
    await f.locator('input[type="number"]').fill(String(port));
  }
  await page.locator(".zm-dialog .zv-btn-primary", { hasText: "Connect" }).click();
  const connected = await page.waitForSelector(`.zm-row >> text=Roadmap ${RUN}`, { timeout: 25000 }).then(() => true).catch(() => false);
  check("connected; the inbox fills from the mailbox", connected);
  check("all three conversations are listed", (await page.locator(".zm-row").count()) >= 3);
  await patch("/api/mail/prefs", { undoSeconds: 0 });

  // 2. New mail while open arrives on its own (IDLE → pulse).
  await deliver({ from: "Ann Example <ann@example.com>", subject: `Re: Roadmap ${RUN}`, messageId: `roadmap-2-${RUN}@example.com`, inReplyTo: `roadmap-${RUN}@example.com`, references: [`roadmap-${RUN}@example.com`], text: "And one more note." });
  const live = await page.locator(".zm-row[data-unread]", { hasText: `Roadmap ${RUN}` }).locator(".zm-row-count").waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  check("a reply joins its conversation live (2 messages, unread)", live);

  // 3. Read the conversation.
  await page.locator(".zm-row", { hasText: `Roadmap ${RUN}` }).first().click();
  await page.waitForSelector(".zm-thread-subject", { timeout: 10000 });
  check("the reading pane shows the subject", (await page.locator(".zm-thread-subject").innerText()).includes(`Roadmap ${RUN}`));
  const frames = page.locator("iframe.zm-frame");
  await frames.first().waitFor({ timeout: 10000 });
  const sandbox = await frames.first().getAttribute("sandbox");
  check("bodies render in a sandboxed frame without scripts", sandbox !== null && !sandbox.includes("allow-scripts"), sandbox ?? "");
  const firstBody = page.frameLocator("iframe.zm-frame").first();
  const bodyText = await firstBody.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  check("the message body is shown", bodyText.includes(`roadmap`) || bodyText.includes("Roadmap") || bodyText.includes(RUN), bodyText.slice(0, 80));
  const held = await page.waitForSelector(".zm-images-bar", { timeout: 8000 }).then(() => true).catch(() => false);
  check("remote images are held back with a 'Show images' bar", held);
  check("the tracker was never requested", ![...ctx.hosts].some((h) => h.includes("tracker.example")));

  // 4. Reply with R and ⌘Enter.
  await page.keyboard.press("Escape");
  await page.locator(".zm-row", { hasText: `Roadmap ${RUN}` }).first().click();
  await page.waitForSelector(".zm-thread-subject");
  await page.locator(".zm-thread-subject").click();
  await page.keyboard.press("r");
  await page.waitForSelector(".zm-compose-inline .bn-editor", { timeout: 15000 });
  await page.locator(".zm-compose-inline .bn-editor").click();
  await page.keyboard.type(`Thanks Ann, sounds good ${RUN}`);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  const sent = await until(async () => (await mailbox("INBOX")).some((m) => m.subject === `Re: Roadmap ${RUN}` && m.flags.length === 0) && (await mailbox("Sent")).some((m) => m.subject === `Re: Roadmap ${RUN}`));
  check("the reply went out over SMTP and was filed in Sent", Boolean(sent));
  await page.waitForTimeout(1500);
  check("the reply shows in the conversation", (await page.locator(".zm-msg, .zm-msg-folded").count()) >= 3);

  // 5. Archive with E: out of the inbox here and on the server.
  await page.locator(".zm-thread-subject").click();
  await page.keyboard.press("e");
  await page.waitForTimeout(800);
  await page.goto(`${BASE}/mail?ws=${ws}`);
  await page.waitForSelector(`.zm-row >> text=Lunch ${RUN}`, { timeout: 15000 });
  check("archived: no longer in the inbox", (await page.locator(".zm-row", { hasText: `Roadmap ${RUN}` }).count()) === 0);
  const archived = await until(async () => (await mailbox("Archive")).some((m) => m.subject === `Roadmap ${RUN}`));
  check("archived on the server (moved to Archive)", Boolean(archived));

  // 6. Snooze with H → Tomorrow.
  await page.locator(".zm-row", { hasText: `Digest ${RUN}` }).first().hover();
  await page.keyboard.press("h");
  await page.locator(".zm-pop .zm-menu-item", { hasText: "Tomorrow" }).first().click();
  await page.waitForTimeout(600);
  check("snoozed: gone from the inbox", (await page.locator(".zm-row", { hasText: `Digest ${RUN}` }).count()) === 0);
  await page.goto(`${BASE}/mail/view/snoozed?ws=${ws}`);
  check("…and listed under Snoozed", await page.waitForSelector(`.zm-row >> text=Digest ${RUN}`, { timeout: 10000 }).then(() => true).catch(() => false));

  // 7. A view of one's own (Notion Mail's views as tabs).
  await page.goto(`${BASE}/mail?ws=${ws}`);
  await page.waitForSelector(".zm-tab-add");
  await page.locator(".zm-tab-add").click();
  await page.locator(".zm-dialog .zm-field", { hasText: "Name" }).locator("input").fill(`Bob ${RUN}`);
  await page.locator(".zm-dialog .zm-field", { hasText: /^From/ }).locator("input").fill("bob@");
  await page.locator(".zm-dialog .zv-btn-primary", { hasText: "Create view" }).click();
  await page.waitForSelector(`.zm-tab[aria-current="page"] >> text=Bob ${RUN}`, { timeout: 10000 });
  await page.waitForTimeout(800);
  const inView = await page.locator(".zm-row").allInnerTexts();
  check("the view shows only what matches", inView.length >= 1 && inView.every((t) => t.includes("Bob") || t.includes("Lunch")), inView.join(" | ").slice(0, 200));

  // 8. Search with / (full text over bodies).
  await page.keyboard.press("/");
  await page.keyboard.type("zucchini");
  await page.keyboard.press("Enter");
  check("search finds a word in a body", await page.waitForSelector(`.zm-row >> text=Lunch ${RUN}`, { timeout: 10000 }).then(() => true).catch(() => false));

  // 9. ⌘K, the command menu.
  await page.keyboard.press("Control+k");
  check("⌘K opens Mail's command menu", await page.waitForSelector(".zm-cmd .zm-menu-search", { timeout: 5000 }).then(() => true).catch(() => false));
  await page.keyboard.press("Escape");

  // 10. Save to Docs: a private page, linked back from the conversation.
  await page.goto(`${BASE}/mail?ws=${ws}`);
  await page.locator(".zm-row", { hasText: `Lunch ${RUN}` }).first().click();
  await page.waitForSelector(".zm-thread-subject");
  await page.locator('.zm-reader-bar button[aria-label="Save to Docs"]').click();
  await page.locator(".zm-dialog .zv-btn-primary", { hasText: "Save" }).click();
  check("saved to Docs", await page.waitForSelector(".ds-toast >> text=Saved to Docs", { timeout: 10000 }).then(() => true).catch(() => false));
  const thread = new URL(page.url()).searchParams.get("t");
  const rel = (await (await ctx.request.get(`${BASE}/api/eco/related?ws=${ws}&ref=mail:${thread}`)).json()).items ?? [];
  const doc = rel.find((i) => i.card.kind === "note");
  check("the page is linked to the conversation (Related)", doc?.card.title === `Lunch ${RUN}`, JSON.stringify(rel).slice(0, 200));

  // 11. A phone: the list, then the conversation full screen, then back.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${BASE}/mail?ws=${ws}`);
  await page.waitForSelector(`.zm-row >> text=Lunch ${RUN}`);
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("phone: no sideways scrolling", noScroll);
  await page.locator(".zm-row", { hasText: `Lunch ${RUN}` }).first().click();
  await page.waitForSelector(".zm-thread-subject");
  check("phone: the conversation takes the screen", !(await page.locator(".zm-list").isVisible()));
  await page.locator(".zm-reader-bar .zm-back").click();
  check("phone: back to the list", await page.locator(".zm-list").isVisible());

  check("no foreign hosts", foreignHosts(ctx).length === 0, foreignHosts(ctx).join(", "));
  check("no console errors", ctx.errors.length === 0, ctx.errors.slice(0, 3).join(" | "));
  check("no failed requests", ctx.failed.filter((f) => !f.includes("/api/mail/img")).length === 0, ctx.failed.slice(0, 3).join(" | "));
} catch (e) {
  check("mail walk finished", false, String(e).slice(0, 300));
  if (process.env.SHOTS) await page?.screenshot({ path: `${process.env.SHOTS}/mail-e2e-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
