"use client";

// A page's blocks as plain, read-only HTML while the editor (BlockNote,
// ProseMirror: ~260 KB compressed, its own lazy part) is still loading.
// It mirrors BlockNote's DOM and classes (.bn-block-group > .bn-block-outer
// > .bn-block > .bn-block-content[data-content-type]), so notes.css draws
// it exactly like the editor and nothing moves when the editor takes over.
// Rich blocks (databases, media, embeds) keep a box of a similar height.

import { Fragment, type ReactNode } from "react";
import { useNotes } from "./context";
import { NoteIcon } from "./NoteIcon";
import { displayTitle } from "@/lib/notes/model";
import { personName } from "@/lib/notes/people";

type Inline = { type?: string; text?: string; styles?: Record<string, unknown>; href?: string; content?: unknown; props?: Record<string, unknown> };
type Block = { id?: string; type?: string; props?: Record<string, unknown>; content?: unknown; children?: Block[] };

function useInline() {
  const { snap, t } = useNotes();
  const render = (content: unknown, key = "i"): ReactNode => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    return (content as Inline[]).map((n, i) => {
      const k = `${key}${i}`;
      if (!n || typeof n !== "object") return null;
      if (n.type === "link") {
        return (
          <a key={k} href={typeof n.href === "string" ? n.href : undefined} target="_blank" rel="noopener noreferrer nofollow">
            {render(n.content, k)}
          </a>
        );
      }
      if (n.type === "mention") {
        const date = typeof n.props?.date === "string" ? n.props.date : "";
        if (date) return <span key={k} className="nt-mention nt-mention-datebox"><span className="nt-mention-date">{date.replace("T", " ")}</span></span>;
        // A person: the name only (public pages never show who it is by id).
        if (n.props?.userId || n.props?.name) {
          const who = personName(String(n.props?.userId ?? "")) || String(n.props?.name ?? "") || t("people.unknown");
          return (
            <span key={k} className="nt-mention nt-mention-person">
              @{who}
            </span>
          );
        }
        const note = snap.byId.get(String(n.props?.noteId ?? ""));
        return (
          <span key={k} className="nt-mention">
            <span>
              <NoteIcon icon={note?.icon} fallback="📄" />
            </span>
            <span className="nt-mention-title">{note ? displayTitle(note, t("page.untitled")) : "—"}</span>
          </span>
        );
      }
      if (n.type === "inlineEquation") return <code key={k}>{String(n.props?.latex ?? "")}</code>;
      if (n.type !== "text") return <Fragment key={k}>{render(n.content, k)}</Fragment>;
      const st = n.styles ?? {};
      let el: ReactNode = n.text ?? "";
      if (st.code) el = <code>{el}</code>;
      if (st.bold) el = <strong>{el}</strong>;
      if (st.italic) el = <em>{el}</em>;
      if (st.underline) el = <u>{el}</u>;
      if (st.strike) el = <s>{el}</s>;
      if (typeof st.textColor === "string" && st.textColor !== "default") el = <span data-style-type="textColor" data-value={st.textColor}>{el}</span>;
      if (typeof st.backgroundColor === "string" && st.backgroundColor !== "default") el = <span data-style-type="backgroundColor" data-value={st.backgroundColor}>{el}</span>;
      // Suggested edits (lib/notes/suggestions.ts) read as in the editor.
      if (typeof st.suggestIns === "string") el = <ins className="nt-sins" data-sid={st.suggestIns}>{el}</ins>;
      if (typeof st.suggestDel === "string") el = <del className="nt-sdel" data-sid={st.suggestDel}>{el}</del>;
      return <Fragment key={k}>{el}</Fragment>;
    });
  };
  return render;
}

const HEADING_TAGS = { 1: "h1", 2: "h2", 3: "h3", 4: "h4" } as const;

function blockAttrs(b: Block): Record<string, string> {
  const p = b.props ?? {};
  const out: Record<string, string> = { "data-content-type": String(b.type ?? "paragraph") };
  if (typeof p.textColor === "string" && p.textColor !== "default") out["data-text-color"] = p.textColor;
  if (typeof p.backgroundColor === "string" && p.backgroundColor !== "default") out["data-background-color"] = p.backgroundColor;
  if (typeof p.textAlignment === "string" && p.textAlignment !== "left") out["data-text-alignment"] = p.textAlignment;
  return out;
}

function Group({ blocks, render }: { blocks: Block[]; render: (c: unknown, k?: string) => ReactNode }) {
  // Numbered lists count consecutive items, as BlockNote's data-index does.
  const indexes: number[] = [];
  for (const b of blocks) indexes.push(b.type === "numberedListItem" ? (indexes.at(-1) ?? 0) + 1 : 0);
  return (
    <div className="bn-block-group" data-node-type="blockGroup">
      {blocks.map((b, i) => (
        <StaticBlock key={b.id ?? i} block={b} index={indexes[i]} render={render} />
      ))}
    </div>
  );
}

function StaticBlock({ block: b, index, render }: { block: Block; index: number; render: (c: unknown, k?: string) => ReactNode }) {
  const p = b.props ?? {};
  const attrs = blockAttrs(b);
  let body: ReactNode;
  switch (b.type) {
    case "heading": {
      const n = Number(p.level);
      const level = n === 2 || n === 3 || n === 4 ? n : n > 4 ? 4 : 1;
      if (level !== 1) attrs["data-level"] = String(level);
      const Tag = HEADING_TAGS[level];
      body = <Tag className="bn-inline-content">{render(b.content)}</Tag>;
      break;
    }
    case "numberedListItem":
      attrs["data-index"] = String(index);
      body = <p className="bn-inline-content">{render(b.content)}</p>;
      break;
    case "checkListItem":
      if (p.checked) attrs["data-checked"] = "true";
      body = (
        <>
          <input type="checkbox" checked={Boolean(p.checked)} readOnly tabIndex={-1} aria-hidden="true" />
          <p className="bn-inline-content">{render(b.content)}</p>
        </>
      );
      break;
    case "quote":
      body = <blockquote className="bn-inline-content">{render(b.content)}</blockquote>;
      break;
    case "codeBlock":
      body = (
        <pre>
          <code className="bn-inline-content">{render(b.content)}</code>
        </pre>
      );
      break;
    case "divider":
      body = <hr />;
      break;
    case "callout":
      body = (
        <div className="nt-callout" data-color={typeof p.color === "string" ? p.color : undefined}>
          <div className="nt-callout-icon">
            <NoteIcon icon={typeof p.icon === "string" ? p.icon : "💡"} />
          </div>
          <div className="nt-callout-body">
            <p className="bn-inline-content">{render(b.content)}</p>
          </div>
        </div>
      );
      break;
    case "image":
      body =
        typeof p.url === "string" && p.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.url} alt={typeof p.caption === "string" ? p.caption : ""} style={{ maxWidth: "100%", width: typeof p.previewWidth === "number" ? p.previewWidth : undefined }} />
        ) : (
          <div className="nt-static-box" />
        );
      break;
    case "table":
      body = <div className="nt-static-box nt-static-box-table" />;
      break;
    case "toggleListItem":
      // BlockNote's own toggle markup (closed), so the arrow keeps the text in place.
      body = (
        <div>
          <div className="bn-toggle-wrapper" data-show-children="false">
            <button className="bn-toggle-button" type="button" tabIndex={-1} aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
                <path d="M320-200v-560l440 280-440 280Z" />
              </svg>
            </button>
            <p className="bn-inline-content">{render(b.content)}</p>
          </div>
        </div>
      );
      break;
    case "paragraph":
    case "bulletListItem":
    case undefined:
      body = <p className="bn-inline-content">{render(b.content)}</p>;
      break;
    default:
      // Databases, media, embeds, buttons, meetings…: hold their place.
      body = Array.isArray(b.content) && b.content.length ? <p className="bn-inline-content">{render(b.content)}</p> : <div className={b.type === "database" || b.type === "linkedDatabase" ? "nt-db-wait nt-db-wait-inline" : "nt-static-box"} />;
  }
  const kids = Array.isArray(b.children) && b.children.length && b.type !== "toggleListItem" ? b.children : null;
  return (
    <div className="bn-block-outer" data-node-type="blockOuter">
      <div className="bn-block" data-node-type="blockContainer">
        <div className="bn-block-content" {...attrs}>
          {body}
        </div>
        {kids && <Group blocks={kids} render={render} />}
      </div>
    </div>
  );
}

/** The page body, read-only, until the editor arrives. */
export function StaticBlocks({ content }: { content: unknown }) {
  const render = useInline();
  const blocks = Array.isArray(content) ? (content as Block[]) : [];
  return (
    <div className="nt-editor nt-static" aria-busy="true">
      <div className="bn-container">
        <div className="bn-editor">
          <Group blocks={blocks} render={render} />
        </div>
      </div>
    </div>
  );
}
