// Builds the Design templates (web/templates/design/*.penpot) on a test stand:
// signs in with the stand's test sign-in, creates a file per template, turns
// each <template data-board> of html/<key>.html into layers (convert.js in
// the editor page → builder.js through the plugin runtime) and exports the
// file through the management API. Nothing but the stand is contacted.
//
//   . /etc/zvena/<stand>.env   # PENPOT_MGMT_KEY / DESIGN_MGMT_KEY, never printed
//   BASE=http://localhost:3100 DESIGN=http://localhost:3110 PENPOT_MGMT_URL=http://127.0.0.1:3111 \
//   PLAYWRIGHT_CORE=… node build.mjs [landing mobile-app ui-kit]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const BASE = process.env.BASE || "http://localhost:3100";
const DESIGN = process.env.DESIGN || "http://localhost:3110";
const MGMT = (process.env.PENPOT_MGMT_URL || "http://127.0.0.1:3111").replace(/\/+$/, "");
const KEY = process.env.PENPOT_MGMT_KEY || process.env.DESIGN_MGMT_KEY || "";
const OUT = process.env.OUT || join(here, "../../../web/templates/design");
// TEMPLATE_LANG=ru builds the Russian copies (html/ru → <key>.ru.penpot);
// the default is English (html → <key>.penpot).
const LANG = process.env.TEMPLATE_LANG || "en";
const HTML_DIR = LANG === "en" ? join(here, "html") : join(here, "html", LANG);
const outName = (key) => (LANG === "en" ? `${key}.penpot` : `${key}.${LANG}.penpot`);
const NAMES_BY_LANG = {
  en: { landing: "Landing page", "mobile-app": "Mobile app", "ui-kit": "UI kit" },
  ru: { landing: "Лендинг", "mobile-app": "Мобильное приложение", "ui-kit": "UI-кит" },
};
const NAMES = NAMES_BY_LANG[LANG] ?? NAMES_BY_LANG.en;
const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(NAMES);
if (!KEY) throw new Error("PENPOT_MGMT_KEY is not set");

// convert.js as a plain script for page.evaluate: exports dropped, the entry
// published on window.
const convert = readFileSync(join(here, "convert.js"), "utf8").replace(/^export /gm, "") + "\nwindow.__zvHtmlToSpec = htmlToSpec;";
const builder = readFileSync(join(here, "builder.js"), "utf8");

async function waitDesign(page) {
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(1500);
    if (!page.url().startsWith(DESIGN) || !page.url().includes("workspace")) continue;
    const ready = await page.evaluate(() => typeof window["ɵloadPlugin"] === "function").catch(() => false);
    if (ready) return;
  }
  throw new Error("Design editor did not open");
}

async function frames(page, ws, fileId) {
  const r = await page.request.get(`${BASE}/api/design/frames?ws=${ws}&file=${fileId}`);
  return r.ok() ? ((await r.json()).frames ?? []) : [];
}

const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
mkdirSync(OUT, { recursive: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru" });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("  console:", m.text().slice(0, 300)));
  await page.goto(`${BASE}/signin?next=/home`);
  await page.locator(".zv-check input[type=checkbox]").check();
  await page.fill('input[name="name"]', "Шаблоны zvena");
  await Promise.all([page.waitForNavigation(), page.click('form[action="/api/auth/dev"] button[type=submit]')]);
  const me = await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  const ws = me.user.ws.id;
  const login = `u-${me.user.id}@${process.env.PENPOT_EMAIL_DOMAIN || "users.zvena.app"}`;

  // One file per template; a failed run (the editor still settling) retries
  // in a fresh file.
  async function buildFile(key, html) {
    await page.goto(`${BASE}/design?ws=${ws}&new=1&name=${encodeURIComponent(NAMES[key] ?? key)}`);
    await waitDesign(page);
    await page.waitForTimeout(6000);
    const fileId = new URL(page.url().replace("#/", "")).searchParams.get("file-id");

    // HTML → specs inside the editor page (Design serves the font).
    await page.evaluate(convert);
    const specs = await page.evaluate(async (source) => {
      const doc = new DOMParser().parseFromString(source, "text/html");
      const out = [];
      for (const t of doc.querySelectorAll("template[data-board]")) {
        const { spec } = await window.__zvHtmlToSpec(t.innerHTML, { fontBase: location.origin });
        out.push({ name: t.dataset.board, spec });
      }
      return out;
    }, html);

    // Specs → layers through the plugin runtime.
    const code = builder.replace("__SPECS__", JSON.stringify(specs));
    await page.evaluate(
      (code) =>
        window["ɵloadPlugin"]({
          pluginId: "00000000-0000-0000-0000-000000000000", // Design's own id: every permission without installing
          name: "zvena templates",
          description: "",
          version: 2,
          host: "", // inline code (with a host the runtime fetches `code` as a URL)
          code,
          permissions: ["content:read", "content:write", "library:read"],
        }),
      code
    );
    let got = [];
    for (let i = 0; i < 40 && got.length < specs.length; i++) {
      await page.waitForTimeout(1500);
      got = await frames(page, ws, fileId);
    }
    if (got.length !== specs.length) throw new Error(`${key}: ${got.length}/${specs.length} boards saved`);
    await page.waitForTimeout(8000); // the last changes and the thumbnails
    await page.keyboard.press("Shift+1"); // zoom to fit, for the screenshot
    await page.waitForTimeout(1500);
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `tpl-${key}.png`) });
    return { fileId, boards: specs.length };
  }

  for (const key of keys) {
    const html = readFileSync(join(HTML_DIR, `${key}.html`), "utf8");
    let built = null;
    for (let attempt = 1; !built; attempt++) {
      try {
        built = await buildFile(key, html);
      } catch (e) {
        if (attempt >= 3) throw e;
        console.log(`${key}: attempt ${attempt} failed (${String(e.message).slice(0, 120)}), retrying`);
      }
    }
    const { fileId, boards } = built;
    const res = await fetch(`${MGMT}/management/zvena/export-file`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shared-key": KEY },
      body: JSON.stringify({ email: login, fileId }),
    });
    if (!res.ok) throw new Error(`${key}: export ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    writeFileSync(join(OUT, outName(key)), bytes);
    console.log(`${key}: ${boards} boards, ${(bytes.length / 1024).toFixed(0)} KB → ${outName(key)}`);
  }
} finally {
  await browser.close();
}
