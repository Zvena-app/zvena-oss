// The public pages and the e-mail sign-in, the way a visitor meets them:
// every public page answers in English with no foreign hosts or console
// errors, old addresses redirect, robots/sitemap exist, and the e-mail link
// and code (read from the stand's outbox) sign in, link accounts and work once.
//   BASE=… WEB_CONTAINER=zvena-webtest-web-1 PLAYWRIGHT_CORE=… node tests/e2e/public.mjs
import { execFileSync } from "node:child_process";
import { BASE, check, context, foreignHosts, landed, launch, pastWelcome, summary } from "./lib.mjs";

const RUN = Math.random().toString(36).slice(2, 7);
const container = process.env.WEB_CONTAINER || "zvena-webtest-web-1";

/** The newest letter in the stand's outbox addressed to `to`. */
function lastLetter(to) {
  const js = `const fs=require("node:fs");const d="/data/outbox";const f=fs.readdirSync(d).map(n=>({n,t:fs.statSync(d+"/"+n).mtimeMs})).sort((a,b)=>b.t-a.t).map(x=>fs.readFileSync(d+"/"+x.n,"utf8")).find(t=>t.includes("To: ${to}"));process.stdout.write(f||"")`;
  return execFileSync("docker", ["exec", container, "node", "-e", js], { encoding: "utf8" });
}

const PAGES = ["/help", "/developers", "/legal/privacy", "/legal/terms", "/legal/cookies", "/source", "/status", "/signin", "/report"];

const browser = await launch();
try {
  const ctx = await context(browser);
  const p = await ctx.newPage();
  for (const path of PAGES) {
    const res = await p.goto(BASE + path);
    const text = await p.locator("body").innerText();
    check(`${path} answers 200`, res?.status() === 200, String(res?.status()));
    check(`${path} has no Cyrillic`, !/[А-Яа-яЁё]/.test(text), (text.match(/.{0,30}[А-Яа-яЁё]+.{0,30}/) || [""])[0]);
    // zvena has an optional decision model now: no page may still promise "no AI".
    check(`${path} names no model or provider`, !/j[e]v|t[y]pe-?s[a]fe/i.test(text), (text.match(/.{0,30}(j[e]v|t[y]pe-?s[a]fe).{0,30}/i) || [""])[0]);
    check(`${path} makes no "no AI" claim`, !/\b(no|without) AI\b|AI-free|none, by design/i.test(text), (text.match(/.{0,30}\b(no|without) AI\b.{0,30}/i) || [""])[0]);
    check(`${path} has one h1`, (await p.locator("h1").count()) === 1);
    check(`${path} has a link preview picture`, (await p.locator('meta[property="og:image"]').count()) > 0 && (await p.locator('meta[name="twitter:image"]').count()) > 0);
  }
  {
    const res = await p.goto(`${BASE}/no-such-page-${Date.now()}`);
    check("an unknown address answers 404 with zvena's page", res?.status() === 404 && (await p.locator("h1").innerText()).includes("doesn"), String(res?.status()));
  }
  {
    const r = await fetch(`${BASE}/`, { redirect: "manual" });
    check("/ sends a visitor to sign-in", r.status === 307 && new URL(r.headers.get("location"), BASE).pathname === "/signin", `${r.status} ${r.headers.get("location")}`);
  }
  check("help sets lang=en", /<html lang="en"/.test(await (await fetch(`${BASE}/help`)).text()));
  for (const [from, to] of [["/legal/consent", "/legal/privacy"], ["/privacy", "/legal/privacy"]]) {
    const r = await fetch(BASE + from, { redirect: "manual" });
    check(`${from} → ${to}`, r.status === 308 && new URL(r.headers.get("location"), BASE).pathname === to, `${r.status} ${r.headers.get("location")}`);
  }
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  check("robots.txt answers (a stand disallows all)", /Disallow: \//.test(robots), robots.slice(0, 80));
  check("sitemap.xml answers", (await fetch(`${BASE}/sitemap.xml`)).status === 200);
  check("no Google script without Google keys", !(await (await fetch(`${BASE}/signin`)).headers.get("content-security-policy")).includes("accounts.google.com"));

  // E-mail sign-in by link: the page asks to continue, the link works once.
  const email = `link-${RUN}@example.com`;
  await p.goto(`${BASE}/signin?next=${encodeURIComponent("/settings")}`);
  await p.fill('input[name="email"]', email);
  await Promise.all([p.waitForURL(/\/signin\/check-email/), p.click('form[action="/api/auth/email/start"] button[type=submit]')]);
  check("check-email page masks the address", (await p.locator("main").innerText()).includes("li•••@example.com"));
  check("the address is not in the URL", !p.url().includes("example.com"), p.url());
  const letter = lastLetter(email);
  const link = (letter.match(/https?:\/\/\S+\/signin\/email\?token=[A-Za-z0-9_-]+/) || [""])[0];
  check("the letter has a link and a code", Boolean(link) && /code: \d{6}/i.test(letter), letter.slice(0, 200));
  await p.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  check("opening the link does not sign in by itself", (await p.evaluate(() => fetch("/api/auth/session").then((r) => r.json()))).user === null);
  await Promise.all([p.waitForURL(landed(/\/settings/)), p.click('form[action="/api/auth/email/verify"] button[type=submit]')]);
  check("a new account sets zvena up first, then goes on to next", new URL(p.url()).pathname === "/welcome" && (new URL(p.url()).searchParams.get("next") ?? "").startsWith("/settings"), p.url());
  await pastWelcome(p);
  const settings = await p.locator("main").innerText();
  check("continuing signs in and returns to next", p.url().includes("/settings"), p.url());
  check("settings show the e-mail method and address", settings.includes("Email link") && settings.includes(email), settings.slice(0, 300));
  check("the name comes from the address", settings.includes(`Link ${RUN}`) || (await p.locator("#zv-name").inputValue()).startsWith("Link"));
  const ctx2 = await context(browser);
  const p2 = await ctx2.newPage();
  await p2.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  check("a used link is refused", (await p2.locator("h1").innerText()).includes("expired"));

  // E-mail sign-in by code, in another browser: the same address → the same account.
  await p2.goto(`${BASE}/signin`);
  await p2.fill('input[name="email"]', email.toUpperCase());
  await Promise.all([p2.waitForURL(/\/signin\/check-email/), p2.click('form[action="/api/auth/email/start"] button[type=submit]')]);
  const code = (lastLetter(email).match(/code: (\d{6})/i) || [])[1];
  await p2.fill('input[name="code"]', code === "000000" ? "111111" : "000000");
  await Promise.all([p2.waitForURL(/error=wrong-code/), p2.click('form[action="/api/auth/email/verify"] button[type=submit]')]);
  check("a wrong code is refused", (await p2.locator(".zv-banner-error").innerText()).includes("isn't right"));
  await p2.fill('input[name="code"]', code);
  await Promise.all([p2.waitForURL(landed(/\/home/)), p2.click('form[action="/api/auth/email/verify"] button[type=submit]')]);
  await pastWelcome(p2);
  const a = await p.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  const b = await p2.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  check("the code signs in to the same account", a.user?.id && a.user.id === b.user?.id, `${a.user?.id} / ${b.user?.id}`);

  check("no foreign hosts", foreignHosts(ctx).length === 0 && foreignHosts(ctx2).length === 0, [...foreignHosts(ctx), ...foreignHosts(ctx2)].join(", "));
  // The deliberate unknown address above logs its own 404.
  const errors = [...ctx.errors, ...ctx2.errors].filter((e) => !/\/no-such-page-\d+ :: .*404/.test(e));
  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("public check ran to the end", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(summary() ? 0 : 1);
