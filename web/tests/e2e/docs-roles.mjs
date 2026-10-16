// Documents: a sync push over 10 MB, a viewer (read-only, still gets live edits), /notes links.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-roles.mjs
import { BASE, check, context, devSignIn, DOCS_NAV, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const ctxA = await context(browser);
const ctxB = await context(browser);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
const api = (page, url, method = "GET", body) =>
  page.evaluate(
    async ([url, method, body]) => {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      let j = null;
      try { j = await r.json(); } catch {}
      return { status: r.status, body: j };
    },
    [url, method, body]
  );
try {
  await devSignIn(a, `Анна ${RUN}`);
  const team = (await api(a, "/api/ws", "POST", { name: `Команда ${RUN}` })).body.workspace.id;
  const big = (await api(a, "/api/ws", "POST", { name: `Большие ${RUN}` })).body.workspace.id;

  // 1. A sync push over 10 MB (Next's proxy used to cut it: 400).
  const text = "я".repeat(1_100_000);
  const now = Date.now();
  const items = Array.from({ length: 5 }, (_, i) => {
    const id = `bigpage${i}${RUN}`;
    return { id, note: { id, parentId: null, kind: "page", title: `Большая ${i}`, icon: "", cover: null, content: [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }], order: i, favorite: false, createdAt: now, updatedAt: now, trashedAt: null } };
  });
  const pushed = await api(a, `/api/notes/sync?ws=${big}`, "POST", { items });
  check("1 sync push of ~11 MB saves every note", pushed.status === 200 && pushed.body?.saved?.length === 5, `${pushed.status} ${JSON.stringify(pushed.body).slice(0, 120)}`);

  // 2. A page in the team workspace.
  await a.goto(`${BASE}/docs?ws=${team}#new`);
  await a.waitForSelector(".nt-title", { timeout: 60000 });
  await a.locator(".nt-title").click();
  await a.keyboard.type("Регламент");
  await a.keyboard.press("Enter");
  await a.keyboard.type("Текст регламента.");
  await a.waitForTimeout(3500);
  check("2 page created", (await a.locator(".nt-main").innerText()).includes("Текст регламента"));
  // New pages start in Private (Notion): the owner moves it to the workspace's pages (••• → Move to).
  await a.getByRole("button", { name: "Стиль, экспорт и другое…" }).click();
  await a.getByRole("menuitem", { name: "Переместить", exact: true }).first().click();
  await a.locator(".nt-panel-row").filter({ hasText: "Пространство" }).first().click();
  await a.waitForTimeout(3500);

  // 3. A viewer joins through a link.
  const inv = await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "viewer" });
  const token = String(inv.body?.url ?? "").split("/join/")[1];
  await devSignIn(b, `Борис ${RUN}`);
  const joined = await api(b, "/api/join", "POST", { token });
  check("3 viewer joined", joined.body?.role === "viewer", JSON.stringify(joined.body));
  await b.goto(`${BASE}/docs?ws=${team}`);
  await b.waitForSelector(DOCS_NAV, { timeout: 60000 });
  await b.waitForTimeout(3000);
  await b.locator(DOCS_NAV).getByText("Регламент").first().click();
  await b.waitForTimeout(2500);
  const editable = await b.locator('.nt-main [contenteditable="true"]').count();
  check("4 viewer sees the page read-only", (await b.locator(".nt-main").innerText()).includes("Текст регламента") && editable === 0, `editable=${editable}`);
  await b.locator(".nt-main").getByText("Текст регламента").click();
  await b.keyboard.type("ВЗЛОМ");
  await b.waitForTimeout(2500);
  check("5 viewer typing changes nothing", !(await b.locator(".nt-main").innerText()).includes("ВЗЛОМ"));

  // 7. The owner edits; the viewer still receives it (sync was not switched off).
  await a.locator(".nt-main").getByText("Текст регламента").click();
  await a.keyboard.press("End");
  await a.keyboard.type(" Обновление от Анны.");
  await a.waitForTimeout(3500);
  await b.evaluate(() => window.dispatchEvent(new Event("focus")));
  await b.waitForTimeout(4000);
  check("6 viewer receives the owner's edit", (await b.locator(".nt-main").innerText()).includes("Обновление от Анны"));
  const st = await api(b, `/api/notes/sync?ws=${team}&since=0`);
  check("7 server copy untouched by the viewer", st.status === 200 && !JSON.stringify(st.body).includes("ВЗЛОМ"));

  // 9. "Copy link" style links open (no /notes 404).
  const r = await a.request.get(`${BASE}/notes`, { maxRedirects: 0 });
  check("8 /notes redirects to /docs", r.status() === 307 && (r.headers().location ?? "").endsWith("/docs"), `${r.status()} ${r.headers().location}`);

  check("9 no foreign hosts", foreignHosts(ctxA).length === 0 && foreignHosts(ctxB).length === 0, [...foreignHosts(ctxA), ...foreignHosts(ctxB)].join(", "));
  check("10 no console errors / failed requests", ctxA.errors.length + ctxB.errors.length + ctxA.failed.length + ctxB.failed.length === 0, [...ctxA.errors, ...ctxB.errors, ...ctxA.failed, ...ctxB.failed].slice(0, 6).join(" | "));
} catch (e) {
  check("docs-roles ran", false, String(e).slice(0, 400));
} finally {
  await a.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-roles-a.png` : "/dev/null" }).catch(() => {});
  await b.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-roles-b.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
