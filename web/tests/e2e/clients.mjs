// zvena's clients against a real stand: the Web Clipper (the unpacked test
// build of clients/web-clipper, loaded into Chromium) connects and clips a
// local article into Documents; the installed web app works offline (a
// recently opened page loads with the network gone, an edit made offline
// syncs when it is back) and keeps no API answer; the share target saves
// a link through /clip and imports a shared Markdown file; signing out
// drops the person's offline copies.
//   node clients/web-clipper/build.mjs --server http://127.0.0.1:3955 --out dist/chrome-test   (once)
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… CLIPPER=/clients/web-clipper/dist/chrome-test node tests/e2e/clients.mjs
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, check, context, devSignIn, launch, summary } from "./lib.mjs";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const EXT = process.env.CLIPPER || "/clients/web-clipper/dist/chrome-test";
const RUN = Math.random().toString(36).slice(2, 7);

// A site to clip, on this machine (the zvena server cannot fetch its pictures:
// a private address — they stay links).
const ARTICLE = `<!doctype html><html><head><title>Field notes ${RUN}</title><meta property="og:site_name" content="Field Notes"></head><body>
<nav>Home · About · Subscribe</nav><article><h1>Field notes ${RUN}</h1>
${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i} about the tide pools, with <a href="/more/${i}">a link</a> and <strong>bold words</strong>, long enough for the reader view to keep it.</p>`).join("\n")}
<h2>Second part</h2><ul><li>first point</li><li>second point</li></ul><img src="/pic.png" alt="A tide pool"><script>window.tracked = true</script></article><footer>© someone</footer></body></html>`;
const site = http.createServer((req, res) => {
  if (req.url === "/pic.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(ARTICLE);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
// SITE_HOST: the article's host name. Without a toolbar click the extension may
// script only its server's host (port aside): a stand at localhost clips a
// localhost page, one at 127.0.0.1 a 127.0.0.1 page.
const SITE = `http://${process.env.SITE_HOST || "127.0.0.1"}:${site.address().port}`;

const api = async (page, path, opts = {}) => {
  const r = await page.request.fetch(`${BASE}${path}`, { headers: { origin: BASE }, ...opts });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status(), body };
};
const pull = async (page) => {
  const s = await api(page, "/api/auth/session");
  const ws = s.body?.user?.ws?.id;
  return { ws, notes: (await api(page, `/api/notes/sync?ws=${ws}&since=0`)).body?.notes ?? [] };
};
const textOf = (n) => JSON.stringify(n?.content ?? []);

// ---------------------------------------------------------------------------
// 1. The Web Clipper

const ext = await pw.chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "zvcli-")), {
  headless: true,
  executablePath: process.env.CHROMIUM,
  locale: "en-US",
  viewport: { width: 1280, height: 860 },
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await ext.addCookies([{ name: "zv_lang", value: "en", url: BASE }]);
const extErrors = [];
ext.on("page", (p) => {
  p.on("pageerror", (e) => extErrors.push(`${p.url()} ${e}`));
  p.on("console", (m) => m.type() === "error" && !/status of 40[14]|Unauthorized/.test(m.text()) && extErrors.push(`${p.url()} :: ${m.text()}`));
});
try {
  let [worker] = ext.serviceWorkers().filter((w) => w.url().startsWith("chrome-extension://"));
  worker ??= await ext.waitForEvent("serviceworker", { timeout: 20000, predicate: (w) => w.url().startsWith("chrome-extension://") });
  const extId = new URL(worker.url()).host;
  const me = await ext.newPage();
  await devSignIn(me, `Clipper ${RUN}`);
  const art = await ext.newPage();
  await art.goto(`${SITE}/article`);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.endsWith("/article"))?.id);

  const popup = await ext.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  await popup.waitForSelector('[data-test="connect"]', { state: "visible", timeout: 20000 });
  const opened = ext.waitForEvent("page");
  await popup.click('[data-test="connect"]');
  const connect = await opened;
  await connect.waitForLoadState();
  check("1 Connect opens zvena's consent page, signed in", /\/clipper\/connect\?/.test(connect.url()) && (await connect.locator('[data-test="clipper-allow"]').count()) === 1, connect.url());
  const closed = connect.waitForEvent("close", { timeout: 15000 }).then(
    () => true,
    () => false
  );
  await connect.click('[data-test="clipper-allow"]');
  check("2 Allow hands the code to the extension, which closes the tab", await closed);
  await popup.waitForSelector('[data-test="clip-screen"]:not([hidden])', { timeout: 15000 });
  check("3 the popup shows the clip screen with the page's title", (await popup.inputValue('[data-test="title"]')) === `Field notes ${RUN}`);
  await popup.waitForSelector('[data-test="dest"][data-id="private"]');
  check("4 Private is the default destination", (await popup.getAttribute('[data-test="dest"][data-id="private"]', "aria-selected")) === "true");
  await popup.click('[data-test="save"]');
  await popup.waitForSelector('[data-test="done-screen"]:not([hidden])', { timeout: 30000 });
  const href = (await popup.getAttribute('[data-test="open"]', "href")) ?? "";
  check("5 the clip is saved; the link opens it in zvena", href.startsWith(`${BASE}/docs?ws=`), href);

  const { notes } = await pull(me);
  const clip = notes.find((n) => n.title === `Field notes ${RUN}`);
  const body = textOf(clip);
  check("6 the page is in Private with the article as blocks", clip?.space?.startsWith("private:") && /"type":"heading"/.test(body) && /Paragraph 7/.test(body) && /"bulletListItem"/.test(body), body.slice(0, 200));
  check("7 navigation, footer and scripts were left out", !/Subscribe|someone|tracked/.test(body));
  check("8 links point at the clipped site; its picture on a private address stays a link", body.includes(`${SITE}/more/3`) && body.includes(`${SITE}/pic.png`));

  // The page opens in Docs.
  await me.goto(href);
  await me.waitForSelector(".nt-title", { timeout: 60000 });
  await me.waitForTimeout(800);
  check("9 Docs opens the clipped page", (await me.locator(".nt-main").innerText()).includes("Second part"));

  // Settings → Connected apps lists it; Disconnect in the extension revokes it.
  await me.goto(`${BASE}/settings`);
  await me.waitForSelector('[data-test="clipper-connection"]', { timeout: 15000 });
  check("10 Settings lists the connected Web Clipper", (await me.locator('[data-test="clipper-connection"]').count()) === 1);
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  await popup.waitForSelector('[data-test="clip-screen"]:not([hidden])', { timeout: 15000 });
  await popup.click('[data-test="settings"]');
  await popup.click('[data-test="disconnect"]');
  await popup.waitForSelector('[data-test="connect"]', { state: "visible" });
  await me.reload();
  await me.waitForTimeout(1500);
  check("11 Disconnect revokes the token on the server", (await me.locator('[data-test="clipper-connection"]').count()) === 0);
  // The test site is plain http on this machine: Docs' policy (https pictures only) blocks its picture, as it should.
  const real = extErrors.filter((e) => !(e.includes(`'${SITE}/pic.png'`) && e.includes("img-src")));
  check("12 no console errors in the clipper flow", real.length === 0, real.slice(0, 3).join(" | "));
} catch (e) {
  check("web clipper ran", false, String(e).slice(0, 400));
} finally {
  await ext.close();
}

// ---------------------------------------------------------------------------
// 2. The installed web app: offline, share target, sign-out

const browser = await launch();
const ctx = await context(browser);
const p = await ctx.newPage();
try {
  await devSignIn(p, `Offline ${RUN}`);
  await p.goto(`${BASE}/docs#new`);
  await p.waitForSelector(".nt-title", { timeout: 60000 });
  await p.locator(".nt-title").click();
  await p.keyboard.type(`Trip plan ${RUN}`);
  await p.keyboard.press("Enter");
  await p.keyboard.type("Pack the boots.");
  await p.waitForTimeout(2500);
  // The worker takes over, keeps the build's files and this page for this person.
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload();
  await p.waitForSelector(".nt-title", { timeout: 60000 });
  const cached = await p
    .waitForFunction(
      async () => {
        const names = await caches.keys();
        const mine = names.filter((n) => n.startsWith("zv-user-") && !n.endsWith("-files"));
        if (mine.length !== 1) return false;
        const c = await caches.open(mine[0]);
        return Boolean(await c.match(`${location.origin}/docs`));
      },
      null,
      { timeout: 20000, polling: 500 }
    )
    .then(
      () => true,
      () => false
    );
  check("13 the worker keeps /docs in this person's own cache", cached);
  const stored = await p.evaluate(async () => {
    const out = [];
    for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(`${n} ${new URL(r.url).pathname}`);
    return out;
  });
  check("14 no API answer is kept (pictures of pages only)", stored.every((x) => !/ \/api\//.test(x) || / \/api\/notes\/file\//.test(x)), stored.filter((x) => / \/api\//.test(x)).slice(0, 3).join(", "));

  // The network goes: requests from the page and from the worker fail.
  let fromWorker = 0;
  await ctx.route("**/*", (route) => {
    if (route.request().serviceWorker()) fromWorker++;
    return route.abort("internetdisconnected");
  });
  await ctx.setOffline(true);
  await p.reload();
  await p.waitForSelector(".nt-title", { timeout: 60000 });
  await p.waitForTimeout(1500);
  const offlineText = await p.locator(".nt-main").innerText();
  check("15 offline, the recently opened page loads from this device", offlineText.includes("Pack the boots") && offlineText.includes(`Trip plan ${RUN}`), offlineText.slice(0, 120));
  check("16 the network was really gone (page fetches fail)", (await p.evaluate(() => fetch("/api/health").then(() => "up", () => "down"))) === "down");
  // Typing offline: the edit waits in this browser.
  await p.locator(".nt-main [data-content-type='paragraph']").first().click();
  await p.keyboard.press("End");
  await p.keyboard.type(" Edited offline.");
  await p.waitForTimeout(1500);
  check("17 an edit made offline shows on the page", (await p.locator(".nt-main").innerText()).includes("Edited offline."));

  // The network is back: the edit syncs.
  await ctx.unroute("**/*");
  await ctx.setOffline(false);
  const synced = await (async () => {
    for (let i = 0; i < 40; i++) {
      await p.waitForTimeout(1000);
      const { notes } = await pull(p);
      if (notes.some((n) => n.title === `Trip plan ${RUN}` && textOf(n).includes("Edited offline."))) return true;
    }
    return false;
  })();
  check("18 back online, the offline edit reaches the server", synced, `worker requests during the outage: ${fromWorker}`);

  // The desktop app's quick search window opens /docs#search (a fresh load, then only the fragment
  // when it comes back): the search is open, and picking a page leaves #search.
  const quick = async (fresh) => {
    if (fresh) await p.goto(`${BASE}/home`);
    await p.goto(`${BASE}/docs#search`);
    await p.waitForSelector(".nt-search-head input", { timeout: 60000 });
    await p.keyboard.type(`Trip plan ${RUN}`);
    await p.locator(".nt-search-row").filter({ hasText: `Trip plan ${RUN}` }).first().click();
    await p.waitForFunction(() => location.hash.length > 1 && location.hash !== "#search", null, { timeout: 10000 });
    return /Trip-plan/.test(decodeURIComponent(await p.evaluate(() => location.hash)));
  };
  check("19a /docs#search opens Search; the picked page takes the address", await quick(true));
  check("19b back to #search without a reload opens Search again", await quick(false));

  // Share target: a shared link opens "Save to zvena" and saves through the clip endpoint.
  await p.evaluate((u) => {
    const f = document.createElement("form");
    f.method = "POST";
    f.action = "/share-target";
    f.enctype = "multipart/form-data";
    for (const [k, v] of Object.entries({ title: "Shared tide tables", text: "From the harbour office", url: u })) {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = k;
      i.value = v;
      f.append(i);
    }
    document.body.append(f);
    f.submit();
  }, `${SITE}/tides`);
  await p.waitForURL(/\/clip\?/, { timeout: 20000 });
  await p.waitForSelector('[data-test="clip-dest"][data-id="private"]', { timeout: 20000 });
  check("19 the share target opens Save to zvena, prefilled", (await p.inputValue('[data-test="clip-title"]')) === "Shared tide tables");
  await p.click('[data-test="clip-save"]');
  await p.waitForSelector('[data-test="clip-done"]', { timeout: 20000 });
  const shared = (await pull(p)).notes.find((n) => n.title === "Shared tide tables");
  check("20 the shared link is saved as a bookmark with its text", textOf(shared).includes(`${SITE}/tides`) && textOf(shared).includes("From the harbour office"));

  // A shared Markdown file is imported into Docs by the worker and the app.
  await p.goto(`${BASE}/docs#home`);
  await p.waitForSelector(".nt-main, .nt-home", { timeout: 60000 });
  await p.evaluate(() => {
    const f = document.createElement("form");
    f.method = "POST";
    f.action = "/share-target";
    f.enctype = "multipart/form-data";
    const i = document.createElement("input");
    i.type = "file";
    i.name = "files";
    i.id = "zv-share-file";
    f.append(i);
    document.body.append(f);
  });
  await p.setInputFiles("#zv-share-file", { name: "packing.md", mimeType: "text/markdown", buffer: Buffer.from(`# Packing list ${RUN}\n\n- boots\n- rope\n`) });
  await p.evaluate(() => document.querySelector("#zv-share-file").form.submit());
  await p.waitForURL(/\/docs/, { timeout: 20000 });
  const imported = await (async () => {
    for (let i = 0; i < 30; i++) {
      await p.waitForTimeout(1000);
      if ((await pull(p)).notes.some((n) => textOf(n).includes("rope"))) return true;
    }
    return false;
  })();
  check("21 a shared .md file becomes a page in Docs", imported);

  // Signing out drops this person's offline copies.
  await p.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  const purged = await p
    .waitForFunction(async () => !(await caches.keys()).some((n) => n.startsWith("zv-user-") && n !== "zv-user-guest"), null, { timeout: 10000, polling: 300 })
    .then(
      () => true,
      () => false
    );
  check("22 signing out drops the person's offline pages", purged);
  check("23 no console errors", ctx.errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(e)).length === 0, ctx.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("web app ran", false, String(e).slice(0, 400));
} finally {
  await browser.close();
  site.close();
}
process.exit(summary() ? 0 : 1);
