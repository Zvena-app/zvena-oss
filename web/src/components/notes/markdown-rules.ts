// zvena Documents: Notion's Markdown shortcuts BlockNote lacks or reads
// otherwise: ">" + space starts a toggle list (BlockNote makes a quote; '"'
// + space still does), ~text~ strikes text through (one tilde, as in
// Notion; ~~text~~ is tiptap's), and $$TeX$$ becomes an inline equation.

import { Extension } from "@tiptap/core";
import { createExtension, type BlockNoteEditor, type BlockSchema, type InlineContentSchema, type StyleSchema } from "@blocknote/core";
import { Plugin, PluginKey } from "prosemirror-state";

type AnyEditor = BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>;

/** The text of the line before the caret (inline nodes as one character). */
function before(state: import("prosemirror-state").EditorState, pos: number): string {
  const $p = state.doc.resolve(pos);
  return $p.parent.textBetween(0, $p.parentOffset, undefined, "\ufffc");
}

export const MarkdownExtrasExtension = createExtension(({ editor }: { editor: AnyEditor }) => ({
  key: "ntMarkdownExtras",
  tiptapExtensions: [
    Extension.create({
      name: "ntMarkdownExtras",
      // Ahead of BlockNote's own input rules (its ">" quote).
      priority: 9000,
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey("ntMarkdownExtras"),
            props: {
              handleTextInput(view, from, to, text) {
                if (!editor.isEditable || from !== to) return false;
                const { state } = view;
                const $p = state.doc.resolve(from);
                if (!$p.parent.isTextblock || $p.parent.type.spec.code) return false;
                const line = before(state, from);
                // ">" + space at the start of a text line: a toggle list (Notion).
                if (text === " " && line === ">" && $p.parent.type.name === "paragraph") {
                  view.dispatch(state.tr.delete(from - 1, from));
                  const block = editor.getTextCursorPosition().block;
                  editor.updateBlock(block, { type: "toggleListItem" } as never);
                  return true;
                }
                // ~text~ : strike-through (not "~~", tiptap's own rule).
                if (text === "~") {
                  const m = /(?:^|[^~\w])~([^~\s](?:[^~]*[^~\s])?)$/u.exec(line);
                  const strike = state.schema.marks.strike;
                  if (m && strike) {
                    const inner = m[1];
                    const start = from - inner.length - 1;
                    const tr = state.tr.delete(start, start + 1);
                    tr.addMark(start, start + inner.length, strike.create());
                    tr.removeStoredMark(strike);
                    view.dispatch(tr);
                    return true;
                  }
                }
                // $$TeX$$ : an inline equation.
                if (text === "$") {
                  const m = /\$\$([^$]+)\$$/u.exec(line);
                  const node = state.schema.nodes.inlineEquation;
                  if (m && node && !m[1].startsWith(" ") && !m[1].endsWith(" ")) {
                    const start = from - m[0].length;
                    view.dispatch(state.tr.replaceWith(start, from, node.create({ latex: m[1] })));
                    return true;
                  }
                }
                return false;
              },
            },
          }),
        ];
      },
    }),
  ],
}));
