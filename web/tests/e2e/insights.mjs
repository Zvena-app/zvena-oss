// Insights end to end: a team with some closed and some open work sees its
// numbers, the weekly flow (hover tooltip, table view), the cycle time, and
// open work by status/assignee/priority/label; a bar opens those issues;
// the screen works on a phone and in dark mode; a stranger gets nothing.
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const SHOTS = process.env.SHOTS || "";
const browser = await launch();
const ctx = await context(browser);
const req = (c, method, path, data) => c.request.fetch(`${BASE}${path}`, { method, data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));

let page;
try {
  page = await ctx.newPage();
  await devSignIn(page, `Ivy Insight ${RUN}`);
  const ws = (await req(ctx, "POST", "/api/ws", { name: `Insights ${RUN}` })).body.workspace.id;
  await req(ctx, "POST", `/api/projects/start?ws=${ws}`, {});
  const boot = (await req(ctx, "GET", `/api/projects/bootstrap?ws=${ws}`)).body;
  const team = boot.teams[0];
  const status = (cat) => boot.statuses.find((s) => s.teamId === team.id && s.category === cat).id;
  const mk = async (title, extra = {}) => (await req(ctx, "POST", `/api/projects/issues?ws=${ws}`, { teamId: team.id, title, ...extra })).body;
  for (const title of ["Ship the login page", "Fix the export", "Write the docs"]) {
    const it = await mk(title);
    await req(ctx, "PATCH", `/api/projects/issues/${it.id}?ws=${ws}`, { statusId: status("started") });
    await req(ctx, "PATCH", `/api/projects/issues/${it.id}?ws=${ws}`, { statusId: status("completed") });
  }
  await mk("Urgent bug", { priority: 1 });

  await page.goto(`${BASE}/projects/insights?ws=${ws}`);
  await page.waitForSelector(".pj-ins-tile", { timeout: 30000 });
  if (await page.locator(".zv-cookie button").count()) await page.locator(".zv-cookie button").first().click();
  const tiles = await page.locator(".pj-ins-tile-value").allInnerTexts();
  // The first run made three example issues (open) + one urgent open; three completed.
  check("tiles: open now and completed in range", tiles[0] === "4" && tiles[1] === "3", tiles.join(" | "));
  check("the weekly flow is drawn", (await page.locator(".pj-ins-chart rect.pj-ins-s1").count()) >= 1);
  const lastWeek = page.locator(".pj-ins-chart g[tabindex]").last();
  await lastWeek.hover();
  const tip = await page.locator(".pj-ins-tip").first().innerText().catch(() => "");
  check("hovering a week shows its numbers", /3/.test(tip) && /Completed|Завершено/.test(tip), tip.replace(/\s+/g, " "));
  check("open work by priority lists the urgent one", (await page.locator(".pj-ins-card", { hasText: /Open by priority|по приоритету/ }).innerText()).includes("1"));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/insights.png`, fullPage: true });

  await page.locator(".pj-ins-filters button", { hasText: /Table|Таблица/ }).click();
  check("the table view shows the same numbers", (await page.locator(".pj-ins-table tbody tr").count()) === 12);
  await page.locator(".pj-ins-filters button", { hasText: /Table|Таблица/ }).click();

  await page.selectOption(".pj-ins-filters select >> nth=2", "4");
  await page.waitForFunction(() => document.querySelectorAll(".pj-ins-chart g[tabindex]").length === 4, null, { timeout: 10000 });
  check("the range switches to 4 weeks (in the URL)", page.url().includes("weeks=4"));

  await page.locator(".pj-ins-card", { hasText: /Open by priority|по приоритету/ }).locator(".pj-ins-bar-row").first().click();
  await page.waitForURL(/\/projects\/issues\?.*priority=1/, { timeout: 10000 });
  await page.waitForSelector(".pj-issue-row", { timeout: 15000 });
  check("a bar opens those issues", (await page.locator(".pj-issue-row").count()) === 1 && (await page.locator(".pj-issue-row").first().innerText()).includes("Urgent bug"));

  // Phone width and dark mode.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/projects/insights?ws=${ws}`);
  await page.waitForSelector(".pj-ins-tile", { timeout: 20000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scroll on a phone", overflow <= 1, String(overflow));
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/insights-phone-dark.png`, fullPage: true });

  const stranger = await context(browser);
  const sp = await stranger.newPage();
  await devSignIn(sp, `Stan ${RUN}`);
  check("a stranger gets no insights", (await req(stranger, "GET", `/api/projects/insights?ws=${ws}`)).status === 403);

  check("no foreign hosts", foreignHosts(ctx).length === 0, foreignHosts(ctx).join(", "));
  check("no console errors", ctx.errors.length === 0, ctx.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("insights walk finished", false, String(e).slice(0, 300));
  if (SHOTS) await page?.screenshot({ path: `${SHOTS}/insights-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
