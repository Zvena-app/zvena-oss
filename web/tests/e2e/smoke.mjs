// Smoke: landing, sign-in, home, a document that survives a reload and syncs.
import { BASE, check, context, devSignIn, DOCS_NAV, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const ANNA = `Anna Smoke ${RUN}`;
const browser = await launch();
const ctx = await context(browser);
const page = await ctx.newPage();
try {
  await page.goto(BASE);
  // No marketing page in this edition: the address of the instance leads to sign-in.
  check("the instance address leads to sign-in", new URL(page.url()).pathname === "/signin", page.url());
  check("cookie notice on the website", await page.locator(".zv-cookie").waitFor({ timeout: 10000 }).then(() => true, () => false));
  await page.goto(`${BASE}/signin`);
  check("sign-in shows the Terms line", (await page.locator(".zv-terms").first().innerText()).includes("Terms of Service"));
  await devSignIn(page, ANNA);
  check("sign-in → home", page.url().includes("/home"), page.url());
  // Home (Linear-style since rc-next3): the page is titled Home; the account's name is in the workspace menu (the rail's header).
  await page.click(".ds-ws-btn");
  check("home shows, signed in as Anna", /home/i.test((await page.locator("h1").first().textContent()) ?? "") && (await page.locator(".zv-user-name").first().textContent())?.includes("Anna"));
  await page.keyboard.press("Escape");
  check("no cookie notice over the app", (await page.locator(".zv-cookie").count()) === 0);
  await page.goto(`${BASE}/docs#new`);
  await page.waitForSelector(".nt-title", { timeout: 30000 });
  check("no cookie notice over Docs", (await page.locator(".zv-cookie").count()) === 0);
  await page.locator(".nt-title").click();
  await page.keyboard.type("Launch plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("First paragraph of the doc.");
  await page.waitForTimeout(3500);
  await page.reload();
  await page.waitForSelector(".nt-title", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const body = await page.locator(".nt-main").innerText();
  check("document survives reload", body.includes("Launch plan") && body.includes("First paragraph"), body.slice(0, 120));
  // A fresh browser of the same person gets it from the server.
  const ctx2 = await context(browser);
  const p2 = await ctx2.newPage();
  await devSignIn(p2, ANNA);
  await p2.goto(`${BASE}/docs`);
  await p2.waitForTimeout(4000);
  const side = await p2.locator(DOCS_NAV).innerText();
  check("document synced to another browser", side.includes("Launch plan"), side.slice(0, 200));
  check("no foreign hosts", foreignHosts(ctx).length === 0 && foreignHosts(ctx2).length === 0, [...foreignHosts(ctx), ...foreignHosts(ctx2)].join(", "));
  check("no console errors", ctx.errors.length === 0, [...ctx.errors.slice(0, 3), ...ctx.failed.slice(0, 5)].join(" | "));
} catch (e) {
  check("smoke ran", false, String(e).slice(0, 300));
} finally {
  await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/smoke-last.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
