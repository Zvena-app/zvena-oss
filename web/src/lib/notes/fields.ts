// zvena Documents: field-level merge of a note (Notion merges per property).
// A device names the fields it changed since its last confirmed push
// ("title", "content", "props.<property id>", …); the server applies only
// those to the stored note, and a device applies a server copy around its
// own unsent fields. Two people editing different cells of one row, or the
// title and the icon of one page, both keep their change.

import type { Note } from "./types";

/** Fields a device may name (anything else makes the push a whole-note write). */
const TOP = new Set(["title", "icon", "cover", "content", "db", "props", "inline", "order", "parentId", "trashedAt", "style", "template", "synced", "space", "comments", "share", "ysnap", "kind"]);
const FIELD_RE = /^(?:[a-zA-Z]{2,12}|props\.[\w-]{1,40})$/;

/** The fields a push names, or null for a whole-note write (old devices, "*", anything unknown). */
export function cleanFields(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 250) return null;
  const out: string[] = [];
  for (const f of v) {
    if (typeof f !== "string" || !FIELD_RE.test(f)) return null;
    if (!f.startsWith("props.") && !TOP.has(f)) return null;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** The fields a local patch changes (`props` per property; updatedAt and favorites are not fields). */
export function patchFields(cur: Note, patch: Partial<Note>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(patch) as (keyof Note)[]) {
    if (k === "updatedAt" || k === "favorite" || k === "id" || k === "computed" || k === "access") continue;
    if (k === "props") {
      const a = cur.props ?? {};
      const b = patch.props ?? {};
      for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[p] ?? null) !== JSON.stringify(b[p] ?? null)) out.push(`props.${p}`);
      continue;
    }
    if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(patch[k] ?? null)) out.push(k);
  }
  return out;
}

/** `base` with `fields` taken from `from` (props per property). */
export function withFields(base: Note, from: Note, fields: readonly string[]): Note {
  const out = { ...base } as Record<string, unknown>;
  let props = base.props ? { ...base.props } : undefined;
  for (const f of fields) {
    if (f.startsWith("props.")) {
      const k = f.slice(6);
      props ??= {};
      if (from.props && k in from.props) props[k] = from.props[k];
      else delete props[k];
    } else if (f === "props") {
      props = from.props ? { ...from.props } : undefined;
    } else if (TOP.has(f)) {
      const v = (from as unknown as Record<string, unknown>)[f];
      if (v === undefined) delete out[f];
      else out[f] = v;
    }
  }
  if (props) out.props = props;
  else delete out.props;
  out.updatedAt = Math.max(base.updatedAt, from.updatedAt);
  return out as unknown as Note;
}
