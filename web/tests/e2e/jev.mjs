// Jev runs the workspace, end to end, as a person sees it:
//   a chart in Documents gets a goal ("Won ≥ 1,000"): a goal issue appears in
//   Projects, and when rows change the chart's goal fills and the issue closes
//   by itself — the page under the chart follows without a reload;
//   Home's Jev panel shows the goal met and what Jev did;
//   a parent issue closes with its last sub-issue, and Undo on Home takes it back;
//   an issue that states a target is proposed a goal on the matching number
//   (rules: the stand has no model), accepted on the issue's Goal panel;
//   a goal measured by a database ("count rows where Stage is Won") is set
//   from the issue and updates by itself;
//   a goal on meetings in a calendar ("customer calls in the next 7 days")
//   closes when the second call is booked;
//   a database automation's run is on Home with Undo, and "Only if Jev
//   agrees" is set in the automation's editor and saved with it.
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const owner = await context(browser);
const req = (ctx, method, path, data) =>
  ctx.request.fetch(`${BASE}${path}`, { method, data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const shot = async (p, name) => process.env.SHOTS && (await p.screenshot({ path: `${process.env.SHOTS}/jev-${name}.png` }).catch(() => {}));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

let page;
try {
  page = await owner.newPage();
  await devSignIn(page, `Jo Jev ${RUN}`);
  const ws = (await req(owner, "POST", "/api/ws", { name: `Jev ${RUN}` })).body.workspace.id;
  await req(owner, "POST", `/api/projects/start?ws=${ws}`, {});
  const boot = await (await owner.request.get(`${BASE}/api/projects/bootstrap?ws=${ws}`)).json();
  const team = boot.teams[0];
  const status = (cat) => boot.statuses.find((s) => s.teamId === team.id && s.category === cat);
  const issueCat = async (id) => {
    const r = await req(owner, "GET", `/api/projects/issues/${id}?ws=${ws}`);
    const i = r.body?.issue ?? r.body;
    return boot.statuses.find((s) => s.id === i?.statusId)?.category;
  };
  const newIssue = async (title, extra = {}) => {
    const r = await req(owner, "POST", `/api/projects/issues?ws=${ws}`, { teamId: team.id, title, ...extra });
    return r.body?.issue ?? r.body;
  };

  // A sales pipeline with a chart: won revenue by stage.
  const db = hex();
  const now = Date.now();
  const base = { icon: "", cover: null, content: [], favorite: false, createdAt: now, updatedAt: now, trashedAt: null };
  const dbNote = {
    ...base,
    id: db,
    parentId: null,
    kind: "database",
    title: "Pipeline",
    order: now,
    db: {
      properties: [
        { id: "title", name: "Deal", type: "title" },
        { id: "amt", name: "Amount", type: "number" },
        { id: "st", name: "Stage", type: "status", options: [{ id: "open", name: "Open", color: "default", group: "todo" }, { id: "won", name: "Won", color: "green", group: "done" }] },
      ],
      views: [{ id: "chart1", name: "Revenue", type: "chart", filters: [], sorts: [], chart: { type: "column", x: "st", y: { fn: "sum", prop: "amt" } } }],
    },
  };
  const row = (id, amt, st, order) => ({ ...base, id, parentId: db, kind: "page", title: `Deal ${order}`, order, props: { amt, st } });
  const r1 = hex();
  const r2 = hex();
  const r3 = hex();
  const sync = (items) => req(owner, "POST", `/api/notes/sync?ws=${ws}`, { items });
  check("database saved", (await sync([{ id: db, note: dbNote }, { id: r1, note: row(r1, 400, "won", 1) }, { id: r2, note: row(r2, 900, "open", 2) }])).status === 200);

  // The chart: Set a goal on its Won bar.
  await page.goto(`${BASE}/docs?ws=${ws}#Pipeline-${db}`);
  const add = page.locator("[data-test=chart-goal-add]");
  await add.waitFor({ timeout: 30000 });
  check("a chart offers to set a goal", await add.isVisible());
  await add.click();
  await page.locator(".eco-chart-goal-form select").first().selectOption({ label: "Won" });
  await page.fill("[data-test=chart-goal-target]", "1000");
  await page.click("[data-test=chart-goal-save]");
  const goalRow = page.locator(".eco-chart-goal").first();
  await goalRow.waitFor({ timeout: 15000 });
  const text = (await goalRow.innerText()).replace(/\s+/g, " ");
  check("the goal shows under the chart with where the Won bar stands", /Won: 400 ≥ 1,?000/.test(text), text);
  await shot(page, "chart-goal");
  const goals = (await req(owner, "GET", `/api/decide?ws=${ws}&view=goals`)).body.goals;
  const goal = goals.find((g) => g.source?.db === db);
  check("a goal issue was made in Projects", Boolean(goal?.issue?.identifier), JSON.stringify(goals).slice(0, 200));
  check("…still open", (await issueCat(goal.issue.id)) !== "completed");

  // A deal is won (as if a teammate edited the row): the chart reaches the goal, the issue closes by itself.
  await sync([{ id: r2, note: { ...row(r2, 900, "won", 2), updatedAt: Date.now() } }]);
  const met = await page
    .waitForSelector(".eco-chart-goal[data-met]", { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check("the chart's goal turns met in the open page, no reload", met);
  check("…and the goal issue closed by itself", await until(async () => (await issueCat(goal.issue.id)) === "completed"));
  await shot(page, "chart-goal-met");

  // A parent closes with its last sub-issue.
  const parent = await newIssue("Onboarding revamp");
  const s1 = await newIssue("Welcome email", { parentId: parent.id });
  const s2 = await newIssue("First-run checklist", { parentId: parent.id });
  await req(owner, "PATCH", `/api/projects/issues/${s1.id}?ws=${ws}`, { statusId: status("completed").id });
  await req(owner, "PATCH", `/api/projects/issues/${s2.id}?ws=${ws}`, { statusId: status("completed").id });
  check("the parent closed with its last sub-issue", await until(async () => (await issueCat(parent.id)) === "completed"));

  // Home: Jev's panel.
  await page.goto(`${BASE}/home?ws=${ws}`);
  const panel = page.locator(".eco-jev");
  await panel.locator(".eco-jev-head h2").waitFor({ timeout: 20000 });
  check("Home shows Jev", (await panel.locator(".eco-jev-head h2").innerText()).trim() === "Jev");
  const goalItem = panel.locator(".eco-jev-goals li[data-met]");
  check("…with the met goal", (await goalItem.count()) >= 1);
  const did = panel.locator(".eco-jev-items li");
  await did.first().waitFor({ timeout: 10000 });
  const lines = (await did.allInnerTexts()).join(" | ");
  check("…and what it did: the goal met and the parent closed", /Goal met/.test(lines) && /Closed .*Onboarding revamp/.test(lines), lines.slice(0, 300));
  await shot(page, "home");
  // Undo the parent on Home.
  const parentLine = did.filter({ hasText: "Onboarding revamp" }).first();
  await parentLine.getByRole("button", { name: "Undo" }).click();
  check("Undo on Home puts the parent back", await until(async () => (await issueCat(parent.id)) !== "completed"));

  // A number and an issue that names it: a proposal on the issue, accepted there.
  await req(owner, "POST", `/api/decide?ws=${ws}`, { op: "metric", key: "signups", value: 120, label: "Signups" });
  const target = await newIssue("Reach 500 signups");
  await page.goto(`${BASE}/projects/issue/${target.identifier}?ws=${ws}`);
  const proposal = page.locator(".eco-goal-proposal");
  const proposed = await proposal
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check("the issue proposes a goal on the number it names", proposed && /Signups ≥ 500/.test(await proposal.innerText()), proposed ? await proposal.innerText() : "");
  await proposal.getByRole("button", { name: "Accept" }).click();
  await page.locator(".eco-goal-row:not(.eco-goal-proposal)").first().waitFor({ timeout: 10000 });
  check("accepted: the issue is a goal on Signups", /Signups/.test(await page.locator(".eco-goal-row").first().innerText()));
  await req(owner, "POST", `/api/decide?ws=${ws}`, { op: "metric", key: "signups", value: 512 });
  check("…and closes when the number gets there", await until(async () => (await issueCat(target.id)) === "completed"));

  // A goal measured by the database, set from an issue.
  const counted = await newIssue("Win three deals");
  await page.goto(`${BASE}/projects/issue/${counted.identifier}?ws=${ws}`);
  await page.getByRole("button", { name: "Close automatically when…" }).click();
  const form = page.locator(".eco-goal-form");
  await form.waitFor();
  await form.locator("label").filter({ hasText: "A database or chart" }).click();
  await form.locator("label", { hasText: "Only rows where" }).locator("select").selectOption({ label: "Stage: Won" });
  await form.locator("label", { hasText: "Target" }).locator("input").fill("3");
  await form.getByRole("button", { name: "Save" }).click();
  const live = page.locator(".eco-goal-live");
  await live.waitFor({ timeout: 10000 });
  check("a database-measured goal updates by itself", (await page.locator(".eco-goal-row").first().innerText()).includes("2"), await page.locator(".eco-goal-row").first().innerText());
  await sync([{ id: r3, note: row(r3, 50, "won", 3) }]);
  check("…a third won deal closes it", await until(async () => (await issueCat(counted.id)) === "completed"));

  // Meetings in a calendar: a goal closes when the second customer call is booked.
  const calBoot = (await req(owner, "GET", `/api/calendar/bootstrap?ws=${ws}`)).body;
  const myCal = calBoot.calendars.find((c) => c.canEdit !== false) ?? calBoot.calendars[0];
  const soonAt = Date.now() + 2 * 86400000;
  const meet = (title, h) => req(owner, "POST", `/api/calendar/events?ws=${ws}`, { calId: myCal.id, title, start: soonAt + h * 3600000, end: soonAt + (h + 1) * 3600000, tz: "UTC", notify: false });
  check("a customer call is booked", (await meet(`Customer call: Acme ${RUN}`, 0)).status === 200);
  await meet(`Lunch ${RUN}`, 2);
  const calls = await newIssue("Book the customer calls");
  await page.goto(`${BASE}/projects/issue/${calls.identifier}?ws=${ws}`);
  await page.getByRole("button", { name: "Close automatically when…" }).click();
  const cform = page.locator(".eco-goal-form");
  await cform.waitFor();
  await cform.locator("label").filter({ hasText: "Meetings in a calendar" }).click();
  await cform.locator("label", { hasText: "When" }).locator("select").selectOption({ label: "Next 7 days" });
  await cform.locator("label", { hasText: "Title has" }).locator("input").fill("customer call");
  await cform.locator("label", { hasText: "Target" }).locator("input").fill("2");
  await shot(page, "calendar-goal-form");
  await cform.getByRole("button", { name: "Save" }).click();
  await page.locator(".eco-goal-live").waitFor({ timeout: 10000 });
  const calRow = (await page.locator(".eco-goal-row").first().innerText()).replace(/\s+/g, " ");
  check("a calendar-measured goal shows the meetings so far", /\b1\b/.test(calRow) && /2/.test(calRow), calRow);
  await meet(`customer call: Beta ${RUN}`, 4);
  check("…and closes when the second call is booked", await until(async () => (await issueCat(calls.id)) === "completed"));

  // A database automation: its run is on Home, with Undo.
  const adb = hex();
  const leads = {
    ...base,
    id: adb,
    parentId: null,
    kind: "database",
    title: "Leads",
    order: now + 10,
    db: {
      properties: [
        { id: "title", name: "Lead", type: "title" },
        { id: "st", name: "Stage", type: "status", options: [{ id: "new", name: "New", color: "blue", group: "todo" }, { id: "won", name: "Won", color: "green", group: "done" }] },
      ],
      views: [{ id: "t1", name: "All", type: "table", filters: [], sorts: [] }],
      automations: [{ id: "au1", name: `Tag new leads ${RUN}`, on: true, trigger: { type: "added" }, actions: [{ type: "set", prop: "st", value: "new" }] }],
    },
  };
  check("a database with an automation saved", (await sync([{ id: adb, note: leads }])).status === 200);
  const lead = hex();
  await sync([{ id: lead, note: { ...base, id: lead, parentId: adb, kind: "page", title: `Lead ${RUN}`, order: 1, props: {}, createdAt: Date.now(), updatedAt: Date.now() } }]);
  const leadStage = async () => (await req(owner, "GET", `/api/notes/sync?ws=${ws}&since=0`)).body.notes.find((n) => n.id === lead)?.props?.st ?? null;
  check("the automation ran on the server", await until(async () => (await leadStage()) === "new"));
  await page.goto(`${BASE}/home?ws=${ws}`);
  const ran = page.locator(".eco-jev-items li").filter({ hasText: `Tag new leads ${RUN}` }).first();
  check(
    "Home shows the automation's run among what Jev did",
    await ran
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false)
  );
  await ran.getByRole("button", { name: "Undo" }).click();
  check("Undo on Home puts the value back", await until(async () => (await leadStage()) === null));

  // "Only if Jev agrees": set in the automation's editor, saved with the automation.
  await page.goto(`${BASE}/docs?ws=${ws}#Leads-${adb}`);
  await page.getByRole("button", { name: "Automations" }).first().click();
  await page.getByRole("button", { name: "New automation" }).click();
  await page.locator(".nt-auto-name").fill(`Ask Jev ${RUN}`);
  await page.locator(".nt-auto-jev-toggle input").check();
  await page.locator(".nt-auto-jev .nt-input").fill("Is this lead a large company?");
  await shot(page, "automation-jev");
  await page.locator(".nt-auto-foot .nt-btn-primary").click();
  const saved = await until(async () => {
    const d = (await req(owner, "GET", `/api/notes/sync?ws=${ws}&since=0`)).body.notes.find((n) => n.id === adb);
    return d?.db?.automations?.some((a) => a.name === `Ask Jev ${RUN}` && a.jev?.question === "Is this lead a large company?" && a.jev.fields.includes("title"));
  });
  check("“Only if Jev agrees” is saved with the automation (the title is what Jev reads)", saved);
  check("the list says it asks Jev", (await page.locator(".nt-auto-item").filter({ hasText: `Ask Jev ${RUN}` }).innerText()).includes("if Jev agrees"));
  await page.keyboard.press("Escape");

  // The owner makes a key for numbers from outside (shown once), and a number sent with it arrives.
  await page.goto(`${BASE}/home?ws=${ws}`);
  await page.locator(".eco-jev-head").getByRole("button", { name: "What Jev does by itself" }).click();
  await page.getByRole("button", { name: "Create a key" }).click();
  const example = page.locator("[data-test=jev-ingest-example]");
  await example.waitFor({ timeout: 10000 });
  const keyText = (await example.innerText()).match(/zvi_[A-Za-z0-9_-]+/)?.[0];
  check("Jev's settings make a key for numbers from outside, with an example", Boolean(keyText));
  const pushed = await owner.request.post(`${BASE}/api/pulse/ingest`, { headers: { authorization: `Bearer ${keyText}`, "content-type": "application/json" }, data: { metric: "mrr", value: 4200, label: "MRR" } });
  check("…and a number sent with it arrives", pushed.status() === 200 && (await req(owner, "GET", `/api/decide?ws=${ws}`)).body.metrics.some((m) => m.key === "mrr" && m.value === 4200));
  await page.getByRole("button", { name: "Revoke the key" }).click();
  await until(async () => (await req(owner, "GET", `/api/decide?ws=${ws}&view=jev`)).body.overview.ingest === false);
  const refused = await owner.request.post(`${BASE}/api/pulse/ingest`, { headers: { authorization: `Bearer ${keyText}`, "content-type": "application/json" }, data: { metric: "mrr", value: 1 } });
  check("…revoked, it no longer works", refused.status() >= 400, String(refused.status()));

  // A phone: Home's panel fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/home?ws=${ws}`);
  await page.locator(".eco-jev-head h2").waitFor({ timeout: 20000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("Home with Jev fits a phone (no sideways scroll)", overflow <= 1, String(overflow));
  await shot(page, "home-phone");

  check("no foreign hosts", foreignHosts(owner).length === 0, foreignHosts(owner).join(", "));
  check("no console errors", owner.errors.length === 0, owner.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("Jev walk finished", false, String(e).slice(0, 400));
  if (process.env.SHOTS) await page?.screenshot({ path: `${process.env.SHOTS}/jev-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
