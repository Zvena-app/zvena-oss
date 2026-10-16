// The ecosystem, end to end, as two people of one workspace:
//   a line of a document becomes an issue (block menu → "Turn into issue");
//   the issue lives in the page: its status menu moves it in Projects;
//   "/issue" creates another one in place;
//   a teammate's change in Projects reaches the open document at once;
//   the issue lists the document it came from; Cmd+K finds both;
//   a mention in an issue comment lands in the Inbox and on Home.
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const owner = await context(browser);
const mate = await context(browser);
const post = (ctx, path, data) => ctx.request.post(`${BASE}${path}`, { data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));
const patch = (ctx, path, data) => ctx.request.patch(`${BASE}${path}`, { data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));

let page;
try {
  page = await owner.newPage();
  await devSignIn(page, `Olivia Eco ${RUN}`);
  const matePage = await mate.newPage();
  await devSignIn(matePage, `Mason Eco ${RUN}`);
  const me = (await (await owner.request.get(`${BASE}/api/auth/session`)).json()).user;
  const mateUser = (await (await mate.request.get(`${BASE}/api/auth/session`)).json()).user;

  // A team workspace with Mason as an editor.
  const ws = (await post(owner, "/api/ws", { name: `Studio ${RUN}` })).body.workspace.id;
  const inv = await post(owner, `/api/ws/invites?ws=${ws}`, { role: "editor" });
  const join = await post(mate, "/api/join", { token: inv.body.url.split("/").pop() });
  check("teammate joins the workspace", join.status === 200, JSON.stringify(join.body));

  // A document with a to-do list.
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const line = (type, text, props = {}) => ({ id: Math.random().toString(36).slice(2, 10), type, props, content: [{ type: "text", text, styles: {} }], children: [] });
  const note = { id, parentId: null, kind: "page", title: "Launch plan", icon: "", cover: null, content: [line("paragraph", "What we ship this week."), line("checkListItem", "Write the launch post", { checked: false }), line("paragraph", "")], order: now, favorite: false, createdAt: now, updatedAt: now, trashedAt: null };
  check("document saved", (await post(owner, `/api/notes/sync?ws=${ws}`, { items: [{ id, note }] })).status === 200);

  // 1. Block menu → "Turn into issue".
  await page.goto(`${BASE}/docs?ws=${ws}#Launch-plan-${id}`);
  await page.waitForSelector(".bn-editor", { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.locator(".bn-block-content", { hasText: "Write the launch post" }).first().hover();
  await page.locator(".nt-side-menu .nt-drag").first().click();
  await page.getByText("Turn into issue", { exact: true }).click();
  await page.waitForSelector(".eco-block", { timeout: 15000 });
  const blockText = await page.locator(".eco-block").first().innerText();
  check("the line is now a live issue", /Write the launch post/.test(blockText) && /-1\b/.test(blockText), blockText.replace(/\s+/g, " "));

  // 2. Its status icon opens the team's whole workflow (Linear's status menu); Done completes it in Projects.
  await page.locator(".eco-block .eco-check").first().click();
  await page.waitForSelector(".eco-status-menu [role=menuitemradio]", { timeout: 10000 });
  const offered = await page.locator(".eco-status-menu [role=menuitemradio]").allInnerTexts();
  check("the status menu offers the whole workflow", ["Backlog", "Todo", "In progress", "In review", "Done", "Canceled", "Duplicate"].every((n) => offered.some((o) => o.includes(n))), offered.join(" | ").replace(/\s+/g, " "));
  await page.locator(".eco-status-menu [role=menuitemradio]", { hasText: "Done" }).click();
  await page.waitForSelector(".eco-block[data-done]", { timeout: 10000 });
  const rel = (await (await owner.request.get(`${BASE}/api/eco/related?ws=${ws}&ref=note:${id}`)).json()).items;
  const issue = rel.find((i) => i.card.kind === "issue")?.card;
  check("the issue is done in Projects", issue?.status?.category === "completed", issue?.status?.name);

  // 3. "/issue" makes one in place.
  await page.locator(".bn-block-content").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type("/issue");
  await page.waitForTimeout(500);
  // The slash menu lists several matches ("Issue", "Issues list"…): pick the live issue by its title.
  await page.locator(".nt-slash-item", { has: page.locator(".nt-slash-title", { hasText: /^Issue$/ }) }).first().click();
  await page.locator(".eco-new-issue input").fill("Design the hero section");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".eco-block").length >= 2, null, { timeout: 15000 });
  check("/issue creates an issue in place", true);

  // 4. Mason changes the second issue in Projects; Olivia's page follows.
  await page.waitForTimeout(1500);
  const rel2 = (await (await owner.request.get(`${BASE}/api/eco/related?ws=${ws}&ref=note:${id}`)).json()).items;
  const hero = rel2.find((i) => i.card.title === "Design the hero section")?.card;
  const boot = await (await mate.request.get(`${BASE}/api/projects/bootstrap?ws=${ws}`)).json();
  const started = boot.statuses.find((s) => s.category === "started");
  const t0 = Date.now();
  await patch(mate, `/api/projects/issues/${hero.key.slice(6)}?ws=${ws}`, { statusId: started.id, assigneeId: mateUser.id });
  const live = await page
    .waitForFunction((name) => [...document.querySelectorAll(".eco-block .eco-status-name")].some((n) => n.textContent === name), started.name, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("a teammate's change reaches the open document live", live, `${Date.now() - t0} ms`);

  // 5. The issue lists the document; Cmd+K finds both.
  await page.goto(`${BASE}${hero.url}`);
  const listed = await page
    .waitForSelector('[data-eco-related] >> text=Launch plan', { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check("the issue lists the document it came from", listed);
  await page.goto(`${BASE}/home?ws=${ws}`);
  // The palette's shortcut works once the page is interactive.
  await page.waitForSelector("html[data-eco-palette]", { state: "attached", timeout: 30000 });
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".eco-palette input", { timeout: 5000 });
  await page.keyboard.type("hero");
  await page.waitForTimeout(1200);
  const found = await page.locator(".eco-palette").innerText();
  check("Cmd+K finds the issue", found.includes("Design the hero section"), found.replace(/\s+/g, " ").slice(0, 160));
  await page.keyboard.press("Escape");

  // 6. A goal: the issue closes itself when a live number reaches its target.
  await page.goto(`${BASE}${hero.url}`);
  await page.getByText("Close automatically when…").click();
  await page.locator(".eco-goal-form select").first().selectOption("__new__");
  await page.locator('.eco-goal-form input[placeholder="MRR"]').fill("MRR");
  await page.locator('.eco-goal-form input[placeholder="0"]').fill("400");
  await page.locator('.eco-goal-form input[placeholder="1000"]').fill("1000");
  await page.getByText("Save", { exact: true }).click();
  const goalShown = await page
    .waitForSelector(".eco-goal-row", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("the goal reads as a sentence with progress", goalShown && /Closes when MRR ≥ 1,000/.test(await page.locator(".eco-goal-row").innerText()));
  const t1 = Date.now();
  await post(mate, `/api/decide?ws=${ws}`, { op: "metric", key: "mrr", value: 1250 });
  const closed = await page
    .waitForSelector(".eco-goal-row[data-reached]", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("the number reaches the target: the bar fills", closed, `${Date.now() - t1} ms`);
  const after = (await (await owner.request.post(`${BASE}/api/eco/cards?ws=${ws}`, { data: { refs: [hero.key] }, headers: { origin: BASE } })).json()).cards[0];
  check("…and the goal issue closed by itself", after?.status?.category === "completed", after?.status?.name);
  await page.screenshot({ path: `${process.env.SHOTS || "/tmp"}/eco-goal.png` }).catch(() => {});

  // 7. A mention in a comment: Inbox, sidebar badge, Home.
  await post(mate, `/api/projects/issues/${hero.key.slice(6)}/comments?ws=${ws}`, { body: `[@ id="${me.id}" label="Olivia"] can you review the copy?` });
  await page.goto(`${BASE}/inbox?ws=${ws}`);
  const inbox = await page
    .waitForSelector(".eco-inbox-item >> text=mentioned you", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("the mention is in the Inbox", inbox);
  check("the sidebar counts unread", Number(await page.locator(".ds-nav-badge, .zv-nav-badge").first().innerText().catch(() => "0")) > 0);
  await page.goto(`${BASE}/home?ws=${ws}`);
  check("Home lists where she is mentioned", (await page.locator("main").innerText()).includes("Mentions"));

  check("no foreign hosts", foreignHosts(owner).length === 0, foreignHosts(owner).join(", "));
  check("no console errors", owner.errors.length === 0, owner.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("ecosystem walk finished", false, String(e).slice(0, 300));
  if (process.env.SHOTS) await page?.screenshot({ path: `${process.env.SHOTS}/eco-e2e-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
