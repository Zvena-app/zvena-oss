// zvena Documents: suggestion mode in the editor (Notion's "Suggest edits";
// the rules are lib/notes/suggestions.ts). While it is on, typing never
// changes the page itself: new text is marked as inserted ("suggestIns"),
// Backspace and Delete mark text as removed ("suggestDel") — text of one's
// own suggestion really goes — and Enter starts a suggested line (a block
// named sg~<suggestion>~<n>; the rest of the line moves there as a
// suggestion). Everything else that would change the page from here
// (formatting, the block menu, drops) is held back. Consecutive typing
// stays one suggestion.

import { Extension } from "@tiptap/core";
import { createExtension, type BlockNoteEditor, type BlockSchema, type InlineContentSchema, type StyleSchema } from "@blocknote/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import type { Mark, Node as PMNode, ResolvedPos, Schema } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { shortId } from "@/lib/notes/model";
import { SUGGEST_DEL, SUGGEST_INS, blockSuggestion, suggestedBlockId, suggestionEntries } from "@/lib/notes/suggestions";
import type { NoteComment } from "@/lib/notes/types";

type AnyEditor = BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>;

/** "off": edits are edits; "on": an editor suggests; "only": suggesting is all this person may do (Can comment). */
export type SuggestMode = "off" | "on" | "only";

export interface SuggestOptions {
  mode: () => SuggestMode;
  /** An open suggestion of this person's (they may grow it, or take it back). */
  mine: (sid: string) => boolean;
  /** A new suggestion started: its record goes into the page's comments. */
  onNew: (sid: string) => void;
  /** Runs a change to this person's suggestions (a commenter's live session sends it out). */
  wrap: (run: () => void) => void;
  /** A suggestion changed (a commenter's copy saves outside a session). */
  onChange: () => void;
}

/**
 * What the plugin asks the page, kept up to date by the editor as it
 * renders (the plugin lives as long as the editor; the page changes).
 */
export class SuggestControl implements SuggestOptions {
  private now: SuggestMode = "off";
  private comments: readonly NoteComment[] = [];
  private userId: string | null = null;
  /** Suggestions made in this editor whose record may not be back from sync yet. */
  private made = new Set<string>();
  private hooks: { onNew: (sid: string) => void; wrap: (run: () => void) => void; onChange: () => void } = { onNew: () => {}, wrap: (run) => run(), onChange: () => {} };

  set(state: { mode: SuggestMode; comments: readonly NoteComment[] | undefined; userId: string | null }): void {
    this.now = state.mode;
    this.comments = state.comments ?? [];
    this.userId = state.userId;
  }

  setHooks(hooks: SuggestControl["hooks"]): void {
    this.hooks = hooks;
  }

  mode = (): SuggestMode => this.now;

  /** A suggestion this editor started (only its records may be tidied away from here). */
  madeHere = (sid: string): boolean => this.made.has(sid);

  mine = (sid: string): boolean => {
    const rec = suggestionEntries(this.comments).get(sid);
    if (rec) return !rec.suggestion?.state && Boolean(this.userId && rec.authorId === this.userId);
    // No record: one made here — unless the id is someone's discussion.
    return this.made.has(sid) && !this.comments.some((c) => c.thread === sid);
  };

  onNew = (sid: string): void => {
    this.made.add(sid);
    this.hooks.onNew(sid);
  };

  wrap = (run: () => void): void => this.hooks.wrap(run);

  onChange = (): void => this.hooks.onChange();
}

const META = "ntSuggest";
export const suggestKey = new PluginKey("ntSuggest");

// Changes the app itself makes while suggesting (sync, accepting, discussion marks) pass.
let bypass = 0;
export function withoutSuggesting<T>(run: () => T): T {
  bypass += 1;
  try {
    return run();
  } finally {
    bypass -= 1;
  }
}

const sidOf = (m: Mark | undefined): string | null => (m && typeof m.attrs.stringValue === "string" ? m.attrs.stringValue : null);

/** Lists and to-dos go on as the same kind of item; anything else as text (Notion). */
const CONTINUES = new Set(["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"]);

function marks(schema: Schema) {
  return { ins: schema.marks[SUGGEST_INS], del: schema.marks[SUGGEST_DEL] };
}

/** A caret at `pos`, or the nearest place text can go. */
function caretAt(tr: Transaction, pos: number): TextSelection {
  const $p = tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size)));
  return $p.parent.inlineContent ? TextSelection.create(tr.doc, $p.pos) : (TextSelection.near($p) as TextSelection);
}

/** The block container around a position, and its depth. */
function containerAt($pos: ResolvedPos): { node: PMNode; depth: number } | null {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === "blockContainer") return { node: $pos.node(d), depth: d };
  return null;
}

/** The suggestion to add to at `pos`: one of this person's right next to it (or the suggested line it is on), else a new one. */
function pickSid(state: EditorState, pos: number, opts: SuggestOptions): { sid: string; fresh: boolean } {
  const { ins, del } = marks(state.schema);
  const $p = state.doc.resolve(pos);
  for (const node of [$p.nodeBefore, $p.nodeAfter]) {
    for (const m of node?.marks ?? []) {
      if (m.type !== ins && m.type !== del) continue;
      const sid = sidOf(m);
      if (sid && opts.mine(sid)) return { sid, fresh: false };
    }
  }
  const c = containerAt($p);
  const b = c ? blockSuggestion(c.node.attrs.id) : null;
  if (b && opts.mine(b)) return { sid: b, fresh: false };
  return { sid: shortId(), fresh: true };
}

/**
 * Marks [from, to) as suggested for removal: this person's own suggested
 * text really goes, someone else's suggestion and text already marked stay.
 * Only text (an inline node such as a mention cannot carry the mark).
 */
function markRemoved(tr: Transaction, from: number, to: number, sid: string, opts: SuggestOptions): void {
  const { ins, del } = marks(tr.doc.type.schema);
  const ranges: { from: number; to: number; drop: boolean }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const s = Math.max(from, pos);
    const e = Math.min(to, pos + node.nodeSize);
    if (s >= e) return false;
    const insSid = sidOf(node.marks.find((m) => m.type === ins));
    if (insSid) {
      if (opts.mine(insSid)) ranges.push({ from: s, to: e, drop: true });
    } else if (!node.marks.some((m) => m.type === del)) ranges.push({ from: s, to: e, drop: false });
    return false;
  });
  for (const r of ranges.reverse()) {
    if (r.drop) tr.delete(r.from, r.to);
    else tr.addMark(r.from, r.to, del.create({ stringValue: sid }));
  }
}

/** Inserts `text` at `pos` as suggested, with the formatting there (not the marks of other suggestions or discussions). */
function insertSuggested(tr: Transaction, state: EditorState, pos: number, text: string, sid: string, base: readonly Mark[]): number {
  const { ins, del } = marks(state.schema);
  const keep = base.filter((m) => m.type !== ins && m.type !== del && m.type.name !== "comment");
  tr.insert(pos, state.schema.text(text, [...keep, ins.create({ stringValue: sid })]));
  return pos + text.length;
}

/**
 * A suggested new line at `pos`: the rest of the line is marked removed
 * here and suggested on a new block below. Returns where the caret goes
 * (the start of the new line), or null when the line cannot be split so.
 */
function splitSuggested(tr: Transaction, state: EditorState, pos: number, sid: string, opts: SuggestOptions): number | null {
  const $p = tr.doc.resolve(pos);
  const c = containerAt($p);
  // Only a block's own line (not a table cell's).
  if (!c || !$p.parent.isTextblock || $p.depth !== c.depth + 1) return null;
  const { ins, del } = marks(state.schema);
  const mapFrom = tr.steps.length;
  const end = $p.end();
  // The rest of the line, as suggested text on the new line (plain text of the page only).
  const rest: PMNode[] = [];
  let plain = true;
  tr.doc.nodesBetween(pos, end, (node, at) => {
    if (node === $p.parent) return true;
    if (!node.isText) {
      plain = false;
      return false;
    }
    const s = Math.max(pos, at);
    const e = Math.min(end, at + node.nodeSize);
    const own = sidOf(node.marks.find((m) => m.type === ins));
    if (node.marks.some((m) => m.type === del) || (own && !opts.mine(own))) plain = false;
    const keep = node.marks.filter((m) => m.type !== ins && m.type !== del && m.type.name !== "comment");
    rest.push(state.schema.text(node.text!.slice(s - at, e - at), [...keep, ins.create({ stringValue: sid })]));
    return false;
  });
  const type = CONTINUES.has($p.parent.type.name) ? $p.parent.type : state.schema.nodes.paragraph;
  if (plain && rest.length) markRemoved(tr, pos, end, sid, opts);
  const after = tr.mapping.slice(mapFrom).map($p.after(c.depth));
  const block = state.schema.nodes.blockContainer.create({ id: suggestedBlockId(sid, shortId()) }, type.create(null, plain ? rest : []));
  tr.insert(after, block);
  return after + 2;
}

/** How far a Backspace or Delete reaches from `pos` in its line: a character, a word or the rest of the line. */
function reach($p: ResolvedPos, pos: number, back: boolean, unit: "char" | "word" | "line"): number {
  const start = $p.start();
  const end = $p.end();
  if (unit === "line") return back ? start : end;
  const text = $p.parent.textBetween(back ? 0 : pos - start, back ? pos - start : end - start, undefined, "\ufffc");
  if (unit === "word") {
    const m = back ? /(\s*[^\s]+|\s+)$/u.exec(text) : /^(\s*[^\s]+|\s+)/u.exec(text);
    const n = m ? m[0].length : 1;
    return back ? pos - n : pos + n;
  }
  // One character (a surrogate pair is one).
  const code = back ? text.charCodeAt(text.length - 1) : text.charCodeAt(0);
  const pair = back ? code >= 0xdc00 && code <= 0xdfff : code >= 0xd800 && code <= 0xdbff;
  return back ? pos - (pair ? 2 : 1) : pos + (pair ? 2 : 1);
}

/** Text already suggested for removal at `pos` (any suggestion's): a removal skips over it. */
function removedAt(state: EditorState, pos: number, forward: boolean): boolean {
  const { del } = marks(state.schema);
  const $p = state.doc.resolve(pos);
  const node = forward ? $p.nodeAfter : $p.nodeBefore;
  return Boolean(node?.isText && node.marks.some((m) => m.type === del));
}

function plugin(opts: SuggestOptions): Plugin {
  const active = () => bypass === 0 && opts.mode() !== "off";
  const send = (view: EditorView, tr: Transaction, fresh: string | null) => {
    tr.setMeta(META, true).scrollIntoView();
    opts.wrap(() => view.dispatch(tr));
    if (fresh) opts.onNew(fresh);
    opts.onChange();
  };
  const remove = (view: EditorView, back: boolean, unit: "char" | "word" | "line"): boolean => {
    const { state } = view;
    const sel = state.selection;
    const tr = state.tr;
    let from = sel.from;
    let to = sel.to;
    if (sel.empty) {
      const $c = sel.$from;
      if (!$c.parent.isTextblock) return true;
      const start = $c.start();
      const end = $c.end();
      let at = sel.from;
      // Past text already suggested for removal.
      while (back ? at > start && removedAt(state, at, false) : at < end && removedAt(state, at, true)) at += back ? -1 : 1;
      if (back ? at <= start : at >= end) {
        // A line of one's own suggestion, left empty: Backspace takes it back.
        const c = containerAt($c);
        const b = c ? blockSuggestion(c.node.attrs.id) : null;
        if (back && c && b && opts.mine(b) && $c.parent.content.size === 0 && c.node.lastChild?.type.name !== "blockGroup") {
          const pos = $c.before(c.depth);
          tr.delete(pos, pos + c.node.nodeSize);
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, pos - 1)), -1));
          send(view, tr, null);
          return true;
        }
        tr.setSelection(caretAt(tr, at));
        view.dispatch(tr.setMeta(META, true));
        return true;
      }
      const other = reach(state.doc.resolve(at), at, back, unit);
      from = Math.min(at, other);
      to = Math.max(at, other);
    }
    const { sid, fresh } = pickSid(state, back ? to : from, opts);
    markRemoved(tr, from, to, sid, opts);
    // Backspace leaves the caret before what it marked, Delete after it.
    const caret = back || !sel.empty ? tr.mapping.map(from, -1) : tr.mapping.map(to);
    tr.setSelection(caretAt(tr, caret));
    send(view, tr, fresh && tr.docChanged && removedSomething(tr, sid) ? sid : null);
    return true;
  };
  const type = (view: EditorView, from: number, to: number, text: string): boolean => {
    const { state } = view;
    const $from = state.doc.resolve(from);
    if (!$from.parent.isTextblock) return true;
    const { sid, fresh } = pickSid(state, from, opts);
    const tr = state.tr;
    const base = state.storedMarks ?? $from.marks();
    let at = to;
    if (from < to) {
      markRemoved(tr, from, to, sid, opts);
      at = tr.mapping.map(to);
    }
    // In code a new line is text; elsewhere each further line is a suggested line of its own.
    const lines = $from.parent.type.spec.code ? [text] : text.replace(/\r\n?/g, "\n").split("\n");
    let caret = insertSuggested(tr, state, at, lines[0], sid, base);
    for (const line of lines.slice(1)) {
      const next = splitSuggested(tr, state, caret, sid, opts);
      if (next === null) break;
      caret = line ? insertSuggested(tr, state, next, line, sid, base) : next;
    }
    tr.setSelection(caretAt(tr, caret));
    send(view, tr, fresh ? sid : null);
    return true;
  };
  return new Plugin({
    key: suggestKey,
    props: {
      handleTextInput(view, from, to, text) {
        if (!active()) return false;
        return type(view, from, to, text);
      },
      handleKeyDown(view, event) {
        if (!active() || event.isComposing) return false;
        const mod = event.metaKey || event.ctrlKey;
        if (event.key === "Backspace" || event.key === "Delete") {
          const unit = event.metaKey ? "line" : event.altKey || event.ctrlKey ? "word" : "char";
          return remove(view, event.key === "Backspace", unit);
        }
        if (event.key === "Enter" && !mod) {
          if (event.shiftKey) return true;
          const { state } = view;
          const tr = state.tr;
          const sel = state.selection;
          const { sid, fresh } = pickSid(state, sel.from, opts);
          let at = sel.to;
          if (!sel.empty) {
            markRemoved(tr, sel.from, sel.to, sid, opts);
            at = tr.mapping.map(sel.to);
          }
          // In code, a new line is text.
          if (state.doc.resolve(sel.from).parent.type.spec.code) {
            tr.setSelection(caretAt(tr, insertSuggested(tr, state, at, "\n", sid, [])));
          } else {
            const caret = splitSuggested(tr, state, at, sid, opts);
            if (caret === null) return true;
            tr.setSelection(caretAt(tr, caret));
          }
          send(view, tr, fresh ? sid : null);
          return true;
        }
        return false;
      },
      handleDrop() {
        return active();
      },
      // DOM events first: BlockNote reads pastes and cuts there too, ahead of ProseMirror's own handlers.
      handleDOMEvents: {
        paste(view, event) {
          if (!active()) return false;
          event.preventDefault();
          // Pasted as suggested text (lines as suggested lines); formatting stays behind.
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (text) type(view, view.state.selection.from, view.state.selection.to, text.slice(0, 20_000));
          return true;
        },
        cut(view, event) {
          if (!active()) return false;
          const { from, to, empty } = view.state.selection;
          event.preventDefault();
          if (empty) return true;
          event.clipboardData?.setData("text/plain", view.state.doc.textBetween(from, to, "\n", "\ufffc"));
          const { sid, fresh } = pickSid(view.state, from, opts);
          const tr = view.state.tr;
          markRemoved(tr, from, to, sid, opts);
          tr.setSelection(caretAt(tr, tr.mapping.map(from, -1)));
          send(view, tr, fresh && removedSomething(tr, sid) ? sid : null);
          return true;
        },
      },
    },
    // Anything else that would change the page from here waits: the server would refuse it from
    // someone who may only comment, and an editor who suggests means to suggest.
    filterTransaction(tr) {
      if (!active() || !tr.docChanged) return true;
      if (tr.getMeta(META) || tr.getMeta("y-sync$") || tr.getMeta("history$")) return true;
      // Discussion marks are not edits.
      if (tr.steps.every((s) => {
        const j = s.toJSON() as { stepType?: string; mark?: { type?: string } };
        return (j.stepType === "addMark" || j.stepType === "removeMark") && j.mark?.type === "comment";
      }))
        return true;
      // What plugins add on their own (ids, trailing lines, links) is the editor's, never a commenter's.
      if (tr.getMeta("appendedTransaction")) return opts.mode() !== "only";
      return false;
    },
  });
}

/** Whether a removal changed anything (a fresh suggestion that only skipped text needs no record). */
function removedSomething(tr: Transaction, sid: string): boolean {
  let hit = false;
  tr.doc.descendants((node) => {
    if (hit) return false;
    if (node.isText && node.marks.some((m) => sidOf(m) === sid)) hit = true;
    return !hit;
  });
  return hit;
}

export const SuggestExtension = createExtension(({ options }: { editor: AnyEditor; options: SuggestOptions }) => ({
  key: "ntSuggest",
  tiptapExtensions: [
    Extension.create({
      name: "ntSuggest",
      // Ahead of everything that reads typing (the "/" menu, Markdown shortcuts, list keys).
      priority: 10_000,
      addProseMirrorPlugins() {
        return [plugin(options)];
      },
    }),
  ],
}));

// ---------------------------------------------------------------------------
// Reading and deciding suggestions in the editor

export interface OpenSuggestion {
  sid: string;
  ins: string;
  del: string;
  /** Where it starts in the document. */
  pos: number;
}

/** The suggestions in a document, in page order. */
export function suggestionsIn(doc: PMNode): OpenSuggestion[] {
  const out = new Map<string, OpenSuggestion>();
  const at = (sid: string, pos: number) => {
    let s = out.get(sid);
    if (!s) out.set(sid, (s = { sid, ins: "", del: "", pos }));
    return s;
  };
  doc.descendants((node, pos) => {
    if (node.type.name === "blockContainer") {
      const b = blockSuggestion(node.attrs.id);
      if (b) {
        const s = at(b, pos);
        if (s.ins) s.ins += "\n";
      }
      return true;
    }
    if (!node.isText) return true;
    for (const m of node.marks) {
      const sid = sidOf(m);
      if (!sid) continue;
      if (m.type.name === SUGGEST_INS) at(sid, pos).ins += node.text ?? "";
      else if (m.type.name === SUGGEST_DEL) at(sid, pos).del += node.text ?? "";
    }
    return false;
  });
  return [...out.values()];
}

/** The transaction accepting (or rejecting) suggestions: their text and lines become the page's, or go. */
export function decideTr(state: EditorState, sids: ReadonlySet<string>, accept: boolean, newId: () => string): Transaction | null {
  const { ins, del } = marks(state.schema);
  type Op = { from: number; to: number; run: (tr: Transaction) => void };
  const ops: Op[] = [];
  const gone: { from: number; to: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === "blockContainer") {
      const b = blockSuggestion(node.attrs.id);
      if (b && sids.has(b)) {
        if (accept) ops.push({ from: pos, to: pos, run: (tr) => tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: newId() }) });
        else {
          gone.push({ from: pos, to: pos + node.nodeSize });
          ops.push({ from: pos, to: pos + node.nodeSize, run: (tr) => tr.delete(pos, pos + node.nodeSize) });
          return false;
        }
      }
      return true;
    }
    if (!node.isText) return true;
    const from = pos;
    const to = pos + node.nodeSize;
    for (const m of node.marks) {
      const sid = sidOf(m);
      if (!sid || !sids.has(sid) || (m.type !== ins && m.type !== del)) continue;
      const drop = (m.type === ins) !== accept;
      ops.push({ from, to, run: (tr) => (drop ? tr.delete(from, to) : tr.removeMark(from, to, m)) });
    }
    return false;
  });
  if (!ops.length) return null;
  const tr = state.tr;
  // From the end, so the positions read before still hold.
  for (const op of ops.filter((o) => !gone.some((g) => o.from > g.from && o.to <= g.to)).sort((a, b) => b.from - a.from || b.to - a.to)) op.run(tr);
  return tr.setMeta(META, true);
}
