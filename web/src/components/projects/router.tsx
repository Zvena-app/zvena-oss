"use client";

// Client-side routes of Projects (/projects/...): screens switch instantly
// through the History API, every state worth sharing (screen, filters,
// display, the issue in the side panel) lives in the URL, and a reload or a
// copied link opens the same place. The workspace (?ws=) is kept on every link.

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { Store, useStore, workspaceId } from "./data";

export interface Loc {
  path: string[];
  params: URLSearchParams;
  key: number;
}

const BASE = "/projects";

function read(key = 0): Loc {
  if (typeof window === "undefined") return { path: [], params: new URLSearchParams(), key };
  const rest = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : "";
  return {
    path: rest
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s)),
    params: new URLSearchParams(location.search),
    key,
  };
}

let seq = 0;
export const loc = new Store<Loc>(read());

// Leaving Projects for another section is a client navigation now (the rail):
// until it lands, this page is still mounted and an answer arriving late (a
// screen's redirect, onboarding) must not push a Projects address over it —
// that cancelled the navigation. A plain click on a link out of /projects
// marks the leave; Projects mounting again (stay()) clears it, and so does
// still being on /projects 5 s later.
let leaving = false;
export function stay(): void {
  leaving = false;
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => loc.set(read(++seq)));
  document.addEventListener(
    "click",
    (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || !location.pathname.startsWith(BASE) || u.pathname.startsWith(BASE)) return;
      leaving = true;
      // Still here a while later (the click opened something in place, or the way out failed): Projects goes on routing.
      setTimeout(() => {
        if (location.pathname.startsWith(BASE)) leaving = false;
      }, 5000);
    },
    true
  );
}

/**
 * Takes the address the app is mounting for: Projects opened by a client
 * navigation (the rail) renders before the browser's address changes, and
 * `loc` may still hold where Projects was left — so the address comes from
 * Next's router (usePathname/useSearchParams), not from `location`.
 */
export function syncLoc(pathname: string, search: string): void {
  if (typeof window === "undefined") return;
  const cur = loc.get();
  const path = (pathname.startsWith(BASE) ? pathname.slice(BASE.length) : "")
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  if (path.join("/") !== cur.path.join("/") || search !== cur.params.toString()) loc.set({ path, params: new URLSearchParams(search), key: ++seq });
}

export function useLoc(): Loc {
  return useStore(loc);
}

/** A URL inside Projects: `/issue/ZVN-1` + params, with the workspace kept. */
export function href(path: string, params?: Record<string, string | null | undefined> | URLSearchParams): string {
  // A path may carry its own query ("/team/X/issues?layout=board"): it merges with `params`.
  const q = path.indexOf("?");
  const own = q >= 0 ? new URLSearchParams(path.slice(q + 1)) : null;
  if (q >= 0) path = path.slice(0, q);
  const p = params instanceof URLSearchParams ? new URLSearchParams(params) : new URLSearchParams();
  if (own) for (const [k, v] of own) if (!p.has(k)) p.set(k, v);
  if (!(params instanceof URLSearchParams)) for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== "") p.set(k, v);
  p.delete("ws");
  const ws = workspaceId();
  const qs = [ws ? `ws=${encodeURIComponent(ws)}` : "", p.toString()].filter(Boolean).join("&");
  return `${BASE}${path === "/" ? "" : path}${qs ? `?${qs}` : ""}`;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (leaving) return;
  const url = to.startsWith(BASE) ? to : href(to);
  if (url === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  loc.set(read(++seq));
  if (!opts.replace) document.querySelector(".pj-main")?.scrollTo?.({ top: 0 });
}

/** Changes query parameters of the current screen (filters, display, side panel). */
export function setParams(changes: Record<string, string | null>, opts: { replace?: boolean } = { replace: true }): void {
  if (leaving) return;
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === "") p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ""}`;
  if (opts.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  loc.set(read(++seq));
}

/** Replaces all screen parameters except the workspace and the side panel. */
export function replaceParams(p: URLSearchParams): void {
  if (leaving) return;
  const cur = new URLSearchParams(location.search);
  const next = new URLSearchParams(p);
  for (const k of ["ws", "peek"]) {
    const v = cur.get(k);
    if (v) next.set(k, v);
  }
  const qs = next.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
  loc.set(read(++seq));
}

/** A link that switches screens without a page load (Ctrl/Cmd/middle click still open a tab). */
export function Link({ to, children, onNavigate, ...rest }: { to: string; children: ReactNode; onNavigate?: () => void } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const url = to.startsWith(BASE) ? to : href(to);
  return (
    <a
      {...rest}
      href={url}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigate?.();
        navigate(url);
      }}
    >
      {children}
    </a>
  );
}

/** Copies issues' identifiers ("KEY-12, KEY-13") or links (one per line); false when the clipboard refused. */
export async function copyIssueRefs(issues: readonly { identifier: string }[], what: "id" | "link"): Promise<boolean> {
  if (!issues.length) return false;
  const text = what === "id" ? issues.map((i) => i.identifier).join(", ") : issues.map((i) => `${location.origin}${href(`/issue/${i.identifier}`)}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
