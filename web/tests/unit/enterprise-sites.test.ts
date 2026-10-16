import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { setDnsForTests } from "@/lib/enterprise/dns";
import { addDomain, DomainError, sitesCnameTarget, verifyDomain } from "@/lib/enterprise/domains";
import { hostOnly, isFirstPartyHost, normalizeDomain, siteRoute, SITE_HOST_HEADER } from "@/lib/enterprise/hosts";
import { domainJoinUrl, joinableWorkspaces, joinByDomain } from "@/lib/enterprise/join";
import { updateSecurity } from "@/lib/enterprise/security";
import { addSiteDomain, customDomainOf, SiteDomainError, shareForHost, verifySiteDomain } from "@/lib/enterprise/site-domains";
import { auditCsv, auditEntries, csvCell } from "@/lib/enterprise/audit-log";
import { blankNote } from "@/lib/notes/model";
import { saveNoteShare, validShareSnapshot } from "@/lib/notes/server-store";
import { audit, sql } from "@/lib/store";
import { createWorkspace, roleIn } from "@/lib/workspaces";
import { proxy } from "@/proxy";

const V = "2026-10-13";
// Custom domains are offered on a server set up for them (Caddy's on-demand TLS, DNS): on for these tests.
process.env.ZVENA_SITES_CUSTOM_DOMAINS = "on";
const txt = new Map<string, string[]>();
const cname = new Map<string, string[]>();
setDnsForTests({ txt: async (n) => txt.get(n) ?? [], cname: async (n) => cname.get(n) ?? [] });

function person(name: string, email: string): string {
  const r = signInWith({ provider: "dev", subject: `sites-${name}`, name, email, emailVerified: true }, V);
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

function publish(ws: string, by: string, options: Record<string, unknown> = {}): string {
  const root = blankNote({ kind: "page", title: "Launch site", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello from the site", styles: {} }] }] });
  const snap = validShareSnapshot({ notes: [root], rootId: root.id, options });
  assert.ok(snap);
  return saveNoteShare(ws, by, root.id, snap);
}

test("hosts: zvena's own hosts, IPs and container names are first-party; anything else is a custom domain", () => {
  const app = "https://zvena.app";
  assert.equal(hostOnly("Docs.Example.COM:443."), "docs.example.com");
  assert.equal(hostOnly("[::1]:3100"), "::1");
  for (const h of ["zvena.app", "www.zvena.app", "ZVENA.APP:443", "127.0.0.1:3100", "10.0.0.5", "web:3100", "localhost:3100", "app.localhost", "[::1]:3954", ""]) assert.equal(isFirstPartyHost(h, app), true, h);
  for (const h of ["docs.example.com", "zvena.app.evil.com", "evil-zvena.app", "sites.zvena.app", "test.zvena.app"]) assert.equal(isFirstPartyHost(h, app), false, h);
  assert.equal(isFirstPartyHost("test.zvena.app", app, "test.zvena.app, other.host"), true);
  assert.equal(normalizeDomain(" HTTPS://Docs.Example.com. "), "docs.example.com");
  assert.equal(normalizeDomain("bücher.example"), "xn--bcher-kva.example");
  for (const bad of ["localhost", "1.2.3.4", "docs.example.com/path", "a@b.com", "-x.com", "x..com", "x.123", ""]) assert.equal(normalizeDomain(bad), null, bad);
  assert.deepEqual(siteRoute("/"), { kind: "rewrite", to: "/n/_site" });
  assert.deepEqual(siteRoute("/robots.txt"), { kind: "rewrite", to: "/api/sites/robots" });
  assert.equal(siteRoute(`/api/notes/file/${"a".repeat(40)}.png`).kind, "pass");
  assert.equal(siteRoute("/_next/static/chunks/x.js").kind, "pass");
  for (const p of ["/docs", "/signin", "/api/auth/session", "/api/notes/sync", "/n/abc", "/settings", "/scim/v2/Users", "/api/sites/domain-check", "/brand/../../etc", "/api/notes/file/../x"]) assert.equal(siteRoute(p).kind, "deny", p);
});

function proxied(url: string, headers: Record<string, string>) {
  return proxy(new NextRequest(url, { headers }));
}

test("proxy: a custom domain gets its site, nothing else, and no cookie reaches the app", () => {
  process.env.APP_URL = "http://localhost:3100";
  const deny = proxied("http://docs.customer.com/api/notes/sync?ws=x", { host: "docs.customer.com", cookie: "zv_s=stolen" });
  assert.equal(deny.status, 404);
  assert.equal(proxied("http://docs.customer.com/signin", { host: "docs.customer.com" }).status, 404);
  const root = proxied("http://docs.customer.com/", { host: "docs.customer.com", cookie: "zv_s=stolen", authorization: "Bearer x" });
  // next.config.ts rewrites "/" by the header the proxy sets (never an absolute rewrite that would leave the server).
  assert.equal(root.headers.get("x-middleware-rewrite"), null);
  assert.equal(root.headers.get("x-middleware-request-x-zv-path"), "/n/_site");
  const overridden = String(root.headers.get("x-middleware-override-headers")).split(",");
  assert.ok(!overridden.includes("cookie") && !overridden.includes("authorization"), overridden.join(","));
  assert.equal(root.headers.get(`x-middleware-request-${SITE_HOST_HEADER}`), "docs.customer.com");
  assert.equal(root.headers.get("strict-transport-security"), null, "dev: no HSTS");
  // zvena itself: a forged site header never passes, prefetches included.
  for (const extra of [{}, { "next-router-prefetch": "1" }, { purpose: "prefetch" }] as Record<string, string>[]) {
    const own = proxied("http://localhost:3100/n/_site", { host: "localhost:3100", [SITE_HOST_HEADER]: "docs.customer.com", ...extra });
    assert.ok(!String(own.headers.get("x-middleware-override-headers")).split(",").includes(SITE_HOST_HEADER), JSON.stringify(extra));
  }
  // Sign-in forms may end at a workspace's identity provider (form-action governs redirects); other pages may not.
  const formAction = (path: string) => /form-action ([^;]*)/.exec(String(proxied(`http://localhost:3100${path}`, { host: "localhost:3100" }).headers.get("content-security-policy")))?.[1] ?? "";
  assert.match(formAction("/signin/sso"), /'self'.* https:/);
  assert.match(formAction("/api/sso/start"), / https:/);
  assert.doesNotMatch(formAction("/docs"), /https:(?!\/\/)/);
  // The routes the proxy skips answer 404 on a custom domain by themselves.
  return import("@/app/api/notes/sync/route").then(async (sync) => {
    const r = await sync.GET(new Request("http://docs.customer.com/api/notes/sync?ws=abcdefgh", { headers: { host: "docs.customer.com" } }));
    assert.equal(r.status, 404);
  });
});

test("next.config rewrites a site's root, robots.txt and sitemap.xml only when the proxy named the host", async () => {
  const conf = (await import("../../next.config")).default;
  const r = (await conf.rewrites?.()) as { beforeFiles: { source: string; destination: string; has?: { type: string; key: string }[] }[] };
  assert.deepEqual(
    r.beforeFiles.map((x) => [x.source, x.destination, x.has?.[0]?.key]),
    [
      ["/", "/n/_site", SITE_HOST_HEADER],
      ["/robots.txt", "/api/sites/robots", SITE_HOST_HEADER],
      ["/sitemap.xml", "/api/sites/sitemap", SITE_HOST_HEADER],
    ]
  );
});

test("workspace domains: the TXT record verifies; a domain is one workspace's; zvena's own are refused", async () => {
  const a = person("dom-a", "a@dom-a.com");
  const b = person("dom-b", "b@dom-b.com");
  const wa = createWorkspace(a, "A").id;
  const wb = createWorkspace(b, "B").id;
  const da = addDomain(wa, a, "Shared-Co.com");
  assert.equal(da.domain, "shared-co.com");
  assert.match(da.record, /^zvena-verification=[A-Za-z0-9_-]{32}$/);
  const db = addDomain(wb, b, "shared-co.com");
  assert.equal((await verifyDomain(wa, a, "shared-co.com")).ok, false, "no record yet");
  txt.set("shared-co.com", [da.record, db.record]);
  assert.ok((await verifyDomain(wa, a, "shared-co.com")).ok);
  const taken = await verifyDomain(wb, b, "shared-co.com");
  assert.equal(!taken.ok && taken.error, "taken");
  assert.throws(() => addDomain(wa, a, "localhost"), DomainError);
  assert.throws(() => addDomain(wa, a, sitesCnameTarget()), DomainError);
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'domain.verify' AND target = ?").get(wa));
});

test("allowed e-mail domains: people at the domain see the workspace after signing in and join with the chosen role", async () => {
  const owner = person("join-owner", "owner@join-co.com");
  const ws = createWorkspace(owner, "Join Co").id;
  const d = addDomain(ws, owner, "join-co.com");
  txt.set("join-co.com", [d.record]);
  await verifyDomain(ws, owner, "join-co.com");
  const ann = person("join-ann", "ann@join-co.com");
  assert.deepEqual(joinableWorkspaces(ann), [], "not open yet");
  sql("UPDATE ent_domains SET allow_join = 1 WHERE ws = ?").run(ws);
  updateSecurity(ws, owner, { joinRole: "commenter" });
  assert.deepEqual(joinableWorkspaces(ann).map((j) => j.id), [ws]);
  assert.match(String(domainJoinUrl(ann, new URL("http://localhost:3100/docs"))), /\/join\/domain\?next=%2Fdocs$/);
  assert.equal(joinByDomain(ann, ws)?.role, "commenter");
  assert.equal(roleIn(ann, ws), "commenter");
  assert.equal(domainJoinUrl(ann, new URL("http://localhost:3100/home")), null);
  // Someone at another domain cannot.
  const bob = person("join-bob", "bob@gmail.com");
  assert.equal(joinByDomain(bob, ws), null);
});

test("custom domains: the claim's own CNAME or TXT verifies it; the shared target alone does not; one workspace per domain", async () => {
  const owner = person("site-owner", "owner@site-co.com");
  const ws = createWorkspace(owner, "Site Co").id;
  const share = publish(ws, owner, { index: true });
  const d = addSiteDomain(ws, owner, share, "Docs.Site-Co.com");
  assert.equal(d.domain, "docs.site-co.com");
  assert.match(d.cname, new RegExp(`^zv-[0-9a-f]{20}\\.${sitesCnameTarget().replace(/\./g, "\\.")}$`));
  assert.throws(() => addSiteDomain(ws, owner, "nope", "x.site-co.com"), SiteDomainError);
  assert.throws(() => addSiteDomain(ws, owner, share, "other.site-co.com"), SiteDomainError, "one domain per site");
  // A CNAME to the shared target proves nothing (anyone could claim a dangling one).
  cname.set("docs.site-co.com", [sitesCnameTarget()]);
  assert.equal((await verifySiteDomain(ws, owner, "docs.site-co.com")).ok, false);
  assert.equal(shareForHost("docs.site-co.com"), null);
  cname.set("docs.site-co.com", [d.cname]);
  const v = await verifySiteDomain(ws, owner, "docs.site-co.com");
  assert.ok(v.ok && v.via === "cname");
  assert.equal(shareForHost("DOCS.site-co.com:443"), share);
  assert.equal(customDomainOf(share), "docs.site-co.com");
  // Someone else claims it too: theirs stays pending, even with a TXT record of their own.
  const rival = person("site-rival", "rival@rival.com");
  const rws = createWorkspace(rival, "Rival").id;
  const rd = addSiteDomain(rws, rival, publish(rws, rival), "docs.site-co.com");
  txt.set("_zvena-site.docs.site-co.com", [rd.txtValue]);
  const r = await verifySiteDomain(rws, rival, "docs.site-co.com");
  assert.equal(!r.ok && r.error, "taken");
  assert.equal(shareForHost("docs.site-co.com"), share);
  // A bare domain by TXT.
  const share2 = publish(ws, owner);
  const apex = addSiteDomain(ws, owner, share2, "site-co.com");
  txt.set("_zvena-site.site-co.com", [apex.txtValue]);
  const t = await verifySiteDomain(ws, owner, "site-co.com");
  assert.ok(t.ok && t.via === "txt");
  // Publishing off: the domain serves nothing, and Caddy is told no.
  const check = await import("@/app/api/sites/domain-check/route");
  const ask = async (domain: string) => (await check.GET(new Request(`http://web:3100/api/sites/domain-check?domain=${domain}`))).status;
  assert.equal(await ask("docs.site-co.com"), 200);
  assert.equal(await ask("unknown.example.com"), 404);
  assert.equal(await ask("not a domain"), 404);
  updateSecurity(ws, owner, { disablePublish: true });
  assert.equal(shareForHost("docs.site-co.com"), null);
  assert.equal(await ask("docs.site-co.com"), 404);
  updateSecurity(ws, owner, { disablePublish: false });
  // A moderator's takedown too.
  sql("UPDATE note_shares SET removed_at = ? WHERE id = ?").run(Date.now(), share2);
  assert.equal(await ask("site-co.com"), 404);
});

test("custom domains: robots.txt and sitemap.xml of the site, by the host the proxy names", async () => {
  const owner = person("robots-owner", "owner@robots-co.com");
  const ws = createWorkspace(owner, "Robots Co").id;
  const open = publish(ws, owner, { index: true });
  const closed = publish(ws, owner);
  const a = addSiteDomain(ws, owner, open, "open.robots-co.com");
  const b = addSiteDomain(ws, owner, closed, "closed.robots-co.com");
  cname.set("open.robots-co.com", [a.cname]);
  cname.set("closed.robots-co.com", [b.cname]);
  await verifySiteDomain(ws, owner, "open.robots-co.com");
  await verifySiteDomain(ws, owner, "closed.robots-co.com");
  const robots = await import("@/app/api/sites/robots/route");
  const sitemap = await import("@/app/api/sites/sitemap/route");
  const get = async (mod: { GET: (r: Request) => Promise<Response> }, host: string | null) => {
    const r = await mod.GET(new Request("http://x/api/sites/robots", { headers: host ? { [SITE_HOST_HEADER]: host } : {} }));
    return { status: r.status, text: await r.text() };
  };
  const ro = await get(robots, "open.robots-co.com");
  assert.match(ro.text, /Allow: \/\n\nSitemap: https:\/\/open\.robots-co\.com\/sitemap\.xml/);
  assert.match((await get(robots, "closed.robots-co.com")).text, /Disallow: \//);
  assert.equal((await get(robots, null)).status, 404);
  assert.match((await get(sitemap, "open.robots-co.com")).text, /<loc>https:\/\/open\.robots-co\.com\/<\/loc>/);
  assert.ok(!(await get(sitemap, "closed.robots-co.com")).text.includes("<loc>"));
});

test("audit log: the workspace's lines and its members' sign-ins, filters, paging, and CSV that never runs as a formula", async () => {
  const owner = person("audit-owner", "owner@audit-co.com");
  const ws = createWorkspace(owner, "Audit Co").id;
  const outsider = person("audit-outsider", "x@other.com");
  audit(owner, "security.update", ws, { setting: "disableGuests", value: true });
  audit(outsider, "security.update", "another-ws");
  audit(outsider, "signin", "email");
  audit(owner, "signin", "email");
  for (let i = 0; i < 5; i++) audit(owner, "group.create", ws);
  const all = auditEntries(ws, { limit: 100 });
  assert.ok(all.entries.every((e) => e.target === ws || (["signin", "signup"].includes(e.action) && e.actor === owner)));
  assert.ok(all.entries.some((e) => e.action === "workspace.create"));
  assert.ok(all.entries.some((e) => e.action === "signin"));
  assert.ok(!all.entries.some((e) => e.actor === outsider));
  assert.equal(all.entries[0].actorName, "audit-owner");
  assert.deepEqual(new Set(auditEntries(ws, { action: "group." }).entries.map((e) => e.action)), new Set(["group.create"]));
  const p1 = auditEntries(ws, { action: "group.create", limit: 2 });
  const p2 = auditEntries(ws, { action: "group.create", limit: 2, before: p1.entries[1].id });
  assert.deepEqual([p1.entries.length, p1.more, p2.entries.length], [2, true, 2]);
  assert.ok(p2.entries.every((e) => e.id < p1.entries[1].id));
  assert.equal(auditEntries(ws, { from: Date.now() + 60_000 }).entries.length, 0);
  assert.equal(auditEntries(ws, { actor: outsider }).entries.length, 0);
  assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell("@SUM(A1)"), `"'@SUM(A1)"`);
  const csv = [...auditCsv(ws, {})].join("");
  assert.match(csv.split("\r\n")[0], /^"time","actor_id","actor","action"/);
  assert.ok(csv.includes('"security.update"'));
});

test("audit log: a member's account events only since they joined this workspace", async () => {
  const owner = person("audit2-owner", "owner@audit2-co.com");
  const ws = createWorkspace(owner, "Audit Two").id;
  const late = person("audit2-late", "late@audit2-co.com");
  // Signed in long before joining: none of the workspace's business.
  sql("INSERT INTO audit (at, actor, action, target, meta) VALUES (?, ?, 'signin', 'email', NULL)").run(Date.now() - 86_400_000, late);
  sql("INSERT INTO members (ws_id, user_id, role, created_at) VALUES (?, ?, 'editor', ?)").run(ws, late, Date.now() - 1000);
  audit(late, "signin", "email");
  const mine = auditEntries(ws, { actor: late, limit: 50 }).entries.filter((e) => e.action === "signin");
  assert.equal(mine.length, 1, "only the sign-in after joining");
});

test("custom domains switched off (ZVENA_SITES_CUSTOM_DOMAINS, the default): routes answer 404, no host is a site", async () => {
  const owner = person("site-off", "owner@off-co.com");
  const ws = createWorkspace(owner, "Off Co").id;
  const share = publish(ws, owner);
  const d = addSiteDomain(ws, owner, share, "docs.off-co.com");
  cname.set("docs.off-co.com", [d.cname]);
  assert.ok((await verifySiteDomain(ws, owner, "docs.off-co.com")).ok);
  assert.equal(shareForHost("docs.off-co.com"), share);
  const check = await import("@/app/api/sites/domain-check/route");
  const domains = await import("@/app/api/ws/site-domains/route");
  delete process.env.ZVENA_SITES_CUSTOM_DOMAINS;
  try {
    assert.equal(shareForHost("docs.off-co.com"), null, "nothing is served on the domain");
    assert.equal((await check.GET(new Request("http://web:3100/api/sites/domain-check?domain=docs.off-co.com"))).status, 404, "Caddy is told no");
    const cookie = `${sessionCookieName()}=${issueSession(owner)}`;
    const list = await domains.GET(new Request(`http://localhost:3100/api/ws/site-domains?ws=${ws}`, { headers: { cookie, origin: "http://localhost:3100", host: "localhost:3100" } }));
    assert.equal(list.status, 404, "nothing listed");
    const add = await domains.POST(new Request(`http://localhost:3100/api/ws/site-domains?ws=${ws}`, { method: "POST", headers: { cookie, origin: "http://localhost:3100", host: "localhost:3100", "content-type": "application/json" }, body: JSON.stringify({ op: "add", shareId: share, domain: "x.off-co.com" }) }));
    assert.equal(add.status, 404);
  } finally {
    process.env.ZVENA_SITES_CUSTOM_DOMAINS = "on";
  }
});
