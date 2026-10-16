// Templates from the website, the way a visitor meets them: each home page
// card opens its own template's public preview (rendered from the template
// itself), "Use this template" signs in and comes back to that template —
// a new account through /welcome, a returning one straight — and adds it;
// a link from another site shows the button instead of adding anything;
// Docs templates can be tried without an account, with the guest notice
// saying what that means.
//   BASE=… PLAYWRIGHT_CORE=… node tests/e2e/templates.mjs
import { BASE, check, context, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const shot = async (p, name) => process.env.SHOTS && (await p.screenshot({ path: `${process.env.SHOTS}/templates-${name}.png`, fullPage: true }).catch(() => {}));
/** Docs opened the copy it made: the address names the new page ("#Roadmap-<id>"). */
const opened = (page, slug) =>
  page
    .waitForFunction((s) => location.pathname === "/docs" && new RegExp(`^#${s}-[0-9a-f]{32}$`).test(location.hash), slug, { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
const browser = await launch();
try {
  const ctx = await context(browser);
  const p = await ctx.newPage();

  // 1. The home page: one preview per card, each a different template.
  await p.goto(`${BASE}/`);
  const cards = await p.locator("#explore .zl-card").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check("1 every template card opens a template's preview", cards.length >= 5 && cards.every((h) => /^\/templates\/[a-z-]+$/.test(h ?? "")), cards.join(" "));
  check("2 …a different one each", new Set(cards).size === cards.length);

  // 2. A preview, before any account: what it is, the real content, the way in.
  const res = await p.goto(`${BASE}/templates/task-tracker`);
  check("3 the preview answers 200 on the website", res?.status() === 200 && (await p.locator("body.zs").count()) === 1, String(res?.status()));
  check("4 …named after the template", (await p.locator("h1").innerText()).includes("Task tracker"));
  const table = p.locator(".zt-preview table").first();
  check("5 …showing its database with sample rows", (await table.locator("tbody tr").count()) >= 2);
  const use = p.locator("[data-test=template-use]");
  const useHref = await use.getAttribute("href");
  check("6 “Sign in to use this template” carries the choice", useHref === `/signin?next=${encodeURIComponent("/templates/task-tracker?use=1")}`, useHref ?? "");
  check("7 Docs templates can be tried without an account", (await p.locator("[data-test=template-try]").getAttribute("href")) === "/docs#tpl=taskTracker/en");
  await shot(p, "preview-doc");
  await p.goto(`${BASE}/templates/landing`);
  check("8 a Design template's preview shows it open in Design", (await p.locator(".zt-preview img").count()) === 1 && (await p.locator("[data-test=template-try]").count()) === 0);
  for (const bad of ["no-such-template", "TaskTracker", "task-tracker..", "a".repeat(60)]) {
    const r = await ctx.request.get(`${BASE}/templates/${bad}`);
    check(`9 /templates/${bad.slice(0, 20)} is 404`, r.status() === 404, String(r.status()));
  }

  // 3. A new account: sign in from the preview, set zvena up, land in the template.
  await p.goto(`${BASE}/templates/task-tracker`);
  await Promise.all([p.waitForURL(/\/signin\?/), p.click("[data-test=template-use]")]);
  const name = `Tess Template ${RUN}`;
  await p.fill('input[name="name"]', name);
  await Promise.all([p.waitForURL(/\/welcome/), p.click('form[action="/api/auth/dev"] button[type=submit]')]);
  check("10 a new account goes through /welcome with the template kept", new URL(p.url()).searchParams.get("next") === "/templates/task-tracker?use=1&welcome=1", p.url());
  // Through the steps as a person would (Enter on the name; then on until the end).
  await p.waitForSelector("[data-test=welcome-name]");
  await p.keyboard.press("Enter");
  for (let i = 0; i < 8 && !(await p.locator("[data-test=welcome-open]").count()); i++) {
    if (await p.locator("[data-test=welcome-solo]").count()) await p.click("[data-test=welcome-solo]");
    await p.locator("[data-test=welcome-next]").first().click();
    await p.waitForTimeout(400);
  }
  await Promise.all([p.waitForURL(/\/docs/, { timeout: 30000 }), p.click("[data-test=welcome-open]")]);
  check("11 …and the template is added and open", await opened(p, "Task-tracker"), p.url());

  // 4. Signed in: the preview's button is the gallery's own link; ?use=1 adds it at once.
  await p.goto(`${BASE}/templates/roadmap`);
  const own = await p.locator("[data-test=template-use]").getAttribute("href");
  check("12 signed in, “Use this template” adds it to the open workspace", /^\/docs\?ws=[^#]+#tpl=roadmap\/en$/.test(own ?? ""), own ?? "");
  await p.goto(`${BASE}/templates/landing`);
  check("13 …a Design one opens it in Design", /^\/api\/design\/template\?ws=[^&]+&key=landing$/.test((await p.locator("[data-test=template-use]").getAttribute("href")) ?? ""));
  await p.goto(`${BASE}/templates/roadmap?use=1`);
  check("14 a returning person's ?use=1 adds the template", await opened(p, "Roadmap"), p.url());

  // 5. Started on another site: nothing is added, the button waits.
  const cross = await ctx.request.get(`${BASE}/templates/roadmap?use=1`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" }, maxRedirects: 0 });
  check("15 a link from another site does not add anything by itself", cross.status() === 200 && (await cross.text()).includes("Use this template"), String(cross.status()));
  const same = await ctx.request.get(`${BASE}/templates/roadmap?use=1`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" }, maxRedirects: 0 });
  check("16 …while one from zvena itself goes on to add it", [303, 307].includes(same.status()) && /\/docs\?ws=.+#tpl=roadmap\/en$/.test(same.headers().location ?? ""), `${same.status()} ${same.headers().location}`);

  // 6. Without an account: try it in Docs; the notice says what that means.
  const guest = await context(browser);
  const g = await guest.newPage();
  await g.goto(`${BASE}/templates/roadmap`);
  await Promise.all([g.waitForURL(/\/docs/), g.click("[data-test=template-try]")]);
  check("17 a guest gets the template in Docs", await opened(g, "Roadmap"), g.url());
  const banner = g.locator("[data-test=guest-banner]");
  check("18 the guest notice says it stays in this browser", /this browser/i.test(await banner.innerText()));
  await banner.getByRole("button", { name: "What’s different" }).click();
  const more = (await g.locator("[data-test=guest-limits]").innerText()).replace(/\s+/g, " ");
  check("19 …and what needs an account, and what happens on sign-in", /Design/.test(more) && /shar/i.test(more) && /personal workspace/i.test(more), more.slice(0, 300));
  await shot(g, "guest-notice");
  check("20 no foreign hosts", foreignHosts(ctx).length === 0 && foreignHosts(guest).length === 0, [...foreignHosts(ctx), ...foreignHosts(guest)].join(", "));
  check("21 no console errors", ctx.errors.length === 0 && guest.errors.length === 0, [...ctx.errors, ...guest.errors].slice(0, 3).join(" | "));
} catch (e) {
  check("templates walk finished", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
