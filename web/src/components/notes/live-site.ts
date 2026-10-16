"use client";

// zvena Documents: published pages stay current (Notion's are live).
// "Publish" / "Update" and the quiet republish that follows edits ask the
// server for a fresh copy; the server builds it from the stored pages (what
// is under the page that the publisher can read, never below a restricted
// page) and checks full access. The quiet one (live) only refreshes a page
// published now, with the settings it was published with.

import { useEffect, useRef } from "react";
import { siteOptionsOf } from "./SiteSettings";
import { withWs } from "@/lib/notes/workspace";
import { subtreeIds, syncedIds } from "@/lib/notes/model";
import { cleanSiteOptions, type SiteOptions } from "@/lib/notes/sites";
import type { Note } from "@/lib/notes/types";
import type { NotesApi } from "./context";

type Snap = NotesApi["snap"];
type Store = NotesApi["store"];

/** The pages a site of `rootId` shows: the page, what is under it (not in the trash), and the synced blocks' content. */
export function siteNotes(snap: Snap, store: Store, rootId: string): Note[] {
  const ids = subtreeIds(rootId, snap.list).filter((id) => {
    const n = snap.byId.get(id);
    return n && (n.id === rootId || !store.isTrashed(n.id));
  });
  const all = new Set(ids);
  const queue = [...ids];
  while (queue.length) {
    for (const sid of syncedIds(snap.byId.get(queue.pop() as string)?.content)) {
      if (all.has(sid) || !snap.byId.get(sid)?.synced) continue;
      all.add(sid);
      queue.push(sid);
    }
  }
  return [...all].map((id) => snap.byId.get(id)).filter((n): n is Note => Boolean(n)).map((n) => ({ ...n, share: undefined, comments: undefined }));
}

/**
 * Publishes `note` (again) with these site settings; the share record it is
 * saved under. `live`: the quiet republish — the server refreshes a page
 * published now with its stored settings (and refuses anything else).
 */
export async function publishSite(store: Store, note: Note, settings: SiteOptions, live = false): Promise<{ id: string; key: string }> {
  const key = note.share?.key ?? crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const res = await fetch(withWs("/api/notes/share"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noteId: note.id, key, snapshot: { rootId: note.id, options: settings }, ...(live ? { live: true } : {}) }),
  });
  if (!res.ok) throw new Error(String(res.status));
  const { id } = (await res.json()) as { id: string };
  // Exactly these settings (one cleared in Site settings is gone); the quiet one only notes when.
  if (live) store.update(note.id, { share: { ...(note.share as NonNullable<Note["share"]>), at: Date.now() } }, { quiet: true });
  else store.update(note.id, { share: { id, key, at: Date.now(), ...settings } }, { quiet: true });
  return { id, key };
}

const QUIET = 4_000;

/** Keeps the published pages this person may publish (full access) current: a quiet republish a few seconds after a change. */
export function useLiveSites(api: NotesApi): void {
  const latest = useRef(api);
  useEffect(() => {
    latest.current = api;
  });
  const signedIn = Boolean(api.user) && !api.readOnly;
  useEffect(() => {
    if (!signedIn) return;
    let busy = false;
    // A republish the server refused (no longer full access, publishing off) is not tried again for the same change.
    const refused = new Map<string, number>();
    const timer = setInterval(() => {
      if (busy) return;
      const { snap, store, levelOf } = latest.current;
      const now = Date.now();
      for (const n of snap.list) {
        const at = n.share?.at;
        // Publishing is for full access (Notion; the server checks it too).
        if (!at || store.isTrashed(n.id) || levelOf(n.id) !== "full") continue;
        const changed = Math.max(...siteNotes(snap, store, n.id).map((x) => x.updatedAt));
        // Changed since it was published, and quiet for a moment (typing goes on).
        if (changed <= at || now - changed < QUIET || refused.get(n.id) === changed) continue;
        busy = true;
        void publishSite(store, n, cleanSiteOptions(siteOptionsOf(n.share)), true)
          .catch(() => refused.set(n.id, changed))
          .finally(() => {
            busy = false;
          });
        return;
      }
    }, 2_000);
    return () => clearInterval(timer);
  }, [signedIn]);
}
