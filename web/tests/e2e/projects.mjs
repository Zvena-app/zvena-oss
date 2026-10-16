// Zvena Projects in a real browser on a test stand (dev sign-in):
// onboarding, creating and editing issues, persistence across reloads,
// keyboard, board drag and drop, filters in the URL, saved views, comments,
// sub-issues, attachments, the inbox, the command palette, roadmap and
// cycles, and isolation from another workspace.
//   BASE=http://127.0.0.1:3400 PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/projects.mjs
// SHOTS=dir also saves screenshots of the main screens (light and dark).
import { mkdirSync } from "node:fs";
import { BASE, check, context, devSignIn, foreignHosts, LANG, launch, summary } from "./lib.mjs";

// The interface's words in the checks' language (E2E_LANG=ru for Russian).
const T =
  LANG === "ru"
    ? { priority: "Приоритет", urgent: "Срочно", high: "Высокий", started: "В работе", done: "Готово", addSub: "Добавить подзадачу", saveView: "Сохранить как представление", del: "Удалить", undo: "Отменить", allIssues: "Все задачи", roadmap: "Дорожная", newCycle: "Новый цикл" }
    : { priority: "Priority", urgent: "Urgent", high: "High", started: "In progress", done: "Done", addSub: "Add sub-issue", saveView: "Save as view", del: "Delete", undo: "Undo", allIssues: "All issues", roadmap: "Roadmap", newCycle: "New cycle" };

const RUN = Math.random().toString(36).slice(2, 7);
const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await launch();
const ctx = await context(browser);
const page = await ctx.newPage();
const api = (p, method = "GET", data) =>
  page.request.fetch(`${BASE}/api/${p}`, { method, headers: { origin: BASE, "content-type": "application/json" }, data: data === undefined ? undefined : JSON.stringify(data) });
const shot = async (name, p = page) => {
  if (!SHOTS) return;
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
};
const mod = process.platform === "darwin" ? "Meta" : "Control";

try {
  // --- A shared workspace of Anna's, with Boris invited as editor ---
  await devSignIn(page, `Anna ${RUN}`, { next: "/home" });
  const ws = (await (await api("ws", "POST", { name: `Company ${RUN}` })).json()).workspace.id;
  check("workspace created", Boolean(ws));
  const invite = await (await api(`ws/invites?ws=${ws}`, "POST", { role: "editor" })).json();
  const token = invite.url.split("/join/")[1];

  // --- First run: no form — "My team" with three example issues on a board ---
  await page.goto(`${BASE}/projects?ws=${ws}`);
  await page.waitForURL(/\/projects\/team\/[A-Z0-9]+\/issues/, { timeout: 30000 });
  const KEY = /\/team\/([A-Z0-9]+)\//.exec(page.url())[1];
  check("first run makes a team and opens its board", page.url().includes("layout=board"), page.url());
  await page.waitForSelector(".pj-card", { timeout: 15000 });
  check("three example issues on the board", (await page.locator(".pj-card").count()) === 3);
  // The cookie notice is answered once, like a person would (it sits over the bottom left).
  if (await page.locator(".zv-cookie button").count()) await page.locator(".zv-cookie button").first().click();
  await shot("01-first-run");
  await page.goto(`${BASE}/projects/team/${KEY}/issues?ws=${ws}&layout=list`);
  await page.waitForSelector(".pj-issue-row", { timeout: 15000 });
  const n = (k) => `${KEY}-${k + 3}`; // the examples took numbers 1–3

  // --- Create issues from the keyboard ---
  await page.keyboard.press("c");
  await page.waitForSelector(".pj-create-title");
  await page.locator(".pj-create-title").fill("Sign-in fails with SSO");
  await page.locator(".pj-create-desc .pj-prose").click();
  await page.keyboard.type("Error 500 after consent. @");
  await page.waitForSelector(".pj-mention-pop .pj-menu-item", { timeout: 5000 });
  await page.keyboard.press("Enter");
  await page.locator(`.pj-create-pills .ds-pill[title='${T.priority}']`).click();
  await page.locator(".pj-popover .pj-menu-item", { hasText: T.urgent }).click();
  await shot("02-create");
  await page.keyboard.press(`${mod}+Enter`);
  await page.locator(".pj-issue-row .ds-row-id", { hasText: n(1) }).first().waitFor({ timeout: 15000 }).catch(() => {});
  check("issue created with an identifier", (await page.locator(".pj-issue-row .ds-row-id", { hasText: n(1) }).count()) === 1);
  for (const title of ["Onboarding screen", "API docs", "Optimize search"]) {
    await page.keyboard.press("c");
    await page.waitForSelector(".pj-create-title");
    await page.locator(".pj-create-title").fill(title);
    await page.keyboard.press(`${mod}+Enter`);
    await page.waitForSelector(`.pj-row-title:text("${title}")`, { timeout: 10000 });
  }
  check("four new issues listed", (await page.locator(".pj-issue-row").count()) === 7);
  await page.reload();
  await page.waitForSelector(".pj-issue-row", { timeout: 15000 });
  check("issues survive a reload", (await page.locator(".pj-issue-row").count()) === 7);
  const first = await (await api(`projects/issues/${n(1)}?ws=${ws}`)).json();
  check("the mention and priority are saved on the server", first.priority === 1 && /\[@ id="/.test(first.description), first.description);
  await shot("03-list");

  // --- Keyboard in the list: focus, status picker ---
  // Focus moves with J/K; S opens the status picker of the focused issue.
  await page.locator(".pj-issue-row", { hasText: "Sign-in fails" }).hover();
  await page.keyboard.press("k");
  await page.keyboard.press("j");
  await page.keyboard.press("s");
  await page.waitForSelector(".pj-popover .pj-menu-item");
  await page.keyboard.type(T.started);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const st1 = (await (await api(`projects/issues/${n(1)}?ws=${ws}`)).json()).statusId;
  const statuses = (await (await api(`projects/bootstrap?ws=${ws}`)).json()).statuses;
  check("status changed by keyboard (S)", statuses.find((x) => x.id === st1)?.name === T.started);

  // --- Issue page: title, description, comment, sub-issue, relation, attachment ---
  await page.goto(`${BASE}/projects/issue/${n(1)}?ws=${ws}`);
  await page.waitForSelector(".pj-issue-title", { timeout: 15000 });
  const title = page.locator(".pj-issue-title");
  await title.fill("Sign-in fails with SSO");
  await title.press("Enter");
  await page.locator(".pj-composer .pj-prose").click();
  await page.keyboard.type("Reproduced on the test stand.");
  await page.keyboard.press(`${mod}+Enter`);
  await page.waitForSelector(".pj-comment", { timeout: 10000 });
  await page.locator(".pj-section-head button", { hasText: T.addSub }).click();
  await page.locator(".pj-inline-add input").fill("Check the SSO callback");
  await page.locator(".pj-inline-add input").press("Enter");
  await page.waitForSelector(".pj-sublist .pj-mini-row", { timeout: 10000 });
  await page.setInputFiles(".pj-section input[type=file]", { name: "log.txt", mimeType: "text/plain", buffer: Buffer.from(`error log ${RUN}`) });
  await page.waitForSelector(".pj-attachment", { timeout: 10000 });
  await shot("04-issue");
  await page.reload();
  await page.waitForSelector(".pj-issue-title", { timeout: 15000 });
  check("title edit persisted", (await page.locator(".pj-issue-title").inputValue()) === "Sign-in fails with SSO");
  check("comment persisted", (await page.locator(".pj-comment").textContent())?.includes("Reproduced"));
  check("sub-issue persisted", (await page.locator(".pj-sublist .pj-mini-row").count()) === 1);
  check("history shows the status change", (await page.locator(".pj-tl-act").allTextContents()).some((x) => x.includes(T.started)));
  const attUrl = await page.locator(".pj-att-name").first().getAttribute("href");
  const att = await page.request.get(`${BASE}${attUrl}`);
  check("attachment downloads for a member", att.status() === 200 && (await att.text()).includes(RUN));

  // --- Board: drag a card into another column ---
  await page.goto(`${BASE}/projects/team/${KEY}/issues?ws=${ws}&layout=board`);
  await page.waitForSelector(".pj-col", { timeout: 15000 });
  await shot("05-board");
  const card = page.locator(".pj-card", { hasText: "API docs" });
  const done = page.locator(".pj-col", { hasText: T.done }).locator(".pj-col-body");
  await card.dragTo(done);
  await page.waitForTimeout(1200);
  const doc = (await (await api(`projects/search?ws=${ws}&q=${encodeURIComponent("API docs")}`)).json()).issues[0];
  const boot = await (await api(`projects/bootstrap?ws=${ws}`)).json();
  check("drag to “Done” saved the status", boot.statuses.find((s) => s.id === doc.statusId)?.category === "completed");
  await page.reload();
  await page.waitForSelector(".pj-col", { timeout: 15000 });
  check("board layout kept in the URL after reload", page.url().includes("layout=board") && (await page.locator(".pj-col", { hasText: T.done }).locator(".pj-card", { hasText: "API docs" }).count()) === 1);

  // --- Filters in the URL, saved view ---
  await page.goto(`${BASE}/projects/issues?ws=${ws}&priority=1`);
  await page.waitForSelector(".pj-issue-row", { timeout: 15000 });
  check("URL filter applies on the server", (await page.locator(".pj-issue-row").count()) === 1 && (await page.locator(".pj-chip").count()) === 1);
  await page.locator("button", { hasText: T.saveView }).click();
  await page.locator(".pj-modal input").fill(`Urgent ${RUN}`);
  await page.locator(".pj-modal button[type=submit]").click();
  await page.waitForURL(/\/projects\/view\//, { timeout: 10000 });
  await page.waitForSelector(".pj-issue-row", { timeout: 15000 });
  check("saved view opens with its filter", (await page.locator(".pj-issue-row").count()) === 1);

  // --- Delete happens at once, with Undo (no confirmation dialog) ---
  await page.goto(`${BASE}/projects/team/${KEY}/issues?ws=${ws}`);
  await page.waitForSelector(".pj-issue-row", { timeout: 15000 });
  const victim = page.locator(".pj-issue-row", { hasText: "Optimize search" });
  await victim.click({ button: "right" });
  await page.locator(".pj-popover .pj-menu-item", { hasText: T.del }).click();
  await page.waitForSelector(".ds-toast-btn", { timeout: 5000 });
  check("deleted at once from the list", (await page.locator(".pj-issue-row", { hasText: "Optimize search" }).count()) === 0);
  await page.locator(".ds-toast-btn", { hasText: T.undo }).click();
  await page.waitForSelector('.pj-issue-row:has-text("Optimize search")', { timeout: 10000 });
  await page.waitForTimeout(6500);
  check("Undo keeps the issue (also on the server)", (await api(`projects/issues/${n(4)}?ws=${ws}`)).status() === 200);
  await page.locator(".pj-issue-row", { hasText: "Optimize search" }).click({ button: "right" });
  await page.locator(".pj-popover .pj-menu-item", { hasText: T.del }).click();
  await page.waitForTimeout(7000);
  check("without Undo the deletion reaches the server", (await api(`projects/issues/${n(4)}?ws=${ws}`)).status() === 404);

  // --- A click opens the side panel; Enter the full page ---
  await page.locator(".pj-row-title", { hasText: "Onboarding screen" }).click();
  await page.waitForSelector(".pj-peek .pj-issue-title", { timeout: 10000 });
  check("click opens the issue on the side, the list stays", page.url().includes("peek=") && (await page.locator(".pj-issue-row").count()) > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes the side panel", !page.url().includes("peek="));

  // --- Bulk: from two selected rows, zvena's selection bar edits them together ---
  await page.locator(".pj-issue-row", { hasText: "Onboarding screen" }).locator(".ds-row-check").click();
  check("one selected row shows no bulk bar", (await page.locator(".ds-selbar").count()) === 0);
  await page.locator(".pj-issue-row", { hasText: "API docs" }).locator(".ds-row-check").click();
  await page.waitForSelector(".ds-selbar", { timeout: 5000 });
  await page.locator(".ds-selbar-btn", { hasText: T.priority }).click();
  await page.locator(".pj-popover .pj-menu-item", { hasText: T.high }).click();
  await page.waitForTimeout(800);
  const bulk = await (await api(`projects/issues/${n(2)}?ws=${ws}`)).json();
  const bulk2 = await (await api(`projects/issues/${n(3)}?ws=${ws}`)).json();
  check("bulk priority saved for both issues", bulk?.priority === 2 && bulk2?.priority === 2, `${bulk?.priority} ${bulk2?.priority}`);
  await shot("05b-bulk");
  await page.keyboard.press("Escape");
  if (await page.locator(".ds-selbar").count()) await page.locator(".ds-selbar .ds-icon-btn").click();

  // --- One frame: Projects lives in zvena's rail; ⌘K is zvena's search, / is Projects' palette ---
  await page.evaluate(() => (window.__stay = 1));
  await page.locator(".ds-section-nav a", { hasText: T.allIssues }).first().click();
  await page.waitForURL(/\/projects\/issues/, { timeout: 10000 });
  check("rail switches Projects screens without a page load", (await page.evaluate(() => window.__stay)) === 1);
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector(".eco-palette", { timeout: 5000 });
  check("⌘K opens zvena's search, not Projects' palette", (await page.locator(".pj-palette").count()) === 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // --- Command palette and shortcuts help ---
  await page.keyboard.press("/");
  await page.waitForSelector(".pj-palette input");
  await page.keyboard.type(T.roadmap);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/projects\/roadmap/, { timeout: 10000 });
  check("palette navigates", page.url().includes("/roadmap"));
  await page.keyboard.press("?");
  check("shortcuts help opens with ?", await page.locator(".pj-help").isVisible());
  await page.keyboard.press("Escape");

  // --- "New issue" from elsewhere in zvena: /projects?create=issue&title=… ---
  await page.goto(`${BASE}/projects?ws=${ws}&create=issue&title=${encodeURIComponent("From a doc")}`);
  await page.waitForSelector(".pj-create-title", { timeout: 15000 });
  check("create link opens the dialog prefilled", (await page.locator(".pj-create-title").inputValue()) === "From a doc" && !page.url().includes("create="));
  await page.keyboard.press("Escape");

  // --- A project with dates on the roadmap; a cycle ---
  const team = boot.teams[0];
  const proj = await (await api(`projects/projects?ws=${ws}`, "POST", { name: "Launch 2.0", teamIds: [team.id], startDate: "2026-10-01", targetDate: "2026-12-15" })).json();
  await api(`projects/issues/${n(1)}?ws=${ws}`, "PATCH", { projectId: proj.id });
  await page.goto(`${BASE}/projects/roadmap?ws=${ws}`);
  await page.waitForSelector(".pj-rm-bar", { timeout: 15000 });
  check("roadmap shows the project", (await page.locator(".pj-rm-bar").count()) === 1);
  await shot("06-roadmap");
  await page.goto(`${BASE}/projects/project/${proj.id}?ws=${ws}`);
  await page.waitForSelector(".pj-project", { timeout: 15000 });
  await shot("07-project");
  await api(`projects/teams/${team.id}?ws=${ws}`, "PATCH", { cyclesEnabled: true });
  await page.goto(`${BASE}/projects/team/${KEY}/cycles?ws=${ws}`);
  await page.waitForSelector(".ds-start", { timeout: 15000 });
  await shot("07b-cycles-empty");
  await page.locator(".ds-start", { hasText: T.newCycle }).click();
  await page.waitForSelector(".pj-cycle-row", { timeout: 15000 });
  check("cycle listed", (await page.locator(".pj-cycle-row").count()) === 1);

  // --- A goal is met when its last issue closes: completed, an automatic update, a toast ---
  const goal = await (await api(`projects/projects?ws=${ws}`, "POST", { name: "Ship onboarding", teamIds: [team.id] })).json();
  const last = await (await api(`projects/issues?ws=${ws}`, "POST", { teamId: team.id, title: "Record the welcome video", projectId: goal.id })).json();
  await page.goto(`${BASE}/projects/issue/${last.identifier}?ws=${ws}`);
  await page.waitForSelector(".pj-issue-title", { timeout: 15000 });
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("s");
  await page.waitForSelector(".pj-popover .pj-menu-item");
  await page.keyboard.type(T.done);
  await page.keyboard.press("Enter");
  const metToast = await page.locator(".ds-toast", { hasText: "Ship onboarding" }).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  check("closing the last issue says the goal is met", metToast);
  await shot("07c-goal-met");
  const met = await (await api(`projects/projects/${goal.id}?ws=${ws}`)).json();
  check("…and the project is completed with an automatic update", met.state === "completed" && met.updates[0]?.auto === "met", `${met.state} ${met.updates[0]?.auto}`);
  await page.goto(`${BASE}/projects/project/${goal.id}/updates?ws=${ws}`);
  await page.waitForSelector(".pj-update-auto", { timeout: 15000 });
  check("the update reads in the person's language", ((await page.locator(".pj-update-auto").first().textContent()) ?? "").length > 10);

  // --- Linear's copy and picker shortcuts on an issue page ---
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => undefined);
  await page.goto(`${BASE}/projects/issue/${last.identifier}?ws=${ws}`);
  await page.waitForSelector(".pj-issue-title", { timeout: 15000 });
  await page.keyboard.press(`${mod}+.`);
  const copied = await page.locator(".ds-toast", { hasText: last.identifier }).first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  check("⌘. copies the issue's identifier", copied && clip === last.identifier, clip);
  await page.keyboard.press("Shift+P");
  const projectPicker = await page.locator(".pj-popover .pj-menu-item", { hasText: "Ship onboarding" }).first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  check("⇧P opens the project picker", projectPicker);
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await page.waitForSelector(".pj-help", { timeout: 5000 });
  const helpText = await page.locator(".pj-help").innerText();
  check("the ? sheet lists triage and copy shortcuts", /Triage|Разбор/i.test(helpText) && /Copy ID|Копировать ID/i.test(helpText), helpText.replace(/\s+/g, " ").slice(0, 300));
  await page.keyboard.press("Escape");

  // --- Unsafe text stays text: no script, no javascript: links, no outside images ---
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  const evil = await (
    await api(`projects/issues?ws=${ws}`, "POST", {
      teamId: team.id,
      title: "<img src=x onerror=alert(1)>",
      description: '<script>window.__pwn=1</script>\n\n[click](javascript:window.__pwn=2)\n\n<img src="https://tracker.example/p.gif" onerror="window.__pwn=3">\n\n![x](https://tracker.example/a.png)',
    })
  ).json();
  await api(`projects/issues/${evil.id}/comments?ws=${ws}`, "POST", { body: '<iframe src="https://evil.example"></iframe> [x](javascript:alert(1))' });
  await page.goto(`${BASE}/projects/issue/${evil.identifier}?ws=${ws}`);
  await page.waitForSelector(".pj-comment", { timeout: 15000 });
  await page.waitForTimeout(800);
  const unsafe = await page.evaluate(() => ({
    pwn: window.__pwn ?? null,
    js: document.querySelectorAll('a[href^="javascript"]').length,
    ext: [...document.querySelectorAll("img")].filter((i) => /tracker\.example/.test(i.src)).length,
    frames: document.querySelectorAll("iframe").length,
    title: document.querySelector(".pj-issue-title")?.value,
  }));
  check("markdown and HTML in issues are inert", unsafe.pwn === null && unsafe.js === 0 && unsafe.ext === 0 && unsafe.frames === 0 && dialogs === 0, JSON.stringify(unsafe));
  check("an HTML-looking title is shown as text", unsafe.title === "<img src=x onerror=alert(1)>");

  // --- Boris joins, gets an assignment in his inbox ---
  const ctx2 = await context(browser);
  const p2 = await ctx2.newPage();
  await devSignIn(p2, `Boris ${RUN}`, { next: "/home" });
  const joined = await p2.request.fetch(`${BASE}/api/join`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, data: JSON.stringify({ token }) });
  check("Boris joined as editor", joined.status() === 200);
  const borisId = (await (await p2.request.get(`${BASE}/api/auth/session`)).json()).user.id;
  await api(`projects/issues/${n(1)}?ws=${ws}`, "PATCH", { assigneeId: borisId });
  await p2.goto(`${BASE}/projects/inbox?ws=${ws}`);
  await p2.waitForSelector(".pj-notif", { timeout: 15000 });
  check("assignment arrives in the inbox", (await p2.locator(".pj-notif").first().textContent())?.includes(n(1)));
  await p2.locator(".pj-notif").first().click();
  await p2.waitForSelector(".pj-inbox-detail .pj-issue-title", { timeout: 15000 });
  await shot("08-inbox", p2);
  check("unread badge clears after opening", (await (await p2.request.get(`${BASE}/api/projects/changes?ws=${ws}`)).json()).unread === 0);

  // --- Live update: Anna's open list sees Boris's change ---
  await page.goto(`${BASE}/projects/team/${KEY}/issues?ws=${ws}`);
  await page.waitForSelector(".pj-issue-row", { timeout: 15000 });
  await p2.request.fetch(`${BASE}/api/projects/issues/${n(3)}?ws=${ws}`, { method: "PATCH", headers: { origin: BASE, "content-type": "application/json" }, data: JSON.stringify({ title: `Updated by Boris ${RUN}` }) });
  await page.waitForSelector(`.pj-row-title:text("Updated by Boris ${RUN}")`, { timeout: 12000 });
  check("another person's change appears without a reload", true);

  // --- Isolation: a stranger sees nothing ---
  const ctx3 = await context(browser);
  const p3 = await ctx3.newPage();
  await devSignIn(p3, `Stranger ${RUN}`, { next: "/home" });
  const r1 = await p3.request.get(`${BASE}/api/projects/issues/${n(1)}?ws=${ws}`);
  const r2 = await p3.request.get(`${BASE}${attUrl}`);
  check("stranger: no issue (403) and no attachment (404)", r1.status() === 403 && r2.status() === 404, `${r1.status()} ${r2.status()}`);
  await p3.goto(`${BASE}/projects/issue/${n(1)}?ws=${ws}`);
  await p3.waitForTimeout(2500);
  check("stranger's page opens their own workspace, not Anna's issue", !(await p3.locator("body").innerText()).includes("Sign-in fails"));

  // --- Dark theme screenshots ---
  if (SHOTS) {
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.goto(`${BASE}/projects/team/${KEY}/issues?ws=${ws}`);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForSelector(".pj-issue-row");
    await shot("09-list-dark");
    await page.goto(`${BASE}/projects/issue/${n(1)}?ws=${ws}`);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForSelector(".pj-issue-title");
    await shot("10-issue-dark");
  }

  check("no foreign hosts", foreignHosts(ctx).length === 0 && foreignHosts(ctx2).length === 0, [...foreignHosts(ctx), ...foreignHosts(ctx2)].join(", "));
  const errors = [...ctx.errors, ...ctx2.errors];
  check("no console errors", errors.length === 0, errors.slice(0, 5).join(" | "));
  const failed = [...ctx.failed, ...ctx2.failed].filter((f) => !f.includes(`/api/projects/issues/${n(1)}?`) || !f.startsWith("403"));
  check("no failed requests", failed.length === 0, failed.slice(0, 5).join(" | "));
} catch (e) {
  check("projects e2e ran", false, String(e).slice(0, 400));
  await shot("zz-failure");
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
