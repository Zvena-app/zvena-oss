"use client";

// The rich text editor of issue descriptions, comments and project updates
// (Tiptap, editor-tiptap.tsx). It is the heaviest code of Projects and of
// Calendar's event panel, and no screen needs it for its first paint, so it
// is a chunk of its own: loaded on first use, or ahead of time (preloadEditor:
// at once on an issue page, else when the app is idle). Until it is here the
// text shows as it reads, in the editor's own layout, so nothing jumps.

import type { ReactNode } from "react";
import { lazyPart } from "@/lib/lazy-part";
import type { EditorProps } from "./editor-tiptap";

export type { EditorProps } from "./editor-tiptap";

const editorPart = lazyPart(() => import("./editor-tiptap"));

/** Starts loading the editor (once). */
export const loadEditor = (): Promise<unknown> => editorPart.load();

/** Loads the editor in the background: now, or once the browser is idle. */
export function preloadEditor(when: "now" | "idle" = "idle"): void {
  if (typeof window === "undefined") return;
  const go = () => void editorPart.load().catch(() => {});
  if (when === "now") go();
  else if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(go, { timeout: 4000 });
  else window.setTimeout(go, 1500);
}

export function MarkdownEditor(props: EditorProps) {
  const m = editorPart.use();
  if (m) return <m.MarkdownEditor {...props} />;
  const editable = props.editable ?? true;
  return <Waiting value={props.value} className={props.className} editable={editable} placeholder={props.placeholder} />;
}

/** Read-only Markdown (comments, updates): the same schema, no editing. */
export function MarkdownView({ value, className }: { value: string; className?: string }) {
  return <MarkdownEditor value={value} editable={false} className={className} />;
}

/** The text while the editor loads: its blocks as plain text, in the editor's markup and classes. */
function Waiting({ value, className, editable, placeholder }: { value: string; className?: string; editable: boolean; placeholder?: string }) {
  const blocks = plainBlocks(value);
  return (
    <div className={`pj-editor ${className ?? ""}`} data-editable={editable || undefined} aria-busy="true">
      <div>
        <div className="pj-prose">{blocks.length ? blocks : <p className="is-editor-empty" data-placeholder={editable ? (placeholder ?? "") : ""} />}</div>
      </div>
    </div>
  );
}

/** Inline Markdown as its text: links and images by their words, emphasis and code marks dropped. */
function inline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1");
}

/** Markdown's blocks (headings, lists, checklists, quotes, code, rules, paragraphs) as React text, never as HTML. */
function plainBlocks(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: { kind: "ul" | "ol" | "task"; items: { text: string; checked?: boolean }[] } | null = null;
  let quote: string[] = [];
  const key = () => out.length;
  const flushPara = () => {
    if (para.length) out.push(<p key={key()}>{inline(para.join(" "))}</p>);
    para = [];
  };
  const flushList = () => {
    const l = list;
    if (!l) return;
    const items = l.items.map((it, i) =>
      l.kind === "task" ? (
        <li key={i} data-checked={it.checked ? "true" : "false"}>
          <label>
            <input type="checkbox" checked={Boolean(it.checked)} disabled readOnly />
          </label>
          <div>
            <p>{inline(it.text)}</p>
          </div>
        </li>
      ) : (
        <li key={i}>
          <p>{inline(it.text)}</p>
        </li>
      )
    );
    out.push(l.kind === "ol" ? <ol key={key()}>{items}</ol> : <ul key={key()} {...(l.kind === "task" ? { "data-type": "taskList" } : {})}>{items}</ul>);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length)
      out.push(
        <blockquote key={key()}>
          <p>{inline(quote.join(" "))}</p>
        </blockquote>
      );
    quote = [];
  };
  const flush = () => {
    flushPara();
    flushList();
    flushQuote();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) {
      flush();
      const fence = t.slice(0, 3);
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) code.push(lines[i]);
      out.push(
        <pre key={key()}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }
    if (!t) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      const level = Math.min(3, h[1].length);
      const H = (["h1", "h2", "h3"] as const)[level - 1];
      out.push(<H key={key()}>{inline(h[2])}</H>);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      out.push(<hr key={key()} />);
      continue;
    }
    const task = /^[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(t);
    const bullet = /^[-*+]\s+(.*)$/.exec(t);
    const num = /^\d+[.)]\s+(.*)$/.exec(t);
    if (task || bullet || num) {
      flushPara();
      flushQuote();
      const kind = task ? "task" : bullet ? "ul" : "ol";
      if (list && list.kind !== kind) flushList();
      list ??= { kind, items: [] };
      list.items.push(task ? { text: task[2], checked: task[1] !== " " } : { text: (bullet ?? num)?.[1] ?? "" });
      continue;
    }
    if (t.startsWith(">")) {
      flushPara();
      flushList();
      quote.push(t.replace(/^>\s?/, ""));
      continue;
    }
    // A line under a list item continues it; otherwise it is the paragraph's.
    if (list && /^\s/.test(line)) {
      const last = list.items[list.items.length - 1];
      last.text = `${last.text} ${t}`;
      continue;
    }
    flushList();
    flushQuote();
    para.push(t);
  }
  flush();
  return out;
}
