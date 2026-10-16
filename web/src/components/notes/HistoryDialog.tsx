"use client";

// Page history (Notion's): the selected version on the left, read-only,
// with what it changed highlighted ("Highlight changes"); the versions on
// the right, by day, with who made each; "Restore version" below them.
// Signed in, the history is the workspace's (lib/notes/versions.ts, the
// same for every member); a guest, or the server out of reach, falls back to
// the versions this browser kept.

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useNotes } from "./context";
import { Modal, toast } from "./ui";
import { Avatar, dayLabel, timeLabel, VersionDiff, whoName } from "./history-render";
import { blocksToMarkdown, mdToHtml } from "@/lib/notes/markdown";
import { fetchVersion, fetchVersions } from "@/lib/notes/history-client";
import type { Note } from "@/lib/notes/types";

interface Entry {
  key: string;
  at: number;
  by: string | null;
  kind: "edit" | "delete" | "suggestion";
  /** An accepted suggestion (by = who suggested it): who accepted it. */
  acceptedBy?: string;
  load: () => Promise<Note>;
}

export function HistoryDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const api = useNotes();
  const { t, locale, store, snap, user } = api;
  // Restoring a version is editing the page.
  const readOnly = !api.canEdit(note.id);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [source, setSource] = useState<"server" | "local">(user ? "server" : "local");
  const [sel, setSel] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(true);
  const [shown, setShown] = useState<{ key: string; after: Note; before: Note | null } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const ws = user?.ws.id ?? null;

  useEffect(() => {
    let live = true;
    const local = async () => {
      const h = await store.history(note.id);
      if (!live) return;
      setSource("local");
      setEntries(h.map((x) => ({ key: x.key, at: x.at, by: null, kind: "edit", load: () => Promise.resolve({ ...note, title: x.title, content: x.content }) })));
    };
    if (!ws) void local();
    else
      fetchVersions(ws, note.id).then(
        (r) => {
          if (!live) return;
          setNames(r.names);
          setSource("server");
          setEntries(r.versions.map((v) => ({ key: String(v.id), at: v.at, by: v.by, kind: v.kind, ...(v.acceptedBy ? { acceptedBy: v.acceptedBy } : {}), load: () => fetchVersion(ws, note.id, v.id) })));
        },
        () => void local()
      );
    return () => {
      live = false;
    };
    // The note's own edits while the dialog is open do not reload the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, store, ws]);

  const key = sel ?? entries?.[0]?.key ?? null;
  useEffect(() => {
    if (!entries || !key) return;
    const i = entries.findIndex((e) => e.key === key);
    if (i < 0) return;
    let live = true;
    const prev = entries[i + 1];
    Promise.all([entries[i].load(), prev ? prev.load().catch(() => null) : Promise.resolve(null)]).then(
      ([after, before]) => live && setShown({ key, after, before }),
      () => live && setFailedKey(key)
    );
    return () => {
      live = false;
    };
  }, [entries, key]);

  // Versions by day, newest first (Notion's list).
  const groups = useMemo(() => {
    const out: { label: string; items: Entry[] }[] = [];
    for (const e of entries ?? []) {
      const label = dayLabel(t, locale, e.at);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [entries, locale, t]);

  const view = shown && shown.key === key ? shown : null;
  const failed = !view && failedKey !== null && failedKey === key;
  // Off: the version as it reads (Markdown keeps its formatting).
  const plain = useMemo(
    () => (view && !highlight ? mdToHtml(`# ${view.after.title || t("page.untitled")}\n\n${blocksToMarkdown(view.after.content, (id) => snap.byId.get(id))}`) : ""),
    [view, highlight, snap.byId, t]
  );

  const restore = () => {
    if (readOnly || !view) return;
    const v = view.after;
    const patch: Partial<Note> = { title: v.title, content: structuredClone(v.content), icon: v.icon, cover: v.cover };
    if (note.kind === "database" && v.db) patch.db = structuredClone(v.db);
    if (v.props && note.props) patch.props = structuredClone(v.props);
    store.update(note.id, patch);
    toast(t("history.restored"));
    onClose();
  };

  const selected = entries?.find((e) => e.key === key);
  return (
    <Modal onClose={onClose} label={t("history.title")} className="nt-tpl nt-history">
      <div className="nt-tpl-wrap">
        <div className="nt-tpl-preview">
          <div className="nt-tpl-preview-head">
            <label className="nt-hist-toggle">
              <button type="button" role="switch" aria-checked={highlight} className="nt-switch nt-btn-reset" onClick={() => setHighlight((h) => !h)}>
                <span />
              </button>
              {t("history.highlight")}
            </label>
            <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} onClick={onClose}>
              <X />
            </button>
          </div>
          <div className="nt-tpl-preview-body nt-md nt-hist-body">
            {failed ? (
              <p className="nt-hist-empty">{t("history.loadFailed")}</p>
            ) : !view ? (
              entries && entries.length === 0 ? null : <p className="nt-hist-empty">{t("app.loading")}</p>
            ) : highlight ? (
              <>
                {selected?.kind === "delete" && <p className="nt-hist-empty">{t("history.beforeDelete")}</p>}
                {!view.before && <p className="nt-hist-empty">{t("history.first")}</p>}
                <VersionDiff before={view.before} after={view.after} highlight api={api} />
              </>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: plain }} />
            )}
          </div>
        </div>
        <div className="nt-tpl-list nt-hist-list">
          <h2>{t("history.title")}</h2>
          <p>{source === "server" ? t("history.noteServer") : user ? t("history.offline") : t("history.note")}</p>
          <div className="nt-hist-scroll">
            {groups.map((g) => (
              <div key={g.label} className="nt-hist-group">
                <div className="nt-menu-label">{g.label}</div>
                {g.items.map((e) => {
                  const name = whoName(t, e.by, names);
                  return (
                    <div key={e.key} className="nt-item nt-hist-item" role="button" tabIndex={0} data-active={e.key === key || undefined} onClick={() => setSel(e.key)} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), setSel(e.key))}>
                      <span className="nt-item-label">
                        {timeLabel(locale, e.at)}
                        {e.kind === "delete" ? ` · ${t("history.beforeDelete")}` : ""}
                        {source === "server" && (
                          <span className="nt-hist-who">
                            <Avatar name={name} />
                            {e.kind === "suggestion" ? t("history.suggestion", { name, by: whoName(t, e.acceptedBy ?? null, names) }) : name}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {entries && entries.length === 0 && <p style={{ paddingTop: 12 }}>{source === "server" ? t("history.emptyServer") : t("history.empty")}</p>}
          </div>
          <div className="nt-hist-foot">
            <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" disabled={readOnly || !view} onClick={restore}>
              {t("history.restore")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
