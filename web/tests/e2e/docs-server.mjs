// Documents' server features end to end, through the HTTP APIs a browser and
// an integration use: a form response runs a database automation on the
// server, a published page is server-rendered for visitors without scripts,
// the public API reads only pages connected to the integration, map tiles
// come through our server.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-server.mjs
import { BASE, check, context, devSignIn, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const ctx = await context(browser);
const a = await ctx.newPage();
const anon = await browser.newContext();
const api = async (c, path, method = "GET", data, headers = {}) => {
  const r = await c.request.fetch(`${BASE}${path}`, { method, data, headers: { origin: BASE, ...headers } });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status(), body, headers: r.headers() };
};
const now = Date.now();
const note = (id, extra) => ({ id, parentId: null, kind: "page", title: "", icon: "", cover: null, content: [], order: now, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, ...extra });
const nid = (k) => `${k}${RUN}${Math.random().toString(36).slice(2, 12)}`.padEnd(24, "x").slice(0, 32);
try {
  await devSignIn(a, `Сервер ${RUN}`);
  const ws = (await api(a, "/api/ws", "POST", { name: `Сервер ${RUN}` })).body.workspace.id;
  const push = (notes) => api(a, `/api/notes/sync?ws=${ws}`, "POST", { items: notes.map((n) => ({ id: n.id, note: n })) });
  const pull = async () => (await api(a, `/api/notes/sync?ws=${ws}&since=0`)).body;

  // 1. A database with "when a page is added → set Status", and a form view.
  const dbId = nid("db");
  const db = note(dbId, {
    kind: "database",
    title: "Заявки",
    db: {
      properties: [
        { id: "title", name: "Имя", type: "title" },
        { id: "st", name: "Статус", type: "select", options: [{ id: "new", name: "Новая", color: "blue" }] },
      ],
      views: [
        { id: "v1", name: "Таблица", type: "table", filters: [], sorts: [], hidden: [], widths: {} },
        { id: "vf", name: "Форма", type: "form", filters: [], sorts: [], hidden: [], widths: {}, form: { questions: [{ prop: "title", required: true }] } },
      ],
      automations: [{ id: "a1", name: "Новая заявка", on: true, trigger: { type: "added" }, actions: [{ type: "set", prop: "st", value: "new" }] }],
    },
  });
  check("1 database saved", (await push([db])).body?.saved?.includes(dbId));
  const form = await api(a, `/api/notes/form?ws=${ws}`, "POST", { dbId, viewId: "vf" });
  const formId = form.body?.id;
  db.db.views[1].form.shareId = formId;
  db.updatedAt = Date.now();
  await push([db]);
  const answer = await anon.request.fetch(`${BASE}/api/notes/form/${formId}`, { method: "POST", data: { answers: { title: "Пётр" } }, headers: { origin: BASE } });
  check("2 a visitor answers the form", answer.status() === 200, String(answer.status()));
  const rows = (await pull()).notes.filter((n) => n.parentId === dbId);
  check("3 the response is a row, and the automation set its status on the server", rows.length === 1 && rows[0].title === "Пётр" && rows[0].props?.st === "new", JSON.stringify(rows.map((r) => [r.title, r.props])));

  // 3b. Conditional logic (Notion Forms): "Steps" shows only for a bug, and only then is required.
  const ldb = nid("lg");
  const logic = note(ldb, {
    kind: "database",
    title: "Отзывы",
    db: {
      properties: [
        { id: "title", name: "Имя", type: "title" },
        { id: "kind", name: "Что это", type: "select", options: [{ id: "bug", name: "Ошибка", color: "red" }, { id: "idea", name: "Идея", color: "blue" }] },
        { id: "steps", name: "Как повторить", type: "text" },
      ],
      views: [{ id: "lf", name: "Форма", type: "form", filters: [], sorts: [], hidden: [], widths: {}, form: { questions: [{ prop: "title" }, { prop: "kind" }, { prop: "steps", required: true, when: { prop: "kind", op: "is", value: "bug" } }] } }],
    },
  });
  await push([logic]);
  const lform = (await api(a, `/api/notes/form?ws=${ws}`, "POST", { dbId: ldb, viewId: "lf" })).body?.id;
  logic.db.views[0].form.shareId = lform;
  logic.updatedAt = Date.now();
  await push([logic]);
  const v = await anon.newPage();
  await v.goto(`${BASE}/f/${lform}`);
  await v.locator(".nt-ff").first().waitFor({ timeout: 15000 });
  const before = await v.locator(".nt-ff").count();
  await v.getByText("Ошибка", { exact: true }).click();
  const after = await v.locator(".nt-ff").count();
  await v.getByText("Идея", { exact: true }).click();
  const back = await v.locator(".nt-ff").count();
  check("3b a question shows only when an earlier answer calls for it", before === 2 && after === 3 && back === 2, `${before} → ${after} → ${back}`);
  // Form-builder phishing: a public form warns against passwords and links "Report abuse" to its own address.
  const warned = await v.locator('[data-test="form-no-passwords"]').isVisible();
  const reportHref = (await v.locator('[data-test="form-report"]').getAttribute("href")) ?? "";
  check("3b' a public form says never to submit passwords and can be reported", warned && reportHref.includes(encodeURIComponent(`/f/${lform}`)), `${warned} ${reportHref}`);
  await v.locator(".nt-ff input[type=text], .nt-ff input:not([type])").first().fill("Ольга");
  await v.getByRole("button", { name: /Отправить|Submit/ }).click();
  const sent = await v.locator(".nt-formpage-done, .nt-form-done, [data-state=sent]").first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  const lrows = (await pull()).notes.filter((n) => n.parentId === ldb);
  check("3c a hidden required question does not hold the response back", lrows.length === 1 && lrows[0].title === "Ольга" && lrows[0].props?.kind === "idea", `${sent} ${JSON.stringify(lrows.map((r) => [r.title, r.props]))}`);
  await v.close();
  // 3d. Only members may answer (Notion's "Only people in your workspace"): a visitor is asked to sign in.
  logic.db.views[0].form.access = "workspace";
  logic.updatedAt = Date.now();
  await push([logic]);
  const g = await anon.newPage();
  await g.goto(`${BASE}/f/${lform}`);
  const gated = await g.locator('[data-test="form-gate"]').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  // Not even the page's HTML names the questions to someone outside.
  const gateHtml = await (await anon.request.fetch(`${BASE}/f/${lform}`)).text();
  const leaks = ["Как повторить", "Что это", "Ошибка"].filter((x) => gateHtml.includes(x));
  const refused = await anon.request.fetch(`${BASE}/api/notes/form/${lform}`, { method: "POST", data: { answers: { title: "Чужой" } }, headers: { origin: BASE } });
  await a.goto(`${BASE}/f/${lform}`);
  const memberSees = await a.locator('[data-test="form-recorded"]').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check("3d a members-only form: visitors are asked to sign in (and refused, its questions unseen), a member answers under their name", gated && leaks.length === 0 && refused.status() === 401 && memberSees, `${gated} ${leaks.join(",")} ${refused.status()} ${memberSees}`);
  await g.close();
  // 3e. A chart split into series (Notion Charts' "Group by"): stacked columns and a legend.
  const cdb = nid("ch");
  const mk = (title, st, team) => note(nid("cr"), { parentId: cdb, title, props: { st, team } });
  await push([
    note(cdb, {
      kind: "database",
      title: "Задачи по командам",
      db: {
        properties: [
          { id: "title", name: "Имя", type: "title" },
          { id: "st", name: "Статус", type: "select", options: [{ id: "todo", name: "Сделать", color: "gray" }, { id: "done", name: "Готово", color: "green" }] },
          { id: "team", name: "Команда", type: "select", options: [{ id: "web", name: "Веб", color: "blue" }, { id: "ios", name: "iOS", color: "orange" }] },
        ],
        views: [
          { id: "vc", name: "График", type: "chart", filters: [], sorts: [], hidden: [], widths: {}, chart: { type: "column", x: "st", group: "team" } },
          { id: "vt", name: "Готовые", type: "table", filters: [{ id: "f1", prop: "st", op: "is", value: "done" }], sorts: [], hidden: [], widths: {} },
        ],
      },
    }),
    mk("a", "todo", "web"),
    mk("b", "todo", "ios"),
    mk("c", "done", "web"),
  ]);
  await a.goto(`${BASE}/docs?ws=${ws}#${cdb}`);
  const legend = await a.locator('[data-test="chart-legend"] .nt-chart-legend-row').count().then(async (n) => n || (await a.locator('[data-test="chart-legend"]').waitFor({ timeout: 15000 }).then(() => a.locator('[data-test="chart-legend"] .nt-chart-legend-row').count()).catch(() => 0)));
  const segs = await a.locator(".nt-chart rect[data-series]").count();
  check("3e a chart grouped by a second property stacks its columns, with a legend", legend === 2 && segs >= 3, `${legend} series, ${segs} segments`);
  // 3f. A link to a view (Notion's "Copy link to view") opens the database on it.
  await a.goto(`${BASE}/docs?ws=${ws}#${cdb}&v=vt`);
  const onView = await a.waitForFunction(() => document.querySelector('.nt-db-tab[aria-selected="true"]')?.textContent?.includes("Готовые"), null, { timeout: 15000 }).then(() => true).catch(() => false);
  check("3f a link to a view opens on that view", onView, (await a.locator('.nt-db-tab[aria-selected="true"]').first().innerText().catch(() => "")));
  // 3g. A simple table turns into a database (Notion): the header row names the properties, each row a page.
  const cell = (text) => ({ type: "tableCell", content: [{ type: "text", text, styles: {} }], props: { backgroundColor: "default", textColor: "default", textAlignment: "left", colspan: 1, rowspan: 1 } });
  const tp = nid("tp");
  await push([
    note(tp, {
      title: "Таблица",
      content: [
        { id: `tb${RUN}`, type: "table", props: { textColor: "default" }, content: { type: "tableContent", columnWidths: [null, null], headerRows: 1, rows: [{ cells: [cell("Город"), cell("Страна")] }, { cells: [cell("Лиссабон"), cell("Португалия")] }, { cells: [cell("Осло"), cell("Норвегия")] }] }, children: [] },
      ],
    }),
  ]);
  await a.goto(`${BASE}/docs?ws=${ws}#${tp}`);
  await a.locator(".nt-main .bn-editor").getByText("Лиссабон").click();
  await a.keyboard.press("Control+/");
  await a.getByRole("menuitem", { name: /Превратить в базу данных|Turn into database/ }).click({ timeout: 10000 });
  const converted = await (async () => {
    for (let i = 0; i < 20; i++) {
      await a.waitForTimeout(500);
      const all = (await pull()).notes;
      const db = all.find((n) => n.kind === "database" && n.parentId === tp);
      const rows = db ? all.filter((n) => n.parentId === db.id) : [];
      if (db && rows.length === 2 && db.db?.properties?.[0]?.name === "Город" && db.db.properties[1]?.name === "Страна" && rows.some((r) => r.title === "Осло" && Object.values(r.props ?? {}).includes("Норвегия"))) return true;
    }
    return false;
  })();
  check("3g a simple table turns into a database", converted && (await a.locator(".nt-main .nt-inline-db").count()) === 1);

  // 1b. A page that reached the server after this device's store (made elsewhere): its link opens it, never "No access".
  await a.goto(`${BASE}/docs?ws=${ws}`);
  await a.waitForSelector(".nt-rail:not(.nt-rail-loading), .nt-side", { timeout: 60000 });
  await a.waitForTimeout(1500);
  const late = note(nid("lt"), { title: `Made elsewhere ${RUN}` });
  await push([late]);
  let opened = 0;
  for (let i = 0; i < 4; i++) {
    await a.goto(`${BASE}/docs?ws=${ws}#${late.id}`);
    const title = await a.locator(".nt-title").first().inputValue({ timeout: 15000 }).catch(() => "");
    const refused = await a.locator(".nt-noaccess h1").count();
    if (title === `Made elsewhere ${RUN}` && refused === 0) opened++;
  }
  check("3b an own page's link opens it, every time (no false 'No access')", opened === 4, `${opened}/4`);

  // 2. A published page, rendered on the server.
  const pageId = nid("pg");
  const text = `Публичный текст ${RUN}`;
  const page = note(pageId, { title: `Открытая ${RUN}`, content: [{ id: "b1", type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] }] });
  await push([page]);
  const share = await api(a, `/api/notes/share?ws=${ws}`, "POST", { noteId: pageId, snapshot: { notes: [page], rootId: pageId } });
  const shareId = share.body?.id;
  const html = await (await anon.request.get(`${BASE}/n/${shareId}`)).text();
  check("4 the published page's text is in the server's HTML", html.includes(text), `share ${share.status}`);
  check("5 no comments or ids of people leak into it", !html.includes("authorId") && !html.includes("createdBy"));
  // 5b. Published pages stay current (Notion's are live): an edit reaches the public page by itself.
  await push([{ ...page, share: { id: shareId, key: `k${RUN}`.padEnd(40, "x"), at: Date.now() - 60_000 }, updatedAt: Date.now() - 120_000 }]);
  await a.goto(`${BASE}/docs?ws=${ws}#${pageId}`);
  await a.locator(".nt-main .bn-editor").getByText(text).click();
  await a.keyboard.press("End");
  await a.keyboard.type(" и ещё строчка");
  let live = false;
  for (let i = 0; i < 20 && !live; i++) {
    await a.waitForTimeout(1000);
    live = (await (await anon.request.get(`${BASE}/n/${shareId}`)).text()).includes("и ещё строчка");
  }
  check("5b an edit reaches the published page without pressing Update", live);

  // 3. The public API sees connected pages only.
  const secretPage = note(nid("sp"), { title: "Не подключена" });
  await push([secretPage]);
  const integ = await api(a, `/api/notes/integrations?ws=${ws}`, "POST", { name: "Бот", caps: { read: true, update: true, insert: true, readComments: true, insertComments: true, users: "names" } });
  const secret = integ.body?.secret;
  check("6 an integration gets a secret once", typeof secret === "string" && secret.startsWith("zv_secret_"), JSON.stringify(integ.body).slice(0, 120));
  await api(a, `/api/notes/connections?ws=${ws}`, "POST", { integration: integ.body?.integration?.id, noteId: pageId });
  const auth = { authorization: `Bearer ${secret}` };
  const got = await anon.request.get(`${BASE}/api/v1/pages/${pageId}`, { headers: auth });
  const gotJson = await got.json().catch(() => null);
  check("7 the API reads the connected page", got.status() === 200 && gotJson?.object === "page", `${got.status()}`);
  const hidden = await anon.request.get(`${BASE}/api/v1/pages/${secretPage.id}`, { headers: auth });
  check("8 …and not a page that is not connected", hidden.status() === 404, `${hidden.status()}`);
  const noAuth = await anon.request.get(`${BASE}/api/v1/pages/${pageId}`);
  check("9 without a token: 401", noAuth.status() === 401, `${noAuth.status()}`);

  // 4. Map tiles come from our server (the browser never calls the map host).
  const tile = await a.request.get(`${BASE}/api/maps/tile/2/1/1.png`);
  check("10 a map tile through the server", tile.status() === 200 && (tile.headers()["content-type"] ?? "").startsWith("image/"), `${tile.status()} ${tile.headers()["content-type"]}`);
  const tileAnon = await anon.request.get(`${BASE}/api/maps/tile/2/1/1.png`);
  check("11 …for signed-in people only", tileAnon.status() === 401, `${tileAnon.status()}`);
} catch (e) {
  check("docs-server ran", false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
