// Welcome: a new account sets zvena up (app/welcome) — name, look, team,
// invites — and lands where it was going; invitees skip the team steps;
// /welcome?next= never leaves zvena; Settings brings it back.
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const ctx = await context(browser);
const page = await ctx.newPage();
const h1 = (p) => p.locator("h1").first().innerText();
const next = (p) => p.click("[data-test=welcome-next]");
try {
  // 1. A new account lands on /welcome, its way on kept in `next`.
  await devSignIn(page, `Wendy Welcome ${RUN}`, { welcome: true });
  const u = new URL(page.url());
  check("1 a new account lands on /welcome", u.pathname === "/welcome" && u.searchParams.get("next") === "/home?welcome=1", page.url());
  await page.waitForSelector("[data-test=welcome-name]");
  check("2 it asks for the name, filled in from sign-in", (await page.inputValue("[data-test=welcome-name]")).startsWith("Wendy Welcome"));

  // 2. The name: saved before the next step, and the avatar follows it.
  await page.fill("[data-test=welcome-name]", `Alex ${RUN} Rivera`);
  check("3 the avatar shows the new name's initial", (await page.locator(".zw-avatar").innerText()).trim() === "E");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-test=welcome-theme-dark]");
  const me = await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  check("4 Enter saves the name and goes on", me.user?.name === `Alex ${RUN} Rivera`, me.user?.name);

  // 3. The look changes as it is clicked, and is remembered.
  await page.click("[data-test=welcome-theme-dark]");
  check("5 dark applies at once", await page.evaluate(() => document.documentElement.classList.contains("dark")));
  await page.click("[data-test=welcome-theme-light]");
  const theme = await page.evaluate(() => JSON.parse(localStorage.getItem("zvena-settings") || "{}").theme);
  check("6 light is stored for this browser", theme === "light" && !(await page.evaluate(() => document.documentElement.classList.contains("dark"))), theme);
  await next(page);

  // 4. A team: a shared workspace with the name given.
  await page.click("[data-test=welcome-team]");
  check("7 the team name is offered from the first name", (await page.inputValue("[data-test=welcome-team-name]")).includes("Alex"));
  await page.fill("[data-test=welcome-team-name]", `Lab ${RUN}`);
  await next(page);
  await page.waitForSelector("[data-test=welcome-emails]");
  const list = await page.evaluate(() => fetch("/api/ws").then((r) => r.json()));
  const team = (list.workspaces ?? []).find((w) => w.name === `Lab ${RUN}`);
  check("8 the team workspace exists, owned by them", team && !team.personal && team.role === "owner", JSON.stringify(list.workspaces?.map((w) => w.name)));

  // 5. Invites: good addresses get invites, a bad one stays in the box with a message.
  await page.fill("[data-test=welcome-emails]", `ana-${RUN}@example.com, not-an-address`);
  await page.click("[data-test=welcome-send]");
  await page.waitForSelector(".zw-sent li");
  check("9 the good address is invited", (await page.locator(".zw-sent").innerText()).includes(`ana-${RUN}@example.com`));
  check("10 the bad one stays with a message", (await page.inputValue("[data-test=welcome-emails]")) === "not-an-address" && (await page.locator(".zw-error").innerText()).includes("not-an-address"));
  await page.click("[data-test=welcome-make-link]");
  const link = await page.inputValue("[data-test=welcome-link]");
  check("11 an invite link to the team", link.startsWith(`${BASE}/join/`), link);
  await next(page);

  // 6. Done: greets by the first name, opens the team's Home.
  check("12 done greets by the first name", (await h1(page)).includes("Alex"));
  await Promise.all([page.waitForURL(/\/home\?ws=/), page.click("[data-test=welcome-open]")]);
  await page.waitForSelector(".eco-home-hello");
  check("13 Home greets them by the name they chose", (await page.locator(".eco-home-hello").innerText()).includes("Alex"));
  check("14 Home opens in the new team", (await page.locator(".eco-home-today").innerText()).includes(`Lab ${RUN}`));

  // 7. Someone arriving through an invite only sets up name and look, then joins.
  const ctx2 = await context(browser);
  const p2 = await ctx2.newPage();
  await devSignIn(p2, `Ana ${RUN}`, { next: new URL(link).pathname, welcome: true });
  check("15 an invitee is asked to set up too", new URL(p2.url()).pathname === "/welcome", p2.url());
  await p2.waitForSelector(".zw-steps li");
  check("16 without the team steps", (await p2.locator(".zw-steps li").count()) === 3);
  await next(p2);
  await p2.waitForSelector("[data-test=welcome-theme-light]");
  await next(p2);
  await Promise.all([p2.waitForURL(/\/join\//), p2.click("[data-test=welcome-open]")]);
  check("17 then the invite opens", new URL(p2.url()).pathname === new URL(link).pathname, p2.url());

  // 8. `next` never leaves zvena.
  for (const evil of ["https://evil.example/x", "//evil.example/x", "/\\evil.example"]) {
    await page.goto(`${BASE}/welcome?next=${encodeURIComponent(evil)}`);
    await page.waitForSelector("[data-test=welcome-name]");
    await next(page);
    await page.waitForSelector("[data-test=welcome-theme-light]");
    await next(page);
    await page.waitForSelector("[data-test=welcome-open]");
    await page.click("[data-test=welcome-open]");
    await page.waitForLoadState("load");
    check(`18 next=${evil} stays on zvena`, new URL(page.url()).origin === BASE && !page.url().includes("evil.example/x"), page.url());
  }

  // 9. Settings brings it back for an existing account.
  await page.goto(`${BASE}/settings`);
  await Promise.all([page.waitForURL(/\/welcome\?next=%2Fsettings/), page.click("[data-test=settings-welcome]")]);
  await page.waitForSelector("[data-test=welcome-name]");
  check("19 Settings → set up again", (await page.inputValue("[data-test=welcome-name]")) === `Alex ${RUN} Rivera`);

  check("no foreign hosts", foreignHosts(ctx).length === 0 && foreignHosts(ctx2).length === 0, [...foreignHosts(ctx), ...foreignHosts(ctx2)].join(", "));
  check("no console errors", ctx.errors.length === 0 && ctx2.errors.length === 0, [...ctx.errors, ...ctx2.errors].slice(0, 3).join(" | "));
} catch (e) {
  check("welcome ran", false, String(e).slice(0, 300));
} finally {
  await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/welcome-last.png` : "/dev/null" }).catch(() => {});
  await browser.close();
}
process.exit(summary() ? 0 : 1);
