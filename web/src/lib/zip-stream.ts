// A streaming ZIP writer (stored entries, data descriptors): the data export
// can be gigabytes of files and designs, so nothing is held in memory beyond
// one chunk. Entries are added from async sources; offsets stay under 4 GB
// (the export refuses more, see app/api/export).

import { crc32 } from "./science/zip";

export type ZipSource = Uint8Array | string | (() => AsyncIterable<Uint8Array>);

const enc = new TextEncoder();

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Running CRC-32 over chunks (same table as crc32()). */
function crcUpdate(crc: number, chunk: Uint8Array): number {
  // crc32() starts from 0xffffffff and finalizes; chain by un-finalizing.
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < chunk.length; i++) c = TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export const ZIP_MAX_BYTES = 4_000_000_000;

/** A ZIP of the given entries as a web stream. */
export function zipStream(entries: AsyncIterable<{ name: string; data: ZipSource }>, when = new Date()): ReadableStream<Uint8Array> {
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  const { time, date } = dosTime(when);
  async function* gen(): AsyncGenerator<Uint8Array> {
    for await (const e of entries) {
      const name = enc.encode(e.name);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0808, true); // data descriptor + UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint16(26, name.length, true);
      const start = offset;
      yield new Uint8Array(local.buffer);
      yield name;
      offset += 30 + name.length;
      let crc = 0;
      let size = 0;
      const chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> =
        typeof e.data === "function" ? e.data() : [typeof e.data === "string" ? enc.encode(e.data) : e.data];
      for await (const chunk of chunks) {
        crc = crcUpdate(crc, chunk);
        size += chunk.length;
        offset += chunk.length;
        if (offset > ZIP_MAX_BYTES) throw new Error("zip too large");
        yield chunk;
      }
      const desc = new DataView(new ArrayBuffer(16));
      desc.setUint32(0, 0x08074b50, true);
      desc.setUint32(4, crc, true);
      desc.setUint32(8, size, true);
      desc.setUint32(12, size, true);
      yield new Uint8Array(desc.buffer);
      offset += 16;
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0808, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true);
      cen.setUint32(24, size, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, start, true);
      const rec = new Uint8Array(46 + name.length);
      rec.set(new Uint8Array(cen.buffer), 0);
      rec.set(name, 46);
      central.push(rec);
      count++;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) {
      cdSize += c.length;
      yield c;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, count, true);
    end.setUint16(10, count, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    yield new Uint8Array(end.buffer);
  }
  const it = gen();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await it.return?.(undefined);
    },
  });
}

export { crc32 };
