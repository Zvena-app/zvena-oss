// Screenshots of the main screens (light and dark, desktop and phone) for a
// visual check; public pages are captured whole (full page).
//   SHOTS=<dir> node tests/e2e/shots.mjs
import { BASE, context, devSignIn, launch } from "./lib.mjs";

const out = process.env.SHOTS || ".";
const PUBLIC = [
  ["signin", "/signin"],
  ["help", "/help"],
  ["privacy", "/legal/privacy"],
  ["terms", "/legal/terms"],
  ["cookies", "/legal/cookies"],
  ["status", "/status"],
  ["source", "/source"],
];
const browser = await launch();
for (const [label, opts] of [
  ["desktop", { viewport: { width: 1280, height: 860 } }],
  ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await context(browser, { ...opts, colorScheme: scheme });
    const page = await ctx.newPage();
    const shot = async (name, fullPage = false) => page.screenshot({ path: `${out}/${label}-${scheme}-${name}.png`, fullPage });
    for (const [name, path] of PUBLIC) {
      if (scheme === "dark" && !["landing", "signin", "about"].includes(name)) continue;
      await page.goto(BASE + path);
      await page.waitForTimeout(400);
      await shot(name, true);
    }
    await devSignIn(page, `Ivan Shots ${label}${scheme}`);
    await shot("home");
    await page.goto(`${BASE}/docs`);
    await page.waitForTimeout(3500);
    await shot("docs");
    await page.goto(`${BASE}/team`);
    await shot("team");
    await page.goto(`${BASE}/settings`);
    await shot("settings", true);
    await ctx.close();
  }
}
await browser.close();
console.log("shots in", out);
