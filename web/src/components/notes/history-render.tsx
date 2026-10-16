"use client";

// Page history highlights (Notion's "Highlight changes"): a version shown
// with what it changed — added text marked, removed text struck through,
// blocks that changed otherwise (a checked to-do, a new heading level)
// flagged in the margin. Shared by Page history and Updates.

import { Fragment, type ReactNode } from "react";
import type { NotesApi } from "./context";
import { diffBlocks, diffWords, type BlockDiff, type FlatBlock, type WordOp } from "@/lib/notes/diff";
import { valueText } from "@/lib/notes/db";
import { personName } from "@/lib/notes/people";
import type { DbProperty, Note } from "@/lib/notes/types";
import { intlOf } from "@/i18n/locales";

/** Who made a version, for people: their name, or what wrote it. */
export function whoName(t: NotesApi["t"], by: string | null | undefined, names: Record<string, string> = {}): string {
  if (!by) return t("history.someone");
  if (by === "form") return t("history.form");
  if (by.startsWith("automation:")) return t("history.automation");
  return names[by] || personName(by) || t("history.someone");
}

export function Avatar({ name }: { name: string }) {
  return <span className="nt-cm-avatar">{(name || "?").trim().charAt(0).toUpperCase()}</span>;
}

/** "Today" / "Yesterday" / a date: the heading of a group of versions or updates. */
export function dayLabel(t: NotesApi["t"], locale: string, at: number, now = Date.now()): string {
  const day = (x: number) => {
    const d = new Date(x);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff === 0) return t("history.today");
  if (diff === 1) return t("history.yesterday");
  return new Date(at).toLocaleDateString(intlOf(locale), { day: "numeric", month: "long", ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

export function timeLabel(locale: string, at: number): string {
  return new Date(at).toLocaleTimeString(intlOf(locale), { hour: "numeric", minute: "2-digit" });
}

function Words({ ops }: { ops: WordOp[] }) {
  return (
    <>
      {ops.map((w, i) => (w.op === "add" ? <ins key={i} className="nt-hist-add">{w.text}</ins> : w.op === "del" ? <del key={i} className="nt-hist-del">{w.text}</del> : <Fragment key={i}>{w.text}</Fragment>))}
    </>
  );
}

/** One block of a version, as the page reads it (text only), with its highlights. */
function BlockLine({ d, api }: { d: BlockDiff; api: NotesApi }) {
  const b: FlatBlock = d.block;
  const text: ReactNode = d.words ? <Words ops={d.words} /> : d.status === "added" ? <ins className="nt-hist-add">{b.text}</ins> : d.status === "removed" ? <del className="nt-hist-del">{b.text}</del> : b.text;
  const style = b.depth ? { marginInlineStart: b.depth * 24 } : undefined;
  const attrs = { "data-status": d.status === "same" ? undefined : d.status, style, className: "nt-hist-block" };
  const level = Number(b.props.level) || 1;
  switch (b.type) {
    case "heading":
      return level === 1 ? <h1 {...attrs}>{text}</h1> : level === 2 ? <h2 {...attrs}>{text}</h2> : <h3 {...attrs}>{text}</h3>;
    case "bulletListItem":
      return (
        <ul {...attrs}>
          <li>{text}</li>
        </ul>
      );
    case "numberedListItem":
      return (
        <ol {...attrs}>
          <li>{text}</li>
        </ol>
      );
    case "checkListItem":
      return (
        <p {...attrs}>
          <span className="nt-hist-check" data-on={b.props.checked === true || undefined} aria-hidden />
          {text}
        </p>
      );
    case "toggleListItem":
      return (
        <p {...attrs}>
          <span aria-hidden>▸ </span>
          {text}
        </p>
      );
    case "quote":
      return <blockquote {...attrs}>{text}</blockquote>;
    case "codeBlock":
      return (
        <pre {...attrs}>
          <code>{text}</code>
        </pre>
      );
    case "divider":
      return <hr {...attrs} />;
    case "page":
    case "database": {
      const linked = typeof b.props.noteId === "string" ? api.snap.byId.get(b.props.noteId) : undefined;
      return <p {...attrs}>{`${b.type === "database" ? "▦" : "📄"} ${linked?.title || (b.type === "database" ? api.t("db.untitled") : api.t("page.untitled"))}`}</p>;
    }
    case "image":
    case "video":
    case "audio":
    case "file":
      return <p {...attrs}>{b.text ? text : `[${b.type}]`}</p>;
    case "toc":
    case "breadcrumb":
    case "columnList":
    case "column":
    case "tabs":
      return null;
    case "tab":
      return typeof b.props?.title === "string" && b.props.title ? <p {...attrs}><b>{b.props.title}</b></p> : null;
    default:
      return <p {...attrs}>{text}</p>;
  }
}

/** A row's properties, those changed since `before` highlighted (`before` null: none is). */
function PropChanges({ before, after, schema, api }: { before: Note | null; after: Note; schema: DbProperty[]; api: NotesApi }) {
  const rows = schema
    .filter((p) => p.type !== "title")
    .map((p) => {
      const now = valueText(p, after.props?.[p.id] ?? null, api.locale);
      const was = before ? valueText(p, before.props?.[p.id] ?? null, api.locale) : now;
      return { p, was, now };
    })
    .filter((x) => x.was || x.now);
  if (!rows.length) return null;
  return (
    <div className="nt-hist-props">
      {rows.map(({ p, was, now }) => (
        <p key={p.id} className="nt-hist-block" data-status={was !== now ? "changed" : undefined}>
          <span className="nt-hist-prop">{p.name}</span>
          {was !== now ? <Words ops={diffWords(was, now)} /> : now}
        </p>
      ))}
    </div>
  );
}

/** A database's properties (its schema) that differ between two versions. */
function SchemaChanges({ before, after, api }: { before: Note | null; after: Note; api: NotesApi }) {
  const was = new Map((before?.db?.properties ?? []).map((p) => [p.id, p]));
  const now = new Map((after.db?.properties ?? []).map((p) => [p.id, p]));
  const typeName = (p: DbProperty) => api.t(`prop.${p.type}` as never);
  const rows: ReactNode[] = [];
  for (const p of now.values()) {
    const o = was.get(p.id);
    if (!o) rows.push(<p key={p.id} className="nt-hist-block" data-status="added"><ins className="nt-hist-add">{p.name}</ins> · {typeName(p)}</p>);
    else if (o.name !== p.name || o.type !== p.type)
      rows.push(
        <p key={p.id} className="nt-hist-block" data-status="changed">
          <Words ops={diffWords(o.name, p.name)} /> · {o.type !== p.type ? <Words ops={diffWords(typeName(o), typeName(p))} /> : typeName(p)}
        </p>
      );
    else rows.push(<p key={p.id} className="nt-hist-block">{p.name} · {typeName(p)}</p>);
  }
  for (const o of was.values()) if (!now.has(o.id)) rows.push(<p key={o.id} className="nt-hist-block" data-status="removed"><del className="nt-hist-del">{o.name}</del> · {typeName(o)}</p>);
  return (
    <div className="nt-hist-props">
      <h3>{api.t("history.schema")}</h3>
      {rows}
    </div>
  );
}

/**
 * A version (`after`) with what it changed since `before` (the version
 * before it; null for the earliest: nothing is highlighted). `highlight`
 * off: the version as it reads.
 */
export function VersionDiff({ before, after, highlight, api }: { before: Note | null; after: Note; highlight: boolean; api: NotesApi }) {
  const base = highlight ? before : null;
  const blocks = diffBlocks(highlight && before ? before.content : after.content, after.content);
  const parent = after.parentId ? api.snap.byId.get(after.parentId) : undefined;
  const untitled = after.kind === "database" ? api.t("db.untitled") : api.t("page.untitled");
  return (
    <>
      <h1 className="nt-hist-title">{base && base.title !== after.title ? <Words ops={diffWords(base.title, after.title)} /> : after.title || untitled}</h1>
      {parent?.kind === "database" && parent.db && <PropChanges before={base} after={after} schema={parent.db.properties} api={api} />}
      {after.kind === "database" && <SchemaChanges before={base ?? after} after={after} api={api} />}
      {blocks.map((d, i) => (
        <BlockLine key={`${d.status}:${d.block.id ?? i}`} d={d} api={api} />
      ))}
    </>
  );
}
