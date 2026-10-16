import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { signInWith, issueSession } from "@/lib/auth";
import { desktopLink } from "@/lib/apps";
import { androidAppLinks, iosAppIds } from "@/lib/app-links";
import { swScope } from "@/lib/sw-scope";
import * as shareTarget from "@/app/share-target/route";
import * as aasa from "@/app/.well-known/apple-app-site-association/route";
import * as assetlinks from "@/app/.well-known/assetlinks.json/route";

// The service worker's policy, loaded from the very file browsers run (it exports its pure parts under Node).
interface Policy {
  VERSION: string;
  STATIC_CACHE: string;
  classify(input: { url: string; method?: string; mode?: string; headers?: Record<string, string>; origin?: string }): string;
  pageKey(url: string): string;
  userCacheName(scope: string | null): string | null;
  scopeFromHtml(html: string): string | null;
  cachesToDrop(names: string[], scope: string | null): string[];
  storable(res: { status: number; type?: string; redirected?: boolean; headers: { get(k: string): string | null } }, kind: string): boolean;
}
const sw = createRequire(__filename)(join(process.cwd(), "public", "sw.js")) as Policy;
const O = "https://zvena.app";
const nav = (path: string, headers: Record<string, string> = {}) => sw.classify({ url: `${O}${path}`, method: "GET", mode: "navigate", headers, origin: O });

test("service worker: API answers, page data and other sites are never stored", () => {
  assert.equal(sw.classify({ url: `${O}/api/notes/sync?ws=abc&since=0`, origin: O }), "bypass");
  assert.equal(sw.classify({ url: `${O}/api/auth/session`, origin: O }), "bypass");
  assert.equal(sw.classify({ url: `${O}/api/clipper/me`, origin: O }), "bypass");
  assert.equal(sw.classify({ url: `${O}/api/notes/file/${"a".repeat(40)}.pdf`, origin: O }), "bypass", "only pictures of pages are kept");
  // Next.js page data (client navigations, prefetches) is a person's data in another shape.
  assert.equal(nav("/docs", { rsc: "1" }), "bypass");
  assert.equal(sw.classify({ url: `${O}/docs?_rsc=x1`, mode: "cors", origin: O }), "bypass");
  assert.equal(nav("/docs", { "next-router-prefetch": "1" }), "bypass");
  assert.equal(sw.classify({ url: "https://cdn.example/x.js", origin: O }), "bypass");
  assert.equal(sw.classify({ url: `${O}/docs`, method: "POST", mode: "navigate", origin: O }), "bypass");
  // The public site and shared pages are not kept as anyone's.
  assert.equal(nav("/"), "bypass");
  assert.equal(nav("/n/abcdefghijklmnop"), "bypass");
  assert.equal(nav("/clip?url=x"), "bypass");
  // Range requests (media) pass.
  assert.equal(sw.classify({ url: `${O}/_next/static/chunks/a.js`, headers: { range: "bytes=0-1" }, origin: O }), "bypass");
});

test("service worker: what is kept — the build's files, app pages, pictures; logout and share are handled", () => {
  assert.equal(sw.classify({ url: `${O}/_next/static/chunks/app-123.js`, origin: O }), "static");
  assert.equal(sw.classify({ url: `${O}/fonts/inter/inter-latin-wght-normal.woff2`, origin: O }), "static");
  assert.equal(sw.classify({ url: `${O}/offline`, origin: O }), "static");
  assert.equal(nav("/docs"), "page");
  assert.equal(nav("/docs?ws=abc"), "page");
  assert.equal(nav("/home"), "page");
  assert.equal(sw.classify({ url: `${O}/api/notes/file/${"a".repeat(40)}.png`, origin: O }), "file");
  assert.equal(sw.classify({ url: `${O}/api/auth/logout`, method: "POST", origin: O }), "logout");
  assert.equal(sw.classify({ url: `${O}/api/auth/account`, method: "DELETE", origin: O }), "logout");
  assert.equal(sw.classify({ url: `${O}/share-target`, method: "POST", mode: "navigate", origin: O }), "share");
});

test("service worker: one cache per person, keyed by path; a page is filed under the scope it names", () => {
  assert.equal(sw.pageKey(`${O}/docs?ws=abc#Page-123`), `${O}/docs`);
  assert.equal(sw.pageKey(`${O}/docs/`), `${O}/docs`);
  const a = "A".repeat(32);
  const b = "b".repeat(32);
  assert.equal(sw.userCacheName(a), `zv-user-${a}`);
  assert.equal(sw.userCacheName("guest"), "zv-user-guest");
  // Nothing that could escape the prefix or name another cache.
  assert.equal(sw.userCacheName("../zv-static"), null);
  assert.equal(sw.userCacheName(""), null);
  assert.equal(sw.userCacheName(null), null);
  assert.equal(sw.scopeFromHtml(`<html><head><meta charSet="utf-8"/><meta name="zv-scope" content="${a}"/>`), a);
  assert.equal(sw.scopeFromHtml(`<meta name="zv-scope" content="<script>">`), null);
  assert.equal(sw.scopeFromHtml("<html><head></head>"), null);
  // Switching to B drops A's pages and pictures and old builds' files, keeps B's and the current static cache.
  const names = [`zv-user-${a}`, `zv-user-${a}-files`, `zv-user-${b}`, `zv-user-${b}-files`, "zv-user-guest", sw.STATIC_CACHE, "zv-static-zv-sw-0", "zv-share", "other-app"];
  assert.deepEqual(sw.cachesToDrop(names, b).sort(), [`zv-user-${a}`, `zv-user-${a}-files`, "zv-static-zv-sw-0", "zv-user-guest"].sort());
  // Signed out: every person's cache goes.
  assert.deepEqual(sw.cachesToDrop(names, null).filter((n) => n.startsWith("zv-user-")).sort(), names.filter((n) => n.startsWith("zv-user-")).sort());
});

test("service worker: only whole, successful HTML pages and allowed files are stored", () => {
  const res = (status: number, headers: Record<string, string>, extra: Record<string, unknown> = {}) => ({ status, headers: { get: (k: string) => headers[k] ?? null }, ...extra });
  assert.ok(sw.storable(res(200, { "content-type": "text/html; charset=utf-8" }), "page"));
  assert.ok(!sw.storable(res(200, { "content-type": "application/json" }), "page"));
  assert.ok(!sw.storable(res(500, { "content-type": "text/html" }), "page"));
  assert.ok(!sw.storable(res(200, { "content-type": "text/html" }, { redirected: true }), "page"), "a sign-in redirect is not the page");
  assert.ok(!sw.storable(res(200, { "cache-control": "no-store" }), "static"));
  assert.ok(!sw.storable(res(200, { "content-length": String(20 * 1024 * 1024) }), "file"));
  assert.ok(sw.storable(res(200, { "content-length": "1000" }), "file"));
});

test("sw scope: an HMAC of the account, the same across sessions, guest without one", () => {
  const r = signInWith({ provider: "dev", subject: "sw-scope-1", name: "Sam" }, "2026-10-13");
  assert.ok(r.ok);
  const one = swScope(`zv_s=${issueSession(r.user.id)}`);
  const two = swScope(`zv_s=${issueSession(r.user.id)}`);
  assert.equal(one, two);
  assert.match(one, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!one.includes(r.user.id));
  assert.equal(sw.userCacheName(one), `zv-user-${one}`);
  assert.equal(swScope(null), "guest");
  assert.equal(swScope("zv_s=forged-token-value-forged-token-value-forged"), "guest");
});

test("desktop links: pages of this site map to zvena://, others do not", () => {
  assert.equal(desktopLink("https://zvena.app/docs?ws=abc#Plan-123", "https://zvena.app"), "zvena://docs?ws=abc#Plan-123");
  assert.equal(desktopLink("/home", "https://zvena.app"), "zvena://home");
  assert.equal(desktopLink("https://evil.example/docs", "https://zvena.app"), null);
  assert.equal(desktopLink("javascript:alert(1)", "https://zvena.app"), null);
});

test("app links: from the environment only, malformed values dropped; 404 without them", async () => {
  assert.deepEqual(iosAppIds({ ZVENA_IOS_APP_ID: "ABCDE12345.app.zvena.mobile, bad id, X.y" }), ["ABCDE12345.app.zvena.mobile"]);
  assert.equal(androidAppLinks({}), null);
  const fp = Array.from({ length: 32 }, () => "AB").join(":");
  const links = androidAppLinks({ ZVENA_ANDROID_CERT_SHA256: `${fp.toLowerCase()}, nope` }) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
  assert.equal(links[0].target.package_name, "app.zvena.mobile");
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, [fp]);
  delete process.env.ZVENA_IOS_APP_ID;
  assert.equal(aasa.GET().status, 404);
  process.env.ZVENA_IOS_APP_ID = "ABCDE12345.app.zvena.mobile";
  const j = (await aasa.GET().json()) as { applinks: { details: { appIDs: string[]; components: { "/": string }[] }[] } };
  assert.deepEqual(j.applinks.details[0].appIDs, ["ABCDE12345.app.zvena.mobile"]);
  assert.ok(j.applinks.details[0].components.some((c) => c["/"] === "/docs"));
  delete process.env.ZVENA_IOS_APP_ID;
  assert.equal(assetlinks.GET().status, 404);
});

test("share target without a worker: the shared link and text open /clip; another site's form is refused", async () => {
  const form = (headers: Record<string, string>) => {
    const fd = new FormData();
    fd.set("title", "A page");
    fd.set("text", "Look at this");
    fd.set("url", "https://example.com/a");
    return new Request("http://localhost:3100/share-target", { method: "POST", body: fd, headers });
  };
  const ok = await shareTarget.POST(form({ "sec-fetch-site": "none" }));
  assert.equal(ok.status, 303);
  const to = new URL(ok.headers.get("location") as string, "http://localhost:3100");
  assert.equal(to.pathname, "/clip");
  assert.equal(to.searchParams.get("url"), "https://example.com/a");
  assert.equal(to.searchParams.get("title"), "A page");
  assert.equal((await shareTarget.POST(form({ "sec-fetch-site": "cross-site" }))).status, 403);
});
