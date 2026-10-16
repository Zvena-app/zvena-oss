// Documents sharing (Notion's model): a member's new page is Private; shared
// from the Share menu as "Can comment", a teammate finds it under Shared,
// reads it and comments but cannot edit; a guest joins one page by link.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-sharing.mjs
import { BASE, check, context, devSignIn, DOCS_NAV, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const TITLE = `Личный план ${RUN}`;
const browser = await launch();
const ctxA = await context(browser);
const ctxB = await context(browser);
const ctxG = await context(browser);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
const g = await ctxG.newPage();
const api = (page, url, method = "GET", body) =>
  page.evaluate(
    async ([url, method, body]) => {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [url, method, body]
  );
const poke = (page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
try {
  await devSignIn(a, `Анна ${RUN}`);
  const team = (await api(a, "/api/ws", "POST", { name: `Команда ${RUN}` })).body.workspace.id;
  const token = String((await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "editor" })).body?.url ?? "").split("/join/")[1];
  await devSignIn(b, `Борис ${RUN}`);
  check("1 teammate joined as editor", (await api(b, "/api/join", "POST", { token })).body?.role === "editor");

  // A new page goes to the author's Private.
  await a.goto(`${BASE}/docs?ws=${team}#new`);
  await a.waitForSelector(".nt-title", { timeout: 60000 });
  await a.locator(".nt-title").click();
  await a.keyboard.type(TITLE);
  await a.keyboard.press("Enter");
  await a.keyboard.type("Секретный текст.");
  await a.waitForTimeout(3500);
  const sideA = await a.locator(DOCS_NAV).innerText();
  check("2 the page is in Private", sideA.includes("Личное") && sideA.includes(TITLE), sideA.slice(0, 300));
  const pageId = (await api(a, `/api/notes/sync?ws=${team}&since=0`)).body?.notes?.find((n) => n.title === TITLE)?.id;
  check("3 saved with the author's Private section", Boolean(pageId));

  await b.goto(`${BASE}/docs?ws=${team}`);
  await b.waitForSelector(DOCS_NAV, { timeout: 60000 });
  await b.waitForTimeout(3000);
  const pullB = await api(b, `/api/notes/sync?ws=${team}&since=0`);
  check("4 the teammate neither sees nor pulls it", !(await b.locator(DOCS_NAV).innerText()).includes(TITLE) && !JSON.stringify(pullB.body).includes(TITLE));

  // Share → add Boris with "Can comment".
  await a.locator(".nt-top-share").click();
  await a.waitForSelector(".nt-share-access", { timeout: 10000 });
  await a.locator(".nt-share-invite .nt-share-level").first().click();
  await a.getByRole("menuitem", { name: /Может комментировать/ }).click();
  // Notion's "Add people, groups, or emails": type a name, pick the match.
  await a.getByRole("textbox", { name: /Добавить людей, группы или e-mail/ }).fill(`Борис ${RUN}`);
  await a.getByRole("option", { name: new RegExp(`Борис ${RUN}`) }).click();
  await a.waitForTimeout(1500);
  const list = await a.locator(".nt-share-people").innerText();
  check("5 the Share menu lists Boris with Can comment", list.includes(`Борис ${RUN}`) && list.includes("Может комментировать"), list);
  await a.keyboard.press("Escape");

  await poke(b);
  await b.waitForTimeout(4000);
  const sideB = await b.locator(DOCS_NAV).innerText();
  check("6 the teammate finds it under Shared", sideB.includes("Общие со мной") && sideB.includes(TITLE), sideB.slice(0, 300));
  await b.locator(DOCS_NAV).getByText(TITLE).first().click();
  await b.waitForTimeout(2500);
  // Can comment: the page takes only suggestions from them (Notion's suggested edits), never edits.
  const editable = await b.locator('.nt-main .nt-editor:not([data-suggest="only"]) [contenteditable="true"]').count();
  check("7 opened for suggestions only", (await b.locator(".nt-main").innerText()).includes("Секретный текст") && editable === 0 && (await b.locator('.nt-main .nt-editor[data-suggest="only"]').count()) > 0, `editable=${editable}`);
  const addComment = b.getByRole("button", { name: "Добавить комментарий" });
  check("8 and may comment", (await addComment.count()) > 0);
  await addComment.first().click({ force: true });
  await b.locator(".nt-cm-new textarea").fill("Выглядит хорошо.");
  await b.keyboard.press("Enter");
  await b.waitForTimeout(3500);
  await poke(a);
  await a.waitForTimeout(4000);
  check("9 the author sees the comment", (await a.locator(".nt-main").innerText()).includes("Выглядит хорошо"));
  // An edit crafted through the API changes nothing but comments ("Can comment").
  await api(b, `/api/notes/sync?ws=${team}`, "POST", { items: [{ id: pageId, note: { id: pageId, parentId: null, kind: "page", title: "Взлом", icon: "", cover: null, content: [], order: 1, favorite: false, createdAt: 1, updatedAt: Date.now(), trashedAt: null } }] });
  const after = (await api(a, `/api/notes/sync?ws=${team}&since=0`)).body?.notes?.find((n) => n.id === pageId);
  check("10 an edit through the API changes nothing", after?.title === TITLE && JSON.stringify(after?.content ?? []).includes("Секретный текст"), after?.title);

  // A guest joins this one page by an invite link.
  const link = String((await api(a, `/api/notes/page-invite?ws=${team}&id=${pageId}`, "POST", { op: "create", level: "view" })).body?.url ?? "");
  await devSignIn(g, `Гость ${RUN}`);
  await g.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await g.getByRole("button", { name: "Открыть страницу" }).click();
  await g.waitForURL(/\/docs\?ws=/, { timeout: 30000 });
  await g.waitForSelector(DOCS_NAV, { timeout: 60000 });
  await g.waitForTimeout(4000);
  const sideG = await g.locator(DOCS_NAV).innerText();
  check("11 the guest sees only the shared page", sideG.includes(TITLE) && !sideG.includes("Личное") && (await g.locator(".nt-main").innerText()).includes("Секретный текст"), sideG.slice(0, 300));
  check("12 the guest cannot read the rest of the workspace", (await api(g, `/api/notes/sync?ws=${team}&since=0`)).body?.notes?.length === 1);

  check("13 no foreign hosts", [ctxA, ctxB, ctxG].every((c) => foreignHosts(c).length === 0));
  const errors = [ctxA, ctxB, ctxG].flatMap((c) => [...c.errors, ...c.failed]);
  check("14 no console errors / failed requests", errors.length === 0, errors.slice(0, 6).join(" | "));
} catch (e) {
  check("docs-sharing ran", false, String(e).slice(0, 400));
} finally {
  for (const [p, n] of [
    [a, "a"],
    [b, "b"],
    [g, "g"],
  ])
    await p.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-sharing-${n}.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
