"use client";

// The rich text editor of issue descriptions, comments and project updates:
// Tiptap with Markdown as the stored format (headings, lists, checklists,
// quotes, code, links, images from attachments, @mentions).
//
// Safety: content is parsed into the editor's schema, so only known nodes
// and marks survive — raw HTML in the Markdown never becomes markup; links
// are limited to http(s)/mailto/relative URLs, and images to this
// workspace's attachments (no external trackers).

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor, type Editor as TEditor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Mention from "@tiptap/extension-mention";
import Image from "@tiptap/extension-image";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { Bold, Code, Heading2, Italic, Link2, List, ListChecks, ListOrdered, Quote, Strikethrough } from "lucide-react";
import type { Person } from "@/lib/projects/types";
import { Avatar } from "./ui";
import { useT } from "./i18n";

const SAFE_IMG = /^\/api\/projects\/attachments\/[A-Za-z0-9_-]{1,40}(\?[^"'<>\s]*)?$/;
const SAFE_LINK = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

const SafeImage = Image.extend({
  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute("src") ?? "";
          return SAFE_IMG.test(v) ? v : null;
        },
        renderHTML: (attrs) => (attrs.src && SAFE_IMG.test(String(attrs.src)) ? { src: attrs.src } : {}),
      },
      alt: { default: null },
      title: { default: null },
    };
  },
}).configure({ inline: false, allowBase64: false });

interface MentionState {
  items: Person[];
  index: number;
  rect: DOMRect | null;
  command: ((p: { id: string; label: string }) => void) | null;
}

export interface EditorProps {
  value: string;
  onChange?: (md: string) => void;
  onBlur?: (md: string) => void;
  onSubmit?: (md: string) => void;
  placeholder?: string;
  editable?: boolean;
  people?: Person[];
  autofocus?: boolean;
  onUpload?: (file: File) => Promise<{ url: string; name: string; image: boolean } | null>;
  className?: string;
  toolbar?: boolean;
  /** Clears the editor after submit (comments). */
  clearOnSubmit?: boolean;
  label?: string;
}

/**
 * What the editor's extensions (created once) read at the time they run:
 * the latest people, callbacks and mention popup state. Updated after each
 * render; read only from editor events.
 */
class Bridge {
  people: Person[] = [];
  mention: MentionState = { items: [], index: 0, rect: null, command: null };
  constructor(public setMention: (m: MentionState | ((m: MentionState) => MentionState)) => void) {}
  cb: Pick<EditorProps, "onChange" | "onBlur" | "onSubmit" | "onUpload"> = {};
  timer: ReturnType<typeof setTimeout> | null = null;
  lastSent = "";
  /** Typing: the Markdown is sent half a second after the last change. */
  changed(read: () => string): void {
    if (!this.cb.onChange) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const md = read();
      this.lastSent = md;
      this.cb.onChange?.(md);
    }, 500);
  }
  /** Leaving the editor sends a pending change at once. */
  blurred(md: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      if (this.cb.onChange && md !== this.lastSent) {
        this.lastSent = md;
        this.cb.onChange(md);
      }
    }
    this.cb.onBlur?.(md);
  }
  sent(md: string): void {
    this.lastSent = md;
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
  sync(people: Person[], mention: MentionState, cb: Bridge["cb"]): void {
    this.people = people;
    this.mention = mention;
    this.cb = cb;
  }
}

function buildExtensions(b: Bridge, opts: { editable: boolean; placeholder?: string; clearOnSubmit?: boolean }) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: !opts.editable,
        autolink: true,
        linkOnPaste: true,
        isAllowedUri: (url: string) => SAFE_LINK.test(url),
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      },
    }),
    Markdown.configure({ indentation: { style: "space", size: 2 } }),
    Placeholder.configure({ placeholder: opts.placeholder ?? "" }),
    TaskList,
    TaskItem.configure({ nested: true }),
    SafeImage,
    Mention.configure({
      HTMLAttributes: { class: "pj-mention" },
      renderText: ({ node }) => `@${node.attrs.label ?? ""}`,
      renderHTML: ({ node }) => ["span", { class: "pj-mention", "data-id": node.attrs.id }, `@${node.attrs.label ?? ""}`],
      suggestion: {
        char: "@",
        items: ({ query }: { query: string }) => {
          const q = query.toLocaleLowerCase();
          return b.people.filter((p) => p.role && p.name.toLocaleLowerCase().includes(q)).slice(0, 8);
        },
        render: () => ({
          onStart: (p: SuggestionProps<Person>) => b.setMention({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, command: (x) => p.command(x) }),
          onUpdate: (p: SuggestionProps<Person>) => b.setMention((m) => ({ items: p.items, index: Math.min(m.index, Math.max(0, p.items.length - 1)), rect: p.clientRect?.() ?? null, command: (x) => p.command(x) })),
          onKeyDown: ({ event }: SuggestionKeyDownProps) => {
            const m = b.mention;
            if (!m.items.length) return false;
            if (event.key === "ArrowDown") {
              b.setMention({ ...m, index: (m.index + 1) % m.items.length });
              return true;
            }
            if (event.key === "ArrowUp") {
              b.setMention({ ...m, index: (m.index - 1 + m.items.length) % m.items.length });
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              const it = m.items[m.index];
              if (it && m.command) m.command({ id: it.id, label: it.name });
              return true;
            }
            if (event.key === "Escape") {
              b.setMention({ items: [], index: 0, rect: null, command: null });
              return true;
            }
            return false;
          },
          onExit: () => b.setMention({ items: [], index: 0, rect: null, command: null }),
        }),
      },
    }),
    Extension.create({
      name: "pjKeys",
      addKeyboardShortcuts() {
        return {
          "Mod-Enter": ({ editor }) => {
            const submit = b.cb.onSubmit;
            if (!submit) return false;
            submit(editor.getMarkdown());
            if (opts.clearOnSubmit) editor.commands.clearContent(true);
            return true;
          },
          Escape: ({ editor }) => {
            editor.commands.blur();
            return true;
          },
        };
      },
    }),
  ];
}

export function MarkdownEditor({ value, onChange, onBlur, onSubmit, placeholder, editable = true, people = [], autofocus, onUpload, className, toolbar = false, clearOnSubmit, label }: EditorProps) {
  const { t } = useT();
  const [mention, setMention] = useState<MentionState>({ items: [], index: 0, rect: null, command: null });
  const [bridge] = useState(() => new Bridge(setMention));
  // The editor is built once per mount; placeholders and modes do not change while open.
  const [extensions] = useState(() => buildExtensions(bridge, { editable, placeholder, clearOnSubmit }));
  useLayoutEffect(() => {
    bridge.sync(people, mention, { onChange, onBlur, onSubmit, onUpload });
  });

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    editable,
    immediatelyRender: false,
    autofocus: autofocus ? "end" : false,
    editorProps: {
      attributes: { class: "pj-prose", "aria-label": label ?? placeholder ?? "", ...(editable ? { role: "textbox", "aria-multiline": "true" } : {}) },
      handlePaste: (_view, event) => uploadFiles(event.clipboardData?.files),
      handleDrop: (_view, event) => uploadFiles((event as DragEvent).dataTransfer?.files),
    },
    onUpdate: ({ editor: ed }) => bridge.changed(ed.getMarkdown.bind(ed)),
    onBlur: ({ editor: ed }) => bridge.blurred(ed.getMarkdown()),
  });

  function uploadFiles(files: FileList | undefined | null): boolean {
    const up = bridge.cb.onUpload;
    if (!up || !files || !files.length || !editor) return false;
    for (const f of Array.from(files).slice(0, 10)) {
      void up(f).then((r) => {
        if (!r || !editor) return;
        if (r.image) editor.chain().focus().setImage({ src: r.url, alt: r.name }).run();
        else editor.chain().focus().insertContent({ type: "text", text: r.name, marks: [{ type: "link", attrs: { href: r.url } }] }).insertContent(" ").run();
      });
    }
    return true;
  }

  // Outside changes (another person saved, a reload) replace the content when not editing.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isFocused && editable) return;
    if (editor.getMarkdown() !== value) {
      editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
      bridge.sent(value);
    }
  }, [value, editor, editable, bridge]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => () => bridge.dispose(), [bridge]);

  return (
    <div className={`pj-editor ${className ?? ""}`} data-editable={editable || undefined}>
      {toolbar && editable && editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
      {mention.rect && mention.items.length > 0 && typeof document !== "undefined" &&
        createPortal(
          <div className="pj-popover pj-mention-pop" style={{ left: mention.rect.left, top: mention.rect.bottom + 4, width: 240 }} data-pj-layer="" data-pj-depth={99} role="listbox" aria-label={t("f.assignee")}>
            <div className="pj-menu-list">
              {mention.items.map((p, i) => (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={i === mention.index}
                  className="pj-menu-item"
                  data-active={i === mention.index || undefined}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    mention.command?.({ id: p.id, label: p.name });
                  }}
                >
                  <Avatar name={p.name} id={p.id} size={18} src={p.avatar} />
                  <span className="pj-menu-label">{p.name}</span>
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function Toolbar({ editor }: { editor: TEditor }) {
  const { t } = useT();
  // The link form takes the bar's place (inside the editor, so the bar stays open while typing).
  const [link, setLink] = useState<{ value: string; had: boolean; bad: boolean } | null>(null);
  const btn = (label: string, icon: React.ReactNode, on: boolean, run: () => void) => (
    <button
      type="button"
      className="pj-tb-btn"
      aria-label={label}
      title={label}
      aria-pressed={on}
      data-on={on || undefined}
      onMouseDown={(e) => {
        e.preventDefault();
        run();
      }}
    >
      {icon}
    </button>
  );
  const c = () => editor.chain().focus();
  const applyLink = () => {
    if (!link) return;
    let url = link.value.trim();
    if (!url) {
      c().extendMarkRange("link").unsetLink().run();
      setLink(null);
      return;
    }
    // "example.com" means the website.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("/") && !url.startsWith("#") && /^[^\s/]+\.[^\s]+/.test(url)) url = `https://${url}`;
    if (!SAFE_LINK.test(url)) {
      setLink({ ...link, bad: true });
      return;
    }
    c().extendMarkRange("link").setLink({ href: url }).run();
    setLink(null);
  };
  if (link)
    return (
      <form
        className="pj-toolbar pj-tb-link"
        role="dialog"
        aria-label={t("ed.link")}
        onSubmit={(e) => {
          e.preventDefault();
          applyLink();
        }}
      >
        <Link2 size={14} aria-hidden />
        <input
          className="pj-tb-link-input"
          autoFocus
          value={link.value}
          placeholder={t("ed.linkPh")}
          aria-label={t("ed.link")}
          aria-invalid={link.bad || undefined}
          title={link.bad ? t("ed.linkBad") : undefined}
          onChange={(e) => setLink({ ...link, value: e.target.value, bad: false })}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setLink(null);
              editor.commands.focus();
            }
          }}
        />
        <button type="submit" className="pj-btn pj-btn-primary pj-btn-sm">
          {t("ed.linkApply")}
        </button>
        {link.had && (
          <button
            type="button"
            className="pj-btn pj-btn-sm"
            onClick={() => {
              c().extendMarkRange("link").unsetLink().run();
              setLink(null);
            }}
          >
            {t("ed.linkRemove")}
          </button>
        )}
        {link.bad && (
          <span className="pj-tb-link-bad" role="alert">
            {t("ed.linkBad")}
          </span>
        )}
      </form>
    );
  return (
    <div className="pj-toolbar" role="toolbar" aria-label={t("ed.toolbar")}>
      {btn(t("ed.h2"), <Heading2 size={15} />, editor.isActive("heading", { level: 2 }), () => c().toggleHeading({ level: 2 }).run())}
      {btn(t("ed.bold"), <Bold size={15} />, editor.isActive("bold"), () => c().toggleBold().run())}
      {btn(t("ed.italic"), <Italic size={15} />, editor.isActive("italic"), () => c().toggleItalic().run())}
      {btn(t("ed.strike"), <Strikethrough size={15} />, editor.isActive("strike"), () => c().toggleStrike().run())}
      {btn(t("ed.code"), <Code size={15} />, editor.isActive("code"), () => c().toggleCode().run())}
      {btn(t("ed.list"), <List size={15} />, editor.isActive("bulletList"), () => c().toggleBulletList().run())}
      {btn(t("ed.numbered"), <ListOrdered size={15} />, editor.isActive("orderedList"), () => c().toggleOrderedList().run())}
      {btn(t("ed.checklist"), <ListChecks size={15} />, editor.isActive("taskList"), () => c().toggleTaskList().run())}
      {btn(t("ed.quote"), <Quote size={15} />, editor.isActive("blockquote"), () => c().toggleBlockquote().run())}
      {btn(t("ed.link"), <Link2 size={15} />, editor.isActive("link"), () => {
        const prev = editor.getAttributes("link").href as string | undefined;
        setLink({ value: prev ?? "", had: Boolean(prev), bad: false });
      })}
    </div>
  );
}

/** Read-only Markdown (comments, updates): the same schema, no editing. */
export function MarkdownView({ value, className }: { value: string; className?: string }) {
  return <MarkdownEditor value={value} editable={false} className={className} />;
}
