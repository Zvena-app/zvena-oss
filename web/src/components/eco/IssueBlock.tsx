"use client";

// An issue inside a document: not a copy, the issue itself. Its status,
// title and assignee are live (change them in Projects and the page shows
// it at once); its checkbox moves the issue through its team's workflow.
//
// The block keeps only ids. "/issue" inserts an empty one that asks for a
// title (or links an existing issue); "Turn into issue" on any line makes the
// line an issue in one step (`turnIntoIssue`).

import { useContext, useEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { CircleDashed, Link2, Plus } from "lucide-react";
import { inlineText } from "@/lib/notes/model";
import { currentWorkspace } from "@/lib/notes/workspace";
import { PageIdContext, ReadOnlyContext, useNotesMaybe } from "@/components/notes/context";
import type { Card } from "@/lib/eco/types";
import { cardStore, eco, EcoHttpError, keepTextSelection, useCard } from "./client";
import { CardView } from "./CardView";
import { useEt } from "./i18n";
import { LinkPopover } from "./Related";
import "./eco.css";

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function LiveIssue({ ws, issueId, editable }: { ws: string; issueId: string; editable: boolean }) {
  const card = useCard(ws, `issue:${issueId}`);
  const [busy, setBusy] = useState(false);
  const toggle = async (done: boolean) => {
    setBusy(true);
    try {
      const { card: next } = await eco.issueDone(ws, issueId, done);
      cardStore(ws).seed([next]);
    } catch {
      // Not allowed or offline: the card shows the issue as it is.
    } finally {
      setBusy(false);
    }
  };
  return <CardView card={card} variant="block" onToggle={editable ? (d) => void toggle(d) : undefined} busy={busy} />;
}

function NewIssue({ ws, pageId, onDone }: { ws: string; pageId: string | null; onDone: (c: Card) => void }) {
  const et = useEt();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const create = async () => {
    const t = title.trim();
    if (!t || !pageId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { card } = await eco.issueFromDoc(ws, { note: pageId, title: t });
      cardStore(ws).seed([card]);
      onDone(card);
    } catch (e) {
      setError(e instanceof EcoHttpError && e.status === 403 ? et("noAccess") : et("failed"));
      setBusy(false);
    }
  };
  return (
    <div className="eco-root" contentEditable={false} style={{ width: "100%" }}>
      <div className="eco-new-issue">
        <CircleDashed size={16} />
        <input
          ref={input}
          autoFocus
          value={title}
          placeholder={et("issueNew")}
          aria-label={et("issueNew")}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            // Keys typed here belong to the field, not to the page around it.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
        />
        <button type="button" className="eco-btn eco-btn-primary" disabled={!title.trim() || busy} onClick={() => void create()}>
          <Plus size={14} />
          {et("issueCreate")}
        </button>
        <button type="button" className="eco-icon-btn" title={et("issuePick")} aria-label={et("issuePick")} onClick={(e) => setPicker(e.currentTarget)}>
          <Link2 size={15} />
        </button>
      </div>
      {error && <div className="eco-related-note">{error}</div>}
      {picker && (
        <LinkPopover
          ws={ws}
          anchor={picker}
          exclude={[]}
          kinds={["issue"]}
          onPick={(c) => {
            setPicker(null);
            onDone(c);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

export const IssueBlock = createReactBlockSpec(
  {
    type: "issue",
    propSchema: {
      issueId: { default: "" },
      // The identifier when it was placed (shown where the issue cannot be read: a public page).
      ident: { default: "" },
    },
    content: "none",
  },
  {
    render: function IssueRender(props) {
      const et = useEt();
      const { issueId, ident } = props.block.props;
      const ro = useContext(ReadOnlyContext);
      const pageId = useContext(PageIdContext);
      const ctx = useNotesMaybe();
      const ws = ctx?.user ? currentWorkspace() : "";
      const editable = props.editor.isEditable && !ro.readOnly;
      if (!ws) {
        // A public page or a guest's documents: issues are never published through a page.
        return (
          <div className="eco-card eco-block eco-missing" contentEditable={false}>
            <CircleDashed size={14} />
            <span>{ident || et("issues")}</span>
          </div>
        );
      }
      if (!issueId || !ID_RE.test(issueId)) {
        if (!editable) return null;
        return (
          <NewIssue
            ws={ws}
            pageId={pageId}
            onDone={(c) => props.editor.updateBlock(props.block, { props: { issueId: c.key.slice("issue:".length), ident: c.sub ?? "" } })}
          />
        );
      }
      return (
        <div className="eco-root" style={{ width: "100%" }} onMouseDownCapture={keepTextSelection}>
          <LiveIssue ws={ws} issueId={issueId} editable={editable} />
        </div>
      );
    },
    // Copied out of the page (Markdown, plain text): the issue's identifier.
    toExternalHTML: function IssueHTML(props) {
      return <p>{props.block.props.ident || "Issue"}</p>;
    },
  }
);

interface BlockLike {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown[];
}

interface EditorLike {
  replaceBlocks(remove: unknown[], insert: unknown[]): unknown;
  getBlock?(id: string): BlockLike | undefined;
  insertBlocks(blocks: unknown[], ref: unknown, placement: "before" | "after"): unknown;
}

/**
 * A line of a page becomes an issue: its text is the title, a checked to-do
 * becomes a done issue, nested lines stay right under it.
 */
export async function turnIntoIssue(editor: EditorLike, picked: BlockLike, pageId: string): Promise<Card> {
  // The line as it is now (a menu opened before a to-do was ticked holds the old copy).
  const block = editor.getBlock?.(picked.id) ?? picked;
  const ws = currentWorkspace();
  const title = inlineText(block.content).replace(/\s+/g, " ").trim();
  if (!ws || !title) throw new EcoHttpError(400, "empty");
  const { card } = await eco.issueFromDoc(ws, { note: pageId, title });
  let next = card;
  if (block.type === "checkListItem" && block.props?.checked === true) next = (await eco.issueDone(ws, card.key.slice("issue:".length), true)).card;
  cardStore(ws).seed([next]);
  const issueBlock = { type: "issue", props: { issueId: card.key.slice("issue:".length), ident: card.sub ?? "" } };
  editor.replaceBlocks([block], [issueBlock, ...(block.children ?? [])]);
  return next;
}

interface DocConversion {
  blockId: string;
  issueId: string;
  ident: string;
}

async function conversions(ws: string, path: string, body?: unknown): Promise<DocConversion[]> {
  const res = await fetch(`/api/projects/${path}${path.includes("?") ? "&" : "?"}ws=${encodeURIComponent(ws)}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return [];
  return ((await res.json()) as { lines?: DocConversion[] }).lines ?? [];
}

/**
 * "Goals from a document" in Projects made issues of this page's task lines;
 * the page is co-edited, so the editor that opens it swaps those lines for
 * live issue blocks (the server hands each line to one editor only). From
 * then on the lines tick themselves as the issues close.
 */
export function useDocConversions(editor: EditorLike & { getBlock(id: string): unknown }, pageId: string, editable: boolean): void {
  useEffect(() => {
    const ws = currentWorkspace();
    if (!editable || !ws || !ID_RE.test(pageId)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: DocConversion[] | null = null;
    let tries = 0;
    const step = async () => {
      if (!alive) return;
      try {
        pending ??= await conversions(ws, `doc-conversions?note=${encodeURIComponent(pageId)}`);
        // The page's blocks arrive with the co-editing sync: wait until the lines are there.
        const here = pending.filter((p) => editor.getBlock(p.blockId));
        if (here.length) {
          const mine = await conversions(ws, "doc-conversions/claim", { note: pageId, blocks: here.map((p) => p.blockId) });
          for (const c of mine) {
            const b = editor.getBlock(c.blockId) as BlockLike | undefined;
            if (alive && b) editor.replaceBlocks([b], [{ type: "issue", props: { issueId: c.issueId, ident: c.ident } }, ...(b.children ?? [])]);
          }
          pending = pending.filter((p) => !here.includes(p));
        }
      } catch {
        // Offline: the lines wait for the next time the page opens.
        return;
      }
      if (alive && pending.length && ++tries < 40) timer = setTimeout(() => void step(), 750);
    };
    timer = setTimeout(() => void step(), 400);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [editor, pageId, editable]);
}
