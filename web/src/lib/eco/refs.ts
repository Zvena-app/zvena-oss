// The ecosystem's addresses: one way to name any object of any product, so
// that a doc, an issue, a project and a design frame can point at each other.
// Pure (browser, server, tests).
//
//   note:<id>                 a Documents page, database or row
//   issue:<id>                a Projects issue (internal id, never KEY-N:
//                             keys change when a team is renamed)
//   project:<id>              a Projects project, the one shared "project" of zvena
//   design:<file>             a Design file
//   design:<file>/<frame>     one frame (board) of it
//   user:<id>                 a person (an @mention in a doc or an issue)
//   event:<id>                a Calendar event (a series, or one event)
//   mail:<thread>             a Mail conversation — personal: only its owner
//                             ever gets its card (lib/eco/cards.ts)
//
// People paste links, not keys: `refFromUrl` reads every address zvena shows
// (/docs#slug, /projects/issue/KEY-N, /design?file=…, /calendar?event=…,
// Design's own #/workspace and #/view links). Identifiers and share links still need the server to
// become ids, so the parser returns them as "raw" refs.

import { idFromSlug } from "../notes/model";

export type RefKind = "note" | "issue" | "project" | "design" | "user" | "event" | "mail";
export const REF_KINDS: readonly RefKind[] = ["note", "issue", "project", "design", "user", "event", "mail"];

export type Ref =
  | { kind: "note"; id: string }
  | { kind: "issue"; id: string }
  | { kind: "project"; id: string }
  | { kind: "design"; file: string; frame?: string }
  | { kind: "user"; id: string }
  | { kind: "event"; id: string }
  | { kind: "mail"; id: string };

/** What a link names before the server resolves it. */
export type RawRef = Ref | { kind: "issue-ident"; ident: string; ws?: string } | { kind: "note-share"; id: string };

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENT_RE = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function refKey(r: Ref): string {
  if (r.kind === "design") return r.frame ? `design:${r.file}/${r.frame}` : `design:${r.file}`;
  return `${r.kind}:${r.id}`;
}

/** A ref from its key, or null when the key is not well-formed. */
export function parseRefKey(key: unknown): Ref | null {
  if (typeof key !== "string" || key.length > 160) return null;
  const i = key.indexOf(":");
  if (i < 0) return null;
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === "note" || kind === "issue" || kind === "project" || kind === "user" || kind === "event" || kind === "mail") return ID_RE.test(rest) ? { kind, id: rest } : null;
  if (kind === "design") {
    const [file, frame, extra] = rest.split("/");
    if (extra !== undefined || !isUuid(file)) return null;
    if (frame === undefined) return { kind: "design", file };
    return isUuid(frame) ? { kind: "design", file, frame } : null;
  }
  return null;
}

export function sameRef(a: Ref, b: Ref): boolean {
  return refKey(a) === refKey(b);
}

/** The file a design ref belongs to: a frame's links count for its file too. */
export function designFileKey(r: Ref): string | null {
  return r.kind === "design" ? `design:${r.file}` : null;
}

export interface Origins {
  /** zvena's own origin (https://zvena.app). */
  app: string;
  /** Design's origin (https://design.zvena.app), when it has one. */
  design?: string;
}

function hashParams(hash: string): URLSearchParams {
  const q = hash.indexOf("?");
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : "");
}

/**
 * What a link points at, when it is one of zvena's own addresses; null for
 * any other link. Relative links are read against the app's origin.
 */
export function refFromUrl(href: unknown, origins: Origins): RawRef | null {
  if (typeof href !== "string" || !href || href.length > 2000) return null;
  let u: URL;
  let app: URL;
  try {
    app = new URL(origins.app);
    u = new URL(href, app);
  } catch {
    return null;
  }
  if (origins.design) {
    let design: URL | null = null;
    try {
      design = new URL(origins.design);
    } catch {
      design = null;
    }
    if (design && u.origin === design.origin) {
      // Penpot: #/workspace?team-id&file-id&page-id[&board-id], #/view?file-id&page-id[&frame-id]
      const p = hashParams(u.hash);
      const file = p.get("file-id");
      if (!isUuid(file)) return null;
      const frame = p.get("board-id") ?? p.get("frame-id");
      return isUuid(frame) ? { kind: "design", file, frame } : { kind: "design", file };
    }
  }
  if (u.origin !== app.origin) return null;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (path === "/docs" || path === "/notes") {
    let slug: string;
    try {
      slug = decodeURIComponent(u.hash.slice(1)).split(/[?&]/)[0];
    } catch {
      // A malformed escape ("#%zz") names nothing.
      return null;
    }
    const id = slug ? idFromSlug(slug) : null;
    return id ? { kind: "note", id } : null;
  }
  const share = /^\/n\/([A-Za-z0-9_-]{6,64})$/.exec(path);
  if (share) return { kind: "note-share", id: share[1] };
  const mail = /^\/mail\/thread\/([A-Za-z0-9_-]{6,64})$/.exec(path);
  if (mail) return { kind: "mail", id: mail[1] };
  if (path === "/design") {
    const file = u.searchParams.get("file");
    if (!isUuid(file)) return null;
    const frame = u.searchParams.get("frame");
    return isUuid(frame) ? { kind: "design", file, frame } : { kind: "design", file };
  }
  if (path === "/calendar" || path.startsWith("/calendar/")) {
    const event = u.searchParams.get("event");
    return event && ID_RE.test(event) ? { kind: "event", id: event } : null;
  }
  if (path === "/projects" || path.startsWith("/projects/")) {
    const peek = u.searchParams.get("peek");
    const issue = /^\/projects\/issue\/([^/]+)$/.exec(path)?.[1] ?? null;
    const ident = issue ?? peek;
    // KEY-12 means another issue in another workspace: the link says which (?ws=).
    const ws = u.searchParams.get("ws");
    if (ident && IDENT_RE.test(ident)) return { kind: "issue-ident", ident: ident.toUpperCase(), ...(ws && /^[A-Za-z0-9_-]{8,40}$/.test(ws) ? { ws } : {}) };
    const project = /^\/projects\/project\/([A-Za-z0-9_-]{6,64})$/.exec(path);
    if (project) return { kind: "project", id: project[1] };
  }
  return null;
}

/** The address a person opens for a ref (relative to zvena's origin). */
export function refHref(r: Ref, ws: string, opts: { slug?: string; ident?: string } = {}): string {
  const q = `ws=${encodeURIComponent(ws)}`;
  switch (r.kind) {
    case "note":
      return `/docs?${q}#${opts.slug ?? r.id}`;
    case "issue":
      return `/projects/issue/${encodeURIComponent(opts.ident ?? r.id)}?${q}`;
    case "project":
      return `/projects/project/${encodeURIComponent(r.id)}?${q}`;
    case "design":
      return `/design?${q}&file=${r.file}${r.frame ? `&frame=${r.frame}` : ""}`;
    case "user":
      return `/team?${q}`;
    case "event":
      return `/calendar?${q}&event=${encodeURIComponent(r.id)}`;
    case "mail":
      return `/mail/thread/${encodeURIComponent(r.id)}?${q}`;
  }
}
