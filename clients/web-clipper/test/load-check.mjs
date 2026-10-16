// The built Chrome extension in a real Chromium: it loads, its popup shows
// the Connect screen without errors, and the page reader (extract.js)
// turns an article into clean, absolute HTML. Run in the Playwright image:
//   docker run --rm --name zvcli-ext-$$ --network host \
//     -v $PWD/clients/web-clipper:/clipper:ro \
//     -e PLAYWRIGHT_CORE=/opt/penpot/exporter/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core \
//     -e CHROMIUM=/opt/penpot/browsers/chromium-1234/chrome-linux64/chrome \
//     --entrypoint node penpotapp/exporter:2.18.3 /clipper/test/load-check.mjs [/clipper/dist/chrome]

import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const dir = process.argv[2] || new URL("../dist/chrome", import.meta.url).pathname;

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const ctx = await pw.chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "zvclip-")), {
  headless: true,
  executablePath: process.env.CHROMIUM,
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
});
const errors = [];
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  check("1 the background service worker starts", /^[a-p]{32}$/.test(id), sw.url());

  const popup = await ctx.newPage();
  popup.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  popup.on("pageerror", (e) => errors.push(String(e)));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForSelector('[data-test="connect"]', { state: "visible", timeout: 10000 });
  check("2 not connected: the popup shows Connect", (await popup.locator('[data-test="connect"]').innerText()).trim() === "Connect to zvena");
  check("3 the wordmark loads", await popup.locator(".zc-logo").evaluate((img) => img.complete && img.naturalWidth > 0));
  check("4 the popup uses Zvena Sans", (await popup.evaluate(() => getComputedStyle(document.body).fontFamily)).startsWith('"Zvena Sans"'));
  await popup.locator("#connect-settings").click();
  check("5 settings show the server", (await popup.locator('[data-test="server"]').inputValue()).startsWith("http"));

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  check("6 no broad host access in the manifest", !JSON.stringify(manifest.host_permissions).includes("<all_urls>") && !manifest.permissions.includes("tabs"));

  // The page reader, on a page of our own (extension pages cannot be scripted, so the bundle is added directly).
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("https://news.example.test/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>A long read</title><meta property="og:image" content="/cover.jpg"><meta property="og:site_name" content="Example News"><link rel="icon" href="/fav.png"></head>
      <body><nav>Home · World · Sports</nav><article><h1>A long read</h1>
      ${Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} with <a href="/rel/${i}">a relative link</a> and <a href="javascript:alert(1)">a bad one</a>, written so that it reads like a real article, long enough for the reader to keep it.</p>`).join("")}
      <p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/lazy.jpg" alt="lazy"></p>
      <p><img srcset="/img/s.jpg 320w, /img/l.jpg 1280w" alt="set" onerror="alert(1)" style="color:red"></p>
      <script>window.bad = 1</script></article><footer>© Example</footer></body></html>`,
    })
  );
  await page.goto("https://news.example.test/2026/story.html");
  await page.addScriptTag({ content: readFileSync(join(dir, "extract.js"), "utf8") });
  await page.evaluate(() => {
    const p = document.querySelector("article p");
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().addRange(r);
  });
  const out = await page.evaluate(() => globalThis.__zvExtract({ article: true }));
  check("7 title, site, cover and icon", out.title === "A long read" && out.siteName === "Example News" && out.cover === "https://news.example.test/cover.jpg" && out.favicon === "https://news.example.test/fav.png", JSON.stringify({ t: out.title, c: out.cover, f: out.favicon }));
  check("8 the article is read, the navigation left out", out.content.includes("Paragraph 11") && !out.content.includes("Sports"));
  check("9 links made absolute, javascript: links unwrapped", out.content.includes('href="https://news.example.test/rel/3"') && !out.content.includes("javascript:"));
  check("10 lazy and srcset images resolved", out.content.includes("https://news.example.test/img/lazy.jpg") && out.content.includes("https://news.example.test/img/l.jpg"));
  check("11 no scripts, handlers or styles", !/<script|onerror|style=/i.test(out.content));
  check("12 the selection is read", out.selection.includes("Paragraph 0") && out.selection.includes("https://news.example.test/rel/0"));
  check("13 the page itself is untouched", await page.evaluate(() => document.querySelector("nav") !== null && document.querySelector("img[data-src]")?.getAttribute("src")?.startsWith("data:") && document.querySelector("img[onerror]") !== null));

  check("14 no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("load-check ran", false, String(e).slice(0, 400));
} finally {
  await ctx.close();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
