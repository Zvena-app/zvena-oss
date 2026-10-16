"use client";

// Notion's block menu "Move to": the block (with what is nested in it) goes
// to the end of another page. Sub-pages and databases inside move with it —
// their parent changes first, so leaving this page never trashes them.

import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { useNotes } from "./context";
import { Popover, toast } from "./ui";
import { NoteIcon } from "./NoteIcon";
import { ancestry, displayTitle, linkedChildIds } from "@/lib/notes/model";
import type { NotesBlock, NotesEditor } from "./blocks";

export function BlockMovePanel({ editor, block, pageId, anchor, onDone }: { editor: NotesEditor; block: NotesBlock; pageId: string | null; anchor: HTMLElement; onDone: () => void }) {
  const { t, snap, store } = useNotes();
  const [q, setQ] = useState("");
  const targets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return snap.list
      .filter((n) => n.kind === "page" && n.id !== pageId && !n.synced && !n.template && !store.isTrashed(n.id) && (!needle || n.title.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
  }, [pageId, q, snap.list, store]);
  const move = (targetId: string) => {
    const target = store.get(targetId);
    const moving = editor.getBlock(block.id);
    if (!target || !moving) return;
    const copy = JSON.parse(JSON.stringify(moving)) as NotesBlock;
    // The sub-pages in it belong to the target from now on (before the block leaves this page).
    for (const id of linkedChildIds([copy])) if (pageId && store.get(id)?.parentId === pageId) store.move(id, targetId);
    store.update(targetId, { content: [...target.content, copy] });
    editor.removeBlocks([moving]);
    toast(t("toast.moved", { where: displayTitle(target, t("page.untitled")) }));
    onDone();
  };
  return (
    <Popover anchor={anchor} onClose={onDone} placement="right-start">
      <div className="nt-panel" style={{ width: 340 }}>
        <div className="nt-panel-head">
          <input className="nt-input" autoFocus placeholder={t("block.moveToPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && targets[0] && move(targets[0].id)} />
        </div>
        <div className="nt-panel-list">
          {targets.length === 0 && <div className="nt-panel-empty">{t("search.noResults")}</div>}
          {targets.map((n) => (
            <div key={n.id} className="nt-panel-row" role="button" tabIndex={0} onClick={() => move(n.id)} onKeyDown={(e) => e.key === "Enter" && move(n.id)}>
              <span className="nt-panel-row-icon">{n.icon ? <NoteIcon icon={n.icon} /> : <FileText size={16} />}</span>
              <div className="nt-panel-row-main">
                <div className="nt-panel-row-title">{displayTitle(n, t("page.untitled"))}</div>
                <div className="nt-panel-row-sub">
                  {ancestry(n.id, snap.byId)
                    .slice(0, -1)
                    .map((x) => displayTitle(x, t("page.untitled")))
                    .join(" / ")}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Popover>
  );
}
