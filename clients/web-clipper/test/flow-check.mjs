// The whole clipper flow in a real Chromium against a stand-in zvena server
// that speaks the clipper's contract: Connect (PKCE, the code handed over
// by the content script), the destination picker, a clip of an article and
// of a selection, recent destinations, Disconnect. The server checks what a
// real one would: the verifier, the bearer token, no cookies.
//   node build.mjs --server http://127.0.0.1:39571 --out dist/chrome-mock
//   docker run --rm --name zvcli-ext-$$ --network host -v $PWD/clients/web-clipper:/clipper:ro \
//     -e PLAYWRIGHT_CORE=… -e CHROMIUM=… --entrypoint node penpotapp/exporter:2.18.3 /clipper/test/flow-check.mjs

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const dir = process.argv[2] || new URL("../dist/chrome-mock", import.meta.url).pathname;
const PORT = 39571;
const APP = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- The stand-in server ---------------------------------------------------------

const srv = { challenge: "", state: "", code: "c0de-0123456789abcdef", token: "zvc_test_token_0123456789", revoked: false, clips: [], cookies: [], bad: [] };
const DESTS = [
  { id: "pg1", kind: "page", title: "Reading list", icon: "📚", path: "" },
  { id: "db1", kind: "database", title: "Projects", icon: "", path: "Team" },
];
const article = `<!doctype html><html><head><title>Mock article</title><meta property="og:image" content="/cover.png"></head><body><nav>Menu</nav><article><h1>Mock article</h1>${Array.from({ length: 10 }, (_, i) => `<p id="p${i}">Paragraph ${i} of the mock article, with <a href="/rel/${i}">a link</a>, long enough for Readability to keep it as content.</p>`).join("")}<img src="/img/a.png"></article></body></html>`;

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, APP);
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (u.pathname.startsWith("/api/") && req.headers.cookie) srv.cookies.push(req.headers.cookie);
    const authed = req.headers.authorization === `Bearer ${srv.token}` && !srv.revoked;
    if (u.pathname === "/clipper/connect") {
      srv.challenge = u.searchParams.get("challenge") ?? "";
      srv.state = u.searchParams.get("state") ?? "";
      srv.client = u.searchParams.get("client");
      return send(res, 200, `<!doctype html><title>Connect</title><button id="allow" onclick="location.href='/clipper/connected#code=${srv.code}&state=${encodeURIComponent(srv.state)}'">Allow</button>`, "text/html");
    }
    if (u.pathname === "/clipper/connected") return send(res, 200, "<!doctype html><title>Connected</title><p>Connected</p>", "text/html");
    if (u.pathname === "/article") return send(res, 200, article, "text/html");
    if (/\.(png|ico)$/.test(u.pathname)) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    }
    if (u.pathname === "/api/clipper/token" && req.method === "POST") {
      const b = JSON.parse(raw || "{}");
      const ok = b.code === srv.code && createHash("sha256").update(String(b.verifier)).digest("base64url") === srv.challenge;
      if (!ok) srv.bad.push("token exchange");
      srv.revoked = false;
      return ok ? send(res, 200, { token: srv.token, user: { id: "u1", name: "Ada Clipper" }, expiresAt: Date.now() + 86400_000 }) : send(res, 400, { error: "bad code" });
    }
    if (u.pathname === "/api/clipper/token" && req.method === "DELETE") {
      if (authed) srv.revoked = true;
      return send(res, 200, { ok: true });
    }
    if (!authed && u.pathname.startsWith("/api/")) return send(res, 401, { error: "unauthorized" });
    if (u.pathname === "/api/clipper/me") return send(res, 200, { user: { id: "u1", name: "Ada Clipper" }, workspaces: [{ id: "ws1", name: "Personal", personal: true, role: "owner" }, { id: "ws2", name: "Team", personal: false, role: "editor" }], lastWs: "ws1" });
    if (u.pathname === "/api/clipper/destinations") {
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      return send(res, 200, { results: DESTS.filter((d) => !q || d.title.toLowerCase().includes(q)) });
    }
    if (u.pathname === "/api/notes/clip" && req.method === "POST") {
      const b = JSON.parse(raw);
      srv.clips.push(b);
      return send(res, 200, { id: `n${srv.clips.length}`, url: `${APP}/docs#Clip-n${srv.clips.length}`, title: b.title });
    }
    send(res, 404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// --- The browser ----------------------------------------------------------------

const ctx = await pw.chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "zvclip-")), {
  headless: true,
  executablePath: process.env.CHROMIUM,
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
});
const errors = [];
ctx.on("page", (p) => {
  p.on("pageerror", (e) => errors.push(`${p.url()} ${e}`));
  p.on("console", (m) => m.type() === "error" && !/401|Unauthorized/.test(m.text()) && errors.push(`${p.url()} ${m.text()}`));
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  const art = await ctx.newPage();
  await art.goto(`${APP}/article`);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.endsWith("/article"))?.id);
  check("1 the article tab is found", Number.isInteger(tabId));

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  await popup.waitForSelector('[data-test="connect"]', { state: "visible" });
  const opened = ctx.waitForEvent("page");
  await popup.click('[data-test="connect"]');
  const connect = await opened;
  await connect.waitForLoadState();
  check("2 Connect opens the server's page with a S256 challenge", /^[A-Za-z0-9_-]{43}$/.test(srv.challenge) && /^[A-Za-z0-9_-]{22,64}$/.test(srv.state) && srv.client === "chrome", connect.url());
  const closed = connect.waitForEvent("close", { timeout: 10000 }).then(() => true, () => false);
  await connect.click("#allow");
  check("3 the code is exchanged and the connect tab closes", await closed);
  await popup.waitForSelector('[data-test="clip-screen"]:not([hidden])', { timeout: 10000 });
  check("4 the popup moves on to the clip screen", true);
  check("5 the title is the page's", (await popup.inputValue('[data-test="title"]')) === "Mock article");
  check("6 two workspaces: the picker shows", await popup.locator('[data-test="workspace"]').isVisible());
  await popup.waitForSelector('[data-test="dest"][data-id="db1"]');
  check("7 Private is chosen by default", (await popup.getAttribute('[data-test="dest"][data-id="private"]', "aria-selected")) === "true");
  check("8 databases are marked", (await popup.locator('[data-test="dest"][data-id="db1"] .zc-tag').count()) === 1);
  check("9 Selection is off without a selection", await popup.isDisabled('[data-test="mode"][data-mode="selection"]'));

  // SHOTS=<dir>: pictures of the popup in both themes (a look check, not a test).
  if (process.env.SHOTS) {
    for (const scheme of ["light", "dark"]) {
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.screenshot({ path: join(process.env.SHOTS, `popup-${scheme}.png`) });
    }
    await popup.emulateMedia({ colorScheme: "light" });
  }
  await popup.fill('[data-test="search"]', "proj");
  await popup.waitForFunction(() => document.querySelectorAll('[data-test="dest"]').length === 1);
  await popup.click('[data-test="dest"][data-id="db1"]');
  await popup.fill('[data-test="title"]', "Edited title");
  await popup.click('[data-test="save"]');
  await popup.waitForSelector('[data-test="done-screen"]:not([hidden])', { timeout: 20000 });
  const c1 = srv.clips[0];
  check("10 the clip went to the database, as an article", c1?.ws === "ws1" && c1.target.type === "database" && c1.target.id === "db1" && c1.mode === "article", JSON.stringify(c1?.target));
  check("11 the edited title is sent", c1?.title === "Edited title");
  check("12 readable HTML with absolute URLs", c1?.html.includes("Paragraph 9") && c1.html.includes(`href="${APP}/rel/2"`) && c1.html.includes(`${APP}/img/a.png`) && !c1.html.includes("Menu"));
  check("13 the cover is the page's og:image", c1?.cover === `${APP}/cover.png`);
  check("14 the success link opens the new page", (await popup.getAttribute('[data-test="open"]', "href")) === `${APP}/docs#Clip-n1`);
  check("15 no cookies are ever sent", srv.cookies.length === 0, srv.cookies.join(";"));

  // The selection, and the database as a recent destination.
  await art.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById("p3"));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  await popup.waitForSelector('[data-test="dest"][data-id="db1"]');
  check("16 the last destination is chosen again", (await popup.getAttribute('[data-test="dest"][data-id="db1"]', "aria-selected")) === "true");
  check("17 recent destinations list it", (await popup.locator(".zc-group").first().innerText()) === "Recent");
  await popup.click('[data-test="dest"][data-id="private"]');
  check("18 Selection is on with a selection", !(await popup.isDisabled('[data-test="mode"][data-mode="selection"]')));
  await popup.check('[data-test="mode"][data-mode="selection"]');
  await popup.click('[data-test="save"]');
  await popup.waitForSelector('[data-test="done-screen"]:not([hidden])', { timeout: 20000 });
  const c2 = srv.clips[1];
  check("19 only the selection is sent, to Private", c2?.mode === "selection" && c2.target.type === "private" && c2.html.includes("Paragraph 3") && !c2.html.includes("Paragraph 4"), c2?.html?.slice(0, 120));

  // An error is shown in words; a revoked token goes back to Connect.
  srv.revoked = true;
  await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  await popup.waitForSelector('[data-test="connect"]', { state: "visible", timeout: 10000 });
  check("20 a revoked token shows Connect again", true);

  // Connect again, then Disconnect revokes on the server.
  srv.revoked = false;
  const again = ctx.waitForEvent("page");
  await popup.click('[data-test="connect"]');
  const c = await again;
  await c.waitForLoadState();
  await c.click("#allow");
  await popup.waitForSelector('[data-test="clip-screen"]:not([hidden])', { timeout: 10000 });
  await popup.click('[data-test="settings"]');
  await popup.click('[data-test="disconnect"]');
  await popup.waitForSelector('[data-test="connect"]', { state: "visible" });
  check("21 Disconnect revokes the token", srv.revoked);
  check("22 every token exchange was valid", srv.bad.length === 0, srv.bad.join(","));
  check("23 no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("flow-check ran", false, String(e).slice(0, 500));
} finally {
  await ctx.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
