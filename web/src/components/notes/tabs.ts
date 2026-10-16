// zvena Documents: Notion's Tabs block. A `tabs` container holds two or more
// `tab`s, each with a title and blocks of its own; one tab shows at a time.
// Built like columns (columns.ts): container nodes BlockNote's core knows as
// "bnBlock"s. The bar above the tabs is drawn by the container's node view:
// click a tab to show it, double-click to rename, "+" adds one, and its menu
// (right-click or the ⋯ that shows on hover) renames, moves or deletes it. A
// caret that lands in a hidden tab (find in page, a link to a block) shows it.

import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { createBlockSpecFromTiptapNode, createExtension } from "@blocknote/core";

/** The words the bar shows (Editor sets them in the page's language). */
export interface TabsText {
  untitled: (n: number) => string;
  add: string;
  rename: string;
  moveLeft: string;
  moveRight: string;
  remove: string;
  menu: string;
}
let text: TabsText = {
  untitled: (n) => `Tab ${n}`,
  add: "Add tab",
  rename: "Rename",
  moveLeft: "Move left",
  moveRight: "Move right",
  remove: "Delete tab",
  menu: "Tab options",
};
export function setTabsText(t: TabsText): void {
  text = t;
}

/** The tab shown in each Tabs block on this screen (by block id; the first one otherwise). */
const shown = new Map<string, string>();

function tabIdAt(list: PMNode, i: number): string {
  return String(list.child(i).attrs.id ?? i);
}

function activeIndex(list: PMNode): number {
  const want = shown.get(String(list.attrs.id));
  for (let i = 0; i < list.childCount; i++) if (tabIdAt(list, i) === want) return i;
  return 0;
}

/** Positions of the container at `pos` and its tabs. */
function tabsAt(view: EditorView, pos: number): { list: PMNode; tabPos: number[] } | null {
  const list = view.state.doc.nodeAt(pos);
  if (!list || list.type.name !== "tabs") return null;
  const tabPos: number[] = [];
  let at = pos + 1;
  list.forEach((t) => {
    tabPos.push(at);
    at += t.nodeSize;
  });
  return { list, tabPos };
}

function menuAt(x: number, y: number, items: { label: string; danger?: boolean; disabled?: boolean; run: () => void }[]) {
  document.querySelector(".nt-tabs-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "nt-tabs-menu";
  menu.setAttribute("role", "menu");
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 40 * items.length - 16)}px`;
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", esc, true);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Element)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nt-tabs-menu-item";
    b.setAttribute("role", "menuitem");
    if (it.danger) b.dataset.danger = "";
    b.disabled = Boolean(it.disabled);
    b.textContent = it.label;
    b.addEventListener("click", () => {
      close();
      it.run();
    });
    menu.append(b);
  }
  document.body.append(menu);
  (menu.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus();
  setTimeout(() => {
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", esc, true);
  });
}

/** BlockNote gives ids only to its own containers (blockContainer, columnList, column): tabs get theirs here. */
const idAttribute = {
  id: {
    default: null,
    keepOnSplit: false,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-id"),
    renderHTML: (attrs: Record<string, unknown>) => (attrs.id ? { "data-id": String(attrs.id) } : {}),
  },
};
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

const TabsNode = Node.create({
  name: "tabs",
  group: "childContainer bnBlock blockGroupChild",
  content: "tab+",
  priority: 40,
  defining: true,
  addAttributes() {
    return idAttribute;
  },
  parseHTML() {
    return [{ tag: 'div[data-node-type="tabs"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "nt-tabs", "data-node-type": "tabs" }), 0];
  },
  addNodeView() {
    return ({ node, getPos, view }): NodeView => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "nt-tabs";
      dom.setAttribute("data-node-type", "tabs");
      const bar = document.createElement("div");
      bar.className = "nt-tabs-bar";
      bar.contentEditable = "false";
      bar.setAttribute("role", "tablist");
      const body = document.createElement("div");
      body.className = "nt-tabs-body";
      // The blocks come first in the DOM (BlockNote lines the side menu up with the first child); the bar is placed above by CSS.
      dom.append(body, bar);

      const pos = () => {
        const p = getPos();
        return typeof p === "number" ? p : null;
      };
      const show = (i: number) => {
        shown.set(String(current.attrs.id), tabIdAt(current, Math.max(0, Math.min(i, current.childCount - 1))));
        paint();
      };
      const rename = (i: number) => {
        const btn = bar.querySelectorAll<HTMLElement>(".nt-tab-btn")[i];
        if (!btn || !view.editable) return;
        const input = document.createElement("input");
        input.className = "nt-tab-input";
        input.value = String(current.child(i).attrs.title ?? "");
        input.placeholder = text.untitled(i + 1);
        input.setAttribute("aria-label", text.rename);
        input.size = Math.max(6, input.value.length + 1);
        btn.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const commit = (save: boolean) => {
          if (done) return;
          done = true;
          const p = pos();
          const at = p === null ? null : tabsAt(view, p);
          if (save && at && at.tabPos[i] !== undefined) {
            const tab = at.list.child(i);
            const title = input.value.trim().slice(0, 120);
            if (title !== String(tab.attrs.title ?? "")) view.dispatch(view.state.tr.setNodeMarkup(at.tabPos[i], undefined, { ...tab.attrs, title }));
          }
          paint();
        };
        input.addEventListener("input", () => (input.size = Math.max(6, input.value.length + 1)));
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit(true);
          if (e.key === "Escape") commit(false);
        });
        input.addEventListener("blur", () => commit(true));
      };
      const addTab = () => {
        const p = pos();
        if (p === null || !view.editable) return;
        const tabType = view.state.schema.nodes.tab;
        const para = view.state.schema.nodes.blockContainer.createAndFill();
        if (!tabType || !para) return;
        const end = p + current.nodeSize - 1;
        const tab = tabType.create({ id: newId(), title: "" }, para);
        const tr = view.state.tr.insert(end, tab);
        view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(end + 2))));
        const list = view.state.doc.nodeAt(p);
        if (list) {
          current = list;
          show(list.childCount - 1);
        }
        view.focus();
      };
      const move = (i: number, by: -1 | 1) => {
        const p = pos();
        const at = p === null ? null : tabsAt(view, p);
        const j = i + by;
        if (!at || j < 0 || j >= at.list.childCount) return;
        const a = Math.min(i, j);
        const first = at.list.child(a);
        const second = at.list.child(a + 1);
        const from = at.tabPos[a];
        view.dispatch(view.state.tr.replaceWith(from, from + first.nodeSize + second.nodeSize, [second, first]));
      };
      const remove = (i: number) => {
        const p = pos();
        const at = p === null ? null : tabsAt(view, p);
        if (!at) return;
        const tr = view.state.tr;
        if (at.list.childCount <= 1) {
          // The last tab goes with the block.
          tr.delete(p as number, (p as number) + at.list.nodeSize);
        } else {
          const tab = at.list.child(i);
          tr.delete(at.tabPos[i], at.tabPos[i] + tab.nodeSize);
          if (activeIndex(at.list) === i) shown.set(String(at.list.attrs.id), tabIdAt(at.list, i === 0 ? 1 : i - 1));
        }
        view.dispatch(tr);
      };
      const openMenu = (i: number, x: number, y: number) => {
        if (!view.editable) return;
        menuAt(x, y, [
          { label: text.rename, run: () => rename(i) },
          { label: text.moveLeft, disabled: i === 0, run: () => move(i, -1) },
          { label: text.moveRight, disabled: i >= current.childCount - 1, run: () => move(i, 1) },
          { label: text.remove, danger: true, run: () => remove(i) },
        ]);
      };

      function paint() {
        if (current.attrs.id) dom.setAttribute("data-id", String(current.attrs.id));
        const active = activeIndex(current);
        const ids: string[] = [];
        current.forEach((_, __, i) => ids.push(tabIdAt(current, i)));
        bar.replaceChildren();
        current.forEach((tab, _, i) => {
          const wrap = document.createElement("div");
          wrap.className = "nt-tab-item";
          if (i === active) wrap.dataset.active = "";
          const b = document.createElement("button");
          b.type = "button";
          b.className = "nt-tab-btn";
          b.setAttribute("role", "tab");
          b.setAttribute("aria-selected", String(i === active));
          b.tabIndex = i === active ? 0 : -1;
          const title = String(tab.attrs.title ?? "");
          b.textContent = title || text.untitled(i + 1);
          if (!title) b.dataset.empty = "";
          b.addEventListener("mousedown", (e) => e.preventDefault());
          b.addEventListener("click", () => show(i));
          b.addEventListener("dblclick", () => rename(i));
          b.addEventListener("contextmenu", (e) => {
            if (!view.editable) return;
            e.preventDefault();
            openMenu(i, e.clientX, e.clientY);
          });
          b.addEventListener("keydown", (e) => {
            const go = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!go) return;
            e.preventDefault();
            const n = (i + go + current.childCount) % current.childCount;
            show(n);
            bar.querySelectorAll<HTMLButtonElement>(".nt-tab-btn")[n]?.focus();
          });
          wrap.append(b);
          if (view.editable) {
            const more = document.createElement("button");
            more.type = "button";
            more.className = "nt-tab-more";
            more.setAttribute("aria-label", text.menu);
            more.title = text.menu;
            more.textContent = "⋯";
            more.addEventListener("mousedown", (e) => e.preventDefault());
            more.addEventListener("click", () => {
              const r = more.getBoundingClientRect();
              openMenu(i, r.left, r.bottom + 4);
            });
            wrap.append(more);
          }
          bar.append(wrap);
        });
        if (view.editable) {
          const add = document.createElement("button");
          add.type = "button";
          add.className = "nt-tab-add";
          add.setAttribute("aria-label", text.add);
          add.title = text.add;
          add.textContent = "+";
          add.addEventListener("mousedown", (e) => e.preventDefault());
          add.addEventListener("click", addTab);
          bar.append(add);
        }
        // Each tab's own DOM shows or hides (the tab node views mark themselves with data-tab).
        [...body.children].forEach((el, i) => {
          if (i === active) (el as HTMLElement).setAttribute("data-active", "");
          else (el as HTMLElement).removeAttribute("data-active");
        });
      }
      paint();
      // The tabs' own views are created after this one.
      requestAnimationFrame(paint);
      dom.addEventListener("nt-tabs-repaint", paint);

      return {
        dom,
        contentDOM: body,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          paint();
          return true;
        },
        stopEvent: (e) => e.target instanceof Element && bar.contains(e.target),
        // Our own marks on the tabs (which one shows) are no change to the document.
        ignoreMutation: (m) => (m.type === "attributes" && m.attributeName === "data-active") || (m.type !== "selection" && !body.contains(m.target)),
        destroy: () => document.querySelector(".nt-tabs-menu")?.remove(),
      };
    };
  },
});

const TabNode = Node.create({
  name: "tab",
  group: "bnBlock childContainer",
  content: "blockContainer+",
  priority: 40,
  defining: true,
  addAttributes() {
    return {
      ...idAttribute,
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") ?? "",
        renderHTML: (attrs) => (attrs.title ? { "data-title": String(attrs.title) } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-node-type="tab"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "nt-tab", "data-node-type": "tab" }), 0];
  },
  addNodeView() {
    return ({ node, getPos, view }): NodeView => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "nt-tab";
      dom.setAttribute("data-node-type", "tab");
      dom.setAttribute("role", "tabpanel");
      // Whether this tab is the one its block shows (redrawn tabs ask again).
      const paint = () => {
        if (current.attrs.id) dom.setAttribute("data-id", String(current.attrs.id));
        const p = getPos();
        if (typeof p !== "number") return;
        const $p = view.state.doc.resolve(p);
        if ($p.parent.type.name !== "tabs") return;
        if (activeIndex($p.parent) === $p.index()) dom.setAttribute("data-active", "");
        else dom.removeAttribute("data-active");
      };
      paint();
      return {
        dom,
        contentDOM: dom,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          paint();
          return true;
        },
        ignoreMutation: (m) => m.type === "attributes" && m.target === dom,
      };
    };
  },
});

/** Shows the tab the caret is in (after a search hit, a link to a block, arrow keys). */
function revealCaret(view: EditorView) {
  const $from = view.state.selection.$from;
  for (let d = $from.depth; d > 1; d--) {
    if ($from.node(d).type.name !== "tab" || $from.node(d - 1).type.name !== "tabs") continue;
    const list = $from.node(d - 1);
    const i = $from.index(d - 1);
    if (activeIndex(list) === i) continue;
    shown.set(String(list.attrs.id), tabIdAt(list, i));
    const dom = view.nodeDOM($from.before(d - 1));
    // Repaint through a no-op: the container view reads `shown` again.
    if (dom instanceof HTMLElement) dom.dispatchEvent(new CustomEvent("nt-tabs-repaint"));
  }
}

const TabsKeys = Extension.create({
  name: "ntTabsKeys",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      // Backspace at the very start of a tab's first block stays in the tab (it never merges tabs).
      Backspace: () => {
        const sel = this.editor.state.selection;
        const $from = sel.$from;
        if (!sel.empty || $from.parentOffset !== 0 || $from.depth < 3) return false;
        const d = $from.depth;
        return $from.node(d - 2).type.name === "tab" && $from.index(d - 2) === 0 && $from.node(d - 1).type.name === "blockContainer" && $from.parent.content.size === 0 && $from.node(d - 2).childCount === 1;
      },
    };
  },
});

const TabsExtension = createExtension(() => ({
  key: "ntTabs",
  tiptapExtensions: [TabsKeys],
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey("ntTabs"),
      // Every tabs / tab node has an id of its own (a paste or a copy brings none, or a twin).
      appendTransaction(trs, _old, state) {
        if (!trs.some((tr) => tr.docChanged)) return null;
        const seen = new Set<string>();
        let tr: ReturnType<typeof state.tr.setNodeMarkup> | null = null;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== "tabs" && node.type.name !== "tab") return true;
          const id = node.attrs.id ? String(node.attrs.id) : "";
          if (!id || seen.has(id)) {
            tr = (tr ?? state.tr).setNodeMarkup(pos, undefined, { ...node.attrs, id: newId() });
            seen.add(String((tr.doc.nodeAt(pos)?.attrs.id as string | undefined) ?? ""));
          } else seen.add(id);
          return true;
        });
        return tr;
      },
      view: () => ({
        update: (view, prev) => {
          if (!prev.selection.eq(view.state.selection)) revealCaret(view);
        },
      }),
    }),
  ],
}));

export const TabsBlock = createBlockSpecFromTiptapNode({ node: TabsNode, type: "tabs", content: "none" }, {}, [TabsExtension()]);
export const TabBlock = createBlockSpecFromTiptapNode({ node: TabNode, type: "tab", content: "none" }, { title: { default: "" } });

/** A new Tabs block: two empty tabs (Notion's "/tabs"). */
export function tabsLayout() {
  return { type: "tabs", children: [0, 1].map(() => ({ type: "tab", props: { title: "" }, children: [{ type: "paragraph" }] })) };
}
