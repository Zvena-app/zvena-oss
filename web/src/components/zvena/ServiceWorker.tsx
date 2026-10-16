"use client";

import { useEffect } from "react";
import { watchInstall } from "@/lib/apps";

// Registers public/sw.js (production builds only: the dev server's files
// change on every edit) and tells it whose page this is. On the first visit
// the worker did not see the page load, so the page hands it the files it
// loaded and its own address, and the next start works offline.

export function ServiceWorker({ scope }: { scope: string }) {
  useEffect(() => {
    watchInstall();
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const firstVisit = !navigator.serviceWorker.controller;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        const sw = navigator.serviceWorker.controller ?? reg.active;
        if (!sw) return;
        sw.postMessage({ type: "scope", scope });
        const urls = performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin));
        sw.postMessage({ type: "warm", urls, ...(firstVisit ? { page: location.pathname + location.search } : {}) });
      })
      .catch(() => {
        // No worker (private mode, a blocked registration): the app works online as before.
      });
  }, [scope]);
  return null;
}
