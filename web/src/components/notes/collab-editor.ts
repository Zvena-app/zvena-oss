"use client";

// zvena Documents: the editor side of a co-edited page. The Yjs document is
// the page while the session is live; this keeps its JSON (note.content) in
// step for everything else that reads it (search, export, public pages,
// history, other devices offline):
//  - each editor saves its own edits (Editor.tsx `save`); one editor at a
//    time — the lowest awareness id among those editing — also saves what
//    the others did, so the JSON ends up complete without everyone writing;
//  - a snapshot is confirmed (note.ysnap = its hash, and the session's meta)
//    once its edits are on the server; an unconfirmed JSON with a newer
//    time means the page was edited outside a session and is merged back in;
//  - an empty session is seeded from the page's JSON by one browser at a time;
//  - this tab's own writes to the page outside the editor (a sub-page added
//    from the sidebar, a template) go into the session at once.

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { CollabProvider } from "@/lib/notes/collab-client";
import { COLLAB_META, contentHash } from "@/lib/notes/collab-shared";
import type { NotesStore } from "@/lib/notes/store";
import type { Note } from "@/lib/notes/types";
import type { NotesEditor } from "./blocks";
import { editedOutside, sessionMeta } from "./collab";
import { withoutSuggesting } from "./suggest";

const DESIGNATED_DELAY = 1500;
const RECONCILE_DELAY = 2500;
const SEED_WAIT = 11_000;

type BlockLike = { id?: string; [k: string]: unknown };

/**
 * Brings the editor to `next` with the fewest changes (by block id): new
 * blocks are inserted in place, gone ones removed, changed ones updated — so
 * the others' cursors and typing elsewhere in the page are left alone.
 */
export function applyContent(editor: NotesEditor, next: unknown[]): void {
  const target = (next.length ? next : [{ type: "paragraph" }]) as BlockLike[];
  // What comes from outside the editor is never a suggestion (suggest.ts).
  withoutSuggesting(() => editor.transact(() => {
    const keep = new Set(target.map((b) => b.id).filter((id): id is string => typeof id === "string"));
    const gone = (editor.document as BlockLike[]).filter((b) => !keep.has(b.id as string));
    let prev: string | null = null;
    for (const b of target) {
      const had = typeof b.id === "string" ? (editor.getBlock(b.id) as BlockLike | undefined) : undefined;
      if (had) {
        if (JSON.stringify(had) !== JSON.stringify({ ...had, ...b })) editor.updateBlock(had.id as string, b as never);
        prev = had.id as string;
        continue;
      }
      const ref: string | undefined = prev ?? ((editor.document[0] as BlockLike | undefined)?.id as string | undefined);
      const placed = (ref ? editor.insertBlocks([b] as never, ref, prev ? "after" : "before") : []) as BlockLike[];
      if (placed[0]?.id) prev = placed[0].id as string;
    }
    if (gone.length) editor.removeBlocks(gone.map((b) => b.id as string));
  }));
}

export function useCollabEditor(opts: {
  editor: NotesEditor;
  collab: CollabProvider | null | undefined;
  noteId: string;
  store: NotesStore;
  readOnly: boolean;
  /** The JSON the editor last wrote (shared with Editor.tsx's save). */
  lastContentRef: MutableRefObject<unknown[]>;
  /** The note as the store has it now (updates arrive from sync). */
  note: Note;
}): { confirm: (doc: unknown[]) => void } {
  const { editor, collab, noteId, store, readOnly, lastContentRef, note } = opts;
  const confirmSeq = useRef(0);
  const reconciled = useRef("");
  const readOnlyNow = useRef(readOnly);
  useEffect(() => {
    readOnlyNow.current = readOnly;
  }, [readOnly]);

  /** Marks the JSON as the session's once its edits are on the server. */
  const confirm = useCallback(
    (doc: unknown[]) => {
      if (!collab || !collab.canEdit) return;
      const h = contentHash(doc);
      const seq = ++confirmSeq.current;
      void collab.whenSent(3000).then((sent) => {
        if (!sent || seq !== confirmSeq.current || collab.status !== "live") return;
        const cur = store.get(noteId);
        if (!cur || contentHash(cur.content) !== h) return;
        if (cur.ysnap !== h) store.update(noteId, { ysnap: h }, { quiet: true });
        const meta = collab.doc.getMap(COLLAB_META);
        if (meta.get("h") !== h || meta.get("at") !== cur.updatedAt) {
          collab.doc.transact(() => {
            meta.set("h", h);
            meta.set("at", cur.updatedAt);
          });
        }
      });
    },
    [collab, noteId, store]
  );

  /** Writes the editor's document as the page's JSON (no side effects on sub-pages). */
  const snapshot = useCallback(() => {
    if (!collab || readOnlyNow.current || !collab.canEdit) return;
    const doc = editor.document as unknown[];
    const h = contentHash(doc);
    const cur = store.get(noteId);
    if (cur && contentHash(cur.content) === h) {
      lastContentRef.current = cur.content;
      confirm(cur.content);
      return;
    }
    lastContentRef.current = doc;
    store.update(noteId, { content: doc });
    confirm(doc);
  }, [collab, confirm, editor, lastContentRef, noteId, store]);

  // One editor (the lowest awareness id among those editing) also saves what the others did.
  useEffect(() => {
    if (!collab) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const designated = () => {
      if (!collab.canEdit) return false;
      let low = collab.doc.clientID;
      for (const [id, s] of collab.awareness.getStates()) if ((s as { editing?: boolean }).editing && id < low) low = id;
      return low === collab.doc.clientID;
    };
    const off = editor.onChange((_ed, { getChanges }) => {
      let remote = false;
      try {
        remote = getChanges().some((c) => c.source.type === "yjs-remote");
      } catch {
        remote = true;
      }
      if (!remote || !designated()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(snapshot, DESIGNATED_DELAY);
    });
    // Back online: what this browser saved meanwhile is the session's again once resynced.
    let was = collab.status;
    const offStatus = collab.subscribe(() => {
      if (was !== "live" && collab.status === "live") setTimeout(snapshot, 300);
      was = collab.status;
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (typeof off === "function") off();
      offStatus();
    };
  }, [collab, editor, snapshot]);

  // An empty session is filled from the page's JSON — by this browser when the server says so,
  // or later when the browser asked first went away without doing it.
  useEffect(() => {
    if (!collab || !collab.canEdit) return;
    let stop = false;
    const seed = () => {
      if (stop || sessionMeta(collab.doc).h) return;
      const cur = store.get(noteId);
      // What the person already typed into the empty session (a new page, typed at once) is kept:
      // the page's JSON goes in first, their blocks after it — never typed away by the seed.
      const typed = (editor.document as { type?: string; content?: unknown; children?: unknown[] }[]).filter((b) => !(b.type === "paragraph" && (!Array.isArray(b.content) || b.content.length === 0) && !b.children?.length));
      const stored = cur?.content ?? [];
      const next = typed.length ? [...stored, ...typed] : stored;
      if (!(typed.length && stored.length === 0)) {
        try {
          applyContent(editor, next);
        } catch {
          withoutSuggesting(() => editor.replaceBlocks(editor.document, (next.length ? next : [{ type: "paragraph" }]) as never));
        }
      }
      const doc = editor.document as unknown[];
      const h = contentHash(doc);
      // The session holds the page from now on (confirmed for the JSON once sent).
      collab.doc.getMap(COLLAB_META).set("h", h);
      lastContentRef.current = doc;
      store.update(noteId, { content: doc });
      confirm(doc);
    };
    if (collab.init?.seed) {
      const t = setTimeout(seed, 0);
      return () => {
        stop = true;
        clearTimeout(t);
      };
    }
    if (sessionMeta(collab.doc).h) return;
    const t = setTimeout(() => {
      if (stop || sessionMeta(collab.doc).h) return;
      void collab.claim().then((ok) => ok && seed());
    }, SEED_WAIT);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [collab, confirm, editor, lastContentRef, noteId, store]);

  // This tab's own writes to the page outside the editor go into the session at once.
  useEffect(() => {
    if (!collab) return;
    return store.onLocalWrite((prev, next) => {
      if (next.id !== noteId || next.content === prev?.content || next.content === lastContentRef.current) return;
      if (readOnlyNow.current || !collab.canEdit) return;
      lastContentRef.current = next.content;
      try {
        applyContent(editor, next.content);
      } catch {
        return;
      }
      confirm(editor.document as unknown[]);
    });
  }, [collab, confirm, editor, lastContentRef, noteId, store]);

  // The page's JSON edited outside a session (offline, an older tab) and newer than the session: merged back in.
  const content = note.content;
  useEffect(() => {
    if (!collab || !collab.canEdit || readOnlyNow.current) return;
    const check = () => {
      const cur = store.get(noteId);
      if (!cur || !sessionMeta(collab.doc).h || !editedOutside(cur, collab.doc)) return;
      const h = contentHash(cur.content);
      if (reconciled.current === h || h === contentHash(editor.document)) return;
      void collab.claim().then((ok) => {
        if (!ok) return;
        const now = store.get(noteId);
        if (!now || contentHash(now.content) !== h || !editedOutside(now, collab.doc)) return;
        reconciled.current = h;
        lastContentRef.current = now.content;
        try {
          applyContent(editor, now.content);
        } catch {
          return;
        }
        snapshot();
      });
    };
    // At the session start at once; for a change from sync a little later, when the session's own
    // snapshot (whose confirmation travels separately) has had time to arrive.
    const t = setTimeout(check, content === lastContentRef.current ? 0 : RECONCILE_DELAY);
    return () => clearTimeout(t);
  }, [collab, content, editor, lastContentRef, noteId, snapshot, store]);

  return { confirm };
}
