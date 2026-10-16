"use client";

// zvena Documents: find and replace in a page (Notion's ⌘F on the desktop).
// A ProseMirror plugin keeps the matches of the query as decorations (the
// current one stands out); the bar steps through them with ↵ / ⇧↵ and, for
// people who may edit, replaces one or all. Matches are found in each text
// block's own text (a mention or an equation is one character there).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Extension } from "@tiptap/core";
import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { ChevronDown, ChevronUp, Replace, X } from "lucide-react";
import type { NotesEditor } from "./blocks";
import { useNotes } from "./context";
import { Portal, useKeyboardInset } from "./ui";

export interface FindState {
  query: string;
  matchCase: boolean;
  /** The current match (an index into the matches). */
  index: number;
}

export interface Match {
  from: number;
  to: number;
}

interface FindPluginState {
  find: FindState;
  matches: Match[];
  deco: DecorationSet;
}

const findKey = new PluginKey<FindPluginState>("ntFind");
const EMPTY: FindState = { query: "", matchCase: false, index: 0 };

/** Every occurrence of the query in the document's text blocks. */
export function findMatches(doc: PMNode, query: string, matchCase: boolean): Match[] {
  if (!query) return [];
  const needle = matchCase ? query : query.toLocaleLowerCase();
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // The block's text with one character per inline node, and where each character sits.
    let text = "";
    const at: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const s = child.text ?? "";
        for (let i = 0; i < s.length; i++) at.push(start + i);
        text += s;
      } else {
        at.push(start);
        text += "\ufffc";
      }
    });
    const hay = matchCase ? text : text.toLocaleLowerCase();
    for (let i = hay.indexOf(needle); i >= 0 && out.length < 5000; i = hay.indexOf(needle, i + Math.max(1, needle.length))) {
      out.push({ from: at[i], to: at[i + needle.length - 1] + 1 });
    }
    return false;
  });
  return out;
}

function decorations(doc: PMNode, matches: Match[], index: number): DecorationSet {
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? "nt-find-hit nt-find-current" : "nt-find-hit" }))
  );
}

function compute(state: EditorState, find: FindState): FindPluginState {
  const matches = findMatches(state.doc, find.query, find.matchCase);
  const index = matches.length ? Math.min(Math.max(0, find.index), matches.length - 1) : 0;
  return { find: { ...find, index }, matches, deco: decorations(state.doc, matches, index) };
}

export const FindExtension = createExtension(() => ({
  key: "ntFind",
  tiptapExtensions: [
    Extension.create({
      name: "ntFind",
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: findKey,
            state: {
              init: (): FindPluginState => ({ find: EMPTY, matches: [], deco: DecorationSet.empty }),
              apply(tr, value, _old, state): FindPluginState {
                const set = tr.getMeta(findKey) as FindState | undefined;
                if (set) return compute(state, set);
                if (!value.find.query) return value;
                return tr.docChanged ? compute(state, value.find) : value;
              },
            },
            props: {
              decorations: (state) => findKey.getState(state)?.deco ?? DecorationSet.empty,
            },
          }),
        ];
      },
    }),
  ],
}));

function readFind(editor: NotesEditor) {
  const view = editor.prosemirrorView;
  return view ? (findKey.getState(view.state) ?? null) : null;
}

/** The find bar (and replace, for people who may edit). */
export function FindBar({ editor, canReplace, onClose }: { editor: NotesEditor; canReplace: boolean; onClose: () => void }) {
  const { t } = useNotes();
  const [query, setQuery] = useState(() => editor.getSelectedText().slice(0, 200));
  const [matchCase, setMatchCase] = useState(false);
  const [index, setIndex] = useState(0);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // The plugin's matches as they are (they follow edits).
  const subscribe = useCallback(
    (cb: () => void) => {
      const tt = editor._tiptapEditor;
      tt.on("transaction", cb);
      return () => void tt.off("transaction", cb);
    },
    [editor]
  );
  const count = useSyncExternalStore(subscribe, () => readFind(editor)?.matches.length ?? 0, () => 0);
  const shownIndex = useSyncExternalStore(subscribe, () => readFind(editor)?.find.index ?? 0, () => 0);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  // The query goes to the plugin; the current match scrolls into view.
  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    view.dispatch(view.state.tr.setMeta(findKey, { query, matchCase, index }).setMeta("addToHistory", false));
    const st = readFind(editor);
    const m = st?.matches[st.find.index];
    if (m) view.domAtPos(m.from).node.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [editor, index, matchCase, query]);
  // Closing clears the highlights.
  useEffect(
    () => () => {
      const view = editor.prosemirrorView;
      if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(findKey, EMPTY).setMeta("addToHistory", false));
    },
    [editor]
  );
  const step = (d: number) => setIndex((i) => (count ? (i + d + count) % count : 0));
  const current = count ? shownIndex + 1 : 0;
  const replaceAt = (all: boolean) => {
    const view = editor.prosemirrorView;
    const st = readFind(editor);
    if (!view || !st || !st.matches.length) return;
    const list = all ? st.matches : [st.matches[st.find.index]];
    const tr = view.state.tr;
    for (const m of [...list].sort((a, b) => b.from - a.from)) {
      const marks = view.state.doc.resolve(m.from + 1).marks();
      if (replacement) tr.replaceWith(m.from, m.to, view.state.schema.text(replacement, marks));
      else tr.delete(m.from, m.to);
    }
    view.dispatch(tr);
  };
  const close = () => {
    onClose();
    editor.focus();
  };
  // Phones put the bar at the bottom: it rides above the on-screen keyboard (responsive/docs.css).
  const keyboard = useKeyboardInset();
  const go = () => {
    const view = editor.prosemirrorView;
    const st = readFind(editor);
    const m = st?.matches[st.find.index];
    if (view && m) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)));
    close();
  };
  return (
    <Portal>
      <div className="nt-find" role="search" aria-label={t("find.title")} style={{ "--nt-kb": `${keyboard}px` } as CSSProperties} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), close())}>
        <div className="nt-find-row">
          {canReplace && (
            <button type="button" className="nt-find-btn nt-btn-reset" aria-label={t("find.replaceToggle")} title={t("find.replaceToggle")} aria-pressed={replaceOpen} onClick={() => setReplaceOpen((v) => !v)}>
              <Replace size={15} />
            </button>
          )}
          <input
            ref={input}
            className="nt-input nt-find-input"
            value={query}
            placeholder={t("find.placeholder")}
            aria-label={t("find.placeholder")}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
              else if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
            }}
          />
          <span className="nt-find-count" aria-live="polite">{query ? t("find.count", { n: current, total: count }) : ""}</span>
          <button type="button" className="nt-find-btn nt-btn-reset" aria-label={t("find.matchCase")} title={t("find.matchCase")} aria-pressed={matchCase} onClick={() => setMatchCase((v) => !v)}>
            Aa
          </button>
          <button type="button" className="nt-find-btn nt-btn-reset" aria-label={t("find.prev")} title={t("find.prev")} disabled={!count} onClick={() => step(-1)}>
            <ChevronUp size={15} />
          </button>
          <button type="button" className="nt-find-btn nt-btn-reset" aria-label={t("find.next")} title={t("find.next")} disabled={!count} onClick={() => step(1)}>
            <ChevronDown size={15} />
          </button>
          <button type="button" className="nt-find-btn nt-btn-reset" aria-label={t("common.close")} title={t("common.close")} onClick={close}>
            <X size={15} />
          </button>
        </div>
        {canReplace && replaceOpen && (
          <div className="nt-find-row">
            <input
              className="nt-input nt-find-input"
              value={replacement}
              placeholder={t("find.replacePlaceholder")}
              aria-label={t("find.replacePlaceholder")}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && replaceAt(false)}
            />
            <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" disabled={!count} onClick={() => replaceAt(false)}>
              {t("find.replace")}
            </button>
            <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" disabled={!count} onClick={() => replaceAt(true)}>
              {t("find.replaceAll")}
            </button>
          </div>
        )}
      </div>
    </Portal>
  );
}
