// Design end to end: zvena sign-in → /design → Design signs in through zvena
// (OIDC, no second login) → the workspace's team dashboard; a new design
// file opens in the editor; no foreign hosts.
//   BASE=http://localhost:3100 DESIGN=http://localhost:3110 node tests/e2e/design.mjs
import { BASE, DESIGN, check, context, devSignIn, foreignHosts, launch, summary, designSettled } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);

/** Design finished signing in through zvena: a signed-in profile and a settled page. */
async function designReady(page, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await page.waitForTimeout(1500);
    if (!page.url().startsWith(DESIGN)) continue;
    const id = await page
      .evaluate(() => fetch("/api/main/methods/get-profile", { headers: { accept: "application/json" } }).then((r) => r.json()).then((p) => p.id).catch(() => null))
      .catch(() => null);
    if (id && id !== "00000000-0000-0000-0000-000000000000") {
      await page.waitForTimeout(2500);
      return true;
    }
  }
  return false;
}
const browser = await launch();
const ctx = await context(browser);
const page = await ctx.newPage();
const shots = process.env.SHOTS;
try {
  await devSignIn(page, `Дизайнер ${RUN}`);
  check("signed in", page.url().includes("/home"));
  await page.goto(`${BASE}/design`);
  const ready = await designReady(page);
  check("Design opened signed in (OIDC)", ready, page.url());
  if (shots) await page.screenshot({ path: `${shots}/design-dashboard.png` });
  // The dashboard draws its zvena nav once the profile and team have loaded.
  await page.waitForSelector("text=/^(Docs|Документы)$/", { timeout: 30000 }).catch(() => {});
  const text = await page.locator("body").innerText();
  check("zvena nav in Design", /Документы|Docs/.test(text) && /Команда|Team/.test(text), text.slice(0, 200));
  check("no AI assistant", !/BlueAI|ассистент|assistant/i.test(text));
  // A new design from zvena's Home.
  await page.goto(`${BASE}/design?new=1&name=${encodeURIComponent("Проверка " + RUN)}`);
  await page.waitForURL((u) => u.toString().includes("workspace"), { timeout: 60000 });
  await designReady(page);
  await designSettled(page);
  await page.waitForSelector("text=/^(Layers|Слои)$/", { timeout: 30000 }).catch(() => {});
  if (shots) await page.screenshot({ path: `${shots}/design-workspace.png` });
  const ws = await page.locator("body").innerText();
  check("editor opened", /Слои|Layers|Страницы|Pages/.test(ws), ws.slice(0, 160));
  check("no foreign hosts", foreignHosts(ctx).length === 0, foreignHosts(ctx).join(", "));
  check("no console errors", ctx.errors.length === 0, [...ctx.errors.slice(0, 4), ...ctx.failed.slice(0, 4)].join(" | "));
} catch (e) {
  check("design flow ran", false, String(e).slice(0, 400));
  if (shots) await page.screenshot({ path: `${shots}/design-fail.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
