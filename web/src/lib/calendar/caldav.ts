// Server-only: two-way sync with CalDAV servers that take app-specific
// passwords — iCloud, Fastmail, Nextcloud, Radicale, Baïkal, Zoho…
//
// Safety: the server is chosen by the person, so every request goes through
// the SSRF guard's address policy (lib/web-read.ts: public addresses only,
// checked at connect time). Only https; redirects are followed a few times,
// each re-checked, and the password is sent only to the same site it was
// given for (iCloud moves people to pNN-caldav.icloud.com). The password is
// sealed at rest (lib/calendar/seal.ts) and never leaves the server.
//
// Sync: local changes go first (PUT with If-Match / If-None-Match, DELETE),
// then the server's events in a window around today come back (REPORT
// calendar-query); a changed collection tag (getctag) tells there is anything
// new. A conflict (412) means the server wins: its copy comes back next. One
// series is one resource (its overrides inside), named by its UID.

import https from "node:https";
import zlib from "node:zlib";
import { allowedUrl, safeLookup } from "../web-read";
import { newId, sql, tx } from "../store";
import { CalAccess, calRow, type CalRow } from "./access";
import { calendarInfo, createCalendar } from "./calendars";
import { calDb } from "./db";
import { find, findAll, multistatus } from "./dav-xml";
import { afterWrite, onCalDavChange } from "./effects";
import { CalError, type EvRow } from "./events";
import { seriesIcs } from "./export";
import { importEvents, parseIcs, type ImportedEvent } from "./ics";
import { open, seal } from "./seal";
import { applyImported } from "./subscriptions";
import type { CalendarInfo } from "./types";

export interface DavAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** One HTTP request to a CalDAV server (tests hand in a fake one). */
export type DavRequest = (method: string, url: string, headers: Record<string, string>, body?: string) => Promise<DavAnswer>;

const MAX_BYTES = 8_000_000;
const TIMEOUT = 20_000;
const MAX_REDIRECTS = 3;

/** The registrable part of a host, roughly ("p52-caldav.icloud.com" → "icloud.com", "a.example.co.uk" → "example.co.uk"). */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const second = parts[parts.length - 2];
  const short = parts[parts.length - 1].length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"].includes(second);
  return parts.slice(short ? -3 : -2).join(".");
}

function once(u: URL, method: string, headers: Record<string, string>, body: string | undefined): Promise<DavAnswer> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(body) : undefined;
    const req = https.request(
      u,
      { method, lookup: safeLookup, timeout: TIMEOUT, headers: { "user-agent": "zvena-calendar/1", "accept-encoding": "gzip", ...headers, ...(data ? { "content-length": String(data.byteLength) } : {}) } },
      (res) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h[k.toLowerCase()] = v;
        let stream: NodeJS.ReadableStream = res;
        if (/gzip/i.test(h["content-encoding"] ?? "")) stream = res.pipe(zlib.createGunzip());
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new Error("too large"));
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks).toString("utf8") }));
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

/** The guarded transport, with the account's credentials for its own site only. */
export function guardedDav(user: string, pass: string, home: string): DavRequest {
  const site = siteOf(new URL(home).hostname);
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  return async (method, raw, headers, body) => {
    let u = allowedUrl(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!u || u.protocol !== "https:") throw new CalError(400, "blocked address");
      const mine = siteOf(u.hostname) === site;
      const r = await once(u, method, { ...headers, ...(mine ? { authorization: auth } : {}) }, body);
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        u = allowedUrl(new URL(r.headers.location, u).toString());
        continue;
      }
      return r;
    }
    throw new CalError(502, "too many redirects");
  };
}

const NS = `xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"`;
const propfind = (props: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`;
const XML = { "content-type": "application/xml; charset=utf-8" };

export interface RemoteCalendar {
  href: string;
  name: string;
  color: string;
}

function hrefIn(base: string, href: string): string {
  return new URL(href, base).toString();
}

async function principalOf(req: DavRequest, url: string): Promise<string | null> {
  const r = await req("PROPFIND", url, { ...XML, depth: "0" }, propfind("<d:current-user-principal/>"));
  if (r.status === 401) throw new CalError(401, "wrong user name or password");
  if (r.status !== 207) return null;
  const href = find(multistatus(r.body)[0]?.props.get("current-user-principal"), "href")?.text.trim();
  return href ? hrefIn(url, href) : null;
}

/** The calendars of an account: principal → calendar home → its event calendars. */
export async function discover(req: DavRequest, serverUrl: string): Promise<{ home: string; calendars: RemoteCalendar[] }> {
  const start = new URL(serverUrl);
  let principal = await principalOf(req, start.toString());
  if (!principal) principal = await principalOf(req, new URL("/.well-known/caldav", start).toString());
  let home: string | null = null;
  if (principal) {
    const r = await req("PROPFIND", principal, { ...XML, depth: "0" }, propfind("<c:calendar-home-set/>"));
    const href = r.status === 207 ? find(multistatus(r.body)[0]?.props.get("calendar-home-set"), "href")?.text.trim() : null;
    if (href) home = hrefIn(principal, href);
  }
  home ??= start.toString();
  const r = await req("PROPFIND", home, { ...XML, depth: "1" }, propfind("<d:resourcetype/><d:displayname/><ic:calendar-color/><c:supported-calendar-component-set/>"));
  if (r.status === 401) throw new CalError(401, "wrong user name or password");
  if (r.status !== 207) throw new CalError(502, "not a CalDAV server");
  const calendars: RemoteCalendar[] = [];
  for (const x of multistatus(r.body)) {
    if (!find(x.props.get("resourcetype"), "calendar")) continue;
    const comps = findAll(x.props.get("supported-calendar-component-set"), "comp").map((c) => (c.attrs.name ?? "").toUpperCase());
    if (comps.length && !comps.includes("VEVENT")) continue;
    const color = (x.props.get("calendar-color")?.text.trim() ?? "").slice(0, 7).toLowerCase();
    calendars.push({ href: hrefIn(home, x.href), name: (x.props.get("displayname")?.text.trim() || x.href.split("/").filter(Boolean).pop() || "Calendar").slice(0, 120), color: /^#[0-9a-f]{6}$/.test(color) ? color : "" });
  }
  return { home, calendars };
}

// ------------------------------------------------------------ accounts

interface AccountRow {
  id: string;
  ws_id: string;
  user_id: string;
  server_url: string;
  username: string;
  secret: string;
}

type ReqFactory = (user: string, pass: string, home: string) => DavRequest;
let makeReq: ReqFactory = guardedDav;

/** Tests: a fake server instead of the network. */
export function setDavTransport(f: ReqFactory | null): void {
  makeReq = f ?? guardedDav;
}

function account(acc: CalAccess, id: unknown): AccountRow {
  calDb();
  const a = typeof id === "string" ? (sql("SELECT * FROM cal_accounts WHERE id = ? AND ws_id = ? AND user_id = ?").get(id, acc.ws, acc.userId) as AccountRow | undefined) : undefined;
  if (!a) throw new CalError(404, "account not found");
  return a;
}

function requestFor(a: AccountRow): DavRequest {
  const pass = open(a.secret, `caldav:${a.id}`);
  if (pass === null) throw new CalError(401, "connect the account again");
  return makeReq(a.username, pass, a.server_url);
}

/** Connects an account (the password is checked by listing its calendars, then sealed). */
export async function connectAccount(acc: CalAccess, input: { serverUrl?: unknown; username?: unknown; password?: unknown }, now = Date.now()): Promise<{ accountId: string; calendars: RemoteCalendar[] }> {
  if (!acc.member) throw new CalError(403, "forbidden");
  const raw = typeof input.serverUrl === "string" ? input.serverUrl.trim() : "";
  const url = allowedUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!url || url.protocol !== "https:") throw new CalError(400, "use an https address");
  const username = typeof input.username === "string" ? input.username.trim().slice(0, 200) : "";
  const password = typeof input.password === "string" ? input.password.slice(0, 500) : "";
  if (!username || !password) throw new CalError(400, "user name and password required");
  if ((sql("SELECT COUNT(*) AS n FROM cal_accounts WHERE user_id = ?").get(acc.userId) as { n: number }).n >= 10) throw new CalError(429, "too many accounts");
  const found = await discover(makeReq(username, password, url.toString()), url.toString());
  const id = newId(12);
  sql("INSERT INTO cal_accounts (id, ws_id, user_id, provider, server_url, username, secret, label, created_at) VALUES (?, ?, ?, 'caldav', ?, ?, ?, ?, ?)").run(id, acc.ws, acc.userId, found.home, username, seal(password, `caldav:${id}`), url.hostname, now);
  return { accountId: id, calendars: found.calendars };
}

export async function remoteCalendars(acc: CalAccess, accountId: unknown): Promise<RemoteCalendar[]> {
  const a = account(acc, accountId);
  return (await discover(requestFor(a), a.server_url)).calendars;
}

/** One calendar of the account, synced from now on. */
export async function linkRemote(acc: CalAccess, accountId: unknown, input: { href?: unknown; name?: unknown; color?: unknown }): Promise<CalendarInfo> {
  const a = account(acc, accountId);
  const list = await discover(requestFor(a), a.server_url);
  const remote = list.calendars.find((c) => c.href === input.href);
  if (!remote) throw new CalError(404, "calendar not found");
  if (sql("SELECT 1 FROM cal_calendars WHERE account_id = ? AND remote_href = ? AND deleted_at IS NULL").get(a.id, remote.href)) throw new CalError(409, "already synced");
  const cal = createCalendar(acc, { name: typeof input.name === "string" && input.name.trim() ? input.name : remote.name, color: input.color ?? (remote.color || undefined) }, { kind: "caldav", account_id: a.id, remote_href: remote.href });
  await syncCalendar(cal.id).catch(() => undefined);
  return calendarInfo(acc, calRow(cal.id) as CalRow);
}

/** Disconnects an account: its calendars here go (the server keeps everything). */
export function removeAccount(acc: CalAccess, accountId: unknown, now = Date.now()): string[] {
  const a = account(acc, accountId);
  const cals = (sql("SELECT id FROM cal_calendars WHERE account_id = ? AND deleted_at IS NULL").all(a.id) as { id: string }[]).map((r) => r.id);
  tx(() => {
    for (const c of cals) {
      sql("UPDATE cal_events SET deleted_at = ?, dirty = 0 WHERE cal_id = ? AND deleted_at IS NULL").run(now, c);
      sql("UPDATE cal_calendars SET deleted_at = ? WHERE id = ?").run(now, c);
    }
    sql("DELETE FROM cal_accounts WHERE id = ?").run(a.id);
  });
  return cals;
}

export function accountsOf(acc: CalAccess): { id: string; label: string; username: string; calendars: number }[] {
  calDb();
  return (sql("SELECT a.id, a.label, a.username, (SELECT COUNT(*) FROM cal_calendars c WHERE c.account_id = a.id AND c.deleted_at IS NULL) AS n FROM cal_accounts a WHERE a.ws_id = ? AND a.user_id = ? ORDER BY a.created_at").all(acc.ws, acc.userId) as { id: string; label: string; username: string; n: number }[]).map((r) => ({
    id: r.id,
    label: r.label,
    username: r.username,
    calendars: Number(r.n),
  }));
}

// ------------------------------------------------------------ sync

const PAST = 180 * 86_400_000;
const AHEAD = 730 * 86_400_000;
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function resourceHref(cal: CalRow, uid: string): string {
  const base = (cal.remote_href ?? "").endsWith("/") ? (cal.remote_href as string) : `${cal.remote_href}/`;
  return new URL(`${encodeURIComponent(uid.replace(/[^A-Za-z0-9@._-]/g, "_"))}.ics`, base).toString();
}

/** Sends the calendar's local changes; returns how many series went out. */
async function push(cal: CalRow, req: DavRequest): Promise<number> {
  const dirty = (sql("SELECT DISTINCT COALESCE(parent_id, id) AS id FROM cal_events WHERE cal_id = ? AND dirty = 1 LIMIT 200").all(cal.id) as { id: string }[]).map((r) => r.id);
  let n = 0;
  for (const id of dirty) {
    const master = sql("SELECT * FROM cal_events WHERE id = ?").get(id) as EvRow | undefined;
    if (!master) continue;
    const clean = () => sql("UPDATE cal_events SET dirty = 0 WHERE id = ? OR parent_id = ?").run(id, id);
    if (master.deleted_at) {
      if (master.remote_href) {
        const r = await req("DELETE", master.remote_href, master.remote_etag ? { "if-match": master.remote_etag } : {});
        if (r.status >= 500) continue;
      }
      sql("DELETE FROM cal_events WHERE id = ? OR parent_id = ?").run(id, id);
      n++;
      continue;
    }
    const href = master.remote_href ?? resourceHref(cal, master.uid);
    const r = await req("PUT", href, { "content-type": "text/calendar; charset=utf-8", ...(master.remote_href && master.remote_etag ? { "if-match": master.remote_etag } : master.remote_href ? {} : { "if-none-match": "*" }) }, seriesIcs(id, { withAlarms: true }));
    if (r.status >= 200 && r.status < 300) {
      sql("UPDATE cal_events SET remote_href = ?, remote_etag = ?, dirty = 0 WHERE id = ? OR parent_id = ?").run(href, r.headers.etag ?? null, id, id);
      n++;
    } else if (r.status === 412 || r.status === 403 || r.status === 409) {
      // The server's copy wins (or it refuses this one): it comes back on the pull.
      clean();
      if (r.status === 403) sql("UPDATE cal_calendars SET sync_error = 'read only on the server' WHERE id = ?").run(cal.id);
      if (r.status === 412 || r.status === 409) sql("UPDATE cal_calendars SET remote_tag = NULL WHERE id = ?").run(cal.id);
    }
  }
  return n;
}

/** Brings the server's events in the window around today into the calendar. */
async function pull(cal: CalRow, req: DavRequest, now: number): Promise<{ changed: string[]; removed: number }> {
  const head = await req("PROPFIND", cal.remote_href as string, { ...XML, depth: "0" }, propfind("<cs:getctag/><d:sync-token/>"));
  if (head.status === 401) throw new CalError(401, "wrong user name or password");
  if (head.status === 404) throw new CalError(404, "the calendar is gone from the server");
  const tag = head.status === 207 ? (multistatus(head.body)[0]?.props.get("getctag")?.text.trim() || multistatus(head.body)[0]?.props.get("sync-token")?.text.trim() || "") : "";
  if (tag && tag === cal.remote_tag) return { changed: [], removed: 0 };
  const from = now - PAST;
  const to = now + AHEAD;
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const r = await req("REPORT", cal.remote_href as string, { ...XML, depth: "1" }, body);
  if (r.status !== 207) throw new CalError(502, `the server answered ${r.status}`);
  const hrefOf = new Map<ImportedEvent, { href: string; etag: string }>();
  const events: ImportedEvent[] = [];
  const hrefs = new Set<string>();
  const dirtyHrefs = new Set((sql("SELECT remote_href FROM cal_events WHERE cal_id = ? AND dirty = 1 AND remote_href IS NOT NULL").all(cal.id) as { remote_href: string }[]).map((x) => x.remote_href));
  for (const x of multistatus(r.body)) {
    const href = new URL(x.href, cal.remote_href as string).toString();
    hrefs.add(href);
    // A change made here and not sent yet wins over the server's copy until it is sent.
    if (dirtyHrefs.has(href)) continue;
    const data = x.props.get("calendar-data")?.text ?? "";
    const etag = x.props.get("getetag")?.text.trim() ?? "";
    for (const ev of importEvents(parseIcs(data), cal.tz)) {
      hrefOf.set(ev, { href, etag });
      events.push(ev);
    }
  }
  const res = applyImported(cal, events, { replace: false, keepReminders: true, now, extra: (ev) => ({ remote_href: hrefOf.get(ev)?.href ?? null, remote_etag: hrefOf.get(ev)?.etag || null }) });
  // Gone from the server (within the window, sent before, not changed here since).
  let removed = 0;
  const local = sql("SELECT id, remote_href, start_at, until_at FROM cal_events WHERE cal_id = ? AND parent_id IS NULL AND remote_href IS NOT NULL AND dirty = 0 AND deleted_at IS NULL").all(cal.id) as { id: string; remote_href: string; start_at: number; until_at: number | null }[];
  for (const l of local) {
    if (hrefs.has(l.remote_href) || l.start_at >= to || (l.until_at !== null && l.until_at < from)) continue;
    sql("DELETE FROM cal_events WHERE id = ? OR parent_id = ?").run(l.id, l.id);
    removed++;
  }
  sql("UPDATE cal_calendars SET remote_tag = ? WHERE id = ?").run(tag || null, cal.id);
  return { changed: res.seriesIds, removed };
}

const running = new Map<string, boolean>();

/** One sync of a CalDAV calendar (one at a time per calendar; a change meanwhile syncs once more). */
export async function syncCalendar(calId: string, now = Date.now()): Promise<{ ok: boolean; error?: string }> {
  if (running.has(calId)) {
    running.set(calId, true);
    return { ok: true };
  }
  running.set(calId, false);
  try {
    let out: { ok: boolean; error?: string } = { ok: true };
    do {
      running.set(calId, false);
      out = await syncOnce(calId, now);
    } while (running.get(calId));
    return out;
  } finally {
    running.delete(calId);
  }
}

async function syncOnce(calId: string, now: number): Promise<{ ok: boolean; error?: string }> {
  calDb();
  const cal = calRow(calId);
  if (!cal || cal.kind !== "caldav" || !cal.account_id || !cal.remote_href) return { ok: false, error: "not a CalDAV calendar" };
  const a = sql("SELECT * FROM cal_accounts WHERE id = ?").get(cal.account_id) as AccountRow | undefined;
  if (!a) return { ok: false, error: "account gone" };
  try {
    const req = requestFor(a);
    const sentOut = await push(cal, req);
    const res = await pull(calRow(calId) as CalRow, req, now);
    sql("UPDATE cal_calendars SET synced_at = ?, sync_error = NULL WHERE id = ?").run(now, calId);
    if (res.changed.length || res.removed || sentOut) afterWrite({ ws: cal.ws_id, by: null, seriesIds: res.changed.slice(0, 500), calIds: [cal.id], notifyGuests: false, fromRemote: true });
    return { ok: true };
  } catch (e) {
    const error = e instanceof CalError ? e.code : e instanceof Error ? e.message.slice(0, 120) : "failed";
    sql("UPDATE cal_calendars SET synced_at = ?, sync_error = ? WHERE id = ?").run(now, error, calId);
    return { ok: false, error };
  }
}

/** Every CalDAV calendar not synced for a while (the ticker). */
export async function syncDue(now = Date.now(), every = 10 * 60_000): Promise<number> {
  calDb();
  const due = sql("SELECT id FROM cal_calendars WHERE kind = 'caldav' AND deleted_at IS NULL AND (synced_at IS NULL OR synced_at < ?) ORDER BY synced_at LIMIT 10").all(now - every) as { id: string }[];
  let n = 0;
  for (const d of due) if ((await syncCalendar(d.id, now)).ok) n++;
  return n;
}

// A local change reaches the server shortly after (several quick edits go together).
const timers = new Map<string, ReturnType<typeof setTimeout>>();
onCalDavChange((calId) => {
  if (timers.has(calId)) return;
  const t = setTimeout(() => {
    timers.delete(calId);
    void syncCalendar(calId).catch(() => undefined);
  }, 1500);
  (t as { unref?: () => void }).unref?.();
  timers.set(calId, t);
});

