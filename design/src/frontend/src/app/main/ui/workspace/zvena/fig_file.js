/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) zvena
 */

// zvena: reader for Figma's local files (.fig, "File → Save local copy…").
// Everything runs in the browser: the file never leaves the person's
// machine, only the resulting design is saved.
//
// A .fig is usually a ZIP with canvas.fig, meta.json, thumbnail.png and
// images/<sha1>; older files are the bare canvas. canvas.fig is
// "fig-kiwi" (or "fig-jam.", …) + uint32 version + chunks of
// [uint32 LE length][bytes]: chunk 0 is the compressed kiwi binary schema,
// chunk 1 the compressed message (raw deflate, or zstd). The message holds
// `nodeChanges` (every node of the document, flat, with parentIndex) and
// `blobs` (vector geometry referenced by index).
//
// decodeFig() turns that into the JSON shape of Figma's REST API
// ("GET /v1/files/:key?geometry=paths"), which figma_converter.js already
// knows how to build: pages, frames, groups, auto layout, text with mixed
// styles, vectors as SVG paths, image fills (imageRef = image hash),
// components, and instances expanded with their overrides.
//
// The format was reverse-engineered by others; this follows the MIT
// licensed fig2sketch (sketch-hq) and Evan Wallace's kiwi format.
//
// Note for the Closure compiler (:advanced): every property of decoded or
// produced data is written with quoted keys / brackets so it is never
// renamed.

const INVALID_ID = 4294967295;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

// ------------------------------------------------------------ errors

function figError(code, message) {
  const e = new Error(message || code);
  e["figCode"] = code;
  return e;
}

// ------------------------------------------------------------ bytes

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function u64(b, o) {
  return u32(b, o) + u32(b, o + 4) * 4294967296;
}

function ascii(b, start, end) {
  let s = "";
  for (let i = start; i < end && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

let textDecoder = null;
function utf8(b, start, end) {
  // short ASCII strings (most names) without TextDecoder
  if (end - start < 64) {
    let s = "";
    let plain = true;
    for (let i = start; i < end; i++) {
      const c = b[i];
      if (c >= 0x80) { plain = false; break; }
      s += String.fromCharCode(c);
    }
    if (plain) return s;
  }
  if (!textDecoder) textDecoder = new (globalThis["TextDecoder"])("utf-8");
  return textDecoder["decode"](b.subarray(start, end));
}

function startsWith(b, sig) {
  if (b.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
  return true;
}

function toHex(bytes) {
  if (!bytes || typeof bytes.length !== "number") return null;
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return s;
}

// ------------------------------------------------------------ inflate

async function inflate(bytes, format) {
  const DS = globalThis["DecompressionStream"];
  const Resp = globalThis["Response"];
  if (typeof DS !== "function" || typeof Resp !== "function") {
    throw figError("browser", "DecompressionStream is not available");
  }
  const ds = new DS(format);
  const writer = ds["writable"]["getWriter"]();
  // errors surface through the readable side
  writer["write"](bytes)["catch"](() => {});
  writer["close"]()["catch"](() => {});
  const buf = await new Resp(ds["readable"])["arrayBuffer"]();
  return new Uint8Array(buf);
}

async function decompress(chunk, opts) {
  const zstd = opts && opts["zstd"];
  if (startsWith(chunk, ZSTD_MAGIC)) {
    if (typeof zstd !== "function") throw figError("zstd", "zstd decoder missing");
    return zstd(chunk);
  }
  try {
    return await inflate(chunk, "deflate-raw");
  } catch (e) {
    if (e && e["figCode"]) throw e;
    // a zlib-wrapped chunk
    if (chunk[0] === 0x78) return inflate(chunk, "deflate");
    throw figError("damaged", "chunk can't be decompressed");
  }
}

// ------------------------------------------------------------ zip

function readZip(bytes) {
  const min = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw figError("damaged", "zip: no central directory");
  let count = u16(bytes, eocd + 10);
  let cdOff = u32(bytes, eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(bytes, loc) === 0x07064b50) {
      const z64 = u64(bytes, loc + 8);
      if (u32(bytes, z64) === 0x06064b50) {
        count = u64(bytes, z64 + 32);
        cdOff = u64(bytes, z64 + 48);
      }
    }
  }
  const entries = new Map();
  let p = cdOff;
  for (let k = 0; k < count && p + 46 <= bytes.length && u32(bytes, p) === 0x02014b50; k++) {
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    let csize = u32(bytes, p + 20);
    let size = u32(bytes, p + 24);
    const nl = u16(bytes, p + 28);
    const xl = u16(bytes, p + 30);
    const cl = u16(bytes, p + 32);
    let lho = u32(bytes, p + 42);
    const name = utf8(bytes, p + 46, p + 46 + nl);
    if (csize === 0xffffffff || size === 0xffffffff || lho === 0xffffffff) {
      let q = p + 46 + nl;
      const end = q + xl;
      while (q + 4 <= end) {
        const id = u16(bytes, q);
        const len = u16(bytes, q + 2);
        if (id === 1) {
          let z = q + 4;
          if (size === 0xffffffff) { size = u64(bytes, z); z += 8; }
          if (csize === 0xffffffff) { csize = u64(bytes, z); z += 8; }
          if (lho === 0xffffffff) { lho = u64(bytes, z); z += 8; }
          break;
        }
        q += 4 + len;
      }
    }
    entries.set(name, { method: method, csize: csize, size: size, lho: lho, encrypted: (flags & 1) === 1 });
    p += 46 + nl + xl + cl;
  }
  return entries;
}

async function zipEntry(bytes, e) {
  if (!e || e.encrypted || u32(bytes, e.lho) !== 0x04034b50) throw figError("damaged", "zip: bad entry");
  const nl = u16(bytes, e.lho + 26);
  const xl = u16(bytes, e.lho + 28);
  const start = e.lho + 30 + nl + xl;
  const data = bytes.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflate(data, "deflate-raw");
  throw figError("damaged", "zip: unsupported compression " + e.method);
}

// ------------------------------------------------------------ kiwi

// A kiwi reader over a byte array (format by Evan Wallace).
class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.i = 0;
  }
}

function eod() {
  return figError("damaged", "unexpected end of data");
}

function readByte(r) {
  if (r.i >= r.b.length) throw eod();
  return r.b[r.i++];
}

function readBool(r) {
  return readByte(r) !== 0;
}

function readVarUint(r) {
  let value = 0;
  let shift = 0;
  let byte;
  do {
    byte = readByte(r);
    value |= (byte & 127) << shift;
    shift += 7;
  } while ((byte & 128) && shift < 35);
  return value >>> 0;
}

function readVarInt(r) {
  const v = readVarUint(r) | 0;
  return (v & 1) ? ~(v >>> 1) : (v >>> 1);
}

const F32 = new Float32Array(1);
const I32 = new Int32Array(F32.buffer);

function readVarFloat(r) {
  const b = r.b;
  const i = r.i;
  if (i >= b.length) throw eod();
  const first = b[i];
  if (first === 0) { r.i = i + 1; return 0; }
  if (i + 4 > b.length) throw eod();
  let bits = first | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  r.i = i + 4;
  bits = (bits << 23) | (bits >>> 9);
  I32[0] = bits;
  return F32[0];
}

function readString(r) {
  const b = r.b;
  let j = r.i;
  while (j < b.length && b[j] !== 0) j++;
  if (j >= b.length) throw eod();
  const s = utf8(b, r.i, j);
  r.i = j + 1;
  return s;
}

function readByteArray(r) {
  const n = readVarUint(r);
  if (r.i + n > r.b.length) throw eod();
  const out = r.b.subarray(r.i, r.i + n);
  r.i += n;
  return out;
}

// 64-bit varints as plain numbers (exact up to 2^53)
function readVarUint64(r) {
  let value = 0;
  let mult = 1;
  for (let k = 0; k < 9; k++) {
    const byte = readByte(r);
    if (k === 8) { value += byte * mult; break; }
    value += (byte & 127) * mult;
    mult *= 128;
    if (!(byte & 128)) break;
  }
  return value;
}

function readVarInt64(r) {
  const v = readVarUint64(r);
  const half = Math.floor(v / 2);
  return v % 2 ? -half - 1 : half;
}

const PRIMITIVES = {
  "-1": readBool,
  "-2": readByte,
  "-3": readVarInt,
  "-4": readVarUint,
  "-5": readVarFloat,
  "-6": readString,
  "-7": readVarInt64,
  "-8": readVarUint64,
};

function decodeSchema(bytes) {
  const r = new Reader(bytes);
  const count = readVarUint(r);
  const defs = [];
  for (let d = 0; d < count; d++) {
    const name = readString(r);
    const kind = readByte(r);
    const fcount = readVarUint(r);
    const fields = [];
    for (let f = 0; f < fcount; f++) {
      fields.push({
        name: readString(r),
        type: readVarInt(r),
        isArray: readBool(r),
        value: readVarUint(r),
      });
    }
    defs.push({ name: name, kind: kind, fields: fields });
  }
  return defs;
}

// One decoding function per schema definition (closures, no eval).
function compileSchema(defs) {
  const fns = new Array(defs.length);
  const valueReader = (type, isArray) => {
    let one;
    if (type < 0) {
      if (isArray && type === -2) return readByteArray;
      one = PRIMITIVES[String(type)];
      if (!one) throw figError("damaged", "unknown kiwi type " + type);
    } else {
      if (type >= defs.length) throw figError("damaged", "unknown kiwi type " + type);
      one = (r) => fns[type](r);
    }
    if (!isArray) return one;
    return (r) => {
      const n = readVarUint(r);
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = one(r);
      return out;
    };
  };
  defs.forEach((def, idx) => {
    if (def.kind === 0) {
      const names = new Map();
      def.fields.forEach((f) => names.set(f.value, f.name));
      fns[idx] = (r) => {
        const v = readVarUint(r);
        const s = names.get(v);
        return s === undefined ? v : s;
      };
    } else if (def.kind === 1) {
      const fs = def.fields.map((f) => [f.name, valueReader(f.type, f.isArray)]);
      fns[idx] = (r) => {
        const o = {};
        for (let i = 0; i < fs.length; i++) o[fs[i][0]] = fs[i][1](r);
        return o;
      };
    } else if (def.kind === 2) {
      const byId = [];
      def.fields.forEach((f) => { byId[f.value] = [f.name, valueReader(f.type, f.isArray)]; });
      fns[idx] = (r) => {
        const o = {};
        for (;;) {
          const id = readVarUint(r);
          if (id === 0) return o;
          const f = byId[id];
          if (!f) throw figError("damaged", "unknown field " + id + " in " + def.name);
          o[f[0]] = f[1](r);
        }
      };
    } else {
      throw figError("damaged", "unknown kiwi kind " + def.kind);
    }
  });
  return fns;
}

function decodeMessage(defs, bytes, rootName) {
  const fns = compileSchema(defs);
  const idx = defs.findIndex((d) => d.name === rootName);
  if (idx < 0) throw figError("damaged", "no " + rootName + " in schema");
  return fns[idx](new Reader(bytes));
}

// ------------------------------------------------------------ container

const PK = [0x50, 0x4b, 0x03, 0x04];

// The canvas (kiwi) of a .fig and a reader for its images.
async function openContainer(bytes, opts) {
  let canvas = bytes;
  let meta = null;
  let images = new Map();
  if (startsWith(bytes, PK)) {
    const entries = readZip(bytes);
    let canvasEntry = entries.get("canvas.fig");
    if (!canvasEntry) {
      for (const [name, e] of entries) {
        if (/(^|\/)canvas\.fig$/.test(name)) { canvasEntry = e; break; }
      }
    }
    if (!canvasEntry) throw figError("not-fig", "zip without canvas.fig");
    canvas = await zipEntry(bytes, canvasEntry);
    const metaEntry = entries.get("meta.json");
    if (metaEntry) {
      try {
        const raw = await zipEntry(bytes, metaEntry);
        meta = JSON.parse(utf8(raw, 0, raw.length));
      } catch (_) { meta = null; }
    }
    for (const [name, e] of entries) {
      const m = /(?:^|\/)images\/([0-9a-fA-F]{40})$/.exec(name);
      if (m) images.set(m[1].toLowerCase(), e);
    }
    images = { zip: bytes, entries: images };
  } else {
    images = { zip: null, entries: images };
  }
  const head = ascii(canvas, 0, 8);
  if (!/^fig-/.test(head)) throw figError("not-fig", "unknown header");
  const version = u32(canvas, 8);
  const chunks = [];
  let o = 12;
  while (o + 4 <= canvas.length) {
    const n = u32(canvas, o);
    o += 4;
    if (o + n > canvas.length) break;
    chunks.push(canvas.subarray(o, o + n));
    o += n;
  }
  if (chunks.length < 2) throw figError("damaged", "missing chunks");
  const schemaBytes = await decompress(chunks[0], opts);
  const dataBytes = await decompress(chunks[1], opts);
  const defs = decodeSchema(schemaBytes);
  const message = decodeMessage(defs, dataBytes, "Message");
  return { kind: head, version: version, message: message, meta: meta, images: images };
}

// Raw decoded message (debugging, tests).
export async function readFigMessage(bytes, opts) {
  const c = await openContainer(bytes, opts);
  return { "kind": c.kind, "version": c.version, "message": c.message, "meta": c.meta };
}

// ------------------------------------------------------------ geometry

const IDENTITY = [[1, 0, 0], [0, 1, 0]];

function finite(v, d) {
  return typeof v === "number" && isFinite(v) ? v : d;
}

function r3(v) {
  const x = Math.round(v * 1000) / 1000;
  return x === 0 || !isFinite(x) ? 0 : x;
}

function matOf(t) {
  if (!t) return IDENTITY;
  return [
    [finite(t["m00"], 1), finite(t["m01"], 0), finite(t["m02"], 0)],
    [finite(t["m10"], 0), finite(t["m11"], 1), finite(t["m12"], 0)],
  ];
}

// 2x3 affine matrices [[a, c, tx], [b, d, ty]]
function mul(m1, m2) {
  const a1 = m1[0][0], c1 = m1[0][1], x1 = m1[0][2];
  const b1 = m1[1][0], d1 = m1[1][1], y1 = m1[1][2];
  const a2 = m2[0][0], c2 = m2[0][1], x2 = m2[0][2];
  const b2 = m2[1][0], d2 = m2[1][1], y2 = m2[1][2];
  return [
    [a1 * a2 + c1 * b2, a1 * c2 + c1 * d2, a1 * x2 + c1 * y2 + x1],
    [b1 * a2 + d1 * b2, b1 * c2 + d1 * d2, b1 * x2 + d1 * y2 + y1],
  ];
}

function invert(m) {
  const a = m[0][0], c = m[0][1], tx = m[0][2];
  const b = m[1][0], d = m[1][1], ty = m[1][2];
  const det = a * d - c * b;
  if (!det || !isFinite(det)) return IDENTITY;
  const ia = d / det, ic = -c / det, ib = -b / det, id = a / det;
  return [[ia, ic, -(ia * tx + ic * ty)], [ib, id, -(ib * tx + id * ty)]];
}

function applyPt(m, x, y) {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}

function finiteMat(m) {
  return isFinite(m[0][0]) && isFinite(m[0][1]) && isFinite(m[0][2]) &&
    isFinite(m[1][0]) && isFinite(m[1][1]) && isFinite(m[1][2]);
}

function roundMat(m) {
  return [[m[0][0], m[0][1], r3(m[0][2])], [m[1][0], m[1][1], r3(m[1][2])]];
}

function bboxOf(m, w, h) {
  const pts = [applyPt(m, 0, 0), applyPt(m, w, 0), applyPt(m, 0, h), applyPt(m, w, h)];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return { "x": r3(x0), "y": r3(y0), "width": r3(x1 - x0), "height": r3(y1 - y0) };
}

// ------------------------------------------------------------ blobs

function blobBytes(ctx, index) {
  if (typeof index !== "number") return null;
  const b = ctx.blobs[index];
  const bytes = b && b["bytes"];
  return bytes instanceof Uint8Array ? bytes : null;
}

// Figma's path commands blob: 0 close, 1 move, 2 line, 3 quad, 4 cubic
// (float32 LE coordinates in node space).
function commandsToPath(bytes) {
  if (!bytes || !bytes.length) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let i = 0;
  const f = () => {
    const v = dv.getFloat32(i, true);
    i += 4;
    return isFinite(v) ? r3(v) : 0;
  };
  const need = (n) => i + n * 4 <= bytes.length;
  while (i < bytes.length) {
    const c = bytes[i++];
    if (c === 0) out.push("Z");
    else if (c === 1 && need(2)) out.push("M " + f() + " " + f());
    else if (c === 2 && need(2)) out.push("L " + f() + " " + f());
    else if (c === 3 && need(4)) out.push("Q " + f() + " " + f() + " " + f() + " " + f());
    else if (c === 4 && need(6)) out.push("C " + f() + " " + f() + " " + f() + " " + f() + " " + f() + " " + f());
    else break;
  }
  const d = out.join(" ");
  return /[0-9]/.test(d) ? d : null;
}

// The vector network blob (vertices, segments, regions).
function decodeNetwork(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  const u = () => { const v = dv.getUint32(i, true); i += 4; return v; };
  const f = () => { const v = dv.getFloat32(i, true); i += 4; return v; };
  try {
    const nv = u(), ns = u(), nr = u();
    if (nv > 1e6 || ns > 1e6 || nr > 1e6) return null;
    const vertices = [];
    for (let k = 0; k < nv; k++) {
      const style = u();
      vertices.push({ style: style, x: f(), y: f() });
    }
    const segments = [];
    for (let k = 0; k < ns; k++) {
      const style = u();
      const a = u(); const ax = f(); const ay = f();
      const b = u(); const bx = f(); const by = f();
      segments.push({ style: style, a: a, ax: ax, ay: ay, b: b, bx: bx, by: by });
    }
    const regions = [];
    for (let k = 0; k < nr; k++) {
      const flags = u();
      const nl = u();
      const loops = [];
      for (let l = 0; l < nl; l++) {
        const n = u();
        const loop = [];
        for (let q = 0; q < n; q++) loop.push(u());
        loops.push(loop);
      }
      regions.push({ style: flags >> 1, evenOdd: (flags & 1) === 0, loops: loops });
    }
    for (const s of segments) if (s.a >= nv || s.b >= nv) return null;
    return { vertices: vertices, segments: segments, regions: regions };
  } catch (_) {
    return null;
  }
}

// Centerline path of a vector network, scaled to the node size. `open`
// tells whether some segments are not part of a closed region.
function networkPath(net, sx, sy) {
  const V = net.vertices;
  const pt = (v) => r3(V[v].x * sx) + " " + r3(V[v].y * sy);
  const seg = (s, reverse) => {
    const from = reverse ? s.b : s.a;
    const to = reverse ? s.a : s.b;
    const t1x = reverse ? s.bx : s.ax, t1y = reverse ? s.by : s.ay;
    const t2x = reverse ? s.ax : s.bx, t2y = reverse ? s.ay : s.by;
    if (!t1x && !t1y && !t2x && !t2y) return "L " + pt(to);
    return "C " + r3((V[from].x + t1x) * sx) + " " + r3((V[from].y + t1y) * sy) + " " +
      r3((V[to].x + t2x) * sx) + " " + r3((V[to].y + t2y) * sy) + " " + pt(to);
  };
  const used = new Set();
  const parts = [];
  for (const region of net.regions) {
    for (const loop of region.loops) {
      const idx = loop.filter((k) => !!net.segments[k]);
      const segs = idx.map((k) => net.segments[k]);
      if (!segs.length) continue;
      let cur;
      if (segs.length === 1) cur = segs[0].a;
      else {
        const s0 = segs[0], s1 = segs[1];
        cur = (s0.b === s1.a || s0.b === s1.b) ? s0.a : s0.b;
      }
      const d = ["M " + pt(cur)];
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        const reverse = s.a !== cur;
        d.push(seg(s, reverse));
        cur = reverse ? s.a : s.b;
        used.add(idx[k]);
      }
      d.push("Z");
      parts.push(d.join(" "));
    }
  }
  let open = false;
  let last = -1;
  let first = -1;
  let chain = null;
  // a chain that ends where it started is closed (stroke joins, no caps)
  const flush = () => {
    if (!chain) return;
    if (last === first) chain.push("Z");
    else open = true;
    parts.push(chain.join(" "));
  };
  net.segments.forEach((s, k) => {
    if (used.has(k)) return;
    if (chain && s.a === last) {
      chain.push(seg(s, false));
    } else {
      flush();
      first = s.a;
      chain = ["M " + pt(s.a), seg(s, false)];
    }
    last = s.b;
  });
  flush();
  const d = parts.join(" ");
  return d ? { d: d, open: open } : null;
}

// ------------------------------------------------------------ paints

function colorOut(c) {
  c = c || {};
  return { "r": finite(c["r"], 0), "g": finite(c["g"], 0), "b": finite(c["b"], 0), "a": finite(c["a"], 1) };
}

function gradientHandles(t, type) {
  const inv = invert(matOf(t));
  const P = (x, y) => {
    const p = applyPt(inv, x, y);
    return { "x": p[0], "y": p[1] };
  };
  if (type === "GRADIENT_LINEAR") return [P(0, 0.5), P(1, 0.5), P(0, 1)];
  return [P(0.5, 0.5), P(1, 0.5), P(0.5, 1)];
}

const FILTER_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];

function paintOut(ctx, p) {
  const type = p["type"];
  const out = { "type": type };
  if (p["visible"] === false) out["visible"] = false;
  out["opacity"] = finite(p["opacity"], 1);
  if (p["blendMode"]) out["blendMode"] = p["blendMode"];
  if (type === "SOLID") {
    out["color"] = colorOut(p["color"]);
  } else if (typeof type === "string" && type.indexOf("GRADIENT_") === 0) {
    out["gradientStops"] = (p["stops"] || []).map((s) => ({
      "color": colorOut(s["color"]),
      "position": finite(s["position"], 0),
    }));
    out["gradientHandlePositions"] = gradientHandles(p["transform"], type);
  } else if (type === "IMAGE") {
    const img = p["image"] || {};
    const ref = toHex(img["hash"]);
    if (!ref) return null;
    out["imageRef"] = ref;
    out["scaleMode"] = p["imageScaleMode"] || "FILL";
    if (out["scaleMode"] === "STRETCH" && p["transform"]) {
      const m = matOf(p["transform"]);
      out["imageTransform"] = [m[0].slice(), m[1].slice()];
    }
    if (typeof p["scale"] === "number") out["scalingFactor"] = p["scale"];
    if (typeof p["rotation"] === "number" && p["rotation"]) out["rotation"] = p["rotation"];
    const pf = p["paintFilter"];
    if (pf) {
      const filters = {};
      for (const k of FILTER_KEYS) {
        // Figma's "saturation" lives in vibrance in the file
        const v = k === "saturation" ? finite(pf["vibrance"], finite(pf["saturation"], 0)) : finite(pf[k], 0);
        if (v) filters[k] = v;
      }
      if (Object.keys(filters).length) out["filters"] = filters;
    }
    if (out["visible"] !== false) {
      ctx.imageRefs.add(ref);
      const blob = blobBytes(ctx, img["dataBlob"]);
      if (blob && !ctx.blobImages.has(ref)) ctx.blobImages.set(ref, blob);
    }
  }
  return out;
}

function paintsOut(ctx, list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p) continue;
    const x = paintOut(ctx, p);
    if (x) out.push(x);
  }
  return out;
}

function effectsOut(list) {
  if (!Array.isArray(list)) return [];
  return list.map((e) => {
    let type = e["type"];
    if (type === "FOREGROUND_BLUR") type = "LAYER_BLUR";
    const o = { "type": type, "visible": e["visible"] !== false, "radius": finite(e["radius"], 0) };
    if (e["color"]) o["color"] = colorOut(e["color"]);
    if (e["offset"]) o["offset"] = { "x": finite(e["offset"]["x"], 0), "y": finite(e["offset"]["y"], 0) };
    o["spread"] = finite(e["spread"], 0);
    if (e["blendMode"]) o["blendMode"] = e["blendMode"];
    if (e["showShadowBehindNode"] === true) o["showShadowBehindNode"] = true;
    return o;
  });
}

// ------------------------------------------------------------ text

function weightOf(style) {
  const s = String(style || "").toLowerCase().replace(/[\s_-]/g, "");
  if (/thin|hairline/.test(s)) return 100;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/semibold|demibold/.test(s)) return 600;
  if (/extrabold|ultrabold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}

function lineHeightOut(st, lh, size) {
  const v = finite(lh["value"], 0);
  const units = lh["units"];
  if (units === "PIXELS") {
    st["lineHeightUnit"] = "PIXELS";
    st["lineHeightPx"] = v;
  } else if (units === "RAW") {
    st["lineHeightUnit"] = "FONT_SIZE_%";
    st["lineHeightPx"] = v * size;
    st["lineHeightPercentFontSize"] = v * 100;
  } else if (units === "PERCENT") {
    if (Math.abs(v - 100) < 0.01) {
      st["lineHeightUnit"] = "INTRINSIC_%";
      st["lineHeightPercent"] = 100;
    } else {
      // a percentage of the font's own line height (≈1.2em)
      st["lineHeightUnit"] = "FONT_SIZE_%";
      st["lineHeightPx"] = (size * 1.2 * v) / 100;
    }
  }
}

// REST TypeStyle from a text node, or from an entry of its style
// override table (`base` = the text node, for values relative to size).
function typeStyle(ctx, src, base) {
  const st = {};
  const fn = src["fontName"];
  if (fn) {
    st["fontFamily"] = fn["family"] || "Inter";
    if (fn["postscript"]) st["fontPostScriptName"] = fn["postscript"];
    st["fontStyle"] = fn["style"] || "Regular";
    st["fontWeight"] = weightOf(fn["style"]);
    st["italic"] = /italic|oblique/i.test(fn["style"] || "");
  }
  const hasSize = typeof src["fontSize"] === "number";
  const size = finite(src["fontSize"], base ? finite(base["fontSize"], 12) : 12);
  if (hasSize) st["fontSize"] = size;
  // a run with its own size keeps the node's relative line height/spacing
  const lh = src["lineHeight"] || (base && hasSize ? base["lineHeight"] : null);
  if (lh) lineHeightOut(st, lh, size);
  const ls = src["letterSpacing"] || (base && hasSize ? base["letterSpacing"] : null);
  if (ls) {
    const v = finite(ls["value"], 0);
    st["letterSpacing"] = ls["units"] === "PERCENT" ? (size * v) / 100 : v;
  }
  if (src["textDecoration"]) st["textDecoration"] = src["textDecoration"];
  if (src["textCase"]) st["textCase"] = src["textCase"];
  if (typeof src["paragraphSpacing"] === "number") st["paragraphSpacing"] = src["paragraphSpacing"];
  if (Array.isArray(src["fillPaints"])) st["fills"] = paintsOut(ctx, src["fillPaints"]);
  return st;
}

function textOut(ctx, out, n) {
  const td = n["textData"] || {};
  const chars = typeof td["characters"] === "string" ? td["characters"] : "";
  out["characters"] = chars;
  const style = typeStyle(ctx, n, null);
  if (!style["fontFamily"]) {
    style["fontFamily"] = "Inter";
    style["fontStyle"] = "Regular";
    style["fontWeight"] = 400;
  }
  if (!style["fontSize"]) style["fontSize"] = 12;
  style["textAutoResize"] = n["textAutoResize"] || "NONE";
  style["textAlignHorizontal"] = n["textAlignHorizontal"] || "LEFT";
  style["textAlignVertical"] = n["textAlignVertical"] || "TOP";
  out["style"] = style;
  const ids = td["characterStyleIDs"];
  const table = td["styleOverrideTable"];
  if (Array.isArray(ids) && ids.length && Array.isArray(table) && table.length) {
    const t = {};
    for (const s of table) {
      const id = s && s["styleID"];
      if (typeof id === "number" && id > 0) t[String(id)] = typeStyle(ctx, s, n);
    }
    // the file counts code points, JS strings count UTF-16 units
    const per = [];
    let cp = 0;
    for (const ch of chars) {
      const id = finite(ids[cp++], 0);
      per.push(id);
      if (ch.length === 2) per.push(id);
    }
    out["characterStyleOverrides"] = per;
    out["styleOverrideTable"] = t;
  }
  const lines = td["lines"];
  if (Array.isArray(lines) && lines.some((l) => l && (l["lineType"] === "ORDERED_LIST" || l["lineType"] === "UNORDERED_LIST" || l["lineType"] === "CHECKLIST"))) {
    ctx.warn("list bullets and numbers in text come in as plain text");
  }
  if (n["hyperlink"]) out["hyperlink"] = n["hyperlink"];
}

// ------------------------------------------------------------ nodes

const KIDS = Symbol("kids");
const PASS = Symbol("pass");
const IDP = Symbol("id");
const DEPTH = Symbol("depth");

function gk(g) {
  return g ? g["sessionID"] + ":" + g["localID"] : "";
}

function validGuid(g) {
  return !!g && typeof g["sessionID"] === "number" && typeof g["localID"] === "number" &&
    g["sessionID"] !== INVALID_ID && g["localID"] !== INVALID_ID;
}

function nodeKey(n) {
  return validGuid(n["overrideKey"]) ? gk(n["overrideKey"]) : gk(n["guid"]);
}

function posOf(n) {
  const p = n["parentIndex"];
  return (p && typeof p["position"] === "string") ? p["position"] : "";
}

function pathOf(o) {
  const gp = o && o["guidPath"];
  const guids = gp && gp["guids"];
  if (!Array.isArray(guids) || !guids.length) return null;
  return guids.map(gk);
}

function makeContext(message) {
  const ctx = {
    byId: new Map(),
    byKey: new Map(),
    byAssetKey: new Map(),
    kids: new Map(),
    blobs: message["blobs"] || [],
    imageRefs: new Set(),
    blobImages: new Map(),
    warnings: new Map(),
    types: {},
    count: 0,
    root: null,
  };
  ctx.warn = (msg) => ctx.warnings.set(msg, (ctx.warnings.get(msg) || 0) + 1);
  for (const n of message["nodeChanges"] || []) {
    if (!n || n["phase"] === "REMOVED" || !validGuid(n["guid"])) continue;
    const id = gk(n["guid"]);
    ctx.byId.set(id, n);
    if (validGuid(n["overrideKey"])) ctx.byKey.set(gk(n["overrideKey"]), n);
    if (typeof n["key"] === "string" && n["key"]) ctx.byAssetKey.set(n["key"], n);
    if (!ctx.root && n["type"] === "DOCUMENT") ctx.root = n;
  }
  for (const n of ctx.byId.values()) {
    const pi = n["parentIndex"];
    if (!pi || !validGuid(pi["guid"])) continue;
    const pid = gk(pi["guid"]);
    if (!ctx.byId.has(pid) || pid === gk(n["guid"])) continue;
    let list = ctx.kids.get(pid);
    if (!list) { list = []; ctx.kids.set(pid, list); }
    list.push(n);
  }
  for (const list of ctx.kids.values()) {
    list.sort((a, b) => {
      const pa = posOf(a), pb = posOf(b);
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }
  return ctx;
}

function findNode(ctx, guid) {
  if (!validGuid(guid)) return null;
  const k = gk(guid);
  return ctx.byId.get(k) || ctx.byKey.get(k) || null;
}

function childrenOf(ctx, n) {
  if (n[KIDS]) return n[KIDS];
  if (n["type"] === "INSTANCE") return expandInstance(ctx, n);
  return ctx.kids.get(gk(n["guid"])) || [];
}

// Shared styles: the node points at a style node (fill, stroke, text,
// effect). Nodes keep their own resolved copy (instance overrides too), so
// a style only fills in what the node doesn't store itself.
function styleNode(ctx, legacy, ref) {
  let s = findNode(ctx, legacy);
  if (!s && ref) {
    s = findNode(ctx, ref["guid"]);
    const asset = ref["assetRef"];
    if (!s && asset && typeof asset["key"] === "string") s = ctx.byAssetKey.get(asset["key"]) || null;
  }
  return s;
}

const TEXT_STYLE_KEYS = ["fontName", "fontSize", "textCase", "textDecoration", "letterSpacing", "lineHeight", "paragraphSpacing"];

function resolveStyles(ctx, n) {
  let out = n;
  const copy = () => { if (out === n) { out = Object.assign({}, n); copyHidden(n, out); } };
  if (n["fillPaints"] === undefined) {
    const fill = styleNode(ctx, n["inheritFillStyleID"], n["styleIdForFill"]);
    if (fill && Array.isArray(fill["fillPaints"])) { copy(); out["fillPaints"] = fill["fillPaints"]; }
  }
  if (n["strokePaints"] === undefined) {
    const stroke = styleNode(ctx, n["inheritFillStyleIDForStroke"], n["styleIdForStrokeFill"]);
    if (stroke && Array.isArray(stroke["fillPaints"])) { copy(); out["strokePaints"] = stroke["fillPaints"]; }
  }
  if (n["effects"] === undefined) {
    const effect = styleNode(ctx, n["inheritEffectStyleID"], n["styleIdForEffect"]);
    if (effect && Array.isArray(effect["effects"])) { copy(); out["effects"] = effect["effects"]; }
  }
  if (n["type"] === "TEXT" && TEXT_STYLE_KEYS.some((k) => n[k] === undefined)) {
    const text = styleNode(ctx, n["inheritTextStyleID"], n["styleIdForText"]);
    if (text) {
      for (const k of TEXT_STYLE_KEYS) {
        if (n[k] === undefined && text[k] !== undefined) { copy(); out[k] = text[k]; }
      }
    }
  }
  return out;
}

function copyHidden(from, to) {
  if (from[KIDS]) to[KIDS] = from[KIDS];
  if (from[PASS]) to[PASS] = from[PASS];
  if (from[IDP]) to[IDP] = from[IDP];
  if (from[DEPTH]) to[DEPTH] = from[DEPTH];
}

// -------------------------------------------------- instances

const DERIVED_KEYS = [
  "size", "transform", "fillGeometry", "strokeGeometry", "strokeWeight", "fontSize",
  "cornerRadius", "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius",
  "rectangleBottomLeftCornerRadius", "rectangleBottomRightCornerRadius",
  "stackSpacing", "stackCounterSpacing", "stackHorizontalPadding", "stackVerticalPadding",
  "stackPaddingRight", "stackPaddingBottom", "borderTopWeight", "borderBottomWeight",
  "borderLeftWeight", "borderRightWeight", "lineHeight", "letterSpacing", "effects", "arcData",
];

function applyOverride(c, props) {
  for (const k of Object.keys(props)) {
    if (k === "guidPath" || k === "guid" || k === "parentIndex" || k === "overrideKey") continue;
    const v = props[k];
    if (k === "overriddenSymbolID") {
      if (validGuid(v)) c["symbolData"] = Object.assign({}, c["symbolData"] || {}, { "symbolID": v });
    } else if (k === "textData") {
      const base = c["textData"] || {};
      const t = Object.assign({}, v);
      if (!Array.isArray(t["characterStyleIDs"])) {
        delete t["styleOverrideTable"];
      } else if (!Array.isArray(t["styleOverrideTable"]) && Array.isArray(base["styleOverrideTable"])) {
        t["styleOverrideTable"] = base["styleOverrideTable"];
      }
      if (!Array.isArray(t["lines"]) && Array.isArray(base["lines"])) t["lines"] = base["lines"];
      c["textData"] = t;
    } else if (v !== undefined) {
      c[k] = v;
    }
  }
}

function applyDerived(c, props) {
  for (const k of DERIVED_KEYS) {
    if (props[k] !== undefined) c[k] = props[k];
  }
}

// Overrides from component property assignments (text, visibility,
// instance swap), found through the main component's property refs.
function propOverrides(ctx, master, assignments, out) {
  if (!Array.isArray(assignments) || !assignments.length) return;
  const refs = new Map();
  const walk = (node) => {
    for (const r of node["componentPropRefs"] || []) {
      if (!r || r["isDeleted"] === true || !validGuid(r["defID"])) continue;
      const k = gk(r["defID"]);
      let list = refs.get(k);
      if (!list) { list = []; refs.set(k, list); }
      list.push([r["componentPropNodeField"], nodeKey(node)]);
    }
    if (node["type"] === "INSTANCE" && node !== master) return;
    for (const ch of ctx.kids.get(gk(node["guid"])) || []) walk(ch);
  };
  walk(master);
  for (const a of assignments) {
    const list = a && refs.get(gk(a["defID"]));
    if (!list) continue;
    const v = a["value"] || {};
    for (const [field, key] of list) {
      let props = null;
      if (field === "VISIBLE" && typeof v["boolValue"] === "boolean") props = { "visible": v["boolValue"] };
      else if (field === "TEXT_DATA" && v["textValue"]) props = { "textData": v["textValue"] };
      else if (field === "OVERRIDDEN_SYMBOL_ID" && validGuid(v["guidValue"])) props = { "overriddenSymbolID": v["guidValue"] };
      if (props) out.push({ path: [key], props: props });
    }
  }
}

// The layers of an instance: a copy of its main component's layers with
// the instance's overrides and its derived (resized) geometry applied.
function expandInstance(ctx, inst) {
  const sd = inst["symbolData"] || {};
  const master = findNode(ctx, sd["symbolID"]);
  if (!master) {
    if (validGuid(sd["symbolID"])) ctx.warn("instances whose main component is missing from the file came in empty");
    return [];
  }
  const depth = (inst[DEPTH] || 0) + 1;
  if (depth > 24) {
    ctx.warn("deeply nested instances were cut off");
    return [];
  }
  const pass = inst[PASS] || { ov: [], der: [] };
  const ov = [];
  const own = (sd["symbolOverrides"] || []).map((o) => ({ path: pathOf(o), props: o })).filter((o) => o.path);
  own.sort((a, b) => a.path.length - b.path.length);
  for (const o of own) ov.push(o);
  propOverrides(ctx, master, inst["componentPropAssignments"], ov);
  for (const o of pass.ov) ov.push(o);
  const der = [];
  for (const d of inst["derivedSymbolData"] || []) {
    const p = pathOf(d);
    if (p) der.push({ path: p, props: d });
  }
  for (const d of pass.der) der.push(d);
  const prefix = inst[IDP] || gk(inst["guid"]);
  const kids = ctx.kids.get(gk(master["guid"])) || [];
  return kids.map((k) => cloneNode(ctx, k, ov, der, prefix, depth));
}

function cloneNode(ctx, node, ov, der, prefix, depth) {
  const key = nodeKey(node);
  const c = Object.assign({}, node);
  c[IDP] = "I" + prefix + ";" + gk(node["guid"]);
  const deeperOv = [];
  const deeperDer = [];
  for (const o of ov) {
    if (o.path[0] !== key) continue;
    if (o.path.length === 1) applyOverride(c, o.props);
    else deeperOv.push({ path: o.path.slice(1), props: o.props });
  }
  for (const d of der) {
    if (d.path[0] !== key) continue;
    if (d.path.length === 1) applyDerived(c, d.props);
    else deeperDer.push({ path: d.path.slice(1), props: d.props });
  }
  if (c["type"] === "INSTANCE") {
    c[PASS] = { ov: deeperOv, der: deeperDer };
    c[DEPTH] = depth;
  } else {
    c[KIDS] = (ctx.kids.get(gk(node["guid"])) || []).map((k) => cloneNode(ctx, k, ov, der, prefix, depth));
  }
  return c;
}

// -------------------------------------------------- REST nodes

const H_CONSTRAINT = { "MIN": "LEFT", "MAX": "RIGHT", "CENTER": "CENTER", "STRETCH": "LEFT_RIGHT", "SCALE": "SCALE", "FIXED_MIN": "LEFT", "FIXED_MAX": "RIGHT" };
const V_CONSTRAINT = { "MIN": "TOP", "MAX": "BOTTOM", "CENTER": "CENTER", "STRETCH": "TOP_BOTTOM", "SCALE": "SCALE", "FIXED_MIN": "TOP", "FIXED_MAX": "BOTTOM" };
const CONTAINERS = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);
const SHAPES = new Set(["VECTOR", "STAR", "LINE", "ELLIPSE", "REGULAR_POLYGON", "BOOLEAN_OPERATION", "RECTANGLE"]);
const PRIMARY_ALIGN = { "MIN": "MIN", "CENTER": "CENTER", "MAX": "MAX", "SPACE_EVENLY": "SPACE_BETWEEN", "SPACE_BETWEEN": "SPACE_BETWEEN", "SPACE_AROUND": "SPACE_BETWEEN", "SPACE_EVENLY_CSS": "SPACE_BETWEEN" };
const COUNTER_ALIGN = { "MIN": "MIN", "CENTER": "CENTER", "MAX": "MAX", "BASELINE": "BASELINE", "STRETCH": "MIN", "AUTO": "MIN" };
const PEN_CAP = { "ROUND": "round", "SQUARE": "square", "ARROW_LINES": "line-arrow", "ARROW_EQUILATERAL": "triangle-arrow", "TRIANGLE_FILLED": "triangle-arrow", "DIAMOND_FILLED": "diamond", "CIRCLE_FILLED": "circle" };

function isAutoLayout(n) {
  return n["stackMode"] === "HORIZONTAL" || n["stackMode"] === "VERTICAL";
}

function hugs(n) {
  if (n["type"] === "TEXT") {
    const r = n["textAutoResize"];
    return { h: r === "WIDTH_AND_HEIGHT", v: r === "WIDTH_AND_HEIGHT" || r === "HEIGHT" };
  }
  if (!isAutoLayout(n)) return { h: false, v: false };
  const fit = (s) => s === "RESIZE_TO_FIT" || s === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";
  // absent primary sizing means hug; absent counter sizing means fixed
  const primary = n["stackPrimarySizing"] === undefined ? true : fit(n["stackPrimarySizing"]);
  const counter = fit(n["stackCounterSizing"]);
  const row = n["stackMode"] === "HORIZONTAL";
  return { h: row ? primary : counter, v: row ? counter : primary };
}

function restType(ctx, n) {
  const t = n["type"];
  switch (t) {
    case "FRAME":
      if (n["isStateGroup"] === true) return "COMPONENT_SET";
      if (n["resizeToFit"] === true && !isAutoLayout(n)) return "GROUP";
      return "FRAME";
    case "GROUP": return "GROUP";
    case "SYMBOL": return "COMPONENT";
    case "ROUNDED_RECTANGLE":
    case "RECTANGLE": return "RECTANGLE";
    case "INSTANCE":
    case "SECTION":
    case "TEXT":
    case "VECTOR":
    case "STAR":
    case "LINE":
    case "ELLIPSE":
    case "REGULAR_POLYGON":
    case "BOOLEAN_OPERATION":
      return t;
    case "SLICE":
      return null;
    default:
      // FigJam and newer layer kinds: keep their look when Figma stored it
      if (Array.isArray(n["fillGeometry"]) && n["fillGeometry"].length) {
        ctx.warn(String(t).toLowerCase().replace(/_/g, " ") + " layers came in as vectors");
        return "VECTOR";
      }
      ctx.warn(String(t).toLowerCase().replace(/_/g, " ") + " layers aren't supported and were skipped");
      return null;
  }
}

function strokesOut(ctx, out, n) {
  out["strokes"] = paintsOut(ctx, n["strokePaints"]);
  out["strokeWeight"] = finite(n["strokeWeight"], 1);
  const align = n["strokeAlign"];
  out["strokeAlign"] = align === "INSIDE" || align === "OUTSIDE" ? align : "CENTER";
  const dashes = n["dashPattern"];
  if (Array.isArray(dashes) && dashes.length && dashes.some((d) => d > 0)) out["strokeDashes"] = dashes.slice();
  if (n["strokeCap"]) out["strokeCap"] = n["strokeCap"];
  if (n["strokeJoin"]) out["strokeJoin"] = n["strokeJoin"];
  if (n["borderStrokeWeightsIndependent"] === true) {
    out["individualStrokeWeights"] = {
      "top": finite(n["borderTopWeight"], 0),
      "right": finite(n["borderRightWeight"], 0),
      "bottom": finite(n["borderBottomWeight"], 0),
      "left": finite(n["borderLeftWeight"], 0),
    };
  }
}

function cornersOut(out, n) {
  const base = finite(n["cornerRadius"], 0);
  const tl = finite(n["rectangleTopLeftCornerRadius"], base);
  const tr = finite(n["rectangleTopRightCornerRadius"], base);
  const br = finite(n["rectangleBottomRightCornerRadius"], base);
  const bl = finite(n["rectangleBottomLeftCornerRadius"], base);
  const independent = n["rectangleCornerRadiiIndependent"] === true;
  if ((independent || n["rectangleCornerRadiiIndependent"] === undefined) && !(tl === tr && tr === br && br === bl)) {
    out["rectangleCornerRadii"] = [tl, tr, br, bl];
  } else if (independent ? tl : base) {
    out["cornerRadius"] = independent ? tl : base;
  }
  const sm = finite(n["cornerSmoothing"], 0);
  if (sm > 0) out["cornerSmoothing"] = sm;
}

function layoutOut(ctx, out, n) {
  if (n["stackMode"] === "GRID") ctx.warn("grid auto layout came in as fixed positions");
  if (!isAutoLayout(n)) return;
  const row = n["stackMode"] === "HORIZONTAL";
  out["layoutMode"] = row ? "HORIZONTAL" : "VERTICAL";
  out["layoutWrap"] = n["stackWrap"] === "WRAP" ? "WRAP" : "NO_WRAP";
  const gap = finite(n["stackSpacing"], 0);
  out["itemSpacing"] = gap;
  // an unset (NaN) counter axis gap follows the item gap
  out["counterAxisSpacing"] = finite(n["stackCounterSpacing"], gap);
  const legacy = finite(n["stackPadding"], 0);
  const left = finite(n["stackHorizontalPadding"], legacy);
  const top = finite(n["stackVerticalPadding"], legacy);
  out["paddingLeft"] = left;
  out["paddingTop"] = top;
  out["paddingRight"] = finite(n["stackPaddingRight"], left);
  out["paddingBottom"] = finite(n["stackPaddingBottom"], top);
  out["primaryAxisAlignItems"] = PRIMARY_ALIGN[n["stackPrimaryAlignItems"] || n["stackJustify"]] || "MIN";
  out["counterAxisAlignItems"] = COUNTER_ALIGN[n["stackCounterAlignItems"] || n["stackCounterAlign"]] || "MIN";
  if (n["stackCounterAlignContent"] === "SPACE_BETWEEN") out["counterAxisAlignContent"] = "SPACE_BETWEEN";
  const hug = hugs(n);
  out["primaryAxisSizingMode"] = (row ? hug.h : hug.v) ? "AUTO" : "FIXED";
  out["counterAxisSizingMode"] = (row ? hug.v : hug.h) ? "AUTO" : "FIXED";
  if (n["bordersTakeSpace"] === true) out["strokesIncludedInLayout"] = true;
  if (n["stackReverseZIndex"] === true) out["itemReverseZIndex"] = true;
}

function childLayoutOut(out, n, parent) {
  const hug = hugs(n);
  if (parent && isAutoLayout(parent)) {
    if (n["stackPositioning"] === "ABSOLUTE") out["layoutPositioning"] = "ABSOLUTE";
    const row = parent["stackMode"] === "HORIZONTAL";
    const grow = finite(n["stackChildPrimaryGrow"], 0) > 0;
    const stretch = n["stackChildAlignSelf"] === "STRETCH";
    out["layoutGrow"] = grow ? 1 : 0;
    out["layoutAlign"] = stretch ? "STRETCH" : "INHERIT";
    out["layoutSizingHorizontal"] = (row ? grow : stretch) ? "FILL" : hug.h ? "HUG" : "FIXED";
    out["layoutSizingVertical"] = (row ? stretch : grow) ? "FILL" : hug.v ? "HUG" : "FIXED";
  } else if (isAutoLayout(n)) {
    out["layoutSizingHorizontal"] = hug.h ? "HUG" : "FIXED";
    out["layoutSizingVertical"] = hug.v ? "HUG" : "FIXED";
  }
}

function geometryOut(ctx, list, overrides) {
  const out = [];
  for (const g of Array.isArray(list) ? list : []) {
    const d = commandsToPath(blobBytes(ctx, g && g["commandsBlob"]));
    if (!d) continue;
    const o = { "path": d, "windingRule": g["windingRule"] === "ODD" ? "EVENODD" : "NONZERO" };
    const sid = g["styleID"];
    if (sid && overrides && overrides[String(sid)]) o["overrideID"] = sid;
    out.push(o);
  }
  return out;
}

// Per-region fills of a vector (REST fillOverrideTable).
function fillOverridesOut(ctx, n) {
  const vd = n["vectorData"];
  const table = vd && vd["styleOverrideTable"];
  if (!Array.isArray(table)) return null;
  const out = {};
  let any = false;
  for (const s of table) {
    if (!s || typeof s["styleID"] !== "number" || !Array.isArray(s["fillPaints"])) continue;
    out[String(s["styleID"])] = { "fills": paintsOut(ctx, s["fillPaints"]) };
    any = true;
  }
  return any ? out : null;
}

// zvena: the centerline of a vector, so strokes stay real strokes
// (editable, with caps and dashes) instead of filled outlines.
function strokePathOut(ctx, out, n, w, h) {
  const strokes = out["strokes"] || [];
  if (!strokes.some((p) => p["visible"] !== false)) return;
  const type = out["type"];
  if (type === "LINE") {
    out["zvStrokePath"] = "M 0 0 L " + r3(w) + " 0";
    out["zvStrokeFilled"] = false;
  } else if (type === "VECTOR") {
    const vd = n["vectorData"];
    if (!vd || out["fillOverrideTable"]) return;
    const net = decodeNetwork(blobBytes(ctx, vd["vectorNetworkBlob"]));
    if (!net || !net.segments.length) return;
    const ns = vd["normalizedSize"] || {};
    const sx = finite(ns["x"], 0) ? w / ns["x"] : 1;
    const sy = finite(ns["y"], 0) ? h / ns["y"] : 1;
    // rounded corners live only in the computed geometry
    const rounded = finite(n["cornerRadius"], 0) > 0 ||
      ((vd["styleOverrideTable"] || []).some((s) => s && finite(s["cornerRadius"], 0) > 0));
    if (rounded) return;
    const p = networkPath(net, sx, sy);
    if (!p) return;
    const filled = (out["fills"] || []).some((f) => f["visible"] !== false);
    if (filled && p.open) return;
    out["zvStrokePath"] = p.d;
    out["zvStrokeFilled"] = filled;
    // caps of an open path: from its end vertices, else from the node
    if (p.open && net.segments.length) {
      const styles = new Map();
      for (const s of vd["styleOverrideTable"] || []) if (s && typeof s["styleID"] === "number") styles.set(s["styleID"], s);
      const first = net.vertices[net.segments[0].a];
      const last = net.vertices[net.segments[net.segments.length - 1].b];
      const capOf = (v) => {
        const s = v && v.style ? styles.get(v.style) : null;
        return (s && s["strokeCap"]) || n["strokeCap"];
      };
      const a = PEN_CAP[capOf(first)], b = PEN_CAP[capOf(last)];
      if (a) out["zvStrokeCapStart"] = a;
      if (b) out["zvStrokeCapEnd"] = b;
    }
  } else if ((type === "STAR" || type === "REGULAR_POLYGON" || type === "ELLIPSE" || type === "BOOLEAN_OPERATION") &&
             !out["fillOverrideTable"] && Array.isArray(out["fillGeometry"]) && out["fillGeometry"].length) {
    out["zvStrokePath"] = out["fillGeometry"].map((g) => g["path"]).join(" ");
    out["zvStrokeFilled"] = true;
  }
  if (type === "LINE") {
    const cap = PEN_CAP[n["strokeCap"]];
    if (cap === "round" || cap === "square") out["zvStrokeCapStart"] = cap;
    if (cap) out["zvStrokeCapEnd"] = cap;
  }
}

// Frame properties an instance doesn't store itself come from its main
// component.
const INSTANCE_DEFAULTS = [
  "fillPaints", "strokePaints", "strokeWeight", "strokeAlign", "effects", "cornerRadius",
  "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomLeftCornerRadius",
  "rectangleBottomRightCornerRadius", "rectangleCornerRadiiIndependent", "cornerSmoothing",
  "frameMaskDisabled", "stackMode", "stackSpacing", "stackCounterSpacing", "stackHorizontalPadding",
  "stackVerticalPadding", "stackPaddingRight", "stackPaddingBottom", "stackPrimarySizing",
  "stackCounterSizing", "stackPrimaryAlignItems", "stackCounterAlignItems", "stackWrap",
  "stackCounterAlignContent", "bordersTakeSpace", "borderStrokeWeightsIndependent",
  "borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight",
];

function withMasterDefaults(ctx, n) {
  if (n["type"] !== "INSTANCE") return n;
  const master = findNode(ctx, (n["symbolData"] || {})["symbolID"]);
  if (!master) return n;
  let out = n;
  for (const k of INSTANCE_DEFAULTS) {
    if (n[k] === undefined && master[k] !== undefined) {
      if (out === n) out = Object.assign({}, n);
      out[k] = master[k];
    }
  }
  return out;
}

function toRest(ctx, node, pAbs, cAbs, parent) {
  if (!node || node["phase"] === "REMOVED") return null;
  const n = resolveStyles(ctx, withMasterDefaults(ctx, node));
  let type = restType(ctx, n);
  if (!type) return null;
  const size = n["size"] || {};
  const w = Math.max(0, finite(size["x"], 0));
  const h = Math.max(0, finite(size["y"], 0));
  const abs = mul(pAbs, matOf(n["transform"]));
  if (!finiteMat(abs)) {
    ctx.warn("layers with an invalid position were skipped");
    return null;
  }
  // a boolean group without stored geometry is rebuilt from its parts
  if (type === "BOOLEAN_OPERATION" && !(Array.isArray(n["fillGeometry"]) && n["fillGeometry"].length)) {
    type = "GROUP";
    ctx.warn("boolean groups without stored geometry came in as plain groups");
  }
  const out = {
    "id": n[IDP] || gk(n["guid"]),
    "name": typeof n["name"] === "string" ? n["name"] : "",
    "type": type,
    "size": { "x": w, "y": h },
    "absoluteTransform": roundMat(abs),
    "relativeTransform": roundMat(mul(invert(cAbs), abs)),
    "absoluteBoundingBox": bboxOf(abs, w, h),
  };
  ctx.count++;
  ctx.types[type] = (ctx.types[type] || 0) + 1;
  if (n["visible"] === false) out["visible"] = false;
  if (n["locked"] === true) out["locked"] = true;
  const op = finite(n["opacity"], 1);
  if (op < 1) out["opacity"] = Math.max(0, op);
  out["blendMode"] = n["blendMode"] && n["blendMode"] !== "UNSET" ? n["blendMode"] : "PASS_THROUGH";
  out["constraints"] = {
    "horizontal": H_CONSTRAINT[n["horizontalConstraint"]] || "LEFT",
    "vertical": V_CONSTRAINT[n["verticalConstraint"]] || "TOP",
  };
  if (n["mask"] === true) {
    out["isMask"] = true;
    out["maskType"] = n["maskType"] === "OUTLINE" || n["maskIsOutline"] === true ? "VECTOR" : (n["maskType"] || "ALPHA");
  }
  if (n["type"] === "INSTANCE") {
    const sd = n["symbolData"] || {};
    if (validGuid(sd["symbolID"])) out["componentId"] = gk(sd["symbolID"]);
  }
  childLayoutOut(out, n, parent);

  if (type !== "GROUP") {
    out["fills"] = paintsOut(ctx, n["fillPaints"]);
    strokesOut(ctx, out, n);
    out["effects"] = effectsOut(n["effects"]);
  } else {
    out["fills"] = [];
    out["strokes"] = [];
    out["effects"] = effectsOut(n["effects"]);
  }

  if (CONTAINERS.has(type)) {
    cornersOut(out, n);
    out["clipsContent"] = type === "SECTION" ? false : n["frameMaskDisabled"] !== true;
    layoutOut(ctx, out, n);
  } else if (type === "RECTANGLE") {
    cornersOut(out, n);
  } else if (type === "TEXT") {
    textOut(ctx, out, n);
  } else if (SHAPES.has(type)) {
    if (n["arcData"]) {
      const a = n["arcData"];
      out["arcData"] = {
        "startingAngle": finite(a["startingAngle"], 0),
        "endingAngle": finite(a["endingAngle"], Math.PI * 2),
        "innerRadius": finite(a["innerRadius"], 0),
      };
    }
    if (finite(n["cornerRadius"], 0) > 0) out["cornerRadius"] = n["cornerRadius"];
    const overrides = fillOverridesOut(ctx, n);
    if (overrides) out["fillOverrideTable"] = overrides;
    out["fillGeometry"] = geometryOut(ctx, n["fillGeometry"], overrides);
    out["strokeGeometry"] = geometryOut(ctx, n["strokeGeometry"], null);
    strokePathOut(ctx, out, n, w, h);
  }

  if (CONTAINERS.has(type) || type === "GROUP" || type === "BOOLEAN_OPERATION") {
    const groupLike = type === "GROUP" || type === "BOOLEAN_OPERATION";
    const kids = [];
    for (const k of childrenOf(ctx, n)) {
      const x = toRest(ctx, k, abs, groupLike ? cAbs : abs, n);
      if (x) kids.push(x);
    }
    out["children"] = kids;
    if (type === "GROUP" && !kids.length) {
      ctx.types[type]--;
      ctx.count--;
      return null;
    }
  }
  return out;
}

function buildDocument(ctx, meta) {
  const root = ctx.root;
  if (!root) throw figError("damaged", "no document node");
  const pages = [];
  for (const canvas of ctx.kids.get(gk(root["guid"])) || []) {
    if (canvas["type"] !== "CANVAS" || canvas["internalOnly"] === true) continue;
    const kids = [];
    for (const k of ctx.kids.get(gk(canvas["guid"])) || []) {
      const x = toRest(ctx, k, IDENTITY, IDENTITY, null);
      if (x) kids.push(x);
    }
    const page = {
      "id": gk(canvas["guid"]),
      "name": typeof canvas["name"] === "string" && canvas["name"] ? canvas["name"] : "Page",
      "type": "CANVAS",
      "children": kids,
    };
    if (canvas["backgroundColor"]) page["backgroundColor"] = colorOut(canvas["backgroundColor"]);
    pages.push(page);
  }
  return {
    "name": (meta && typeof meta["file_name"] === "string" && meta["file_name"]) || "Figma file",
    "document": { "id": gk(root["guid"]), "name": "Document", "type": "DOCUMENT", "children": pages },
    "components": {},
    "zvSource": "fig",
  };
}

// ------------------------------------------------------------ images

const IMAGE_TYPES = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46, 0x38], "image/gif"],
];

// Media type of image bytes (null when Design can't store it).
export function imageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  for (const [sig, type] of IMAGE_TYPES) if (startsWith(bytes, sig)) return type;
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  const head = ascii(bytes, 0, 256).trim();
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

async function readImage(c, ctx, ref) {
  const blob = ctx.blobImages.get(ref);
  if (blob) return blob;
  const imgs = c.images;
  const e = imgs && imgs.entries && imgs.entries.get(ref);
  if (!e || !imgs.zip) return null;
  try {
    return await zipEntry(imgs.zip, e);
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------------ entry

// Decodes a .fig (ArrayBuffer or Uint8Array). `opts.zstd` is a zstd
// decompress function (Uint8Array → Uint8Array). The result:
//   doc        REST-like document (see figma_converter.js)
//   imageRefs  image hashes used by visible fills that the file contains
//   missingImages  how many used images the file doesn't contain
//   readImage  (ref) => Promise<Uint8Array | null>
//   warnings   [string]
//   stats      { nodes, types: { TYPE: count }, pages }
export async function decodeFig(input, opts) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const c = await openContainer(bytes, opts);
  const ctx = makeContext(c.message);
  const doc = buildDocument(ctx, c.meta);
  const refs = Array.from(ctx.imageRefs);
  const has = (ref) => ctx.blobImages.has(ref) || !!(c.images && c.images.entries && c.images.entries.has(ref));
  const available = refs.filter(has);
  const missing = refs.length - available.length;
  if (missing > 0) ctx.warn("images missing from the .fig file were left out");
  if (c.kind !== "fig-kiwi") ctx.warn("this isn't a Figma Design file (" + c.kind.replace(/[^a-z-]/g, "") + "); some layers may be missing");
  const warnings = [];
  for (const [msg, count] of ctx.warnings) warnings.push(count > 1 ? msg + " (" + count + ")" : msg);
  return {
    "doc": doc,
    "imageRefs": available,
    "missingImages": missing,
    "readImage": (ref) => readImage(c, ctx, ref),
    "warnings": warnings,
    "stats": { "nodes": ctx.count, "types": ctx.types, "pages": doc["document"]["children"].length },
    "kind": c.kind,
    "version": c.version,
  };
}

// The REST-like document of an already decoded message (tests).
export function documentOf(message) {
  const ctx = makeContext(message);
  const doc = buildDocument(ctx, null);
  const warnings = [];
  for (const [msg, count] of ctx.warnings) warnings.push(count > 1 ? msg + " (" + count + ")" : msg);
  return { "doc": doc, "imageRefs": Array.from(ctx.imageRefs), "warnings": warnings };
}

// Error code of a failed decodeFig: "not-fig", "damaged", "browser",
// "zstd" or null.
export function errorCode(e) {
  return (e && e["figCode"]) || null;
}
