"use client";

// The composer's text: zvena's editor (BlockNote, as in Documents) in a
// lighter setup — formatting, lists, links, the slash menu; no side handles,
// files or tables. Loaded on first use (its own chunk). The message goes out
// as BlockNote's e-mail-friendly HTML; the blocks are kept with the draft so
// it reopens exactly as it was.

import "@blocknote/ariakit/style.css";
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import { blockNoteLocale } from "@/components/notes/blocknote-locale";

export interface ComposeEditorHandle {
  /** Inserts a link at the cursor (a Docs page). */
  insertLink(url: string, text: string): void;
  /** Inserts HTML at the cursor (a snippet). */
  insertHtml(html: string): Promise<void>;
  focus(): void;
  html(): Promise<string>;
  blocks(): unknown[];
}

export default function ComposeEditor({
  initialBlocks,
  initialHtml,
  locale,
  placeholder,
  onChange,
  handle,
  autoFocus,
}: {
  initialBlocks?: unknown[];
  initialHtml?: string;
  locale: string;
  placeholder: string;
  onChange: () => void;
  handle: Ref<ComposeEditorHandle>;
  autoFocus?: boolean;
}) {
  const dictionary = useMemo(() => {
    const d = blockNoteLocale(locale);
    return { ...d, placeholders: { ...d.placeholders, default: placeholder, emptyDocument: placeholder } };
  }, [locale, placeholder]);
  const editor = useCreateBlockNote(
    {
      dictionary,
      ...(initialBlocks?.length ? { initialContent: initialBlocks as never } : {}),
    },
    []
  );
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    if (!initialBlocks?.length && initialHtml) {
      const blocks = editor.tryParseHTMLToBlocks(initialHtml);
      if (blocks.length) editor.replaceBlocks(editor.document, blocks);
    }
    if (autoFocus) setTimeout(() => editor.focus(), 30);
  }, [editor, initialBlocks, initialHtml, autoFocus]);
  useImperativeHandle(
    handle,
    () => ({
      insertLink(url, text) {
        editor.focus();
        editor.insertInlineContent([{ type: "link", href: url, content: text }, " "]);
      },
      async insertHtml(html) {
        const blocks = editor.tryParseHTMLToBlocks(html);
        if (!blocks.length) return;
        const at = editor.getTextCursorPosition().block;
        const empty = Array.isArray(at.content) && at.content.length === 0;
        if (empty) editor.replaceBlocks([at], blocks);
        else editor.insertBlocks(blocks, at, "after");
      },
      focus() {
        editor.focus();
      },
      async html() {
        return editor.blocksToHTMLLossy(editor.document);
      },
      blocks() {
        return editor.document as unknown[];
      },
    }),
    [editor]
  );
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return (
    <div className="zm-editor">
      <BlockNoteView editor={editor} theme={dark ? "dark" : "light"} sideMenu={false} filePanel={false} tableHandles={false} emojiPicker={false} onChange={onChange} />
    </div>
  );
}
