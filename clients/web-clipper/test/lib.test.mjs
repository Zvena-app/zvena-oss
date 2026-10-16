// The clipper's pure logic: the Connect flow's values, URLs, the request
// body, recent destinations, error messages, the manifests, the zip writer.
//   npm test

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { base64url, challengeOf, makeState, makeVerifier, randomString, STATE_RE, VERIFIER_RE } from "../src/lib/pkce.js";
import { absUrl, MAX_DATA_URL, originPattern, pickSrcset, serverOrigin } from "../src/lib/urls.js";
import { buildPayload, byteLength, capHtml, MAX_BODY_BYTES } from "../src/lib/payload.js";
import { cleanDest, lastKey, MAX_RECENTS, pushRecent, recentsKey, safeIcon } from "../src/lib/recents.js";
import { errorKey, retryAfterSeconds } from "../src/lib/errors.js";
import { DEFAULT_SERVER, makeManifest } from "../src/lib/manifest.js";
import { crc32, zip } from "../scripts/zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("PKCE: state and verifier have the shapes the server accepts", () => {
  for (let i = 0; i < 50; i++) {
    assert.match(makeState(), STATE_RE);
    assert.match(makeVerifier(), VERIFIER_RE);
  }
  assert.notEqual(makeState(), makeState());
  assert.equal(randomString(10, "ab").replace(/[ab]/g, ""), "");
});

test("PKCE: S256 challenge is base64url(SHA-256(verifier)) without padding", async () => {
  // RFC 7636, appendix B.
  assert.equal(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const v = makeVerifier();
  assert.equal(await challengeOf(v), createHash("sha256").update(v).digest("base64url"));
  assert.doesNotMatch(base64url(new Uint8Array([255, 254, 253])), /[+/=]/);
});

test("URLs: relative → absolute, unsafe schemes dropped", () => {
  const base = "https://news.example.com/a/b/article.html";
  assert.equal(absUrl("../img/x.png", base, { image: true }), "https://news.example.com/a/img/x.png");
  assert.equal(absUrl("//cdn.example.com/y.jpg", base, { image: true }), "https://cdn.example.com/y.jpg");
  assert.equal(absUrl("#top", base), "https://news.example.com/a/b/article.html#top");
  assert.equal(absUrl("javascript:alert(1)", base), "");
  assert.equal(absUrl(" JaVaScRiPt:alert(1)", base), "");
  assert.equal(absUrl("data:text/html,<script>", base), "");
  assert.equal(absUrl("mailto:a@b.c", base), "mailto:a@b.c");
  assert.equal(absUrl("mailto:a@b.c", base, { image: true }), "");
  assert.equal(absUrl("https://user:pw@example.com/", base), "");
  assert.equal(absUrl("data:image/png;base64,AAAA", base, { image: true }), "data:image/png;base64,AAAA");
  assert.equal(absUrl(`data:image/png;base64,${"A".repeat(MAX_DATA_URL)}`, base, { image: true }), "");
  assert.equal(absUrl("data:image/svg+xml;base64,AAAA", base, { image: true }), "");
  assert.equal(absUrl("", base), "");
});

test("srcset: the widest w, else the highest x", () => {
  assert.equal(pickSrcset("a.jpg 320w, b.jpg 1280w, c.jpg 640w"), "b.jpg");
  assert.equal(pickSrcset("a.jpg, b.jpg 2x, c.jpg 1.5x"), "b.jpg");
  assert.equal(pickSrcset("https://x.com/i.jpg?w=1,2 800w, https://x.com/j.jpg 400w"), "https://x.com/i.jpg?w=1,2");
  assert.equal(pickSrcset("only.png"), "only.png");
  assert.equal(pickSrcset(""), "");
});

test("server origins: https anywhere, http only on this machine", () => {
  assert.equal(serverOrigin("zvena.example.com/docs"), "https://zvena.example.com");
  assert.equal(serverOrigin("http://127.0.0.1:3955/"), "http://127.0.0.1:3955");
  assert.equal(serverOrigin("http://evil.example.com"), "");
  assert.equal(serverOrigin("ftp://x"), "");
  assert.equal(serverOrigin(""), "");
  assert.equal(originPattern("http://127.0.0.1:3955"), "http://127.0.0.1/*");
  assert.equal(originPattern("https://zvena.app"), "https://zvena.app/*");
});

test("payload: fields cut to their limits, the target cleaned", () => {
  const p = buildPayload({ ws: "w1", target: { type: "page", id: "p1", extra: 1 }, mode: "article", title: "  T  ", page: { url: "https://a.b/", content: "<p>x</p>", excerpt: "e".repeat(5000), cover: "https://a.b/c.jpg" } });
  assert.deepEqual(p.target, { type: "page", id: "p1" });
  assert.equal(p.title, "T");
  assert.equal(p.excerpt.length, 1000);
  assert.equal(p.html, "<p>x</p>");
  assert.deepEqual(buildPayload({ ws: "w", target: { type: "nope" }, mode: "x", page: { url: "https://a.b/" } }).target, { type: "private" });
  assert.equal(buildPayload({ ws: "w", mode: "x", page: { url: "https://a.b/" } }).mode, "article");
  // Bookmarks send no body; selections send the selection, not the article.
  assert.equal(buildPayload({ ws: "w", mode: "bookmark", page: { url: "https://a.b/", content: "<p>a</p>" } }).html, undefined);
  assert.equal(buildPayload({ ws: "w", mode: "selection", page: { url: "https://a.b/", content: "<p>a</p>", selection: "<b>s</b>" } }).html, "<b>s</b>");
  // No title: the page's, then its address.
  assert.equal(buildPayload({ ws: "w", mode: "bookmark", page: { url: "https://a.b/" } }).title, "https://a.b/");
});

test("payload: a huge article is cut at a tag to fit 4 MB", () => {
  const html = "<p>Привет, мир — это длинная статья.</p>".repeat(120_000);
  const p = buildPayload({ ws: "w", mode: "article", title: "t", page: { url: "https://a.b/", content: html } });
  assert.ok(byteLength(JSON.stringify(p)) <= MAX_BODY_BYTES);
  assert.ok(p.html.endsWith("</p>"));
  assert.ok(p.html.length > 1000);
  assert.equal(capHtml("<p>short</p>", 1000), "<p>short</p>");
  assert.equal(capHtml("no tags at all here", 5), "");
});

test("recent destinations: newest first, no duplicates, five at most", () => {
  let list = [];
  for (let i = 0; i < 8; i++) list = pushRecent(list, { id: `p${i}`, kind: "page", title: `P${i}` });
  assert.equal(list.length, MAX_RECENTS);
  assert.equal(list[0].id, "p7");
  list = pushRecent(list, { id: "p5", kind: "page", title: "again" });
  assert.deepEqual(list.map((d) => d.id), ["p5", "p7", "p6", "p4", "p3"]);
  assert.equal(list[0].title, "again");
  assert.equal(cleanDest({ id: "x", kind: "private" }), null);
  assert.deepEqual(pushRecent([{ id: "a", kind: "database", title: "D", icon: "icon:star:blue" }], null).map((d) => d.icon), [""]);
  assert.equal(recentsKey("https://zvena.app", "w1"), "recent:https://zvena.app|w1");
  assert.equal(lastKey("https://zvena.app"), "last:https://zvena.app");
  assert.equal(safeIcon("📄"), "📄");
  assert.equal(safeIcon("/api/notes/file/x.png"), "");
  assert.equal(safeIcon("javascript:x"), "");
});

test("errors: each answer has a message", () => {
  const keys = JSON.parse(readFileSync(join(root, "src/_locales/en/messages.json"), "utf8"));
  const cases = [
    [0, "errNetwork"],
    [400, "errBadRequest"],
    [401, "errUnauthorized"],
    [403, "errForbidden"],
    [404, "errNotFound"],
    [413, "errTooLarge"],
    [429, "errRateLimited"],
    [507, "errQuota"],
    [500, "errServer"],
    [503, "errServer"],
    [418, "errBadRequest"],
  ];
  for (const [status, key] of cases) {
    assert.equal(errorKey(status, null), key);
    assert.ok(keys[key], `${key} is in _locales`);
  }
  assert.equal(errorKey(507, { error: "storage full" }), "errServer");
  assert.equal(retryAfterSeconds("30"), 30);
  assert.equal(retryAfterSeconds("0"), 1);
  assert.equal(retryAfterSeconds(new Date(Date.now() + 5000).toUTCString()) > 0, true);
  assert.equal(retryAfterSeconds(""), 0);
});

test("manifests: least privilege, the right background per browser", () => {
  for (const browser of ["chrome", "firefox"]) {
    const m = makeManifest({ browser, version: "1.2.3" });
    const all = JSON.stringify(m);
    assert.equal(m.manifest_version, 3);
    assert.equal(m.version, "1.2.3");
    assert.ok(!all.includes("<all_urls>"));
    assert.deepEqual(m.host_permissions, ["https://zvena.app/*"]);
    assert.deepEqual([...m.permissions].sort(), ["activeTab", "contextMenus", "scripting", "storage"]);
    assert.ok(!m.permissions.includes("tabs") && !m.permissions.includes("cookies"));
    assert.deepEqual(m.content_scripts[0].matches, ["https://zvena.app/clipper/connected*"]);
    assert.equal(m.default_locale, "en");
    assert.ok(m.commands._execute_action && m.commands["save-page"]);
  }
  const c = makeManifest({ browser: "chrome", version: "1" });
  assert.deepEqual(c.background, { service_worker: "background.js" });
  assert.equal(c.browser_specific_settings, undefined);
  const f = makeManifest({ browser: "firefox", version: "1" });
  assert.deepEqual(f.background, { scripts: ["background.js"] });
  assert.equal(f.browser_specific_settings.gecko.id, "web-clipper@zvena.app");
  assert.ok(Array.isArray(f.browser_specific_settings.gecko.data_collection_permissions.required));
  const tst = makeManifest({ browser: "chrome", version: "1", server: "http://127.0.0.1:3955" });
  assert.deepEqual(tst.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(tst.content_scripts[0].matches, ["http://127.0.0.1/clipper/connected*"]);
  assert.equal(DEFAULT_SERVER, "https://zvena.app");
  assert.throws(() => makeManifest({ browser: "safari", version: "1" }));
});

test("locales: every language has every message; store limits; no country names", () => {
  const dir = join(root, "src/_locales");
  const en = JSON.parse(readFileSync(join(dir, "en/messages.json"), "utf8"));
  const locales = readdirSync(dir);
  for (const want of ["en", "zh_CN", "hi", "es", "ar", "fr", "bn", "pt_BR", "pt_PT", "ru", "id"]) assert.ok(locales.includes(want), want);
  for (const loc of locales) {
    const m = JSON.parse(readFileSync(join(dir, loc, "messages.json"), "utf8"));
    assert.deepEqual(Object.keys(m).sort(), Object.keys(en).sort(), loc);
    for (const [k, v] of Object.entries(m)) assert.ok(typeof v.message === "string" && v.message.trim(), `${loc}.${k}`);
    assert.ok(m.extName.message.length <= 75, `${loc} name`);
    assert.ok(m.extDescription.message.length <= 132, `${loc} description: ${m.extDescription.message.length}`);
    assert.ok(m.extName.message.includes("zvena"), `${loc} keeps the brand`);
    assert.doesNotMatch(JSON.stringify(m), /Russia|Росси/i);
  }
});

test("zip: CRC-32 and an archive that inflates back", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const files = [
    { name: "b.txt", data: Buffer.from("hello hello hello hello") },
    { name: "a/ü.json", data: Buffer.from("{}") },
  ];
  const z = zip(files);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
  assert.equal(z.readUInt16LE(z.length - 22 + 10), 2);
  // Walk the local entries: sorted names, contents intact.
  let off = 0;
  const seen = [];
  while (z.readUInt32LE(off) === 0x04034b50) {
    const method = z.readUInt16LE(off + 8);
    const size = z.readUInt32LE(off + 18);
    const nameLen = z.readUInt16LE(off + 26);
    const name = z.subarray(off + 30, off + 30 + nameLen).toString("utf8");
    const body = z.subarray(off + 30 + nameLen, off + 30 + nameLen + size);
    const data = method === 8 ? inflateRawSync(body) : body;
    assert.equal(crc32(data), z.readUInt32LE(off + 14));
    seen.push([name, data.toString()]);
    off += 30 + nameLen + size;
  }
  assert.deepEqual(seen, [
    ["a/ü.json", "{}"],
    ["b.txt", "hello hello hello hello"],
  ]);
  assert.deepEqual(zip(files), zip([...files].reverse()));
});
