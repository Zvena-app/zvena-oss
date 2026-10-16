// The shared frame, arranged as Linear's (2026-10-15): the workspace menu with
// search and compose beside it, foldable rail groups that stay folded, Try →
// Import opens Docs' import, "?" help, the inset work panel, Esc and arrow
// keys in the menus, and the phone drawer closing once you go somewhere.
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
try {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await devSignIn(page, `Riley Shell ${RUN}`);
  await page.waitForSelector(".ds-ws-btn");

  // The work is an inset panel next to the rail; the window itself doesn't scroll.
  const panel = await page.evaluate(() => {
    const m = document.querySelector(".zv-main").getBoundingClientRect();
    const s = getComputedStyle(document.querySelector(".zv-main"));
    return { left: m.left, top: m.top, radius: parseFloat(s.borderTopLeftRadius), scrolls: document.scrollingElement.scrollHeight <= innerHeight + 1 };
  });
  check("the work sits in an inset rounded panel", panel.top >= 6 && panel.radius > 0 && panel.scrolls, JSON.stringify(panel));

  // Workspace menu: account, settings, language, sign out; Esc closes it and gives focus back.
  await page.click(".ds-ws-btn");
  const menu = page.locator(".ds-ws-menu");
  check("workspace menu opens with the account", (await menu.innerText()).includes(`Riley Shell ${RUN}`));
  check("…and has Settings, Invite people and Sign out", /Settings/.test(await menu.innerText()) && /Invite people/.test(await menu.innerText()) && /Sign out/.test(await menu.innerText()));
  check("…and the language picker", (await menu.locator("select").count()) === 1);
  check("focus moves into the menu", await page.evaluate(() => document.activeElement?.closest(".ds-ws-menu") != null));
  await page.keyboard.press("ArrowDown");
  check("arrow keys move inside the menu", await page.evaluate(() => document.activeElement?.closest(".ds-ws-menu") != null));
  await page.keyboard.press("Escape");
  check("Esc closes it and focus returns to its button", (await menu.count()) === 0 && (await page.evaluate(() => document.activeElement?.classList.contains("ds-ws-btn"))));

  // Folding a group survives a reload.
  const fold = page.locator(".ds-rail-fold", { hasText: "Workspace" });
  await fold.click();
  check("folding Workspace hides its sections", (await page.locator(".zv-side a", { hasText: "Calendar" }).count()) === 0);
  await page.reload();
  await page.waitForSelector(".ds-ws-btn");
  await page.waitForTimeout(500);
  check("…and it stays folded after a reload", (await page.locator(".ds-rail-fold", { hasText: "Workspace" }).getAttribute("aria-expanded")) === "false");
  await page.locator(".ds-rail-fold", { hasText: "Workspace" }).click();
  check("unfolding shows them again", (await page.locator(".zv-side a", { hasText: "Calendar" }).count()) === 1);

  // "?" help, from the keyboard.
  await page.focus(".ds-help-btn");
  await page.keyboard.press("Enter");
  check("help menu lists the help center", (await page.locator('.ds-help-menu [role="menuitem"]', { hasText: "Help center" }).count()) === 1);
  await page.keyboard.press("Escape");

  // Compose opens the create picker.
  await page.click(".zc-create-icon");
  check("compose opens the create picker", await page.locator(".zc-pop").isVisible());
  await page.keyboard.press("Escape");

  // Try → Import docs opens Docs' import dialog.
  await page.locator(".zv-side a", { hasText: "Import docs" }).click();
  await page.waitForURL(/\/docs/);
  const imported = await page
    .waitForSelector('[role="dialog"] >> text=/Import/i', { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check("Try → Import docs opens the import dialog", imported, page.url());
  check("…and tidies the address", !page.url().includes("import=1"), page.url());

  // Pages of the frame get Linear's thin header.
  await page.goto(`${BASE}/inbox`);
  check("Inbox has the thin page header", (await page.locator(".ds-page-head h1", { hasText: "Inbox" }).count()) === 1);

  // Phone: the drawer closes once a link in it is followed.
  const phone = await context(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/home`);
  check("closed drawer is hidden", (await pp.locator(".zv-side").evaluate((el) => getComputedStyle(el).visibility)) === "hidden");
  await pp.click(".ds-menu-btn");
  await pp.waitForTimeout(400);
  check("menu button opens the drawer", (await pp.locator(".zv-side").evaluate((el) => getComputedStyle(el).visibility)) === "visible");
  await pp.click(".zc-create-icon");
  await pp.waitForTimeout(400);
  check("compose on a phone opens the sheet and closes the drawer", (await pp.locator(".zc-pop").isVisible()) && (await pp.locator(".zv-shell[data-open]").count()) === 0);
  await pp.keyboard.press("Escape");
  await pp.click(".ds-menu-btn");
  await pp.waitForTimeout(400);
  await pp.locator(".zv-side a", { hasText: "Inbox" }).click();
  await pp.waitForURL(/\/inbox/);
  await pp.waitForTimeout(500);
  check("drawer is closed on the new page", (await pp.locator(".zv-shell[data-open]").count()) === 0);
  // A section button that opens a modal dialog (Docs' Import) closes the drawer too (popovers anchored in it, like Trash, keep it); touch targets are 32 px+.
  await pp.goto(`${BASE}/docs#home`);
  await pp.waitForSelector(".ds-section-nav", { state: "attached", timeout: 60000 });
  await pp.waitForTimeout(3000); // Docs settles its address (#home → the last page) first
  await pp.click(".ds-menu-btn");
  await pp.waitForTimeout(400);
  const plus = await pp.locator(".ds-nav-title > button:not(.ds-rail-fold), .ds-nav-title > a").first().boundingBox();
  check("section heading buttons are 32 px on touch", plus && plus.width >= 32 && plus.height >= 32, JSON.stringify(plus));
  await pp.locator(".ds-section-nav [role=\"button\"]", { hasText: /^Import$/ }).first().click();
  await pp.waitForTimeout(800);
  if (process.env.SHOTS) await pp.screenshot({ path: `${process.env.SHOTS}/phone-import.png` });
  check("a dialog from the drawer closes the drawer", (await pp.locator(".zv-shell[data-open]").count()) === 0 && (await pp.locator('[role="dialog"]').count()) > 0);

  check("no foreign hosts", foreignHosts(ctx).length === 0, foreignHosts(ctx).join(", "));
  check("no console errors", ctx.errors.length === 0, ctx.errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
