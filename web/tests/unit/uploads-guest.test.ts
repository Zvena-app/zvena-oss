import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { guestMayUpload, looksLikeImage, notesFilesDir } from "@/lib/notes/files";
import { createReport, parseTarget, resolveReport } from "@/lib/reports";
import { cleanupGuests, isRemovedFile, newGuestId, recordFile, touchGuest } from "@/lib/storage";
import { sql, store } from "@/lib/store";
import { personalWorkspace } from "@/lib/workspaces";

const DAY = 86_400_000;
const H = { origin: "http://localhost:3100", host: "localhost:3100" };

/** A PNG of random pixels. */
async function noisePng(w: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp(randomBytes(w * w * 3), { raw: { width: w, height: w, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer());
}

/** About 600 KB that pass as a GIF (GIFs are stored as they are, so the size is exact). */
const bigGif = () => new Uint8Array(Buffer.concat([Buffer.from("GIF89a"), randomBytes(600_000)]));

function person(name: string): { id: string; cookie: string; ws: string } {
  const r = signInWith({ provider: "dev", subject: `upl-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  const id = r.ok ? r.user.id : "";
  return { id, cookie: `${sessionCookieName()}=${issueSession(id)}`, ws: personalWorkspace(id, name).id };
}

async function upload(opts: { bytes: Uint8Array; name: string; type: string; cookie?: string; ip?: string; ws?: string }) {
  const { POST } = await import("@/app/api/notes/upload/route");
  const res = await POST(
    new Request(`http://localhost:3100/api/notes/upload${opts.ws ? `?ws=${opts.ws}` : ""}`, {
      method: "POST",
      headers: { ...H, "content-type": opts.type, "x-file-name": encodeURIComponent(opts.name), "x-real-ip": opts.ip ?? "198.51.100.7", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      body: Buffer.from(opts.bytes),
    })
  );
  const body = (await res.json()) as { url?: string; error?: string; signIn?: boolean };
  return { status: res.status, body, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function serve(url: string, headers: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/notes/file/[name]/route");
  const u = new URL(url, "http://localhost:3100");
  const name = u.pathname.split("/").pop() as string;
  return GET(new Request(u, { headers }), { params: Promise.resolve({ name }) });
}

test("files: guests may add raster pictures only, and the bytes must really be a picture", async () => {
  for (const ext of ["png", "jpg", "gif", "webp", "avif", "heic"]) assert.equal(guestMayUpload(ext), true, ext);
  for (const ext of ["svg", "pdf", "zip", "docx", "doc", "xls", "txt", "html", "mp4", "json"]) assert.equal(guestMayUpload(ext), false, ext);
  assert.equal(looksLikeImage(await noisePng(4), "png"), true);
  assert.equal(looksLikeImage(Buffer.from("PK\u0003\u0004 a zip archive"), "png"), false);
  assert.equal(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "jpg"), true);
  assert.equal(looksLikeImage(Buffer.from("GIF89a...."), "gif"), true);
  assert.equal(looksLikeImage(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "), "webp"), true);
});

test("guest uploads: pictures work (the Docs demo), anything else asks to sign in", async () => {
  const png = await noisePng(16);
  const ok = await upload({ bytes: png, name: "photo.png", type: "image/png" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.cookie ?? "", /^zv_g=[0-9a-f]{32}$/, "a guest cookie is set");
  const shown = await serve(ok.body.url as string);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-disposition"), null, "pictures open in place");
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff");

  for (const [name, type, bytes] of [
    ["report.pdf", "application/pdf", Buffer.from("%PDF-1.7 fake")],
    ["tool.zip", "application/zip", Buffer.from("PK\u0003\u0004zip")],
    ["sheet.xls", "application/vnd.ms-excel", Buffer.from("xls")],
    ["logo.svg", "image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")],
  ] as const) {
    const r = await upload({ bytes, name, type, cookie: ok.cookie });
    assert.equal(r.status, 401, name);
    assert.equal(r.body.signIn, true, `${name}: the editor is told to sign in`);
  }
  const disguised = await upload({ bytes: Buffer.from("PK\u0003\u0004 not a picture at all"), name: "cat.png", type: "image/png", cookie: ok.cookie });
  assert.deepEqual([disguised.status, disguised.body.signIn], [415, true], "an archive renamed .png is refused");
});

test("guest uploads: a small allowance per guest, per network and per day for the whole server", async () => {
  const keep = { a: process.env.ZVENA_GUEST_UPLOAD_MB, b: process.env.ZVENA_GUEST_UPLOAD_MB_PER_IP, c: process.env.ZVENA_GUEST_UPLOAD_MB_PER_DAY };
  try {
    process.env.ZVENA_GUEST_UPLOAD_MB = "1";
    process.env.ZVENA_GUEST_UPLOAD_MB_PER_IP = "1";
    process.env.ZVENA_GUEST_UPLOAD_MB_PER_DAY = "1000";
    const ip = "192.0.2.50";
    const first = await upload({ bytes: bigGif(), name: "a.gif", type: "image/gif", ip });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // Same guest: over the 1 MB allowance.
    const second = await upload({ bytes: bigGif(), name: "b.gif", type: "image/gif", ip, cookie: first.cookie });
    assert.deepEqual([second.status, second.body.error, second.body.signIn], [507, "guest quota", true]);
    // Dropping the cookie does not help: the network has used its day.
    const fresh = await upload({ bytes: bigGif(), name: "c.gif", type: "image/gif", ip });
    assert.deepEqual([fresh.status, fresh.body.error], [507, "guest uploads paused"]);
    // Neither does rotating IPv6 addresses inside one /64.
    process.env.ZVENA_GUEST_UPLOAD_MB_PER_IP = "1";
    assert.equal((await upload({ bytes: bigGif(), name: "d.gif", type: "image/gif", ip: "2001:db8:5:5::1" })).status, 200);
    assert.equal((await upload({ bytes: bigGif(), name: "e.gif", type: "image/gif", ip: "2001:db8:5:5::2" })).status, 507);
    // The server-wide cap holds for everyone.
    process.env.ZVENA_GUEST_UPLOAD_MB = "20";
    process.env.ZVENA_GUEST_UPLOAD_MB_PER_IP = "60";
    process.env.ZVENA_GUEST_UPLOAD_MB_PER_DAY = "1";
    const capped = await upload({ bytes: bigGif(), name: "f.gif", type: "image/gif", ip: "198.51.100.99" });
    assert.deepEqual([capped.status, capped.body.error], [507, "guest uploads paused"]);
    // An account is not limited by the guest caps.
    const u = person("cap");
    assert.equal((await upload({ bytes: bigGif(), name: "g.gif", type: "image/gif", ip: "198.51.100.99", cookie: u.cookie, ws: u.ws })).status, 200);
  } finally {
    for (const [k, v] of [["ZVENA_GUEST_UPLOAD_MB", keep.a], ["ZVENA_GUEST_UPLOAD_MB_PER_IP", keep.b], ["ZVENA_GUEST_UPLOAD_MB_PER_DAY", keep.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("guest files expire by upload age: visits do not keep them forever", async () => {
  const g = newGuestId();
  const name = `${randomBytes(20).toString("hex")}.png`;
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(notesFilesDir(), { recursive: true });
  writeFileSync(join(notesFilesDir(), name), "x");
  recordFile({ kind: "guest", id: g }, name, 1);
  const uploaded = Date.now() - 31 * DAY;
  sql("UPDATE files SET created_at = ? WHERE owner_id = ?").run(uploaded, g);
  // The guest pings every day: the removal date is still upload + TTL.
  const t = touchGuest(g);
  assert.equal(t.removeAt, uploaded + 30 * DAY);
  await cleanupGuests();
  assert.equal(existsSync(join(notesFilesDir(), name)), false, "removed although the guest was seen today");
  assert.equal(sql("SELECT COUNT(*) AS n FROM files WHERE owner_id = ?").get(g)?.n, 0);
});

test("serving: only pictures open in place; PDFs show only inside our own pages; download names keep the type", async () => {
  const u = person("serve");
  const pdf = await upload({ bytes: Buffer.from(`%PDF-1.4 ${randomBytes(8).toString("hex")}`), name: "Plan.pdf", type: "application/pdf", cookie: u.cookie, ws: u.ws });
  assert.equal(pdf.status, 200);
  const opened = await serve(pdf.body.url as string);
  assert.match(opened.headers.get("content-disposition") ?? "", /^attachment/, "a followed link downloads the PDF");
  assert.match(opened.headers.get("content-security-policy") ?? "", /sandbox/);
  const framed = await serve(pdf.body.url as string, { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" });
  assert.equal(framed.headers.get("content-disposition"), null, "the PDF block still shows it");
  assert.match(framed.headers.get("vary") ?? "", /sec-fetch-dest/);
  const elsewhere = await serve(pdf.body.url as string, { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" });
  assert.match(elsewhere.headers.get("content-disposition") ?? "", /^attachment/, "another site cannot frame it in place");

  const doc = await upload({ bytes: Buffer.from(`notes ${randomBytes(8).toString("hex")}`), name: "notes.txt", type: "text/plain", cookie: u.cookie, ws: u.ws });
  const txt = await serve(doc.body.url as string);
  assert.match(txt.headers.get("content-disposition") ?? "", /^attachment/, "text downloads too");
  assert.equal(txt.headers.get("x-content-type-options"), "nosniff");
  assert.match(txt.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);

  const png = await upload({ bytes: await noisePng(8), name: "p.png", type: "image/png", cookie: u.cookie, ws: u.ws });
  const renamed = await serve(`${png.body.url}?download=invoice.exe`);
  assert.match(renamed.headers.get("content-disposition") ?? "", /filename="invoice\.exe\.png"/);
});

test("reports: an uploaded file can be reported; taking it down deletes and blocks it", async () => {
  const u = person("reported");
  const png = await noisePng(12);
  const up = await upload({ bytes: png, name: "bad.png", type: "image/png", cookie: u.cookie, ws: u.ws });
  const name = (up.body.url as string).split("/").pop() as string;
  const t = parseTarget(`https://zvena.app/api/notes/file/${name}`);
  assert.deepEqual(t, { kind: "file", target: name });
  assert.equal(parseTarget("https://zvena.app/api/notes/file/../../etc"), null);

  // Through the public report endpoint.
  const { POST: report } = await import("@/app/api/report/route");
  const rr = await report(new Request("http://localhost:3100/api/report", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ url: `http://localhost:3100${up.body.url}`, reason: "fraud" }) }));
  assert.equal(rr.status, 200);
  const id = (sql("SELECT id FROM reports WHERE kind = 'file' AND target = ?").get(name) as { id: string }).id;
  assert.equal(await resolveReport(id, "mod-1", "removed", "malware"), true);
  assert.equal(existsSync(join(notesFilesDir(), name)), false, "deleted from disk");
  assert.equal(sql("SELECT COUNT(*) AS n FROM files WHERE name = ?").get(name)?.n, 0);
  assert.equal(isRemovedFile(name), true);
  assert.equal((await serve(`/api/notes/file/${name}`)).status, 451);
  const again = await upload({ bytes: png, name: "again.png", type: "image/png", cookie: u.cookie, ws: u.ws });
  assert.equal(again.status, 451, "the same content cannot come back");
  assert.ok(createReport({ kind: "file", target: name, reason: "spam", details: "", contact: "", reporterId: null }));
});

test("admin: a moderator deletes a file directly; others get 404", async () => {
  const owner = person("owner-f");
  const mod = person("moderator-f");
  sql("UPDATE users SET is_admin = 1 WHERE id = ?").run(mod.id);
  const up = await upload({ bytes: await noisePng(10), name: "x.png", type: "image/png", cookie: owner.cookie, ws: owner.ws });
  const name = (up.body.url as string).split("/").pop() as string;
  const { POST } = await import("@/app/api/admin/reports/route");
  const call = (cookie: string, body: unknown) => POST(new Request("http://localhost:3100/api/admin/reports", { method: "POST", headers: { ...H, cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await call(owner.cookie, { deleteFile: name })).status, 404);
  assert.equal(existsSync(join(notesFilesDir(), name)), true);
  assert.equal((await call(mod.cookie, { deleteFile: "https://example.com/not-a-file" })).status, 400);
  const r = await call(mod.cookie, { deleteFile: `http://localhost:3100${up.body.url}` });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, removed: 1 });
  assert.equal(existsSync(join(notesFilesDir(), name)), false);
  assert.equal((await serve(up.body.url as string)).status, 451);
});

test("migration: an older reports table learns the 'file' kind and keeps its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "zvena-reports-"));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'form', 'design')),
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  reporter_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'removed', 'rejected')),
  resolved_by TEXT,
  resolved_at INTEGER,
  resolution TEXT NOT NULL DEFAULT ''
);
INSERT INTO reports (id, kind, target, reason, created_at) VALUES ('r1', 'page', 'p1', 'spam', 1);`);
  old.close();
  const keep = process.env.ZVENA_DB_PATH;
  process.env.ZVENA_DB_PATH = path;
  try {
    const d = store();
    assert.equal((d.prepare("SELECT target FROM reports WHERE id = 'r1'").get() as { target: string }).target, "p1");
    d.prepare("INSERT INTO reports (id, kind, target, reason, created_at) VALUES ('r2', 'file', 'f', 'spam', 2)").run();
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number }).n, 2);
  } finally {
    process.env.ZVENA_DB_PATH = keep;
    store();
  }
});

test("public forms and pages: the Report abuse link's target is understood by the report endpoint", () => {
  // PublicForm links "/report?url=/f/<id>" (the same on the server and in the browser; checked in e2e docs-server 3b').
  assert.deepEqual(parseTarget("/f/Form1234567"), { kind: "form", target: "Form1234567" });
  assert.deepEqual(parseTarget(`https://zvena.app/n/${"s".repeat(20)}`), { kind: "page", target: "s".repeat(20) });
});
