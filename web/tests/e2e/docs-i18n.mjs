// Documents in a language other than English and Russian: the page, the
// editor's own menus and dates speak it (Spanish here), and Arabic turns the
// whole interface right to left.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-i18n.mjs
import { BASE, check, context, devSignIn, launch, summary } from "./lib.mjs";

const browser = await launch();
const RUN = Math.random().toString(36).slice(2, 6);
try {
  // Spanish.
  const es = await context(browser, { locale: "es" });
  await es.addCookies([{ name: "zv_lang", value: "es", url: BASE }]);
  const p = await es.newPage();
  await devSignIn(p, `Idioma ${RUN}`);
  await p.goto(`${BASE}/docs#new`);
  await p.waitForSelector(".nt-title", { timeout: 60000 });
  check("1 the page is in Spanish", (await p.locator("html").getAttribute("lang")) === "es");
  await p.locator(".nt-title").click();
  await p.keyboard.type("Plan");
  await p.keyboard.press("Enter");
  // The slash menu in Spanish.
  await p.keyboard.type("/");
  await p.waitForSelector(".nt-slash", { timeout: 10000 });
  const menu = await p.locator(".nt-slash").first().innerText();
  check("2 the slash menu speaks Spanish", /Título|Encabezado|Lista/i.test(menu), menu.slice(0, 120).replace(/\s+/g, " "));
  await p.keyboard.press("Escape");
  await p.keyboard.press("Backspace");
  // "@" offers dates: Today / Tomorrow in Spanish (Intl).
  await p.keyboard.type("@");
  await p.waitForTimeout(600);
  const mention = await p.locator(".nt-slash").first().innerText().catch(() => "");
  check("3 date mentions read Hoy / Mañana", /Hoy/.test(mention) && /Mañana/.test(mention), mention.slice(0, 160).replace(/\s+/g, " "));
  await p.keyboard.press("Escape");
  check("4 no console errors", es.errors.length === 0, es.errors.slice(0, 3).join(" | "));
  await es.close();

  // Arabic: right to left.
  const ar = await context(browser, { locale: "ar" });
  await ar.addCookies([{ name: "zv_lang", value: "ar", url: BASE }]);
  const q = await ar.newPage();
  await devSignIn(q, `لغة ${RUN}`);
  await q.goto(`${BASE}/docs#new`);
  await q.waitForSelector(".nt-title", { timeout: 60000 });
  check("5 Arabic: the document is right to left", (await q.locator("html").getAttribute("dir")) === "rtl");
  check("6 no console errors (Arabic)", ar.errors.length === 0, ar.errors.slice(0, 3).join(" | "));
  await ar.close();
} catch (e) {
  check("docs-i18n ran", false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
