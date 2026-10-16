// Server-only: maps for Documents (the Map view, the Place property). The
// browser never talks to a map provider: map tiles and address lookups go
// through these functions, which fetch from one configured upstream each
// (OpenStreetMap by default) and keep what they got.
//
// - Tiles: ZVENA_TILES_URL (default the OSM tile server), cached on disk
//   (ZVENA_TILES_DIR, default <data>/tiles) for ZVENA_TILES_TTL_DAYS (30),
//   capped at ZVENA_TILES_CACHE_MB (2048): the oldest tiles go first. At
//   most two upstream requests at a time (the OSM tile usage policy).
// - Addresses: ZVENA_GEOCODER_URL (default Nominatim), one upstream request
//   a second for the whole server, answers cached 30 days in SQLite
//   (geo_cache). Searches run on Enter, never as you type (Nominatim's
//   policy forbids autocomplete).
// The upstream is fixed by the operator; only validated numbers and an
// encoded query reach it, and redirects are not followed.

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config";
import { notesFilesDir } from "./notes/files";
import type { PlaceValue } from "./notes/types";
import { sql } from "./store";
import { isLocale } from "@/i18n/locales";

const DAY = 86_400_000;
export const TILE_MAX_ZOOM = 19;
const TILE_BYTES = 1_000_000;
const GEO_BYTES = 500_000;

export type MapsFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

const defaultFetch: MapsFetch = (url, init) => fetch(url, { ...init, redirect: "error" });
let fetcher: MapsFetch = defaultFetch;

/** Tests swap the network for a fake (null: back to the real one). */
export function setMapsFetch(fn: MapsFetch | null): void {
  fetcher = fn ?? defaultFetch;
}

function userAgent(): string {
  const contact = (process.env.ZVENA_MAPS_CONTACT || "").trim();
  return `zvena-maps/1.0 (+${config.appUrl}${contact ? `; ${contact}` : ""})`;
}

let warnedContact = false;
/**
 * The OSM tile and Nominatim policies ask every application for a way to
 * reach its operator; without one (ZVENA_MAPS_CONTACT) heavy use gets the
 * server's address blocked and maps break for everyone. Said once, at
 * start-up and on the first upstream request.
 */
export function warnMapsContact(): boolean {
  if (warnedContact || (process.env.ZVENA_MAPS_CONTACT || "").trim()) return false;
  const osm = /(^|\.)openstreetmap\.org$/i;
  const host = (u: string) => {
    try {
      return new URL(u.replace(/\{[zxys]\}/g, "0")).hostname;
    } catch {
      return "";
    }
  };
  if (!osm.test(host(tilesTemplate())) && !osm.test(host(geocoderBase()))) return false;
  warnedContact = true;
  console.warn("[maps] ZVENA_MAPS_CONTACT is empty: OpenStreetMap's tile and Nominatim policies require a contact (an e-mail or URL of this server's operator) — set it, or point ZVENA_TILES_URL / ZVENA_GEOCODER_URL at your own provider");
  return true;
}

// Upstream tile budgets (cached tiles are free): per person and for the whole
// server, per day (ZVENA_MAPS_TILES_PER_USER_DAY, ZVENA_MAPS_TILES_PER_DAY) —
// the OSM tile policy forbids bulk downloading through us.
interface TileBudget {
  day: number;
  total: number;
  users: Map<string, number>;
}
const BKEY = Symbol.for("zvena.maps.budget");
const gb = globalThis as unknown as Record<symbol, TileBudget | undefined>;

/** Over today's upstream budget and nothing cached for that tile. */
export class TileBudgetSpent extends Error {
  constructor() {
    super("tile budget");
  }
}

/** Takes one upstream tile from today's budget of `user` and of the server; false when spent. */
export function takeTileBudget(user: string | undefined, now = Date.now()): boolean {
  const day = Math.floor(now / DAY);
  let b = gb[BKEY];
  if (!b || b.day !== day) b = gb[BKEY] = { day, total: 0, users: new Map() };
  const used = user ? (b.users.get(user) ?? 0) : 0;
  if (b.total >= num("ZVENA_MAPS_TILES_PER_DAY", 50_000) || (user && used >= num("ZVENA_MAPS_TILES_PER_USER_DAY", 5_000))) return false;
  b.total += 1;
  if (user) b.users.set(user, used + 1);
  return true;
}

/** Bytes of an upstream answer, read with a cap (null: failed, refused or too big). */
async function getBytes(url: string, accept: string, max: number, timeoutMs: number): Promise<{ bytes: Buffer; type: string } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetcher(url, { headers: { "user-agent": userAgent(), accept, "accept-language": "en" }, signal: ctl.signal });
    if (!r.ok || !r.body) return null;
    if (Number(r.headers.get("content-length") ?? "0") > max) return null;
    const reader = r.body.getReader();
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
    return { bytes: Buffer.concat(chunks), type: (r.headers.get("content-type") ?? "").toLowerCase() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tiles

export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** A tile address from the route (`y` may end in ".png"); null when out of range. */
export function parseTile(z: string, x: string, y: string): TileId | null {
  if (!/^\d{1,2}$/.test(z) || !/^\d{1,7}$/.test(x) || !/^\d{1,7}(\.png)?$/.test(y)) return null;
  const t = { z: Number(z), x: Number(x), y: Number(y.replace(/\.png$/, "")) };
  if (t.z > TILE_MAX_ZOOM) return null;
  const n = 2 ** t.z;
  return t.x < n && t.y < n ? t : null;
}

/** The operator's tile URL template; anything but an http(s) URL with {z}, {x} and {y} falls back to OSM. */
export function tilesTemplate(raw = process.env.ZVENA_TILES_URL): string {
  const fallback = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const s = (raw || "").trim();
  if (!s || !/^https?:\/\//i.test(s) || !s.includes("{z}") || !s.includes("{x}") || !s.includes("{y}")) return fallback;
  try {
    new URL(s.replace(/\{[zxys]\}/g, "0"));
    return s;
  } catch {
    return fallback;
  }
}

export function tileUrl(t: TileId, template = tilesTemplate()): string {
  return template.replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y)).replace("{s}", "a");
}

function tilesDir(): string {
  return process.env.ZVENA_TILES_DIR || join(dirname(notesFilesDir()), "tiles");
}

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

interface TileState {
  active: number;
  queue: (() => void)[];
  inflight: Map<string, Promise<Buffer | null>>;
  bytes: number | null;
  lastSweep: number;
  sweeping: boolean;
}

const TKEY = Symbol.for("zvena.maps.tiles");
const gt = globalThis as unknown as Record<symbol, TileState | undefined>;
const tiles: TileState = (gt[TKEY] ??= { active: 0, queue: [], inflight: new Map(), bytes: null, lastSweep: 0, sweeping: false });

/** At most two upstream tile requests at once (a polite client, per the OSM policy). */
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (tiles.active >= 2) await new Promise<void>((resolve) => tiles.queue.push(resolve));
  tiles.active += 1;
  try {
    return await fn();
  } finally {
    tiles.active -= 1;
    tiles.queue.shift()?.();
  }
}

async function walk(dir: string, out: { path: string; size: number; at: number }[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = await stat(p);
      if (st.isDirectory()) await walk(p, out);
      else if (st.isFile()) out.push({ path: p, size: st.size, at: st.mtimeMs });
    } catch {
      // Gone meanwhile.
    }
  }
}

/** Keeps the tile cache under its cap: the oldest tiles go first, down to 90% of it. */
export async function sweepTiles(now = Date.now()): Promise<number> {
  const cap = num("ZVENA_TILES_CACHE_MB", 2048) * 1024 * 1024;
  const files: { path: string; size: number; at: number }[] = [];
  await walk(tilesDir(), files);
  let bytes = files.reduce((n, f) => n + f.size, 0);
  let removed = 0;
  if (bytes > cap) {
    files.sort((a, b) => a.at - b.at);
    for (const f of files) {
      if (bytes <= cap * 0.9) break;
      try {
        await unlink(f.path);
        bytes -= f.size;
        removed += 1;
      } catch {
        // Already gone.
      }
    }
  }
  tiles.bytes = bytes;
  tiles.lastSweep = now;
  return removed;
}

/** The first write of a process counts the cache; later ones sweep when over the cap (at most every 10 minutes). */
function maybeSweep(now: number): void {
  if (tiles.sweeping) return;
  const over = tiles.bytes !== null && tiles.bytes > num("ZVENA_TILES_CACHE_MB", 2048) * 1024 * 1024 && now - tiles.lastSweep > 10 * 60_000;
  if (tiles.bytes !== null && !over) return;
  tiles.sweeping = true;
  void sweepTiles(now)
    .catch(() => {})
    .finally(() => {
      tiles.sweeping = false;
    });
}

/**
 * A map tile (PNG bytes): from the disk cache while fresh, else from the
 * upstream (an old copy still serves when the upstream fails). Null: none.
 */
export async function getTile(t: TileId, now = Date.now(), user?: string): Promise<Buffer | null> {
  const file = join(tilesDir(), String(t.z), String(t.x), `${t.y}.png`);
  let cached: Buffer | null = null;
  try {
    const st = await stat(file);
    cached = await readFile(file);
    if (now - st.mtimeMs < num("ZVENA_TILES_TTL_DAYS", 30) * DAY) return cached;
  } catch {
    cached = null;
  }
  const key = `${t.z}/${t.x}/${t.y}`;
  const running = tiles.inflight.get(key);
  if (running) return (await running) ?? cached;
  if (!takeTileBudget(user, now)) {
    if (cached) return cached;
    throw new TileBudgetSpent();
  }
  warnMapsContact();
  const job = slot(async () => {
    const got = await getBytes(tileUrl(t), "image/png,image/*;q=0.8", TILE_BYTES, 10_000);
    if (!got || !got.type.startsWith("image/")) return null;
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, got.bytes);
      await rename(tmp, file);
      if (tiles.bytes !== null) tiles.bytes += got.bytes.byteLength;
      maybeSweep(now);
    } catch {
      // A full disk: the tile is served anyway, just not kept.
    }
    return got.bytes;
  });
  tiles.inflight.set(key, job);
  try {
    return (await job) ?? cached;
  } finally {
    tiles.inflight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Addresses

interface GeoState {
  nextAt: number;
  waiting: number;
}

const GKEY = Symbol.for("zvena.maps.geo");
const gg = globalThis as unknown as Record<symbol, GeoState | undefined>;
const geo: GeoState = (gg[GKEY] ??= { nextAt: 0, waiting: 0 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GeoBusy extends Error {
  constructor() {
    super("busy");
  }
}

/** One upstream geocoder request a second for the whole server; past 20 waiting, callers are told to retry. */
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  if (geo.waiting >= 20) throw new GeoBusy();
  geo.waiting += 1;
  try {
    const now = Date.now();
    const at = Math.max(now, geo.nextAt);
    geo.nextAt = at + 1000;
    if (at > now) await sleep(at - now);
  } finally {
    geo.waiting -= 1;
  }
  return fn();
}

function geocoderBase(raw = process.env.ZVENA_GEOCODER_URL): string {
  const s = (raw || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/i.test(s) ? s : "https://nominatim.openstreetmap.org";
}

function cacheGet(key: string, now: number): PlaceValue[] | null {
  const row = sql("SELECT json, at FROM geo_cache WHERE key = ?").get(key) as { json: string; at: number } | undefined;
  if (!row || now - Number(row.at) > 30 * DAY) return null;
  try {
    return JSON.parse(row.json) as PlaceValue[];
  } catch {
    return null;
  }
}

function cachePut(key: string, value: PlaceValue[], now: number): void {
  sql("INSERT INTO geo_cache (key, json, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, at = excluded.at").run(key, JSON.stringify(value), now);
}

/** Drops address lookups older than 30 days (daily upkeep). */
export function purgeGeoCache(now = Date.now()): number {
  return Number(sql("DELETE FROM geo_cache WHERE at < ?").run(now - 30 * DAY).changes);
}

/** A Nominatim (jsonv2) result as a place. */
export function toPlace(r: unknown): PlaceValue | null {
  if (typeof r !== "object" || r === null) return null;
  const x = r as { name?: unknown; display_name?: unknown; lat?: unknown; lon?: unknown };
  const lat = Number(x.lat);
  const lng = Number(x.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const address = typeof x.display_name === "string" ? x.display_name.slice(0, 500) : "";
  const name = (typeof x.name === "string" && x.name.trim() ? x.name.trim() : address.split(",")[0]?.trim() || "").slice(0, 300);
  return { name: name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`, ...(address ? { address } : {}), lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

async function geocoderJson(path: string): Promise<unknown> {
  warnMapsContact();
  const got = await throttled(() => getBytes(`${geocoderBase()}${path}`, "application/json", GEO_BYTES, 8000));
  if (!got) return null;
  try {
    return JSON.parse(got.bytes.toString("utf8"));
  } catch {
    return null;
  }
}

/** Place names in the reader's language (any interface language; English otherwise). */
const langOf = (lang: string) => (isLocale(lang) ? lang : "en");

/** Places matching an address or a name (up to 6). Null: the geocoder did not answer. */
export async function searchPlaces(q: string, lang = "en", now = Date.now()): Promise<PlaceValue[] | null> {
  const query = q.replace(/\s+/g, " ").trim().slice(0, 200);
  if (query.length < 2) return [];
  const key = `s:${langOf(lang)}:${query.toLowerCase()}`;
  const hit = cacheGet(key, now);
  if (hit) return hit;
  const raw = await geocoderJson(`/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}&accept-language=${langOf(lang)}`);
  if (!Array.isArray(raw)) return null;
  const out = raw.map(toPlace).filter((p): p is PlaceValue => p !== null);
  cachePut(key, out, now);
  return out;
}

/** The place at a point (a dropped pin, "Use current location"). Null: nothing there or no answer. */
export async function reversePlace(lat: number, lng: number, lang = "en", now = Date.now()): Promise<PlaceValue | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const la = lat.toFixed(5);
  const ln = lng.toFixed(5);
  const key = `r:${langOf(lang)}:${la},${ln}`;
  const hit = cacheGet(key, now);
  if (hit) return hit[0] ?? null;
  const raw = await geocoderJson(`/reverse?format=jsonv2&zoom=18&lat=${la}&lon=${ln}&accept-language=${langOf(lang)}`);
  if (raw === null) return null;
  const p = toPlace(raw);
  // The point itself stays where it was put; the answer only names it.
  const place = p ? { ...p, lat: Number(la), lng: Number(ln) } : null;
  cachePut(key, place ? [place] : [], now);
  return place;
}
