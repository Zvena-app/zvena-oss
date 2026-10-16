// zvena Documents: Notion-style columns. BlockNote's core understands two
// container node types for this ("bnBlock" nodes without content of their
// own): a `columnList` holding two or more `column`s, each holding blocks.
// Dropping a dragged block on the left or right edge of another block puts
// them side by side; the gutter between two columns resizes them.

import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Selection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type { Node as PMNode, Slice } from "prosemirror-model";
import {
  createBlockSpecFromTiptapNode,
  createExtension,
  fixColumnList,
  type BlockNoteEditor,
  type BlockSchema,
  type DropCursorOptions,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A column's share of its row, from our attribute or Notion's exported "width: 50%". */
function readWidth(el: HTMLElement): number {
  const own = Number(el.getAttribute("data-width"));
  if (own > 0) return own;
  const pct = /width:\s*([\d.]+)%/.exec(el.getAttribute("style") ?? "");
  const count = el.parentElement ? el.parentElement.querySelectorAll(":scope > .column").length : 0;
  return pct && count ? round(Number(pct[1]) / (100 / count)) || 1 : 1;
}

// ---------------------------------------------------------------------------
// Nodes

const ColumnListNode = Node.create({
  name: "columnList",
  group: "childContainer bnBlock blockGroupChild",
  content: "column column+",
  priority: 40,
  defining: true,
  parseHTML() {
    return [
      { tag: 'div[data-node-type="columnList"]' },
      // Notion's HTML export.
      { tag: "div.column-list", getAttrs: (el) => (el.querySelectorAll(":scope > .column").length >= 2 ? {} : false) },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "nt-cols", "data-node-type": "columnList" }), 0];
  },
});

/** Drag the gutter on a column's left to move width between it and its left neighbour. */
function startResize(e: PointerEvent, view: EditorView, dom: HTMLElement, grip: HTMLElement, getPos: () => number | undefined) {
  const prev = dom.previousElementSibling as HTMLElement | null;
  const pos = getPos();
  if (!view.editable || e.button !== 0 || !prev || typeof pos !== "number") return;
  const left = view.state.doc.resolve(pos).nodeBefore;
  const self = view.state.doc.nodeAt(pos);
  if (!left || !self) return;
  e.preventDefault();
  e.stopPropagation();
  const w1 = Number(left.attrs.width) || 1;
  const w2 = Number(self.attrs.width) || 1;
  const p1 = prev.getBoundingClientRect().width;
  const p2 = dom.getBoundingClientRect().width;
  const total = w1 + w2;
  const px = p1 + p2;
  const min = Math.min(72, px / 2 - 1);
  const x0 = e.clientX;
  let n1 = w1;
  let n2 = w2;
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add("nt-col-resizing");
  grip.classList.add("nt-active");
  const move = (ev: PointerEvent) => {
    const a = Math.min(px - min, Math.max(min, p1 + ev.clientX - x0));
    n1 = round((total * a) / px);
    n2 = round(total - n1);
    prev.style.flexGrow = String(n1);
    dom.style.flexGrow = String(n2);
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    document.body.classList.remove("nt-col-resizing");
    grip.classList.remove("nt-active");
    const at = getPos();
    if (typeof at !== "number" || (n1 === w1 && n2 === w2)) return;
    const l = view.state.doc.resolve(at).nodeBefore;
    const s = view.state.doc.nodeAt(at);
    if (!l || !s) return;
    view.dispatch(view.state.tr.setNodeMarkup(at - l.nodeSize, undefined, { ...l.attrs, width: n1 }).setNodeMarkup(at, undefined, { ...s.attrs, width: n2 }));
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}

/** Double-clicking a gutter makes every column in the row the same width. */
function equalize(view: EditorView, getPos: () => number | undefined) {
  const pos = getPos();
  if (!view.editable || typeof pos !== "number") return;
  const $pos = view.state.doc.resolve(pos);
  const listPos = $pos.before($pos.depth);
  const list = $pos.parent;
  const tr = view.state.tr;
  let at = listPos + 1;
  list.forEach((col) => {
    if (col.attrs.width !== 1) tr.setNodeMarkup(at, undefined, { ...col.attrs, width: 1 });
    at += col.nodeSize;
  });
  if (tr.docChanged) view.dispatch(tr);
}

const ColumnNode = Node.create({
  name: "column",
  group: "bnBlock childContainer",
  content: "blockContainer+",
  priority: 40,
  defining: true,
  addAttributes() {
    return {
      width: {
        default: 1,
        parseHTML: (el) => readWidth(el),
        renderHTML: (attrs) => (attrs.width === 1 ? {} : { "data-width": String(attrs.width), style: `flex-grow: ${attrs.width}` }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-node-type="column"]' }, { tag: "div.column", getAttrs: (el) => (el.parentElement?.classList.contains("column-list") ? {} : false) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "nt-col", "data-node-type": "column" }), 0];
  },
  addNodeView() {
    return ({ node, getPos, view }): NodeView => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "nt-col";
      dom.setAttribute("data-node-type", "column");
      // The blocks come first: BlockNote lines the side menu up with the first child.
      const body = document.createElement("div");
      body.className = "nt-col-body";
      const grip = document.createElement("div");
      grip.className = "nt-col-resize";
      grip.contentEditable = "false";
      grip.setAttribute("aria-hidden", "true");
      dom.append(body, grip);
      const paint = () => {
        dom.style.flexGrow = String(Number(current.attrs.width) || 1);
        if (current.attrs.id) dom.setAttribute("data-id", String(current.attrs.id));
      };
      paint();
      grip.addEventListener("pointerdown", (e) => startResize(e, view, dom, grip, getPos));
      grip.addEventListener("dblclick", () => equalize(view, getPos));
      return {
        dom,
        contentDOM: body,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          paint();
          return true;
        },
        stopEvent: (e) => e.target instanceof Element && grip.contains(e.target),
        ignoreMutation: (m) => m.type !== "selection" && !body.contains(m.target),
      };
    };
  },
});

// ---------------------------------------------------------------------------
// Drag and drop: the left / right edge of a block

/** The blocks a side-menu drag carries (the editor selects them on drag start). */
function draggedNodes(sel: Selection): PMNode[] | null {
  const nodes = sel instanceof NodeSelection ? [sel.node] : (sel as unknown as { nodes?: PMNode[] }).nodes;
  if (!nodes?.length || nodes.some((n) => n.type.name !== "blockContainer")) return null;
  return nodes;
}

interface SideTarget {
  /** Position before the target block. */
  pos: number;
  node: PMNode;
  side: "left" | "right";
}

/**
 * The block a dragged block would sit beside, when the pointer is on that
 * block's left or right edge. Only top-level blocks and blocks directly in a
 * column qualify (Notion does not make columns inside lists or toggles).
 */
export function sideDropTarget(view: EditorView, x: number, y: number, slice: Slice | undefined): SideTarget | null {
  const sel = view.state.selection;
  const nodes = draggedNodes(sel);
  // The drag must be this editor's own selection (not a drag from another editor).
  if (!nodes || !slice || slice.content.firstChild?.attrs.id !== nodes[0].attrs.id) return null;
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const doc = view.state.doc;
  const $pos = doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  const fits = (depth: number) => depth === 1 || $pos.node(depth).type.name === "column";
  let pos = -1;
  let node: PMNode | null = null;
  for (let d = 2; d <= $pos.depth; d++) {
    if ($pos.node(d).type.name === "blockContainer" && fits(d - 1)) {
      pos = $pos.before(d);
      node = $pos.node(d);
      break;
    }
  }
  if (!node && $pos.nodeAfter?.type.name === "blockContainer" && fits($pos.depth)) {
    pos = $pos.pos;
    node = $pos.nodeAfter;
  }
  if (!node || (pos >= sel.from && pos < sel.to)) return null;
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  const r = dom.getBoundingClientRect();
  if (y < r.top || y > r.bottom) return null;
  if (x >= r.left && x < r.left + Math.min(28, r.width * 0.1)) return { pos, node, side: "left" };
  if (x <= r.right && x > r.right - Math.min(96, r.width * 0.2)) return { pos, node, side: "right" };
  return null;
}

/** Drop cursor settings: Notion's blue, and a vertical line on a block's edge for columns. */
export const columnDropCursor: DropCursorOptions = {
  color: "rgba(35, 131, 226, 0.43)",
  width: 4,
  hooks: {
    computeDropPosition: ({ view, event, defaultPosition }) => {
      const t = sideDropTarget(view, event.clientX, event.clientY, view.dragging?.slice);
      return t ? { pos: t.pos, orientation: t.side === "left" ? "block-vertical-left" : "block-vertical-right" } : defaultPosition;
    },
  },
};

/** Position before the column list around `pos`, if any. */
function enclosingList(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === "columnList") return $pos.before(d);
  return null;
}

/**
 * Backspace at the start of a column's first block moves that block to the end
 * of the previous column (or above the row, from the first column); a column
 * left empty disappears. BlockNote's own version of this computes positions
 * before tidying the row and throws when the row collapses.
 */
function columnBackspace(view: EditorView): boolean {
  const sel = view.state.selection;
  const $from = sel.$from;
  const d = $from.depth;
  if (!sel.empty || $from.parentOffset !== 0 || !$from.parent.isTextblock || d < 4) return false;
  const block = $from.node(d - 1);
  const column = $from.node(d - 2);
  const list = $from.node(d - 3);
  if (block.type.name !== "blockContainer" || column.type.name !== "column" || list.type.name !== "columnList" || $from.index(d - 2) !== 0) return false;
  const blockPos = $from.before(d - 1);
  const columnPos = $from.before(d - 2);
  const listPos = $from.before(d - 3);
  const first = $from.index(d - 3) === 0;
  const tr = view.state.tr;
  // Insert first (always before the block), then remove through the mapping.
  tr.insert(first ? listPos : columnPos - 1, block);
  const map = (pos: number) => tr.mapping.map(pos);
  if (column.childCount > 1) {
    tr.delete(map(blockPos), map(blockPos + block.nodeSize));
  } else if (list.childCount > 2) {
    // The column empties: it goes, the row keeps its other columns.
    tr.delete(map(columnPos), map(columnPos + column.nodeSize));
  } else {
    // Two columns and this one empties: the row turns back into the other column's blocks.
    const at = map(listPos);
    const row = tr.doc.nodeAt(at);
    if (!row || row.type.name !== "columnList") return false;
    tr.replaceWith(at, at + row.nodeSize, row.child(first ? 1 : 0).content);
  }
  let found = -1;
  tr.doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.attrs.id === block.attrs.id) found = pos;
    return found < 0;
  });
  if (found >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(found + 1)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

const ColumnKeys = Extension.create({
  name: "ntColumnKeys",
  // Ahead of BlockNote's keyboard shortcuts (priority 50).
  priority: 1000,
  addKeyboardShortcuts() {
    return { Backspace: () => columnBackspace(this.editor.view) };
  },
});

const ColumnsExtension = createExtension(({ editor }: { editor: BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema> }) => ({
  key: "ntColumns",
  tiptapExtensions: [ColumnKeys],
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey("ntColumns"),
      props: {
        handleDrop(view, event, slice, moved) {
          if (!moved || !view.editable) return false;
          const t = sideDropTarget(view, event.clientX, event.clientY, slice);
          const nodes = t && draggedNodes(view.state.selection);
          if (!t || !nodes) return false;
          const ids = nodes.map((n) => String(n.attrs.id));
          const targetId = String(t.node.attrs.id);
          event.preventDefault();
          editor.transact(() => {
            const blocks = ids.map((id) => editor.getBlock(id)).filter((b) => !!b);
            editor.removeBlocks(ids);
            const parent = editor.getParentBlock(targetId);
            if (parent?.type === "column") {
              // Beside a block in a column: a new column in that row.
              const widths = (editor.getParentBlock(parent.id)?.children ?? []).map((c) => Number(c.props?.width) || 1);
              const width = widths.length ? round(widths.reduce((a, b) => a + b, 0) / widths.length) : 1;
              editor.insertBlocks([{ type: "column", props: { width }, children: blocks }] as never, parent.id, t.side === "left" ? "before" : "after");
              return;
            }
            const target = editor.getBlock(targetId);
            if (!target) return;
            const mine = { type: "column", props: { width: 1 }, children: blocks };
            const theirs = { type: "column", props: { width: 1 }, children: [target] };
            editor.replaceBlocks([targetId], [{ type: "columnList", children: t.side === "left" ? [mine, theirs] : [theirs, mine] }] as never);
          });
          return true;
        },
      },
      // A plain (vertical) drop that empties a column removes the column, and
      // a row left with one column turns back into ordinary blocks.
      appendTransaction(trs, oldState, newState) {
        if (!trs.some((tr) => tr.docChanged && tr.getMeta("uiEvent") === "drop")) return null;
        const listPos = enclosingList(oldState.doc, oldState.selection.from);
        if (listPos === null) return null;
        let pos = listPos;
        for (const tr of trs) {
          const r = tr.mapping.mapResult(pos);
          if (r.deleted) return null;
          pos = r.pos;
        }
        if (newState.doc.nodeAt(pos)?.type.name !== "columnList") return null;
        const tr = newState.tr;
        try {
          fixColumnList(tr, pos);
        } catch {
          return null;
        }
        return tr.docChanged ? tr : null;
      },
    }),
  ],
}));

// ---------------------------------------------------------------------------
// Block specs

export const ColumnListBlock = createBlockSpecFromTiptapNode({ node: ColumnListNode, type: "columnList", content: "none" }, {}, [ColumnsExtension()]);
export const ColumnBlock = createBlockSpecFromTiptapNode({ node: ColumnNode, type: "column", content: "none" }, { width: { default: 1 } });

/** A row of `n` empty columns (the "/2 columns" … "/5 columns" commands). */
export function columnLayout(n: number) {
  return {
    type: "columnList",
    children: Array.from({ length: n }, () => ({ type: "column", props: { width: 1 }, children: [{ type: "paragraph" }] })),
  };
}
