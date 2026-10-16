"use client";

// Markdown / HTML → BlockNote blocks without a mounted editor (imports): one
// headless editor with the Notes schema, created on first use.

import { BlockNoteEditor } from "@blocknote/core";
import { notesSchema } from "./blocks";
import { linkDateTokens } from "@/lib/notes/reminders";

let headless: BlockNoteEditor<never, never, never> | null = null;

function editor(): BlockNoteEditor<never, never, never> {
  headless ??= BlockNoteEditor.create({ schema: notesSchema } as never) as unknown as BlockNoteEditor<never, never, never>;
  return headless;
}

export function markdownToBlocks(md: string): unknown[] {
  try {
    const blocks = linkDateTokens(editor().tryParseMarkdownToBlocks(md) as unknown[]);
    return blocks.length ? blocks : linkDateTokens([{ type: "paragraph", content: md }]);
  } catch {
    return md
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => ({ type: "paragraph", content: p.trim() }));
  }
}

export function htmlToBlocks(html: string): unknown[] {
  try {
    return editor().tryParseHTMLToBlocks(html) as unknown[];
  } catch {
    return [];
  }
}
