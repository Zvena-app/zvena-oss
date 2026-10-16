// Documents: Page history (two people's versions, highlights, restore), Updates and Analytics.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-history.mjs
import { BASE, check, context, devSignIn, DOCS_NAV, launch, moveToWorkspace, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const ctxA = await context(browser);
const ctxB = await context(browser);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
a.setDefaultTimeout(90000);
b.setDefaultTimeout(90000);
const api = (page, url, method = "GET", body) =>
  page.evaluate(async ([url, method, body]) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [url, method, body]);
const more = (p) => p.getByRole("button", { name: "Стиль, экспорт и другое…" }).click();
const shot = (p, name) => p.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-history-${name}.png` : "/dev/null" }).catch(() => {});
try {
  await devSignIn(a, `Анна ${RUN}`);
  const team = (await api(a, "/api/ws", "POST", { name: `История ${RUN}` })).body.workspace.id;
  await a.goto(`${BASE}/docs?ws=${team}#new`);
  await a.waitForSelector(".nt-title");
  await a.locator(".nt-title").click();
  await a.keyboard.type("Регламент");
  await a.keyboard.press("Enter");
  await a.keyboard.type("Первая редакция текста.");
  await a.waitForTimeout(4000);
  await moveToWorkspace(a);
  const inv = await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "editor" });
  const token = String(inv.body?.url ?? "").split("/join/")[1];
  await devSignIn(b, `Борис ${RUN}`);
  check("1 Boris joined as editor", (await api(b, "/api/join", "POST", { token })).body?.role === "editor");
  await b.goto(`${BASE}/docs?ws=${team}`);
  await b.waitForSelector(DOCS_NAV);
  await b.waitForTimeout(3000);
  await b.locator(DOCS_NAV).getByText("Регламент").first().click();
  await b.waitForTimeout(3000);
  await b.locator(".nt-main").getByText("Первая редакция").click();
  await b.keyboard.press("End");
  await b.keyboard.type(" Правка Бориса.");
  await b.waitForTimeout(4000);
  const page = (await api(a, `/api/notes/sync?ws=${team}&since=0`)).body.notes.find((n) => n.title === "Регламент");
  const versions = (await api(a, `/api/notes/versions?ws=${team}&id=${page.id}`)).body?.versions ?? [];
  check("2 two versions by two people on the server", versions.length >= 2 && new Set(versions.map((v) => v.by)).size === 2, JSON.stringify(versions.map((v) => v.by)));

  await a.evaluate(() => window.dispatchEvent(new Event("focus")));
  await a.waitForTimeout(3000);
  await more(a);
  await a.getByText("История версий").click();
  await a.waitForSelector(".nt-history .nt-hist-item");
  const list = await a.locator(".nt-history .nt-hist-list").innerText();
  check("3 history lists versions with names", list.includes(`Борис ${RUN}`) && list.includes(`Анна ${RUN}`), list.slice(0, 300));
  await a.waitForSelector(".nt-history .nt-hist-add", { timeout: 30000 }).catch(() => {});
  const added = await a.locator(".nt-history .nt-hist-add").allInnerTexts();
  check("4 newest version highlights Boris's words", added.join(" ").includes("Правка Бориса"), added.join(" | "));
  await shot(a, "dialog");
  await a.locator(".nt-history .nt-hist-item").nth(1).click();
  await a.waitForTimeout(1500);
  await a.getByRole("button", { name: "Восстановить версию" }).click();
  await a.waitForTimeout(2500);
  // The page's text without other people's live carets (a name label can sit inside a word).
  const body = await a.locator(".nt-main").evaluate((el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('[class*="collaboration-cursor"]').forEach((x) => x.remove());
    return (c.textContent ?? "").replace(/\u2060/g, "");
  });
  check("5 restore brings back the older text", body.includes("Первая редакция") && !body.includes("Правка Бориса"), body.slice(0, 200));

  await more(a);
  await a.getByText("Обновления").click();
  await a.waitForSelector(".nt-updates .nt-updates-item");
  const upd = await a.locator(".nt-updates").innerText();
  check("6 updates show Boris's edit and the creation", upd.includes(`Борис ${RUN} — изменения`) && upd.includes("страница создана"), upd.slice(0, 400));
  await a.locator(".nt-updates").getByText("Показать изменения").first().click();
  await a.waitForSelector(".nt-updates .nt-updates-diff .nt-hist-title");
  check("7 updates show the changes", (await a.locator(".nt-updates .nt-updates-diff").count()) === 1);
  await shot(a, "updates");
  await a.keyboard.press("Escape");

  await more(a);
  await a.getByText("Аналитика").click();
  await a.waitForSelector(".nt-analytics .nt-analytics-stat");
  const an = await a.locator(".nt-analytics").innerText();
  check("8 analytics count views and list editors", /Всего просмотров\s*\n?\s*[1-9]/.test(an) && an.includes(`Борис ${RUN}`), an.slice(0, 400));
  await a.locator(".nt-analytics").getByRole("tab", { name: /Уникальных/ }).click();
  check("9 the chart is drawn", (await a.locator(".nt-analytics svg polyline.nt-chart-line").count()) === 1);
  check("10 no console errors / failed requests", ctxA.errors.length + ctxB.errors.length === 0 && ctxA.failed.length + ctxB.failed.length === 0, [...ctxA.errors, ...ctxB.errors, ...ctxA.failed, ...ctxB.failed].slice(0, 6).join(" | "));
} catch (e) {
  check("docs-history ran", false, String(e).slice(0, 500));
} finally {
  await shot(a, "last");
  await browser.close();
}
process.exit(summary() ? 0 : 1);
