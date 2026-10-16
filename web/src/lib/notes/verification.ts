// zvena Documents: wikis and page verification (Notion's "Turn into wiki").
// A wiki is a database with an Owner (person) and a Verification property;
// a page in it is verified by an owner or someone with full access, for a
// while or indefinitely, and goes back to unverified when that runs out
// (the daily upkeep, lib/notes/verification-server.ts). Pure; shared by the
// browser and the server.

import { localYmd } from "./dates";
import type { DbProperty, DbSchema, Note, PropValue, VerificationValue } from "./types";

export type { VerificationValue } from "./types";

/** How a value reads now: "expired" is a verification whose date has passed (before or after the upkeep). */
export type VerificationShown = "verified" | "expired" | "unverified";

/** Verify for: Notion's choices (null: indefinitely). */
export const VERIFY_DAYS = [7, 30, 90] as const;

/** Owners hear of it this many days before a verification expires. */
export const VERIFY_WARN_DAYS = 7;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isVerification = (v: PropValue | undefined): v is VerificationValue =>
  typeof v === "object" && v !== null && !Array.isArray(v) && ((v as VerificationValue).state === "verified" || (v as VerificationValue).state === "unverified");

/** Today's calendar day (local in the browser; the server passes its own). */
export const todayYmd = (now = Date.now()) => localYmd(new Date(now));

export function verificationState(v: PropValue | undefined, today = todayYmd()): VerificationShown {
  if (!isVerification(v)) return "unverified";
  if (v.state === "verified") return v.until && v.until < today ? "expired" : "verified";
  // The upkeep turned it to unverified and kept the date: Notion still says "Expired".
  return v.until && v.until < today ? "expired" : "unverified";
}

/** The day `days` after today (verified through the end of it). */
export function untilAfter(days: number, now = Date.now()): string {
  const d = new Date(now);
  return localYmd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/** A verification by `by` now: for `days`, until a day, or indefinitely (null). */
export function verifiedBy(by: string, until: number | string | null, now = Date.now()): VerificationValue {
  const day = typeof until === "number" ? untilAfter(until, now) : until && YMD_RE.test(until) ? until : null;
  return { state: "verified", by, at: now, ...(day ? { until: day } : {}) };
}

export const UNVERIFIED: VerificationValue = { state: "unverified" };

/** The wiki's Owner and Verification properties (null when the database is not a wiki). */
export function wikiProps(schema: DbSchema | undefined | null): { owner: DbProperty | null; verification: DbProperty | null } | null {
  if (!schema?.wiki) return null;
  const owner = schema.properties.find((p) => p.id === schema.wiki?.owner && p.type === "person") ?? null;
  const verification = schema.properties.find((p) => p.id === schema.wiki?.verification && p.type === "verification") ?? null;
  return { owner, verification };
}

/** The page owners of a wiki page (its Owner property). */
export function ownersOf(row: Note | null | undefined, schema: DbSchema | undefined | null): string[] {
  const w = wikiProps(schema);
  const v = w?.owner && row ? row.props?.[w.owner.id] : null;
  return Array.isArray(v) ? v : [];
}

/** Who may verify a wiki page: its owners and people with full access to it (Notion). */
export function canVerify(userId: string, full: boolean, row: Note | null | undefined, schema: DbSchema | undefined | null): boolean {
  return full || ownersOf(row, schema).includes(userId);
}

/** A database schema turned into a wiki: Owner and Verification are added (or reused) first after the title. */
export function asWiki(schema: DbSchema, names: { owner: string; verification: string }, newId: () => string): DbSchema {
  const owner = schema.properties.find((p) => p.id === schema.wiki?.owner && p.type === "person") ?? { id: newId(), name: names.owner, type: "person" as const };
  const verification = schema.properties.find((p) => p.type === "verification") ?? { id: newId(), name: names.verification, type: "verification" as const };
  const rest = schema.properties.filter((p) => p.id !== owner.id && p.id !== verification.id);
  const at = rest.findIndex((p) => p.type === "title") + 1;
  const properties = [...rest.slice(0, at), owner, verification, ...rest.slice(at)];
  return { ...schema, properties, wiki: { owner: owner.id, verification: verification.id } };
}

/**
 * Back to a plain database (Notion's "Turn into database" on a wiki): the
 * wiki's Owner and Verification properties go with it — they belong to the
 * wiki (Notion removes them together, and drops them from the views); the
 * other properties stay. `drop` removes one property and what points at it
 * (lib/notes/db.ts withoutProp).
 */
export function withoutWiki(schema: DbSchema, drop: (s: DbSchema, propId: string) => DbSchema): DbSchema {
  const w = wikiProps(schema);
  const { wiki: _w, ...rest } = schema;
  void _w;
  let out: DbSchema = rest;
  for (const p of [w?.owner, w?.verification]) if (p) out = drop(out, p.id);
  return out;
}
