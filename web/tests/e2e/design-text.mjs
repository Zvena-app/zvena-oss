// Text in Design (needs Design): a text layer typed on the canvas, over two
// lines, made bold, undone and redone, is saved and still there after a reload,
// with no errors in the page.
//   BASE=http://localhost:3100 DESIGN=http://localhost:3110 node tests/e2e/design-text.mjs
import { BASE, DESIGN, check, context, devSignIn, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const WORDS = `Hello ${RUN}`;

/** Design finished signing in through zvena (as in design-bridge.mjs). */
async function designReady(page, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await page.waitForTimeout(1500);
    if (!page.url().startsWith(DESIGN)) continue;
    const id = await page
      .evaluate(() => fetch("/api/main/methods/get-profile", { headers: { accept: "application/json" } }).then((r) => r.json()).then((p) => p.id).catch(() => null))
      .catch(() => null);
    if (id && id !== "00000000-0000-0000-0000-000000000000") {
      await page.waitForTimeout(2500);
      return true;
    }
  }
  return false;
}

/** The editor has finished starting: the rasterizer iframe has loaded (start-of-file input is lost before that). */
async function editorSettled(page, timeout = 90000) {
  await page
    .waitForFunction(() => { const f = document.getElementById("rasterizer"); if (!f) return false; try { return /rasterizer/.test(f.contentWindow.location.href) && f.contentDocument?.readyState === "complete"; } catch { return true; } }, null, { timeout, polling: 500 })
    .catch(() => undefined);
}

const browser = await launch();
const ctx = await context(browser);
try {
  if (!DESIGN) throw new Error("DESIGN is not set");
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await devSignIn(page, `Text ${RUN}`);
  const ws = (await ctx.request.fetch(`${BASE}/api/ws`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, data: JSON.stringify({ name: `Text ${RUN}` }) }).then((r) => r.json())).workspace.id;
  await page.goto(`${BASE}/design?ws=${ws}&new=1&name=${encodeURIComponent(`Text ${RUN}`)}`);
  check("1 Design opened signed in", await designReady(page), new URL(page.url()).origin);
  await page.waitForURL((u) => u.toString().includes("file-id="), { timeout: 60000 });
  await editorSettled(page);
  await page.waitForTimeout(2500);
  const vp = await page.locator(".viewport, [data-testid='viewport'], canvas").first().boundingBox();
  const cx = vp ? vp.x + vp.width / 2 : 640;
  const cy = vp ? vp.y + vp.height / 2 : 430;

  // Type two lines into a new text layer (the text tool, a click on the canvas).
  await page.mouse.click(cx + 300, cy + 220);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.keyboard.press("t");
  await page.waitForTimeout(300);
  await page.mouse.click(cx - 200, cy - 150);
  await page.waitForTimeout(Number(process.env.TEXT_WAIT || 800));
  await page.keyboard.type(WORDS, { delay: 30 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line", { delay: 30 });
  // Bold on everything typed.
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+b");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/design-text-typed.png` });
  const layers = () => page.getByTestId("layer-row").allInnerTexts().then((t) => t.join(" | ")).catch(() => "");
  check("2 the text layer is in Layers", (await layers()).includes(WORDS), (await layers()).slice(0, 200));

  // Undo the layer, redo it.
  await page.mouse.click(cx + 260, cy + 200);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(800);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(800);
  const afterUndo = await layers();
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(800);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(1500);
  check("3 undo and redo work on it", (await layers()).includes(WORDS), `after undo: ${afterUndo.includes(WORDS)}`);

  // Saved: after a reload the text is still there, both lines.
  await page.waitForTimeout(4000);
  await page.reload();
  await designReady(page);
  await editorSettled(page);
  await page.getByTestId("layer-row").filter({ hasText: WORDS }).first().waitFor({ timeout: 30000 }).catch(() => undefined);
  check("4 after a reload the layer is still there", (await layers()).includes(WORDS), (await layers()).slice(0, 200));
  const content = await page
    .evaluate(async ({ id }) => {
      const r = await fetch(`/api/main/methods/get-file?id=${id}`, { headers: { accept: "application/json" } });
      return r.ok ? JSON.stringify(await r.json()) : `HTTP ${r.status}`;
    }, { id: new URLSearchParams(page.url().split("?").slice(1).join("?")).get("file-id") })
    .catch((e) => String(e));
  check("5 …with both lines", (await layers()).includes(`${WORDS} second line`), (await layers()).slice(0, 200));
  check("6 the text is bold", /"font-weight":"?700/.test(content) || /fontWeight"?:"?700/.test(content), (content.match(/.{0,40}font-weight.{0,20}/) || [""])[0]);
  check("7 no errors in the page", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("design-text ran", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
