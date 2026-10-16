// Documents: two people edit one page at the same time (live co-editing):
// each sees the other's typing within 2 s, the other's cursor carries their
// name, the Topbar shows who else is in the page, and the page's JSON (what
// search, export and other devices read) ends up with both edits.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-collab.mjs
import { BASE, check, context, devSignIn, DOCS_NAV, foreignHosts, launch, moveToWorkspace, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const ANNA = `Анна ${RUN}`;
const BORIS = `Борис ${RUN}`;
const browser = await launch();
const ctxA = await context(browser);
const ctxB = await context(browser);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
const api = (page, url, method = "GET", body) =>
  page.evaluate(
    async ([url, method, body]) => {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [url, method, body]
  );
/** Waits until `fn` is true (polling every 100 ms); returns how long it took, or -1. */
async function within(ms, fn) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 100));
  }
  return -1;
}
/** The page text as written (the others' cursor widgets left out). */
const body = (p) =>
  p.locator(".nt-main .bn-editor").evaluate((el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll(".bn-collaboration-cursor__label, .bn-collaboration-cursor__caret").forEach((x) => x.remove());
    return (c.textContent ?? "").replace(/\u2060/g, "");
  });
try {
  await devSignIn(a, ANNA);
  const team = (await api(a, "/api/ws", "POST", { name: `Совместно ${RUN}` })).body.workspace.id;
  const inv = await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "editor" });
  await devSignIn(b, BORIS);
  const joined = await api(b, "/api/join", "POST", { token: String(inv.body?.url ?? "").split("/join/")[1] });
  check("1 editor joined", joined.body?.role === "editor", JSON.stringify(joined.body));

  await a.goto(`${BASE}/docs?ws=${team}#new`);
  await a.waitForSelector(".nt-title", { timeout: 60000 });
  await a.locator(".nt-title").click();
  await a.keyboard.type("Совместная страница");
  await a.keyboard.press("Enter");
  await a.waitForSelector(".nt-main .bn-editor", { timeout: 30000 });
  await a.keyboard.type("Первая строка.");
  await a.waitForTimeout(3500);
  await moveToWorkspace(a);

  await b.goto(`${BASE}/docs?ws=${team}`);
  await b.waitForSelector(DOCS_NAV, { timeout: 60000 });
  await b.waitForTimeout(2500);
  await b.locator(DOCS_NAV).getByText("Совместная страница").first().click();
  const opened = await within(10000, async () => (await body(b).catch(() => "")).includes("Первая строка."));
  check("2 the second person opens the page with its text", opened >= 0);

  // Anna types; Boris sees it live.
  await a.locator(".nt-main .bn-editor").getByText("Первая строка.").click();
  await a.keyboard.press("End");
  await a.keyboard.type(" Анна печатает.");
  const seenB = await within(2000, async () => (await body(b)).includes("Анна печатает."));
  check("3 Boris sees Anna's typing within 2 s", seenB >= 0, `${seenB} ms`);

  // Boris types at the start of the same line at the same time; Anna sees it live.
  await b.locator(".nt-main .bn-editor").getByText("Первая строка.").click();
  await b.keyboard.press("Home");
  await b.keyboard.type("Борис: ");
  const seenA = await within(2000, async () => (await body(a)).includes("Борис: "));
  check("4 Anna sees Boris's typing within 2 s", seenA >= 0, `${seenA} ms`);
  const same = await within(2000, async () => (await body(a)) === (await body(b)));
  check("5 both see the same page", same >= 0, `${(await body(a)).slice(0, 80)} | ${(await body(b)).slice(0, 80)}`);

  // The other's cursor carries their name; the Topbar shows who else is here.
  const label = await within(3000, async () => (await a.locator(".bn-collaboration-cursor__label").allInnerTexts().catch(() => [])).some((t) => t.includes(BORIS)) || (await a.locator(".bn-collaboration-cursor__label").evaluateAll((els) => els.map((e) => e.textContent ?? "")).catch(() => [])).some((t) => t.includes(BORIS)));
  check("6 Boris's cursor in Anna's page has his name", label >= 0);
  const faceA = await within(3000, async () => ((await a.locator(".nt-top-faces").getAttribute("aria-label").catch(() => null)) ?? "").includes(BORIS));
  const faceB = await within(3000, async () => ((await b.locator(".nt-top-faces").getAttribute("aria-label").catch(() => null)) ?? "").includes(ANNA));
  check("7 the Topbar shows the other person", faceA >= 0 && faceB >= 0, `${faceA} ${faceB}`);

  // Saved: a reload brings both edits back, and the page's JSON on the server has them too.
  await a.waitForTimeout(3500);
  await b.reload();
  await b.waitForSelector(".nt-main .bn-editor", { timeout: 30000 });
  const kept = await within(8000, async () => {
    const t = await body(b).catch(() => "");
    return t.includes("Борис: ") && t.includes("Анна печатает.");
  });
  check("8 a reload keeps both edits", kept >= 0, (await body(b).catch(() => "")).slice(0, 120));
  const json = await within(10000, async () => {
    const st = await api(a, `/api/notes/sync?ws=${team}&since=0`);
    const page = (st.body?.notes ?? []).find((n) => n.title === "Совместная страница");
    const text = JSON.stringify(page?.content ?? []);
    return text.includes("Борис: ") && text.includes("Анна печатает.");
  });
  check("9 the page's JSON on the server has both edits", json >= 0);

  // An edit made outside a session (an offline device, an older tab) — newer JSON, not a session's
  // snapshot — is merged into the live page for everyone.
  const st = await api(a, `/api/notes/sync?ws=${team}&since=0`);
  const page = (st.body?.notes ?? []).find((n) => n.title === "Совместная страница");
  const outside = { ...page, content: [...page.content, { type: "paragraph", content: [{ type: "text", text: "Правка с другого устройства.", styles: {} }] }], updatedAt: Date.now() + 1000 };
  delete outside.ysnap;
  const pushed = await api(b, `/api/notes/sync?ws=${team}`, "POST", { items: [{ id: page.id, note: outside }] });
  await a.evaluate(() => window.dispatchEvent(new Event("focus")));
  await b.evaluate(() => window.dispatchEvent(new Event("focus")));
  const merged = await within(12000, async () => (await body(a)).includes("Правка с другого устройства.") && (await body(b)).includes("Правка с другого устройства."));
  check("9b an edit made outside the session reaches both live pages", pushed.status === 200 && merged >= 0, `${pushed.status} ${merged} ms`);
  const once = (await body(a)).split("Правка с другого устройства.").length - 1;
  check("9c merged once, the earlier text kept", once === 1 && (await body(a)).includes("Анна печатает."), (await body(a)).slice(0, 160));

  // A viewer follows the live page and cannot change it.
  const ctxV = await context(browser);
  const v = await ctxV.newPage();
  const vInv = await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "viewer" });
  await devSignIn(v, `Вера ${RUN}`);
  await api(v, "/api/join", "POST", { token: String(vInv.body?.url ?? "").split("/join/")[1] });
  await v.goto(`${BASE}/docs?ws=${team}`);
  await v.waitForSelector(DOCS_NAV, { timeout: 60000 });
  await v.waitForTimeout(2500);
  await v.locator(DOCS_NAV).getByText("Совместная страница").first().click();
  await within(10000, async () => (await body(v).catch(() => "")).includes("Анна печатает."));
  await a.locator(".nt-main .bn-editor").getByText("Правка с другого устройства.").click();
  await a.keyboard.press("End");
  await a.keyboard.type(" Для Веры.");
  const seenV = await within(2000, async () => (await body(v)).includes("Для Веры."));
  const editable = await v.locator('.nt-main [contenteditable="true"]').count();
  check("10 a viewer sees live typing and cannot edit", seenV >= 0 && editable === 0, `${seenV} ms, editable=${editable}`);
  check("11 viewer: no console errors", ctxV.errors.length + ctxV.failed.length === 0, [...ctxV.errors, ...ctxV.failed].slice(0, 4).join(" | "));
  check("12 no foreign hosts", foreignHosts(ctxA).length === 0 && foreignHosts(ctxB).length === 0, [...foreignHosts(ctxA), ...foreignHosts(ctxB)].join(", "));
  check("13 no console errors / failed requests", ctxA.errors.length + ctxB.errors.length + ctxA.failed.length + ctxB.failed.length === 0, [...ctxA.errors, ...ctxB.errors, ...ctxA.failed, ...ctxB.failed].slice(0, 6).join(" | "));
} catch (e) {
  check("docs-collab ran", false, String(e).slice(0, 400));
} finally {
  await a.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-collab-a.png` : "/dev/null" }).catch(() => {});
  await b.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-collab-b.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
