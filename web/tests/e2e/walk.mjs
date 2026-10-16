// Two people of one workspace (needs Design): a live Design frame inside a
// document follows the design; a page shared with a teammate stops being
// readable for them, on the server and in the tab they have open, once
// access is revoked.
//   BASE=http://localhost:3100 DESIGN=http://localhost:3110 node tests/e2e/walk.mjs
import { BASE, DESIGN, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);

async function until(fn, ms = 20000, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

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

const browser = await launch();
const ctxA = await context(browser);
const ctxB = await context(browser);
const call = (ctx) => (method, path, data) =>
  ctx.request
    .fetch(`${BASE}${path}`, { method, headers: { origin: BASE, "content-type": "application/json" }, ...(data ? { data: JSON.stringify(data) } : {}) })
    .then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));
const apiA = call(ctxA);
const apiB = call(ctxB);

try {
  if (!DESIGN) throw new Error("DESIGN is not set");
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await devSignIn(a, `Walk Ann ${RUN}`);
  await devSignIn(b, `Walk Ben ${RUN}`);
  const ws = (await apiA("POST", "/api/ws", { name: `Walk ${RUN}` })).body.workspace.id;
  const inv = await apiA("POST", `/api/ws/invites?ws=${ws}`, { role: "editor" });
  const joined = await apiB("POST", "/api/join", { token: inv.body.url.split("/").pop() });
  check("1 Ben joins as an editor", joined.body?.role === "editor", JSON.stringify(joined.body));
  const ben = (await apiB("GET", "/api/auth/session")).body.user;

  // A design with one frame, drawn in Design (its own tab, kept open).
  const d = await ctxA.newPage();
  await d.goto(`${BASE}/design?ws=${ws}&new=1&name=${encodeURIComponent(`Walk ${RUN}`)}`);
  check("2 Design opened signed in", await designReady(d), d.url());
  await d.waitForURL((u) => u.toString().includes("file-id="), { timeout: 60000 });
  const file = new URLSearchParams(d.url().split("?").slice(1).join("?")).get("file-id");
  await d.waitForTimeout(4000);
  const vp = await d.locator(".viewport, [data-testid='viewport'], canvas").first().boundingBox();
  const cx = vp ? vp.x + vp.width / 2 : 640;
  const cy = vp ? vp.y + vp.height / 2 : 430;
  const drag = async (key, x0, y0, x1, y1) => {
    await d.bringToFront();
    await d.mouse.click(cx + 260, cy + 200);
    await d.keyboard.press(key);
    await d.mouse.move(x0, y0);
    await d.mouse.down();
    await d.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 });
    await d.mouse.move(x1, y1, { steps: 6 });
    await d.mouse.up();
  };
  await drag("f", cx - 120, cy - 90, cx + 120, cy + 90);
  const frame = (await until(async () => (await apiA("GET", `/api/design/frames?ws=${ws}&file=${file}`)).body?.frames?.[0], 30000, 1000)) ?? null;
  check("3 the frame is saved", Boolean(frame?.id), JSON.stringify(frame).slice(0, 160));

  // A page with the frame in it, shared with Ben only (restricted).
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const note = {
    id, parentId: null, kind: "page", title: `Hero ${RUN}`, icon: "", cover: null, order: now, favorite: false, createdAt: now, updatedAt: now, trashedAt: null,
    content: [
      { id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "Hero section for review.", styles: {} }], children: [] },
      { id: "d1", type: "design", props: { fileId: file, frameId: frame.id, name: frame.name, width: frame.width, height: frame.height }, children: [] },
    ],
  };
  check("4 page saved", (await apiA("POST", `/api/notes/sync?ws=${ws}`, { items: [{ id, note }] })).status === 200);
  const restrict = await apiA("POST", `/api/notes/access?ws=${ws}&id=${id}`, { op: "general", restricted: true });
  const grant = await apiA("POST", `/api/notes/access?ws=${ws}&id=${id}`, { op: "grant", userId: ben.id, level: "edit" });
  check("5 restricted and shared with Ben", restrict.status === 200 && grant.status === 200, `${restrict.status} ${grant.status}`);

  // Ann's page shows the frame's live picture; a change in Design shows up there.
  const url = `${BASE}/docs?ws=${ws}#Hero-${RUN}-${id}`;
  const pic = (p) => p.locator(".nt-design img").first();
  const loaded = (p) => pic(p).evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
  await a.goto(url);
  await a.waitForSelector(".nt-design", { timeout: 60000 });
  check("6 the frame's picture shows in the document", Boolean(await until(() => loaded(a).then((ok) => ok || null), 60000, 1000)));
  const before = await pic(a).getAttribute("src");
  // Ann draws a rectangle inside the frame in the Design tab.
  await drag("r", cx - 60, cy - 40, cx + 60, cy + 40);
  await a.bringToFront();
  const changed = await until(async () => {
    await a.locator(".nt-design-bar button").first().click().catch(() => undefined);
    const src = await pic(a).getAttribute("src");
    return src && src !== before ? src : null;
  }, 90000, 5000);
  check("7 a change in Design reaches the picture in the document", Boolean(changed), `${before} → ${changed}`);

  // Ben reads it, picture included.
  await b.goto(url);
  await b.waitForSelector(".nt-main .bn-editor", { timeout: 60000 });
  await b.waitForFunction(() => document.querySelector(".nt-main")?.textContent?.includes("Hero section for review."), null, { timeout: 30000 }).catch(() => undefined);
  check("8 Ben opens the shared page", (await b.locator(".nt-main").innerText()).includes("Hero section for review."));
  check("9 …with the frame's picture", Boolean(await until(() => loaded(b).then((ok) => ok || null), 60000, 1000)));

  // Ann revokes Ben's access.
  const revoke = await apiA("POST", `/api/notes/access?ws=${ws}&id=${id}`, { op: "revoke", userId: ben.id });
  check("10 access revoked", revoke.status === 200, JSON.stringify(revoke.body));
  const pulled = await apiB("GET", `/api/notes/sync?ws=${ws}&since=0`);
  check("11 the server no longer gives Ben the page (and tells his device to drop it)", !(pulled.body?.notes ?? []).some((n) => n.id === id) && (pulled.body?.deleted ?? []).includes(id), `${pulled.status} deleted=${JSON.stringify(pulled.body?.deleted ?? null).slice(0, 80)}`);
  const edit = await apiB("POST", `/api/notes/sync?ws=${ws}`, { items: [{ id, note: { ...note, title: "Taken over", updatedAt: Date.now() + 1000 } }] });
  const after = (await apiA("GET", `/api/notes/sync?ws=${ws}&since=0`)).body?.notes?.find((n) => n.id === id);
  check("12 Ben's edit after the revoke changes nothing", after?.title === `Hero ${RUN}`, `${edit.status} ${after?.title}`);
  const frameB = await apiB("GET", `/api/design/frame?ws=${ws}&file=${file}&frame=${frame.id}`);
  check("13 Ben still sees the workspace's design (it was never the page's to share)", frameB.status === 200, String(frameB.status));
  // The tab Ben has open loses the page too.
  const gone = await until(async () => ((await b.locator(".nt-noaccess").count()) > 0 || !(await b.locator(".nt-main").innerText().catch(() => "")).includes("Hero section for review.") ? true : null), 30000, 1000);
  check("14 Ben's open tab no longer shows the page", Boolean(gone));
  await b.reload();
  await b.waitForTimeout(4000);
  check("15 …nor after a reload", !(await b.locator("body").innerText()).includes("Hero section for review."));

  check("16 no foreign hosts", foreignHosts(ctxA).filter((h) => h !== new URL(DESIGN).host).length === 0 && foreignHosts(ctxB).length === 0, [...foreignHosts(ctxA), ...foreignHosts(ctxB)].join(", "));
} catch (e) {
  check("walk ran", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
