"use client";

// Settings for a Button block (Notion: name, icon, colour, and "When clicked"
// steps). Changes apply when the panel closes.

import { useMemo, useState } from "react";
import * as locales from "@blocknote/core/locales";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import { ArrowUpRight, CircleHelp, FilePlus2, Link2, Plus, Rows3, Smile, X } from "lucide-react";
import { notesSchema } from "./blocks";
import { useNotes } from "./context";
import { EmojiPicker } from "./EmojiPicker";
import { Popover } from "./ui";
import { PropIcon } from "./database/cells";
import { parseSteps, type ButtonStep, type ButtonValue } from "./button";
import { displayTitle } from "@/lib/notes/model";
import { NOTE_COLORS, type DbProperty, type Note } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { NoteIcon } from "./NoteIcon";
import { blockNoteLocale } from "./blocknote-locale";

type StepType = ButtonStep["type"];

const STEP_META: Record<StepType, { label: NotesKey; icon: React.ReactNode }> = {
  insert: { label: "button.step.insert", icon: <Rows3 /> },
  addPage: { label: "button.step.addPage", icon: <FilePlus2 /> },
  openPage: { label: "button.step.openPage", icon: <ArrowUpRight /> },
  openUrl: { label: "button.step.openUrl", icon: <Link2 /> },
  confirm: { label: "button.step.confirm", icon: <CircleHelp /> },
};

function newStep(type: StepType): ButtonStep {
  if (type === "insert") return { type, where: "below", blocks: [] };
  if (type === "addPage") return { type, dbId: "", title: "" };
  if (type === "openPage") return { type, noteId: "" };
  if (type === "openUrl") return { type, url: "" };
  return { type, text: "" };
}

/** Blocks a click inserts: a small editor of their own. */
function BlocksField({ value, onChange }: { value: unknown[]; onChange: (blocks: unknown[]) => void }) {
  const { t, locale } = useNotes();
  const dictionary = useMemo(() => {
    const base = blockNoteLocale(locale);
    return { ...base, placeholders: { ...base.placeholders, default: t("button.blocksPlaceholder"), emptyDocument: t("button.blocksPlaceholder") } } as typeof locales.en;
  }, [locale, t]);
  const editor = useCreateBlockNote({ schema: notesSchema, initialContent: value.length ? (value as never) : undefined, dictionary, animations: false });
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return (
    <div className="nt-btnedit-blocks nt-editor">
      <BlockNoteView
        editor={editor as never}
        theme={dark ? "dark" : "light"}
        sideMenu={false}
        onChange={() => {
          const doc = editor.document as unknown[];
          // A lone empty paragraph means "nothing to insert".
          const empty = doc.length === 1 && (doc[0] as { type?: string; content?: unknown[] }).type === "paragraph" && !(doc[0] as { content?: unknown[] }).content?.length;
          onChange(empty ? [] : doc);
        }}
      />
    </div>
  );
}

/** A database's settable properties (not computed, not files or relations). */
export const SETTABLE = new Set<DbProperty["type"]>(["text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "email", "phone"]);

export function ValueField({ prop, value, onChange }: { prop: DbProperty; value: ButtonValue | undefined; onChange: (v: ButtonValue | undefined) => void }) {
  const { t } = useNotes();
  if (prop.type === "checkbox") return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked ? true : undefined)} />;
  if (prop.type === "select" || prop.type === "status")
    return (
      <select className="nt-input nt-btnedit-select" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{t("button.notSet")}</option>
        {(prop.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  if (prop.type === "multi_select") {
    const set = new Set(Array.isArray(value) ? value : []);
    return (
      <div className="nt-btnedit-chips">
        {(prop.options ?? []).map((o) => (
          <button
            type="button"
            key={o.id}
            className="nt-tag nt-btn-reset"
            data-color={o.color}
            aria-pressed={set.has(o.id)}
            onClick={() => {
              const next = new Set(set);
              if (next.has(o.id)) next.delete(o.id);
              else next.add(o.id);
              onChange(next.size ? [...next] : undefined);
            }}
          >
            {o.name}
          </button>
        ))}
      </div>
    );
  }
  if (prop.type === "date")
    return (
      <select className="nt-input nt-btnedit-select" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{t("button.notSet")}</option>
        <option value="@today">{t("button.date.today")}</option>
        <option value="@tomorrow">{t("button.date.tomorrow")}</option>
        <option value="@week">{t("button.date.week")}</option>
      </select>
    );
  return (
    <input
      className="nt-input"
      type={prop.type === "number" ? "number" : "text"}
      value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
      placeholder={t("button.notSet")}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return onChange(undefined);
        onChange(prop.type === "number" ? (Number.isFinite(Number(v)) ? Number(v) : undefined) : v);
      }}
    />
  );
}

export function PagePicker({ value, onPick, filter, placeholder }: { value: string; onPick: (id: string) => void; filter: (n: Note) => boolean; placeholder: string }) {
  const { t, snap } = useNotes();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const current = value ? snap.byId.get(value) : undefined;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return snap.list.filter((n) => n.trashedAt === null && !n.template && filter(n) && (!s || n.title.toLowerCase().includes(s))).slice(0, 30);
  }, [snap.list, q, filter]);
  return (
    <>
      <button type="button" className="nt-btnedit-pick nt-btn-reset" onClick={(e) => setOpen(e.currentTarget)}>
        {current ? (
          <>
            <span className="nt-btnedit-pick-icon"><NoteIcon icon={current.icon} fallback="📄" /></span>
            {displayTitle(current, t("page.untitled"))}
          </>
        ) : (
          <span className="nt-btnedit-muted">{placeholder}</span>
        )}
      </button>
      {open && (
        <Popover anchor={open} onClose={() => setOpen(null)}>
          <div className="nt-btnedit-picker">
            <input className="nt-input" autoFocus value={q} placeholder={t("button.search")} onChange={(e) => setQ(e.target.value)} />
            <div className="nt-btnedit-picker-list">
              {list.length === 0 && <div className="nt-btnedit-muted" style={{ padding: "6px 8px" }}>{t("search.noResults")}</div>}
              {list.map((n) => (
                <button
                  type="button"
                  key={n.id}
                  className="nt-mi nt-btn-reset"
                  data-active={n.id === value || undefined}
                  onClick={() => {
                    onPick(n.id);
                    setOpen(null);
                  }}
                >
                  <span className="nt-mi-icon"><NoteIcon icon={n.icon} fallback="📄" /></span>
                  <span className="nt-mi-label">{displayTitle(n, t("page.untitled"))}</span>
                </button>
              ))}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

export const isDb = (n: Note) => n.kind === "database";
const anyPage = (n: Note) => n.kind === "page" || n.kind === "database";

function StepCard({ step, index, onChange, onRemove }: { step: ButtonStep; index: number; onChange: (s: ButtonStep) => void; onRemove: () => void }) {
  const { t, snap } = useNotes();
  const meta = STEP_META[step.type];
  let body: React.ReactNode = null;
  if (step.type === "insert") {
    body = (
      <>
        <div className="nt-btnedit-row">
          <select className="nt-input nt-btnedit-select" value={step.where} onChange={(e) => onChange({ ...step, where: e.target.value === "above" ? "above" : "below" })}>
            <option value="below">{t("button.below")}</option>
            <option value="above">{t("button.above")}</option>
          </select>
        </div>
        <BlocksField value={step.blocks} onChange={(blocks) => onChange({ ...step, blocks })} />
      </>
    );
  } else if (step.type === "addPage") {
    const db = step.dbId ? snap.byId.get(step.dbId) : undefined;
    const templates = db ? snap.list.filter((n) => n.parentId === db.id && n.template && n.trashedAt === null) : [];
    const props = (db?.db?.properties ?? []).filter((p) => SETTABLE.has(p.type));
    body = (
      <>
        <div className="nt-btnedit-row">
          <PagePicker value={step.dbId} filter={isDb} placeholder={t("button.pickDb")} onPick={(dbId) => onChange({ type: "addPage", dbId, title: step.title, open: step.open })} />
        </div>
        {db && (
          <>
            <label className="nt-btnedit-field">
              <span>{t("button.pageTitle")}</span>
              <input className="nt-input" value={step.title} placeholder={t("page.untitled")} onChange={(e) => onChange({ ...step, title: e.target.value })} />
            </label>
            {templates.length > 0 && (
              <label className="nt-btnedit-field">
                <span>{t("button.template")}</span>
                <select className="nt-input nt-btnedit-select" value={step.templateId ?? ""} onChange={(e) => onChange({ ...step, templateId: e.target.value || undefined })}>
                  <option value="">{t("button.noTemplate")}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {displayTitle(tpl, t("page.untitled"))}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {props.map((p) => (
              <div key={p.id} className="nt-btnedit-field">
                <span>
                  <PropIcon type={p.type} />
                  {p.name}
                </span>
                <ValueField
                  prop={p}
                  value={step.values?.[p.id]}
                  onChange={(v) => {
                    const values = { ...(step.values ?? {}) };
                    if (v === undefined) delete values[p.id];
                    else values[p.id] = v;
                    onChange({ ...step, values: Object.keys(values).length ? values : undefined });
                  }}
                />
              </div>
            ))}
            <label className="nt-btnedit-check">
              <input type="checkbox" checked={!!step.open} onChange={(e) => onChange({ ...step, open: e.target.checked || undefined })} />
              {t("button.openAfter")}
            </label>
          </>
        )}
      </>
    );
  } else if (step.type === "openPage") {
    body = (
      <div className="nt-btnedit-row">
        <PagePicker value={step.noteId} filter={anyPage} placeholder={t("button.pickPage")} onPick={(noteId) => onChange({ type: "openPage", noteId })} />
      </div>
    );
  } else if (step.type === "openUrl") {
    body = (
      <div className="nt-btnedit-row">
        <input className="nt-input" value={step.url} placeholder="https://…" onChange={(e) => onChange({ type: "openUrl", url: e.target.value })} />
      </div>
    );
  } else {
    body = (
      <div className="nt-btnedit-row">
        <input className="nt-input" value={step.text} placeholder={t("button.confirmDefault")} onChange={(e) => onChange({ type: "confirm", text: e.target.value })} />
      </div>
    );
  }
  return (
    <div className="nt-btnedit-step" data-step={step.type}>
      <div className="nt-btnedit-step-head">
        <span className="nt-btnedit-step-n">{index + 1}</span>
        <span className="nt-btnedit-step-icon">{meta.icon}</span>
        <span className="nt-btnedit-step-title">{t(meta.label)}</span>
        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("button.removeStep")} title={t("button.removeStep")} onClick={onRemove}>
          <X />
        </button>
      </div>
      {body}
    </div>
  );
}

export function ButtonEditor({
  anchor,
  block,
  editor,
  onClose,
}: {
  anchor: HTMLElement;
  block: { id: string; props: { label: string; icon: string; color: string; actions: string } };
  editor: { updateBlock: (id: string, update: { props: Record<string, string> }) => unknown; getBlock: (id: string) => unknown };
  onClose: () => void;
}) {
  const { t } = useNotes();
  const [label, setLabel] = useState(block.props.label);
  const [icon, setIcon] = useState(block.props.icon);
  const [color, setColor] = useState(block.props.color || "default");
  const [steps, setSteps] = useState(() => parseSteps(block.props.actions).map((s, k) => ({ k, s })));
  const [iconPop, setIconPop] = useState<HTMLElement | null>(null);
  const [addPop, setAddPop] = useState<HTMLElement | null>(null);
  const save = () => {
    // The block may be gone (deleted while the panel was open).
    if (editor.getBlock(block.id)) {
      const actions = JSON.stringify(steps.map((x) => x.s).filter((s) => s.type !== "addPage" || s.dbId));
      editor.updateBlock(block.id, { props: { label: label.trim(), icon, color, actions } });
    }
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={save} className="nt-btnedit-pop">
      <div className="nt-btnedit">
        <div className="nt-btnedit-head">
          <button type="button" className="nt-btnedit-iconbtn nt-btn-reset" aria-label={t("button.icon")} title={t("button.icon")} onClick={(e) => setIconPop(e.currentTarget)}>
            <NoteIcon icon={icon} fallback={<Smile />} />
          </button>
          <input
            className="nt-input"
            autoFocus
            value={label}
            maxLength={200}
            placeholder={t("button.new")}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </div>
        <div className="nt-btnedit-colors" role="radiogroup" aria-label={t("button.color")}>
          {NOTE_COLORS.map((c) => (
            <button type="button" key={c} role="radio" className="nt-btnedit-color nt-btn-reset" data-color={c} aria-checked={color === c} title={t(`color.${c}`)} onClick={() => setColor(c)} />
          ))}
        </div>
        <div className="nt-menu-label">{t("button.whenClicked")}</div>
        {steps.map((x, i) => (
          <StepCard
            key={x.k}
            index={i}
            step={x.s}
            onChange={(s) => setSteps((list) => list.map((y) => (y.k === x.k ? { k: y.k, s } : y)))}
            onRemove={() => setSteps((list) => list.filter((y) => y.k !== x.k))}
          />
        ))}
        {steps.length < 12 && (
          <button type="button" className="nt-mi nt-btn-reset nt-btnedit-add" onClick={(e) => setAddPop(e.currentTarget)}>
            <span className="nt-mi-icon">
              <Plus />
            </span>
            <span className="nt-mi-label">{steps.length ? t("button.addAnother") : t("button.addStep")}</span>
          </button>
        )}
        <div className="nt-btnedit-foot">
          <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" onClick={save}>
            {t("button.done")}
          </button>
        </div>
      </div>
      {addPop && (
        <Popover anchor={addPop} onClose={() => setAddPop(null)}>
          <div className="nt-menu" style={{ width: 240 }}>
            {(Object.keys(STEP_META) as StepType[]).map((type) => (
              <button
                type="button"
                key={type}
                className="nt-mi nt-btn-reset"
                onClick={() => {
                  setSteps((list) => [...list, { k: Math.max(-1, ...list.map((y) => y.k)) + 1, s: newStep(type) }]);
                  setAddPop(null);
                }}
              >
                <span className="nt-mi-icon">{STEP_META[type].icon}</span>
                <span className="nt-mi-label">{t(STEP_META[type].label)}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
      {iconPop && (
        <Popover anchor={iconPop} onClose={() => setIconPop(null)}>
          <EmojiPicker
            onPick={(e) => {
              setIcon(e);
              setIconPop(null);
            }}
            onRemove={() => {
              setIcon("");
              setIconPop(null);
            }}
          />
        </Popover>
      )}
    </Popover>
  );
}
