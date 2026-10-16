// zvena Documents: the math of the Map view (Web Mercator, as every web map
// uses): where a point lands on the screen at a zoom, which 256 px tiles
// cover the view, pins that crowd together drawn as one cluster, and the
// view that shows every pin. Pure functions (no DOM), shared with the tests.

export const TILE = 256;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 19;
const MAX_LAT = 85.05112878;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Point {
  x: number;
  y: number;
}

const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
export const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));

/** World pixels at `zoom` (the world is 256·2^zoom wide). */
export function project(p: LatLng, zoom: number): Point {
  const size = TILE * 2 ** zoom;
  const s = Math.sin((clampLat(p.lat) * Math.PI) / 180);
  return { x: ((p.lng + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}

export function unproject(pt: Point, zoom: number): LatLng {
  const size = TILE * 2 ** zoom;
  const lng = (pt.x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * pt.y) / size;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  // Longitudes wrap around the globe; latitudes stop at the Mercator edge.
  return { lat: clampLat(lat), lng: ((((lng + 180) % 360) + 360) % 360) - 180 };
}

export interface TileSpot {
  key: string;
  z: number;
  x: number;
  y: number;
  left: number;
  top: number;
}

/** The tiles covering a `width`×`height` view centred on `center` (x wraps around the globe). */
export function visibleTiles(center: LatLng, zoom: number, width: number, height: number): TileSpot[] {
  const z = clampZoom(zoom);
  const n = 2 ** z;
  const c = project(center, z);
  const left = c.x - width / 2;
  const top = c.y - height / 2;
  const out: TileSpot[] = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx++) {
      const x = ((tx % n) + n) % n;
      out.push({ key: `${z}/${tx}/${ty}`, z, x, y: ty, left: tx * TILE - left, top: ty * TILE - top });
    }
  }
  return out;
}

/** A point's position in the view (the copy of the world nearest the centre). */
export function toScreen(p: LatLng, center: LatLng, zoom: number, width: number, height: number): Point {
  const size = TILE * 2 ** zoom;
  const c = project(center, zoom);
  const q = project(p, zoom);
  let dx = q.x - c.x;
  if (dx > size / 2) dx -= size;
  if (dx < -size / 2) dx += size;
  return { x: width / 2 + dx, y: height / 2 + (q.y - c.y) };
}

/** The point under a position of the view. */
export function fromScreen(pt: Point, center: LatLng, zoom: number, width: number, height: number): LatLng {
  const c = project(center, zoom);
  return unproject({ x: c.x + pt.x - width / 2, y: c.y + pt.y - height / 2 }, zoom);
}

export interface Pin extends LatLng {
  id: string;
}

export interface Cluster extends LatLng {
  ids: string[];
}

/** Pins within `cell` px of each other at this zoom, grouped (one-pin groups are plain pins). */
export function clusterPins(pins: readonly Pin[], zoom: number, cell = 48): Cluster[] {
  const cells = new Map<string, { ids: string[]; lat: number; lng: number }>();
  for (const p of pins) {
    const w = project(p, zoom);
    const key = `${Math.floor(w.x / cell)}:${Math.floor(w.y / cell)}`;
    const c = cells.get(key);
    if (c) {
      c.ids.push(p.id);
      c.lat += p.lat;
      c.lng += p.lng;
    } else cells.set(key, { ids: [p.id], lat: p.lat, lng: p.lng });
  }
  return [...cells.values()].map((c) => ({ ids: c.ids, lat: c.lat / c.ids.length, lng: c.lng / c.ids.length }));
}

/** The centre and the closest zoom that show every pin with `pad` px to spare (one pin: a street view). */
export function fitPins(pins: readonly LatLng[], width: number, height: number, pad = 48, maxZoom = 15): { center: LatLng; zoom: number } {
  if (pins.length === 0) return { center: { lat: 30, lng: 10 }, zoom: 2 };
  if (pins.length === 1) return { center: { lat: pins[0].lat, lng: pins[0].lng }, zoom: maxZoom };
  const lats = pins.map((p) => p.lat);
  const lngs = pins.map((p) => p.lng);
  const sw = { lat: Math.min(...lats), lng: Math.min(...lngs) };
  const ne = { lat: Math.max(...lats), lng: Math.max(...lngs) };
  let zoom = maxZoom;
  for (; zoom > MIN_ZOOM; zoom--) {
    const a = project(sw, zoom);
    const b = project(ne, zoom);
    if (Math.abs(b.x - a.x) <= width - 2 * pad && Math.abs(a.y - b.y) <= height - 2 * pad) break;
  }
  const mid = unproject({ x: (project(sw, zoom).x + project(ne, zoom).x) / 2, y: (project(sw, zoom).y + project(ne, zoom).y) / 2 }, zoom);
  return { center: mid, zoom };
}

/** A link to the place on openstreetmap.org (opened in a new tab; the page itself never loads from there). */
export function osmLink(p: LatLng, zoom = 17): string {
  const lat = p.lat.toFixed(5);
  const lng = p.lng.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${zoom}/${lat}/${lng}`;
}
