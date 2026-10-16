// Documents, databases with several data sources (Notion, 2025) in the
// browser: a database gets a second data source from "+", its tab says so,
// rows land in the source shown, "New view" asks which source, the Data
// sources panel renames one, conditional color paints a row, a teammate
// without access to a source sees it closed, and a source becomes a
// database of its own. Russian labels.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-sources.mjs
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const ctxA = await context(browser);
const ctxK = await context(browser);
const a = await ctxA.newPage();
const k = await ctxK.newPage();
const api = (page, url, method = "GET", body) =>
  page.evaluate(
    async ([url, method, body]) => {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [url, method, body]
  );
const all = async (page, ws) => (await api(page, `/api/notes/sync?ws=${ws}&since=0`)).body?.notes ?? [];
const noteOf = async (page, ws, id) => (await all(page, ws)).find((n) => n.id === id);
const db = async (page, ws, id) => (await noteOf(page, ws, id))?.db;
/** The menu item labelled exactly so (its hint aside), in the menu opened last. */
const item = (page, name) => page.locator(".nt-mi", { has: page.locator(".nt-mi-label", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).last();
try {
  await devSignIn(a, `Анна ${RUN}`);
  const team = (await api(a, "/api/ws", "POST", { name: `Источники ${RUN}` })).body.workspace.id;
  const token = String((await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "editor" })).body?.url ?? "").split("/join/")[1];
  await devSignIn(k, `Кира ${RUN}`);
  check("1 a teammate joined", (await api(k, "/api/join", "POST", { token })).body?.role === "editor");

  // Anna's database "Проекты" (one data source, as every database before) with two rows.
  await a.goto(`${BASE}/docs?ws=${team}`);
  await a.waitForTimeout(2000);
  const now = Date.now();
  const id = `dsdb${RUN}aaaaaaaaaaaa`.slice(0, 20);
  const base = { icon: "", cover: null, content: [], favorite: false, createdAt: now, updatedAt: now, trashedAt: null };
  const schema = { properties: [{ id: "title", name: "Название", type: "title" }, { id: "stage", name: "Этап", type: "text" }], views: [{ id: "tbl", name: "Все проекты", type: "table", filters: [], sorts: [], hidden: [], widths: {} }] };
  const put = await api(a, `/api/notes/sync?ws=${team}`, "POST", {
    items: [
      { id, note: { ...base, id, parentId: null, space: "", kind: "database", title: `Проекты ${RUN}`, order: 1, db: schema } },
      { id: `${id}r1`, note: { ...base, id: `${id}r1`, parentId: id, kind: "page", title: "Запуск", order: 1, props: { stage: "идёт" } } },
      { id: `${id}r2`, note: { ...base, id: `${id}r2`, parentId: id, kind: "page", title: "Тест", order: 2, props: { stage: "план" } } },
    ],
  });
  check("2 the database is saved", put.status === 200 && (put.body?.rejected ?? []).length === 0, JSON.stringify(put.body).slice(0, 200));

  // "+" → "New data source": a second source with a tab of its own.
  await a.goto(`${BASE}/docs?ws=${team}#${id}`);
  await a.waitForSelector(".nt-db-tabs", { timeout: 60000 });
  await a.waitForTimeout(1500);
  await a.getByRole("button", { name: "Добавить вид", exact: true }).click();
  await item(a, "Новый источник данных").click();
  await a.waitForTimeout(3500);
  const kids = (await all(a, team)).filter((n) => n.parentId === id && n.kind === "database");
  const src = kids[0];
  check("3 a data source is created inside the database", kids.length === 1 && src?.db?.dataSource === true, JSON.stringify(kids.map((n) => n.title)));
  const tabs = await a.locator(".nt-db-tab").allInnerTexts();
  check("4 the view tabs say which source they show", tabs.some((x) => x.includes("Новый источник данных")) && tabs.some((x) => x.includes(`Проекты ${RUN}`)), tabs.join(" | "));
  check("5 the new source's view is a tab of the database", (await db(a, team, id))?.views.some((v) => v.source === src?.id));

  // A row added in that tab belongs to the new source.
  await a.locator(".nt-db-new button").first().click();
  await a.waitForTimeout(2500);
  await a.keyboard.press("Escape");
  await a.waitForTimeout(2500);
  const srcRows = (await all(a, team)).filter((n) => n.parentId === src?.id && n.kind === "page");
  check("6 a new row goes to the source shown", srcRows.length === 1, String(srcRows.length));
  check("7 the database keeps its own rows", (await all(a, team)).filter((n) => n.parentId === id && n.kind === "page").length === 2);

  // "New view" asks which source: a board of the first one.
  await a.getByRole("button", { name: "Добавить вид", exact: true }).click();
  const asks = await a.getByText("Данные из", { exact: true }).count();
  await item(a, `Проекты ${RUN}`).click();
  await item(a, "Доска").click();
  await a.waitForTimeout(3000);
  const views = (await db(a, team, id))?.views ?? [];
  const board = views.find((v) => v.type === "board");
  check("8 New view asks for the data source and makes a view of the one picked", asks > 0 && Boolean(board) && !board?.source, JSON.stringify(views.map((v) => [v.type, v.source ?? "own"])));

  // The Data sources panel: rename the new source.
  await a.locator(".nt-db-tab").filter({ hasText: "Все проекты" }).click();
  await a.waitForTimeout(800);
  await a.getByRole("button", { name: "Оформление", exact: true }).click();
  await item(a, "Источник данных").click();
  await item(a, "Источники данных базы").click();
  await a.waitForSelector('[data-testid="sources-panel"]', { timeout: 5000 });
  const panelRows = await a.locator(".nt-srcpanel-row").count();
  const box = await a.locator('[data-testid="sources-panel"]').boundingBox();
  if (process.env.SHOTS) await a.screenshot({ path: `${process.env.SHOTS}/docs-sources-panel.png` });
  await a.locator('.nt-srcpanel-row[data-kind="child"] button').click();
  await item(a, "Переименовать").click();
  await a.locator('.nt-srcpanel-row[data-kind="child"] input').fill(`Задачи ${RUN}`);
  await a.keyboard.press("Enter");
  await a.waitForTimeout(3000);
  check("9 the panel lists both sources and renames one", panelRows === 2 && (await noteOf(a, team, src?.id))?.title === `Задачи ${RUN}`, String(panelRows));
  check("9b the panel opens beside the view menu", Boolean(box && box.x > 400 && box.y > 150), JSON.stringify(box));
  await a.keyboard.press("Escape");
  await a.keyboard.press("Escape");
  await a.waitForTimeout(500);

  // Conditional color: rows whose title contains "Запуск" turn red.
  await a.getByRole("button", { name: "Оформление", exact: true }).click();
  await item(a, "Условный цвет").click();
  await a.waitForSelector('[data-testid="color-panel"]', { timeout: 5000 });
  await a.getByText("Добавить правило цвета", { exact: true }).click();
  await a.locator('[data-testid="color-rule"] .nt-advf-value').fill("Запуск");
  await a.waitForTimeout(3000);
  const red = await a.locator('.nt-tr-body[data-ccolor="red"]').allInnerTexts();
  if (process.env.SHOTS) await a.screenshot({ path: `${process.env.SHOTS}/docs-sources-color.png` });
  check("10 conditional color paints the matching row only", red.length === 1 && red[0].includes("Запуск"), JSON.stringify(red));
  check("11 the rule is saved in the view", ((await db(a, team, id))?.views.find((v) => v.id === "tbl")?.colors ?? []).length === 1);
  await a.keyboard.press("Escape");
  await a.keyboard.press("Escape");

  // Kira sees both sources; once Anna restricts the new one, its tab says it is closed.
  await k.goto(`${BASE}/docs?ws=${team}#${id}`);
  await k.waitForSelector(".nt-db-tabs", { timeout: 60000 });
  await k.waitForTimeout(2000);
  check("12 a teammate reads the second source", (await all(k, team)).some((n) => n.parentId === src?.id && n.kind === "page"));
  const lock = await api(a, `/api/notes/access?ws=${team}&id=${src?.id}`, "POST", { op: "general", restricted: true });
  await k.goto(`${BASE}/docs?ws=${team}#${id}`);
  await k.waitForSelector(".nt-db-tabs", { timeout: 60000 });
  await k.waitForTimeout(3000);
  await k.locator(".nt-db-tab").filter({ hasText: "Нет доступа" }).first().click();
  await k.waitForTimeout(1000);
  check("13 a restricted source stays closed to her", lock.status === 200 && (await k.locator('[data-testid="source-missing"]').count()) === 1 && !(await all(k, team)).some((n) => n.parentId === src?.id));

  // Turn the source into a database of its own.
  await a.goto(`${BASE}/docs?ws=${team}#${id}`);
  await a.waitForSelector(".nt-db-tabs", { timeout: 60000 });
  await a.waitForTimeout(1500);
  await a.getByRole("button", { name: "Оформление", exact: true }).click();
  await item(a, "Источник данных").click();
  await item(a, "Источники данных базы").click();
  await a.locator('.nt-srcpanel-row[data-kind="child"] button').click();
  await item(a, "Превратить в базу данных").click();
  await a.waitForTimeout(3500);
  const split = await noteOf(a, team, src?.id);
  const left = (await db(a, team, id))?.views ?? [];
  check("14 the source is a database of its own now, with its tab", split?.parentId === null && !split?.db?.dataSource && (split?.db?.views ?? []).some((v) => v.type === "table") && !left.some((v) => v.source === src?.id), JSON.stringify({ parent: split?.parentId, ds: split?.db?.dataSource, left: left.map((v) => v.source ?? "own") }));
  check("15 its rows went with it", (await all(a, team)).filter((n) => n.parentId === src?.id && n.kind === "page").length === 1);

  check("16 no foreign hosts", [ctxA, ctxK].every((c) => foreignHosts(c).length === 0));
  const errors = [ctxA, ctxK].flatMap((c) => [...c.errors, ...c.failed]);
  check("17 no console errors / failed requests", errors.length === 0, errors.slice(0, 6).join(" | "));
} catch (e) {
  check("docs-sources ran", false, String(e).slice(0, 400));
  console.log([ctxA, ctxK].flatMap((c) => [...c.errors, ...c.failed]).slice(0, 8).join("\n"));
} finally {
  for (const [p, n] of [
    [a, "a"],
    [k, "k"],
  ])
    await p.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-sources-${n}.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
