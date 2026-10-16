// Documents keep the last keystrokes: a page typed into and reloaded,
// closed, left for another page or sent to the background at once still has
// its text afterwards — for a guest (this browser only) and for an account.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-durability.mjs
import { BASE, check, context, devSignIn, launch, summary } from "./lib.mjs";

const browser = await launch();

/** A new page with a title and a line of text typed in; returns its URL. */
async function typed(p, title, text) {
  await p.goto("about:blank");
  await p.goto(`${BASE}/docs#new`);
  await p.waitForSelector(".nt-title", { timeout: 60000 });
  await p.locator(".nt-title").click();
  await p.keyboard.type(title);
  await p.keyboard.press("Enter");
  await p.keyboard.type(text, { delay: 5 });
  return p.url();
}

const body = (p) => p.locator(".nt-main .bn-editor").innerText({ timeout: 30000 }).catch(() => "");

async function opened(p, url) {
  // A fresh load (a hash-only goto would route in place).
  await p.goto("about:blank");
  await p.goto(url);
  await p.waitForSelector(".nt-main .bn-editor", { timeout: 60000 });
  // This page's title (the app routes by the hash after it loads).
  const slug = decodeURIComponent(new URL(url).hash.slice(1)).replace(/-[0-9a-f]{32}$/, "").replace(/-/g, " ");
  await p.waitForFunction((t) => document.querySelector(".nt-title")?.value === t, slug, { timeout: 30000 }).catch(() => undefined);
  // A signed-in page fills from the server or its live session a moment later.
  await p.waitForTimeout(2500);
}

async function run(who, signIn) {
  const ctx = await context(browser);
  const p = await ctx.newPage();
  const name = `Durable ${Math.random().toString(36).slice(2, 6)}`;
  try {
    if (signIn) await devSignIn(p, name);
    const urls = {};
    // 1. Reload right after the last key.
    let url = (urls.Reload = await typed(p, `Reload ${who}`, "typed then reloaded"));
    await p.reload();
    await p.waitForSelector(".nt-main .bn-editor", { timeout: 60000 });
    await p.waitForTimeout(2500);
    check(`${who}: 1 reload at once keeps the text`, (await body(p)).includes("typed then reloaded"), (await body(p)).slice(0, 80));
    check(`${who}: 1 …and the title`, (await p.locator(".nt-title").inputValue()) === `Reload ${who}`);

    // 2. The tab closed right after the last key (a new tab opens the page).
    url = urls.Close = await typed(p, `Close ${who}`, "typed then closed");
    await p.close({ runBeforeUnload: true });
    const p2 = await ctx.newPage();
    await opened(p2, url);
    check(`${who}: 2 closing the tab at once keeps the text`, (await body(p2)).includes("typed then closed"), (await body(p2)).slice(0, 80));

    // 3. Another page opened right after the last key (in-app navigation), then back.
    const other = new URL(url).hash;
    url = urls.Switch = await typed(p2, `Switch ${who}`, "typed then switched");
    await p2.evaluate((h) => (location.hash = h), other);
    await p2.waitForFunction((h) => location.hash === h && document.querySelector(".nt-title")?.value?.startsWith("Close"), other, { timeout: 30000 });
    await p2.waitForTimeout(800);
    await p2.reload();
    await opened(p2, url);
    check(`${who}: 3 opening another page at once keeps the text`, (await body(p2)).includes("typed then switched"), `${await p2.locator(".nt-title").inputValue()}: ${(await body(p2)).slice(0, 80)}`);

    // 4. The app sent to the background (a phone switching apps), then killed.
    url = urls.Hidden = await typed(p2, `Hidden ${who}`, "typed then hidden");
    await p2.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await p2.waitForTimeout(300);
    // A killed app gets no pagehide: the page is gone without one.
    const cdp = await ctx.newCDPSession(p2);
    await Promise.race([cdp.send("Page.crash").catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    const p3 = await ctx.newPage();
    await opened(p3, url);
    check(`${who}: 4 backgrounded then killed keeps the text`, (await body(p3)).includes("typed then hidden"), (await body(p3)).slice(0, 80));
    if (signIn) {
      // 5. The server has every one of them too: the same account in a fresh browser (no local copy).
      const fresh = await context(browser);
      const q = await fresh.newPage();
      await devSignIn(q, name);
      for (const [title, text] of [["Reload", "typed then reloaded"], ["Close", "typed then closed"], ["Switch", "typed then switched"], ["Hidden", "typed then hidden"]]) {
        await opened(q, url.replace(/#.*/, "") + "#" + new URL(urls[title]).hash.slice(1));
        check(`${who}: 5 ${title.toLowerCase()} reached the server`, (await body(q)).includes(text), (await body(q)).slice(0, 80));
      }
      await fresh.close();
    }
    check(`${who}: no console errors`, ctx.errors.filter((e) => !/crash/i.test(e)).length === 0, ctx.errors.slice(0, 3).join(" | "));
  } catch (e) {
    check(`${who}: ran`, false, String(e).slice(0, 300));
  } finally {
    await ctx.close();
  }
}

try {
  await run("guest", false);
  await run("account", true);
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
