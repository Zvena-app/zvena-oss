// Documents: a commenter comments a page (signed with their own name) and cannot edit it.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-comments.mjs
import { BASE, check, context, devSignIn, DOCS_NAV, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const ctxA = await context(browser);
const ctxC = await context(browser);
const a = await ctxA.newPage();
const c = await ctxC.newPage();
const api = (page, url, method = "GET", body) =>
  page.evaluate(async ([url, method, body]) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [url, method, body]);
try {
  await devSignIn(a, `Анна ${RUN}`);
  const team = (await api(a, "/api/ws", "POST", { name: `Комментарии ${RUN}` })).body.workspace.id;
  await a.goto(`${BASE}/docs?ws=${team}#new`);
  await a.waitForSelector(".nt-title", { timeout: 60000 });
  await a.locator(".nt-title").click();
  await a.keyboard.type("Обсуждение");
  await a.keyboard.press("Enter");
  await a.keyboard.type("Что думаете?");
  await a.waitForTimeout(3500);
  // New pages start in Private (Notion): the owner moves it to the workspace's pages (••• → Move to).
  await a.getByRole("button", { name: "Стиль, экспорт и другое…" }).click();
  await a.getByRole("menuitem", { name: "Переместить", exact: true }).first().click();
  await a.locator(".nt-panel-row").filter({ hasText: "Пространство" }).first().click();
  await a.waitForTimeout(3500);
  const inv =await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "commenter" });
  const token = String(inv.body?.url ?? "").split("/join/")[1];
  await devSignIn(c, `Вера ${RUN}`);
  check("1 commenter joined", (await api(c, "/api/join", "POST", { token })).body?.role === "commenter");
  await c.goto(`${BASE}/docs?ws=${team}`);
  await c.waitForSelector(DOCS_NAV, { timeout: 60000 });
  await c.waitForTimeout(3000);
  await c.locator(DOCS_NAV).getByText("Обсуждение").first().click();
  await c.waitForTimeout(2000);
  const add = c.getByRole("button", { name: "Добавить комментарий" });
  check("2 commenter has 'Add comment'", (await add.count()) > 0);
  await c.locator(".nt-page-head, .nt-main").first().hover().catch(() => {});
  await add.first().click({ force: true });
  await c.locator(".nt-cm-new textarea").fill("Согласна, но поправьте сроки.");
  await c.keyboard.press("Enter");
  await c.waitForTimeout(3500);
  const st = await api(a, `/api/notes/sync?ws=${team}&since=0`);
  const page = (st.body?.notes ?? []).find((n) => n.title === "Обсуждение");
  const cm = page?.comments?.[0];
  check("3 comment saved on the server, signed by the commenter", cm?.text === "Согласна, но поправьте сроки." && cm?.author === `Вера ${RUN}`, JSON.stringify(page?.comments ?? null).slice(0, 200));
  check("4 page itself unchanged", page?.title === "Обсуждение");
  await a.evaluate(() => window.dispatchEvent(new Event("focus")));
  await a.waitForTimeout(4000);
  check("5 owner sees the comment", (await a.locator(".nt-main").innerText()).includes("поправьте сроки"));
  check("6 no console errors / failed requests", ctxA.errors.length + ctxC.errors.length + ctxA.failed.length + ctxC.failed.length === 0, [...ctxA.errors, ...ctxC.errors, ...ctxA.failed, ...ctxC.failed].slice(0, 6).join(" | "));
} catch (e) {
  check("docs-comments ran", false, String(e).slice(0, 400));
} finally {
  await c.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-comments-c.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
