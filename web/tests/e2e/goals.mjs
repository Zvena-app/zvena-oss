// Goals move by themselves, end to end, as two people of one workspace:
//   a document's goal and tasks become a project with issues (Goals from a document);
//   the document shows the goal's progress in its "Related" header, and its
//   task lines become live issue blocks when it opens;
//   the teammate closes the issues in Projects: the bar fills in the open
//   document without a reload, and at the last one the project is completed;
//   the goal's lead hears of it in zvena's Inbox; reopening work reopens the goal.
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const owner = await context(browser);
const mate = await context(browser);
const req = (ctx, method, path, data) =>
  ctx.request.fetch(`${BASE}${path}`, { method, data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));

let page;
try {
  page = await owner.newPage();
  await devSignIn(page, `Gina Goal ${RUN}`);
  const matePage = await mate.newPage();
  await devSignIn(matePage, `Theo Goal ${RUN}`);
  const me = (await (await owner.request.get(`${BASE}/api/auth/session`)).json()).user;

  const ws = (await req(owner, "POST", "/api/ws", { name: `Goals ${RUN}` })).body.workspace.id;
  const inv = await req(owner, "POST", `/api/ws/invites?ws=${ws}`, { role: "editor" });
  check("teammate joins", (await req(mate, "POST", "/api/join", { token: inv.body.url.split("/").pop() })).status === 200);
  await req(owner, "POST", `/api/projects/start?ws=${ws}`, {});
  const boot = await (await owner.request.get(`${BASE}/api/projects/bootstrap?ws=${ws}`)).json();
  const team = boot.teams[0];
  const done = boot.statuses.find((s) => s.teamId === team.id && s.category === "completed");
  const todo = boot.statuses.find((s) => s.teamId === team.id && s.category === "unstarted");

  // A plan with a goal and its two tasks.
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const line = (type, text, props = {}) => ({ id: Math.random().toString(36).slice(2, 10), type, props, content: [{ type: "text", text, styles: {} }], children: [] });
  const note = {
    id,
    parentId: null,
    kind: "page",
    title: "Q4 plan",
    icon: "",
    cover: null,
    content: [line("heading", "Goal: launch the mobile app", { level: 2 }), line("checkListItem", "Submit to the App Store", { checked: false }), line("checkListItem", "Record the demo video", { checked: false })],
    order: now,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
  };
  check("document saved", (await req(owner, "POST", `/api/notes/sync?ws=${ws}`, { items: [{ id, note }] })).status === 200);

  // Goals from the document, as the dialog does: read, create, link both ways.
  const plan = (await req(owner, "POST", `/api/projects/assist?ws=${ws}`, { action: "fromDoc", noteId: id })).body;
  const goalLine = plan.lines.findIndex((l) => l.kind === "goal");
  const tasks = plan.lines.filter((l) => l.kind === "task").map((l) => ({ text: l.text, goal: 0, blockId: l.blockId }));
  check("the document reads as one goal and two tasks", goalLine >= 0 && tasks.length === 2, JSON.stringify(plan.lines.map((l) => l.kind)));
  const made = (await req(owner, "POST", `/api/projects/from-doc?ws=${ws}`, { teamId: team.id, noteId: id, goals: [{ text: plan.lines[goalLine].text }], tasks })).body;
  check("the task lines are queued to become live issues", made.converting === 2, String(made.converting));
  for (const dst of [...made.projects.map((p) => `project:${p}`), ...made.issues.map((i) => `issue:${i}`)]) await req(owner, "POST", `/api/eco/link?ws=${ws}`, { src: `note:${id}`, dst });
  const projectId = made.projects[0];
  await req(owner, "PATCH", `/api/projects/projects/${projectId}?ws=${ws}`, { leadId: me.id });

  // The document shows the goal with its progress.
  await page.goto(`${BASE}/docs?ws=${ws}#Q4-plan-${id}`);
  await page.waitForSelector(".bn-editor", { timeout: 30000 });
  const chip = page.locator(".eco-goal-chip").first();
  await chip.waitFor({ timeout: 20000 });
  check("the document shows its goal", (await chip.innerText()).includes("launch the mobile app"), await chip.innerText());
  check("…at 0%", (await chip.locator(".eco-goal-chip-pct").innerText()) === "0%");
  const swapped = await page
    .waitForFunction(() => document.querySelectorAll(".bn-editor .eco-block").length === 2, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("opening the document turns its task lines into live issues", swapped);
  const plainLeft = await page.locator(".bn-block-content[data-content-type=checkListItem]").count();
  check("…replacing the plain checklist lines", plainLeft === 0, String(plainLeft));

  // Theo closes the first task in Projects: the open document follows.
  const t0 = Date.now();
  await req(mate, "PATCH", `/api/projects/issues/${made.issues[0]}?ws=${ws}`, { statusId: done.id });
  const half = await page
    .waitForFunction(() => document.querySelector(".eco-goal-chip .eco-goal-chip-pct")?.textContent === "50%", null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("the bar fills in the open document, live", half, `${Date.now() - t0} ms`);
  const ticked = await page
    .waitForFunction(() => document.querySelectorAll(".bn-editor .eco-block[data-done]").length === 1, null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("…and its line ticks itself", ticked);

  // The last one: the goal is met.
  const last = await req(mate, "PATCH", `/api/projects/issues/${made.issues[1]}?ws=${ws}`, { statusId: done.id });
  check("the closer is told at once", last.body?.goals?.[0]?.kind === "met" && last.body.goals[0].projectId === projectId, JSON.stringify(last.body?.goals));
  const metLive = await page
    .waitForSelector(".eco-goal-chip[data-done]", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("the document shows the goal as met", metLive);
  const allTicked = await page
    .waitForFunction(() => document.querySelectorAll(".bn-editor .eco-block[data-done]").length === 2, null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("every task line of the goal is ticked", allTicked);
  // A second visit does not swap anything again.
  await page.reload();
  await page.waitForSelector(".bn-editor .eco-block", { timeout: 20000 });
  await page.waitForTimeout(2500);
  check("the swap happens once", (await page.locator(".bn-editor .eco-block").count()) === 2);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/goal-doc-met.png` });
  const project = (await req(owner, "GET", `/api/projects/projects/${projectId}?ws=${ws}`)).body;
  check("the project is completed, with zvena's update", project.state === "completed" && project.updates[0]?.auto === "met", `${project.state} ${project.updates[0]?.auto}`);

  // Gina, the lead, hears it in zvena's Inbox.
  await page.goto(`${BASE}/inbox?ws=${ws}`);
  const heard = await page
    .waitForSelector(".eco-inbox-item >> text=goal met", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("the lead's Inbox says the goal is met", heard);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/goal-inbox.png` });

  // Work reopens: so does the goal.
  await req(mate, "PATCH", `/api/projects/issues/${made.issues[1]}?ws=${ws}`, { statusId: todo.id });
  const back = (await req(owner, "GET", `/api/projects/projects/${projectId}?ws=${ws}`)).body;
  check("reopening work reopens the goal", back.state === "started" && back.updates[0]?.auto === "reopened", `${back.state} ${back.updates[0]?.auto}`);

  // Nobody outside the workspace sees any of it.
  const strangerCtx = await context(browser);
  const sp = await strangerCtx.newPage();
  await devSignIn(sp, `Stan Goal ${RUN}`);
  check("a stranger gets no project", (await req(strangerCtx, "GET", `/api/projects/projects/${projectId}?ws=${ws}`)).status === 403);

  check("no foreign hosts", foreignHosts(owner).length === 0, foreignHosts(owner).join(", "));
  check("no console errors", owner.errors.length === 0, owner.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("goals walk finished", false, String(e).slice(0, 300));
  if (process.env.SHOTS) await page?.screenshot({ path: `${process.env.SHOTS}/goals-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
