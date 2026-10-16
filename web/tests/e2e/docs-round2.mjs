// Documents, Notion parity round 2 in the browser: a commenter starts an
// inline discussion on a page that reads only; a page turns into a wiki and
// one of its pages is verified from its header; a page moves to another
// workspace. Russian labels.
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-round2.mjs
import { BASE, DOCS_NAV, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const TITLE = `Справочник ${RUN}`;
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
const noteOf = async (page, ws, id) => (await api(page, `/api/notes/sync?ws=${ws}&since=0`)).body?.notes?.find((n) => n.id === id);
try {
  await devSignIn(a, `Анна ${RUN}`);
  const team = (await api(a, "/api/ws", "POST", { name: `Команда ${RUN}` })).body.workspace.id;
  const token = String((await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "commenter" })).body?.url ?? "").split("/join/")[1];
  await devSignIn(k, `Кира ${RUN}`);
  check("1 a commenter joined", (await api(k, "/api/join", "POST", { token })).body?.role === "commenter");

  // Anna writes a page in the workspace's section (the commenter can read it).
  await a.goto(`${BASE}/docs?ws=${team}`);
  await a.waitForSelector(DOCS_NAV, { timeout: 60000 });
  const now = Date.now();
  const id = `r2page${RUN}aaaaaaaa`.slice(0, 20);
  const sub = `r2sub${RUN}bbbbbbbbbb`.slice(0, 20);
  const para = (text) => ({ id: `b${RUN}`, type: "paragraph", props: { textColor: "default", backgroundColor: "default", textAlignment: "left" }, content: [{ type: "text", text, styles: {} }], children: [] });
  const base = { icon: "", cover: null, order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null };
  const put = await api(a, `/api/notes/sync?ws=${team}`, "POST", {
    items: [
      { id, note: { ...base, id, parentId: null, space: "", kind: "page", title: TITLE, content: [para("Отпуск согласует руководитель.")] } },
      { id: sub, note: { ...base, id: sub, parentId: id, kind: "page", title: `Отпуск ${RUN}`, content: [] } },
    ],
  });
  check("2 the pages are saved", put.status === 200 && (put.body?.rejected ?? []).length === 0, JSON.stringify(put.body).slice(0, 200));

  // Kira selects text and comments on it.
  await k.goto(`${BASE}/docs?ws=${team}#${id}`);
  await k.waitForSelector(".nt-main .bn-editor", { timeout: 60000 });
  await k.waitForTimeout(2500);
  // Can comment: her typing would be a suggestion (Notion's suggested edits), never an edit.
  check("3 the page takes only suggestions from her", (await k.locator('.nt-main .nt-editor[data-suggest="only"]').count()) > 0 && (await k.locator('.nt-main .nt-editor:not([data-suggest]) [contenteditable="true"]').count()) === 0);
  await k.evaluate(() => {
    const el = [...document.querySelectorAll(".nt-main .bn-inline-content")].find((x) => x.textContent?.includes("руководитель"));
    const text = el && document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) return;
    const r = document.createRange();
    r.setStart(text, text.textContent.indexOf("руководитель"));
    r.setEnd(text, text.textContent.indexOf("руководитель") + "руководитель".length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await k.waitForSelector(".nt-cm-pick", { timeout: 5000 });
  await k.locator(".nt-cm-pick").click();
  await k.locator(".nt-thread .nt-cm-new textarea").fill("Какой именно?");
  await k.keyboard.press("Enter");
  await k.waitForTimeout(4000);
  const after = await noteOf(a, team, id);
  const marked = JSON.stringify(after?.content ?? []);
  check("4 her comment and its mark are on the page", (after?.comments ?? []).some((c) => c.text.includes("Какой именно") && c.thread) && marked.includes('"comment"'), marked.slice(0, 300));
  const words = (after?.content ?? []).flatMap((b) => (b.content ?? []).map((x) => x.text ?? "")).join("");
  check("5 the text itself is unchanged", words === "Отпуск согласует руководитель.", words);
  // Anything else from her is refused (the body stays).
  await api(k, `/api/notes/sync?ws=${team}`, "POST", { items: [{ id, note: { ...after, content: [para("Взлом")] } }] });
  check("6 an edit through the API changes nothing", JSON.stringify((await noteOf(a, team, id))?.content).includes("руководитель"));

  // Anna turns the page into a wiki from its "…" menu.
  await a.goto(`${BASE}/docs?ws=${team}#${id}`);
  await a.waitForSelector(".nt-title", { timeout: 60000 });
  await a.waitForTimeout(1500);
  await a.getByRole("button", { name: "Стиль, экспорт и другое…" }).click();
  await a.getByText("Превратить в вики").click();
  await a.waitForTimeout(3500);
  const wiki = await noteOf(a, team, id);
  check("7 the page is a wiki with Owner and Verification", wiki?.kind === "database" && Boolean(wiki?.db?.wiki?.verification) && Boolean(wiki?.db?.wiki?.owner));
  check("8 its body stays above its pages", (await a.locator(".nt-main").innerText()).includes("руководитель") && (await a.locator(".nt-main").innerText()).includes(`Отпуск ${RUN}`));

  // Anna verifies the wiki page from its header.
  await a.goto(`${BASE}/docs?ws=${team}#${sub}`);
  await a.waitForSelector(".nt-verify-btn", { timeout: 60000 });
  await a.locator(".nt-verify-btn").click();
  await a.getByRole("menuitem", { name: /На 30 дней/ }).click();
  await a.waitForTimeout(3500);
  const v = (await noteOf(a, team, sub))?.props?.[wiki?.db?.wiki?.verification];
  check("9 verified for 30 days by her", v?.state === "verified" && Boolean(v?.until) && (await a.locator(".nt-page-verify").innerText()).includes("Подтверждено"), JSON.stringify(v));
  const cur = await noteOf(k, team, sub);
  await api(k, `/api/notes/sync?ws=${team}`, "POST", { items: [{ id: sub, note: { ...cur, props: { ...cur.props, [wiki.db.wiki.verification]: { state: "unverified" } } } }] });
  check("10 the commenter cannot take it away", (await noteOf(a, team, sub))?.props?.[wiki.db.wiki.verification]?.state === "verified");

  // A page moves to Anna's other workspace.
  const other = (await api(a, "/api/ws", "POST", { name: `Второе ${RUN}` })).body.workspace.id;
  const lone = `r2lone${RUN}cccccccc`.slice(0, 20);
  await api(a, `/api/notes/sync?ws=${team}`, "POST", { items: [{ id: lone, note: { ...base, id: lone, parentId: null, space: "private", kind: "page", title: `Черновик ${RUN}`, content: [] } }] });
  const mv = await api(a, "/api/notes/move-workspace", "POST", { from: team, to: other, noteId: lone });
  check("11 moved to the other workspace", mv.status === 200 && mv.body?.moved === 1 && !(await noteOf(a, team, lone)) && Boolean(await noteOf(a, other, lone)), JSON.stringify(mv.body));

  check("12 no foreign hosts", [ctxA, ctxK].every((c) => foreignHosts(c).length === 0));
  const errors = [ctxA, ctxK].flatMap((c) => [...c.errors, ...c.failed]);
  check("13 no console errors / failed requests", errors.length === 0, errors.slice(0, 6).join(" | "));
} catch (e) {
  check("docs-round2 ran", false, String(e).slice(0, 400));
} finally {
  for (const [p, n] of [
    [a, "a"],
    [k, "k"],
  ])
    await p.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-round2-${n}.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
