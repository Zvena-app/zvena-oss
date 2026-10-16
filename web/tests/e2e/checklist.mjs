// The stand checklist: sign-up with the test sign-in, a team,
// a design, a document with the live design, an invite, a public link, a
// complaint and its moderation, roles, data export and account deletion —
// two people in two browsers, no foreign hosts anywhere.
//
//   BASE=http://localhost:3100 DESIGN=http://localhost:3110 \
//   ZVENA_DB_PATH=<the dev server's db> | WEB_CONTAINER=zvena-staging-web-1 \
//   PLAYWRIGHT_CORE=… SHOTS=<dir> node tests/e2e/checklist.mjs
import { BASE, check, context, DESIGN, designSettled, devSignIn, DOCS_NAV, foreignHosts, launch, moveToWorkspace, pastWelcome, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const shots = process.env.SHOTS;
const shot = async (page, name) => shots && page.screenshot({ path: `${shots}/check-${name}.png` }).catch(() => {});

async function designReady(page, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await page.waitForTimeout(1500);
    if (!page.url().startsWith(DESIGN)) continue;
    const id = await page
      .evaluate(() => fetch("/api/main/methods/get-profile", { headers: { accept: "application/json" } }).then((r) => r.json()).then((p) => p.id).catch(() => null))
      .catch(() => null);
    if (id && id !== "00000000-0000-0000-0000-000000000000") {
      // Signed in; the frontend then leaves #/auth/verify-token for the file.
      await page.waitForURL(/workspace/, { timeout: Math.max(1000, end - Date.now()) }).catch(() => {});
      await page.waitForTimeout(3000);
      return true;
    }
  }
  return false;
}

// The moderator of the stand: the database file (dev server) or the web
// container (WEB_CONTAINER=zvena-staging-web-1).
async function makeAdmin(userId) {
  if (!/^[0-9a-f]+$/.test(userId)) throw new Error("bad user id");
  if (process.env.WEB_CONTAINER) {
    const { execFileSync } = await import("node:child_process");
    const js = `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.ZVENA_DB_PATH);db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run("${userId}");`;
    execFileSync("docker", ["exec", process.env.WEB_CONTAINER, "node", "-e", js], { stdio: "ignore" });
    return;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.ZVENA_DB_PATH);
  db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(userId);
  db.close();
}

const browser = await launch();
const ctxA = await context(browser, { viewport: { width: 1440, height: 900 } });
const ctxB = await context(browser, { viewport: { width: 1440, height: 900 } });
const ctxC = await context(browser);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
const c = await ctxC.newPage();
a.on("dialog", (d) => d.accept());
b.on("dialog", (d) => d.accept());
let wsId = "";
let publicUrl = "";
try {
  // 1. Sign-up of A (test sign-in, consent ticked).
  await devSignIn(a, `Анна Проверка ${RUN}`, { welcome: true });
  check("1 sign-up A goes through setting zvena up", new URL(a.url()).pathname === "/welcome" && new URL(a.url()).searchParams.get("next") === "/home?welcome=1", a.url());
  await pastWelcome(a);
  const me = await a.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  const aId = me.user.id;

  // 2. A team workspace.
  await a.goto(`${BASE}/team?new=1`);
  await a.fill("#new input", `Команда ${RUN}`);
  await Promise.all([a.waitForURL(/\/team\?ws=/), a.click("#new button[type=submit]")]);
  wsId = new URL(a.url()).searchParams.get("ws");
  check("2 team created", Boolean(wsId), a.url());

  // 3. Invite link (editor).
  await a.click("text=Создать ссылку");
  await a.waitForSelector(".zv-banner input");
  const invite = await a.inputValue(".zv-banner input");
  check("3 invite link", /\/join\/[A-Za-z0-9_-]{20,}$/.test(invite), invite);
  await shot(a, "team");

  // 4. A design with a frame.
  await a.goto(`${BASE}/design?ws=${wsId}&new=1&name=${encodeURIComponent("Макет " + RUN)}`);
  const ready = await designReady(a);
  check("4 design opened (OIDC)", ready && a.url().includes("workspace"), a.url());
  await designSettled(a);
  await a.waitForTimeout(1500);
  await a.mouse.click(700, 450);
  await a.keyboard.press("b");
  await a.mouse.move(520, 260);
  await a.mouse.down();
  await a.mouse.move(820, 620, { steps: 8 });
  await a.mouse.up();
  await a.waitForTimeout(600);
  await a.keyboard.press("r");
  await a.mouse.move(560, 300);
  await a.mouse.down();
  await a.mouse.move(760, 420, { steps: 6 });
  await a.mouse.up();
  await a.keyboard.press("Escape");
  await a.mouse.click(1100, 760);
  await a.waitForTimeout(15000);
  await shot(a, "design");
  const fileId = new URL(a.url().replace("#/", "")).searchParams.get("file-id");
  const frames = await (await a.request.get(`${BASE}/api/design/frames?ws=${wsId}&file=${fileId}`)).json().catch(() => ({}));
  check("4 board drawn and saved", frames.frames?.length === 1, JSON.stringify(frames).slice(0, 200));

  // 5. A document with the live design.
  await a.goto(`${BASE}/docs?ws=${wsId}#new`);
  await a.waitForSelector(".nt-title", { timeout: 60000 });
  await a.locator(".nt-title").click();
  await a.keyboard.type("Спецификация");
  await a.keyboard.press("Enter");
  await a.keyboard.type("Главный экран:");
  await a.keyboard.press("Enter");
  await a.keyboard.type("/макет", { delay: 60 });
  await a.waitForTimeout(800);
  await a.keyboard.press("Enter");
  await a.waitForSelector(".nt-design-picker-row", { timeout: 30000 });
  await a.locator(".nt-design-picker-row", { hasText: `Макет ${RUN}` }).first().click();
  await a.waitForSelector(".nt-design-picker-row", { timeout: 30000 });
  await a.locator(".nt-design-picker-row").first().click();
  let imgOk = false;
  for (let i = 0; i < 20 && !imgOk; i++) {
    await a.waitForTimeout(3000);
    imgOk = await a.evaluate(() => {
      const img = document.querySelector(".nt-design img");
      return Boolean(img && img.complete && img.naturalWidth > 0);
    });
    if (!imgOk && i % 4 === 3) await a.locator(".nt-design-bar button").first().click().catch(() => {});
  }
  check("5 live design in the document", imgOk);
  // New pages start in Private (Notion): the team sees it once it is in the workspace's pages.
  await moveToWorkspace(a);
  await shot(a, "doc-design");

  // 6. Publish the page.
  await a.waitForTimeout(2500);
  await a.locator("button", { hasText: "Поделиться" }).first().click();
  // Docs' share window has a "Publish" tab (Notion); the older one had the button right there.
  const publishTab = a.locator(".nt-share-tab", { hasText: "Публикация" }).first();
  if (await publishTab.isVisible().catch(() => false)) await publishTab.click();
  await a.locator(".nt-share button", { hasText: "Опубликовать" }).first().click();
  await a.waitForSelector(".nt-share-link input", { timeout: 20000 });
  publicUrl = await a.inputValue(".nt-share-link input");
  check("6 page published", /\/n\/[A-Za-z0-9]{16,}/.test(publicUrl), publicUrl);
  await a.keyboard.press("Escape");

  // 7. B joins by the link and sees the document.
  await devSignIn(b, `Борис Проверка ${RUN}`);
  await b.goto(invite);
  await Promise.all([b.waitForURL(/\/home\?ws=/), b.click("text=Присоединиться")]);
  check("7 B joined", b.url().includes(wsId), b.url());
  await b.goto(`${BASE}/docs?ws=${wsId}`);
  await b.waitForTimeout(5000);
  check("7 B sees the document", (await b.locator(DOCS_NAV).innerText()).includes("Спецификация"));

  // 8. B opens the team's design.
  await b.goto(`${BASE}/design?ws=${wsId}`);
  await designReady(b);
  await b.waitForTimeout(3000);
  const bDash = await b.locator("body").innerText();
  check("8 B sees the team's design", bDash.includes(`Макет ${RUN}`), bDash.slice(0, 200));
  await shot(b, "b-design");

  // 9. A makes B a viewer.
  await a.goto(`${BASE}/team?ws=${wsId}`);
  const row = a.locator(".zv-row", { hasText: `Борис Проверка ${RUN}` });
  await row.locator("select").selectOption("viewer");
  await a.waitForTimeout(2500);
  await a.reload();
  check("9 B is a viewer", (await a.locator(".zv-row", { hasText: `Борис Проверка ${RUN}` }).locator("select").inputValue()) === "viewer");

  // 10. B reads only.
  await b.goto(`${BASE}/docs?ws=${wsId}`);
  await b.waitForTimeout(5000);
  const bBody = await b.locator(".nt-root").innerText();
  check("10 B sees the read-only notice", /зритель/.test(bBody), bBody.slice(0, 200));
  check("10 B cannot add pages", (await b.locator(".nt-new-page").count()) === 0);
  await shot(b, "b-readonly");

  // 11. A guest opens the public page.
  await c.goto(publicUrl);
  await c.waitForTimeout(4000);
  const pub = await c.locator("body").innerText();
  check("11 public page opens", pub.includes("Спецификация"), pub.slice(0, 160));
  check("11 public page keeps the design private", (await c.locator(".nt-design-public").count()) === 1 && (await c.locator(".nt-design img").count()) === 0);
  await shot(c, "public-page");

  // 12. The guest reports it.
  await c.locator("a", { hasText: "Сообщить о нарушении" }).first().click();
  await c.waitForURL(/\/report\?url=/);
  await c.selectOption("select", "spam");
  await c.fill("textarea", "Проверка очереди жалоб");
  await c.click("button[type=submit]");
  await c.waitForSelector("text=Жалоба отправлена", { timeout: 15000 });
  check("12 complaint sent", true);

  // 13. A moderates it.
  await makeAdmin(aId);
  await a.goto(`${BASE}/admin`);
  const card = a.locator(".zv-card", { hasText: "Проверка очереди жалоб" });
  check("13 complaint in the queue", (await card.count()) === 1);
  await card.locator("button", { hasText: "Снять с публикации" }).click();
  await a.waitForTimeout(2500);
  // The 404 of the taken-down page is the expected answer, not an error.
  c.removeAllListeners("console");
  const gone = await c.goto(publicUrl);
  check("13 page taken down", gone?.status() === 404, String(gone?.status()));

  // 14. A downloads all their data.
  const exp = await a.request.get(`${BASE}/api/export`);
  const zip = Buffer.from(await exp.body());
  const names = zip.toString("latin1");
  check("14 export", exp.ok() && names.includes("account.json") && names.includes("documents/") && names.includes(".penpot"), `${zip.length} bytes`);

  // 15. B deletes the account.
  await b.goto(`${BASE}/settings`);
  await b.fill("input[autocomplete=off]", "УДАЛИТЬ");
  await Promise.all([b.waitForURL(`${BASE}/`), b.locator("button", { hasText: "Удалить аккаунт" }).click()]);
  const after = await b.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  check("15 B deleted and signed out", after.user === null);
  await a.goto(`${BASE}/team?ws=${wsId}`);
  check("15 the team keeps A only", !(await a.locator("body").innerText()).includes(`Борис Проверка ${RUN}`));

  check("no foreign hosts", [ctxA, ctxB, ctxC].every((x) => foreignHosts(x).length === 0), [ctxA, ctxB, ctxC].flatMap(foreignHosts).join(", "));
  ctxC.failed = ctxC.failed.filter((f) => f !== `404 ${publicUrl}`);
  check("no console errors", [ctxA, ctxB, ctxC].every((x) => x.errors.length === 0 && x.failed.length === 0), [ctxA, ctxB, ctxC].flatMap((x) => [...x.errors, ...x.failed]).slice(0, 6).join(" | "));
} catch (e) {
  check("checklist ran to the end", false, String(e).slice(0, 500));
  await shot(a, "fail-a");
  await shot(b, "fail-b");
  await shot(c, "fail-c");
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
