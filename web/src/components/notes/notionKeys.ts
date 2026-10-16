// Notion's block shortcuts BlockNote lacks: ⌘D duplicates the selected
// blocks, ⌘↵ ticks a to-do, ⌘⌥4…8 turn the block into a to-do, bulleted,
// numbered or toggle list, or code; Esc selects the
// block's text. (⌘⇧↑/↓ to move blocks is BlockNote's.)

import { Extension } from "@tiptap/core";
import { TextSelection } from "prosemirror-state";
import { createExtension, type BlockNoteEditor, type BlockSchema, type InlineContentSchema, type StyleSchema } from "@blocknote/core";
import { withoutBlockIds } from "@/lib/notes/model";

type AnyEditor = BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>;
type AnyBlock = { id: string; type: string; props: Record<string, unknown> };

/** Blocks that are their own text and may change type (not pages, databases, media…). */
const TEXT_TYPES = new Set(["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote"]);
/** Blocks that point at other notes: a copy would be a second link, so ⌘D leaves them. */
const LINKED = new Set(["page", "database", "synced"]);

function selectedBlocks(editor: AnyEditor): AnyBlock[] {
  const sel = editor.getSelection()?.blocks as AnyBlock[] | undefined;
  return sel?.length ? sel : [editor.getTextCursorPosition().block as AnyBlock];
}

function duplicate(editor: AnyEditor): boolean {
  const blocks = selectedBlocks(editor).filter((b) => !LINKED.has(b.type));
  // Handled either way, so the browser's "bookmark this page" never opens.
  if (!blocks.length) return true;
  const inserted = editor.insertBlocks(withoutBlockIds(blocks) as never, blocks[blocks.length - 1].id, "after");
  const last = inserted[inserted.length - 1];
  if (last) editor.setTextCursorPosition(last.id, "end");
  return true;
}

function toggleTodo(editor: AnyEditor): boolean {
  const todos = selectedBlocks(editor).filter((b) => b.type === "checkListItem");
  if (!todos.length) return false;
  const on = !todos.every((b) => b.props.checked === true);
  editor.transact(() => {
    for (const b of todos) editor.updateBlock(b.id, { props: { checked: on } } as never);
  });
  return true;
}

function turnInto(editor: AnyEditor, type: string): boolean {
  const blocks = selectedBlocks(editor).filter((b) => TEXT_TYPES.has(b.type) || b.type === "codeBlock");
  if (!blocks.length) return false;
  editor.transact(() => {
    for (const b of blocks) editor.updateBlock(b.id, { type } as never);
  });
  return true;
}

/** Esc: the block's text selected (a second Esc leaves the editor, as before). */
function selectBlock(editor: AnyEditor): boolean {
  // A menu or popover open: Esc is theirs.
  if (document.querySelector(".bn-suggestion-menu, .bn-grid-suggestion-menu, .nt-slash, .nt-popover")) return false;
  const view = editor.prosemirrorView;
  const sel = view?.state.selection;
  if (!view || !sel || !sel.empty || !sel.$from.parent.isTextblock || sel.$from.parent.content.size === 0) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, sel.$from.start(), sel.$from.end())));
  return true;
}

export const NotionKeysExtension = createExtension(({ editor }: { editor: AnyEditor }) => ({
  key: "ntNotionKeys",
  tiptapExtensions: [
    Extension.create({
      name: "ntNotionKeys",
      // Ahead of BlockNote's own keys (priority 50), which give ⌘⌥4–6 to headings 4–6.
      priority: 1000,
      addKeyboardShortcuts() {
        // Read-only pages (locked, peeks of others) keep their blocks as they are.
        const when = (fn: () => boolean) => () => editor.isEditable && fn();
        return {
          "Mod-d": when(() => duplicate(editor)),
          "Mod-Enter": when(() => toggleTodo(editor)),
          "Mod-Alt-4": when(() => turnInto(editor, "checkListItem")),
          "Mod-Alt-5": when(() => turnInto(editor, "bulletListItem")),
          "Mod-Alt-6": when(() => turnInto(editor, "numberedListItem")),
          "Mod-Alt-7": when(() => turnInto(editor, "toggleListItem")),
          "Mod-Alt-8": when(() => turnInto(editor, "codeBlock")),
          Escape: when(() => selectBlock(editor)),
        };
      },
    }),
  ],
}));
