"use client";

// Updates (Notion's page sidebar): who edited the page and when, with the
// changes a click away, comments, and when it was created, moved, trashed
// or restored — newest first, by day. Edits come from the workspace's page
// history (one entry per person's run of versions), comments from the page.

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useNotes } from "./context";
import { Portal } from "./ui";
import { Avatar, dayLabel, timeLabel, VersionDiff, whoName } from "./history-render";
import { fetchUpdates, fetchVersion, type UpdateEvent, type VersionInfo } from "@/lib/notes/history-client";
import { displayTitle } from "@/lib/notes/model";
import type { Note, NoteComment } from "@/lib/notes/types";
import { FollowButton } from "./follow";

type Item =
  | { kind: "edits"; at: number; by: string | null; versions: VersionInfo[]; prev: VersionInfo | null; acceptedBy?: string }
  | { kind: "comment"; at: number; by: string | null; name: string; comment: NoteComment }
  | { kind: "event"; at: number; by: string | null; event: UpdateEvent };

/** A person's versions close together (an hour apart at most, the same day) read as one update. */
function editRuns(versions: readonly VersionInfo[]): Item[] {
  const out: Item[] = [];
  versions.forEach((v, i) => {
    const last = out[out.length - 1];
    const prevV = versions[i + 1] ?? null;
    if (last && last.kind === "edits" && last.by === v.by && v.kind === "edit" && last.versions[last.versions.length - 1].at - v.at < 3_600_000 && new Date(last.at).toDateString() === new Date(v.at).toDateString()) {
      last.versions.push(v);
      last.prev = prevV;
    } else if (v.kind === "edit") out.push({ kind: "edits", at: v.at, by: v.by, versions: [v], prev: prevV });
    // An accepted suggestion: its own entry, under who suggested it.
    else if (v.kind === "suggestion") out.push({ kind: "edits", at: v.at, by: v.by, versions: [v], prev: prevV, ...(v.acceptedBy ? { acceptedBy: v.acceptedBy } : {}) });
  });
  return out;
}

function Changes({ ws, note, item }: { ws: string; note: Note; item: Extract<Item, { kind: "edits" }> }) {
  const api = useNotes();
  const [pair, setPair] = useState<{ before: Note | null; after: Note } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([fetchVersion(ws, note.id, item.versions[0].id), item.prev ? fetchVersion(ws, note.id, item.prev.id).catch(() => null) : Promise.resolve(null)]).then(
      ([after, before]) => live && setPair({ before, after }),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [ws, note.id, item]);
  if (!pair) return <p className="nt-hist-empty">{api.t("app.loading")}</p>;
  return (
    <div className="nt-md nt-updates-diff">
      <VersionDiff before={pair.before} after={pair.after} highlight api={api} />
    </div>
  );
}

export function UpdatesPanel({ note, onClose }: { note: Note; onClose: () => void }) {
  const api = useNotes();
  const { t, locale, snap, user } = api;
  const ws = user?.ws.id ?? null;
  const [data, setData] = useState<{ versions: VersionInfo[]; events: UpdateEvent[]; names: Record<string, string> } | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (!ws) return;
    let live = true;
    fetchUpdates(ws, note.id).then(
      (r) => live && setData(r),
      () => live && setData({ versions: [], events: [], names: {} })
    );
    return () => {
      live = false;
    };
  }, [ws, note.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items = useMemo(() => {
    if (!data) return [];
    const list: Item[] = [
      ...editRuns(data.versions),
      ...(note.comments ?? []).map((c) => ({ kind: "comment" as const, at: c.at, by: c.authorId ?? null, name: c.author, comment: c })),
      ...data.events.filter((e) => e.kind !== "delete").map((e) => ({ kind: "event" as const, at: e.at, by: e.by, event: e })),
    ];
    list.sort((a, b) => b.at - a.at);
    // A day's heading above its first update.
    return list.map((it, i) => {
      const day = dayLabel(t, locale, it.at);
      return { it, day, first: i === 0 || dayLabel(t, locale, list[i - 1].at) !== day };
    });
  }, [data, note.comments, t, locale]);

  const place = (id: string | null | undefined) => {
    if (!id) return t("updates.top");
    const n = snap.byId.get(id);
    return n ? displayTitle(n, n.kind === "database" ? t("db.untitled") : t("page.untitled")) : t("page.untitled");
  };
  const names = data?.names ?? {};
  return (
    <Portal>
      <aside className="nt-peek nt-updates" role="dialog" aria-label={t("updates.title")}>
        <div className="nt-peek-bar">
          <b className="nt-updates-title">{t("updates.title")}</b>
          <FollowButton noteId={note.id} />
          <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="nt-peek-scroll nt-updates-list">
          {!data && <p className="nt-hist-empty">{t("app.loading")}</p>}
          {data && items.length === 0 && <p className="nt-hist-empty">{t("updates.empty")}</p>}
          {items.map(({ it, day, first }, i) => {
            const head = first ? <div className="nt-menu-label">{day}</div> : null;
            const name = it.kind === "comment" ? it.name || whoName(t, it.by, names) : whoName(t, it.by, names);
            let text = "";
            if (it.kind === "edits" && it.acceptedBy) text = t("updates.suggestionAccepted", { name, by: whoName(t, it.acceptedBy, names) });
            else if (it.kind === "edits") text = it.versions.length > 1 ? t("updates.editedN", { name, n: it.versions.length }) : t("updates.edited", { name });
            else if (it.kind === "comment" && it.comment.suggestion) text = t("updates.suggested", { name });
            else if (it.kind === "comment") text = t("updates.commented", { name });
            else if (it.event.kind === "create") text = t("updates.created", { name });
            else if (it.event.kind === "move") text = t("updates.moved", { name, from: place(it.event.from), to: place(it.event.to) });
            else if (it.event.kind === "trash") text = t("updates.trashed", { name });
            else if (it.event.kind === "restore") text = t("updates.restored", { name });
            return (
              <div key={`${it.kind}:${it.at}:${i}`}>
                {head}
                <div className="nt-updates-item">
                  <Avatar name={name} />
                  <div className="nt-updates-main">
                    <div className="nt-updates-head">
                      <span>{text}</span>
                      <span className="nt-updates-time">{timeLabel(locale, it.at)}</span>
                    </div>
                    {it.kind === "comment" && (
                      <div className="nt-updates-quote">
                        {it.comment.quote && <q>{it.comment.quote}</q>}
                        <span>{it.comment.text}</span>
                      </div>
                    )}
                    {it.kind === "edits" && ws && (
                      <>
                        <button type="button" className="nt-backlinks-btn nt-btn-reset" onClick={() => setOpen(open === i ? null : i)}>
                          {open === i ? t("updates.hideChanges") : t("updates.showChanges")}
                        </button>
                        {open === i && <Changes ws={ws} note={note} item={it} />}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </Portal>
  );
}
