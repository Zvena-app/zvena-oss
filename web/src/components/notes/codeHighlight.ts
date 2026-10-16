// Syntax colors in code blocks: our own small tokenizer (src/lib/notes/highlight)
// fed to prosemirror-highlight, which BlockNote already ships — no Shiki.

import { createExtension } from "@blocknote/core";
import { createHighlightPlugin, type Parser } from "prosemirror-highlight";
import { Decoration } from "prosemirror-view";
import { tokenize } from "@/lib/notes/highlight";

const parser: Parser = ({ content, language, pos }) => tokenize(content, language).map((t) => Decoration.inline(pos + 1 + t.from, pos + 1 + t.to, { class: `nt-tok nt-tok-${t.cls}` }));

export const CodeHighlightExtension = createExtension(() => ({
  key: "ntCodeHighlight",
  prosemirrorPlugins: [createHighlightPlugin({ parser, nodeTypes: ["codeBlock"] })],
}));
