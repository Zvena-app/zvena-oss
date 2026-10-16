// Projects settings end to end, laid out like zvena's own settings: the
// sections on the left (the workspace's, then each team), rows of a title and
// hint with the control beside them. An owner renames a team, turns its
// switches (private, triage, cycles), adds and deletes a status, adds a label
// and a field; a viewer sees the same page read-only; it fits a phone.
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const SHOTS = process.env.SHOTS || "";
const browser = await launch();
const ctx = await context(browser);
const req = (c, method, path, data) => c.request.fetch(`${BASE}${path}`, { method, data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));
const boot = async (c, ws) => (await req(c, "GET", `/api/projects/bootstrap?ws=${ws}`)).body;
const row = (page, text) => page.locator(".zst-row", { hasText: text }).first();
const settle = (page) => page.waitForTimeout(700);

let page;
try {
  page = await ctx.newPage();
  await devSignIn(page, `Sam Settings ${RUN}`);
  const ws = (await req(ctx, "POST", "/api/ws", { name: `Settings ${RUN}` })).body.workspace.id;
  await req(ctx, "POST", `/api/projects/start?ws=${ws}`, {});
  const team = (await boot(ctx, ws)).teams[0];

  await page.goto(`${BASE}/projects/settings?ws=${ws}`);
  await page.waitForSelector(".pj-st-nav", { timeout: 30000 });
  if (await page.locator(".zv-cookie button").count()) await page.locator(".zv-cookie button").first().click();
  const nav = await page.locator(".pj-st-nav").innerText();
  check("the left list has the workspace's sections and the team", /Teams/.test(nav) && /Labels/.test(nav) && /Custom fields/.test(nav) && nav.includes(team.name), nav.replace(/\s+/g, " "));
  check("one page title on the token scale", (await page.locator(".pj-st-title").evaluate((el) => getComputedStyle(el).fontSize)) === "24px");

  // A team's page.
  await page.locator(".pj-st-nav a", { hasText: team.name }).click();
  await page.waitForURL(/\/projects\/settings\/team\//);
  await page.waitForSelector(".zst-section");
  const sections = await page.locator(".zst-section-title").allInnerTexts();
  check("the team page is in sections", ["General", "Triage", "Workflow", "Cycles", "Estimates", "Team members", "Danger zone"].every((s) => sections.includes(s)), sections.join(" | "));
  check("the open team is marked in the list", (await page.locator(".pj-st-nav a[aria-current=page]").innerText()).includes(team.name));

  const name = row(page, "Team name").locator("input");
  await name.fill(`Platform ${RUN}`);
  await name.blur();
  await settle(page);
  check("renaming saves on blur", (await boot(ctx, ws)).teams[0].name === `Platform ${RUN}`);
  check("…and the page title follows", (await page.locator(".pj-st-title").innerText()).includes(`Platform ${RUN}`));

  const sw = (text) => row(page, text).locator("[role=switch]");
  check("switches are zvena's ds Switch", (await sw("Private team").getAttribute("class")).includes("ds-switch"));
  await sw("Private team").click();
  await settle(page);
  check("private on", (await boot(ctx, ws)).teams[0].private === true && (await sw("Private team").getAttribute("aria-checked")) === "true");
  await sw("Private team").click();
  await settle(page);

  await sw("Triage incoming issues").click();
  await settle(page);
  check("triage on, with a way into it", (await boot(ctx, ws)).teams[0].triage === true && (await row(page, "Triage incoming issues").locator("a", { hasText: "Open triage" }).count()) === 1);

  const weeks = row(page, "Cycle length").locator("select");
  const cyclesOn = (await sw("Enable cycles").getAttribute("aria-checked")) === "true";
  check("cycle length follows the cycles switch", (await weeks.isDisabled()) === !cyclesOn);
  if (!cyclesOn) {
    await sw("Enable cycles").click();
    await settle(page);
  }
  await weeks.selectOption("3");
  await settle(page);
  const t1 = (await boot(ctx, ws)).teams[0];
  check("cycles on, three weeks long", t1.cyclesEnabled === true && t1.cycleWeeks === 3);

  // A status: added in Started, then deleted (its issues go to the other Started status).
  const started = page.locator(".pj-wf-cat", { hasText: "Started" }).first();
  await started.locator("button[aria-label='Add status']").click();
  await started.locator("input[placeholder='Status name']").fill("QA");
  await started.locator("button[type=submit]").click();
  await settle(page);
  check("a status is added", (await boot(ctx, ws)).statuses.some((s) => s.teamId === team.id && s.name === "QA"));
  const qa = page.locator(".pj-wf-row").filter({ has: page.locator("input[value='QA']") });
  await qa.locator("button[aria-label='Delete']").click();
  await page.locator(".pj-modal button, [role=dialog] button", { hasText: "Delete" }).last().click();
  await settle(page);
  check("…and deleted", !(await boot(ctx, ws)).statuses.some((s) => s.teamId === team.id && s.name === "QA"));

  const del = row(page, "Delete team").locator("button");
  check("the owner sees the danger zone", (await del.count()) === 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pj-settings-team.png`, fullPage: true });

  // Labels and fields.
  await page.locator(".pj-st-nav a", { hasText: "Labels" }).click();
  await page.waitForURL(/\/settings\/labels/);
  await page.locator("input[aria-label='Label name']").first().fill(`Customer ${RUN}`);
  await page.locator(".pj-label-form button[type=submit]").click();
  await settle(page);
  check("a label is added", (await boot(ctx, ws)).labels.some((l) => l.name === `Customer ${RUN}`));
  await page.locator(".pj-st-nav a", { hasText: "Custom fields" }).click();
  await page.waitForURL(/\/settings\/fields/);
  await page.locator("input[aria-label='Field name']").fill("Budget");
  await page.locator("select[aria-label='Type']").selectOption("number");
  await page.locator(".pj-label-form button[type=submit]").click();
  await settle(page);
  check("a field is added", (await boot(ctx, ws)).fields.some((f) => f.name === "Budget" && f.type === "number"));

  // A viewer: the same pages, nothing to change.
  const viewer = await context(browser);
  const vp = await viewer.newPage();
  await devSignIn(vp, `Vera Viewer ${RUN}`);
  const inv = await req(ctx, "POST", `/api/ws/invites?ws=${ws}`, { role: "viewer" });
  await req(viewer, "POST", "/api/join", { token: inv.body.url.split("/").pop() });
  await vp.goto(`${BASE}/projects/settings/team/${team.key}?ws=${ws}`);
  await vp.waitForSelector(".zst-section", { timeout: 30000 });
  check("a viewer is told it is read-only", (await vp.locator(".pj-st-main > .zst-note").count()) === 1);
  check("a viewer's switches are off limits", (await vp.locator(".zst-row [role=switch]:not([disabled])").count()) === 0);
  check("a viewer sees no danger zone", (await vp.locator(".zst-section-title", { hasText: "Danger zone" }).count()) === 0);

  // Phone width and dark mode.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/projects/settings/team/${team.key}?ws=${ws}`);
  await page.waitForSelector(".zst-section", { timeout: 20000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scroll on a phone", overflow <= 1, String(overflow));
  check("on a phone the sections are a row above the page", (await page.locator(".pj-st-nav").evaluate((el) => getComputedStyle(el).display)) === "flex");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pj-settings-phone-dark.png`, fullPage: true });

  check("no foreign hosts", foreignHosts(ctx).length === 0, foreignHosts(ctx).join(", "));
  check("no console errors", ctx.errors.length === 0, ctx.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("settings walk finished", false, String(e).slice(0, 300));
  if (SHOTS) await page?.screenshot({ path: `${SHOTS}/pj-settings-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
