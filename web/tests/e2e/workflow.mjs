// Linear's workflow wherever an issue shows, in a real browser:
//   a sub-issue's status changes from its parent's list;
//   "Mark as duplicate…" (command palette) closes the issue in the Duplicate status;
//   the team's settings name its Duplicate status;
//   project progress draws work in progress apart from done;
//   in a document and on Home an issue's icon opens its team's whole
//   workflow (mouse and keyboard), not a done / not done checkbox — also at phone width.
//   BASE=http://127.0.0.1:3400 PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/workflow.mjs
// SHOTS=dir saves screenshots of the status menus (desktop and phone).
import { mkdirSync } from "node:fs";
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const ctx = await context(browser);
const page = await ctx.newPage();
const api = (p, method = "GET", data) =>
  page.request.fetch(`${BASE}/api/${p}`, { method, headers: { origin: BASE, "content-type": "application/json" }, data: data === undefined ? undefined : JSON.stringify(data) }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));
const shot = async (name, p = page) => {
  if (!SHOTS) return;
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await page.waitForTimeout(200);
  }
  return false;
};

try {
  await devSignIn(page, `Wren ${RUN}`, { next: "/home" });
  const me = (await api("auth/session")).body.user;
  const ws = (await api("ws", "POST", { name: `Flow ${RUN}` })).body.workspace.id;
  check("workspace created", Boolean(ws));
  // First run makes the team (Projects opens on it).
  await page.goto(`${BASE}/projects?ws=${ws}`);
  await page.waitForURL(/\/projects\/team\/[A-Z0-9]+\/issues/, { timeout: 30000 });
  const KEY = /\/team\/([A-Z0-9]+)\//.exec(page.url())[1];
  if (await page.locator(".zv-cookie button").count()) await page.locator(".zv-cookie button").first().click();
  const boot = (await api(`projects/bootstrap?ws=${ws}`)).body;
  const team = boot.teams[0];
  const st = (name) => boot.statuses.find((s) => s.teamId === team.id && s.name === name);
  const issue = async (body) => (await api(`projects/issues?ws=${ws}`, "POST", { teamId: team.id, ...body })).body;
  const statusOf = async (id) => (await api(`projects/issues/${id}?ws=${ws}`)).body?.statusId;

  // --- A sub-issue's status, right in its parent's list ---
  const parent = await issue({ title: "Launch checklist" });
  const child = await issue({ title: "Write release notes", parentId: parent.id });
  await page.goto(`${BASE}/projects/issue/${parent.identifier}?ws=${ws}`);
  await page.waitForSelector(".pj-mini-row .pj-mini-status", { timeout: 20000 });
  await page.locator(".pj-mini-row .pj-mini-status").first().click();
  await page.locator(".pj-popover .pj-menu-item", { hasText: "In progress" }).first().click();
  check("a sub-issue moves to In progress from its parent", await until(async () => (await statusOf(child.id)) === st("In progress").id));
  check("…and its row says so", await until(async () => (await page.locator(".pj-mini-row .pj-mini-status").first().getAttribute("title"))?.includes("In progress")));
  check("…and the parent's progress shows it in progress", await until(async () => (await page.locator(".pj-mini-progress .pj-progress-started").count()) === 1));
  await shot("wf-01-subissue");

  // --- "Mark as duplicate…" from the command palette ---
  const orig = await issue({ title: "Export to CSV fails" });
  const dupe = await issue({ title: "CSV export broken", statusId: st("Todo").id });
  await page.goto(`${BASE}/projects/issue/${dupe.identifier}?ws=${ws}`);
  await page.waitForSelector(".pj-issue-main", { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.keyboard.press("/");
  await page.waitForSelector(".pj-palette input", { timeout: 5000 });
  await page.keyboard.type("duplicate");
  await page.locator(".pj-palette .pj-menu-item", { hasText: "Mark as duplicate" }).first().click();
  await page.waitForSelector(".pj-palette .pj-issue-search input", { timeout: 5000 });
  await page.keyboard.type(orig.identifier);
  await page.locator(".pj-palette .pj-menu-item", { hasText: orig.identifier }).first().click({ timeout: 10000 });
  check("marked as a duplicate: closed in the Duplicate status", await until(async () => (await statusOf(dupe.id)) === st("Duplicate").id));
  const rel = (await api(`projects/issues/${dupe.id}?ws=${ws}`)).body?.relations ?? [];
  check("…with the relation to the original", rel.some((r) => r.type === "duplicate" && r.issue.id === orig.id));

  // --- The team's settings name its Duplicate status ---
  await page.goto(`${BASE}/projects/settings/team/${KEY}?ws=${ws}`);
  const sel = page.getByLabel("Duplicate status", { exact: true });
  await sel.waitFor({ timeout: 20000 });
  check("settings: the Duplicate status is the seeded one", (await sel.inputValue()) === st("Duplicate").id);
  await sel.selectOption(st("Canceled").id);
  check("…and can be changed to another canceled status", await until(async () => (await api(`projects/bootstrap?ws=${ws}`)).body.teams[0].duplicateStatusId === st("Canceled").id));
  await sel.selectOption(st("Duplicate").id);
  await sel.scrollIntoViewIfNeeded();
  await shot("wf-02-settings");

  // --- Project progress: done, and work in progress drawn apart ---
  const project = (await api(`projects/projects?ws=${ws}`, "POST", { name: `Website ${RUN}`, teamIds: [team.id] })).body;
  await issue({ title: "Hero copy", projectId: project.id, statusId: st("Done").id });
  await issue({ title: "Pricing table", projectId: project.id, statusId: st("In progress").id });
  await issue({ title: "FAQ", projectId: project.id });
  await page.goto(`${BASE}/projects/project/${project.id}?ws=${ws}`);
  await page.waitForSelector(".pj-project-side .pj-progress", { timeout: 20000 });
  check("project progress shows work in progress apart from done", (await page.locator(".pj-project-side .pj-progress-started").count()) === 1);

  // --- A document: the live issue's icon opens the whole workflow ---
  const docIssue = await issue({ title: "Record the demo video", assigneeId: me.id, statusId: st("Todo").id });
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const para = (text) => ({ id: Math.random().toString(36).slice(2, 10), type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
  const block = { id: Math.random().toString(36).slice(2, 10), type: "issue", props: { issueId: docIssue.id, ident: docIssue.identifier }, children: [] };
  const note = { id, parentId: null, kind: "page", title: "Demo plan", icon: "", cover: null, content: [para("This week:"), block, para("")], order: now, favorite: false, createdAt: now, updatedAt: now, trashedAt: null };
  check("document saved", (await api(`notes/sync?ws=${ws}`, "POST", { items: [{ id, note }] })).status === 200);
  await page.goto(`${BASE}/docs?ws=${ws}#Demo-plan-${id}`);
  await page.waitForSelector(".eco-block .eco-check", { timeout: 30000 });
  const btn = page.locator(".eco-block .eco-check").first();
  check("the issue shows a status button, not a checkbox", (await btn.getAttribute("role")) === null && (await btn.getAttribute("aria-haspopup")) === "menu", await btn.getAttribute("aria-label"));
  await btn.click();
  await page.waitForSelector(".eco-status-menu [role=menuitemradio]", { timeout: 10000 });
  const items = await page.locator(".eco-status-menu [role=menuitemradio]").allInnerTexts();
  check("the menu lists the team's workflow in board order", items.map((x) => x.split("\n")[0].trim()).join(",") === "Backlog,Todo,In progress,In review,Done,Canceled,Duplicate", items.join(" | ").replace(/\s+/g, " "));
  check("…with the current status checked", (await page.locator('.eco-status-menu [aria-checked="true"]').innerText()).includes("Todo"));
  await shot("wf-03-doc-menu");
  await page.locator(".eco-status-menu [role=menuitemradio]", { hasText: "In progress" }).click();
  check("half done: In progress in Projects", await until(async () => (await statusOf(docIssue.id)) === st("In progress").id));
  check("…and on the page", await until(async () => (await page.locator(".eco-block .eco-status-name").first().innerText()) === "In progress"));

  // Keyboard: Enter opens, the number picks, Escape closes and gives the focus back.
  await btn.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".eco-status-menu", { timeout: 5000 });
  await page.keyboard.press("Escape");
  check("Escape closes the menu and the focus is back on the button", (await page.locator(".eco-status-menu").count()) === 0 && (await page.evaluate(() => document.activeElement?.classList.contains("eco-check"))));
  await page.keyboard.press("Enter");
  await page.waitForSelector(".eco-status-menu", { timeout: 5000 });
  await page.keyboard.press("1");
  check("postponed: 1 picks Backlog", await until(async () => (await statusOf(docIssue.id)) === st("Backlog").id));
  await page.keyboard.press("Enter");
  await page.waitForSelector(".eco-status-menu", { timeout: 5000 });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check("arrows and Enter: In review", await until(async () => (await statusOf(docIssue.id)) === st("In review").id));

  // --- Home: my issues, the same menu; Canceled is not "done" ---
  await page.goto(`${BASE}/home?ws=${ws}`);
  const home = page.locator(".eco-block", { hasText: "Record the demo video" }).locator(".eco-check");
  await home.waitFor({ timeout: 30000 });
  await home.click();
  await page.locator(".eco-status-menu [role=menuitemradio]", { hasText: "Canceled" }).click();
  check("Home: canceled from the menu", await until(async () => (await statusOf(docIssue.id)) === st("Canceled").id));
  check("…and the card dims it as closed", await until(async () => (await page.locator(".eco-block[data-done]", { hasText: "Record the demo video" }).count()) === 1));

  // --- Phone width: the menu fits and its rows are easy to tap ---
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${BASE}/docs?ws=${ws}#Demo-plan-${id}`);
  await phone.waitForSelector(".eco-block .eco-check", { timeout: 30000 });
  await phone.locator(".eco-block .eco-check").first().click();
  await phone.waitForSelector(".eco-status-menu [role=menuitemradio]", { timeout: 10000 });
  const box = await phone.locator(".eco-status-menu").boundingBox();
  check("phone: the menu fits the screen", box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await shot("wf-04-phone-menu", phone);
  await phone.keyboard.press("Escape");
  await phone.close();

  check("no requests to foreign hosts", foreignHosts(ctx).length === 0, foreignHosts(ctx).join(", "));
  check("no console errors", ctx.errors.length === 0, ctx.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("run without exceptions", false, e instanceof Error ? e.message.split("\n")[0] : String(e));
  await shot("wf-error").catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
