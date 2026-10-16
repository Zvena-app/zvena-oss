// Documents' editor: after clicking a block without text (divider, sub-page,
// database), a click into the empty line below takes typing (Chrome kept the
// node selection and swallowed every key).
//   BASE=… PLAYWRIGHT_CORE=… CHROMIUM=… E2E_LANG=ru node tests/e2e/docs-editor.mjs
import { BASE, check, context, devSignIn, launch, summary } from "./lib.mjs";

const browser = await launch();
const ctx = await context(browser);
const p = await ctx.newPage();
try {
  await devSignIn(p, `Редактор ${Math.random().toString(36).slice(2, 6)}`);
  await p.goto(`${BASE}/docs#new`);
  await p.waitForSelector(".nt-title", { timeout: 60000 });
  await p.locator(".nt-title").click();
  await p.keyboard.type("Узлы");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Над чертой");
  await p.keyboard.press("Enter");
  await p.keyboard.type("---");
  await p.waitForTimeout(500);
  const hr = p.locator('.nt-main [data-content-type="divider"]').first();
  check("1 a divider was made", (await hr.count()) > 0);
  // The empty line under the divider.
  const below = p.locator('.nt-main .bn-block-outer:has([data-content-type="divider"]) + .bn-block-outer [data-content-type="paragraph"]').first();
  if ((await below.count()) === 0) {
    await hr.click();
    await p.keyboard.press("Enter");
  }
  await hr.click();
  await p.waitForTimeout(300);
  await below.click();
  await p.keyboard.type("после клика");
  await p.waitForTimeout(500);
  check("2 typing after clicking the divider lands in the line below", (await p.locator(".nt-main").innerText()).includes("после клика"));
  // Enter in a new page's title and type at once (the live session may still be connecting): the text goes to the body.
  for (let i = 0; i < 3; i++) {
    await p.goto("about:blank");
    await p.goto(`${BASE}/docs#new`);
    await p.waitForSelector(".nt-title", { timeout: 60000 });
    await p.locator(".nt-title").click();
    await p.keyboard.type(`Быстро ${i}`);
    await p.keyboard.press("Enter");
    await p.keyboard.type("сразу текст");
    await p.waitForTimeout(1500);
    const title = await p.locator(".nt-title").inputValue();
    const body = await p.locator(".nt-main .bn-editor").innerText().catch(() => "");
    check(`4.${i} Enter then typing: the title stays, the text is in the body`, title === `Быстро ${i}` && body.includes("сразу текст"), `title=${title} body=${body.slice(0, 60)}`);
  }
  check("3 no console errors", ctx.errors.length === 0, ctx.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("docs-editor ran", false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
