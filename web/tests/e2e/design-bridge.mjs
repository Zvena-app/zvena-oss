// Design ↔ the ecosystem, end to end (needs Design):
//   a comment on a frame that names an issue links the frame and the issue;
//   the selected frame shows its issues in Design's right panel; Quick
//   actions (Ctrl+/) find zvena's issues; a comment becomes an issue
//   (/eco/from-design) linked to the frame; resolving the comment in Design
//   closes that issue, reopening it opens the issue again (Jev's hub).
//   BASE=http://localhost:3100 DESIGN=http://localhost:3110 node tests/e2e/design-bridge.mjs
import { BASE, DESIGN, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const shots = process.env.SHOTS;

async function until(fn, ms = 20000, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

/** Design finished signing in through zvena: a signed-in profile and a settled page. */
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
const ctx = await context(browser);
const page = await ctx.newPage();
const api = (method, path, data) =>
  ctx.request
    .fetch(`${BASE}${path}`, { method, headers: { origin: BASE, "content-type": "application/json" }, ...(data ? { data: JSON.stringify(data) } : {}) })
    .then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));

try {
  if (!DESIGN) throw new Error("DESIGN is not set");
  await devSignIn(page, `Bridge ${RUN}`);
  const ws = (await api("POST", "/api/ws", { name: `Bridge ${RUN}` })).body.workspace.id;
  const team = (await api("POST", `/api/projects/teams?ws=${ws}`, { name: "Product", key: `B${RUN.slice(0, 3).toUpperCase()}` })).body;
  const issue = (await api("POST", `/api/projects/issues?ws=${ws}`, { teamId: team.id, title: `Hero banner ${RUN}` })).body;
  check("an issue to talk about", Boolean(issue?.identifier), JSON.stringify(issue).slice(0, 200));

  // A design file, opened in the editor (Design signs in through zvena).
  await page.goto(`${BASE}/design?ws=${ws}&new=1&name=${encodeURIComponent(`Landing ${RUN}`)}`);
  check("Design opened signed in", await designReady(page), page.url());
  // Signing in passes through Design's own pages first; the editor's address names the file.
  await page.waitForURL((u) => u.toString().includes("file-id="), { timeout: 60000 });
  const hash = new URLSearchParams(page.url().split("?").slice(1).join("?"));
  const designTeam = hash.get("team-id");
  const file = hash.get("file-id");
  check("the file's ids are known", Boolean(designTeam && file), page.url());
  await page.waitForTimeout(4000);

  // A frame, drawn as a person would: F, then drag on the canvas.
  const vp = await page.locator(".viewport, [data-testid='viewport'], canvas").first().boundingBox();
  const cx = vp ? vp.x + vp.width / 2 : 640;
  const cy = vp ? vp.y + vp.height / 2 : 430;
  await page.mouse.click(cx + 200, cy + 150);
  await page.keyboard.press("f");
  await page.mouse.move(cx - 120, cy - 90);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 6 });
  await page.mouse.move(cx + 120, cy + 90, { steps: 6 });
  await page.mouse.up();
  const frames = await until(async () => {
    const r = await api("GET", `/api/design/frames?ws=${ws}&file=${file}`);
    return r.body?.frames?.length ? r.body.frames : null;
  }, 30000, 1000);
  const frame = frames?.[0];
  check("the frame is saved", Boolean(frame?.id), JSON.stringify(frames ?? null).slice(0, 200));
  const pageId = frame.pageId;

  // A comment on the frame that names the issue → the frame and the issue are linked.
  const thread = await page.evaluate(
    async ({ file, pageId, frame, text }) => {
      const r = await fetch("/api/main/methods/create-comment-thread", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ fileId: file, pageId, frameId: frame, position: { x: 20, y: 20 }, content: text }),
      });
      return r.ok ? r.json() : { error: r.status, body: await r.text() };
    },
    { file, pageId, frame: frame.id, text: `The banner needs a new photo, see ${BASE}/projects/issue/${issue.identifier}` }
  );
  check("comment saved in Design", Boolean(thread?.id), JSON.stringify(thread).slice(0, 200));
  const linked = await until(async () => {
    const r = await api("GET", `/api/eco/related?ws=${ws}&ref=issue:${issue.id}`);
    return r.body?.items?.find((i) => i.card.key === `design:${file}/${frame.id}`) ?? null;
  }, 20000);
  check("Design told zvena; the comment links the frame and the issue", Boolean(linked), linked ? `${linked.card.title} (${linked.via})` : "");

  // The selected frame shows its issues in the right panel (zvena answers Design's origin with CORS).
  // Selected from the layers list: where the frame landed on the canvas depends on the zoom.
  for (const el of await page.getByText(frame.name, { exact: true }).all()) {
    const box = await el.boundingBox();
    if (box && box.x < 300) {
      await el.click();
      break;
    }
  }
  // The frame may have been selected (and its Related read) before the comment existed:
  // the panel catches up by itself (comment changes, every 30 s), no reselecting.
  const panel = await until(async () => ((await page.locator("body").innerText()).includes(`Hero banner ${RUN}`) ? true : null), 40000, 1000);
  if (shots) {
    await page.getByText(`Hero banner ${RUN}`).first().scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: `${shots}/design-bridge-panel.png` });
  }
  if (!panel) {
    const probe = await page.evaluate(
      async ({ base, team, ref }) => {
        const r = await fetch(`${base}/api/eco/related?team=${team}&ref=${encodeURIComponent(ref)}`, { credentials: "include" }).catch((e) => ({ status: String(e) }));
        const body = r.text ? await r.text() : "";
        const title = [...document.querySelectorAll("*")].find((el) => el.childElementCount === 0 && el.textContent === "Related");
        let box = title;
        for (let i = 0; i < 4 && box?.parentElement; i++) box = box.parentElement;
        return { status: r.status, body: body.slice(0, 120), section: box ? box.innerText.slice(0, 300) : null, keyText: document.body.innerText.includes("zvena.bridge") };
      },
      { base: BASE, team: designTeam, ref: `design:${file}/${frame.id}` }
    );
    console.log("panel probe:", JSON.stringify(probe));
    console.log("console errors:", JSON.stringify(ctx.errors.slice(0, 6)));
  }
  check("the frame's Related lists the issue in Design", Boolean(panel));

  // Quick actions find zvena's issues.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+/");
  await page.waitForTimeout(500);
  await page.keyboard.type(`Hero banner ${RUN}`);
  const quick = await until(async () => {
    const t = await page.locator("[role='listbox']").innerText();
    return t.includes(`Hero banner ${RUN}`) ? t : null;
  }, 10000);
  if (shots) await page.screenshot({ path: `${shots}/design-bridge-quick.png` });
  check("Quick actions find the issue", Boolean(quick), (quick ?? "").replace(/\s+/g, " ").slice(0, 120));
  await page.keyboard.press("Escape");

  // The comment becomes an issue of its own, linked to the frame.
  const zv = await ctx.newPage();
  await zv.goto(`${BASE}/eco/from-design?team=${designTeam}&thread=${thread.id}`);
  const title = zv.locator("form input").first();
  await title.waitFor({ timeout: 20000 });
  check("the form quotes the comment", (await zv.locator("form").innerText()).includes("new photo"));
  await title.fill(`New hero photo ${RUN}`);
  await zv.locator("form button[type='submit']").click();
  const made = await until(async () => {
    const r = await api("GET", `/api/eco/related?ws=${ws}&ref=design:${file}/${frame.id}`);
    return r.body?.items?.find((i) => i.card.kind === "issue" && i.card.title === `New hero photo ${RUN}`) ?? null;
  }, 15000);
  check("a comment becomes an issue linked to its frame", Boolean(made), made ? `${made.card.sub} (${made.via})` : "");

  // Resolved in Design: Jev closes the issue the comment became (and reopens it with the thread).
  const madeId = made.card.key.split(":")[1];
  const doneOf = async () => {
    const b = (await api("GET", `/api/projects/issues/${madeId}?ws=${ws}`)).body;
    return (b?.issue ?? b)?.completedAt ?? null;
  };
  const resolve = (isResolved) =>
    page.evaluate(
      async ({ id, isResolved }) => (await fetch("/api/main/methods/update-comment-thread", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ id, isResolved }) })).status,
      { id: thread.id, isResolved }
    );
  check("the thread is resolved in Design", (await resolve(true)) < 300);
  check("…and its issue closes by itself", Boolean(await until(async () => ((await doneOf()) ? true : null), 20000)));
  check("reopened in Design: the issue opens again", (await resolve(false)) < 300 && Boolean(await until(async () => ((await doneOf()) ? null : true), 20000)));

  check("no foreign hosts", foreignHosts(ctx).length === 0, foreignHosts(ctx).join(", "));
} catch (e) {
  check("bridge flow ran", false, String(e).slice(0, 500));
  if (shots) await page.screenshot({ path: `${shots}/design-bridge-fail.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
