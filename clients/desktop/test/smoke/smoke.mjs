// Smoke test of the packaged app under Xvfb: a fake zvena server, the app
// pointed at it, checks over the DevTools protocol (21 checks). Runs in the
// Playwright image (it has Xvfb and the libraries Electron needs), as a
// regular user (Chromium refuses to run as root):
//   npx electron-builder --config electron-builder.config.js --linux AppImage
//   docker run --rm --init --user pwuser --network host \
//     -v "$PWD/dist/linux-unpacked:/app:ro" -v "$PWD/test/smoke:/smoke:ro" -v /tmp/zvena-shots:/shots \
//     --entrypoint /usr/bin/xvfb-run mcr.microsoft.com/playwright:v1.55.0-noble -a node /smoke/smoke.mjs
// (/shots gets a picture of the tab strip; it must be writable by pwuser.)
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";

setTimeout(() => { console.log("TIMEOUT\n" + log.slice(-4000)); process.exit(2); }, 100000).unref?.();
const PORT = 3961;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const page = (title, body = "") => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, ORIGIN);
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (u.pathname === "/home") return res.end(page("Fake home", `<a id="ext" href="https://example.com/">ext</a><a id="blank" target="_blank" href="/docs#Other-0123456789abcdef0123456789abcdef">blank</a>`));
  if (u.pathname === "/docs") return res.end(page("Fake docs"));
  res.statusCode = 404;
  res.end(page("Not found"));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let log = "";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const userData = mkdtempSync("/tmp/zvena-ud-");
const app = spawn("/app/zvena", ["--no-sandbox", "--remote-debugging-port=9333", `--user-data-dir=${userData}`, "zvena://docs#Deep-0123456789abcdef0123456789abcdef"], {
  // The packaged app refuses a debugging port unless ZVENA_DEVTOOLS=1.
  env: { ...process.env, APP_URL: ORIGIN, ELECTRON_ENABLE_LOGGING: "0", ZVENA_DEVTOOLS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

app.stdout.on("data", (d) => (log += d));
app.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9333/json/list");
      const list = await r.json();
      if (list.some((t) => t.url.startsWith(ORIGIN))) return list;
    } catch {}
    await sleep(500);
  }
  return [];
}

async function evaluate(t, expression) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const out = await new Promise((resolve) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) resolve(msg.result?.result?.value ?? (msg.result?.exceptionDetails ? "EXC:" + JSON.stringify(msg.result.exceptionDetails).slice(0, 300) : undefined));
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return out;
}

try {
  let list = await targets();
  await sleep(2500);
  list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const strip = list.find((t) => t.url === "zvena-ui://ui/tabs.html");
  const home = list.find((t) => t.url === `${ORIGIN}/home`);
  const deep = list.find((t) => t.url.startsWith(`${ORIGIN}/docs#Deep-`));
  check("1 the tab strip page loads", Boolean(strip));
  check("2 the start tab opens the app's /home", Boolean(home), list.map((t) => t.url).join(" | "));
  check("3 a zvena:// link at launch opens its page in a tab", Boolean(deep));
  if (strip) {
    const tabs = await evaluate(strip, "[...document.querySelectorAll('.tab .title')].map(e => e.textContent).join(',')");
    check("4 the strip shows both tabs with page titles", /Fake home/.test(tabs) && /Fake docs/.test(tabs), tabs);
    const font = await evaluate(strip, "getComputedStyle(document.body).fontFamily");
    check("5 the strip uses Zvena Sans", /Zvena Sans/.test(font), font);
    const bridge = await evaluate(strip, "typeof window.zvenaDesktop + '/' + typeof window.zvUi + '/' + typeof require");
    check("6 the strip has zvUi only (no Node)", bridge === "undefined/object/undefined", bridge);
  }
  if (home) {
    const info = await evaluate(home, "JSON.stringify({ d: window.zvenaDesktop && { isDesktop: window.zvenaDesktop.isDesktop, platform: window.zvenaDesktop.platform, version: window.zvenaDesktop.version, keys: Object.keys(window.zvenaDesktop) }, ua: navigator.userAgent, node: typeof require + typeof process, perm: Notification.permission, frozen: Object.isFrozen(window.zvenaDesktop) })");
    const j = JSON.parse(info);
    check("7 the page sees window.zvenaDesktop (frozen, 4 keys)", j.d?.isDesktop === true && j.d.version === "1.0.0" && j.frozen && j.d.keys.join() === "isDesktop,version,platform,setBadge", info);
    check("8 the user agent says zvena-desktop, not Electron", /zvena-desktop\/1\.0\.0$/.test(j.ua) && !/Electron\//.test(j.ua), j.ua);
    check("9 no Node in the page", j.node === "undefinedundefined");
    check("10 notifications are granted to the app origin", j.perm === "granted", j.perm);
    const geo = await evaluate(home, "navigator.permissions.query({name:'geolocation'}).then(p => p.state)");
    check("11 other permissions are refused", geo === "denied", geo);
    // An external link must not navigate the tab.
    await evaluate(home, "document.getElementById('ext').click(), 1");
    await sleep(1500);
    const still = await evaluate(home, "location.href");
    check("12 an external link leaves the tab on the app", still === `${ORIGIN}/home`, still);
    await evaluate(home, "document.getElementById('blank').click(), 1");
    await sleep(2000);
    const after = await (await fetch("http://127.0.0.1:9333/json/list")).json();
    check("13 a target=_blank app link becomes a new tab", after.some((t) => t.url.includes("/docs#Other-")), after.map((t) => t.url).join(" | "));
    const nav = await evaluate(home, "(location.href = 'file:///etc/passwd', new Promise(r => setTimeout(() => r(location.href), 1000)))");
    check("14 file: navigation is blocked", nav === `${ORIGIN}/home`, nav);

    const count = async () => (await (await fetch("http://127.0.0.1:9333/json/list")).json()).filter((t) => t.url.startsWith(ORIGIN)).length;
    for (const [t, name] of [[(await (await fetch("http://127.0.0.1:9333/json/list")).json()).find((x) => x.url === "zvena-ui://ui/tabs.html"), "strip"]]) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      const png = await new Promise((r) => { ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id === 9) r(j.result.data); }; ws.send(JSON.stringify({ id: 9, method: "Page.captureScreenshot", params: { format: "png" } })); });
      ws.close();
      try {
        (await import("node:fs")).writeFileSync("/shots/" + name + ".png", Buffer.from(png, "base64"));
      } catch {
        // No /shots mount: no picture.
      }
    }
    const n0 = await count();
    const stripT = (await (await fetch("http://127.0.0.1:9333/json/list")).json()).find((t) => t.url === "zvena-ui://ui/tabs.html");
    await evaluate(stripT, "document.getElementById('new').click(), 1");
    await sleep(1500);
    const n1 = await count();
    check("15 the strip's + opens a new tab at /home", n1 === n0 + 1, `${n0} → ${n1}`);
    const t1 = await evaluate(stripT, "[...document.querySelectorAll('.tab')].length + '/' + document.querySelector('.tab.active .title').textContent");
    check("16 the new tab is the active one in the strip", t1 === `${n0 + 1}/Fake home`, t1);
    await evaluate(stripT, "document.querySelector('.tab.active .x').click(), 1");
    await sleep(1000);
    const n2 = await count();
    check("17 its × closes it", n2 === n0, `${n1} → ${n2}`);
    const bad = await evaluate(stripT, "window.zvUi.send('close', { id: 'x' }), window.zvUi.send('evil'), 1");
    await sleep(500);
    check("18 malformed strip messages change nothing", bad === 1 && (await count()) === n0);
    // A second launch with a link hands it to this app (single instance); a foreign one is ignored.
    const second = spawn("/app/zvena", ["--no-sandbox", `--user-data-dir=${userData}`, "zvena://open?url=" + encodeURIComponent("https://evil.example/x")], { env: { ...process.env, APP_URL: ORIGIN }, stdio: "ignore" });
    const code2 = await new Promise((r) => second.on("exit", r));
    await sleep(1000);
    const all = (await (await fetch("http://127.0.0.1:9333/json/list")).json()).map((t) => t.url);
    check("19 a second launch exits and a foreign zvena://open is ignored", code2 === 0 && !all.some((u) => u.includes("evil.example")) && (await count()) === n0, String(code2));
    const third = spawn("/app/zvena", ["--no-sandbox", `--user-data-dir=${userData}`, "zvena://projects?from=link"], { env: { ...process.env, APP_URL: ORIGIN }, stdio: "ignore" });
    await new Promise((r) => third.on("exit", r));
    await sleep(1500);
    const all3 = (await (await fetch("http://127.0.0.1:9333/json/list")).json()).map((t) => t.url);
    check("20 a second launch with zvena://projects opens it in the running app", all3.includes(`${ORIGIN}/projects?from=link`), all3.join(" | "));
  }
} catch (e) {
  check("smoke ran", false, String(e));
} finally {
  app.kill("SIGTERM");
  await sleep(1500);
  server.close();
  try {
    const saved = JSON.parse((await import("node:fs")).readFileSync(userData + "/zvena-settings.json", "utf8"));
    check("21 quitting saves the window and its tabs", saved.windows?.[0]?.tabs?.length >= 3, JSON.stringify(saved.windows?.[0]?.tabs));
  } catch (e) { check("21 quitting saves the window and its tabs", false, String(e)); }
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) console.log(log.slice(-3000));
process.exit(failed ? 1 : 0);
