"use client";

// The page editor: BlockNote under Notion's chrome — "/" menu, "@" and "[["
// mentions, the selection toolbar and the ⋮⋮ block handle with its menu.
// Content saves to the store as you type and follows outside changes (sync,
// other tabs, the sidebar).

import { createPortal } from "react-dom";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { Component, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FilePanelController,
  FormattingToolbarController,
  LinkToolbarController,
  SideMenuController,
  SuggestionMenuController,
  GridSuggestionMenuController,
  getDefaultReactEmojiPickerItems,
  useActiveStyles,
  useBlockNoteEditor,
  useCreateBlockNote,
  useExtension,
  useExtensionState,
  useSelectedBlocks,
  type SuggestionMenuProps,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import { FilePanelExtension, SideMenuExtension, SuggestionMenu as SuggestionMenuExt, filterSuggestionItems } from "@blocknote/core/extensions";
import * as locales from "@blocknote/core/locales";
import { withCollaboration } from "@blocknote/core/yjs";
import type { BlockNoteEditorOptions } from "@blocknote/core";
import {
  AlignLeft,
  Baseline,
  Bold,
  Calendar,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  CornerUpRight,
  Database,
  FileText,
  GalleryHorizontalEnd,
  Globe,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Image as ImageIcon,
  Italic,
  KanbanSquare,
  Link,
  Link2,
  MessageSquare,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  Minus,
  Music,
  Paintbrush,
  Paperclip,
  Plus,
  Quote,
  Sigma,
  Smile,
  SquareCode,
  Strikethrough,
  Table,
  Table2,
  Trash2,
  Type,
  Underline,
  Video,
  Workflow,
  PenTool,
  CircleDot,
  CalendarDays,
  GanttChart,
  MousePointerClick,
  AlarmClock,
  RefreshCw,
  ClipboardList,
  ChevronsRight,
  Columns2,
  Columns3,
  Columns4,
  ChartColumn,
  ListCollapse,
  MessageSquareQuote,
  Repeat2,
  ArrowUpRight,
  Check,
  AtSign,
  IndentIncrease,
  IndentDecrease,
  Undo2,
  Redo2,
  AlignCenter,
  AlignRight,
  Captions,
  Download,
  Maximize2,
  PanelTop,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { localYmd, parseHumanDateTime } from "@/lib/notes/dates";
import { dateTimePart } from "@/lib/notes/reminders";
import { askReminderPermission } from "@/lib/notes/notify-permission";
import { ThreadPopover } from "./Comments";
import { EMBED_PROVIDERS, embedSrc, notesSchema, registerDbRenderer, registerSyncedRenderer, type EmbedProvider, type NotesBlock, type NotesEditor, type NotesSchema } from "./blocks";
import { columnDropCursor, columnLayout } from "./columns";
import { setTabsText, tabsLayout } from "./tabs";
import { CodeHighlightExtension } from "./codeHighlight";
import { NotionKeysExtension } from "./notionKeys";
import { LinkedPicker } from "./database/LinkedPicker";
import { markFreshButton } from "./button";
import { Avatar, matchPeople } from "./people";
import { people } from "@/lib/notes/people";
import { PageIdContext, useNotes } from "./context";
import { NotionFilePanel } from "./FilePanel";
import { databasePart, lazyComponent } from "./lazy";
import { Menu, Popover, Portal, layer as notesLayer, toast, type Anchor, type MenuGroup } from "./ui";
import { defaultView, displayTitle, linkedChildIds, linkedNoteId, noteSlug, shortId, withoutBlockIds } from "@/lib/notes/model";
import { searchCustomEmoji } from "@/lib/notes/emoji";
import { BlockMovePanel } from "./BlockMove";
import { linkPreview } from "./link-mention";
import { withWs } from "@/lib/notes/workspace";
import type { Note, NoteColor } from "@/lib/notes/types";
import { NOTE_COLORS } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { NoteIcon } from "./NoteIcon";
import { turnIntoIssue, useDocConversions } from "@/components/eco/IssueBlock";
import { et } from "@/components/eco/i18n";
import type { CollabProvider } from "@/lib/notes/collab-client";
import { COLLAB_FRAGMENT } from "@/lib/notes/collab-shared";
import { useCollabEditor } from "./collab-editor";
import { intlOf, nearDay } from "@/i18n/locales";
import { blockNoteLocale } from "./blocknote-locale";
import { blockOfHash, flashBlock } from "./block-link";
import { FindBar, FindExtension } from "./FindReplace";
import { MarkdownExtrasExtension } from "./markdown-rules";
import { SuggestControl, SuggestExtension, decideTr, withoutSuggesting, type SuggestMode } from "./suggest";
import { SuggestColors, SuggestGutter, suggestionEl, useOpenSuggestions } from "./SuggestGutter";
import { suggestionEntries, suggestionIds } from "@/lib/notes/suggestions";

const InlineDatabase = lazyComponent(databasePart, (m) => m.DatabaseView, <div className="nt-db-wait nt-db-wait-inline" aria-busy="true" />);

export interface EditorHandle {
  focusStart: () => void;
  editor: NotesEditor | null;
}

// ---------------------------------------------------------------------------
// Phones: Notion's toolbar above the on-screen keyboard while editing

/** A touch screen without a mouse: phones and tablets get the bottom toolbar instead of floating ones. */
const isTouchScreen = () => typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/**
 * The bar above the keyboard. With text selected it turns into the
 * formatting bar (bold, italic, strike-through, link, comment), so
 * phones never get BlockNote's own mobile bar on top of it (v1 F42: the two
 * overlapped into one strip). Rendered inside BlockNoteView for its context,
 * into the Notes layer (portalled straight to <body> it had no design tokens:
 * a see-through bar over the page).
 */
function MobileToolbar({ editor, root, onInsert, onMention, onComment }: { editor: NotesEditor; root: React.RefObject<HTMLDivElement | null>; onInsert: () => void; onMention: () => void; onComment: () => void }) {
  const { t } = useNotes();
  const [touch] = useState(isTouchScreen);
  const [show, setShow] = useState(false);
  // A non-empty selection in text blocks: the formatting row.
  const [formatting, setFormatting] = useState(false);
  const [link, setLink] = useState<HTMLElement | null>(null);
  const styles = useActiveStyles(editor as never) as Record<string, unknown>;
  useEffect(() => {
    if (!touch) return;
    const check = () => {
      const text = editor.getSelectedText().trim();
      const blocks = (editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]) as NotesBlock[];
      setFormatting(Boolean(text) && blocks.every((b) => TEXT_TYPES.has(b.type)));
    };
    check();
    return editor.onSelectionChange(check);
  }, [editor, touch]);
  const [lift, setLift] = useState(0);
  const [turn, setTurn] = useState<HTMLElement | null>(null);
  // The block's menu (⋮⋮ has no hover on touch screens): delete, duplicate, move up/down, color…
  const [blockMenu, setBlockMenu] = useState<{ el: HTMLElement; block: NotesBlock } | null>(null);
  // The turn-into menu takes focus from the editor; the bar stays while it's open.
  const turnOpen = useRef(false);
  useEffect(() => {
    turnOpen.current = Boolean(turn || blockMenu);
  }, [turn, blockMenu]);
  useEffect(() => {
    const el = root.current;
    if (!touch || !el) return;
    const on = () => setShow(true);
    const off = (e: FocusEvent) => {
      const to = e.relatedTarget as HTMLElement | null;
      if (turnOpen.current || (to && (el.contains(to) || to.closest(".nt-mtb, .nt-popover")))) return;
      setShow(false);
    };
    el.addEventListener("focusin", on);
    el.addEventListener("focusout", off);
    return () => {
      el.removeEventListener("focusin", on);
      el.removeEventListener("focusout", off);
    };
  }, [root, touch]);
  // iOS shrinks the visual viewport for the keyboard, not the layout one.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!show || !vv) return;
    // The keyboard's height also goes to CSS (--nt-kb): on phones the /, @ and : menus sit on this bar.
    const place = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setLift(kb);
      document.documentElement.style.setProperty("--nt-kb", `${kb}px`);
    };
    place();
    vv.addEventListener("resize", place);
    vv.addEventListener("scroll", place);
    return () => {
      vv.removeEventListener("resize", place);
      vv.removeEventListener("scroll", place);
      document.documentElement.style.removeProperty("--nt-kb");
    };
  }, [show]);
  if (!touch || !show || typeof document === "undefined") return null;
  const cur = () => editor.getTextCursorPosition().block as NotesBlock;
  const run = (fn: () => void) => () => {
    fn();
    editor.focus();
  };
  const btn = (key: string, label: string, icon: ReactNode, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, disabled = false) => (
    <button key={key} type="button" className="nt-mtb-btn nt-btn-reset" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {icon}
    </button>
  );
  const toggle = (style: string) => run(() => editor.toggleStyles({ [style]: true } as never));
  const styleBtn = (key: string, label: string, icon: ReactNode) => (
    <button key={key} type="button" className="nt-mtb-btn nt-btn-reset" aria-label={label} aria-pressed={Boolean(styles[key])} title={label} data-on={styles[key] ? "true" : undefined} onClick={toggle(key)}>
      {icon}
    </button>
  );
  if (formatting) {
    // The link editor is the bar's sibling, not its child: the bar cancels
    // pointer presses (the caret stays in the page), which would also stop a
    // tap from placing the caret in the link field.
    return createPortal(
      <>
        <div className="nt-mtb" role="toolbar" aria-label={t("mtb.label")} style={{ transform: `translateY(${-lift}px)` }} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
          {styleBtn("bold", t("fmt.bold"), <Bold />)}
          {styleBtn("italic", t("fmt.italic"), <Italic />)}
          {styleBtn("strike", t("fmt.strike"), <Strikethrough />)}
          {btn("link", t("fmt.link"), <Link2 />, (e) => setLink(e.currentTarget))}
          {btn("comment", t("fmt.comment"), <MessageSquare />, () => onComment())}
          <span className="nt-mtb-gap" />
          {btn("done", t("mtb.done"), <ChevronDown />, () => (document.activeElement as HTMLElement | null)?.blur())}
        </div>
        {link && <LinkInput anchor={link} onClose={() => setLink(null)} />}
      </>,
      notesLayer()
    );
  }
  return createPortal(
    <div className="nt-mtb" role="toolbar" aria-label={t("mtb.label")} style={{ transform: `translateY(${-lift}px)` }} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      {btn("insert", t("mtb.insert"), <Plus />, run(onInsert))}
      {btn("turn", t("block.turnInto"), <Type />, (e) => setTurn(e.currentTarget))}
      {btn("block", t("db.options"), <GripVertical />, (e) => setBlockMenu({ el: e.currentTarget, block: cur() }))}
      {btn(
        "todo",
        t("slash.todo"),
        <ListChecks />,
        run(() => {
          const b = cur();
          if (b.type === "checkListItem") editor.updateBlock(b, { props: { checked: !(b.props as { checked?: boolean }).checked } } as never);
          else editor.updateBlock(b, { type: "checkListItem" } as never);
        })
      )}
      {btn("mention", t("mtb.mention"), <AtSign />, run(onMention))}
      {btn("indent", t("kbd.indent"), <IndentIncrease />, run(() => editor.nestBlock()), !editor.canNestBlock())}
      {btn("outdent", t("kbd.outdent"), <IndentDecrease />, run(() => editor.unnestBlock()), !editor.canUnnestBlock())}
      {btn("undo", t("kbd.undo"), <Undo2 />, run(() => editor.undo()))}
      {btn("redo", t("kbd.redo"), <Redo2 />, run(() => editor.redo()))}
      <span className="nt-mtb-gap" />
      {btn("done", t("mtb.done"), <ChevronDown />, () => (document.activeElement as HTMLElement | null)?.blur())}
      {blockMenu && (
        <Popover anchor={blockMenu.el} placement="top-start" onClose={() => setBlockMenu(null)}>
          <BlockMenu block={blockMenu.block} onClose={() => (setBlockMenu(null), editor.focus())} />
        </Popover>
      )}
      {turn && (
        <Popover anchor={turn} placement="top-start" onClose={() => setTurn(null)}>
          <Menu
            width={240}
            onClose={() => setTurn(null)}
            groups={[
              {
                key: "t",
                label: t("block.turnInto"),
                items: TURN_INTO.slice(0, 11).map((x) => ({
                  key: x.key,
                  label: t(x.label as NotesKey),
                  icon: x.icon,
                  checked: blockKind(cur() as never) === x.key,
                  onSelect: () => {
                    editor.updateBlock(cur(), x.block as never);
                    setTurn(null);
                    editor.focus();
                  },
                })),
              },
            ]}
          />
        </Popover>
      )}
    </div>,
    notesLayer()
  );
}

// ---------------------------------------------------------------------------
// "Copy" on the code block under the mouse (Notion)

function CodeCopy({ editor, root }: { editor: NotesEditor; root: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useNotes();
  const [at, setAt] = useState<{ id: string; top: number; left: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const move = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.(".nt-code-copy")) return;
      const code = target.closest?.('[data-content-type="codeBlock"]') as HTMLElement | null;
      // Code inside a nested (synced) editor belongs to that editor's button.
      if (!code || code.closest(".nt-editor") !== el) return setAt((cur) => (cur ? null : cur));
      const id = code.closest("[data-id]")?.getAttribute("data-id");
      if (!id) return;
      const r = code.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const next = { id, top: Math.round(r.top - b.top + 6), left: Math.round(r.right - b.left - 8) };
      setAt((cur) => (cur && cur.id === next.id && cur.top === next.top && cur.left === next.left ? cur : next));
    };
    const leave = () => setAt(null);
    el.addEventListener("mousemove", move);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener("mousemove", move);
      el.removeEventListener("mouseleave", leave);
    };
  }, [root]);
  if (!at) return null;
  const copy = () => {
    const block = editor.getBlock(at.id) as { content?: unknown } | undefined;
    const text = Array.isArray(block?.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? "").join("") : "";
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(at.id);
    setTimeout(() => setCopied((c) => (c === at.id ? null : c)), 1500);
  };
  return (
    <button type="button" className="nt-code-copy nt-btn-reset" style={{ top: at.top, left: at.left }} contentEditable={false} onMouseDown={(e) => e.preventDefault()} onClick={copy}>
      {copied === at.id ? <Check size={13} /> : <Copy size={13} />}
      {copied === at.id ? t("code.copied") : t("code.copy")}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Slash menu

interface SlashItem {
  key: string;
  title: string;
  subtext?: string;
  group: string;
  icon: ReactNode;
  aliases?: string[];
  hint?: string;
  onItemClick: () => void;
}

/**
 * Phones dock the /, @ and [[ menus on the bar above the keyboard (responsive/docs.css):
 * the page scrolls so the line being typed stays above the menu (Notion's iOS app).
 */
function useCaretAboveMenu(ref: React.RefObject<HTMLDivElement | null>, shown: boolean) {
  useEffect(() => {
    if (!shown || !window.matchMedia("(pointer: coarse) and (max-width: 640px), (pointer: coarse) and (max-height: 500px)").matches) return;
    const id = requestAnimationFrame(() => {
      const menu = ref.current;
      const sel = window.getSelection();
      if (!menu || !sel?.rangeCount) return;
      const caret = sel.getRangeAt(0).getBoundingClientRect();
      const over = caret.bottom + 12 - menu.getBoundingClientRect().top;
      const scroller = (sel.anchorNode?.parentElement ?? null)?.closest<HTMLElement>(".nt-peek-scroll, .nt-scroller");
      if (over > 0 && caret.height > 0 && scroller) scroller.scrollBy({ top: over });
    });
    return () => cancelAnimationFrame(id);
  }, [ref, shown]);
}

function SlashMenu(props: SuggestionMenuProps<SlashItem>) {
  const { t } = useNotes();
  const ref = useRef<HTMLDivElement>(null);
  useCaretAboveMenu(ref, props.items.length > 0);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [props.selectedIndex]);
  if (props.items.length === 0) {
    return (
      <div className="nt-popover nt-slash" style={{ position: "static" }}>
        <div className="nt-slash-empty">{t("slash.noResults")}</div>
      </div>
    );
  }
  return (
    <div ref={ref} className="nt-popover nt-slash" style={{ position: "static", animation: "none" }} onMouseDown={(e) => e.preventDefault()}>
      {props.items.map((item, i) => {
        const head = i === 0 || item.group !== props.items[i - 1].group ? item.group : null;
        return (
          <div key={item.key}>
            {head && <div className="nt-menu-label">{head}</div>}
            <div className="nt-slash-item" data-active={i === props.selectedIndex || undefined} onClick={() => props.onItemClick?.(item)}>
              <span className="nt-slash-thumb">{item.icon}</span>
              <span className="nt-slash-text">
                <div className="nt-slash-title">{item.title}</div>
              </span>
              {item.hint && <span className="nt-slash-kbd">{item.hint}</span>}
            </div>
          </div>
        );
      })}
      <div className="nt-slash-foot">
        <span>{t("search.hint")}</span>
        <span>esc</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mention menu ("@" / "[[")

interface MentionItem {
  key: string;
  title: string;
  group: string;
  icon: ReactNode;
  onItemClick: () => void;
}

function MentionMenu(props: SuggestionMenuProps<MentionItem>) {
  const { t } = useNotes();
  const ref = useRef<HTMLDivElement>(null);
  useCaretAboveMenu(ref, props.items.length > 0);
  if (props.items.length === 0) {
    return (
      <div className="nt-popover nt-slash" style={{ position: "static" }}>
        <div className="nt-slash-empty">{t("slash.noResults")}</div>
      </div>
    );
  }
  return (
    <div ref={ref} className="nt-popover nt-slash" style={{ position: "static", animation: "none" }} onMouseDown={(e) => e.preventDefault()}>
      {props.items.map((item, i) => {
        const head = i === 0 || item.group !== props.items[i - 1].group ? item.group : null;
        return (
          <div key={item.key}>
            {head && <div className="nt-menu-label">{head}</div>}
            <div className="nt-slash-item" data-active={i === props.selectedIndex || undefined} onClick={() => props.onItemClick?.(item)}>
              <span className="nt-slash-thumb">{item.icon}</span>
              <span className="nt-slash-text">
                <div className="nt-slash-title">{item.title}</div>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "+" opens its menu at the start of a line or after a space, never in code. */
function plusOpens(tr: import("prosemirror-state").Transaction): boolean {
  const $f = tr.selection.$from;
  if ($f.parent.type.spec.code) return false;
  const before = $f.parent.textBetween(Math.max(0, $f.parentOffset - 1), $f.parentOffset, undefined, "\ufffc");
  return before === "" || /\s/.test(before);
}

// ---------------------------------------------------------------------------
// Block types ("Turn into")

interface TurnInto {
  key: string;
  label: NotesKey;
  icon: ReactNode;
  block: { type: string; props?: Record<string, unknown> };
}

const TURN_INTO: TurnInto[] = [
  { key: "paragraph", label: "slash.text", icon: <Type />, block: { type: "paragraph" } },
  { key: "h1", label: "slash.h1", icon: <Heading1 />, block: { type: "heading", props: { level: 1, isToggleable: false } } },
  { key: "h2", label: "slash.h2", icon: <Heading2 />, block: { type: "heading", props: { level: 2, isToggleable: false } } },
  { key: "h3", label: "slash.h3", icon: <Heading3 />, block: { type: "heading", props: { level: 3, isToggleable: false } } },
  { key: "h4", label: "slash.h4", icon: <Heading4 />, block: { type: "heading", props: { level: 4, isToggleable: false } } },
  { key: "bullet", label: "slash.bullet", icon: <List />, block: { type: "bulletListItem" } },
  { key: "numbered", label: "slash.numbered", icon: <ListOrdered />, block: { type: "numberedListItem" } },
  { key: "todo", label: "slash.todo", icon: <ListChecks />, block: { type: "checkListItem" } },
  { key: "toggle", label: "slash.toggle", icon: <ListCollapse />, block: { type: "toggleListItem" } },
  { key: "code", label: "slash.code", icon: <SquareCode />, block: { type: "codeBlock" } },
  { key: "quote", label: "slash.quote", icon: <Quote />, block: { type: "quote" } },
  { key: "callout", label: "slash.callout", icon: <MessageSquareQuote />, block: { type: "callout" } },
  { key: "th1", label: "slash.toggleH1", icon: <Heading1 />, block: { type: "heading", props: { level: 1, isToggleable: true } } },
  { key: "th2", label: "slash.toggleH2", icon: <Heading2 />, block: { type: "heading", props: { level: 2, isToggleable: true } } },
  { key: "th3", label: "slash.toggleH3", icon: <Heading3 />, block: { type: "heading", props: { level: 3, isToggleable: true } } },
  { key: "th4", label: "slash.toggleH4", icon: <Heading4 />, block: { type: "heading", props: { level: 4, isToggleable: true } } },
];

/** The plain text of a block's inline content. */
function inlinePlain(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((c: { type?: string; text?: string; content?: unknown }) => (c.type === "text" ? (c.text ?? "") : c.type === "link" ? inlinePlain(c.content) : "")).join("");
}

function blockKind(b: { type: string; props?: Record<string, unknown> } | undefined): string {
  if (!b) return "paragraph";
  if (b.type === "heading") return `${b.props?.isToggleable ? "th" : "h"}${b.props?.level ?? 1}`;
  return TURN_INTO.find((x) => x.block.type === b.type)?.key ?? b.type;
}

const TEXT_TYPES = new Set(["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote", "callout", "codeBlock"]);

function ColorSwatch({ color, bg }: { color: NoteColor; bg?: boolean }) {
  const c = color === "default" ? "var(--nt-text)" : `var(--nt-c-${color})`;
  const b = bg ? (color === "default" ? "transparent" : `var(--nt-b-${color})`) : "transparent";
  return (
    <span className="nt-color-a" style={{ color: bg ? "var(--nt-text)" : c, background: b }}>
      A
    </span>
  );
}

/** The color last picked anywhere in a page (Notion's ⌘⇧H applies it again). */
let lastColor: { kind: "text" | "bg"; color: NoteColor } | null = null;

/** ⌘⇧H: the last color on the selected text, or on the block. */
function applyLastColor(editor: NotesEditor): boolean {
  if (!lastColor) return false;
  const key = lastColor.kind === "bg" ? "backgroundColor" : "textColor";
  if (editor.getSelectedText()) {
    if (lastColor.color === "default") editor.removeStyles({ [key]: "" } as never);
    else editor.addStyles({ [key]: lastColor.color } as never);
    return true;
  }
  const b = editor.getTextCursorPosition().block as NotesBlock;
  const prop = lastColor.kind === "bg" && b.type === "callout" ? "color" : key;
  if (!(prop in (b.props as Record<string, unknown>))) return false;
  editor.updateBlock(b, { props: { [prop]: lastColor.color } } as never);
  return true;
}

/** Notion's "Turn into → Page": the text becomes the title, nested blocks the body. */
function blockToPage(editor: NotesEditor, block: NotesBlock, pageId: string, api: Pick<ReturnType<typeof useNotes>, "newPage" | "store">): void {
  const title = inlinePlain(block.content).trim().slice(0, 2000);
  const child = api.newPage(pageId, { stay: true, title, content: withoutBlockIds(block.children ?? []) });
  // Sub-pages nested in the block move with it (left here, the save would trash them).
  for (const id of linkedChildIds(block.children ?? [])) if (api.store.get(id)?.parentId === pageId) api.store.update(id, { parentId: child.id });
  editor.replaceBlocks([block], [{ type: "page", props: { noteId: child.id } }] as never);
}

function colorGroups(t: (k: NotesKey, v?: Record<string, string | number>) => string, pick: (kind: "text" | "bg", c: NoteColor) => void, current?: { text?: string; bg?: string }): MenuGroup[] {
  const onPick = (kind: "text" | "bg", c: NoteColor) => {
    lastColor = { kind, color: c };
    pick(kind, c);
  };
  return [
    {
      key: "text",
      label: t("block.textColor"),
      items: NOTE_COLORS.map((c) => ({
        key: `t-${c}`,
        label: t(`color.${c}` as NotesKey),
        icon: <ColorSwatch color={c} />,
        checked: (current?.text ?? "default") === c,
        onSelect: () => onPick("text", c),
      })),
    },
    {
      key: "bg",
      label: t("block.bgColor"),
      items: NOTE_COLORS.map((c) => ({
        key: `b-${c}`,
        label: c === "default" ? t("color.default") : t("color.bg", { color: t(`color.${c}` as NotesKey) }),
        icon: <ColorSwatch color={c} bg />,
        checked: (current?.bg ?? "default") === c,
        onSelect: () => onPick("bg", c),
      })),
    },
  ];
}

// ---------------------------------------------------------------------------
// Side menu (+ / ⋮⋮) and the block menu

function BlockMenu({ block, onClose }: { block: NotesBlock; onClose: () => void }) {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const { t, currentId, store, newPage, user, readOnly } = useNotes();
  const pageId = useContext(PageIdContext);
  // Issues live in a workspace: signed in, and allowed to edit there.
  const canIssue = Boolean(user) && !readOnly;
  const [sub, setSub] = useState<{ kind: "turn" | "color" | "move"; anchor: HTMLElement } | null>(null);
  const [q, setQ] = useState("");
  const props = (block.props ?? {}) as Record<string, unknown>;
  const isText = TEXT_TYPES.has(block.type);
  // Several blocks selected (Notion's multi-block selection): delete, duplicate, turn into and color act on all.
  const [targets] = useState<NotesBlock[]>(() => {
    try {
      const sel = editor.getSelection()?.blocks as NotesBlock[] | undefined;
      return sel && sel.length > 1 && sel.some((b) => b.id === block.id) ? sel : [block];
    } catch {
      return [block];
    }
  });
  const texts = targets.filter((b) => TEXT_TYPES.has(b.type));
  const [touch] = useState(isTouchScreen);
  const moveStep = (up: boolean) => {
    try {
      editor.setTextCursorPosition(block);
    } catch {
      // Blocks without content cannot hold a text cursor: BlockNote moves the selected block.
    }
    if (up) editor.moveBlocksUp();
    else editor.moveBlocksDown();
  };
  const groups: MenuGroup[] = [
    {
      key: "main",
      items: [
        {
          key: "delete",
          label: t("block.delete"),
          icon: <Trash2 />,
          hint: "Del",
          onSelect: () => {
            editor.removeBlocks(targets);
            onClose();
          },
        },
        {
          key: "dup",
          label: t("block.duplicate"),
          icon: <Copy />,
          hint: "Ctrl+D",
          onSelect: () => {
            if (targets.length > 1) {
              // A copy of every selected block, below the last one (linked pages are left out, as ⌘D does).
              const copies = withoutBlockIds(targets.filter((b) => b.type !== "page" && b.type !== "database" && b.type !== "synced"));
              if (copies.length) editor.insertBlocks(copies as never, targets[targets.length - 1], "after");
              onClose();
              return;
            }
            const copy = JSON.parse(JSON.stringify(block)) as NotesBlock & { id?: string };
            type Raw = { id?: string; type?: string; props?: { noteId?: unknown }; children?: unknown[] };
            const strip = (b: Raw) => {
              delete b.id;
              // A sub-page or database is copied too (as in Notion): two blocks
              // on one page would have deleting the "copy" trash the original.
              if ((b.type === "page" || b.type === "database") && typeof b.props?.noteId === "string") {
                const dup = store.duplicate(b.props.noteId, t("menu.copySuffix"));
                if (dup) b.props = { ...b.props, noteId: dup.id };
              }
              (b.children as Raw[] | undefined)?.forEach(strip);
            };
            strip(copy as Raw);
            editor.insertBlocks([copy as never], block, "after");
            onClose();
          },
        },
        ...(isText ? [{ key: "turn", label: t("block.turnInto"), icon: <Repeat2 />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "turn", anchor: el }) }] : []),
        // Notion's "Turn into database" for a simple table: its header row names the properties, each row a page.
        ...(block.type === "table" && targets.length === 1 && !readOnly
          ? [
              {
                key: "todb",
                label: t("block.toDatabase"),
                icon: <Database />,
                onSelect: () => {
                  const content = block.content as unknown as { headerRows?: number; rows?: { cells?: unknown[] }[] } | undefined;
                  const cells = (content?.rows ?? []).map((r) => (r.cells ?? []).map((c) => inlinePlain((c as { content?: unknown })?.content ?? c).trim()));
                  const width = Math.max(1, ...cells.map((r) => r.length));
                  const header = Number(content?.headerRows ?? 0) > 0 ? (cells.shift() ?? []) : [];
                  const properties = Array.from({ length: width }, (_, i) =>
                    i === 0 ? { id: "title", name: header[0] || t("db.name"), type: "title" as const } : { id: shortId(), name: header[i] || t("table.column", { n: i + 1 }), type: "text" as const }
                  );
                  const db = store.create({ kind: "database", parentId: pageId ?? currentId, title: "", inline: true, db: { properties, views: [defaultView("table", t("db.table"))] } });
                  cells.forEach((r, i) =>
                    store.create({ kind: "page", parentId: db.id, title: r[0] ?? "", order: i + 1, props: Object.fromEntries(properties.slice(1).map((p, j) => [p.id, r[j + 1] ?? ""]).filter(([, v]) => v)) })
                  );
                  editor.replaceBlocks([block], [{ type: "database", props: { noteId: db.id, view: "" } }] as never);
                  onClose();
                },
              },
            ]
          : []),
        // Notion's "Comment" on a block: a discussion on its text.
        ...(isText && targets.length === 1 && inlinePlain(block.content).trim()
          ? [{ key: "comment", label: t("fmt.comment"), icon: <MessageSquare />, hint: "Ctrl+Shift+M", onSelect: () => (onClose(), window.dispatchEvent(new CustomEvent("nt-comment-block", { detail: block.id }))) }]
          : []),
        // zvena's ecosystem: the line becomes a live issue in Projects (its text the title).
        ...(isText && canIssue && block.type !== "codeBlock"
          ? [
              {
                key: "issue",
                label: et("toIssue"),
                icon: <CircleDot />,
                onSelect: () => {
                  onClose();
                  const page = pageId ?? currentId ?? "";
                  // Every selected line with text becomes its own issue, in order.
                  const lines = texts.filter((b) => b.type !== "codeBlock" && inlinePlain(b.content).trim());
                  void (async () => {
                    let made = 0;
                    let last: { sub?: string; title: string } | null = null;
                    for (const b of lines.length ? lines : [block]) {
                      try {
                        last = await turnIntoIssue(editor as never, b as never, page);
                        made += 1;
                      } catch {
                        // Counted below.
                      }
                    }
                    if (!made) toast(et("failed"));
                    else if (made === 1 && last) toast(`${et("toIssueDone")}: ${last.sub ?? last.title}`);
                    else toast(`${et("toIssueDone")}: ${made}`);
                  })();
                },
              },
            ]
          : []),
        // Touch screens cannot drag ⋮⋮: the block moves a step at a time (the menu stays open).
        ...(touch && targets.length === 1
          ? [
              { key: "up", label: t("layout.moveUp"), icon: <ArrowUp />, onSelect: () => moveStep(true) },
              { key: "down", label: t("layout.moveDown"), icon: <ArrowDown />, onSelect: () => moveStep(false) },
            ]
          : []),
        { key: "move", label: t("block.moveTo"), icon: <CornerUpRight />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "move", anchor: el }) },
        // Sub-page and database blocks stay put (also inside a toggle or list):
        // their pages belong to this page, and would go to the trash with the block.
        ...(block.type !== "synced" && linkedChildIds([block]).length === 0
          ? [
              {
                key: "sync",
                label: t("block.makeSynced"),
                icon: <RefreshCw />,
                onSelect: () => {
                  // The content lives under its page: who can read the page can read it (Notion's original block).
                  const content = store.create({ kind: "page", parentId: pageId ?? null, synced: true, title: "", content: withoutBlockIds([block]) });
                  editor.replaceBlocks([block], [{ type: "synced", props: { noteId: content.id } }] as never);
                  onClose();
                },
              },
            ]
          : []),
        {
          key: "link",
          label: t("block.copyLink"),
          icon: <Link />,
          onSelect: () => {
            // The page this block is on (a peeked row is not the open page).
            const page = store.get(pageId ?? currentId ?? "");
            if (page) {
              void navigator.clipboard?.writeText(`${location.origin}${withWs("/docs")}#${noteSlug(page)}&b=${block.id}`).catch(() => undefined);
              toast(t("page.copyLinkDone"));
            }
            onClose();
          },
        },
      ],
    },
    ...(isText || block.type === "callout"
      ? [
          {
            key: "color",
            items: [{ key: "color", label: t("block.color"), icon: <Paintbrush />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "color", anchor: el }) }],
          },
        ]
      : []),
  ];
  const filtered = q.trim()
    ? groups.map((g) => ({ ...g, items: g.items.filter((i) => String(i.label).toLowerCase().includes(q.trim().toLowerCase())) }))
    : groups;
  return (
    <>
      <Menu
        width={300}
        groups={filtered}
        onClose={onClose}
        header={
          <div className="nt-menu-input-wrap">
            <input className="nt-input" autoFocus={!touch} placeholder={t("block.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        }
      />
      {sub?.kind === "move" && (
        <BlockMovePanel
          editor={editor}
          block={block}
          pageId={pageId}
          anchor={sub.anchor}
          onDone={() => {
            setSub(null);
            onClose();
          }}
        />
      )}
      {sub?.kind === "turn" && (
        <Popover anchor={sub.anchor} placement="right-start" onClose={() => setSub(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "turn",
                label: t("block.turnInto"),
                items: [
                  ...TURN_INTO.map((x) => ({
                    key: x.key,
                    label: t(x.label),
                    icon: x.icon,
                    checked: blockKind(block as never) === x.key,
                    onSelect: () => {
                      editor.transact(() => {
                        for (const b of texts.length ? texts : [block]) editor.updateBlock(b, x.block as never);
                      });
                      onClose();
                    },
                  })),
                  // Notion's "Turn into → Block equation": the text becomes its TeX.
                  ...(targets.length === 1
                    ? [
                        {
                          key: "equation",
                          label: t("slash.equation"),
                          icon: <Sigma />,
                          onSelect: () => {
                            editor.replaceBlocks([block], [{ type: "equation", props: { latex: inlinePlain(block.content).trim().slice(0, 4000) } }] as never);
                            onClose();
                          },
                        },
                      ]
                    : []),
                  // Notion's "Turn into → Page": the text becomes the title, nested blocks the body.
                  ...(pageId && targets.length === 1
                    ? [
                        {
                          key: "page",
                          label: t("slash.page"),
                          icon: <FileText />,
                          hint: "Ctrl+Alt+9",
                          onSelect: () => {
                            blockToPage(editor, block, pageId, { newPage, store });
                            onClose();
                          },
                        },
                      ]
                    : []),
                ],
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "color" && (
        <Popover anchor={sub.anchor} placement="right-start" onClose={() => setSub(null)}>
          <Menu
            width={240}
            groups={colorGroups(
              t,
              (kind, c) => {
                editor.transact(() => {
                  for (const b of targets) {
                    if (b.type === "callout") editor.updateBlock(b, { props: kind === "bg" ? { color: c } : { textColor: c } } as never);
                    else if (TEXT_TYPES.has(b.type)) editor.updateBlock(b, { props: kind === "bg" ? { backgroundColor: c } : { textColor: c } } as never);
                  }
                });
                onClose();
              },
              { text: String(props.textColor ?? "default"), bg: String(block.type === "callout" ? props.color : (props.backgroundColor ?? "default")) }
            )}
          />
        </Popover>
      )}
    </>
  );
}

function NotionSideMenu() {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const { t } = useNotes();
  const sideMenu = useExtension(SideMenuExtension);
  const suggestion = useExtension(SuggestionMenuExt);
  const block = useExtensionState(SideMenuExtension, { selector: (s) => s?.block }) as NotesBlock | undefined;
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [menuBlock, setMenuBlock] = useState<NotesBlock | null>(null);
  if (!block) return null;
  const add = (e: React.MouseEvent) => {
    const empty = Array.isArray(block.content) && block.content.length === 0;
    if (empty && block.type === "paragraph") {
      editor.setTextCursorPosition(block);
    } else {
      const inserted = editor.insertBlocks([{ type: "paragraph" }], block, e.altKey ? "before" : "after")[0];
      editor.setTextCursorPosition(inserted);
    }
    suggestion.openSuggestionMenu("/");
  };
  const close = () => {
    setMenu(null);
    setMenuBlock(null);
    sideMenu.unfreezeMenu();
  };
  return (
    <div className="nt-side-menu">
      <button type="button" aria-label={t("block.addHint")} title={`${t("block.addHint")}\n${t("block.altAddHint")}`} onClick={add}>
        <Plus strokeWidth={1.7} />
      </button>
      <div
        className="nt-drag"
        role="button"
        tabIndex={-1}
        aria-label={t("block.dragHint")}
        title={`${t("block.dragHint")}\n${t("block.clickHint")}`}
        draggable
        onDragStart={(e) => sideMenu.blockDragStart(e, block)}
        onDragEnd={() => sideMenu.blockDragEnd()}
        onClick={(e) => {
          sideMenu.freezeMenu();
          setMenuBlock(block);
          setMenu(e.currentTarget);
          // Notion selects the block while its menu is open (a selection of several it is part of stays).
          try {
            const sel = editor.getSelection()?.blocks;
            if (!(sel && sel.length > 1 && sel.some((b) => b.id === block.id))) editor.setTextCursorPosition(block, "end");
          } catch {
            // Blocks without content cannot hold a text cursor.
          }
        }}
      >
        <GripVertical strokeWidth={1.7} />
      </div>
      {menu && menuBlock && (
        <Popover anchor={menu} placement="left-start" onClose={close}>
          <BlockMenu block={menuBlock} onClose={close} />
        </Popover>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting toolbar

function LinkInput({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const { t, snap } = useNotes();
  const [v, setV] = useState(editor.getSelectedLinkUrl() ?? "");
  const pages = useMemo(() => {
    const q = v.trim().toLowerCase();
    if (!q || /^https?:|^www\./.test(q)) return [];
    return snap.list.filter((n) => n.trashedAt === null && n.title.toLowerCase().includes(q)).slice(0, 6);
  }, [snap.list, v]);
  const apply = (url: string) => {
    if (url) editor.createLink(/^(https?:|mailto:|\/)/.test(url) ? url : `https://${url}`);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div style={{ width: 360, padding: "8px 0 4px" }}>
        <div style={{ padding: "0 8px 6px" }}>
          <input
            className="nt-input"
            autoFocus
            placeholder={t("fmt.linkPlaceholder")}
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply(v.trim());
            }}
          />
        </div>
        {pages.length > 0 && <div className="nt-menu-label">{t("fmt.linkPages")}</div>}
        {pages.map((p) => (
          <button type="button" key={p.id} className="nt-mi nt-btn-reset" onClick={() => apply(`/docs#${p.id}`)}>
            <span className="nt-mi-icon"><NoteIcon icon={p.icon} fallback={<FileText />} /></span>
            <span className="nt-mi-label">{displayTitle(p, t("page.untitled"))}</span>
          </button>
        ))}
        {editor.getSelectedLinkUrl() && (
          <button
            type="button"
            className="nt-mi nt-btn-reset"
            data-danger="true"
            onClick={() => {
              editor.deleteLink();
              onClose();
            }}
          >
            <span className="nt-mi-icon">
              <Trash2 />
            </span>
            <span className="nt-mi-label">{t("fmt.removeLink")}</span>
          </button>
        )}
      </div>
    </Popover>
  );
}

const MEDIA_TYPES = new Set(["image", "video", "audio", "file"]);

/** Notion's toolbar on a selected image, video, audio or file: align, caption, replace, download, original. */
function MediaToolbar({ block, onComment }: { block: NotesBlock; onComment: () => void }) {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const { t } = useNotes();
  const [caption, setCaption] = useState<HTMLElement | null>(null);
  const props = block.props as { url?: string; caption?: string; textAlignment?: string; name?: string };
  const url = typeof props.url === "string" ? props.url : "";
  const align = (a: "left" | "center" | "right") => editor.updateBlock(block, { props: { textAlignment: a } } as never);
  const btn = (key: string, label: string, icon: ReactNode, onClick: (el: HTMLElement) => void, on?: boolean) => (
    <button type="button" key={key} className="nt-fmt-btn nt-btn-reset" data-on={on || undefined} title={label} aria-label={label} onClick={(e) => onClick(e.currentTarget)}>
      {icon}
    </button>
  );
  return (
    <div className="nt-fmt" onMouseDown={(e) => e.preventDefault()}>
      {(block.type === "image" || block.type === "video") && (
        <div className="nt-fmt-group">
          {btn("l", t("media.alignLeft"), <AlignLeft />, () => align("left"), props.textAlignment === "left")}
          {btn("c", t("media.alignCenter"), <AlignCenter />, () => align("center"), (props.textAlignment ?? "center") === "center")}
          {btn("r", t("media.alignRight"), <AlignRight />, () => align("right"), props.textAlignment === "right")}
        </div>
      )}
      <div className="nt-fmt-group">
        {btn("cap", t("media.caption"), <Captions />, (el) => setCaption(el), Boolean(props.caption))}
        {btn("cm", t("fmt.comment"), <MessageSquare />, () => onComment())}
        {btn("rep", t("media.replace"), <RefreshCw />, () => editor.getExtension(FilePanelExtension)?.showMenu(block.id))}
      </div>
      {url && (
        <div className="nt-fmt-group">
          <a className="nt-fmt-btn" href={url} download={props.name || true} title={t("media.download")} aria-label={t("media.download")}>
            <Download />
          </a>
          <a className="nt-fmt-btn" href={url} target="_blank" rel="noopener noreferrer" title={t("media.original")} aria-label={t("media.original")}>
            <Maximize2 />
          </a>
        </div>
      )}
      {caption && <CaptionInput block={block} anchor={caption} onClose={() => setCaption(null)} />}
    </div>
  );
}

function CaptionInput({ block, anchor, onClose }: { block: NotesBlock; anchor: HTMLElement; onClose: () => void }) {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const { t } = useNotes();
  const [v, setV] = useState(String((block.props as { caption?: string }).caption ?? ""));
  const done = () => {
    editor.updateBlock(block, { props: { caption: v.trim().slice(0, 2000) } } as never);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={done}>
      <div style={{ width: 320, padding: 8 }}>
        <input className="nt-input" autoFocus value={v} placeholder={t("media.captionPlaceholder")} aria-label={t("media.caption")} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && done()} />
      </div>
    </Popover>
  );
}

/** While suggesting, the selection toolbar only comments (formatting would be an edit). */
function SuggestToolbar({ onComment }: { onComment: () => void }) {
  const { t } = useNotes();
  return (
    <div className="nt-fmt" onMouseDown={(e) => e.preventDefault()}>
      <div className="nt-fmt-group">
        <button type="button" className="nt-fmt-btn nt-btn-reset nt-fmt-wide" title={t("fmt.comment")} onClick={onComment}>
          <MessageSquare />
          {t("fmt.comment")}
        </button>
      </div>
    </div>
  );
}

function FormatToolbar({ onComment }: { onComment: () => void }) {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const { t } = useNotes();
  const styles = useActiveStyles(editor as never) as Record<string, unknown>;
  const selected = useSelectedBlocks(editor as never) as unknown as NotesBlock[];
  const [pop, setPop] = useState<{ kind: "turn" | "color" | "link"; anchor: HTMLElement } | null>(null);
  const first = selected[0];
  const current = TURN_INTO.find((x) => x.key === blockKind(first as never));
  const textual = selected.every((b) => TEXT_TYPES.has(b.type));
  if (!textual) return selected.length === 1 && MEDIA_TYPES.has(first.type) ? <MediaToolbar block={first} onComment={onComment} /> : null;
  const toggle = (s: string) => editor.toggleStyles({ [s]: true } as never);
  const btn = (key: string, label: NotesKey, icon: ReactNode, onClick: (el: HTMLElement) => void, on?: boolean) => (
    <button type="button" key={key} className="nt-fmt-btn nt-btn-reset" data-on={on || undefined} title={t(label)} aria-label={t(label)} onClick={(e) => onClick(e.currentTarget)}>
      {icon}
    </button>
  );
  return (
    <div className="nt-fmt" onMouseDown={(e) => e.preventDefault()}>
      <div className="nt-fmt-group">
        <button type="button" className="nt-fmt-btn nt-btn-reset" onClick={(e) => setPop({ kind: "turn", anchor: e.currentTarget })}>
          {current ? t(current.label) : t("slash.text")}
          <ChevronDown className="nt-fmt-chev" />
        </button>
      </div>
      <div className="nt-fmt-group">
        {btn("link", "fmt.link", <Link2 />, (el) => setPop({ kind: "link", anchor: el }), Boolean(editor.getSelectedLinkUrl()))}
        {btn("comment", "fmt.comment", <MessageSquare />, () => onComment())}
      </div>
      <div className="nt-fmt-group">
        {btn("b", "fmt.bold", <Bold />, () => toggle("bold"), Boolean(styles.bold))}
        {btn("i", "fmt.italic", <Italic />, () => toggle("italic"), Boolean(styles.italic))}
        {btn("u", "fmt.underline", <Underline />, () => toggle("underline"), Boolean(styles.underline))}
        {btn("s", "fmt.strike", <Strikethrough />, () => toggle("strike"), Boolean(styles.strike))}
        {btn("code", "fmt.code", <Code />, () => toggle("code"), Boolean(styles.code))}
        {btn("eq", "fmt.equation", <Sigma />, () => {
          const text = editor.getSelectedText();
          if (text) editor.insertInlineContent([{ type: "inlineEquation", props: { latex: text } } as never, " "]);
        })}
      </div>
      <div className="nt-fmt-group">
        <button type="button" className="nt-fmt-btn nt-btn-reset" title={t("fmt.color")} onClick={(e) => setPop({ kind: "color", anchor: e.currentTarget })}>
          <Baseline />
          <ChevronDown className="nt-fmt-chev" />
        </button>
      </div>
      {pop?.kind === "turn" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "turn",
                label: t("block.turnInto"),
                items: TURN_INTO.map((x) => ({
                  key: x.key,
                  label: t(x.label),
                  icon: x.icon,
                  checked: current?.key === x.key,
                  onSelect: () => {
                    for (const b of selected) editor.updateBlock(b, x.block as never);
                    setPop(null);
                  },
                })),
              },
            ]}
          />
        </Popover>
      )}
      {pop?.kind === "color" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)}>
          <Menu
            width={240}
            groups={colorGroups(
              t,
              (kind, c) => {
                if (c === "default") editor.removeStyles({ [kind === "bg" ? "backgroundColor" : "textColor"]: "" } as never);
                else editor.addStyles({ [kind === "bg" ? "backgroundColor" : "textColor"]: c } as never);
                setPop(null);
              },
              { text: String(styles.textColor ?? "default"), bg: String(styles.backgroundColor ?? "default") }
            )}
          />
        </Popover>
      )}
      {pop?.kind === "link" && <LinkInput anchor={pop.anchor} onClose={() => setPop(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor

/** Synced blocks just created: their editor takes the caret when it mounts. */
const focusOnMount = new Set<string>();

/** `collab`: the page is edited together (its live session; components/notes/collab.tsx). */
/** `canComment`: read-only, but text may be selected and discussed (Notion's Can comment). */
/** `suggest`: typing suggests (components/notes/suggest.ts); "only" for someone who may only comment. */
type NoteEditorProps = { note: Note; readOnly?: boolean; onTitleFocusRequest?: () => void; embedded?: boolean; collab?: CollabProvider | null; canComment?: boolean; suggest?: SuggestMode };

/** Block types this version knows; content from a newer version may hold others. */
const KNOWN_BLOCKS = new Set(Object.keys(notesSchema.blockSchema));
function hasUnknownBlocks(blocks: unknown, depth = 0): boolean {
  if (!Array.isArray(blocks) || depth > 40) return false;
  return blocks.some((raw) => {
    const b = raw as { type?: unknown; children?: unknown };
    return !!b && typeof b === "object" && ((typeof b.type === "string" && !KNOWN_BLOCKS.has(b.type)) || hasUnknownBlocks(b.children, depth + 1));
  });
}

/** Shown instead of the editor when it cannot open a page (never saves over it). */
function EditorUnavailable({ reason }: { reason: "newer" | "error" }) {
  const { t } = useNotes();
  return (
    <div className="nt-editor-unavailable" role="alert">
      <p>{reason === "newer" ? t("editor.newer") : t("editor.failed")}</p>
      <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" onClick={() => location.reload()}>
        {t("editor.reload")}
      </button>
    </div>
  );
}

class EditorBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  render() {
    return this.state.failed ? <EditorUnavailable reason="error" /> : this.props.children;
  }
}

/**
 * The page editor. A page holding blocks this version does not know (made on
 * a newer version, e.g. in another tab after an update) is not opened, so an
 * old tab can never save over them; an editor crash shows a reload prompt.
 */
export const NoteEditor = forwardRef<EditorHandle, NoteEditorProps>(function NoteEditor(props, ref) {
  if (hasUnknownBlocks(props.note.content)) return <EditorUnavailable reason="newer" />;
  return (
    <EditorBoundary resetKey={props.note.id}>
      <NoteEditorInner {...props} ref={ref} />
    </EditorBoundary>
  );
});

const NoteEditorInner = forwardRef<EditorHandle, NoteEditorProps>(function NoteEditorInner({ note, readOnly, onTitleFocusRequest, embedded, collab, canComment, suggest }, ref) {
  const api = useNotes();
  const { t, locale, store } = api;
  // Suggestion mode (Notion's "Suggest edits"): the editor's plugin reads these through refs.
  const suggestMode: SuggestMode = embedded ? "off" : (suggest ?? "off");
  const [suggestCtl] = useState(() => new SuggestControl());
  const userId = api.user?.id ?? null;
  useEffect(() => suggestCtl.set({ mode: suggestMode, comments: note.comments, userId }), [note.comments, suggestCtl, suggestMode, userId]);
  const editorRoot = useRef<HTMLDivElement>(null);
  const [pasteMenu, setPasteMenu] = useState<{ url: string; blockId: string; x: number; y: number; keys: number } | null>(null);
  // Keystrokes so far: typing on right after a paste (even before its menu
  // shows, on a slow device) means no menu.
  const keyCount = useRef(0);
  // ⌘⇧V / Ctrl+Shift+V: the paste that follows is plain text (Notion's "Paste and match style").
  const plainPaste = useRef(0);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      keyCount.current += 1;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyV") plainPaste.current = e.timeStamp;
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
  const lastContent = useRef<unknown[]>(note.content);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applying = useRef(false);
  const noteId = note.id;

  const dictionary = useMemo(() => {
    const base = blockNoteLocale(locale);
    return {
      ...base,
      placeholders: {
        ...base.placeholders,
        default: t("page.placeholder"),
        emptyDocument: t("page.placeholder"),
        heading: t("slash.h1"),
        toggleListItem: t("slash.toggle"),
      },
    } as typeof locales.en;
  }, [locale, t]);

  const options = {
    schema: notesSchema,
    extensions: [CodeHighlightExtension(), NotionKeysExtension(), MarkdownExtrasExtension(), SuggestExtension(suggestCtl), FindExtension()],
    // A name for screen readers (axe: the editable area had none).
    domAttributes: { editor: { "aria-label": t("a11y.editor") } },
    // A co-edited page takes its body from the session.
    initialContent: !collab && note.content.length ? (note.content as never) : undefined,
    dictionary,
    uploadFile: (file: File) => api.upload(file),
    tabBehavior: "prefer-indent",
    // Notion's simple tables: header row and column, cell colors, merged cells.
    tables: { headers: true, cellBackgroundColor: true, cellTextColor: true, splitCells: true },
    // A synced block's content ends where its last block ends.
    trailingBlock: !embedded,
    dropCursor: columnDropCursor,
    // "Copy and sync" puts a reference on the clipboard: pasting it adds the same synced block here.
    pasteHandler: ({ event, editor: ed, defaultPasteHandler }) => {
      // Both events' timeStamps share one clock: the paste that follows the keys closely is the plain one.
      if (plainPaste.current && event.timeStamp - plainPaste.current < 1500) {
        plainPaste.current = 0;
        const raw = (event.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
        if (!raw) return true;
        // The text alone, in the current block's style; more lines become more blocks of the same kind.
        const [first, ...rest] = raw.split("\n");
        const view = ed.prosemirrorView;
        view.dispatch(view.state.tr.insertText(first).scrollIntoView());
        if (rest.length) {
          const cur = ed.getTextCursorPosition().block as unknown as NotesBlock;
          const kind = cur.type === "heading" || cur.type === "codeBlock" ? "paragraph" : cur.type;
          const placed = ed.insertBlocks(rest.map((line) => ({ type: kind, content: line })) as never, cur.id, "after");
          const last = placed[placed.length - 1];
          if (last) ed.setTextCursorPosition(last, "end");
        }
        return true;
      }
      const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
      // A pasted link stays a link; Notion then offers to make it a bookmark or an embed.
      if (/^https?:\/\/[^\s<>"]{3,1990}$/.test(text)) {
        const done = defaultPasteHandler();
        const blockId = (ed.getTextCursorPosition().block as unknown as NotesBlock).id;
        const keys = keyCount.current;
        setTimeout(() => {
          if (keyCount.current !== keys) return;
          try {
            const c = ed.prosemirrorView.coordsAtPos(ed.prosemirrorState.selection.from);
            setPasteMenu({ url: text, blockId, x: c.left, y: c.bottom, keys });
          } catch {
            // The view went away.
          }
        }, 0);
        return done;
      }
      const m = /^zvena-synced:([A-Za-z0-9_-]{6,64})$/.exec(text);
      if (!m || m[1] === note.id || !store.get(m[1])?.synced) return defaultPasteHandler();
      const cur = ed.getTextCursorPosition().block as unknown as NotesBlock;
      const block = { type: "synced", props: { noteId: m[1] } } as never;
      const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0;
      if (empty) ed.replaceBlocks([cur.id], [block]);
      else ed.insertBlocks([block], cur.id, "after");
      return true;
    },
    animations: false,
    links: {
      onClick: (event: MouseEvent) => {
        const a = (event.target as HTMLElement).closest("a");
        const href = a?.getAttribute("href") ?? "";
        // A page of this workspace opens in place; other links (and pages of other workspaces) in a new tab.
        const id = href ? linkedNoteId(href, location.href) : null;
        if (id && store.get(id)) {
          event.preventDefault();
          // A link to a block of this page just scrolls there.
          const block = blockOfHash(new URL(href, location.href).hash);
          if (id === noteId && block && editor.domElement) flashBlock(editor.domElement, block);
          else api.open(id, block ? { block } : undefined);
          return true;
        }
        if (href) {
          event.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
          return true;
        }
        return false;
      },
    },
  } satisfies Partial<BlockNoteEditorOptions<NotesSchema["blockSchema"], NotesSchema["inlineContentSchema"], NotesSchema["styleSchema"]>>;
  const editor = useCreateBlockNote(
    collab
      ? withCollaboration({
          ...options,
          collaboration: {
            fragment: collab.doc.getXmlFragment(COLLAB_FRAGMENT),
            user: { name: collab.user.name, color: collab.user.color },
            provider: { awareness: collab.awareness },
            // Notion: a colored caret whose name shows while that person types or moves.
            showCursorLabels: "activity",
          },
        })
      : options,
    [noteId, dictionary, collab]
  ) as unknown as NotesEditor;

  // Lines that "Goals from a document" made issues of become live issue blocks here.
  useDocConversions(editor as never, noteId, !readOnly && !embedded);

  useEffect(() => {
    if (!focusOnMount.delete(noteId)) return;
    const first = editor.document[0];
    if (first) editor.setTextCursorPosition(first, "end");
    editor.focus();
  }, [editor, noteId]);

  // The paste menu goes away as soon as typing goes on.
  // "Paste as → Mention": the pasted link becomes a chip; its title and icon follow from the link preview.
  const linkToMention = useCallback(
    (blockId: string, url: string) => {
      const b = editor.getBlock(blockId) as NotesBlock | undefined;
      if (!b || !Array.isArray(b.content)) return;
      const chip = { type: "linkMention", props: { url, title: "", icon: "" } };
      let done = false;
      const next: unknown[] = [];
      for (const c of b.content as { type: string; href?: string; text?: string }[]) {
        if (!done && c.type === "link" && c.href === url) {
          next.push(chip);
          done = true;
        } else if (!done && c.type === "text" && c.text?.includes(url)) {
          const i = c.text.indexOf(url);
          if (i > 0) next.push({ ...c, text: c.text.slice(0, i) });
          next.push(chip);
          const rest = c.text.slice(i + url.length);
          if (rest) next.push({ ...c, text: rest });
          done = true;
        } else next.push(c);
      }
      if (!done) next.push(" ", chip);
      editor.updateBlock(b, { content: next } as never);
      void linkPreview(url).then(({ title, icon }) => {
        if (!title && !icon) return;
        const cur = editor.getBlock(blockId) as NotesBlock | undefined;
        if (!cur || !Array.isArray(cur.content)) return;
        let hit = false;
        const upd = (cur.content as { type: string; props?: { url?: string; title?: string } }[]).map((c) => {
          if (hit || c.type !== "linkMention" || c.props?.url !== url || c.props.title) return c;
          hit = true;
          return { ...c, props: { ...c.props, title, icon } };
        });
        if (hit) editor.updateBlock(cur, { content: upd } as never);
      });
    },
    [editor]
  );

  useEffect(() => {
    if (!pasteMenu) return;
    const off = () => setPasteMenu(null);
    if (keyCount.current !== pasteMenu.keys) {
      // A key went down between the paste and this effect.
      off();
      return;
    }
    window.addEventListener("keydown", off, true);
    return () => window.removeEventListener("keydown", off, true);
  }, [pasteMenu]);

  useImperativeHandle(ref, () => ({
    focusStart: () => {
      const first = editor.document[0];
      if (first) editor.setTextCursorPosition(first, "start");
      editor.focus();
    },
    editor,
  }));

  // A co-edited page: its JSON follows the session (seed, snapshots, edits made outside it).
  const { confirm } = useCollabEditor({ editor, collab, noteId, store, readOnly: Boolean(readOnly), lastContentRef: lastContent, note });

  /** This person's open suggestions no longer on the page (typed away), and with no replies: their records go. */
  const pruneSuggestions = useCallback(
    (doc: unknown[]) => {
      const me = api.user?.id;
      const comments = store.get(noteId)?.comments ?? [];
      if (!me || !comments.some((c) => c.suggestion && c.authorId === me && !c.suggestion.state)) return;
      const present = suggestionIds(doc);
      // Only suggestions started in this editor: another tab's may not have reached this copy yet.
      const gone = new Set(
        comments
          .filter((c) => c.suggestion && c.thread && c.authorId === me && !c.suggestion.state && suggestCtl.madeHere(c.thread) && !present.has(c.thread) && !comments.some((x) => x.thread === c.thread && x.id !== c.id))
          .map((c) => c.id)
      );
      if (gone.size) store.update(noteId, { comments: comments.filter((c) => !gone.has(c.id)) }, { quiet: true });
    },
    [api.user?.id, noteId, store, suggestCtl]
  );

  // Save as you type (debounced) and trash sub-pages whose block was deleted.
  const save = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const doc = editor.document as unknown[];
    const before = new Set(linkedChildIds(lastContent.current));
    const after = new Set(linkedChildIds(doc));
    lastContent.current = doc;
    store.update(noteId, { content: doc });
    if (collab) confirm(doc);
    pruneSuggestions(doc);
    for (const id of before) {
      if (after.has(id)) continue;
      const child = store.get(id);
      // Only the page's own sub-pages go to the trash (a "Link to page" block
      // pointing elsewhere just disappears).
      if (child && child.parentId === noteId && child.trashedAt === null) {
        store.trash(id);
        toast(t("toast.trashed"), {
          label: t("toast.undo"),
          run: () => {
            store.restore(id);
            editor.undo();
          },
        });
      }
    }
  }, [collab, confirm, editor, noteId, pruneSuggestions, store, t]);

  // A read-only editor never writes: a block re-rendering or tidying its
  // props there (a bookmark's preview, a viewer's click) is not an edit, and
  // the server would refuse it, leaving this device's copy apart.
  const readOnlyNow = useRef(Boolean(readOnly));
  useEffect(() => {
    readOnlyNow.current = Boolean(readOnly);
  }, [readOnly]);
  useEffect(() => {
    // In a session only this person's own edits save here (the others' arrive through it).
    const off = editor.onChange(() => {
      if (applying.current || readOnlyNow.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(save, 350);
    }, !collab);
    // The page going away (reload, close, background) takes the typing now, not 350 ms later.
    const release = store.holdEdits(() => {
      if (saveTimer.current) save();
    });
    return () => {
      if (typeof off === "function") off();
      release();
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        save();
      }
    };
  }, [collab, editor, save, store]);

  // Outside changes to this note's body (sync, another tab, the sidebar);
  // a co-edited page takes them through its session (collab-editor.ts).
  useEffect(() => {
    if (collab || note.content === lastContent.current) return;
    if (saveTimer.current) return; // local typing in flight wins; it saves next
    lastContent.current = note.content;
    applying.current = true;
    try {
      const blocks = (note.content.length ? note.content : [{ type: "paragraph" }]) as never[];
      withoutSuggesting(() => editor.replaceBlocks(editor.document, blocks));
    } catch {
      // Malformed remote content: keep what is on screen.
    } finally {
      applying.current = false;
    }
  }, [collab, editor, note.content]);

  // A click on a block without text (sub-page, database, synced block, an
  // issue card) leaves a node selection on it; a click into the empty line
  // below then fires no selectionchange in Chrome (the node selection's
  // hidden caret already sits there), so ProseMirror keeps the node
  // selection and every typed key is swallowed. After a click, a caret the
  // browser placed outside the selected node becomes the text selection.
  useEffect(() => {
    const dom = editor.domElement;
    if (!dom) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUp = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const view = editor.prosemirrorView;
        const sel = view?.state.selection;
        if (!view || !(sel instanceof NodeSelection)) return;
        const dsel = window.getSelection();
        const node = dsel?.anchorNode;
        if (!dsel || !dsel.isCollapsed || !node || !view.dom.contains(node)) return;
        const nodeDom = view.nodeDOM(sel.from);
        if (nodeDom && (nodeDom === node || nodeDom.contains(node))) return;
        let pos: number;
        try {
          pos = view.posAtDOM(node, dsel.anchorOffset);
        } catch {
          return;
        }
        const next = TextSelection.near(view.state.doc.resolve(Math.max(0, Math.min(pos, view.state.doc.content.size))));
        if (next.from >= sel.from && next.to <= sel.to) return;
        view.dispatch(view.state.tr.setSelection(next));
      }, 0);
    };
    dom.addEventListener("mouseup", onUp);
    return () => {
      dom.removeEventListener("mouseup", onUp);
      if (timer) clearTimeout(timer);
    };
  }, [editor]);

  // ↑ or Backspace at the very start focuses the title (as in Notion).
  useEffect(() => {
    const dom = editor.domElement;
    if (!dom) return;
    const onKey = (e: KeyboardEvent) => {
      if (readOnly || e.isComposing) return;
      // Keys typed into a database cell, a caption input or any other widget
      // inside the page are theirs, not the editor's.
      const target = e.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable='false']") || target !== dom)) return;
      if (e.key === "ArrowUp" || e.key === "Backspace") {
        const pos = editor.getTextCursorPosition();
        const sel = editor.prosemirrorState.selection;
        if (!pos.prevBlock && sel.empty && sel.$from.parentOffset === 0 && !editor.getParentBlock(pos.block)) {
          const empty = Array.isArray(pos.block.content) && pos.block.content.length === 0;
          if (e.key === "ArrowUp" || (empty && editor.document.length === 1)) {
            e.preventDefault();
            onTitleFocusRequest?.();
          }
        }
      }
    };
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener("keydown", onKey, true);
  }, [editor, readOnly, onTitleFocusRequest]);

  // Inline discussions: a "comment" style marks the text; the thread lives in the note.
  const [thread, setThread] = useState<{ id: string; quote?: string; el: HTMLElement | null } | null>(null);
  const markEl = (id: string) => editor.domElement?.querySelector<HTMLElement>(`.nt-cmark[data-thread="${CSS.escape(id)}"]`) ?? null;
  const startComment = useCallback(() => {
    const quote = editor.getSelectedText().trim();
    if (!quote) return;
    const id = shortId();
    withoutSuggesting(() => editor.addStyles({ comment: id } as never));
    // The mark renders on the next frame; anchor the thread to it.
    requestAnimationFrame(() => setThread({ id, quote, el: markEl(id) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  // Can comment: the page reads only, but selected text may start a discussion
  // (its mark is the only change such a person makes; the server checks it).
  const commentOnly = Boolean(readOnly && canComment && !embedded);
  const [pick, setPick] = useState<{ x: number; y: number; from: number; to: number } | null>(null);
  /** A commenter's new mark waits for its first comment before it is saved. */
  const pendingMark = useRef<string | null>(null);
  const markEdit = useCallback((run: () => void) => withoutSuggesting(() => (collab && readOnly ? collab.commentMark(run) : run())), [collab, readOnly]);
  const saveMarks = useCallback(() => {
    // Outside a session a commenter's marks go with the page's JSON.
    if (!commentOnly || collab) return;
    const doc = editor.document as unknown[];
    lastContent.current = doc;
    store.update(noteId, { content: doc });
  }, [collab, commentOnly, editor, noteId, store]);
  useEffect(() => {
    if (!commentOnly) return;
    const onSel = () => {
      const dom = editor.domElement;
      const sel = window.getSelection();
      const view = editor._tiptapEditor?.view;
      if (!dom || !view || !sel || sel.isCollapsed || !sel.rangeCount || !sel.anchorNode || !sel.focusNode || !dom.contains(sel.anchorNode) || !dom.contains(sel.focusNode)) return setPick(null);
      try {
        const a = view.posAtDOM(sel.anchorNode, sel.anchorOffset);
        const b = view.posAtDOM(sel.focusNode, sel.focusOffset);
        const r = sel.getRangeAt(0).getBoundingClientRect();
        setPick(a === b ? null : { x: r.left + r.width / 2, y: r.top, from: Math.min(a, b), to: Math.max(a, b) });
      } catch {
        setPick(null);
      }
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [commentOnly, editor]);
  const commentOnPick = () => {
    if (!pick) return;
    const tt = editor._tiptapEditor;
    const quote = tt.state.doc.textBetween(pick.from, pick.to, " ").trim();
    if (!quote) return;
    const id = shortId();
    markEdit(() => tt.chain().setTextSelection({ from: pick.from, to: pick.to }).setMark("comment", { stringValue: id }).run());
    pendingMark.current = id;
    setPick(null);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => setThread({ id, quote, el: markEl(id) }));
  };
  // Its first comment is in: the mark is saved with it.
  useEffect(() => {
    const id = pendingMark.current;
    if (id && (note.comments ?? []).some((c) => c.thread === id)) {
      pendingMark.current = null;
      saveMarks();
    }
  }, [note.comments, saveMarks]);
  const removeMark = useCallback(
    (id: string) => {
      // Walk the document and drop this thread's style from every text run.
      const strip = (items: unknown): unknown =>
        Array.isArray(items)
          ? items.map((it) => {
              const x = it as { type?: string; styles?: Record<string, unknown>; content?: unknown };
              if (x.type === "text" && x.styles?.comment === id) {
                const { comment: _c, ...rest } = x.styles;
                void _c;
                return { ...x, styles: rest };
              }
              if (x.type === "link") return { ...x, content: strip(x.content) };
              return it;
            })
          : items;
      const visit = (blocks: NotesBlock[]) => {
        for (const b of blocks) {
          if (Array.isArray(b.content) && JSON.stringify(b.content).includes(`"comment":"${id}"`)) editor.updateBlock(b, { content: strip(b.content) } as never);
          if (b.children?.length) visit(b.children as NotesBlock[]);
        }
      };
      markEdit(() => visit(editor.document as NotesBlock[]));
      // A commenter's mark never saved (no comment yet) has nothing to take back.
      if (pendingMark.current === id) pendingMark.current = null;
      else saveMarks();
    },
    [editor, markEdit, saveMarks]
  );
  // The Tabs block's bar speaks the page's language.
  useEffect(() => {
    setTabsText({
      untitled: (n) => t("tabs.untitled", { n }),
      add: t("tabs.add"),
      rename: t("tabs.rename"),
      moveLeft: t("tabs.moveLeft"),
      moveRight: t("tabs.moveRight"),
      remove: t("tabs.remove"),
      menu: t("tabs.menu"),
    });
  }, [t]);
  // The topbar's discussion list opens a thread by id.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== "string") return;
      if (markEl(id)) setTimeout(() => setThread({ id, el: markEl(id) }), 350);
      else if (suggestionEl(editor.domElement, id)) setTimeout(() => setThread({ id, el: suggestionEl(editor.domElement, id) }), 350);
    };
    window.addEventListener("nt-open-thread", onOpen);
    return () => window.removeEventListener("nt-open-thread", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  // A thread deleted in the comments sidebar takes its mark off the text (in the editor that holds it).
  useEffect(() => {
    const onRemove = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === "string" && markEl(id)) removeMark(id);
    };
    window.addEventListener("nt-remove-thread-mark", onRemove);
    return () => window.removeEventListener("nt-remove-thread-mark", onRemove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, removeMark]);
  // Clicking marked text opens its thread.
  useEffect(() => {
    const dom = editor.domElement;
    if (!dom) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>(".nt-cmark");
      const id = el?.dataset.thread;
      // Only an open discussion: resolved text is plain text again (Notion), reopened from the comments list.
      if (el && id && (note.comments ?? []).some((c) => c.thread === id && !c.resolved)) return setThread({ id, el });
      // Suggested text opens its card while reviewing (while suggesting, a click is for the caret; the margin opens it).
      const sug = (e.target as HTMLElement).closest?.<HTMLElement>(".nt-sins, .nt-sdel");
      if (sug?.dataset.sid && suggestCtl.mode() === "off") setThread({ id: sug.dataset.sid, el: sug });
    };
    dom.addEventListener("click", onClick);
    return () => dom.removeEventListener("click", onClick);
  }, [editor, note.comments, suggestCtl]);
  // Typing in the page closes an open discussion card (Notion): it never stays over the text, the "/" menu or the caret.
  // A new discussion left without a comment leaves no mark behind.
  useEffect(() => {
    const dom = editor.domElement;
    if (!dom || !thread) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (e.key.length !== 1 && e.key !== "Enter" && e.key !== "Backspace" && e.key !== "Delete" && e.key !== "Tab") return;
      const started = (note.comments ?? []).some((c) => c.thread === thread.id);
      if (!started && markEl(thread.id)) removeMark(thread.id);
      setThread(null);
    };
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, thread, note.comments, removeMark]);
  // Only open threads are highlighted (resolved or deleted ones fade out).
  const openThreads = useMemo(() => {
    const ids = new Set<string>();
    for (const c of note.comments ?? []) if (c.thread && !c.resolved) ids.add(c.thread);
    if (thread) ids.add(thread.id);
    return [...ids];
  }, [note.comments, thread]);

  // Suggestions: a new one gets its record (the thread's first entry, signed by the server);
  // someone who may only comment saves them as they type (in a session they go out live).
  const suggestSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    suggestCtl.setHooks({
      onNew: (sid) => {
        const u = api.user;
        if (!u) return;
        const comments = store.get(noteId)?.comments ?? [];
        if (comments.some((c) => c.thread === sid)) return;
        store.update(noteId, { comments: [...comments, { id: shortId(), thread: sid, text: "", at: Date.now(), author: u.name, authorId: u.id, suggestion: {} }] }, { quiet: true });
      },
      wrap: (run) => (collab && suggestCtl.mode() === "only" ? collab.commentMark(run) : run()),
      onChange: () => {
        if (suggestCtl.mode() !== "only") return;
        if (suggestSave.current) clearTimeout(suggestSave.current);
        suggestSave.current = setTimeout(saveSuggested, 350);
      },
    });
    const saveSuggested = () => {
      if (suggestSave.current) clearTimeout(suggestSave.current);
      suggestSave.current = null;
      const doc = editor.document as unknown[];
      if (!collab) {
        lastContent.current = doc;
        store.update(noteId, { content: doc });
      }
      pruneSuggestions(doc);
    };
    // Suggestions typed a moment ago are kept like typing (the page going away, another page opened).
    const release = store.holdEdits(() => {
      if (suggestSave.current) saveSuggested();
    });
    return () => {
      release();
      if (suggestSave.current) saveSuggested();
    };
  }, [api.user, collab, editor, noteId, pruneSuggestions, store, suggestCtl]);
  const openSuggestions = useOpenSuggestions(editor, note);
  const canDecide = !readOnly && !embedded;
  /** Accepts or rejects suggestions (all open ones without `sids`): the page changes, their records say who decided. */
  const decide = useCallback(
    async (sids: string[] | null, accept: boolean) => {
      if (!canDecide) return;
      const records = suggestionEntries(store.get(noteId)?.comments);
      const want = new Set((sids ?? openSuggestions.map((x) => x.sid)).filter((sid) => !records.get(sid)?.suggestion?.state));
      if (!want.size) return;
      // Typing still waiting goes first: the decision is a version of its own (its suggester's, when accepted).
      if (saveTimer.current) save();
      await api.flush().catch(() => undefined);
      const view = editor.prosemirrorView;
      const tr = view ? decideTr(view.state, want, accept, () => crypto.randomUUID()) : null;
      if (tr && view) withoutSuggesting(() => view.dispatch(tr));
      save();
      const comments = store.get(noteId)?.comments ?? [];
      store.update(noteId, { comments: comments.map((c) => (c.suggestion && c.thread && want.has(c.thread) && !c.suggestion.state ? { ...c, suggestion: { state: accept ? "accepted" : "rejected" }, resolved: true } : c)) }, { quiet: true });
      if (thread && want.has(thread.id)) setThread(null);
      toast(want.size === 1 ? t(accept ? "suggest.accepted" : "suggest.rejected") : t(accept ? "suggest.acceptedN" : "suggest.rejectedN", { n: want.size }));
    },
    [api, canDecide, editor, noteId, openSuggestions, save, store, t, thread]
  );
  // The page menu's "Accept all" / "Reject all", and a card's buttons elsewhere.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ noteId?: string; accept?: boolean; sid?: string }>).detail;
      if (d?.noteId === noteId && typeof d.accept === "boolean") void decide(d.sid ? [d.sid] : null, d.accept);
    };
    window.addEventListener("nt-suggest-decide", on);
    return () => window.removeEventListener("nt-suggest-decide", on);
  }, [decide, noteId]);
  const threadSuggestion = thread ? openSuggestions.find((x) => x.sid === thread.id) : undefined;

  const suggestionOpen = useCallback((c: string) => setTimeout(() => editor.getExtension(SuggestionMenuExt)?.openSuggestionMenu(c), 0), [editor]);

  /** A discussion on the text between `from` and `to` (a commenter's mark waits for its first comment). */
  const commentOn = useCallback(
    (from: number, to: number) => {
      const tt = editor._tiptapEditor;
      const quote = tt.state.doc.textBetween(from, to, " ").trim();
      if (!quote) return;
      const id = shortId();
      markEdit(() => tt.chain().setTextSelection({ from, to }).setMark("comment", { stringValue: id }).run());
      if (commentOnly) pendingMark.current = id;
      requestAnimationFrame(() => setThread({ id, quote, el: markEl(id) }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commentOnly, editor, markEdit]
  );
  // The block menu's "Comment": a discussion on the whole block's text.
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const view = editor.prosemirrorView;
      if (!view || typeof id !== "string") return;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name !== "blockContainer" || node.attrs.id !== id) return true;
        const content = node.firstChild;
        if (content?.isTextblock) commentOn(pos + 2, pos + 2 + content.content.size);
        return false;
      });
    };
    window.addEventListener("nt-comment-block", on);
    return () => window.removeEventListener("nt-comment-block", on);
  }, [commentOn, editor]);

  // Find in page (⌘F, or ••• → Find in page): the page's own editor answers, a peeked row's when it has the focus.
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    if (embedded) return;
    const mine = () => {
      const root = editorRoot.current;
      const page = root?.closest(".nt-page");
      const active = document.activeElement;
      if (!root || !page) return false;
      if (active && active !== document.body) return page.contains(active);
      return Boolean(root.closest(".nt-peek")) === Boolean(document.querySelector(".nt-peek"));
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyF" && mine()) {
        e.preventDefault();
        setFinding(true);
      }
    };
    const onFind = (e: Event) => (e as CustomEvent<string>).detail === noteId && setFinding(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("nt-find", onFind);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("nt-find", onFind);
    };
  }, [embedded, noteId]);

  // Notion's editor shortcuts: ⌘/ block actions, ⌘⇧M comment, ⌘⇧H last color, ⌘⌥T all toggles,
  // ⌘⇧E equation, ⌘⌥9 turn into a page, ⌘K link (text selected).
  const [keyMenu, setKeyMenu] = useState<{ kind: "actions"; block: NotesBlock; anchor: HTMLElement } | { kind: "link"; anchor: Anchor } | null>(null);
  useEffect(() => {
    const dom = editor.domElement;
    if (!dom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (target && target !== dom && target.closest("input, textarea, select")) return;
      const editing = !readOnly && suggestCtl.mode() === "off";
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.shiftKey && e.code === "KeyM") {
        if (!canComment || embedded) return;
        stop();
        const sel = editor.prosemirrorState.selection;
        if (!sel.empty) return commentOn(sel.from, sel.to);
        // A selection made with the keyboard a moment ago may not have reached the editor yet: the page's own.
        const view = editor._tiptapEditor?.view;
        const ds = window.getSelection();
        if (!view || !ds || ds.isCollapsed || !ds.anchorNode || !ds.focusNode || !dom.contains(ds.anchorNode) || !dom.contains(ds.focusNode)) return;
        try {
          const x = view.posAtDOM(ds.anchorNode, ds.anchorOffset);
          const y = view.posAtDOM(ds.focusNode, ds.focusOffset);
          if (x !== y) commentOn(Math.min(x, y), Math.max(x, y));
        } catch {
          // Outside the text (a widget): nothing to discuss.
        }
        return;
      }
      if (e.altKey && e.code === "KeyT") {
        // Expand every toggle; when all are open, close them.
        stop();
        const wrappers = [...dom.querySelectorAll<HTMLElement>(".bn-toggle-wrapper")];
        const closed = wrappers.filter((w) => w.getAttribute("data-show-children") !== "true");
        for (const w of closed.length ? closed : wrappers) w.querySelector<HTMLButtonElement>(".bn-toggle-button")?.click();
        return;
      }
      if (!editing) return;
      const block = editor.getTextCursorPosition().block as NotesBlock;
      if (!e.shiftKey && !e.altKey && (e.key === "/" || e.code === "Slash")) {
        const el = dom.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(block.id)}"]`);
        if (!el) return;
        stop();
        setKeyMenu({ kind: "actions", block, anchor: el });
      } else if (e.shiftKey && e.code === "KeyH") {
        if (applyLastColor(editor)) stop();
      } else if (e.shiftKey && e.code === "KeyE") {
        stop();
        const text = editor.getSelectedText();
        editor.insertInlineContent([{ type: "inlineEquation", props: { latex: text || "x^2" } } as never, " "]);
      } else if (e.altKey && e.code === "Digit9" && TEXT_TYPES.has(block.type)) {
        stop();
        blockToPage(editor, block, noteId, api);
      } else if (!e.shiftKey && !e.altKey && e.code === "KeyK" && !editor.prosemirrorState.selection.empty) {
        stop();
        const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
        if (r) setKeyMenu({ kind: "link", anchor: { x: r.left, y: r.bottom } });
      }
    };
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener("keydown", onKey, true);
  }, [api, canComment, commentOn, editor, embedded, noteId, readOnly, suggestCtl]);

  // BlockNote 0.55 closes the menu before it clears the query, and a closed
  // menu clears nothing: "/table" stayed in the text above the new table.
  // The typed trigger + query is removed here before an item runs.
  const queries = useRef<Record<string, string>>({});
  const dropQuery = useCallback(
    (trigger: string) => {
      const tt = editor._tiptapEditor;
      const typed = trigger + (queries.current[trigger] ?? "");
      const to = tt.state.selection.from;
      const from = to - typed.length;
      if (from >= 0 && tt.state.doc.textBetween(from, to, "\n") === typed) tt.chain().deleteRange({ from, to }).run();
    },
    [editor]
  );

  // Slash menu items.
  const getSlashItems = useCallback(
    async (query: string): Promise<SlashItem[]> => {
      queries.current["/"] = query;
      const ins = (block: Record<string, unknown>) => {
        const pos = editor.getTextCursorPosition();
        const cur = pos.block as NotesBlock;
        const empty = Array.isArray(cur.content) && cur.content.length === 0;
        if (empty) return editor.updateBlock(cur, block as never) as NotesBlock;
        return editor.insertBlocks([block as never], cur, "after")[0] as NotesBlock;
      };
      // Notion opens the Upload / Embed popover right away for media blocks.
      // (Shown after the insert settles: the panel closes on any later
      // change, e.g. the trailing empty line BlockNote adds.)
      const media = (b: NotesBlock) => setTimeout(() => editor.getExtension(FilePanelExtension)?.showMenu(b.id), 150);
      const insertNoteBlock = (type: "page" | "database", noteIdNew: string) => {
        const pos = editor.getTextCursorPosition();
        const cur = pos.block as NotesBlock;
        const empty = Array.isArray(cur.content) && cur.content.length === 0 && cur.type === "paragraph";
        const blocks = [{ type, props: { noteId: noteIdNew } }];
        // Persist the parent first so the new child is never orphaned.
        const placed = empty ? editor.replaceBlocks([cur], blocks as never).insertedBlocks : editor.insertBlocks(blocks as never, cur, "after");
        // Keep typing below the new block (Notion moves the caret past it).
        const last = placed[placed.length - 1];
        if (last) {
          const next = editor.getNextBlock(last);
          const target = next && Array.isArray(next.content) && next.content.length === 0 ? next : editor.insertBlocks([{ type: "paragraph" }] as never, last, "after")[0];
          editor.setTextCursorPosition(target, "start");
        }
        save();
      };
      // Notion's "/2 columns" … "/5 columns": a row of empty columns, caret in the first.
      const insertColumns = (n: number) => {
        const cur = editor.getTextCursorPosition().block as NotesBlock;
        const layout = columnLayout(n) as never;
        const parent = editor.getParentBlock(cur);
        let placed: NotesBlock | undefined;
        if (parent?.type === "column") {
          // Columns do not nest: the new row goes below the current one.
          const row = editor.getParentBlock(parent);
          placed = row ? (editor.insertBlocks([layout], row, "after")[0] as NotesBlock) : undefined;
        } else {
          const empty = Array.isArray(cur.content) && cur.content.length === 0 && cur.type === "paragraph";
          placed = (empty ? editor.replaceBlocks([cur], [layout]).insertedBlocks : editor.insertBlocks([layout], cur, "after"))[0] as NotesBlock | undefined;
        }
        const first = placed?.children[0]?.children[0];
        if (first) editor.setTextCursorPosition(first, "start");
      };
      const g = {
        basic: t("slash.basic"),
        media: t("slash.media"),
        db: t("slash.database"),
        adv: t("slash.advanced"),
        inline: t("slash.inline"),
      };
      const items: SlashItem[] = [
        { key: "text", title: t("slash.text"), group: g.basic, icon: <Type />, aliases: ["paragraph", "p", "текст"], onItemClick: () => ins({ type: "paragraph" }) },
        { key: "h1", title: t("slash.h1"), group: g.basic, icon: <Heading1 />, hint: "#", aliases: ["h1", "heading", "title", "заголовок"], onItemClick: () => ins({ type: "heading", props: { level: 1 } }) },
        { key: "h2", title: t("slash.h2"), group: g.basic, icon: <Heading2 />, hint: "##", aliases: ["h2", "subheading", "заголовок2"], onItemClick: () => ins({ type: "heading", props: { level: 2 } }) },
        { key: "h3", title: t("slash.h3"), group: g.basic, icon: <Heading3 />, hint: "###", aliases: ["h3", "заголовок3"], onItemClick: () => ins({ type: "heading", props: { level: 3 } }) },
        { key: "h4", title: t("slash.h4"), group: g.basic, icon: <Heading4 />, hint: "####", aliases: ["h4", "заголовок4"], onItemClick: () => ins({ type: "heading", props: { level: 4 } }) },
        { key: "bullet", title: t("slash.bullet"), group: g.basic, icon: <List />, hint: "-", aliases: ["ul", "bullet", "list", "список"], onItemClick: () => ins({ type: "bulletListItem" }) },
        { key: "numbered", title: t("slash.numbered"), group: g.basic, icon: <ListOrdered />, hint: "1.", aliases: ["ol", "numbered", "нумерованный"], onItemClick: () => ins({ type: "numberedListItem" }) },
        { key: "todo", title: t("slash.todo"), group: g.basic, icon: <ListChecks />, hint: "[]", aliases: ["todo", "task", "checkbox", "задача", "чекбокс"], onItemClick: () => ins({ type: "checkListItem" }) },
        { key: "toggle", title: t("slash.toggle"), group: g.basic, icon: <ChevronRight />, hint: ">", aliases: ["toggle", "collapse", "переключатель", "раскрывающийся"], onItemClick: () => ins({ type: "toggleListItem" }) },
        {
          key: "page",
          title: t("slash.page"),
          group: g.basic,
          icon: <FileText />,
          aliases: ["page", "subpage", "страница"],
          onItemClick: () => {
            const child = api.newPage(noteId, { stay: true });
            insertNoteBlock("page", child.id);
            api.open(child.id);
          },
        },
        { key: "callout", title: t("slash.callout"), group: g.basic, icon: <MessageSquareQuote />, aliases: ["callout", "note", "выноска"], onItemClick: () => ins({ type: "callout" }) },
        { key: "quote", title: t("slash.quote"), group: g.basic, icon: <Quote />, hint: '"', aliases: ["quote", "blockquote", "цитата"], onItemClick: () => ins({ type: "quote" }) },
        {
          key: "table",
          title: t("slash.table"),
          group: g.basic,
          icon: <Table />,
          aliases: ["table", "таблица"],
          onItemClick: () =>
            ins({
              type: "table",
              content: { type: "tableContent", rows: [{ cells: ["", "", ""] }, { cells: ["", "", ""] }, { cells: ["", "", ""] }] },
            }),
        },
        { key: "divider", title: t("slash.divider"), group: g.basic, icon: <Minus />, hint: "---", aliases: ["divider", "hr", "line", "разделитель"], onItemClick: () => ins({ type: "divider" }) },
        { key: "link_page", title: t("slash.linkPage"), group: g.basic, icon: <CornerUpRight />, aliases: ["link", "ссылка"], onItemClick: () => suggestionOpen("[[") },
        { key: "image", title: t("slash.image"), group: g.media, icon: <ImageIcon />, aliases: ["image", "img", "picture", "photo", "картинка", "фото"], onItemClick: () => media(ins({ type: "image" })) },
        { key: "video", title: t("slash.video"), group: g.media, icon: <Video />, aliases: ["video", "youtube", "видео"], onItemClick: () => media(ins({ type: "video" })) },
        { key: "audio", title: t("slash.audio"), group: g.media, icon: <Music />, aliases: ["audio", "sound", "аудио"], onItemClick: () => media(ins({ type: "audio" })) },
        { key: "code", title: t("slash.code"), group: g.media, icon: <SquareCode />, hint: "```", aliases: ["code", "snippet", "код"], onItemClick: () => ins({ type: "codeBlock" }) },
        { key: "file", title: t("slash.file"), group: g.media, icon: <Paperclip />, aliases: ["file", "attachment", "файл"], onItemClick: () => media(ins({ type: "file" })) },
        { key: "bookmark", title: t("slash.bookmark"), group: g.media, icon: <Globe />, aliases: ["bookmark", "url", "закладка"], onItemClick: () => ins({ type: "bookmark" }) },
        { key: "embed", title: t("slash.embed"), group: g.media, icon: <AlignLeft />, aliases: ["embed", "iframe", "встроить"], onItemClick: () => ins({ type: "embed" }) },
        // Notion's named embeds: the same block, asking for that service's link.
        ...(Object.entries(EMBED_PROVIDERS) as [EmbedProvider, string][]).map(([provider, name]) => ({
          key: `embed-${provider}`,
          title: name,
          group: g.media,
          icon: <AlignLeft />,
          aliases: [provider, ...name.toLowerCase().split(/[\s()]+/).filter(Boolean), "embed", "встроить"],
          onItemClick: () => ins({ type: "embed", props: { provider } }),
        })),
        { key: "pdf", title: t("slash.pdf"), group: g.media, icon: <FileText />, aliases: ["pdf", "document", "документ"], onItemClick: () => ins({ type: "pdf" }) },
        { key: "design", title: t("slash.design"), group: g.media, icon: <PenTool />, aliases: ["design", "frame", "mockup", "макет", "дизайн", "фрейм"], onItemClick: () => ins({ type: "design" }) },
        // zvena's ecosystem: a live issue from Projects (created here, or an existing one).
        { key: "issue", title: et("slashIssue"), subtext: et("slashIssueHint"), group: g.media, icon: <CircleDot />, aliases: ["issue", "task", "todo", "ticket", "задача", "тикет"], onItemClick: () => ins({ type: "issue" }) },
        { key: "issues", title: et("slashIssues"), subtext: et("slashIssuesHint"), group: g.media, icon: <ListChecks />, aliases: ["issues", "tasks", "project", "задачи", "проект"], onItemClick: () => ins({ type: "issues" }) },
        ...(
          [
            ["db_table", "slash.dbTable", <Table2 key="i" />, "table"],
            ["db_board", "slash.dbBoard", <KanbanSquare key="i" />, "board"],
            ["db_gallery", "slash.dbGallery", <GalleryHorizontalEnd key="i" />, "gallery"],
            ["db_list", "slash.dbList", <ListTree key="i" />, "list"],
            ["db_calendar", "slash.dbCalendar", <CalendarDays key="i" />, "calendar"],
            ["db_timeline", "slash.dbTimeline", <GanttChart key="i" />, "timeline"],
            ["db_chart", "slash.dbChart", <ChartColumn key="i" />, "chart"],
            ["db_form", "slash.dbForm", <ClipboardList key="i" />, "form"],
          ] as const
        ).map(([key, label, icon, view]) => ({
          key,
          title: t(label),
          group: g.db,
          icon,
          aliases: ["database", "db", "база", view],
          onItemClick: () => {
            const db = api.newDatabase(noteId, { inline: true, view, stay: true, ...(view === "form" ? { title: t("form.responsesDb") } : {}) });
            insertNoteBlock("database", db.id);
          },
        })),
        {
          key: "db_linked",
          title: t("slash.dbLinked"),
          group: g.db,
          icon: <ArrowUpRight />,
          aliases: ["linked", "link", "view", "database", "db", "связанное", "представление", "база"],
          onItemClick: () => {
            const b = ins({ type: "database", props: { noteId: "", view: shortId() + shortId() } });
            if (!editor.getNextBlock(b)) editor.insertBlocks([{ type: "paragraph" }] as never, b, "after");
          },
        },
        {
          key: "db_page",
          title: t("slash.dbPage"),
          group: g.db,
          icon: <Database />,
          aliases: ["database", "full", "база"],
          onItemClick: () => {
            const db = api.newDatabase(noteId, { stay: true });
            insertNoteBlock("page", db.id);
            api.open(db.id);
          },
        },
        { key: "toc", title: t("slash.toc"), group: g.adv, icon: <ListTree />, aliases: ["toc", "contents", "оглавление"], onItemClick: () => ins({ type: "toc" }) },
        {
          key: "synced",
          title: t("slash.synced"),
          group: g.adv,
          icon: <RefreshCw />,
          aliases: ["synced", "sync", "синхронизированный", "синхронизация", "общий"],
          onItemClick: () => {
            // Under this page, so the synced content is exactly as private as the page.
            const content = api.store.create({ kind: "page", parentId: noteId, synced: true, title: "" });
            focusOnMount.add(content.id);
            const b = ins({ type: "synced", props: { noteId: content.id } });
            if (!editor.getNextBlock(b)) editor.insertBlocks([{ type: "paragraph" }] as never, b, "after");
          },
        },
        {
          key: "tabs",
          title: t("slash.tabs"),
          subtext: t("slash.tabsHint"),
          group: g.adv,
          icon: <PanelTop />,
          aliases: ["tabs", "tab", "вкладки", "вкладка", "табы"],
          onItemClick: () => {
            // Tabs do not go inside columns or other tabs (Notion): the block goes below the row.
            const cur = editor.getTextCursorPosition().block as NotesBlock;
            const parent = editor.getParentBlock(cur);
            const holder = parent?.type === "column" || parent?.type === "tab" ? editor.getParentBlock(parent) : null;
            const empty = !holder && Array.isArray(cur.content) && cur.content.length === 0 && cur.type === "paragraph";
            const layout = tabsLayout() as never;
            const placed = (holder ? editor.insertBlocks([layout], holder, "after") : empty ? editor.replaceBlocks([cur], [layout]).insertedBlocks : editor.insertBlocks([layout], cur, "after"))[0] as NotesBlock | undefined;
            const first = placed?.children[0]?.children[0];
            if (first) editor.setTextCursorPosition(first, "start");
            if (placed && !editor.getNextBlock(placed)) editor.insertBlocks([{ type: "paragraph" }] as never, placed, "after");
          },
        },
        { key: "breadcrumb", title: t("slash.breadcrumb"), group: g.adv, icon: <ChevronsRight />, aliases: ["breadcrumb", "путь", "навигация", "цепочка", "хлебные"], onItemClick: () => ins({ type: "breadcrumb" }) },
        {
          key: "button",
          title: t("slash.button"),
          group: g.adv,
          icon: <MousePointerClick />,
          aliases: ["button", "btn", "template button", "кнопка", "automation", "action", "действие"],
          onItemClick: () => {
            const b = ins({ type: "button" });
            markFreshButton(b.id);
            // Keep typing below the button.
            const next = editor.getNextBlock(b);
            if (!next) editor.insertBlocks([{ type: "paragraph" }] as never, b, "after");
          },
        },
        { key: "equation", title: t("slash.equation"), group: g.adv, icon: <Sigma />, aliases: ["math", "latex", "equation", "формула"], onItemClick: () => ins({ type: "equation" }) },
        { key: "th1", title: t("slash.toggleH1"), group: g.adv, icon: <Heading1 />, aliases: ["toggle heading"], onItemClick: () => ins({ type: "heading", props: { level: 1, isToggleable: true } }) },
        { key: "th2", title: t("slash.toggleH2"), group: g.adv, icon: <Heading2 />, aliases: ["toggle heading"], onItemClick: () => ins({ type: "heading", props: { level: 2, isToggleable: true } }) },
        { key: "th3", title: t("slash.toggleH3"), group: g.adv, icon: <Heading3 />, aliases: ["toggle heading"], onItemClick: () => ins({ type: "heading", props: { level: 3, isToggleable: true } }) },
        { key: "th4", title: t("slash.toggleH4"), group: g.adv, icon: <Heading4 />, aliases: ["toggle heading"], onItemClick: () => ins({ type: "heading", props: { level: 4, isToggleable: true } }) },
        { key: "mermaid", title: t("slash.mermaid"), group: g.adv, icon: <Workflow />, aliases: ["mermaid", "diagram", "flowchart", "диаграмма", "схема"], onItemClick: () => ins({ type: "mermaid" }) },
        ...([2, 3, 4, 5] as const).map((n) => ({
          key: `cols${n}`,
          title: t(`slash.cols${n}`),
          group: g.adv,
          icon: n === 2 ? <Columns2 /> : n === 3 ? <Columns3 /> : <Columns4 />,
          aliases: ["columns", "column", "layout", "колонки", "столбцы", "колонка", `${n}`],
          onItemClick: () => insertColumns(n),
        })),
        { key: "mention_person", title: t("slash.mentionPerson"), group: g.inline, icon: <AtSign />, aliases: ["person", "mention", "@", "человек", "упомянуть"], onItemClick: () => suggestionOpen("@") },
        { key: "mention", title: t("slash.mentionPage"), group: g.inline, icon: <FileText />, aliases: ["mention", "@", "упомянуть"], onItemClick: () => suggestionOpen("@") },
        {
          key: "date",
          title: t("slash.date"),
          group: g.inline,
          icon: <Calendar />,
          aliases: ["date", "today", "now", "reminder", "remind", "дата", "сегодня", "напоминание"],
          onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { noteId: "", date: new Date().toISOString().slice(0, 10) } } as never, " "]),
        },
        {
          key: "inline_eq",
          title: t("slash.inlineEquation"),
          group: g.inline,
          icon: <Sigma />,
          aliases: ["inline math", "формула"],
          onItemClick: () => editor.insertInlineContent([{ type: "inlineEquation", props: { latex: "x^2" } } as never, " "]),
        },
        { key: "emoji", title: t("slash.emoji"), group: g.inline, icon: <Smile />, aliases: ["emoji", "эмодзи", "смайл"], onItemClick: () => suggestionOpen(":") },
      ];
      // Notion's "/red", "/blue background": color the current block. Only
      // offered once something is typed, so the full menu stays short.
      const paint = (kind: "text" | "bg", c: NoteColor) => {
        const cur = editor.getTextCursorPosition().block as NotesBlock;
        const key = kind === "text" ? "textColor" : cur.type === "callout" ? "color" : "backgroundColor";
        if (key in (cur.props as Record<string, unknown>)) editor.updateBlock(cur, { props: { [key]: c } } as never);
      };
      const colors: SlashItem[] =
        query.trim().length >= 2
          ? NOTE_COLORS.filter((c) => c !== "default").flatMap((c) => [
              { key: `color-${c}`, title: t(`color.${c}` as NotesKey), group: t("block.color"), icon: <ColorSwatch color={c} />, aliases: [c, "color", "цвет"], onItemClick: () => paint("text", c) },
              {
                key: `bg-${c}`,
                title: t("color.bg", { color: t(`color.${c}` as NotesKey) }),
                group: t("block.color"),
                icon: <ColorSwatch color={c} bg />,
                aliases: [`${c} background`, "background", "highlight", "фон", "выделение"],
                onItemClick: () => paint("bg", c),
              },
            ])
          : [];
      return filterSuggestionItems([...items, ...colors], query);
    },
    [api, editor, noteId, save, suggestionOpen, t]
  );


  const getMentionItems = useCallback(
    async (query: string): Promise<MentionItem[]> => {
      queries.current["@"] = query;
      const q = query.trim().toLowerCase();
      const insertMention = (props: { noteId?: string; date?: string; remind?: string; userId?: string; name?: string }) =>
        editor.insertInlineContent([{ type: "mention", props: { noteId: "", date: "", remind: "", userId: "", name: "", ...props } } as never, " "]);
      // People first (Notion): members of the workspace; the name rides along for after they leave.
      const persons = matchPeople(people(), q, api.user?.id)
        .slice(0, q ? 8 : 5)
        .map<MentionItem>((p) => ({
          key: `user:${p.id}`,
          title: p.id === api.user?.id ? `${p.name} (${t("people.you")})` : p.name,
          group: t("people.group"),
          icon: <Avatar name={p.name} avatar={p.avatar} size={20} />,
          onItemClick: () => insertMention({ userId: p.id, name: p.name }),
        }));
      // Local calendar days (toISOString would give the UTC day after midnight).
      const iso = (d: number) => {
        const x = new Date();
        return localYmd(new Date(x.getFullYear(), x.getMonth(), x.getDate() + d));
      };
      // A date (with its time, if any) in words for the menu.
      const dateWords = (v: string, opts: Intl.DateTimeFormatOptions) => {
        const day = new Date(`${v.slice(0, 10)}T00:00:00`).toLocaleDateString(intlOf(locale), opts);
        const time = dateTimePart(v);
        return time ? `${day}, ${new Date(`${v.slice(0, 10)}T${time}:00`).toLocaleTimeString(intlOf(locale), { hour: "numeric", minute: "2-digit" })}` : day;
      };
      // Notion's "@remind tomorrow 7pm": a date mention with a reminder on the day, or at its time.
      const rm = /^(?:напомн\S*|remind(?: me)?)\s+(.+)$/i.exec(q);
      const remindDate = rm ? parseHumanDateTime(rm[1], locale) : null;
      const remindItem: MentionItem[] = remindDate
        ? [
            {
              key: `remind:${remindDate}`,
              title: t("remind.mention", { date: dateWords(remindDate, { weekday: "short", month: "long", day: "numeric" }) }),
              group: t("db.date"),
              icon: <AlarmClock />,
              onItemClick: () => {
                insertMention({ date: remindDate, remind: dateTimePart(remindDate) ? "at" : "day" });
                void askReminderPermission();
              },
            },
          ]
        : [];
      // A typed date ("15 октября", "пятница", "через 3 дня") comes first.
      const typed = q && !remindDate ? parseHumanDateTime(q, locale) : null;
      const typedItem: MentionItem[] =
        typed && ![iso(0), iso(1), iso(-1)].includes(typed)
          ? [
              {
                key: `date:${typed}`,
                title: dateWords(typed, { weekday: "short", month: "long", day: "numeric", year: "numeric" }),
                group: t("db.date"),
                icon: <Calendar />,
                onItemClick: () => insertMention({ date: typed }),
              },
            ]
          : [];
      const dates: MentionItem[] = [
        { key: "today", title: nearDay(locale, 0), group: t("db.date"), icon: <Calendar />, onItemClick: () => insertMention({ date: iso(0) }) },
        { key: "tomorrow", title: nearDay(locale, 1), group: t("db.date"), icon: <Calendar />, onItemClick: () => insertMention({ date: iso(1) }) },
        { key: "yesterday", title: nearDay(locale, -1), group: t("db.date"), icon: <Calendar />, onItemClick: () => insertMention({ date: iso(-1) }) },
      ].filter((d) => !q || d.title.toLowerCase().includes(q) || d.key.includes(q) || (typed !== null && d.key === (typed === iso(0) ? "today" : typed === iso(1) ? "tomorrow" : typed === iso(-1) ? "yesterday" : "")));
      const pages = api.snap.list
        .filter((n) => n.id !== noteId && n.trashedAt === null && !api.store.isTrashed(n.id) && (!q || n.title.toLowerCase().includes(q)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8)
        .map<MentionItem>((n) => ({
          key: n.id,
          title: displayTitle(n, t("page.untitled")),
          group: t("search.pages"),
          icon: n.icon ? <span style={{ fontSize: 16 }}><NoteIcon icon={n.icon} /></span> : <FileText />,
          onItemClick: () => insertMention({ noteId: n.id }),
        }));
      const create: MentionItem[] = q
        ? [
            {
              key: "new",
              title: t("search.newPage", { q: query.trim() }),
              group: t("search.pages"),
              icon: <Plus />,
              onItemClick: () => {
                const child = api.newPage(noteId, { stay: true, title: query.trim() });
                insertMention({ noteId: child.id });
              },
            },
          ]
        : [];
      if (remindItem.length) return remindItem;
      return typed ? [...typedItem, ...dates, ...persons, ...pages, ...create] : [...persons, ...pages, ...create, ...dates];
    },
    [api, editor, locale, noteId, t]
  );

  // ":" emoji search: the workspace's custom emoji first, then the standard set.
  const getEmojiItems = useCallback(
    async (query: string) => {
      queries.current[":"] = query;
      const custom = searchCustomEmoji(query, 20).map((e) => ({
        id: `custom:${e.name}`,
        // eslint-disable-next-line @next/next/no-img-element -- the workspace's own uploaded image
        icon: <img className="nt-cemoji" src={e.url} alt={`:${e.name}:`} title={`:${e.name}:`} />,
        onItemClick: () => editor.insertInlineContent([{ type: "customEmoji", props: { name: e.name, url: e.url } }, " "] as never),
      }));
      return [...custom, ...(await getDefaultReactEmojiPickerItems(editor, query))];
    },
    [editor]
  );

  const getLinkPageItems = useCallback(
    async (query: string): Promise<MentionItem[]> => {
      queries.current["[["] = query;
      const q = query.trim().toLowerCase();
      return api.snap.list
        .filter((n) => n.id !== noteId && n.trashedAt === null && !api.store.isTrashed(n.id) && (!q || n.title.toLowerCase().includes(q)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10)
        .map<MentionItem>((n) => ({
          key: n.id,
          title: displayTitle(n, t("page.untitled")),
          group: t("slash.linkPage"),
          icon: n.icon ? <span style={{ fontSize: 16 }}><NoteIcon icon={n.icon} /></span> : <FileText />,
          onItemClick: () => {
            const cur = editor.getTextCursorPosition().block as NotesBlock;
            const empty = Array.isArray(cur.content) && cur.content.length === 0;
            const block = { type: "page", props: { noteId: n.id } };
            if (empty) editor.replaceBlocks([cur], [block] as never);
            else editor.insertBlocks([block] as never, cur, "after");
          },
        }));
    },
    [api, editor, noteId, t]
  );

  // "+" (Notion): a link to a page, or a new sub-page with the typed name, as a block.
  const getPlusItems = useCallback(
    async (query: string): Promise<MentionItem[]> => {
      queries.current["+"] = query;
      const links = (await getLinkPageItems(query)).map((x) => ({ ...x, group: t("plus.title") }));
      queries.current["[["] = "";
      const title = query.trim();
      const create: MentionItem[] = title
        ? [
            {
              key: "new",
              title: t("search.newPage", { q: title }),
              group: t("plus.title"),
              icon: <Plus />,
              onItemClick: () => {
                const child = api.newPage(noteId, { stay: true, title: title.slice(0, 2000) });
                const cur = editor.getTextCursorPosition().block as NotesBlock;
                const empty = Array.isArray(cur.content) && cur.content.length === 0;
                const block = { type: "page", props: { noteId: child.id } };
                if (empty) editor.replaceBlocks([cur], [block] as never);
                else editor.insertBlocks([block] as never, cur, "after");
              },
            },
          ]
        : [];
      return [...create, ...links];
    },
    [api, editor, getLinkPageItems, noteId, t]
  );

  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  // The editor renders in the browser only (its own lazy part): known at the first render.
  const [touchScreen] = useState(isTouchScreen);

  return (
    <PageIdContext.Provider value={noteId}>
      <div ref={editorRoot} className={embedded ? "nt-editor nt-editor-embedded" : "nt-editor"} data-suggest={suggestMode !== "off" ? suggestMode : undefined}>
        <CodeCopy editor={editor} root={editorRoot} />
        <BlockNoteView
          editor={editor as never}
          theme={dark ? "dark" : "light"}
          editable={!readOnly || suggestMode === "only"}
          slashMenu={false}
          formattingToolbar={false}
          sideMenu={false}
          linkToolbar={false}
          filePanel={false}
          emojiPicker={false}
        >
          <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} suggestionMenuComponent={SlashMenu} onItemClick={(i: SlashItem) => (dropQuery("/"), i.onItemClick())} />
          <SuggestionMenuController triggerCharacter="@" getItems={getMentionItems} suggestionMenuComponent={MentionMenu} onItemClick={(i: MentionItem) => (dropQuery("@"), i.onItemClick())} />
          <SuggestionMenuController triggerCharacter="[[" getItems={getLinkPageItems} suggestionMenuComponent={MentionMenu} onItemClick={(i: MentionItem) => (dropQuery("[["), i.onItemClick())} />
          <GridSuggestionMenuController triggerCharacter=":" columns={10} minQueryLength={2} getItems={getEmojiItems} onItemClick={(i) => (dropQuery(":"), i.onItemClick())} />
          <SuggestionMenuController triggerCharacter="+" shouldOpen={plusOpens} getItems={getPlusItems} suggestionMenuComponent={MentionMenu} onItemClick={(i: MentionItem) => (dropQuery("+"), i.onItemClick())} />
          {/* Touch screens format from the bar above the keyboard: BlockNote's
              controller would add its own mobile bar there (F42). */}
          {!readOnly && !touchScreen && <FormattingToolbarController formattingToolbar={() => (suggestMode === "off" ? <FormatToolbar onComment={startComment} /> : <SuggestToolbar onComment={startComment} />)} />}
          {!readOnly && !embedded && suggestMode === "off" && <MobileToolbar editor={editor} root={editorRoot} onInsert={() => suggestionOpen("/")} onMention={() => suggestionOpen("@")} onComment={startComment} />}
          {!readOnly && suggestMode === "off" && <SideMenuController sideMenu={NotionSideMenu} />}
          <LinkToolbarController />
          {!readOnly && suggestMode === "off" && <FilePanelController filePanel={NotionFilePanel} />}
          {keyMenu?.kind === "actions" && (
            <Popover anchor={keyMenu.anchor} placement="bottom-start" onClose={() => setKeyMenu(null)}>
              <BlockMenu block={keyMenu.block} onClose={() => (setKeyMenu(null), editor.focus())} />
            </Popover>
          )}
          {keyMenu?.kind === "link" && <LinkInput anchor={keyMenu.anchor} onClose={() => (setKeyMenu(null), editor.focus())} />}
        </BlockNoteView>
      {pasteMenu && (
        <Popover anchor={{ x: pasteMenu.x, y: pasteMenu.y }} onClose={() => setPasteMenu(null)}>
          <Menu
            width={230}
            groups={[
              {
                key: "p",
                label: t("paste.title"),
                items: [
                  { key: "url", label: t("paste.keep"), icon: <Link />, onSelect: () => setPasteMenu(null) },
                  {
                    key: "mention",
                    label: t("paste.mention"),
                    icon: <AtSign />,
                    onSelect: () => {
                      const { blockId, url } = pasteMenu;
                      setPasteMenu(null);
                      linkToMention(blockId, url);
                    },
                  },
                  {
                    key: "bookmark",
                    label: t("paste.bookmark"),
                    icon: <Globe />,
                    onSelect: () => {
                      const b = editor.getBlock(pasteMenu.blockId) as NotesBlock | undefined;
                      setPasteMenu(null);
                      if (!b) return;
                      const only = Array.isArray(b.content) && b.content.map((c) => ("text" in c ? c.text : "content" in c && Array.isArray(c.content) ? c.content.map((x: { text?: string }) => x.text ?? "").join("") : "")).join("").trim() === pasteMenu.url;
                      if (only) editor.updateBlock(b, { type: "bookmark", props: { url: pasteMenu.url } } as never);
                      else editor.insertBlocks([{ type: "bookmark", props: { url: pasteMenu.url } }] as never, b, "after");
                    },
                  },
                  ...(embedSrc(pasteMenu.url) && embedSrc(pasteMenu.url)?.src !== new URL(pasteMenu.url).toString()
                    ? [
                        {
                          key: "embed",
                          label: t("paste.embed"),
                          icon: <AlignLeft />,
                          onSelect: () => {
                            const b = editor.getBlock(pasteMenu.blockId) as NotesBlock | undefined;
                            setPasteMenu(null);
                            if (!b) return;
                            const only = Array.isArray(b.content) && b.content.map((c) => ("text" in c ? c.text : "content" in c && Array.isArray(c.content) ? c.content.map((x: { text?: string }) => x.text ?? "").join("") : "")).join("").trim() === pasteMenu.url;
                            if (only) editor.updateBlock(b, { type: "embed", props: { url: pasteMenu.url } } as never);
                            else editor.insertBlocks([{ type: "embed", props: { url: pasteMenu.url } }] as never, b, "after");
                          },
                        },
                      ]
                    : []),
                ],
              },
            ]}
          />
        </Popover>
      )}
        {commentOnly && pick && (
          <Portal>
            <button
              type="button"
              className="nt-cm-pick nt-btn-reset"
              style={{ left: pick.x, top: Math.max(8, pick.y - 40) }}
              // Keeps the selection while the button is pressed.
              onMouseDown={(e) => e.preventDefault()}
              onClick={commentOnPick}
            >
              <MessageSquare size={14} />
              {t("fmt.comment")}
            </button>
          </Portal>
        )}
        {openThreads.length > 0 && <style>{openThreads.map((id) => `.nt-editor .nt-cmark[data-thread="${CSS.escape(id)}"]{background:var(--nt-cmark-bg);border-bottom:2px solid var(--nt-cmark-line);cursor:pointer}`).join("")}</style>}
        {!embedded && <SuggestColors comments={note.comments} />}
        {finding && <FindBar editor={editor} canReplace={!readOnly && suggestMode === "off"} onClose={() => setFinding(false)} />}
        {!embedded && openSuggestions.length > 0 && <SuggestGutter editor={editor} root={editorRoot} note={note} list={openSuggestions} onOpen={(id, el) => setThread({ id, el })} />}
        {thread && (
          <ThreadPopover
            note={note}
            threadId={thread.id}
            quote={thread.quote}
            anchor={thread.el ?? markEl(thread.id) ?? suggestionEl(editor.domElement, thread.id)}
            suggestion={threadSuggestion ? { ins: threadSuggestion.ins, del: threadSuggestion.del, canDecide, onDecide: (accept) => void decide([threadSuggestion.sid], accept) } : undefined}
            onRemoveMark={() => removeMark(thread.id)}
            onClose={(empty) => {
              // A new thread closed without a comment leaves no mark behind.
              if (empty) removeMark(thread.id);
              setThread(null);
            }}
          />
        )}
      </div>
    </PageIdContext.Provider>
  );
});

// A synced block shows its content note with a full editor of its own.
registerSyncedRenderer(({ note, readOnly }) => <NoteEditor note={note} readOnly={readOnly} embedded />);
// Inline databases render through the editor without importing it back; their
// code loads when a page first shows one.
registerDbRenderer(({ dbId, scope, onPick }) => (dbId ? <InlineDatabase dbId={dbId} scope={scope} inline /> : onPick ? <LinkedPicker onPick={onPick} /> : null));
