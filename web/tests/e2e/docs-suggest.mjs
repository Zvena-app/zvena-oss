// Documents: suggested edits (Notion's "Suggest edits"), live in two
// browsers. A commenter's typing becomes suggestions (inserted text
// underlined, removed text struck, her face in the margin); the editor sees
// them at once, accepts one and rejects the other from their cards; the
// Inbox and the page history follow; the commenter cannot accept her own
// through the API. Then the editor suggests too (••• → Suggest edits) and
// accepts everything from the page menu.
//   E2E_LANG=ru BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/docs-suggest.mjs
import { BASE, check, context, devSignIn, foreignHosts, launch, LANG, summary } from "./lib.mjs";

const RU = LANG === "ru";
const L = {
  more: RU ? "Стиль, экспорт и другое…" : "Style, export, and more…",
  suggestEdits: RU ? "Предлагать правки" : "Suggest edits",
  acceptAll: RU ? "Принять все предложения" : "Accept all suggestions",
  suggesting: RU ? "Предложения" : "Suggesting",
};
const RUN = Math.random().toString(36).slice(2, 7);
const TITLE = `Предложения ${RUN}`;
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
async function within(ms, fn) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn().catch(() => false)) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 150));
  }
  return -1;
}
const noteOf = async (page, team, id) => ((await api(page, `/api/notes/sync?ws=${team}&since=0`)).body?.notes ?? []).find((n) => n.id === id);
/** The page's text as written (the others' cursors left out). */
const body = (p) =>
  p.locator(".nt-main .bn-editor").evaluate((el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll(".bn-collaboration-cursor__label, .bn-collaboration-cursor__caret").forEach((x) => x.remove());
    // Spaces collapsed: a removed word leaves the spaces around it, as in Notion.
    return (c.textContent ?? "").replace(/\u2060/g, "").replace(/\s+/g, " ");
  });
const marked = (p, sel) => p.locator(`.nt-main ${sel}`).evaluateAll((els) => els.map((e) => e.textContent ?? "").join("|"));
/** Puts the caret right after `text` in the page (by DOM range; the editor follows the selection). */
const caretAfter = (p, text) =>
  p.evaluate((text) => {
    const walk = document.createTreeWalker(document.querySelector(".nt-main .bn-editor"), NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.textContent.indexOf(text);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + text.length);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return true;
    }
    return false;
  }, text);

try {
  await devSignIn(a, `Анна ${RUN}`);
  const team = (await api(a, "/api/ws", "POST", { name: `Правки ${RUN}` })).body.workspace.id;
  const token = String((await api(a, `/api/ws/invites?ws=${team}`, "POST", { role: "commenter" })).body?.url ?? "").split("/join/")[1];
  await devSignIn(k, `Кира ${RUN}`);
  check("1 a commenter joined", (await api(k, "/api/join", "POST", { token })).body?.role === "commenter");

  // Anna's page, in the workspace's section.
  await a.goto(`${BASE}/docs?ws=${team}`);
  await a.waitForSelector(".nt-rail:not(.nt-rail-loading), .nt-side", { timeout: 60000 });
  const now = Date.now();
  const id = `sg${RUN}pageaaaaaa`.slice(0, 18);
  const para = (bid, text) => ({ id: bid, type: "paragraph", props: { textColor: "default", backgroundColor: "default", textAlignment: "left" }, content: [{ type: "text", text, styles: {} }], children: [] });
  const put = await api(a, `/api/notes/sync?ws=${team}`, "POST", {
    items: [{ id, note: { id, parentId: null, space: "", kind: "page", title: TITLE, icon: "", cover: null, order: 1, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, content: [para(`b1${RUN}`, "Alpha beta gamma."), para(`b2${RUN}`, "Second line.")] } }],
  });
  check("2 the page is saved", put.status === 200 && (put.body?.rejected ?? []).length === 0, JSON.stringify(put.body).slice(0, 200));

  // Both open it: a live session.
  await a.goto(`${BASE}/docs?ws=${team}#${id}`);
  await k.goto(`${BASE}/docs?ws=${team}#${id}`);
  await a.waitForSelector(".nt-main .bn-editor", { timeout: 60000 });
  await k.waitForSelector(".nt-main .bn-editor", { timeout: 60000 });
  await within(10000, async () => (await body(k)).includes("Alpha beta gamma."));
  // Both in the live session (Anna sees Kira's face); a session that fell back to sync on a slow machine is opened again.
  const inSession = () => within(12000, async () => ((await a.locator(".nt-top-faces").getAttribute("aria-label").catch(() => null)) ?? "").includes(`Кира ${RUN}`));
  if ((await inSession()) < 0) {
    await k.reload();
    await k.waitForSelector(".nt-main .bn-editor", { timeout: 60000 });
    await inSession();
  }
  await k.waitForTimeout(1500);
  const only = await k.locator('.nt-main .nt-editor[data-suggest="only"] [contenteditable="true"]').count();
  check("3 the commenter's page takes suggestions only", only > 0 && (await k.locator(".nt-sug-chip").count()) > 0, `editable=${only}`);

  // Kira types after "gamma." — a suggestion, not an edit.
  await k.locator(".nt-main .bn-editor").getByText("Alpha beta gamma.").click();
  await caretAfter(k, "gamma.");
  await k.keyboard.type(" delta");
  const insK = await within(4000, async () => (await marked(k, ".nt-sins")).includes("delta"));
  check("4 her typing shows as a suggestion (underlined)", insK >= 0, await marked(k, ".nt-sins"));
  // …and she suggests removing "beta" (selected, then Backspace).
  await k.evaluate(() => {
    const walk = document.createTreeWalker(document.querySelector(".nt-main .bn-editor"), NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.textContent.indexOf("beta");
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 4);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return;
    }
  });
  await k.waitForTimeout(200);
  await k.keyboard.press("Backspace");
  const delK = await within(4000, async () => (await marked(k, ".nt-sdel")).includes("beta"));
  check("5 a removal shows struck through, the text stays", delK >= 0 && (await body(k)).includes("beta"), await marked(k, ".nt-sdel"));

  // Anna sees both live, with Kira's face in the margin.
  const seenA = await within(6000, async () => (await marked(a, ".nt-sins")).includes("delta") && (await marked(a, ".nt-sdel")).includes("beta"));
  check("6 the editor sees both suggestions live", seenA >= 0, `${seenA} ms`);
  const faces = await within(4000, async () => (await a.locator(".nt-sug-face").count()) === 2);
  check("7 two faces in the margin", faces >= 0, String(await a.locator(".nt-sug-face").count()));

  // On the server: the marks, and the suggestions' entries signed by Kira.
  const kiraId = (await api(k, `/api/auth/session?ws=${team}`)).body?.user?.id;
  const stored = await within(12000, async () => {
    const n = await noteOf(a, team, id);
    const recs = (n?.comments ?? []).filter((c) => c.suggestion);
    return JSON.stringify(n?.content).includes('"suggestIns"') && JSON.stringify(n?.content).includes('"suggestDel"') && recs.length === 2 && recs.every((c) => c.authorId === kiraId);
  });
  check("8 saved: marks on the page, two suggestions by her", stored >= 0, JSON.stringify((await noteOf(a, team, id))?.comments ?? null).slice(0, 300));

  // Kira cannot accept her own suggestion (nor edit the page) through the API.
  const cur = await noteOf(k, team, id);
  const forged = { ...cur, content: [para(`b1${RUN}`, "Alpha gamma. delta"), para(`b2${RUN}`, "Second line.")], comments: (cur.comments ?? []).map((c) => (c.suggestion ? { ...c, suggestion: { state: "accepted" } } : c)) };
  await api(k, `/api/notes/sync?ws=${team}`, "POST", { items: [{ id, note: forged }] });
  const after = await noteOf(a, team, id);
  check("9 her own 'accept' through the API changes nothing", (after?.comments ?? []).filter((c) => c.suggestion).every((c) => !c.suggestion.state) && JSON.stringify(after?.content).includes("beta"), JSON.stringify(after?.comments).slice(0, 200));

  // Anna accepts the insertion from its card…
  const insFace = a.locator(".nt-sug-face").first();
  await insFace.click();
  await a.waitForSelector(".nt-sug-card", { timeout: 5000 });
  const cardText = await a.locator(".nt-sug-card").innerText();
  const which = cardText.includes("delta") ? "ins" : "del";
  await a.locator(".nt-sug-card .nt-sug-accept").click();
  const accepted = await within(5000, async () => (which === "ins" ? !(await marked(a, ".nt-sins")).includes("delta") && (await body(a)).includes("delta") : !(await body(a)).includes("beta")));
  check("10 accepted from the card", accepted >= 0, `${which}: ${await body(a)}`);
  // …and rejects the other one.
  await a.waitForTimeout(800);
  await a.locator(".nt-sug-face").first().click();
  await a.waitForSelector(".nt-sug-card", { timeout: 5000 });
  await a.locator(".nt-sug-card .nt-sug-reject").click();
  const clean = await within(5000, async () => (await a.locator(".nt-main .nt-sins, .nt-main .nt-sdel").count()) === 0 && (await a.locator(".nt-sug-face").count()) === 0);
  const expect = which === "ins" ? "Alpha beta gamma. delta" : "Alpha gamma.";
  check("11 rejected: no suggestion left, the page reads as decided", clean >= 0 && (await body(a)).includes(expect), await body(a));
  const liveK = await within(5000, async () => (await body(k)).includes(expect) && (await k.locator(".nt-main .nt-sins, .nt-main .nt-sdel").count()) === 0);
  check("12 the commenter sees the decisions live", liveK >= 0, await body(k));

  // Server: both decided by Anna; the Inbox and the history follow.
  const annaId = (await api(a, `/api/auth/session?ws=${team}`)).body?.user?.id;
  const decided = await within(12000, async () => {
    const n = await noteOf(a, team, id);
    const recs = (n?.comments ?? []).filter((c) => c.suggestion);
    return recs.length === 2 && recs.every((c) => c.suggestion.by === annaId) && recs.some((c) => c.suggestion.state === "accepted") && recs.some((c) => c.suggestion.state === "rejected") && !JSON.stringify(n?.content).includes("suggest");
  });
  check("13 saved: one accepted, one rejected, by her; no marks left", decided >= 0, JSON.stringify((await noteOf(a, team, id))?.comments ?? null).slice(0, 300));
  const inboxA = (await api(a, `/api/eco/inbox?ws=${team}`)).body?.items ?? [];
  const inboxK = (await api(k, `/api/eco/inbox?ws=${team}`)).body?.items ?? [];
  check("14 the editor's Inbox: suggested edits", inboxA.some((x) => x.kind === "suggestion" && x.actor?.id === kiraId), JSON.stringify(inboxA.map((x) => x.kind)));
  check("15 the suggester's Inbox: accepted and rejected", inboxK.some((x) => x.kind === "suggestion_accepted") && inboxK.some((x) => x.kind === "suggestion_rejected"), JSON.stringify(inboxK.map((x) => x.kind)));
  const versions = (await api(a, `/api/notes/versions?ws=${team}&id=${id}`)).body?.versions ?? [];
  const sv = versions.find((v) => v.kind === "suggestion");
  check("16 the history keeps the accepted suggestion under her", Boolean(sv && sv.by === kiraId && sv.acceptedBy === annaId), JSON.stringify(versions.slice(0, 3)));

  // Anna suggests too: ••• → Suggest edits; then accepts everything from the menu.
  await a.getByRole("button", { name: L.more }).click();
  await a.getByRole("menuitemcheckbox", { name: L.suggestEdits }).click();
  await a.keyboard.press("Escape");
  await a.waitForTimeout(400);
  check("17 the editor switched to suggesting", (await a.locator(".nt-sug-chip").count()) > 0 && (await a.locator('.nt-main .nt-editor[data-suggest="on"]').count()) > 0);
  await a.locator(".nt-main .bn-editor").getByText("Second line.").click();
  await caretAfter(a, "Second line.");
  await a.keyboard.type(" Anna adds");
  await a.keyboard.press("Enter");
  await a.keyboard.type("A new line");
  // A paste is suggested text too.
  await a.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", " pasted");
    document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const mine = await within(4000, async () => (await marked(a, ".nt-sins")).includes("Anna adds") && (await marked(a, ".nt-sins")).includes("A new line pasted") && (await a.locator('.nt-main .bn-block-outer[data-id^="sg~"]').count()) === 1);
  check("18 her typing, a paste and her new line are suggestions", mine >= 0, await marked(a, ".nt-sins"));
  const seenK = await within(4000, async () => (await marked(k, ".nt-sins")).includes("A new line"));
  check("19 the commenter sees them live", seenK >= 0);
  await a.waitForTimeout(800);
  await a.getByRole("button", { name: L.more }).click();
  await a.getByRole("menuitem", { name: L.acceptAll }).click();
  const all = await within(6000, async () => (await a.locator(".nt-main .nt-sins, .nt-main .nt-sdel").count()) === 0 && (await body(a)).includes("Anna adds") && (await body(a)).includes("A new line") && (await a.locator('.nt-main .bn-block-outer[data-id^="sg~"]').count()) === 0);
  check("20 Accept all: the text and the line are the page's", all >= 0, await body(a));
  const saved = await within(12000, async () => {
    const n = await noteOf(a, team, id);
    const t = JSON.stringify(n?.content ?? []);
    return t.includes("A new line") && !t.includes("suggest") && !t.includes('"sg~');
  });
  check("21 saved as the page's own text", saved >= 0);

  // ---- Notion parity, round 3 (Anna edits again) ----
  await a.evaluate(() => localStorage.setItem("nt-suggest", "[]"));
  const pid = `pr${RUN}pageaaaaaaa`.slice(0, 18);
  const soon = new Date(Date.now() + 3 * 86_400_000);
  const ymd = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  const t2 = Date.now();
  await api(a, `/api/notes/sync?ws=${team}`, "POST", {
    items: [
      {
        id: pid,
        note: {
          id: pid, parentId: null, space: "", kind: "page", title: `Parity ${RUN}`, icon: "", cover: null, order: 2, favorite: false, createdAt: t2, updatedAt: t2, trashedAt: null,
          content: [
            para(`p1${RUN}`, "Find the line, then another line."),
            { ...para(`p2${RUN}`, "Due "), content: [{ type: "text", text: "Due ", styles: {} }, { type: "mention", props: { noteId: "", date: ymd, remind: "", userId: "", name: "" } }] },
            para(`p3${RUN}`, "Deep target block"),
          ],
        },
      },
    ],
  });
  // A link to a block opens the page there and highlights it.
  await a.goto(`${BASE}/docs?ws=${team}#${pid}&b=p3${RUN}`);
  await a.waitForSelector(".nt-main .bn-editor", { timeout: 60000 });
  const flashed = await within(8000, async () => (await a.locator(`.nt-main .nt-block-flash[data-for="p3${RUN}"]`).count()) === 1);
  check("P1 a link to a block scrolls to it and highlights it", flashed >= 0);
  // Find and replace (⌘F in the page).
  await a.locator(".nt-main .bn-editor").getByText("Deep target block").click();
  await a.keyboard.press("Control+f");
  await a.waitForSelector(".nt-find", { timeout: 4000 });
  await a.locator(".nt-find-input").first().fill("line");
  const counted = await within(3000, async () => /\b2\b/.test(await a.locator(".nt-find-count").innerText()) && (await a.locator(".nt-main .nt-find-hit").count()) === 2);
  check("P2 find in page highlights every match", counted >= 0, await a.locator(".nt-find-count").innerText().catch(() => ""));
  await a.locator('.nt-find button[aria-pressed]').first().click();
  await a.locator(".nt-find-input").nth(1).fill("row");
  await a.locator(".nt-find").getByRole("button", { name: RU ? "Заменить все" : "Replace all" }).click();
  const replaced = await within(3000, async () => (await body(a)).includes("Find the row, then another row."));
  check("P3 replace all", replaced >= 0, await body(a));
  await a.keyboard.press("Escape");
  await a.waitForTimeout(300);
  // Markdown: "> " starts a toggle list, ~text~ strikes it through, $$TeX$$ is an inline equation.
  await a.locator(".nt-main .bn-editor").getByText("Deep target block").click();
  await caretAfter(a, "Deep target block");
  await a.keyboard.press("Enter");
  await a.keyboard.type("> Folded");
  const toggled = await within(3000, async () => (await a.locator('.nt-main [data-content-type="toggleListItem"]').filter({ hasText: "Folded" }).count()) === 1);
  check("P4 '> ' makes a toggle list (Notion)", toggled >= 0);
  await a.keyboard.press("Enter");
  await a.keyboard.press("Enter");
  await a.keyboard.type("A ~gone~ word and $$x^2$$ ");
  const md = await within(3000, async () => (await a.locator(".nt-main s").filter({ hasText: "gone" }).count()) > 0 && (await a.locator('.nt-main [data-inline-content-type="inlineEquation"]').count()) > 0);
  check("P5 ~strike~ and $$equation$$", md >= 0, await a.locator(".nt-main .bn-editor").innerHTML().then((h) => h.slice(-600)).catch(() => ""));
  // ⌘/ opens the block's actions; Esc closes them.
  await a.keyboard.press("Control+/");
  const actions = await within(2000, async () => (await a.locator(".nt-popover .nt-menu").count()) > 0);
  check("P6 ⌘/ opens the block's actions", actions >= 0);
  await a.keyboard.press("Escape");
  // Editing one's own comment.
  await a.getByRole("button", { name: RU ? "Добавить комментарий" : "Add comment" }).first().click({ force: true });
  await a.locator(".nt-comments .nt-cm-new textarea").fill("First thought");
  await a.keyboard.press("Enter");
  await a.waitForSelector(".nt-comments .nt-cm-text", { timeout: 4000 });
  await a.locator(".nt-comments .nt-cm").first().hover();
  await a.locator(".nt-comments").getByRole("button", { name: RU ? "Изменить комментарий" : "Edit comment" }).first().click();
  await a.locator(".nt-comments .nt-cm-edit textarea").fill("Second thought");
  await a.keyboard.press("Enter");
  const edited = await within(3000, async () => (await a.locator(".nt-comments .nt-cm-text").first().innerText()).includes("Second thought") && (await a.locator(".nt-comments .nt-cm-edited").count()) > 0);
  check("P7 a comment edited by its author shows (edited)", edited >= 0);
  // Follow the page from its ••• menu.
  await a.getByRole("button", { name: L.more }).click();
  await a.getByRole("menuitemcheckbox", { name: RU ? "Следить за страницей" : "Follow page" }).click({ timeout: 5000 });
  await a.keyboard.press("Escape");
  const followed = await within(4000, async () => (await api(a, `/api/notes/follow?ws=${team}&id=${pid}`)).body?.following === true);
  check("P8 ••• → Follow page", followed >= 0);
  // My notifications: mentions off.
  await api(a, "/api/notes/prefs", "POST", { notify: { mention: false } });
  const prefs = (await api(a, "/api/notes/prefs")).body;
  check("P9 notification settings are kept", Array.isArray(prefs?.muted) && prefs.muted.includes("mention"), JSON.stringify(prefs));
  await api(a, "/api/notes/prefs", "POST", { notify: { mention: true } });
  // Home: the date coming up, a click opens its page.
  await a.goto(`${BASE}/docs?ws=${team}#home`);
  const upcoming = await within(8000, async () => (await a.locator(".nt-home-event").filter({ hasText: `Parity ${RUN}` }).count()) > 0);
  check("P10 Home shows the date coming up", upcoming >= 0);
  // Quick Find: a hit in the text opens its block.
  await a.keyboard.press("Control+p");
  await a.locator(".nt-search-head input").fill("Deep target");
  // The first row is the page found by its text (results load as one types).
  await a.locator(".nt-search-row[data-active]").filter({ hasText: `Parity ${RUN}` }).first().waitFor({ timeout: 8000 }).catch(() => {});
  await a.keyboard.press("Enter");
  const jumped = await within(8000, async () => (await a.locator(`.nt-main .nt-block-flash[data-for="p3${RUN}"]`).count()) === 1);
  check("P11 a search hit in the text scrolls to its block", jumped >= 0);
  // "+" at the start of a word: link a page or create one.
  await a.locator(".nt-main .bn-editor").getByText("Deep target block").click();
  await caretAfter(a, "Deep target block");
  await a.keyboard.type(" +Предл");
  const plus = await within(3000, async () => (await a.locator(".nt-slash .nt-slash-item").filter({ hasText: TITLE }).count()) > 0);
  check("P12 '+' offers pages to link (and a new one)", plus >= 0);
  await a.keyboard.press("Escape");
  // Esc selects the block's text (Notion).
  await a.waitForTimeout(300);
  await a.locator(".nt-main .bn-editor").getByText("Deep target block").click();
  await a.waitForTimeout(300);
  await a.keyboard.press("Escape");
  await a.waitForTimeout(200);
  const selected = await a.evaluate(() => getSelection()?.toString() ?? "");
  check("P13 Esc selects the block's text", selected.includes("Deep target block"), selected);
  // The comment list: Open and Resolved.
  await a.locator(".nt-top-cm").click();
  const tabs = await a.locator(".nt-discuss-tab").count();
  check("P14 the comment list has Open and Resolved", tabs === 2);
  await a.keyboard.press("Escape");
  // A discussion on selected text (⌘⇧M), then the list pinned in the sidebar (Notion's "Open in sidebar").
  await a.locator(".nt-main .bn-editor").getByText("Deep target block").click();
  await a.keyboard.press("End");
  await a.keyboard.press("Shift+Home");
  await a.keyboard.press("Control+Shift+M");
  await a.locator(".nt-thread-pop .nt-cm-new textarea").fill("Inline note");
  await a.keyboard.press("Enter");
  await a.waitForTimeout(400);
  await a.keyboard.press("Escape");
  await a.locator(".nt-top-cm").click();
  await a.locator('[data-test="comments-dock"]').click();
  const side = a.locator('[data-test="comments-sidebar"]');
  const docked = await within(4000, async () => (await side.count()) === 1 && (await side.innerText()).includes("Inline note") && (await side.innerText()).includes("Second thought"));
  check("P14b Open in sidebar: every discussion beside the page", docked >= 0, await side.innerText().catch(() => "none"));
  await side.locator(".nt-cside-card[data-thread] .nt-cm-new textarea").first().fill("Reply from the side");
  await a.keyboard.press("Enter");
  const replied = await within(5000, async () => {
    const n = await noteOf(a, team, pid);
    const inline = (n?.comments ?? []).find((c) => c.text === "Inline note");
    return Boolean(inline?.thread) && (n?.comments ?? []).some((c) => c.text === "Reply from the side" && c.thread === inline.thread);
  });
  check("P14c a reply in the sidebar joins the thread", replied >= 0);
  await side.locator(".nt-cside-card[data-thread]").first().getByRole("button", { name: RU ? "Решено" : "Resolve", exact: true }).click();
  const resolvedSide = await within(4000, async () => !(await side.innerText()).includes("Inline note"));
  await side.getByRole("tab", { name: RU ? "Решённые" : "Resolved" }).click();
  const inResolved = await within(3000, async () => (await side.innerText()).includes("Inline note"));
  check("P14d resolved there, it moves to Resolved", resolvedSide >= 0 && inResolved >= 0, await side.innerText());
  // A new visit (the test's ids are short, so by id rather than the page's title link).
  await a.goto(`${BASE}/docs?ws=${team}#${pid}`);
  const stays = await within(8000, async () => (await a.locator('[data-test="comments-sidebar"]').count()) === 1);
  await a.locator('[data-test="comments-sidebar"]').getByRole("button", { name: RU ? "Закрыть панель" : "Close sidebar" }).click();
  check("P14e the sidebar stays open on the next visit, and closes", stays >= 0 && (await a.locator('[data-test="comments-sidebar"]').count()) === 0);
  // ⌘/ outside the text: the keyboard shortcuts; My notifications lists every kind.
  await a.locator(".nt-title").click();
  await a.keyboard.press("Control+/");
  const keys = await within(3000, async () => (await a.locator(".nt-kbd-list .nt-kbd-row").count()) > 30);
  check("P15 ⌘/ shows the keyboard shortcuts", keys >= 0, String(await a.locator(".nt-kbd-list .nt-kbd-row").count()));
  await a.locator(".nt-settings-nav-item").filter({ hasText: RU ? "Мои уведомления" : "My notifications" }).click();
  const switches = await within(3000, async () => (await a.locator(".nt-settings-body [role=switch]").count()) === 8);
  check("P16 My notifications: seven kinds to turn off, and e-mail", switches >= 0, String(await a.locator(".nt-settings-body [role=switch]").count()));
  await a.keyboard.press("Escape");
  // The Tabs block (Notion's "/tabs"): two tabs, one shown; rename by double-click; saved with the page.
  // The discussion on "Deep target block" open again (as under load it may be): clicking its text and typing must
  // close its card, never cover the "/" menu or take the caret (Notion).
  {
    const cur = await noteOf(a, team, pid);
    const comments = (cur?.comments ?? []).map((c) => {
      const { resolved: _r, ...rest } = c;
      return rest;
    });
    await api(a, `/api/notes/sync?ws=${team}`, "POST", { items: [{ id: pid, note: { ...cur, comments, updatedAt: Date.now() }, fields: ["comments"] }] });
  }
  await a.goto(`${BASE}/docs?ws=${team}#${pid}`);
  await a.locator(".nt-main .bn-editor").getByText("Deep target block").waitFor({ timeout: 15000 });
  await a.waitForTimeout(800);
  await a.locator(".nt-main .bn-editor").getByText("Deep target block").click();
  const opened = await a.locator(".nt-thread-pop").count();
  await caretAfter(a, "Deep target block");
  await a.keyboard.press("End");
  await a.keyboard.press("Enter");
  await a.keyboard.type("/tabs");
  check("T0 typing closes the discussion card the click opened; the caret stays in the text", opened === 1 && (await a.locator(".nt-thread-pop").count()) === 0 && (await a.locator(".nt-slash-item").count()) > 0, `opened ${opened}`);
  await a.locator(".nt-slash-item", { has: a.locator(".nt-slash-title", { hasText: RU ? /^Вкладки$/ : /^Tabs$/ }) }).first().click();
  await a.keyboard.type("Alpha content");
  const two = await within(4000, async () => (await a.locator(".nt-main .nt-tabs .nt-tab-btn").count()) === 2);
  check("T1 /tabs makes two tabs, the first shown", two >= 0, String(await a.locator(".nt-main .nt-tabs .nt-tab-btn").count()));
  await a.locator(".nt-main .nt-tabs .nt-tab-btn").nth(1).click();
  const switched = await within(3000, async () => !(await a.locator(".nt-main .nt-tabs").getByText("Alpha content").isVisible()));
  await a.locator(".nt-main .nt-tabs-body > [data-active] .bn-inline-content").first().click();
  await a.keyboard.type("Beta content");
  check("T2 another tab shows its own blocks", switched >= 0 && (await a.locator(".nt-main .nt-tabs").getByText("Beta content").isVisible()));
  await a.locator(".nt-main .nt-tabs .nt-tab-btn").first().dblclick();
  await a.locator(".nt-main .nt-tab-input").fill("Overview");
  await a.keyboard.press("Enter");
  const savedTabs = await within(8000, async () => {
    const n = await noteOf(a, team, pid);
    const tb = (n?.content ?? []).find((b) => b.type === "tabs");
    const txt = JSON.stringify(tb ?? null);
    return tb?.children?.length === 2 && tb.children[0].props?.title === "Overview" && txt.includes("Alpha content") && txt.includes("Beta content");
  });
  check("T3 renamed, and saved with the page (both tabs' blocks)", savedTabs >= 0, JSON.stringify(((await noteOf(a, team, pid))?.content ?? []).find((b) => b.type === "tabs") ?? null).slice(0, 300));
  await a.locator(".nt-main .nt-tabs .nt-tab-add").click();
  const three = await within(3000, async () => (await a.locator(".nt-main .nt-tabs .nt-tab-btn").count()) === 3 && (await a.locator(".nt-main .nt-tab-item[data-active] .nt-tab-btn").innerText()).length > 0);
  check("T4 + adds a tab and shows it", three >= 0);
  // Named embeds (Notion's "/figma", "/google drive"…): the embed block asks for that service's link.
  await a.locator(".nt-main .bn-editor").getByText("Deep target block").click();
  await caretAfter(a, "Deep target block");
  await a.keyboard.press("End");
  await a.keyboard.press("Enter");
  await a.keyboard.type("/figma");
  await a.locator(".nt-slash-item", { has: a.locator(".nt-slash-title", { hasText: /^Figma$/ }) }).first().click();
  const named = await within(4000, async () => (await a.locator(".nt-main .nt-media-input").filter({ hasText: "Figma" }).count()) > 0);
  check("T5 /figma makes an embed that asks for a Figma link", named >= 0);
  await a.keyboard.press("Escape");

  check("22 no foreign hosts", foreignHosts(ctxA).length === 0 && foreignHosts(ctxK).length === 0, [...foreignHosts(ctxA), ...foreignHosts(ctxK)].join(", "));
  check("23 no console errors / failed requests", ctxA.errors.length + ctxK.errors.length + ctxA.failed.length + ctxK.failed.length === 0, [...ctxA.errors, ...ctxK.errors, ...ctxA.failed, ...ctxK.failed].slice(0, 6).join(" | "));
} catch (e) {
  check("docs-suggest ran", false, String(e).slice(0, 400));
} finally {
  await a.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-suggest-a.png` : "/dev/null" }).catch(() => {});
  await k.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/docs-suggest-k.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
