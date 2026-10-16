"use client";

// zvena Documents: Notion's Button block. A button runs its steps in order:
// insert blocks next to it, add a page to a database (optionally from a
// template, with preset properties), open a page or a link, or ask for a
// confirmation first. The settings panel lives in ButtonEditor (loaded on use).

import { Suspense, lazy, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { Settings2 } from "lucide-react";
import { ReadOnlyContext, useNotesMaybe, type NotesApi } from "./context";
import { toast } from "./ui";
import { resolveValues } from "@/lib/notes/automations";
import { displayTitle, withoutBlockIds } from "@/lib/notes/model";
import type { PropValue } from "@/lib/notes/types";
import { NoteIcon } from "./NoteIcon";

export type ButtonStep =
  | { type: "insert"; where: "below" | "above"; blocks: unknown[] }
  | { type: "addPage"; dbId: string; title: string; templateId?: string; open?: boolean; values?: Record<string, ButtonValue> }
  | { type: "openPage"; noteId: string }
  | { type: "openUrl"; url: string }
  | { type: "confirm"; text: string };

/** A preset property value; dates may be relative ("@today", "@tomorrow", "@week"). */
export type ButtonValue = PropValue;

export const BUTTON_STEP_TYPES = ["insert", "addPage", "openPage", "openUrl", "confirm"] as const;
const MAX_STEPS = 12;

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");

/** Steps from the block's `actions` prop (JSON); anything malformed is dropped. */
export function parseSteps(raw: string): ButtonStep[] {
  let list: unknown;
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: ButtonStep[] = [];
  for (const r of list.slice(0, MAX_STEPS)) {
    const s = r as Record<string, unknown>;
    if (!s || typeof s !== "object") continue;
    if (s.type === "insert") out.push({ type: "insert", where: s.where === "above" ? "above" : "below", blocks: Array.isArray(s.blocks) ? s.blocks.slice(0, 200) : [] });
    else if (s.type === "addPage" && typeof s.dbId === "string") {
      const values = s.values && typeof s.values === "object" && !Array.isArray(s.values) ? (s.values as Record<string, ButtonValue>) : undefined;
      out.push({ type: "addPage", dbId: s.dbId, title: str(s.title), ...(typeof s.templateId === "string" && s.templateId ? { templateId: s.templateId } : {}), ...(s.open ? { open: true } : {}), ...(values ? { values } : {}) });
    } else if (s.type === "openPage" && typeof s.noteId === "string") out.push({ type: "openPage", noteId: s.noteId });
    else if (s.type === "openUrl") out.push({ type: "openUrl", url: str(s.url) });
    else if (s.type === "confirm") out.push({ type: "confirm", text: str(s.text, 300) });
  }
  return out;
}

/** http(s) and mailto links only; a bare domain becomes https. */
export function buttonUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}


/** Runs the steps; stops when a confirmation is declined. */
function runSteps(steps: ButtonStep[], ctx: NotesApi, insert: (blocks: unknown[], where: "below" | "above") => void) {
  const { t, store } = ctx;
  for (const s of steps) {
    if (s.type === "confirm") {
      if (!window.confirm(s.text.trim() || t("button.confirmDefault"))) return;
    } else if (s.type === "insert") {
      if (s.blocks.length) insert(withoutBlockIds(s.blocks), s.where);
    } else if (s.type === "addPage") {
      const db = store.get(s.dbId);
      if (!db || db.kind !== "database" || db.trashedAt !== null) {
        toast(t("button.dbMissing"));
        continue;
      }
      const tpl = s.templateId ? store.get(s.templateId) : undefined;
      const fromTpl = tpl && tpl.parentId === db.id && tpl.trashedAt === null ? tpl : undefined;
      // Unique IDs are numbered afresh; the template's other values come first, the button's on top.
      const tplProps = Object.fromEntries(Object.entries(fromTpl?.props ?? {}).filter(([k]) => db.db?.properties.find((p) => p.id === k)?.type !== "unique_id"));
      const props = { ...tplProps, ...resolveValues(s.values, db.db) };
      const row = ctx.newRow(db.id, { title: s.title.trim() || fromTpl?.title || "", props, stay: true });
      if (fromTpl) store.update(row.id, { icon: fromTpl.icon, cover: fromTpl.cover, content: structuredClone(fromTpl.content) });
      if (s.open) ctx.open(row.id, { peek: true });
      else toast(t("button.added", { db: displayTitle(db, t("db.untitled")) }), { label: t("button.openRow"), run: () => ctx.open(row.id, { peek: true }) });
    } else if (s.type === "openPage") {
      if (store.get(s.noteId)) ctx.open(s.noteId);
    } else if (s.type === "openUrl") {
      const url = buttonUrl(s.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    }
  }
}

/** Buttons inserted from the "/" menu open their settings at once (Notion). */
const fresh = new Set<string>();
export function markFreshButton(id: string) {
  fresh.add(id);
}

const ButtonEditor = lazy(() => import("./ButtonEditor").then((m) => ({ default: m.ButtonEditor })));

interface ButtonBlockProps {
  label: string;
  icon: string;
  color: string;
  actions: string;
}

export const ButtonBlock = createReactBlockSpec(
  {
    type: "button",
    propSchema: { label: { default: "" }, icon: { default: "" }, color: { default: "default" }, actions: { default: "[]" } },
    content: "none",
  },
  {
    // Clicks run the button; ProseMirror must not select the block instead.
    meta: { selectable: false },
    render: function ButtonRender(props) {
      const p = props.block.props as ButtonBlockProps;
      const ctx = useNotesMaybe();
      const ro = useContext(ReadOnlyContext);
      // Public pages, viewers and commenters: only links work. Settings need
      // an editable page (not a locked one).
      const readOnly = ro.readOnly || !ctx || ctx.readOnly;
      const canEdit = !readOnly && props.editor.isEditable;
      const steps = useMemo(() => parseSteps(p.actions), [p.actions]);
      const [edit, setEdit] = useState<HTMLElement | null>(null);
      const wrap = useRef<HTMLDivElement>(null);
      const id = props.block.id;
      useEffect(() => {
        if (!fresh.has(id) || !wrap.current) return;
        fresh.delete(id);
        // Opens once, right after the block mounts.
        setEdit(wrap.current);
      }, [id]);
      const t = ctx?.t;
      const label = p.label || (t ? t("button.new") : "New button");
      // Public pages: only links work.
      const linksOnly = steps.length > 0 && steps.every((s) => s.type === "openUrl" || s.type === "openPage");
      const click = () => {
        if (readOnly) {
          if (!linksOnly) return;
          for (const s of steps) {
            if (s.type === "openPage") {
              if (ctx) {
                if (ctx.store.get(s.noteId)) ctx.open(s.noteId);
              } else if (ro.notes?.has(s.noteId)) ro.openPublic?.(s.noteId);
            }
            const url = s.type === "openUrl" ? buttonUrl(s.url) : null;
            if (url) window.open(url, "_blank", "noopener,noreferrer");
          }
          return;
        }
        if (!steps.length) {
          if (props.editor.isEditable) setEdit(wrap.current);
          return;
        }
        runSteps(steps, ctx, (blocks, where) => {
          // A locked page keeps its blocks; the button's other steps still run.
          if (!props.editor.isEditable) return;
          const editor = props.editor as unknown as { insertBlocks: (b: never, ref: string, where: "before" | "after") => unknown };
          editor.insertBlocks(blocks as never, id, where === "above" ? "before" : "after");
        });
      };
      return (
        <div className="nt-btnblock" ref={wrap} contentEditable={false}>
          <button
            type="button"
            className="nt-btnblock-btn nt-btn-reset"
            data-color={p.color !== "default" ? p.color : undefined}
            data-disabled={(readOnly && !linksOnly) || undefined}
            title={readOnly && !linksOnly ? (t ? t("button.readOnly") : undefined) : undefined}
            onClick={click}
          >
            {p.icon && <span className="nt-btnblock-icon"><NoteIcon icon={p.icon} /></span>}
            <span>{label}</span>
          </button>
          {canEdit && (
            <button type="button" className="nt-btnblock-edit nt-btn-reset" aria-label={t?.("button.edit")} title={t?.("button.edit")} onClick={(e) => setEdit(e.currentTarget.parentElement)}>
              <Settings2 />
            </button>
          )}
          {edit && canEdit && (
            <Suspense fallback={null}>
              <ButtonEditor anchor={edit} block={{ id, props: p }} editor={props.editor as never} onClose={() => setEdit(null)} />
            </Suspense>
          )}
        </div>
      );
    },
  }
);
