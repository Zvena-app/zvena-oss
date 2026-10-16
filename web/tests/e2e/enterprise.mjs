// Business / Enterprise features end to end (a test stand: ZVENA_STAND=test,
// ZVENA_DEV_LOGIN=1): a workspace owner verifies a domain (the stand's DNS
// test hook answers), sets up OpenID Connect SSO against a mock identity
// provider running here, and a new person signs in through it and is
// provisioned; SCIM creates and deactivates a member; Settings → Security
// stops publishing; a published site is served on its custom domain by Host
// header — and nothing else of the app is.
//   BASE=http://127.0.0.1:3954 PLAYWRIGHT_CORE=… CHROMIUM=… node tests/e2e/enterprise.mjs
//   (a stand in Docker: IDP_HOST=<the bridge gateway> so its server reaches the mock provider)
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { BASE, check, context, devSignIn, landed, pastWelcome, summary } from "./lib.mjs";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const RUN = Math.random().toString(36).slice(2, 7);
const DOMAIN = `acme-${RUN}.test`;
const SITE = `docs-${RUN}.example.test`;
const base = new URL(BASE);

// --- A mock OpenID Connect provider ---------------------------------------------------
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const client = { id: `zvena-e2e-${RUN}`, secret: randomBytes(16).toString("hex") };
const codes = new Map();
let nextPerson = null;
const b64u = (b) => Buffer.from(b).toString("base64url");
const idp = createServer((req, res) => {
  const url = new URL(req.url, issuer);
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (url.pathname === "/.well-known/openid-configuration") {
    return send(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
  }
  if (url.pathname === "/jwks") return send(200, { keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256", use: "sig" }] });
  if (url.pathname === "/authorize") {
    // The provider's sign-in page: whoever the test says is at the keyboard.
    const code = randomBytes(12).toString("hex");
    codes.set(code, { who: nextPerson, nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri") });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      const [id, secret] = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":").map(decodeURIComponent);
      const c = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      if (id !== client.id || secret !== client.secret || !c) return send(400, { error: "invalid_grant" });
      if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== c.challenge || form.get("redirect_uri") !== c.redirect) return send(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "e2e" }));
      const body = b64u(JSON.stringify({ iss: issuer, aud: client.id, iat: now, exp: now + 300, nonce: c.nonce, jti: randomBytes(8).toString("hex"), ...c.who }));
      send(200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: `${head}.${body}.${b64u(sign("RSA-SHA256", Buffer.from(`${head}.${body}`), keys.privateKey))}` });
    });
    return;
  }
  send(404, { error: "not found" });
});
// IDP_HOST: an address both the browser and the stand's server reach (a stand in
// Docker: the bridge's gateway, e.g. 172.21.0.1); a stand on this machine: loopback.
const IDP_HOST = process.env.IDP_HOST || "127.0.0.1";
await new Promise((r) => idp.listen(0, IDP_HOST, r));
const issuer = `http://${IDP_HOST}:${idp.address().port}`;

/** A request to the stand with any Host header (what a custom domain's visitor sends). */
function raw(path, host, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: base.hostname, port: base.port, path, method: opts.method ?? "GET", headers: { host, ...(opts.headers ?? {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end(opts.body);
  });
}

const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--host-resolver-rules=MAP ${SITE} ${base.hostname}`],
});
const api = (page, url, method = "GET", body) =>
  page.evaluate(
    async ([url, method, body]) => {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [url, method, body]
  );

try {
  const ctxO = await context(browser);
  const owner = await ctxO.newPage();
  await devSignIn(owner, `Olivia Owner ${RUN}`);
  const ws = (await api(owner, "/api/ws", "POST", { name: `Acme ${RUN}` })).body.workspace.id;

  // 1. Verified domain: add it in Settings → Identity, publish the TXT record (the stand's DNS hook), verify.
  await owner.goto(`${BASE}/settings?ws=${ws}&tab=identity`);
  await owner.locator('[data-test="domain-input"]').fill(DOMAIN);
  await owner.getByRole("button", { name: "Add domain" }).click();
  const record = (await owner.locator(`[data-domain="${DOMAIN}"] .zst-code-text`).first().innerText({ timeout: 10000 })).trim();
  check("1 the domain shows its TXT record", /^zvena-verification=/.test(record), record);
  await api(owner, "/api/enterprise/test-dns", "POST", { type: "txt", name: DOMAIN, values: [record] });
  await owner.locator(`[data-domain="${DOMAIN}"] [data-test="domain-verify"]`).click();
  await owner.locator(`[data-domain="${DOMAIN}"] .zst-badge-ok`).waitFor({ timeout: 10000 });
  check("2 the domain is verified", true);

  // 2. OIDC SSO against the mock provider, then enabled.
  await owner.locator('[data-test="sso-kind"]').selectOption("oidc");
  await owner.locator('[data-test="oidc-issuer"]').fill(issuer);
  await owner.locator('[data-test="oidc-client"]').fill(client.id);
  await owner.locator('[data-test="oidc-secret"]').fill(client.secret);
  await owner.locator('[data-test="sso-save"]').click();
  await owner.locator('[data-test="sso-enabled"]').waitFor({ timeout: 10000 });
  await owner.locator('[data-test="sso-enabled"]').click();
  await owner.waitForFunction(() => document.querySelector('[data-test="sso-enabled"]')?.getAttribute("aria-checked") === "true", null, { timeout: 10000 });
  const sso = (await api(owner, `/api/ws/sso?ws=${ws}`)).body?.sso;
  check("3 SSO is configured and on; the secret never comes back", sso?.kind === "oidc" && sso.enabled && sso.oidc?.hasSecret && !JSON.stringify(sso).includes(client.secret), JSON.stringify(sso));

  // 3. A new person signs in with SSO from the sign-in page and joins just in time.
  const ctxN = await context(browser);
  const newbie = await ctxN.newPage();
  nextPerson = { sub: `ann-${RUN}`, email: `ann@${DOMAIN}`, email_verified: true, name: `Ann Acme ${RUN}` };
  await newbie.goto(`${BASE}/signin`);
  await newbie.getByRole("link", { name: "Continue with SSO" }).click();
  await newbie.locator('input[name="email"]').fill(`ann@${DOMAIN}`);
  await Promise.all([newbie.waitForURL(landed(/\/home/), { timeout: 30000 }), newbie.getByRole("button", { name: "Continue" }).click()]);
  await pastWelcome(newbie);
  const me = (await api(newbie, "/api/auth/session")).body;
  check("4 signed in through SSO", JSON.stringify(me).includes(`Ann Acme ${RUN}`), JSON.stringify(me).slice(0, 200));
  const members = (await api(owner, `/api/ws/members?ws=${ws}`)).body?.members ?? [];
  const ann = members.find((m) => m.name === `Ann Acme ${RUN}`);
  check("5 provisioned as a member with the default role", ann?.role === "editor", JSON.stringify(members));

  // 4. Require SSO: the e-mail sign-in of that domain goes to the identity provider instead of an inbox.
  await owner.locator('[data-test="sso-enforced"]').click();
  await owner.waitForFunction(() => document.querySelector('[data-test="sso-enforced"]')?.getAttribute("aria-checked") === "true", null, { timeout: 10000 });
  const ctxE = await context(browser);
  const other = await ctxE.newPage();
  nextPerson = { sub: `ben-${RUN}`, email: `ben@${DOMAIN}`, email_verified: true, name: `Ben Acme ${RUN}` };
  await other.goto(`${BASE}/signin`);
  const emailForm = other.locator('form[action="/api/auth/email/start"]');
  if (await emailForm.count()) {
    await emailForm.locator('input[name="email"]').fill(`ben@${DOMAIN}`);
    await Promise.all([other.waitForURL(landed(/\/home/), { timeout: 30000 }), emailForm.locator('button[type="submit"]').click()]);
    await pastWelcome(other);
    check("6 an enforced domain's e-mail sign-in goes through SSO", JSON.stringify((await api(other, "/api/auth/session")).body).includes(`Ben Acme ${RUN}`));
  } else check("6 an enforced domain's e-mail sign-in goes through SSO", false, "no e-mail form on the stand");

  // 5. SCIM: a token from Settings, then the directory creates and deactivates someone.
  await owner.locator('[data-test="scim-new"]').click();
  const token = (await owner.locator('[data-test="scim-token"] .zst-code-text').innerText({ timeout: 10000 })).trim();
  check("7 a SCIM token is shown once", /^zvscim_/.test(token));
  const scim = async (method, path, body) => {
    const r = await fetch(`${BASE}/scim/v2/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const created = await scim("POST", "Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `cara@${DOMAIN}`, name: { givenName: "Cara", familyName: `Acme ${RUN}` } });
  const caraId = created.body?.id;
  const afterCreate = (await api(owner, `/api/ws/members?ws=${ws}`)).body?.members ?? [];
  check("8 SCIM create → a member", created.status === 201 && afterCreate.some((m) => m.userId === caraId), `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
  const found = await scim("GET", `Users?filter=${encodeURIComponent(`userName eq "cara@${DOMAIN}"`)}`);
  check("9 SCIM filter finds them", found.body?.totalResults === 1);
  const off = await scim("PATCH", `Users/${caraId}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", value: { active: false } }] });
  const afterOff = (await api(owner, `/api/ws/members?ws=${ws}`)).body?.members ?? [];
  check("10 SCIM deactivate → removed from the workspace", off.status === 200 && off.body?.active === false && !afterOff.some((m) => m.userId === caraId));
  check("11 SCIM without the token is refused", (await fetch(`${BASE}/scim/v2/Users`)).status === 401);

  // 6. Security: "Disable publishing to the web" stops Publish and the page already published.
  const pageId = `e2e${RUN}page01`;
  const note = { id: pageId, kind: "page", parentId: null, title: `Launch site ${RUN}`, icon: "", cover: null, order: Date.now(), content: [{ type: "paragraph", content: [{ type: "text", text: `Hello from ${RUN}`, styles: {} }] }], createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null, favorite: false };
  await api(owner, `/api/notes/sync?ws=${ws}`, "POST", { items: [{ id: pageId, note }] });
  const pub = await api(owner, `/api/notes/share?ws=${ws}`, "POST", { noteId: pageId, snapshot: { notes: [note], rootId: pageId } });
  const shareId = pub.body?.id;
  check("12 a page is published", pub.status === 200 && Boolean(shareId), JSON.stringify(pub).slice(0, 200));
  check("13 …and served at /n/<id>", (await raw(`/n/${shareId}`, base.host)).status === 200);
  await owner.goto(`${BASE}/settings?ws=${ws}&tab=security`);
  await owner.locator('[data-test="sec-disablePublish"]').click();
  await owner.waitForFunction(() => document.querySelector('[data-test="sec-disablePublish"]')?.getAttribute("aria-checked") === "true", null, { timeout: 10000 });
  const blocked = await api(owner, `/api/notes/share?ws=${ws}`, "POST", { noteId: pageId, snapshot: { notes: [note], rootId: pageId } });
  check("14 publishing is refused while disabled", blocked.status === 403, String(blocked.status));
  check("15 the published page is not served meanwhile", (await raw(`/n/${shareId}`, base.host)).status === 404);
  await owner.locator('[data-test="sec-disablePublish"]').click();
  await owner.waitForFunction(() => document.querySelector('[data-test="sec-disablePublish"]')?.getAttribute("aria-checked") === "false", null, { timeout: 10000 });
  check("16 back on: served again", (await raw(`/n/${shareId}`, base.host)).status === 200);

  // 7. A custom domain for the site: connect, verify by the claim's CNAME, served by Host header only.
  await owner.goto(`${BASE}/settings?ws=${ws}&tab=sites`);
  await owner.locator('[data-test="site-domain-input"]').first().fill(SITE);
  await owner.getByRole("button", { name: "Connect domain" }).first().click();
  const target = (await owner.locator('[data-test="site-cname"] .zst-code-text').innerText({ timeout: 10000 })).trim();
  check("17 the site shows its own CNAME target", /^zv-[0-9a-f]{20}\.sites\.zvena\.app$/.test(target), target);
  check("18 not served before it is verified", (await raw("/", SITE)).status === 404);
  await api(owner, "/api/enterprise/test-dns", "POST", { type: "cname", name: SITE, values: [target] });
  await owner.locator('[data-test="site-verify"]').click();
  await owner.locator(`[data-site-domain="${SITE}"] .zst-badge-ok`).waitFor({ timeout: 10000 });
  const home = await raw("/", SITE, { headers: { cookie: "zv_s=whatever" } });
  check("19 the custom domain serves the site", home.status === 200 && home.body.includes(`Hello from ${RUN}`) && !home.headers["set-cookie"], `${home.status}`);
  check("20 its canonical address is the custom domain", new RegExp(`<link rel="canonical" href="http://${SITE.replace(/\./g, "\\.")}/?"`).test(home.body));
  const leaks = await Promise.all(["/api/auth/session", "/docs", "/settings", "/signin", `/n/${shareId}`, "/api/ws", "/scim/v2/Users", "/api/sites/domain-check?domain=" + SITE].map((p) => raw(p, SITE)));
  check("21 nothing else of the app on that host", leaks.every((r) => r.status === 404), leaks.map((r) => r.status).join(","));
  const robots = await raw("/robots.txt", SITE);
  check("22 its robots.txt (a test stand: closed)", robots.status === 200 && robots.body.includes("Disallow: /"));
  check("23 Caddy's ask: yes for it, no for others", (await raw(`/api/sites/domain-check?domain=${SITE}`, base.host)).status === 200 && (await raw("/api/sites/domain-check?domain=random.example.test", base.host)).status === 404);
  check("24 an unknown host gets nothing", (await raw("/", `nobody-${RUN}.example.test`)).status === 404);
  // In a browser: the page renders (and its interactive view takes over) on the domain itself.
  const ctxV = await browser.newContext({ locale: "en-US" });
  const visitor = await ctxV.newPage();
  const errors = [];
  // (Chrome warns that COOP is ignored on a plain-HTTP origin other than localhost: the stand's, not the site's.)
  visitor.on("console", (m) => m.type() === "error" && !/Cross-Origin-Opener-Policy header has been ignored/.test(m.text()) && errors.push(m.text()));
  await visitor.goto(`http://${SITE}:${base.port}/`);
  await visitor.waitForSelector(".nt-pub", { timeout: 30000 });
  await visitor.waitForTimeout(2500);
  const text = await visitor.locator(".nt-pub").innerText();
  const brand = await visitor.locator(".nt-pub-brand").first().getAttribute("href");
  check("25 a browser on the custom domain sees the site", text.includes(`Hello from ${RUN}`) && text.includes(`Launch site ${RUN}`), text.slice(0, 120));
  check("26 its links to zvena leave the domain", String(brand).startsWith(BASE), String(brand));
  check("27 no console errors there", errors.length === 0, errors.slice(0, 3).join(" | "));

  // 8. The audit log has it all.
  const log = (await api(owner, `/api/ws/audit?ws=${ws}`)).body?.entries ?? [];
  const actions = new Set(log.map((e) => e.action));
  check("28 audit log: domain, SSO, SCIM, security, publishing, site domain", ["domain.verify", "sso.update", "sso.jit", "scim.user.create", "scim.user.deactivate", "security.update", "page.publish", "site.domain.verify"].every((a) => actions.has(a)), [...actions].join(","));
  await owner.goto(`${BASE}/settings?ws=${ws}&tab=audit`);
  await owner.locator('[data-test="audit-table"] tbody tr td[data-action]').first().waitFor({ timeout: 10000 });
  const rows = await owner.locator('[data-test="audit-table"] tbody tr').count();
  const csv = await owner.evaluate(async (u) => (await fetch(u)).text(), await owner.locator('[data-test="audit-csv"]').getAttribute("href"));
  const tableText = await owner.locator('[data-test="audit-table"]').innerText();
  check("29b the audit log says what happened in words", tableText.includes("Verified a domain") && !tableText.includes("domain.verify"), tableText.slice(0, 200));
  await owner.locator('[data-test="audit-range"]').selectOption("custom");
  check("29c a custom period shows two dates", (await owner.locator('.zst-filters input[type="date"]').count()) === 2);
  // Settings → Apps: each app's own settings, one click away.
  await owner.locator('[data-test="settings-app-docs"]').click();
  const docsSet = await owner.locator(".nt-settings .nt-settings-body").first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  check("29d Settings → Apps → Docs opens Documents' settings (the link is tidied)", docsSet && !owner.url().includes("settings=1"), owner.url());
  await owner.goto(`${BASE}/settings?ws=${ws}`);
  await owner.locator('[data-test="settings-app-calendar"]').click();
  const calSet = await owner.getByRole("dialog").filter({ has: owner.locator(".cal-form") }).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  check("29e Settings → Apps → Calendar opens Calendar's settings", calSet, owner.url());
  // Settings → Analytics: the workspace's activity, its members listed.
  await owner.goto(`${BASE}/settings?ws=${ws}&tab=analytics`);
  const stats = await owner.locator('[data-test="analytics-stats"] .zst-stat').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const memberRows = await owner.locator('[data-test="analytics-members"] tbody tr').count();
  await owner.locator('[data-test="analytics-span"]').selectOption("90");
  const spanOk = await owner.waitForFunction(() => document.querySelectorAll(".zst-chart rect").length === 90, null, { timeout: 10000 }).then(() => true).catch(() => false);
  check("29f Settings → Analytics: numbers, a bar per day, every member", stats && memberRows >= 1 && spanOk, `${memberRows} members`);
  check("29 the audit log page lists events and exports CSV", rows > 5 && csv.startsWith('"time","actor_id"') && csv.includes("scim.user.create"), `${rows} rows`);
} catch (e) {
  check("enterprise ran", false, String(e?.stack ?? e).slice(0, 500));
} finally {
  await browser.close();
  idp.close();
}
process.exit(summary() ? 0 : 1);
