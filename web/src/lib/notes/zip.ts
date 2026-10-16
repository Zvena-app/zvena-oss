// ZIP for zvena Documents: export (stored entries via the Science writer) and
// import (Notion's "Markdown & CSV" export, Obsidian vaults): a reader for
// stored and deflated entries, using the browser's DecompressionStream.

import { zipStore } from "../science/zip";

export function zipFiles(files: { name: string; data: string | Uint8Array }[]): Blob {
  const bytes = zipStore(files);
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/zip" });
}

export interface UnzippedFile {
  name: string;
  data: Uint8Array;
}

/** A file inside the archive larger than this is skipped (uploads take 50 MB at most)… */
const MAX_FILE = 100 * 1024 * 1024;
/** …and a nested ZIP (Notion splits big exports into parts) larger than this. */
const MAX_NESTED = 1536 * 1024 * 1024;

/** Inflates an entry; null past `max` bytes (a ZIP bomb stops here, not in the tab's memory). */
async function inflateRaw(data: Uint8Array, max: number): Promise<Uint8Array | null> {
  const ds = new DecompressionStream("deflate-raw");
  const reader = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer]).stream().pipeThrough(ds).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Reads every file of a ZIP (central directory; stored + deflate). Nested ZIPs are opened too (Notion splits big exports). */
export async function unzip(buf: ArrayBuffer, depth = 0): Promise<UnzippedFile[]> {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: UnzippedFile[] = [];
  const dec = new TextDecoder("utf-8");
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(start, start + csize);
    const nested = depth < 2 && /\.zip$/i.test(name);
    const max = nested ? MAX_NESTED : MAX_FILE;
    let data: Uint8Array | null;
    if (method === 0) data = csize <= max ? raw.slice() : null;
    else if (method === 8) data = await inflateRaw(raw, max);
    else continue;
    if (!data) continue;
    if (nested) {
      try {
        out.push(...(await unzip(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, depth + 1)));
        continue;
      } catch {
        // Not a readable zip: keep it as a file.
      }
    }
    out.push({ name, data });
  }
  return out;
}
