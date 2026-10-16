"use client";

// zvena Documents: suggested edits in the page's margin (Notion): the
// suggester's avatar beside the line each open suggestion starts on, and
// their color on the suggested text. A click opens the suggestion's card
// (ThreadPopover). Positions follow the editor's changes and resizes.

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { personColor } from "@/lib/notes/collab-shared";
import { personById } from "@/lib/notes/people";
import { suggestionEntries } from "@/lib/notes/suggestions";
import type { Note, NoteComment } from "@/lib/notes/types";
import type { NotesEditor } from "./blocks";
import { useNotes } from "./context";
import { Avatar } from "./people";
import { suggestionsIn, type OpenSuggestion } from "./suggest";

/** The element a suggestion starts at: its marked text, or its suggested line. */
export function suggestionEl(root: ParentNode | null | undefined, sid: string): HTMLElement | null {
  if (!root) return null;
  const q = CSS.escape(sid);
  const marked = root.querySelector<HTMLElement>(`.nt-sins[data-sid="${q}"], .nt-sdel[data-sid="${q}"]`);
  const line = root.querySelector<HTMLElement>(`.bn-block-outer[data-id^="sg~${q}~"]`);
  if (marked && line) return marked.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_PRECEDING ? line : marked;
  return marked ?? line;
}

/** Open suggestions in the editor (decided ones whose marks a slow copy still shows are left out). */
export function useOpenSuggestions(editor: NotesEditor, note: Note): OpenSuggestion[] {
  const [list, setList] = useState<OpenSuggestion[]>(() => suggestionsIn(editor.prosemirrorState.doc));
  useEffect(() => {
    const read = () =>
      setList((prev) => {
        const next = suggestionsIn(editor.prosemirrorState.doc);
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    read();
    return editor.onChange(read, true);
  }, [editor]);
  const records = useMemo(() => suggestionEntries(note.comments), [note.comments]);
  return useMemo(() => list.filter((s) => !records.get(s.sid)?.suggestion?.state), [list, records]);
}

/** Each suggester's color on their suggestions. */
export function SuggestColors({ comments }: { comments: readonly NoteComment[] | undefined }) {
  const css = [...suggestionEntries(comments).entries()]
    .filter(([, c]) => c.authorId)
    .map(([sid, c]) => {
      const q = CSS.escape(sid);
      return `.nt-editor [data-sid="${q}"],.nt-editor .bn-block-outer[data-id^="sg~${q}~"]{--nt-sug:${personColor(c.authorId as string)}}`;
    })
    .join("");
  return css ? <style>{css}</style> : null;
}

export function SuggestGutter({ editor, root, note, list, onOpen }: { editor: NotesEditor; root: React.RefObject<HTMLDivElement | null>; note: Note; list: OpenSuggestion[]; onOpen: (sid: string, el: HTMLElement) => void }) {
  const { t } = useNotes();
  const records = useMemo(() => suggestionEntries(note.comments), [note.comments]);
  const [spots, setSpots] = useState<{ sid: string; top: number }[]>([]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const place = () => {
      const box = el.getBoundingClientRect();
      const out: { sid: string; top: number }[] = [];
      for (const s of list) {
        const at = suggestionEl(editor.domElement, s.sid);
        if (at) out.push({ sid: s.sid, top: Math.round(at.getBoundingClientRect().top - box.top) });
      }
      setSpots((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [editor, list, root]);
  if (!spots.length) return null;
  // Suggestions starting on the same line sit side by side.
  const rows = new Map<number, string[]>();
  for (const s of spots) {
    const key = [...rows.keys()].find((k) => Math.abs(k - s.top) < 6) ?? s.top;
    rows.set(key, [...(rows.get(key) ?? []), s.sid]);
  }
  return (
    <div className="nt-sug-gutter" aria-label={t("suggest.suggesting")}>
      {[...rows.entries()].map(([top, sids]) => (
        <div key={sids.join(",")} className="nt-sug-row" style={{ top }}>
          {sids.map((sid) => {
            const r = records.get(sid);
            const who = (r?.authorId ? personById(r.authorId) : undefined) ?? null;
            const name = who?.name || r?.author || "";
            return (
              <button
                type="button"
                key={sid}
                className="nt-sug-face nt-btn-reset"
                style={{ ["--nt-sug" as string]: r?.authorId ? personColor(r.authorId) : undefined }}
                title={name ? `${t("suggest.open")} · ${name}` : t("suggest.open")}
                aria-label={name ? `${t("suggest.open")} · ${name}` : t("suggest.open")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  const at = suggestionEl(editor.domElement, sid);
                  onOpen(sid, at ?? e.currentTarget);
                }}
              >
                <Avatar name={name || "?"} avatar={who?.avatar} size={22} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
