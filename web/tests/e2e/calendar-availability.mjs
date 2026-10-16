// Calendar's "Share availability" with no working days ticked: the dialog asks
// for free/busy once, not again after every answer (the fallback week of
// Monday–Friday used to be a new array on every render, which re-ran the fetch).
import { BASE, check, context, devSignIn, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const ctx = await context(browser);
try {
  const page = await ctx.newPage();
  await devSignIn(page, `Ava Avail ${RUN}`);
  const session = await (await ctx.request.get(`${BASE}/api/auth/session`)).json();
  const ws = session.user.ws.id;
  const put = await ctx.request.fetch(`${BASE}/api/calendar/prefs?ws=${ws}`, { method: "PUT", data: { workDays: [] }, headers: { origin: BASE } });
  check("no working days saved", put.status() === 200, String(put.status()));

  let asks = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/calendar/freebusy")) asks++;
  });
  await page.goto(`${BASE}/calendar?ws=${ws}`);
  await page.waitForSelector('[data-testid="share-availability"]', { timeout: 30000 });
  await page.click('[data-testid="share-availability"]');
  await page.waitForTimeout(5000);
  check("free/busy is asked once while the dialog stays open", asks >= 1 && asks <= 2, `${asks} requests in 5 s`);
} catch (e) {
  check("availability ran", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
