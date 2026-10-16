// Moving around zvena through the rail is a client navigation: no page load
// between sections, each app opens on the right screen, and what was typed in
// Documents right before leaving reaches the server.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/speed.mjs
import { BASE, check, context, devSignIn, launch, summary } from "./lib.mjs";

const READY = {
  home: ".eco-home-list",
  docs: ".nt-rail:not(.nt-rail-loading), .nt-side",
  projects: ".pj-app:not([data-loading]) .pj-main",
  calendar: ".cal-app:not(.cal-app-loading)",
  mail: ".zm-app:not(:has(.zm-loading))",
  inbox: ".zv-content-narrow",
};
const LINK = {
  home: 'a[href^="/home"]',
  docs: 'a[href^="/docs?ws"]',
  projects: 'a[href^="/projects?ws"]',
  my: 'a[href^="/projects/my-issues"]',
  calendar: 'a[href^="/calendar"]',
  mail: 'a[href^="/mail"]',
  inbox: 'a[href^="/inbox"]',
};

const browser = await launch();
const ctx = await context(browser);
const p = await ctx.newPage();
let loads = 0;
p.on("load", () => loads++);
const rail = (k) => p.locator(`.ds-rail-scroll ${LINK[k]}`).first();
async function go(k, ready = READY[k]) {
  const l0 = loads;
  await rail(k).hover();
  await rail(k).click();
  await p.waitForSelector(ready, { timeout: 30000 });
  return loads === l0;
}
try {
  await devSignIn(p, `Speed ${Math.random().toString(36).slice(2, 6)}`);
  await p.goto(`${BASE}/home`);
  await p.waitForSelector(READY.home);
  const ws = new URL(await rail("home").getAttribute("href"), BASE).searchParams.get("ws");

  // 1 Every section through the rail without a page load.
  for (const k of ["docs", "projects", "calendar", "mail", "inbox", "home"]) check(`1 ${k}: rail click is a client navigation`, await go(k), p.url());

  // 2 Projects opens where the rail points, also when it was left on another screen.
  await go("projects");
  await p.waitForURL(/\/projects\/(team\/[^/]+\/issues|my-issues)/);
  await p.goto(`${BASE}/projects/issues?ws=${ws}`);
  await p.waitForSelector(READY.projects);
  await go("home");
  check("2 My tasks after leaving Projects on All issues", await go("my", ".pj-app:not([data-loading]) .pj-main"), p.url());
  await p.waitForTimeout(500);
  check("2 the address and the rail say My tasks", /\/projects\/my-issues/.test(p.url()) && (await rail("my").getAttribute("aria-current")) === "page", p.url());

  await p.goto(`${BASE}/projects/my-issues?ws=${ws}`);
  await p.waitForSelector(READY.projects);
  await p.waitForTimeout(500);
  check("2 a page load of My tasks marks My tasks in the rail", (await rail("my").getAttribute("aria-current")) === "page");

  // 3 Typed in Documents, left at once for another section: it still reaches the server.
  await p.goto(`${BASE}/docs?ws=${ws}#new`);
  await p.waitForSelector(".nt-title", { timeout: 60000 });
  await p.locator(".nt-title").click();
  await p.keyboard.type("Leaving fast");
  await p.keyboard.press("Enter");
  const marker = `typed-${Date.now()}`;
  await p.keyboard.type(marker);
  // Well inside the editor's save delay (350 ms).
  await p.waitForTimeout(60);
  check("3 left Documents through the rail without a page load", await go("projects"));
  let saved = false;
  for (let i = 0; i < 20 && !saved; i++) {
    await p.waitForTimeout(500);
    saved = await p.evaluate(
      async ({ ws, marker }) => {
        const r = await fetch(`/api/notes/sync?ws=${encodeURIComponent(ws)}&since=0`, { credentials: "same-origin", cache: "no-store" });
        return r.ok && (await r.text()).includes(marker);
      },
      { ws, marker }
    );
  }
  check("3 the text typed right before leaving is on the server", saved);
  // …and Documents opened again (from memory) has the page.
  check("3 Documents again: client navigation", await go("docs"));
  await p.waitForTimeout(800);
  check("3 the page is in Documents' tree", (await p.locator(".nt-rail, .nt-side").first().innerText()).includes("Leaving fast"));

  check("4 no console errors", ctx.errors.length === 0, ctx.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("speed ran", false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
