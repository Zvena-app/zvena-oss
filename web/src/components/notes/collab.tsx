"use client";

// zvena Documents: a page edited together (Notion's live collaboration).
// useCollab opens the page's co-editing session (lib/notes/collab-client.ts)
// for signed-in members; until it answers the page reads as static text,
// and without an answer (offline, the server unreachable) the page opens in
// the editor as before, saving through sync. The people in a page show as
// avatars in the Topbar (CollabFaces), as in Notion.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Doc } from "yjs";
import type { CollabPeer, CollabProvider } from "@/lib/notes/collab-client";
import { COLLAB_META, contentHash, personColor, type CollabInit } from "@/lib/notes/collab-shared";
import type { Note } from "@/lib/notes/types";
import { useNotes } from "./context";
import { Tip } from "./ui";

export type CollabMode = "off" | "connecting" | "live" | "fallback";

export interface CollabSession {
  mode: CollabMode;
  provider: CollabProvider | null;
  init: CollabInit | null;
  /** Edits from this browser are accepted (the role may be lowered during the session). */
  canEdit: boolean;
}

// Who is in which page now: the Topbar reads the open page's list.
const peersByNote = new Map<string, CollabPeer[]>();
const peerListeners = new Set<() => void>();
const NO_PEERS: CollabPeer[] = [];

function publishPeers(noteId: string, peers: CollabPeer[]): void {
  const prev = peersByNote.get(noteId) ?? NO_PEERS;
  if (JSON.stringify(prev) === JSON.stringify(peers)) return;
  if (peers.length) peersByNote.set(noteId, peers);
  else peersByNote.delete(noteId);
  peerListeners.forEach((fn) => fn());
}

export function usePagePeers(noteId: string | null | undefined): CollabPeer[] {
  return useSyncExternalStore(
    (fn) => {
      peerListeners.add(fn);
      return () => peerListeners.delete(fn);
    },
    () => (noteId ? (peersByNote.get(noteId) ?? NO_PEERS) : NO_PEERS),
    () => NO_PEERS
  );
}

/** The session's metadata: the hash and time of the last snapshot a session wrote. */
export function sessionMeta(doc: Doc): { h: string; at: number } {
  const m = doc.getMap(COLLAB_META);
  return { h: typeof m.get("h") === "string" ? (m.get("h") as string) : "", at: Number(m.get("at") ?? 0) || 0 };
}

/**
 * The page's JSON was edited outside a live session (offline, an older tab)
 * after the session's last snapshot: it is merged back into the session.
 */
export function editedOutside(note: Pick<Note, "content" | "ysnap" | "updatedAt">, doc: Doc): boolean {
  const meta = sessionMeta(doc);
  const h = contentHash(note.content);
  return h !== meta.h && note.ysnap !== h && note.updatedAt > meta.at;
}

const OFF: CollabSession = { mode: "off", provider: null, init: null, canEdit: false };
const CONNECTING: CollabSession = { mode: "connecting", provider: null, init: null, canEdit: false };
const FALLBACK: CollabSession = { mode: "fallback", provider: null, init: null, canEdit: false };

/** Opens the co-editing session of a page while `enabled`. */
export function useCollab(note: Note, enabled: boolean): CollabSession {
  const api = useNotes();
  const user = api.user;
  const latest = useRef(note);
  useEffect(() => {
    latest.current = note;
  });
  const noteId = note.id;
  const ws = user?.ws.id;
  const uid = user?.id;
  const name = user?.name;
  // One session per page, workspace and person; a new key starts over (connecting).
  const key = enabled && ws && uid ? `${ws}:${noteId}:${uid}` : "";
  const [state, setState] = useState<{ key: string; session: CollabSession }>({ key: "", session: OFF });
  useEffect(() => {
    if (!key || !ws || !uid) return;
    let live = true;
    let p: CollabProvider | null = null;
    let off = () => {};
    let retry: ReturnType<typeof setTimeout> | null = null;
    const set = (session: CollabSession) => live && setState({ key, session });
    const fallback = () => {
      p?.destroy();
      set(FALLBACK);
    };
    // The provider (and Yjs) loads with the first co-edited page, not with the workspace.
    const start = (attempt: number) => void import("@/lib/notes/collab-client")
      .then(async ({ CollabProvider }) => {
        if (!live) return;
        const prov = new CollabProvider(ws, noteId, { id: uid, name: name || "?", color: personColor(uid) });
        p = prov;
        const onPeers = () => {
          publishPeers(noteId, prov.peers());
          if (live) setState((cur) => (cur.key === key && cur.session.provider === prov && cur.session.canEdit !== prov.canEdit ? { key, session: { ...cur.session, canEdit: prov.canEdit } } : cur));
        };
        prov.awareness.on("change", onPeers);
        const unsub = prov.subscribe(onPeers);
        off = () => {
          unsub();
          prov.awareness.off("change", onPeers);
        };
        const init = await prov.connect(4000);
        if (!live) return;
        // A reader follows the session only when it holds the page as it is
        // (else the page's JSON, saved outside a session, is what there is to read).
        const ok = init.canEdit || (init.seeded && !editedOutside(api.store.get(noteId) ?? latest.current, prov.doc));
        if (!ok) {
          fallback();
          // A page just opened by its editor holds their snapshot a moment later: a reader
          // (a commenter suggesting, too) tries the session again, twice at most.
          if (attempt < 2 && live) {
            off();
            retry = setTimeout(() => live && start(attempt + 1), 2500 * (attempt + 1));
          }
          return;
        }
        set({ mode: "live", provider: prov, init, canEdit: prov.canEdit });
      })
      .catch(fallback);
    start(0);
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
      off();
      p?.destroy();
      publishPeers(noteId, []);
    };
    // The store is stable; the note is read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return OFF;
  return state.key === key ? state.session : CONNECTING;
}

/** The people in the open page, as avatars in the Topbar (Notion). */
export function CollabFaces({ noteId }: { noteId: string }) {
  const peers = usePagePeers(noteId);
  if (peers.length === 0) return null;
  const shown = peers.slice(0, 3);
  const more = peers.length - shown.length;
  return (
    <Tip label={peers.map((p) => p.name).join(", ")}>
      <div className="nt-top-faces" role="group" aria-label={peers.map((p) => p.name).join(", ")}>
        {shown.map((p) => (
          <span key={p.uid} className="nt-cm-avatar nt-top-face" style={{ background: p.color }}>
            {(p.name || "?").trim().charAt(0).toUpperCase()}
          </span>
        ))}
        {more > 0 && <span className="nt-cm-avatar nt-top-face nt-top-face-more">+{more}</span>}
      </div>
    </Tip>
  );
}
