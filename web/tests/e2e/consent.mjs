// The Terms changed: a signed-in person accepts the new version before going
// on (pages, Docs and Design through OIDC), or signs out.
//   BASE=… WEB_CONTAINER=zvena-web-1 PLAYWRIGHT_CORE=… node tests/e2e/consent.mjs
import { execFileSync } from "node:child_process";
import { BASE, check, context, devSignIn, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
function staleConsent(userId) {
  if (!/^[0-9a-f]+$/.test(userId)) throw new Error("bad user id");
  const js = `const {DatabaseSync}=require("node:sqlite");new DatabaseSync(process.env.ZVENA_DB_PATH).prepare("UPDATE users SET consent_version = '2000-01-01' WHERE id = ?").run("${userId}");`;
  execFileSync("docker", ["exec", process.env.WEB_CONTAINER || "zvena-web-1", "node", "--no-warnings", "-e", js], { stdio: "ignore" });
}

const browser = await launch();
try {
  const ctx = await context(browser);
  const p = await ctx.newPage();
  await devSignIn(p, `Consent ${RUN}`);
  const me = await p.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  staleConsent(me.user.id);

  for (const path of ["/home", "/docs", "/design"]) {
    await p.goto(BASE + path);
    check(`${path} asks to accept the new Terms`, new URL(p.url()).pathname === "/consent", p.url());
  }
  check("the page names the Terms", (await p.locator("main").innerText()).includes("Terms of Service"));
  const button = p.locator("form[action='/api/auth/consent'] button[type=submit]");
  // next=/design: zvena → Design → OIDC back through zvena; let the chain settle.
  await button.click();
  for (let i = 0; i < 20 && (p.url().includes("/consent") || (!p.url().includes("workspace") && !p.url().includes("dashboard"))); i++) await p.waitForTimeout(1000);
  check("after agreeing the person goes on", !p.url().includes("/consent"), p.url());
  await p.goto(`${BASE}/home`);
  check("and is not asked again", new URL(p.url()).pathname === "/home", p.url());

  staleConsent(me.user.id);
  await p.goto(`${BASE}/home`);
  await Promise.all([p.waitForURL(`${BASE}/`), p.locator("button", { hasText: "Sign out" }).click()]);
  const after = await p.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  check("refusing signs out", after.user === null);
} catch (e) {
  check("consent check ran to the end", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
