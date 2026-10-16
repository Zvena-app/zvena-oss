// Calendar, end to end, as two people of one workspace (New York time):
//   drag on the week grid to make an event, name it; drag it to move it,
//   drag its edge to make it longer; make it repeat weekly, then move one
//   occurrence only ("this event");
//   the keyboard (M, W, T) and ⌘K ("next fri");
//   a Docs database as a layer: its row shows, dragging it changes its date
//   in Documents;
//   a scheduling link booked by a visitor who is not signed in;
//   the secret ICS feed and the .ics download; a teammate sees free/busy only.
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const TZ = "America/New_York";
const SHOTS = process.env.SHOTS;
const browser = await launch();
const owner = await context(browser, { timezoneId: TZ });
const mate = await context(browser, { timezoneId: TZ });
const visitor = await context(browser, { timezoneId: "Europe/Paris" });
const post = (ctx, path, data, method = "POST") => ctx.request.fetch(`${BASE}${path}`, { method, data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));
const get = (ctx, path) => ctx.request.get(`${BASE}${path}`).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null), text: await r.text().catch(() => "") }));
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/calendar-${name}.png` }).catch(() => {}) : Promise.resolve());

// A week ahead: next Monday in New York (a grid with nothing else on it).
function nyDay(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const today = nyDay(0);
const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
const monday = addDays(today, ((8 - wd) % 7) || 7);
const tuesday = addDays(monday, 1);
const hourIn = (ms) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));
const minuteIn = (ms) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, minute: "numeric" }).format(new Date(ms)));

let page;
try {
  page = await owner.newPage();
  await devSignIn(page, `Olivia Cal ${RUN}`);
  const matePage = await mate.newPage();
  await devSignIn(matePage, `Mason Cal ${RUN}`);
  const ws = (await post(owner, "/api/ws", { name: `Studio Cal ${RUN}` })).body.workspace.id;
  const inv = await post(owner, `/api/ws/invites?ws=${ws}`, { role: "editor" });
  check("teammate joins", (await post(mate, "/api/join", { token: inv.body.url.split("/").pop() })).status === 200);

  // ---------------------------------------------------------------- the frame
  await page.goto(`${BASE}/calendar?ws=${ws}&date=${monday}&view=week`);
  await page.waitForSelector(".cal-grid .cal-col", { timeout: 30000 });
  check("Calendar is a section of the shared rail", (await page.locator('.zv-side a[aria-current="page"]').first().innerText()).includes("Calendar"));
  check("the rail shows the mini month and the calendars", (await page.locator(".cal-rail .cal-mini").count()) === 1 && (await page.locator(".cal-rail .cal-item").count()) >= 1);
  check("a week of seven days", (await page.locator(".cal-col").count()) === 7);
  await shot(page, "week");

  // ---------------------------------------------------------------- create by dragging
  const col = page.locator(`.cal-col[data-day="${tuesday}"]`);
  const box = await col.boundingBox();
  const yAt = (min) => box.y + min * 0.8;
  await page.mouse.move(box.x + box.width / 2, yAt(10 * 60 + 2));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, yAt(10 * 60 + 30), { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, yAt(10 * 60 + 58), { steps: 4 });
  await page.mouse.up();
  await page.waitForSelector('[data-testid="event-panel"]', { timeout: 10000 });
  await page.keyboard.type(`Design review ${RUN}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((t) => [...document.querySelectorAll(".cal-ev .cal-ev-title")].some((n) => n.textContent?.includes(t)), `Design review ${RUN}`, { timeout: 10000 });
  const from = Date.parse(`${monday}T00:00:00Z`) - 86400000;
  const to = from + 9 * 86400000;
  const events = async (ctx = owner) => (await get(ctx, `/api/calendar/events?ws=${ws}&from=${from}&to=${to + 21 * 86400000}&tz=${TZ}`)).body.items;
  let ev = (await events()).find((e) => e.title === `Design review ${RUN}`);
  check("drag on the grid makes an event 10:00–11:00", ev && hourIn(ev.start) === 10 && minuteIn(ev.start) === 0 && ev.end - ev.start === 3600000, ev && new Date(ev.start).toISOString());

  // ---------------------------------------------------------------- move and resize
  await page.keyboard.press("Escape");
  const block = page.locator(".cal-ev", { hasText: `Design review ${RUN}` }).first();
  let b = await block.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 8 + 24, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 8 + 48, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  ev = (await events()).find((e) => e.title === `Design review ${RUN}`);
  check("dragging moves it an hour later", ev && hourIn(ev.start) === 11 && minuteIn(ev.start) === 0, ev && new Date(ev.start).toISOString());
  b = await page.locator(".cal-ev", { hasText: `Design review ${RUN}` }).first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height + 12, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height + 24, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  ev = (await events()).find((e) => e.title === `Design review ${RUN}`);
  check("dragging its edge makes it 30 minutes longer", ev && ev.end - ev.start === 90 * 60000, ev && `${(ev.end - ev.start) / 60000} min`);

  // ---------------------------------------------------------------- repeat weekly, then move one occurrence
  await page.locator(".cal-ev", { hasText: `Design review ${RUN}` }).first().click();
  await page.waitForSelector('[data-testid="event-panel"] .cal-title-input');
  await page.getByRole("button", { name: "Repeat" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Every week on Tuesday/ }).click();
  await page.waitForTimeout(1500);
  const series = (await events()).filter((e) => e.title === `Design review ${RUN}`);
  check("weekly: every Tuesday at 11:00", series.length >= 3 && series.every((e) => hourIn(e.start) === 11 && new Date(e.start).getUTCDay() === 2), `${series.length} occurrences`);
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="next"]').click();
  await page.waitForFunction((t) => [...document.querySelectorAll(".cal-ev .cal-ev-title")].some((n) => n.textContent?.includes(t)), `Design review ${RUN}`, { timeout: 10000 });
  b = await page.locator(".cal-ev", { hasText: `Design review ${RUN}` }).first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 8 + 40, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 8 + 96, { steps: 4 });
  await page.mouse.up();
  await page.waitForSelector('[data-testid="scope-this"]', { timeout: 5000 });
  await page.locator('[data-testid="scope-this"]').click();
  await page.locator('[data-testid="scope-ok"]').click();
  await page.waitForTimeout(1500);
  const after = (await events()).filter((e) => e.title === `Design review ${RUN}`).map((e) => hourIn(e.start));
  check("this event only: one occurrence at 13:00, the rest at 11:00", after.filter((h) => h === 13).length === 1 && after.filter((h) => h === 11).length >= 2, after.join(","));
  await shot(page, "repeat");

  // ---------------------------------------------------------------- keyboard and ⌘K
  await page.locator(".cal-head-title").click();
  await page.keyboard.press("m");
  await page.waitForSelector(".cal-month", { timeout: 5000 });
  check("M: month view", true);
  await shot(page, "month");
  await page.keyboard.press("a");
  await page.waitForSelector(".cal-agenda, .cal-agenda-empty", { timeout: 5000 });
  check("A: agenda", true);
  await page.keyboard.press("w");
  await page.waitForSelector(".cal-grid", { timeout: 5000 });
  await page.keyboard.press("t");
  await page.waitForTimeout(300);
  check("T: today", new URL(page.url()).searchParams.get("date") === today, page.url());
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.waitForSelector('[data-testid="cmd-input"]', { timeout: 5000 });
  await page.keyboard.type("next fri");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const fri = new URL(page.url()).searchParams.get("date");
  check("⌘K → \"next fri\" goes to a Friday", fri && new Date(`${fri}T12:00:00Z`).getUTCDay() === 5 && fri > today, fri);

  // ---------------------------------------------------------------- a Docs database as a layer
  const dbId = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const rowId = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const db = { id: dbId, parentId: null, kind: "database", title: `Content plan ${RUN}`, icon: "", cover: null, content: [], order: now, favorite: false, createdAt: now, updatedAt: now, trashedAt: null, db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "pub", name: "Publish", type: "date" }], views: [{ id: "v1", name: "Table", type: "table" }] } };
  const row = { id: rowId, parentId: dbId, kind: "page", title: `Launch post ${RUN}`, icon: "", cover: null, content: [], props: { pub: { start: addDays(monday, 2) } }, order: now, favorite: false, createdAt: now, updatedAt: now, trashedAt: null };
  check("a database with a date property", (await post(owner, `/api/notes/sync?ws=${ws}`, { items: [{ id: dbId, note: db }, { id: rowId, note: row }] })).status === 200);
  await page.goto(`${BASE}/calendar?ws=${ws}&date=${monday}&view=week`);
  await page.waitForSelector(".cal-grid .cal-col", { timeout: 30000 });
  await page.getByRole("button", { name: "Add a Docs database" }).first().click();
  await page.waitForSelector('[data-testid="layer-db"]', { timeout: 10000 });
  await page.locator('[data-testid="layer-db"]').selectOption(dbId);
  await page.locator('[data-testid="layer-add"]').click();
  await page.waitForFunction((t) => [...document.querySelectorAll(".cal-bar .cal-ev-title")].some((n) => n.textContent?.includes(t)), `Launch post ${RUN}`, { timeout: 15000 });
  check("its row is on the calendar (Wednesday)", true);
  const bar = page.locator(".cal-bar", { hasText: `Launch post ${RUN}` }).first();
  const bb = await bar.boundingBox();
  const colW = box.width;
  await page.mouse.move(bb.x + 10, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + 10 + colW / 2, bb.y + bb.height / 2, { steps: 4 });
  await page.mouse.move(bb.x + 10 + colW + 4, bb.y + bb.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const pulled = (await get(owner, `/api/notes/sync?ws=${ws}&ids=${rowId}`)).body.notes[0];
  check("dragging it changes its date in Documents", pulled?.props?.pub?.start === addDays(monday, 3), JSON.stringify(pulled?.props?.pub));
  await shot(page, "layer");

  // ---------------------------------------------------------------- a scheduling link, booked signed out
  const link = await post(mate, `/api/calendar/links?ws=${ws}`, { title: `Intro ${RUN}`, duration: 30, step: 30, noticeMin: 0, windowDays: 30, tz: TZ, weekly: { 0: [[540, 1020]], 1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]], 4: [[540, 1020]], 5: [[540, 1020]], 6: [[540, 1020]] } });
  check("a scheduling link", link.status === 200 && link.body.link.slug, JSON.stringify(link.body).slice(0, 120));
  // Mason is busy on one day: that slot must not be offered, and nothing of it shows.
  const vpage = await visitor.newPage();
  await vpage.goto(link.body.link.url.replace(/^https?:\/\/[^/]+/, BASE));
  await vpage.waitForSelector('[data-testid="slot"]', { timeout: 20000 });
  const html = await vpage.content();
  check("the public page shows the host and the link, nothing private", html.includes(`Intro ${RUN}`) && html.includes(`Mason Cal ${RUN}`) && !html.includes("Design review"));
  await vpage.locator('[data-testid="slot"]').first().click();
  await vpage.locator('[data-testid="slot-next"]').click();
  await vpage.locator('[data-testid="book-name"]').fill("Grace Guest");
  await vpage.locator('[data-testid="book-email"]').fill(`grace-${RUN}@example.org`);
  await vpage.locator('[data-testid="book-confirm"]').click();
  await vpage.waitForSelector('[data-testid="booking-done"]', { timeout: 15000 });
  check("booked as a visitor", true);
  await vpage.screenshot({ path: SHOTS ? `${SHOTS}/calendar-booked.png` : "/dev/null" }).catch(() => {});
  const mateItems = (await get(mate, `/api/calendar/events?ws=${ws}&from=${Date.now() - 86400000}&to=${Date.now() + 31 * 86400000}&tz=${TZ}`)).body.items;
  check("the booking is an event in the host's calendar", mateItems.some((e) => e.title === `Intro ${RUN} · Grace Guest` && e.guests === 1));
  const again = await visitor.request.post(`${BASE}/api/calendar/public/${link.body.link.slug}/book`, { data: { start: 1, name: "Bot", email: "bot@example.org", website: "spam" }, headers: { origin: BASE } });
  check("a filled honeypot is refused", again.status() === 400);

  // ---------------------------------------------------------------- ICS: the secret feed and the download
  const boot = (await get(owner, `/api/calendar/bootstrap?ws=${ws}`)).body;
  const mine = boot.calendars.find((c) => c.isDefault);
  await page.locator(".cal-item", { hasText: mine.name }).first().hover();
  await page.locator(".cal-item", { hasText: mine.name }).first().locator(".cal-item-more").click();
  await page.getByRole("menuitem", { name: "Calendar settings" }).click();
  await page.locator('[data-testid="feed-on"]').click();
  await page.waitForSelector('[data-testid="feed-url"]', { timeout: 10000 });
  const feedUrl = await page.locator('[data-testid="feed-url"]').inputValue();
  const anon = await browser.newContext();
  const feed = await anon.request.get(feedUrl.replace(/^https?:\/\/[^/]+/, BASE));
  const ics = await feed.text();
  check("the secret address serves the calendar as ICS, signed out", feed.status() === 200 && ics.startsWith("BEGIN:VCALENDAR") && ics.includes(`SUMMARY:Design review ${RUN}`) && /RRULE:FREQ=WEEKLY/.test(ics), `${feed.status()} ${ics.slice(0, 60)}`);
  check("…with the moved occurrence as RECURRENCE-ID", /RECURRENCE-ID/.test(ics));
  const bad = await anon.request.get(`${BASE}/api/calendar/feed/${"x".repeat(32)}.ics`);
  check("a wrong token gets nothing", bad.status() === 404);
  await anon.close();
  const dl = await owner.request.get(`${BASE}/api/calendar/calendars/${mine.id}/ics?ws=${ws}`);
  check("the .ics download", dl.status() === 200 && /attachment/.test(dl.headers()["content-disposition"] ?? "") && (await dl.text()).includes("BEGIN:VEVENT"));
  const foreign = await mate.request.get(`${BASE}/api/calendar/calendars/${mine.id}/ics?ws=${ws}`);
  check("…not for a teammate who sees only free/busy", foreign.status() === 404);
  await page.keyboard.press("Escape");

  // ---------------------------------------------------------------- free/busy for a teammate
  const fb = (await get(mate, `/api/calendar/freebusy?ws=${ws}&users=${boot.me.id}&from=${from}&to=${to}&tz=${TZ}`)).body.users[0];
  check("a teammate sees Olivia busy, without titles", fb.busy.length >= 1 && fb.busy.every((x) => !x.title), JSON.stringify(fb.busy[0] ?? {}));
  const peek = await get(mate, `/api/calendar/events/${ev.id}?ws=${ws}`);
  check("…and cannot open the event", peek.status === 404);

  // ---------------------------------------------------------------- phone width: the week becomes three days
  const phone = await owner.newPage();
  await phone.setViewportSize({ width: 390, height: 800 });
  await phone.goto(`${BASE}/calendar?ws=${ws}&date=${tuesday}&view=week`);
  await phone.waitForSelector(".cal-grid .cal-col", { timeout: 30000 });
  check("a phone gets the three-day view", (await phone.locator(".cal-col").count()) === 3);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no horizontal scroll on a phone", overflow <= 1, `${overflow}px`);
  await phone.screenshot({ path: SHOTS ? `${SHOTS}/calendar-phone.png` : "/dev/null" }).catch(() => {});
  await phone.close();

  // Share availability (Notion Calendar): free times of the next working days, as text with the scheduling link.
  await page.goto(`${BASE}/calendar?ws=${ws}&view=week`);
  await page.locator('[data-testid="share-availability"]').click({ timeout: 15000 });
  const avail = await page.waitForFunction(() => /: .*\d.*–/.test(document.querySelector('[data-testid="avail-text"]')?.textContent ?? ""), null, { timeout: 15000 }).then(() => true).catch(() => false);
  check("Share availability lists the free times of the next working days", avail, (await page.locator('[data-testid="avail-text"]').innerText().catch(() => "")).slice(0, 200));
  await page.keyboard.press("Escape");
  check("no foreign hosts", foreignHosts(owner).length === 0 && foreignHosts(visitor).length === 0, [...foreignHosts(owner), ...foreignHosts(visitor)].join(", "));
  check("no console errors", owner.errors.length === 0 && visitor.errors.length === 0, [...owner.errors.slice(0, 3), ...visitor.errors.slice(0, 2)].join(" | "));
  check("no failed requests", owner.failed.length === 0, owner.failed.slice(0, 5).join(" | "));
} catch (e) {
  check("calendar ran", false, String(e).slice(0, 400));
  if (page) await shot(page, "fail");
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
