"use client";

// How Documents are opened from outside the page: the desktop app's quick
// search window (/docs#search), files shared to the installed app (the
// service worker keeps them in a cache: /docs?share=<id>), .md / .html
// files opened with the installed app (the File Handling API's launch
// queue), and "Open links in desktop app" handing a page to the desktop app.
// Imports go through the local store like the Import dialog, so they work
// offline and sync later.

import { useEffect, useRef, useState } from "react";
import { openInDesktop, shouldHandOff, stayInBrowser } from "@/lib/apps";
import { noteSlug } from "@/lib/notes/model";
import type { NotesStore } from "@/lib/notes/store";
import type { NotesT } from "@/lib/notes/i18n";
import { toast } from "./ui";

const SHARE_CACHE = "zv-share";
const SHARE_ID = /^[a-f0-9]{32}$/;
const IMPORTABLE = /\.(md|markdown|html?|txt)$/i;

interface LaunchFile {
  getFile(): Promise<File>;
}
interface LaunchQueue {
  setConsumer(fn: (params: { files?: readonly LaunchFile[] }) => void): void;
}

/** The files a share left in the service worker's cache (and the entries, to drop afterwards). */
export async function takeShared(id: string): Promise<File[]> {
  if (!SHARE_ID.test(id) || typeof caches === "undefined") return [];
  const cache = await caches.open(SHARE_CACHE);
  const prefix = `/__zv-share/${id}/`;
  const meta = await cache.match(`${prefix}meta`);
  if (!meta) return [];
  const { files = [] } = (await meta.json().catch(() => ({}))) as { files?: string[] };
  const out: File[] = [];
  for (let i = 0; i < Math.min(files.length, 10); i++) {
    const r = await cache.match(`${prefix}${i}`);
    if (!r) continue;
    let name = files[i] ?? "file";
    try {
      name = decodeURIComponent(r.headers.get("x-name") ?? name);
    } catch {
      // The name from the list stays.
    }
    out.push(new File([await r.blob()], name, { type: r.headers.get("content-type") ?? "" }));
  }
  for (const k of await cache.keys()) if (new URL(k.url).pathname.startsWith(prefix)) await cache.delete(k);
  // Shares nobody picked up (a closed tab) go after a day.
  for (const k of await cache.keys()) {
    const m = /^\/__zv-share\/([a-f0-9]{32})\/meta$/.exec(new URL(k.url).pathname);
    if (!m) continue;
    const at = ((await (await cache.match(k))?.json().catch(() => null)) as { at?: number } | null)?.at ?? 0;
    if (Date.now() - at > 86_400_000) for (const x of await cache.keys()) if (new URL(x.url).pathname.startsWith(`/__zv-share/${m[1]}/`)) await cache.delete(x);
  }
  return out;
}

export function useAppLaunch(opts: { ready: boolean; store: NotesStore; upload: (f: File) => Promise<string>; readOnly: boolean; openSearch: () => void; openPage: (id: string) => void; t: NotesT }): void {
  const { ready, store, upload, readOnly, openSearch, openPage, t } = opts;
  const once = useRef(false);
  // The address as the app was opened: the start route rewrites it before the store is ready.
  const [launch] = useState(() => (typeof location === "undefined" ? { search: false, share: null } : { search: location.hash === "#search", share: new URLSearchParams(location.search).get("share") }));

  // "Open links in desktop app": a page opened from elsewhere goes to the app (once per load).
  useEffect(() => {
    if (!shouldHandOff()) return;
    if (openInDesktop(location.href)) toast(t("desktop.opening"), { label: t("desktop.openHere"), run: stayInBrowser }, 10_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The quick search window comes back to /docs#search without reloading (only the fragment changes).
  useEffect(() => {
    if (!ready) return;
    const onHash = () => location.hash === "#search" && openSearch();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [ready, openSearch]);

  useEffect(() => {
    if (!ready || once.current) return;
    once.current = true;
    if (launch.search) openSearch();
    const importAll = async (files: File[]) => {
      const list = files.filter((f) => IMPORTABLE.test(f.name));
      if (!list.length) return;
      if (readOnly) return toast(t("launch.readOnly"));
      try {
        const { importFile } = await import("./importer");
        let first: string | null = null;
        let skipped = 0;
        for (const f of list) {
          const r = await importFile(f, store, upload, null);
          if (r.root) first ??= r.root.id;
          skipped += (r.skipped ?? []).reduce((n, x) => n + (x.count ?? 1), 0) + (r.skippedMore ?? 0);
        }
        // What a ZIP left out is listed in the Import dialog; here, how many.
        toast(skipped ? t("import.skippedToast", { n: skipped }) : t("launch.imported"));
        const n = first ? store.get(first) : undefined;
        if (n) {
          history.replaceState(null, "", `/docs#${noteSlug(n)}`);
          openPage(n.id);
        }
      } catch {
        toast(t("launch.failed"));
      }
    };
    const share = launch.share;
    if (share) {
      const params = new URLSearchParams(location.search);
      if (params.has("share")) {
        params.delete("share");
        history.replaceState(null, "", `/docs${params.size ? `?${params}` : ""}${location.hash}`);
      }
      void takeShared(share).then(importAll);
    }
    const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
    queue?.setConsumer((p) => {
      if (!p.files?.length) return;
      void Promise.all(p.files.map((h) => h.getFile())).then(importAll, () => toast(t("launch.failed")));
    });
  }, [ready, store, upload, readOnly, openSearch, openPage, t, launch]);
}
