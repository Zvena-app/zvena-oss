// ZIP for zvena Documents: export (stored entries via the Science writer) and
// import (Notion's "Markdown & CSV" export, Obsidian vaults): a reader for
// stored and deflated entries, using the browser's DecompressionStream.
//
// An imported ZIP is untrusted input and every file of it ends up in the
// tab's memory, so the whole import (nested archives included) shares one
// budget: uncompressed bytes (`maxTotal`), entries read (`maxEntries`) and
// nesting depth (`maxDepth`). Sizes are checked from the central directory
// before anything is inflated, and the inflated bytes are counted again on
// the way (a header can lie: inflation stops right past the declared size,
// and the input is fed in small slices, so one slice inflates to ~8 MB at
// most). Peak memory is thus about the archive itself + `maxTotal` + one
// slice in flight. Whatever is left out comes back in `skipped`, with why.

import { crc32, zipStore } from "../science/zip";

export function zipFiles(files: { name: string; data: string | Uint8Array }[]): Blob {
  const bytes = zipStore(files);
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/zip" });
}

export interface UnzippedFile {
  name: string;
  data: Uint8Array;
}

const MB = 1024 * 1024;

export interface UnzipLimits {
  /** A file inside the archive larger than this is skipped (uploads take 50 MB at most). */
  maxFile: number;
  /** A nested ZIP (Notion splits big exports into parts) larger than this; it counts into `maxTotal` along with what it holds. */
  maxNested: number;
  /** Uncompressed bytes of the whole import, nested archives included. */
  maxTotal: number;
  /** Entries read across all archives (folders included). */
  maxEntries: number;
  /** How deep nested ZIPs are opened (1 = a ZIP inside the ZIP). */
  maxDepth: number;
  /** An entry over `ratioFrom` bytes that inflates more than this many times its compressed size looks like a ZIP bomb. */
  maxRatio: number;
  ratioFrom: number;
}

export const UNZIP_LIMITS: Readonly<UnzipLimits> = {
  maxFile: 100 * MB,
  maxNested: 512 * MB,
  maxTotal: 1024 * MB,
  maxEntries: 50_000,
  maxDepth: 2,
  maxRatio: 250,
  ratioFrom: 1 * MB,
};

/** Why an entry was left out. */
export type SkipReason = "too-large" | "budget" | "too-many" | "too-deep" | "ratio" | "corrupt" | "unsupported" | "encrypted";

export interface SkippedEntry {
  /** Path in the archive (a nested archive's entries: "part.zip/path"); "" = the archive itself ("too-many"). */
  name: string;
  reason: SkipReason;
  /** "too-many": how many entries were not read. */
  count?: number;
}

export interface UnzipOptions {
  /** Lower limits (tests); the defaults are UNZIP_LIMITS. */
  limits?: Partial<UnzipLimits>;
  /** Cancels the import: unzip rejects with the signal's reason (an AbortError). */
  signal?: AbortSignal;
}

export interface UnzipResult {
  files: UnzippedFile[];
  /** At most MAX_REPORT entries; `more` counts the rest. */
  skipped: SkippedEntry[];
  more: number;
  /** Uncompressed bytes read (≤ maxTotal). */
  bytes: number;
}

/** The archive itself can't be read: "not-zip" (no end of central directory, e.g. truncated), "corrupt", "unsupported" (ZIP64). */
export class ZipError extends Error {
  constructor(readonly code: "not-zip" | "corrupt" | "unsupported") {
    super(code === "not-zip" ? "not a zip" : code === "corrupt" ? "corrupt zip" : "unsupported zip");
    this.name = "ZipError";
  }
}

const MAX_REPORT = 500;
/** Compressed bytes handed to the inflater at a time (deflate tops out near 1032:1, so ~8 MB out per slice). */
const SLICE = 8 * 1024;
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

interface State {
  lim: UnzipLimits;
  signal?: AbortSignal;
  files: UnzippedFile[];
  skipped: SkippedEntry[];
  more: number;
  bytes: number;
  entries: number;
  /** Bytes since the last yield to the page. */
  sinceYield: number;
}

function skip(st: State, name: string, reason: SkipReason, count?: number): void {
  if (st.skipped.length < MAX_REPORT) st.skipped.push(count === undefined ? { name, reason } : { name, reason, count });
  else st.more += 1;
}

const aborted = (signal?: AbortSignal): boolean => Boolean(signal?.aborted);

/**
 * Inflates exactly `size` bytes (the central directory's size); more, less or
 * a broken stream is a ZipError. Fed in SLICE-sized pieces with backpressure,
 * so a lying header never gets far past `size` in memory.
 */
async function inflateRaw(data: Uint8Array, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const fed = (async () => {
    for (let i = 0; i < data.length; i += SLICE) await writer.write(data.subarray(i, i + SLICE) as Uint8Array<ArrayBuffer>);
    await writer.close();
  })().catch(() => {
    // The reader sees the same error (or cancelled the stream itself).
  });
  const out = new Uint8Array(size);
  let o = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (o + value.byteLength > size) throw new ZipError("corrupt");
      out.set(value, o);
      o += value.byteLength;
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    await fed;
    signal?.throwIfAborted();
    throw e instanceof ZipError ? e : new ZipError("corrupt");
  }
  await fed;
  if (o !== size) throw new ZipError("corrupt");
  return out;
}

async function readArchive(u8: Uint8Array, depth: number, prefix: string, st: State): Promise<void> {
  const { lim, signal } = st;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not-zip");
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new ZipError("unsupported");
  const cdEnd = cdOff + cdSize;
  if (cdEnd > eocd) throw new ZipError("corrupt");
  const dec = new TextDecoder("utf-8");
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    if (st.entries >= lim.maxEntries) {
      skip(st, prefix.replace(/\/$/, ""), "too-many", count - i);
      return;
    }
    st.entries += 1;
    if (p + 46 > cdEnd || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError("corrupt");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen > cdEnd) throw new ZipError("corrupt");
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const path = prefix + name;
    if (flags & 1) {
      skip(st, path, "encrypted");
      continue;
    }
    if ((method !== 0 && method !== 8) || csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) {
      skip(st, path, "unsupported");
      continue;
    }
    if (local + 30 > u8.length || dv.getUint32(local, true) !== 0x04034b50) {
      skip(st, path, "corrupt");
      continue;
    }
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (start + csize > u8.length || (method === 0 && csize !== usize)) {
      skip(st, path, "corrupt");
      continue;
    }
    const nested = /\.zip$/i.test(name);
    if (nested && depth >= lim.maxDepth) {
      skip(st, path, "too-deep");
      continue;
    }
    if (usize > (nested ? lim.maxNested : lim.maxFile)) {
      skip(st, path, "too-large");
      continue;
    }
    if (method === 8 && usize > lim.ratioFrom && usize > csize * lim.maxRatio) {
      skip(st, path, "ratio");
      continue;
    }
    if (st.bytes + usize > lim.maxTotal) {
      skip(st, path, "budget");
      continue;
    }
    const raw = u8.subarray(start, start + csize);
    let data: Uint8Array;
    try {
      // Stored entries stay views into the archive (no copy).
      data = method === 0 ? raw : await inflateRaw(raw, usize, signal);
    } catch {
      signal?.throwIfAborted();
      skip(st, path, "corrupt");
      continue;
    }
    if (crc32(data) !== crc) {
      skip(st, path, "corrupt");
      continue;
    }
    st.bytes += usize;
    st.sinceYield += usize;
    if (st.sinceYield > 16 * MB || i % 500 === 499) {
      st.sinceYield = 0;
      await yieldToUi();
    }
    if (nested) {
      try {
        await readArchive(data, depth + 1, `${path}/`, st);
      } catch (e) {
        if (aborted(signal)) throw e;
        skip(st, path, e instanceof ZipError && e.code === "unsupported" ? "unsupported" : "corrupt");
      }
      continue;
    }
    st.files.push({ name, data });
  }
}

/**
 * Reads every file of a ZIP (central directory; stored + deflate). Nested
 * ZIPs are opened too (Notion splits big exports). Rejects with a ZipError
 * when the archive itself is unreadable, or with the signal's reason when
 * cancelled; single entries that can't be read land in `skipped`.
 */
export async function unzip(buf: ArrayBuffer | Uint8Array, opts: UnzipOptions = {}): Promise<UnzipResult> {
  const st: State = { lim: { ...UNZIP_LIMITS, ...opts.limits }, signal: opts.signal, files: [], skipped: [], more: 0, bytes: 0, entries: 0, sinceYield: 0 };
  opts.signal?.throwIfAborted();
  await readArchive(buf instanceof Uint8Array ? buf : new Uint8Array(buf), 0, "", st);
  return { files: st.files, skipped: st.skipped, more: st.more, bytes: st.bytes };
}
