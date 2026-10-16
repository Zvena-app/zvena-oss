// The home page's "one change, everywhere" scenario (app/page.tsx #connected),
// checked against the product so the website only says what happens:
//   a live number reaches its target → the goal issue closes by itself (an
//   exact rule, no AI) → the Docs row linked to it is marked done → its parent
//   issue closes with its last sub-issue (an automatic step) → Home's
//   Automations panel shows both; the automatic step has Undo, the rule's
//   own close does not (the issue is reopened by hand).
//   BASE=… PLAYWRIGHT_CORE=… node tests/e2e/scenario.mjs   (SHOTS=<dir> for a picture of the panel)
import { BASE, check, context, devSignIn, foreignHosts, launch, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const browser = await launch();
const owner = await context(browser);
const req = (method, path, data) =>
  owner.request.fetch(`${BASE}${path}`, { method, data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  await devSignIn(page, `Sam Scenario ${RUN}`);
  const ws = (await req("POST", "/api/ws", { name: `Scenario ${RUN}` })).body.workspace.id;
  await req("POST", `/api/projects/start?ws=${ws}`, {});
  const boot = await (await owner.request.get(`${BASE}/api/projects/bootstrap?ws=${ws}`)).json();
  const team = boot.teams[0];
  const status = (cat) => boot.statuses.find((s) => s.teamId === team.id && s.category === cat);
  const issueCat = async (id) => {
    const r = await req("GET", `/api/projects/issues/${id}?ws=${ws}`);
    const i = r.body?.issue ?? r.body;
    return boot.statuses.find((s) => s.id === i?.statusId)?.category;
  };
  const newIssue = async (title, extra = {}) => {
    const r = await req("POST", `/api/projects/issues?ws=${ws}`, { teamId: team.id, title, ...extra });
    return r.body?.issue ?? r.body;
  };

  // A live number, a parent issue with two sub-issues (one already done), and the goal.
  await req("POST", `/api/decide?ws=${ws}`, { op: "metric", key: "signups", value: 640, label: "Signups" });
  const parent = await newIssue("Launch the beta");
  const goal = await newIssue("Reach 1,000 signups", { parentId: parent.id });
  const post = await newIssue("Write the launch post", { parentId: parent.id });
  await req("PATCH", `/api/projects/issues/${post.id}?ws=${ws}`, { statusId: status("completed").id });
  const set = await req("POST", `/api/decide?ws=${ws}`, { op: "goal", issue: goal.id, key: "signups", cmp: ">=", target: 1000 });
  check("an issue becomes a goal: “Close automatically when… Signups ≥ 1,000”", set.status === 200 && set.body?.reaction?.if?.kind === "compare", JSON.stringify(set.body).slice(0, 200));

  // A Docs row linked to the goal issue.
  const db = hex();
  const row = hex();
  const now = Date.now();
  const base = { icon: "", cover: null, content: [], favorite: false, createdAt: now, updatedAt: now, trashedAt: null };
  const dbNote = {
    ...base,
    id: db,
    parentId: null,
    kind: "database",
    title: "Launch checklist",
    order: now,
    db: {
      properties: [
        { id: "title", name: "Task", type: "title" },
        { id: "st", name: "Status", type: "status", options: [{ id: "todo", name: "Not started", color: "default", group: "todo" }, { id: "done", name: "Done", color: "green", group: "done" }] },
      ],
      views: [{ id: "t1", name: "All", type: "table", filters: [], sorts: [] }],
    },
  };
  const rowNote = { ...base, id: row, parentId: db, kind: "page", title: "Announce the beta", order: 1, props: { st: "todo" } };
  check("the checklist is saved", (await req("POST", `/api/notes/sync?ws=${ws}`, { items: [{ id: db, note: dbNote }, { id: row, note: rowNote }] })).status === 200);
  check("…and its row linked to the goal issue", (await req("POST", `/api/eco/link?ws=${ws}`, { src: `note:${row}`, dst: `issue:${goal.id}` })).status === 200);
  const rowStatus = async () => (await req("GET", `/api/notes/sync?ws=${ws}&since=0`)).body.notes.find((n) => n.id === row)?.props?.st ?? null;

  // The number gets there.
  check("still open below the target", (await issueCat(goal.id)) !== "completed" && (await rowStatus()) === "todo");
  await req("POST", `/api/decide?ws=${ws}`, { op: "metric", key: "signups", value: 1012 });
  check("1 the goal issue closes by itself", await until(async () => (await issueCat(goal.id)) === "completed"));
  check("2 the linked Docs row is marked done", await until(async () => (await rowStatus()) === "done"));
  check("3 the parent closes with its last sub-issue", await until(async () => (await issueCat(parent.id)) === "completed"));

  // The journal: what happened, and what can be undone.
  const hub = (await req("GET", `/api/decide?ws=${ws}&view=hub`)).body;
  const met = hub.activity.find((a) => a.kind === "goal_met");
  const closed = hub.activity.find((a) => a.kind === "parent_done");
  check("4 the journal has the goal met (an exact rule, no Undo)", met && met.source === "rule" && met.canUndo === false, JSON.stringify(met));
  check("5 …and the parent closed automatically, with Undo", closed && closed.canUndo === true, JSON.stringify(closed));

  // Home: the Automations panel, as a person sees it.
  await page.goto(`${BASE}/home?ws=${ws}`);
  const panel = page.locator(".eco-hub");
  await panel.locator(".eco-hub-items li").first().waitFor({ timeout: 20000 });
  const lines = (await panel.locator(".eco-hub-items li").allInnerTexts()).join(" | ");
  check("6 Home shows “Goal met” and “Launch the beta closed: all its sub-issues are done”", /Goal met: .*Reach 1,000 signups/.test(lines) && /Launch the beta closed: all its sub-issues are done/.test(lines), lines.slice(0, 300));
  if (process.env.SHOTS) await panel.screenshot({ path: `${process.env.SHOTS}/scenario-home.png` }).catch(() => {});
  const parentLine = panel.locator(".eco-hub-items li").filter({ hasText: "Launch the beta closed" }).first();
  await parentLine.getByRole("button", { name: "Undo" }).click();
  check("7 Undo puts the parent back", await until(async () => (await issueCat(parent.id)) !== "completed"));
  check("8 …and leaves the goal and the row as they are", (await issueCat(goal.id)) === "completed" && (await rowStatus()) === "done");

  check("no foreign hosts", foreignHosts(owner).length === 0, foreignHosts(owner).join(", "));
  check("no console errors", owner.errors.length === 0, owner.errors.slice(0, 3).join(" | "));
} catch (e) {
  check("scenario walk finished", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
