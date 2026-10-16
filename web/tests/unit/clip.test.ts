import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { issueSession, signInWith } from "@/lib/auth";
import { clipperConnections, clipperUser, issueClipperCode, pkceChallenge, redeemClipperCode, revokeAllClippers } from "@/lib/clipper";
import { grant, setRestricted } from "@/lib/notes/access";
import { CLIP_LIMITS, clipDestinations, defaultClipDeps, saveClip, sniffImage, validClipRequest, type ClipDeps, type ClipRequest } from "@/lib/notes/clip";
import { absoluteUrl, htmlToBlocks, parseHtml, srcsetBest } from "@/lib/notes/html-blocks";
import { blankNote, blocksText } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";
import * as clipRoute from "@/app/api/notes/clip/route";
import * as tokenRoute from "@/app/api/clipper/token/route";
import * as authorizeRoute from "@/app/api/clipper/authorize/route";
import * as destRoute from "@/app/api/clipper/destinations/route";
import * as meRoute from "@/app/api/clipper/me/route";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `clip-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
}

function team() {
  const olga = person("Olga");
  const anna = person("Anna");
  const vova = person("Vova");
  const kira = person("Kira");
  const ws = createWorkspace(olga, `Clip team ${n}`).id;
  assert.ok(acceptInvite(anna, createInvite(olga, ws, "editor").token));
  assert.ok(acceptInvite(vova, createInvite(olga, ws, "viewer").token));
  assert.ok(acceptInvite(kira, createInvite(olga, ws, "commenter").token));
  return { ws, olga, anna, vova, kira };
}

const push = (ws: string, by: string, notes: Note[]) => pushNotes(ws, notes.map((x) => ({ id: x.id, note: x })), { by, quotaLeft: Infinity, author: by, access: { userId: by } });
const stored = (ws: string, id: string): Note | null => {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string } | undefined;
  return r ? (JSON.parse(r.json) as Note) : null;
};

/** No network: pictures "download" from a table, storage is a list. */
function fakeDeps(images: Record<string, Uint8Array>): ClipDeps & { fetched: string[]; saved: number } {
  const deps = {
    fetched: [] as string[],
    saved: 0,
    async fetchImage(url: string) {
      deps.fetched.push(url);
      return images[url] ? { body: images[url], contentType: "image/png" } : null;
    },
    async storeImage() {
      deps.saved++;
      return `/api/notes/file/${randomBytes(20).toString("hex")}.png`;
    },
  };
  return deps;
}

// A 1×1 PNG.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

const req = (r: Partial<ClipRequest> & Pick<ClipRequest, "ws" | "target">): ClipRequest => ({ mode: "article", url: "https://example.com/post/1", title: "A post", html: "<p>Hello <b>world</b></p>", ...r });

// ---------------------------------------------------------------------------
// HTML → blocks

test("html-blocks: headings, styles, links resolved against the page, lists, quotes, code, tables", () => {
  let i = 0;
  const blocks = htmlToBlocks(
    `<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em> <a href="/about">about</a> <a href="javascript:alert(1)">bad</a></p>
     <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol><li><p>first</p></li></ol>
     <blockquote><p>quoted</p></blockquote><pre><code class="language-ts">const a = 1;\n  b();</code></pre>
     <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><hr>`,
    { base: "https://example.com/post/1", newId: () => `b${++i}` }
  );
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ["heading", "paragraph", "bulletListItem", "bulletListItem", "numberedListItem", "quote", "codeBlock", "table", "divider"]);
  assert.equal(blocks[0].props.level, 1);
  const p = blocks[1].content as { type: string; text?: string; href?: string; styles?: Record<string, boolean>; content?: { text: string }[] }[];
  assert.deepEqual(p.find((x) => x.text === "bold")?.styles, { bold: true });
  assert.equal(p.find((x) => x.type === "link")?.href, "https://example.com/about");
  // javascript: never becomes a link; its text stays.
  assert.equal(p.filter((x) => x.type === "link").length, 1);
  assert.ok(blocksText([blocks[1]]).includes("bad"));
  assert.equal(blocks[3].children?.[0].type, "bulletListItem");
  assert.equal((blocks[6].props as { language: string }).language, "ts");
  assert.equal(((blocks[6].content as { text: string }[])[0]).text, "const a = 1;\n  b();");
  const table = blocks[7].content as { headerRows?: number; rows: { cells: unknown[][] }[] };
  assert.equal(table.headerRows, 1);
  assert.equal(table.rows.length, 2);
});

test("html-blocks: scripts, styles, forms, frames and event handlers never pass", () => {
  const blocks = htmlToBlocks(
    `<script>alert(1)</script><style>p{}</style><p onclick="steal()">safe <img src=x onerror=alert(1)></p><form><input value=secret></form><iframe src="https://evil.example/"></iframe><svg><script>1</script></svg><p>end</p>`,
    { base: "https://example.com/" }
  );
  const json = JSON.stringify(blocks);
  assert.ok(!/alert|steal|secret|onerror|onclick|evil/.test(json), json);
  assert.ok(json.includes("safe") && json.includes("end"));
  // The broken picture resolved against the page is still only an https address.
  const img = blocks.find((b) => b.type === "image");
  assert.equal(img?.props.url, "https://example.com/x");
});

test("html-blocks: whitespace collapses, line breaks stay, pictures leave paragraphs in order, YouTube embeds", () => {
  const blocks = htmlToBlocks(`<p>  one\n   two<br>three  </p><p>before <img src="https://cdn.example/a.png" alt="A"> after</p><figure><img srcset="https://cdn.example/s.png 300w, https://cdn.example/l.png 1200w"><figcaption>Cap</figcaption></figure><iframe src="https://www.youtube.com/embed/x"></iframe>`);
  assert.equal((blocks[0].content as { text: string }[]).map((x) => x.text).join(""), "one two\nthree");
  assert.deepEqual(
    blocks.slice(1, 4).map((b) => b.type),
    ["paragraph", "image", "paragraph"]
  );
  assert.equal(blocks[2].props.name, "A");
  const fig = blocks.find((b) => b.props.url === "https://cdn.example/l.png");
  assert.equal(fig?.props.caption, "Cap");
  assert.equal(blocks.at(-1)?.type, "embed");
});

test("html-blocks: bounded (blocks, depth) and forgiving with broken markup", () => {
  const many = "<p>x</p>".repeat(5000);
  assert.equal(htmlToBlocks(many, { maxBlocks: 100 }).length, 100);
  const deep = "<div>".repeat(5000) + "deep" + "</div>".repeat(5000);
  assert.ok(htmlToBlocks(deep).length <= 1);
  assert.ok(parseHtml("<p>unclosed <b>bold <i>both").length > 0);
  assert.equal(absoluteUrl("//cdn.example/x", "https://a.example/"), "https://cdn.example/x");
  assert.equal(absoluteUrl("data:text/html,<script>", "https://a.example/"), "");
  assert.equal(absoluteUrl("https://user:pw@a.example/", undefined), "");
  assert.equal(srcsetBest("a.png 1x, b.png 2x"), "b.png");
});

test("html-blocks: hostile markup stays linear (no rescans from every '<')", () => {
  const big = 2_000_000;
  for (const unit of ["<a", "<!", "<?", '<a "', "<a '", "</a ", "<p x=", "<<<<"]) {
    const html = unit.repeat(Math.floor(big / unit.length));
    const t0 = Date.now();
    htmlToBlocks(html, { maxBlocks: 100 });
    assert.ok(Date.now() - t0 < 4000, `${JSON.stringify(unit)} took ${Date.now() - t0} ms`);
  }
  // A quoted ">" inside an attribute does not end the tag.
  const [img] = htmlToBlocks(`<img alt="a > b" src="https://x.example/i.png">`);
  assert.equal(img.props.name, "a > b");
});

test("clip: requests are validated (modes, targets, sizes, addresses)", () => {
  const ws = "abcdefgh12";
  assert.ok(validClipRequest({ ws, target: { type: "private" }, mode: "bookmark", url: "https://example.com" }));
  assert.equal(validClipRequest({ ws, target: { type: "private" }, mode: "bookmark", url: "javascript:alert(1)" }), null);
  assert.equal(validClipRequest({ ws, target: { type: "private" }, mode: "article", url: "file:///etc/passwd", html: "<p>x</p>" }), null);
  assert.equal(validClipRequest({ ws, target: { type: "page", id: "../../x" }, mode: "text", text: "x" }), null);
  assert.equal(validClipRequest({ ws, target: { type: "private" }, mode: "nope", url: "https://example.com" }), null);
  assert.equal(validClipRequest({ ws, target: { type: "private" }, mode: "article", url: "https://example.com", html: "x".repeat(CLIP_LIMITS.htmlChars + 1) }), null);
  const v = validClipRequest({ ws, target: { type: "private" }, mode: "article", url: "https://example.com/a", html: "<p>x</p>", cover: "/img.png", favicon: "javascript:x" });
  assert.equal(v?.cover, "https://example.com/img.png");
  assert.equal(v?.favicon, undefined);
  assert.equal(sniffImage(PNG), "png");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")), null);
});

// ---------------------------------------------------------------------------
// Saving: access and what lands

test("clip: Private, under a page, into a database (URL property); pictures stored or kept as links", async () => {
  const t = team();
  const page = blankNote({ kind: "page", parentId: null, title: "Reading" });
  const db = blankNote({
    kind: "database",
    parentId: null,
    title: "Links",
    db: { properties: [{ id: "title", name: "Name", type: "title" }, { id: "u1", name: "URL", type: "url" }], views: [{ id: "v", name: "Table", type: "table", filters: [], sorts: [], hidden: [], widths: {} }] },
  });
  assert.equal(push(t.ws, t.anna, [page, db]).saved.length, 2);

  const deps = fakeDeps({ "https://cdn.example/ok.png": PNG });
  const html = `<p>Text</p><img src="https://cdn.example/ok.png"><img src="https://cdn.example/missing.png">`;
  const a = await saveClip(req({ ws: t.ws, target: { type: "private" }, html, cover: "https://cdn.example/ok.png" }), { id: t.anna, name: "Anna" }, deps);
  assert.ok(a.ok);
  const mine = stored(t.ws, a.id) as Note;
  assert.equal(mine.space, `private:${t.anna}`);
  assert.equal(mine.createdBy, t.anna);
  const imgs = (mine.content as { type: string; props: { url: string } }[]).filter((b) => b.type === "image").map((b) => b.props.url);
  assert.match(imgs[0], /^\/api\/notes\/file\//);
  assert.equal(imgs[1], "https://cdn.example/missing.png");
  assert.match(mine.cover?.value ?? "", /^\/api\/notes\/file\//);
  // The first line links back to the page.
  assert.equal((mine.content[0] as { content: { href: string }[] }).content[0].href, "https://example.com/post/1");

  const b = await saveClip(req({ ws: t.ws, target: { type: "page", id: page.id }, mode: "bookmark", html: undefined }), { id: t.anna, name: "Anna" }, deps);
  assert.ok(b.ok);
  assert.equal(stored(t.ws, b.id)?.parentId, page.id);
  // The parent shows it in its body, as the app places a sub-page.
  assert.ok((stored(t.ws, page.id)?.content as { type: string; props: { noteId: string } }[]).some((x) => x.type === "page" && x.props.noteId === b.id));

  const c = await saveClip(req({ ws: t.ws, target: { type: "database", id: db.id } }), { id: t.anna, name: "Anna" }, deps);
  assert.ok(c.ok);
  const row = stored(t.ws, c.id) as Note;
  assert.equal(row.parentId, db.id);
  assert.equal(row.props?.u1, "https://example.com/post/1");
  assert.equal(row.title, "A post");
});

test("clip: only where the person may edit — viewers, commenters, restricted pages, other workspaces, wrong kinds", async () => {
  const t = team();
  const page = blankNote({ kind: "page", parentId: null, title: "Team page" });
  const secret = blankNote({ kind: "page", parentId: null, title: "HR" });
  assert.equal(push(t.ws, t.olga, [page, secret]).saved.length, 2);
  setRestricted(t.ws, secret.id, true, t.olga);
  const deps = fakeDeps({});
  const to = (target: ClipRequest["target"], who: string) => saveClip(req({ ws: t.ws, target }), { id: who, name: who }, deps);

  assert.deepEqual(await to({ type: "page", id: page.id }, t.vova), { ok: false, status: 403, error: "forbidden" });
  assert.deepEqual(await to({ type: "page", id: page.id }, t.kira), { ok: false, status: 403, error: "forbidden" });
  assert.deepEqual(await to({ type: "private" }, t.vova), { ok: false, status: 403, error: "forbidden" });
  // A page the person cannot see is "not found" (its existence is not confirmed).
  assert.deepEqual(await to({ type: "page", id: secret.id }, t.anna), { ok: false, status: 404, error: "not found" });
  assert.deepEqual(await to({ type: "database", id: page.id }, t.anna), { ok: false, status: 404, error: "not found" });
  const outsider = person("Mallory");
  assert.deepEqual(await to({ type: "page", id: page.id }, outsider), { ok: false, status: 403, error: "forbidden" });
  // A viewer given edit on one page may clip under it.
  grant(t.ws, page.id, t.vova, "edit", t.olga);
  assert.ok((await to({ type: "page", id: page.id }, t.vova)).ok);
  // A trashed page is not a place.
  const gone = blankNote({ kind: "page", parentId: null, title: "Old", trashedAt: Date.now() });
  push(t.ws, t.anna, [gone]);
  assert.equal((await to({ type: "page", id: gone.id }, t.anna)).ok, false);
  // Nothing was downloaded for the refused clips.
  assert.equal(deps.saved, 0);
});

test("clip: pictures on private addresses are never fetched (SSRF guard) and stay links", async () => {
  const t = team();
  const html = ["http://127.0.0.1/a.png", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/x.png", "http://localhost/x.png", "http://[::1]/x.png", "http://example.com:8080/x.png"].map((u) => `<img src="${u}">`).join("");
  const r = await saveClip(req({ ws: t.ws, target: { type: "private" }, html }), { id: t.anna, name: "Anna" }, defaultClipDeps);
  assert.ok(r.ok);
  const urls = ((stored(t.ws, r.id) as Note).content as { type: string; props: { url: string } }[]).filter((b) => b.type === "image").map((b) => b.props.url);
  assert.equal(urls.length, 6);
  assert.ok(urls.every((u) => !u.startsWith("/api/notes/file/")));
  const files = sql("SELECT COUNT(*) AS n FROM files WHERE owner_id = ?").get(t.olga) as { n: number };
  assert.equal(Number(files.n), 0);
});

test("clip: a huge article is cut to fit one page", async () => {
  const t = team();
  const html = `<p>${"word ".repeat(3000)}</p>`.repeat(300);
  const r = await saveClip(req({ ws: t.ws, target: { type: "private" }, html, images: "link" }), { id: t.anna, name: "Anna" }, fakeDeps({}));
  assert.ok(r.ok);
  const note = stored(t.ws, r.id) as Note;
  assert.ok(Buffer.byteLength(JSON.stringify(note)) <= CLIP_LIMITS.noteBytes);
  assert.ok(note.content.length > 10);
});

test("clip destinations: titles of pages and databases the person may add to; no rows, trash or restricted pages", () => {
  const t = team();
  const db = blankNote({ kind: "database", parentId: null, title: "Reading list", db: { properties: [{ id: "title", name: "Name", type: "title" }], views: [] } });
  const row = blankNote({ kind: "page", parentId: db.id, title: "Reading row" });
  const sub = blankNote({ kind: "page", parentId: null, title: "Reading notes" });
  const child = blankNote({ kind: "page", parentId: sub.id, title: "Reading child" });
  const hr = blankNote({ kind: "page", parentId: null, title: "Reading HR" });
  const trashed = blankNote({ kind: "page", parentId: null, title: "Reading old", trashedAt: Date.now() });
  push(t.ws, t.olga, [db, row, sub, child, hr, trashed]);
  setRestricted(t.ws, hr.id, true, t.olga);
  const titles = clipDestinations(t.ws, t.anna, "reading").map((d) => d.title).sort();
  assert.deepEqual(titles, ["Reading child", "Reading list", "Reading notes"]);
  assert.equal(clipDestinations(t.ws, t.anna, "child")[0].path, "Reading notes");
  assert.equal(clipDestinations(t.ws, t.anna, "reading").find((d) => d.title === "Reading list")?.kind, "database");
  // A viewer may add nowhere; the owner sees the restricted page too; "%" is a letter, not a wildcard.
  assert.equal(clipDestinations(t.ws, t.vova, "reading").length, 0);
  assert.ok(clipDestinations(t.ws, t.olga, "reading").some((d) => d.title === "Reading HR"));
  assert.equal(clipDestinations(t.ws, t.anna, "%").length, 0);
  assert.equal(clipDestinations(t.ws, person("Out"), "").length, 0);
});

// ---------------------------------------------------------------------------
// Tokens and routes

const verifier = () => randomBytes(48).toString("base64url");

test("clipper tokens: the code works once, only with its verifier, only in time", () => {
  const u = person("Tess");
  const v = verifier();
  const code = issueClipperCode(u, pkceChallenge(v), "chrome");
  assert.equal(redeemClipperCode(code, verifier()), null, "another verifier");
  // The failed try burnt the code.
  assert.equal(redeemClipperCode(code, v), null);
  const v2 = verifier();
  const code2 = issueClipperCode(u, pkceChallenge(v2), "firefox");
  const issued = redeemClipperCode(code2, v2);
  assert.ok(issued);
  assert.match(issued.token, /^zvc_[A-Za-z0-9_-]{43}$/);
  assert.equal(clipperUser(issued.token)?.user.id, u);
  assert.equal(redeemClipperCode(code2, v2), null, "a code is single-use");
  const v3 = verifier();
  const old = issueClipperCode(u, pkceChallenge(v3), "chrome", Date.now() - 10 * 60_000);
  assert.equal(redeemClipperCode(old, v3), null, "expired");
  // Kept only as an HMAC.
  assert.equal(sql("SELECT 1 FROM clipper_tokens WHERE hash = ?").get(issued.token), undefined);
  assert.equal(clipperConnections(u)[0].client, "firefox");
  assert.equal(revokeAllClippers(u), 1);
  assert.equal(clipperUser(issued.token), null);
});

function tokenFor(userId: string): string {
  const v = verifier();
  return (redeemClipperCode(issueClipperCode(userId, pkceChallenge(v), "chrome"), v) as { token: string }).token;
}

const BASE = "http://localhost:3100";
const post = (path: string, body: unknown, headers: Record<string, string>) => new Request(`${BASE}${path}`, { method: "POST", headers: { host: "localhost:3100", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("clip route: a token from an extension works; cookies need our origin; a foreign page is refused even with a token", async () => {
  const t = team();
  const token = tokenFor(t.anna);
  const body = { ws: t.ws, target: { type: "private" }, mode: "bookmark", url: "https://example.com/x", title: "X" };
  const ok = await clipRoute.POST(post("/api/notes/clip", body, { authorization: `Bearer ${token}`, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }));
  assert.equal(ok.status, 200);
  const j = (await ok.json()) as { id: string; url: string };
  assert.ok(stored(t.ws, j.id));
  assert.ok(j.url.startsWith("http://localhost:3100/docs?ws="));
  // A web page of another site, with a stolen token.
  assert.equal((await clipRoute.POST(post("/api/notes/clip", body, { authorization: `Bearer ${token}`, origin: "https://evil.example" }))).status, 403);
  assert.equal((await clipRoute.POST(post("/api/notes/clip", body, { authorization: "Bearer zvc_nope" }))).status, 401);
  const session = `zv_s=${issueSession(t.anna)}`;
  // The session cookie from another site (CSRF) — refused; from our own page — saved.
  assert.equal((await clipRoute.POST(post("/api/notes/clip", body, { cookie: session, origin: "https://evil.example" }))).status, 403);
  assert.equal((await clipRoute.POST(post("/api/notes/clip", body, { cookie: session, origin: BASE }))).status, 200);
  // The cookie never stands in for a bad token.
  assert.equal((await clipRoute.POST(post("/api/notes/clip", body, { cookie: session, origin: BASE, authorization: "Bearer zvc_nope" }))).status, 401);
  // Too large, malformed.
  assert.equal((await clipRoute.POST(post("/api/notes/clip", { ...body, mode: "article", html: "x".repeat(CLIP_LIMITS.bodyBytes) }, { authorization: `Bearer ${token}` }))).status, 413);
  assert.equal((await clipRoute.POST(post("/api/notes/clip", { ...body, target: { type: "page", id: "x" } }, { authorization: `Bearer ${token}` }))).status, 400);
});

test("clipper routes: authorize needs our signed-in page; token exchange; me and destinations by token", async () => {
  const t = team();
  const v = verifier();
  const session = `zv_s=${issueSession(t.anna)}`;
  const authBody = { state: randomBytes(16).toString("base64url"), challenge: pkceChallenge(v), client: "edge" };
  assert.equal((await authorizeRoute.POST(post("/api/clipper/authorize", authBody, { cookie: session, origin: "https://evil.example" }))).status, 403);
  assert.equal((await authorizeRoute.POST(post("/api/clipper/authorize", authBody, { origin: BASE }))).status, 401);
  const a = await authorizeRoute.POST(post("/api/clipper/authorize", authBody, { cookie: session, origin: BASE }));
  assert.equal(a.status, 200);
  const { code } = (await a.json()) as { code: string };
  assert.equal((await tokenRoute.POST(post("/api/clipper/token", { code, verifier: v }, { origin: "https://evil.example" }))).status, 403);
  const tr = await tokenRoute.POST(post("/api/clipper/token", { code, verifier: v }, { origin: "moz-extension://8c2b7d4e-1111-2222-3333-444455556666" }));
  assert.equal(tr.status, 200);
  const { token, user } = (await tr.json()) as { token: string; user: { id: string } };
  assert.equal(user.id, t.anna);
  const get = (path: string) => new Request(`${BASE}${path}`, { headers: { host: "localhost:3100", authorization: `Bearer ${token}` } });
  const me = (await (await meRoute.GET(get("/api/clipper/me"))).json()) as { workspaces: { id: string }[] };
  assert.ok(me.workspaces.some((w) => w.id === t.ws));
  const page = blankNote({ kind: "page", parentId: null, title: "Inbox of links" });
  push(t.ws, t.anna, [page]);
  const d = (await (await destRoute.GET(get(`/api/clipper/destinations?ws=${t.ws}&q=inbox`))).json()) as { results: { id: string }[] };
  assert.deepEqual(d.results.map((r) => r.id), [page.id]);
  assert.equal((await destRoute.GET(get(`/api/clipper/destinations?ws=${createWorkspace(t.olga, "Other").id}&q=`))).status, 403);
  // Disconnect from the extension.
  const del = await tokenRoute.DELETE(new Request(`${BASE}/api/clipper/token`, { method: "DELETE", headers: { host: "localhost:3100", authorization: `Bearer ${token}` } }));
  assert.equal(del.status, 200);
  assert.equal((await meRoute.GET(get("/api/clipper/me"))).status, 401);
});
