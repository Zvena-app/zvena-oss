// zvena Documents keyboard shortcuts (Notion's, as they work here), listed in
// Settings. "mod" is Ctrl (⌘ on
// macOS), "alt" Alt (⌥), "shift" Shift (⇧). Pure.
import type { NotesKey } from "./i18n";

export const NOTES_SHORTCUTS: readonly [NotesKey, string[]][] = [
  ["kbd.search", ["mod", "P"]],
  ["kbd.sidebar", ["mod", "\\"]],
  ["kbd.theme", ["mod", "shift", "L"]],
  ["kbd.newPage", ["mod", "alt", "N"]],
  ["kbd.bold", ["mod", "B"]],
  ["kbd.italic", ["mod", "I"]],
  ["kbd.underline", ["mod", "U"]],
  ["kbd.strike", ["mod", "shift", "S"]],
  ["kbd.code", ["mod", "E"]],
  ["kbd.link", ["mod", "K"]],
  ["kbd.undo", ["mod", "Z"]],
  ["kbd.redo", ["mod", "shift", "Z"]],
  ["kbd.pastePlain", ["mod", "shift", "V"]],
  ["kbd.text", ["mod", "alt", "0"]],
  ["kbd.h1", ["mod", "alt", "1"]],
  ["kbd.h2", ["mod", "alt", "2"]],
  ["kbd.h3", ["mod", "alt", "3"]],
  ["kbd.bullet", ["mod", "shift", "8"]],
  ["kbd.numbered", ["mod", "shift", "7"]],
  ["kbd.todo", ["mod", "shift", "9"]],
  ["kbd.toTodo", ["mod", "alt", "4"]],
  ["kbd.toToggle", ["mod", "alt", "7"]],
  ["kbd.toCode", ["mod", "alt", "8"]],
  ["kbd.toPage", ["mod", "alt", "9"]],
  ["kbd.toggleTodo", ["mod", "Enter"]],
  ["kbd.duplicate", ["mod", "D"]],
  ["kbd.moveBlock", ["mod", "shift", "↑ ↓"]],
  ["kbd.actions", ["mod", "/"]],
  ["kbd.selectBlock", ["Esc"]],
  ["kbd.comment", ["mod", "shift", "M"]],
  ["kbd.lastColor", ["mod", "shift", "H"]],
  ["kbd.equation", ["mod", "shift", "E"]],
  ["kbd.toggles", ["mod", "alt", "T"]],
  ["kbd.find", ["mod", "F"]],
  ["kbd.back", ["mod", "["]],
  ["kbd.forward", ["mod", "]"]],
  ["kbd.parent", ["mod", "shift", "U"]],
  ["kbd.movePage", ["mod", "shift", "P"]],
  ["kbd.indent", ["Tab"]],
  ["kbd.outdent", ["shift", "Tab"]],
  ["kbd.slash", ["/"]],
  ["kbd.mention", ["@"]],
  ["kbd.linkPage", ["[["]],
  ["kbd.markdown", ["#", "-", "[]", ">", "\"", "---", "```", "$$"]],
];

/** One key as shown: modifiers per platform. */
export function shortcutKey(k: string, mac: boolean): string {
  if (k === "mod") return mac ? "⌘" : "Ctrl";
  if (k === "alt") return mac ? "⌥" : "Alt";
  if (k === "shift") return mac ? "⇧" : "Shift";
  return k;
}
