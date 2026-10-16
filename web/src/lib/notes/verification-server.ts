// Server-only: wiki verification rules and upkeep (Notion).
// Daily: a verification past its day goes back to unverified (it reads
// "Expired"); owners hear of it a week before and when it happens. The
// rules for pushes are in wiki-guard.ts.

import { notify } from "../eco/inbox";
import { sql } from "../store";
import { pushNotes } from "./server-store";
import type { DbSchema, Note, VerificationValue } from "./types";
import { intlOf } from "@/i18n/locales";
import "../../i18n/server-catalogs";
import { userLocale } from "../user-locale";
import { workspaceTz } from "./automations-server";
import { notesT } from "./i18n";
import { localYmd } from "./dates";
import { timeZoneOf } from "./reminders-server";
import { zonedNow } from "./schedule";
import { VERIFY_WARN_DAYS, isVerification, ownersOf } from "./verification";

const USER_RE = /^[A-Za-z0-9_-]{6,64}$/;

type Notifier = typeof notify;
let send: Notifier = notify;
/** Tests listen to what would reach the Inbox. */
export function setVerifyNotifierForTests(fn: Notifier): Notifier {
  const prev = send;
  send = fn;
  return prev;
}

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Daily upkeep

function noticed(ws: string, noteId: string, propId: string, until: string, kind: "soon" | "expired", now: number): boolean {
  const r = sql("INSERT OR IGNORE INTO note_verify_notices (ws, note_id, prop_id, until, kind, at) VALUES (?, ?, ?, ?, ?, ?)").run(ws, noteId, propId, until, kind, now);
  return Number(r.changes) === 0;
}

function tell(ws: string, row: Note, schema: DbSchema, v: VerificationValue, what: "soon" | "expired"): void {
  const owners = ownersOf(row, schema);
  // No owners: the one who verified it.
  const to = owners.length ? owners : v.by && !v.by.includes(":") ? [v.by] : [];
  for (const u of new Set(to)) {
    // In each owner's language; the day as their calendar writes it.
    const locale = userLocale(u);
    const page = row.title || notesT(locale, "page.untitled");
    const date = v.until ? new Date(`${v.until}T00:00:00Z`).toLocaleDateString(intlOf(locale), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
    const text = what === "expired" ? notesT(locale, "verify.inboxExpired", { page }) : notesT(locale, "verify.inboxSoon", { page, date });
    send(u, { ws, kind: "reminder", ref: `note:${row.id}`, by: null, text: text.slice(0, 280) });
  }
}

/** Expires verifications past their day and warns owners before; returns how many expired. */
export function verificationUpkeep(now = Date.now()): { expired: number; warned: number } {
  // A verification lasts through its last day where the person who verified it is (their time zone), else the workspace's.
  const zones = new Map<string, { today: string; soon: string }>();
  const daysFor = (ws: string, by: string | undefined) => {
    const tz = by && USER_RE.test(by) ? timeZoneOf(by) : workspaceTz(ws);
    let z = zones.get(tz);
    if (!z) {
      const wall = zonedNow(now, tz);
      z = { today: localYmd(wall), soon: localYmd(new Date(wall.getFullYear(), wall.getMonth(), wall.getDate() + VERIFY_WARN_DAYS)) };
      zones.set(tz, z);
    }
    return z;
  };
  const rows = sql(`SELECT ws, id, json FROM notes WHERE deleted = 0 AND parent_id IS NOT NULL AND json LIKE '%"state":"verified"%' LIMIT 20000`).all() as { ws: string; id: string; json: string | null }[];
  const schemas = new Map<string, DbSchema | undefined>();
  const schemaOf = (ws: string, id: string) => {
    const k = `${ws}:${id}`;
    if (!schemas.has(k)) {
      const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
      let s: DbSchema | undefined;
      try {
        s = (JSON.parse(r?.json ?? "null") as Note | null)?.db;
      } catch {
        s = undefined;
      }
      schemas.set(k, s);
    }
    return schemas.get(k);
  };
  let expired = 0;
  let warned = 0;
  for (const r of rows) {
    let row: Note | null = null;
    try {
      row = JSON.parse(r.json ?? "null") as Note | null;
    } catch {
      row = null;
    }
    if (!row?.parentId || row.trashedAt) continue;
    const schema = schemaOf(r.ws, row.parentId);
    for (const p of schema?.properties.filter((x) => x.type === "verification") ?? []) {
      const v = row.props?.[p.id];
      if (!isVerification(v) || v.state !== "verified" || !v.until) continue;
      const { today, soon } = daysFor(r.ws, v.by);
      if (v.until < today) {
        const next: VerificationValue = { ...v, state: "unverified" };
        const res = pushNotes(r.ws, [{ id: row.id, note: { ...row, props: { ...(row.props ?? {}), [p.id]: next } }, fields: [`props.${p.id}`] }], { by: "automation:verification", quotaLeft: Infinity });
        if (!res.saved.length) continue;
        expired += 1;
        if (!noticed(r.ws, row.id, p.id, v.until, "expired", now)) tell(r.ws, row, schema as DbSchema, v, "expired");
      } else if (v.until <= soon && !noticed(r.ws, row.id, p.id, v.until, "soon", now)) {
        warned += 1;
        tell(r.ws, row, schema as DbSchema, v, "soon");
      }
    }
  }
  sql("DELETE FROM note_verify_notices WHERE at < ?").run(now - 400 * DAY);
  return { expired, warned };
}
