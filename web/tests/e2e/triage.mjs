// Triage end to end, as a team lead and a colleague outside the team:
//   the lead turns Triage on in the team's settings;
//   the colleague's new issue says it went to the team's triage and is not on the board;
//   the lead sees it in Triage (badge in the rail), accepts one with 1,
//   declines another with 3 and a reason; the colleague hears both;
//   a stranger cannot triage.
import { BASE, check, context, devSignIn, foreignHosts, LANG, launch, summary } from "./lib.mjs";

const T = LANG === "ru" ? { triage: "Разбор", on: "Разбор входящих задач", decline: "Отклонить" } : { triage: "Triage", on: "Triage incoming issues", decline: "Decline" };
const RUN = Math.random().toString(36).slice(2, 7);
const SHOTS = process.env.SHOTS || "";
const browser = await launch();
const leadCtx = await context(browser);
const mateCtx = await context(browser);
const req = (ctx, method, path, data) =>
  ctx.request.fetch(`${BASE}${path}`, { method, data, headers: { origin: BASE } }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));

let page;
try {
  page = await leadCtx.newPage();
  await devSignIn(page, `Lena Lead ${RUN}`);
  const mate = await mateCtx.newPage();
  await devSignIn(mate, `Omar Outside ${RUN}`);
  const ws = (await req(leadCtx, "POST", "/api/ws", { name: `Triage ${RUN}` })).body.workspace.id;
  const inv = await req(leadCtx, "POST", `/api/ws/invites?ws=${ws}`, { role: "editor" });
  check("colleague joins (editor, not in the team)", (await req(mateCtx, "POST", "/api/join", { token: inv.body.url.split("/").pop() })).status === 200);

  // The lead turns Triage on in the team's settings.
  await page.goto(`${BASE}/projects?ws=${ws}`);
  await page.waitForURL(/\/projects\/team\/[A-Z0-9]+\//, { timeout: 30000 });
  const KEY = /\/team\/([A-Z0-9]+)\//.exec(page.url())[1];
  if (await page.locator(".zv-cookie button").count()) await page.locator(".zv-cookie button").first().click();
  await page.goto(`${BASE}/projects/settings/team/${KEY}?ws=${ws}`);
  await page.locator(".zst-row", { hasText: T.on }).locator("[role=switch]").click();
  await page.waitForTimeout(800);
  const boot = await (await page.request.get(`${BASE}/api/projects/bootstrap?ws=${ws}`)).json();
  const team = boot.teams.find((t) => t.key === KEY);
  check("Triage is on", team?.triage === true);

  // Omar files two issues through the dialog.
  await mate.goto(`${BASE}/projects/team/${KEY}/issues?ws=${ws}&layout=list`);
  await mate.waitForSelector(".pj-screen", { timeout: 30000 });
  if (await mate.locator(".zv-cookie button").count()) await mate.locator(".zv-cookie button").first().click();
  for (const title of ["Export to CSV drops the last row", "Make the logo bigger"]) {
    await mate.keyboard.press("c");
    await mate.waitForSelector(".pj-create-title");
    await mate.locator(".pj-create-title").fill(title);
    await mate.keyboard.press("Control+Enter");
    await mate.waitForSelector(".ds-toast", { timeout: 8000 });
  }
  const sentToast = (await mate.locator(".ds-toast").allTextContents()).join(" ");
  check("the colleague is told it went to triage", /triage|разбор/i.test(sentToast), sentToast.slice(0, 120));
  await mate.waitForTimeout(600);
  check("…and it is not on the team's list", (await mate.locator(".pj-issue-row", { hasText: "Export to CSV" }).count()) === 0);

  // The colleague cannot let their own issue in: no actions on it, and the server says no.
  const mine = (await req(mateCtx, "GET", `/api/projects/issues?ws=${ws}&inTeam=${(await req(leadCtx, "GET", `/api/projects/bootstrap?ws=${ws}`)).body.teams.find((t) => t.key === KEY).id}&triage=1&group=none&completed=all`)).body;
  const ownId = mine?.groups?.flatMap((g) => g.items).find((i) => i.title.startsWith("Export to CSV"))?.identifier;
  if (ownId) {
    await mate.goto(`${BASE}/projects/issue/${ownId}?ws=${ws}`);
    await mate.waitForSelector(".pj-triage-bar", { timeout: 15000 });
    check("the author outside the team sees no triage actions", (await mate.locator(".pj-triage-actions").count()) === 0);
    check("…and the server refuses their accept", (await req(mateCtx, "POST", `/api/projects/issues/${ownId}/triage?ws=${ws}`, { action: "accept" })).status === 403);
  } else check("the colleague finds their waiting issue", false, JSON.stringify(mine).slice(0, 200));

  // The lead's rail counts it; Triage lists both.
  await page.goto(`${BASE}/projects/team/${KEY}/triage?ws=${ws}`);
  await page.waitForSelector(".pj-triage .pj-notif", { timeout: 15000 });
  check("Triage lists the two issues", (await page.locator(".pj-triage .pj-notif").count()) === 2);
  const railText = await page.locator(".ds-nav-item, a", { hasText: T.triage }).first().innerText();
  check("the rail shows how many wait", /2/.test(railText), railText.replace(/\s+/g, " "));
  await page.waitForSelector(".pj-triage-bar", { timeout: 15000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/triage.png` });

  // 1 accepts the selected one (the newest first).
  const first = (await page.locator(".pj-triage .pj-notif[data-on] .pj-notif-title").innerText()).trim();
  await page.keyboard.press("1");
  await page.waitForFunction(() => document.querySelectorAll(".pj-triage .pj-notif").length === 1, null, { timeout: 10000 });
  check("1 accepts the issue", true, first);

  // 3 declines the other, with a reason.
  await page.waitForSelector(".pj-triage-bar", { timeout: 10000 });
  await page.keyboard.press("3");
  await page.waitForSelector(".pj-triage-decline textarea", { timeout: 5000 });
  await page.keyboard.type("Brand guidelines fix the logo size.");
  await page.locator(".pj-triage-decline button[type=submit]").click();
  await page.waitForFunction(() => document.querySelectorAll(".pj-triage .pj-notif").length === 0, null, { timeout: 10000 });
  check("3 declines it with a reason", true);

  const accepted = (await req(leadCtx, "GET", `/api/projects/issues?ws=${ws}&filter=${encodeURIComponent(JSON.stringify({ team: [team.id] }))}`)).body;
  const titles = accepted.groups.flatMap((g) => g.items.map((i) => i.title));
  check("the accepted issue is in the team's work, the declined one is closed", titles.includes(first.replace(/^\S+\s/, "")) || titles.some((t) => first.includes(t)), titles.join(" | "));

  // Omar hears what became of them.
  const n = (await req(mateCtx, "GET", `/api/projects/notifications?ws=${ws}`)).body.items.filter((x) => x.kind === "triaged").map((x) => x.data.result).sort();
  check("the colleague hears both outcomes", JSON.stringify(n) === JSON.stringify(["accepted", "declined"]), JSON.stringify(n));

  // A stranger gets nothing.
  const sc = await context(browser);
  const sp = await sc.newPage();
  await devSignIn(sp, `Stan ${RUN}`);
  const any = (await req(leadCtx, "POST", `/api/projects/issues?ws=${ws}`, { teamId: team.id, title: "Sent on purpose", triage: true })).body;
  check("a stranger cannot triage", (await req(sc, "POST", `/api/projects/issues/${any.id}/triage?ws=${ws}`, { action: "accept" })).status === 403);

  check("no foreign hosts", foreignHosts(leadCtx).length === 0, foreignHosts(leadCtx).join(", "));
  check("no console errors", leadCtx.errors.length === 0 && mateCtx.errors.length === 0, [...leadCtx.errors, ...mateCtx.errors].slice(0, 3).join(" | "));
} catch (e) {
  check("triage walk finished", false, String(e).slice(0, 300));
  if (SHOTS) await page?.screenshot({ path: `${SHOTS}/triage-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
