// ZIP import: damaged entries are charged to the budget like good ones, and central-directory
// entries that share one local header (one blob inflated over and over) are refused.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { unzip } from "@/lib/notes/zip";
import { crc32 } from "@/lib/science/zip";

const KB = 1024;

/**
 * A deflated archive: `blobs` local entries, then `entries` central-directory entries,
 * entry i pointing at blob `at(i)`. Every blob's CRC is `crc` (default: wrong).
 */
function archive(blobs: number, entries: number, at: (i: number) => number, usize: number, good = false): Uint8Array {
  const plain = new Uint8Array(usize);
  for (let i = 0; i < usize; i += 64) plain[i] = (i * 31) & 0xff;
  const comp = new Uint8Array(deflateRawSync(plain));
  const crc = good ? crc32(plain) : 0x12345678;
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let off = 0;
  for (let b = 0; b < blobs; b++) {
    const name = Buffer.from(`b${b}.md`);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(usize, 22);
    h.writeUInt16LE(name.length, 26);
    offsets.push(off);
    parts.push(h, name, comp);
    off += 30 + name.length + comp.length;
  }
  const cdOff = off;
  for (let i = 0; i < entries; i++) {
    const name = Buffer.from(`f${i}.md`);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offsets[at(i)], 42);
    parts.push(c, name);
    off += 46 + name.length;
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(entries, 8);
  e.writeUInt16LE(entries, 10);
  e.writeUInt32LE(off - cdOff, 12);
  e.writeUInt32LE(cdOff, 16);
  parts.push(e);
  return new Uint8Array(Buffer.concat(parts));
}

/** Counts the inflaters unzip starts. */
async function counting<T>(run: () => Promise<T>): Promise<{ made: number; out: T }> {
  const DS = globalThis.DecompressionStream;
  let made = 0;
  globalThis.DecompressionStream = class extends DS {
    constructor(f: CompressionFormat) {
      super(f);
      made++;
    }
  };
  try {
    return { out: await run(), made };
  } finally {
    globalThis.DecompressionStream = DS;
  }
}

const limits = { maxFile: 16 * KB, maxNested: 64 * KB, maxTotal: 32 * KB, maxEntries: 500, maxDepth: 2 };

test("zip import: entries that fail their CRC are charged to the budget too", async () => {
  // 20 distinct damaged entries of 8 KB against a 32 KB budget: 4 are tried, the rest are over budget.
  const zip = archive(20, 20, (i) => i, 8 * KB);
  const { made, out } = await counting(() => unzip(zip, { limits }));
  assert.equal(made, 4);
  assert.equal(out.files.length, 0);
  assert.equal(out.bytes, 0, "nothing damaged is kept");
  assert.deepEqual(
    out.skipped.map((s) => s.reason),
    [...Array(4).fill("corrupt"), ...Array(16).fill("budget")]
  );
  // Good entries keep reading as before.
  const ok = await unzip(archive(4, 4, (i) => i, 8 * KB, true), { limits });
  assert.equal(ok.files.length, 4);
  assert.equal(ok.bytes, 32 * KB);
});

test("zip import: central-directory entries sharing one local header are read once", async () => {
  // 400 entries pointing at one blob (the review's 1.68 GB case, shrunk): inflated once, the rest corrupt.
  for (const good of [false, true]) {
    const zip = archive(1, 400, () => 0, 4 * KB, good);
    const { made, out } = await counting(() => unzip(zip, { limits: { ...limits, maxTotal: 4 * KB * 400 } }));
    assert.equal(made, 1, `good=${good}`);
    assert.equal(out.files.length, good ? 1 : 0);
    assert.equal(out.skipped.length, good ? 399 : 400);
    assert.ok(out.skipped.every((s) => s.reason === "corrupt"));
  }
});
