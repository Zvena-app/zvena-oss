import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { unzip, UNZIP_LIMITS, ZipError, type UnzipLimits } from "@/lib/notes/zip";
import { crc32, zipStore } from "@/lib/science/zip";

// Archives are built here byte by byte (stored or deflated, with headers that
// can lie) and the limits are shrunk to KBs, so nothing big is ever allocated.

interface Entry {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8 | 12;
  /** Declared sizes / CRC / flags (default: the real ones). */
  usize?: number;
  crc?: number;
  flags?: number;
}

function makeZip(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder();
  const files = entries.map((e) => {
    const name = enc.encode(e.name);
    const plain = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const method = e.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(plain)) : plain;
    return { name, body, method, usize: e.usize ?? plain.length, crc: e.crc ?? crc32(plain), flags: (e.flags ?? 0) | 0x0800 };
  });
  let size = 22;
  for (const f of files) size += 30 + f.name.length + f.body.length + 46 + f.name.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  const u16 = (v: number) => {
    dv.setUint16(p, v, true);
    p += 2;
  };
  const u32 = (v: number) => {
    dv.setUint32(p, v >>> 0, true);
    p += 4;
  };
  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(p);
    u32(0x04034b50);
    u16(20);
    u16(f.flags);
    u16(f.method);
    u32(0);
    u32(f.crc);
    u32(f.body.length);
    u32(f.usize);
    u16(f.name.length);
    u16(0);
    out.set(f.name, p);
    p += f.name.length;
    out.set(f.body, p);
    p += f.body.length;
  }
  const cd = p;
  files.forEach((f, i) => {
    u32(0x02014b50);
    u16(20);
    u16(20);
    u16(f.flags);
    u16(f.method);
    u32(0);
    u32(f.crc);
    u32(f.body.length);
    u32(f.usize);
    u16(f.name.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(offsets[i]);
    out.set(f.name, p);
    p += f.name.length;
  });
  const cdSize = p - cd;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(files.length);
  u16(files.length);
  u32(cdSize);
  u32(cd);
  u16(0);
  return out;
}

const KB = 1024;
const small = (over: Partial<UnzipLimits> = {}): Partial<UnzipLimits> => ({ maxFile: 16 * KB, maxNested: 64 * KB, maxTotal: 64 * KB, maxEntries: 50, maxDepth: 2, ...over });
const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);
const names = (r: { files: { name: string }[] }) => r.files.map((f) => f.name).sort();

test("zip import: stored and deflated entries read back; folders are not files", async () => {
  const zip = makeZip([
    { name: "Notes/", data: "", method: 0 },
    { name: "Notes/a.md", data: "# A\n\nhello", method: 8 },
    { name: "Notes/b.csv", data: "Name,Tag\nx,y\n", method: 0 },
  ]);
  const r = await unzip(zip, { limits: small() });
  assert.deepEqual(names(r), ["Notes/a.md", "Notes/b.csv"]);
  assert.equal(new TextDecoder().decode(r.files.find((f) => f.name === "Notes/a.md")?.data), "# A\n\nhello");
  assert.deepEqual(r.skipped, []);
  // The Science writer's archives (exports) still import.
  const own = await unzip(zipStore([{ name: "x.md", data: "x" }]));
  assert.deepEqual(names(own), ["x.md"]);
});

test("zip import: production limits bound the total and nested archives below it", () => {
  assert.ok(UNZIP_LIMITS.maxNested < UNZIP_LIMITS.maxTotal);
  assert.ok(UNZIP_LIMITS.maxFile < UNZIP_LIMITS.maxNested);
  assert.ok(UNZIP_LIMITS.maxTotal <= 1024 * 1024 * 1024);
  assert.ok(UNZIP_LIMITS.maxEntries > 0 && UNZIP_LIMITS.maxDepth >= 1 && UNZIP_LIMITS.maxDepth <= 3);
});

test("zip import: a truncated archive or a broken central directory is a clear ZipError", async () => {
  const zip = makeZip([{ name: "a.md", data: "hello world" }]);
  await assert.rejects(unzip(zip.subarray(0, zip.length - 10)), (e: unknown) => e instanceof ZipError && e.code === "not-zip");
  await assert.rejects(unzip(new Uint8Array(5)), (e: unknown) => e instanceof ZipError && e.code === "not-zip");
  // Central directory offset points past the end of central directory.
  const badOff = zip.slice();
  new DataView(badOff.buffer).setUint32(badOff.length - 6, badOff.length + 100, true);
  await assert.rejects(unzip(badOff), (e: unknown) => e instanceof ZipError && e.code === "corrupt");
  // Central directory record with a wrong signature.
  const badSig = zip.slice();
  const cd = new DataView(badSig.buffer).getUint32(badSig.length - 6, true);
  badSig[cd] = 0;
  await assert.rejects(unzip(badSig), (e: unknown) => e instanceof ZipError && e.code === "corrupt");
  // Entry count larger than the directory holds.
  const badCount = zip.slice();
  new DataView(badCount.buffer).setUint16(badCount.length - 12, 40, true);
  await assert.rejects(unzip(badCount), (e: unknown) => e instanceof ZipError && e.code === "corrupt");
});

test("zip import: a bad CRC, a broken deflate stream or a bad local header skips just that entry", async () => {
  const good = { name: "ok.md", data: "fine" };
  const zip = makeZip([{ name: "crc.md", data: "some text", crc: 1234 }, good, { name: "stored-crc.md", data: "abc", method: 0, crc: 99 }]);
  const r = await unzip(zip, { limits: small() });
  assert.deepEqual(names(r), ["ok.md"]);
  assert.deepEqual(r.skipped, [
    { name: "crc.md", reason: "corrupt" },
    { name: "stored-crc.md", reason: "corrupt" },
  ]);
  // Garbage instead of deflate data (the stream errors: no crash, no hang).
  const broken = makeZip([{ name: "junk.md", data: bytes(300, 0x41), method: 0, usize: 300 }, good]);
  new DataView(broken.buffer).setUint16(8, 8, true); // local: deflate
  const cd = new DataView(broken.buffer).getUint32(broken.length - 6, true);
  new DataView(broken.buffer).setUint16(cd + 10, 8, true); // central: deflate
  broken.fill(0xff, 30 + "junk.md".length, 30 + "junk.md".length + 300);
  const r2 = await unzip(broken, { limits: small() });
  assert.deepEqual(names(r2), ["ok.md"]);
  assert.deepEqual(r2.skipped, [{ name: "junk.md", reason: "corrupt" }]);
  // Local header offset pointing at nothing.
  const lost = makeZip([{ name: "a.md", data: "x" }, good]);
  const cd3 = new DataView(lost.buffer).getUint32(lost.length - 6, true);
  new DataView(lost.buffer).setUint32(cd3 + 42, lost.length - 3, true);
  const r3 = await unzip(lost, { limits: small() });
  assert.deepEqual(r3.skipped, [{ name: "a.md", reason: "corrupt" }]);
});

test("zip import: encrypted entries and unsupported methods are reported", async () => {
  const zip = makeZip([{ name: "secret.md", data: "x", flags: 1 }, { name: "lzma.md", data: "x", method: 12 }, { name: "ok.md", data: "y" }]);
  const r = await unzip(zip, { limits: small() });
  assert.deepEqual(names(r), ["ok.md"]);
  assert.deepEqual(r.skipped, [
    { name: "secret.md", reason: "encrypted" },
    { name: "lzma.md", reason: "unsupported" },
  ]);
});

test("zip import: files over maxFile and over the total budget are skipped before inflating", async () => {
  const zip = makeZip([
    { name: "big.png", data: bytes(20 * KB) }, // > maxFile 16 KB
    { name: "a.md", data: bytes(12 * KB) },
    { name: "b.md", data: bytes(12 * KB) },
    { name: "c.md", data: bytes(12 * KB) }, // 36 KB > maxTotal 32 KB
    { name: "d.md", data: bytes(4 * KB) }, // still fits
  ]);
  const r = await unzip(zip, { limits: small({ maxTotal: 32 * KB }) });
  assert.deepEqual(names(r), ["a.md", "b.md", "d.md"]);
  assert.deepEqual(r.skipped, [
    { name: "big.png", reason: "too-large" },
    { name: "c.md", reason: "budget" },
  ]);
  assert.equal(r.bytes, 28 * KB);
  assert.ok(r.bytes <= 32 * KB);
});

test("zip import: a lying header (declared small, inflates large) stops at the declared size", async () => {
  // 4 MB of zeros deflate to ~4 KB; the header claims 100 bytes.
  const bomb = bytes(4 * 1024 * KB, 0);
  const zip = makeZip([{ name: "bomb.md", data: bomb, usize: 100 }, { name: "ok.md", data: "fine" }]);
  const t0 = Date.now();
  const r = await unzip(zip, { limits: small() });
  assert.deepEqual(names(r), ["ok.md"]);
  assert.deepEqual(r.skipped, [{ name: "bomb.md", reason: "corrupt" }]);
  assert.ok(r.bytes <= 64 * KB, "inflated bytes stay within the budget");
  assert.ok(Date.now() - t0 < 5000);
  // Declared larger than it really is: also a mismatch, not a short file.
  const short = makeZip([{ name: "short.md", data: "abc", usize: 10 }]);
  assert.deepEqual((await unzip(short, { limits: small() })).skipped, [{ name: "short.md", reason: "corrupt" }]);
});

test("zip import: a suspicious compression ratio is refused before inflating", async () => {
  const zip = makeZip([{ name: "zeros.bin", data: bytes(64 * KB, 0) }, { name: "text.md", data: "plain" }]);
  const r = await unzip(zip, { limits: small({ maxFile: 128 * KB, maxTotal: 128 * KB, ratioFrom: 8 * KB, maxRatio: 20 }) });
  assert.deepEqual(names(r), ["text.md"]);
  assert.deepEqual(r.skipped, [{ name: "zeros.bin", reason: "ratio" }]);
});

test("zip import: many small files over the entry limit stop reading, counted once", async () => {
  const zip = makeZip(Array.from({ length: 30 }, (_, i) => ({ name: `p${String(i).padStart(2, "0")}.md`, data: `page ${i}` })));
  const r = await unzip(zip, { limits: small({ maxEntries: 10 }) });
  assert.equal(r.files.length, 10);
  assert.deepEqual(r.skipped, [{ name: "", reason: "too-many", count: 20 }]);
});

test("zip import: nested archives are opened up to maxDepth and count into the total", async () => {
  const level2 = makeZip([{ name: "deep.md", data: "deep" }]);
  const level1 = makeZip([{ name: "inner.md", data: "inner" }, { name: "level2.zip", data: level2, method: 0 }]);
  const outer = makeZip([{ name: "top.md", data: "top" }, { name: "part1.zip", data: level1 }]);
  const all = await unzip(outer, { limits: small() });
  assert.deepEqual(names(all), ["deep.md", "inner.md", "top.md"]);
  const one = await unzip(outer, { limits: small({ maxDepth: 1 }) });
  assert.deepEqual(names(one), ["inner.md", "top.md"]);
  assert.deepEqual(one.skipped, [{ name: "part1.zip/level2.zip", reason: "too-deep" }]);
  const none = await unzip(outer, { limits: small({ maxDepth: 0 }) });
  assert.deepEqual(none.skipped, [{ name: "part1.zip", reason: "too-deep" }]);

  // The nested archive (10 KB stored) and its file (10 KB) both count: 20 KB > 16 KB.
  const part = makeZip([{ name: "big.md", data: bytes(10 * KB), method: 0 }]);
  const wrapped = makeZip([{ name: "part.zip", data: part, method: 0 }]);
  const r = await unzip(wrapped, { limits: small({ maxTotal: 16 * KB }) });
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.skipped, [{ name: "part.zip/big.md", reason: "budget" }]);
  assert.ok(r.bytes <= 16 * KB);
  // A nested archive over maxNested is not opened at all.
  const r2 = await unzip(wrapped, { limits: small({ maxNested: 8 * KB }) });
  assert.deepEqual(r2.skipped, [{ name: "part.zip", reason: "too-large" }]);
  // The entry limit is shared with nested archives too.
  const many = makeZip(Array.from({ length: 8 }, (_, i) => ({ name: `n${i}.md`, data: "x" })));
  const r3 = await unzip(makeZip([{ name: "a.md", data: "a" }, { name: "many.zip", data: many }]), { limits: small({ maxEntries: 5 }) });
  assert.equal(r3.files.length, 4); // a.md + n0..n2 (many.zip itself is the 2nd entry)
  assert.deepEqual(r3.skipped, [{ name: "many.zip", reason: "too-many", count: 5 }]);
  // A damaged nested archive is reported; the rest imports.
  const r4 = await unzip(makeZip([{ name: "broken.zip", data: "not a zip at all" }, { name: "a.md", data: "a" }]), { limits: small() });
  assert.deepEqual(names(r4), ["a.md"]);
  assert.deepEqual(r4.skipped, [{ name: "broken.zip", reason: "corrupt" }]);
});

test("zip import: the skipped report is capped, the rest counted", async () => {
  const zip = makeZip(Array.from({ length: 520 }, (_, i) => ({ name: `s${i}.md`, data: "x", flags: 1 })));
  const r = await unzip(zip, { limits: small({ maxEntries: 1000 }) });
  assert.equal(r.skipped.length, 500);
  assert.equal(r.more, 20);
  assert.ok(r.skipped.every((x) => x.reason === "encrypted"));
});

test("zip import: an AbortSignal cancels before and during the import", async () => {
  const zip = makeZip(Array.from({ length: 20 }, (_, i) => ({ name: `p${i}.md`, data: bytes(2 * KB) })));
  const before = new AbortController();
  before.abort();
  await assert.rejects(unzip(zip, { signal: before.signal }), (e: unknown) => e instanceof Error && e.name === "AbortError");
  // Aborted while the first entry inflates (unzip runs synchronously up to there).
  const during = new AbortController();
  const p = unzip(zip, { signal: during.signal, limits: small() });
  during.abort();
  await assert.rejects(p, (e: unknown) => e instanceof Error && e.name === "AbortError");
  // Aborted inside a nested archive: the abort is not swallowed as "corrupt".
  const nested = makeZip([{ name: "inner.zip", data: zip, method: 0 }]);
  const deep = new AbortController();
  const q = unzip(nested, { signal: deep.signal, limits: small() });
  deep.abort();
  await assert.rejects(q, (e: unknown) => e instanceof Error && e.name === "AbortError");
});
