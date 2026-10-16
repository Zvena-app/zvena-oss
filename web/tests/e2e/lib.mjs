// Shared bits of the browser checks: playwright-core with a local Chromium,
// a "no foreign hosts" network guard, and the test sign-in. Software WebGL:
// the Design canvas draws through it on a server without a GPU.
//   PLAYWRIGHT_CORE=/path/to/playwright-core  CHROMIUM=/usr/bin/chromium  BASE=http://localhost:3100
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

export const BASE = process.env.BASE || "http://localhost:3100";
export const DESIGN = process.env.DESIGN || "";
/** The interface language of the checks: "en" (default) or "ru" (the older checks select Russian labels). */
export const LANG = process.env.E2E_LANG === "ru" ? "ru" : "en";

export async function launch() {
  return pw.chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
}

/** A context that records every host the page talks to and every console error. */
export async function context(browser, opts = {}) {
  const ctx = await browser.newContext({ locale: LANG === "ru" ? "ru" : "en-US", viewport: { width: 1280, height: 860 }, acceptDownloads: true, ...opts });
  await ctx.addCookies([{ name: "zv_lang", value: LANG, url: BASE }]);
  ctx.hosts = new Set();
  ctx.errors = [];
  ctx.on("request", (r) => {
    try {
      ctx.hosts.add(new URL(r.url()).host);
    } catch {}
  });
  ctx.on("page", (p) => p.on("console", (m) => m.type() === "error" && !/status of 401/.test(m.text()) && ctx.errors.push(`${p.url()} :: ${m.text()}`)));
  ctx.failed = [];
  ctx.on("response", (r) => {
    // Expected: the session check of a guest, and Design's anonymous calls before it signs in through zvena.
    if (r.status() >= 400 && !/\/api\/(auth\/session|notes\/sync)/.test(r.url()) && !(r.status() === 401 && /\/api\/main\/methods\//.test(r.url()))) ctx.failed.push(`${r.status()} ${r.url()}`);
  });
  return ctx;
}

export function allowedHosts() {
  const hosts = [new URL(BASE).host];
  if (DESIGN) hosts.push(new URL(DESIGN).host);
  return hosts;
}

export function foreignHosts(ctx) {
  const ok = new Set(allowedHosts());
  return [...ctx.hosts].filter((h) => h && !ok.has(h));
}

/** The test sign-in of a test stand (next to the "By continuing, you agree…" line).
 * A new account lands on /welcome (setting zvena up); the checks leave it for
 * where they were going unless `welcome: true` (tests/e2e/welcome.mjs walks it). */
export async function devSignIn(page, name, { next = "/home", welcome = false } = {}) {
  await page.goto(`${BASE}/signin?next=${encodeURIComponent(next)}`);
  await page.fill('input[name="name"]', name);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/api/auth/dev"] button[type=submit]')]);
  if (!welcome) await pastWelcome(page);
}

/** On /welcome (a new account's first stop): goes on to its `next`, as "Skip" would. Elsewhere: nothing. */
export async function pastWelcome(page) {
  const u = new URL(page.url());
  if (u.pathname !== "/welcome") return;
  await page.goto(`${BASE}${u.searchParams.get("next") || "/home"}`);
}

/** A sign-in that ends on a new account's /welcome or on `re` (e.g. /\/home/). */
export const landed = (re) => (url) => url.pathname === "/welcome" || re.test(url.href);

const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0;
}

/** Documents' page tree: its block in zvena's shared rail (signed in), or its own sidebar (a guest without an account). */
export const DOCS_NAV = ".nt-rail:not(.nt-rail-loading), .nt-side";

/** New pages start in Private (Notion): moves the open page to the workspace's pages (••• → Move to) so teammates see it. Russian labels (E2E_LANG=ru). */
export async function moveToWorkspace(page) {
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Стиль, экспорт и другое…" }).click();
  await page.getByRole("menuitem", { name: "Переместить", exact: true }).first().click();
  await page.locator(".nt-panel-row").filter({ hasText: "Пространство" }).first().click();
  await page.waitForTimeout(2500);
}

/**
 * Design's editor has finished starting: its rasterizer iframe (it evaluates the bundle again on the main
 * thread) has loaded. A drag made before that can be lost on a busy machine, so draw after this.
 */
export async function designSettled(page, timeout = 90000) {
  await page
    .waitForFunction(
      () => {
        const f = document.getElementById("rasterizer");
        if (!f) return false;
        try {
          return /rasterizer/.test(f.contentWindow.location.href) && f.contentDocument?.readyState === "complete";
        } catch {
          return true;
        }
      },
      null,
      { timeout, polling: 500 },
    )
    .catch(() => {});
}
