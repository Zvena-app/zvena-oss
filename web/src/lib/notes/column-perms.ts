// zvena Documents: column permissions (Notion) — per database property, who
// may see its values and who may change them. A property's `perms.view`
// lists who sees it, `perms.edit` who edits it (user ids, "group:<id>",
// "integration:<id>"); a list left out means everyone with access to the
// database. People with full access to the database always may.
//
// Enforced on the server only (pure functions; lib/notes/server-store.ts
// and the API call them):
//   - a pull strips the values a person may not see from rows and marks the
//     property in the database's schema (`denied`), so cells show a lock;
//   - a push keeps the stored value of every property the person may not
//     change (whole-note pushes and per-field pushes alike);
//   - a schema push by someone without full access cannot add, change or
//     drop permissions, nor change or drop a protected property;
//   - a formula or rollup that reads a property the person may not see is
//     hidden from them too (it shows as restricted): its value would tell
//     what the hidden property holds, and computed from what they may see
//     it would be wrong. Notion shows such values as restricted, never
//     computed from data the reader cannot open.

import { compileFormula, findProp } from "./compute";
import { FormulaError, type FNode } from "./formula";
import type { DbProperty, DbSchema, Note, PropValue } from "./types";

/** Another database a relation points at, as the person sees it (its schema and what they may not see there). */
export type OtherColumns = (dbId: string) => { schema: DbSchema; denied: ReadonlyMap<string, "view" | "edit"> } | undefined;

export interface Who {
  /** User id, or "integration:<id>". */
  id: string;
  groups: ReadonlySet<string>;
  /** Full access to the database: every column is theirs. */
  full: boolean;
}

export interface ColumnRule {
  view: boolean;
  edit: boolean;
}

function named(list: readonly string[], who: Who): boolean {
  for (const p of list) {
    if (p === who.id) return true;
    if (p.startsWith("group:") && who.groups.has(p.slice(6))) return true;
  }
  return false;
}

/** What the person may do with one property's values. */
export function columnRule(prop: DbProperty, who: Who): ColumnRule {
  if (who.full || !prop.perms) return { view: true, edit: true };
  const view = !prop.perms.view || named(prop.perms.view, who);
  const edit = view && (!prop.perms.edit || named(prop.perms.edit, who));
  return { view, edit };
}

/**
 * The properties of a schema the person may not see or not edit (only
 * those), with the formulas and rollups that read a hidden one (`others`:
 * the related databases, for rollups and formulas over relations).
 */
export function deniedColumns(schema: DbSchema | undefined, who: Who, others?: OtherColumns): Map<string, "view" | "edit"> {
  const out = new Map<string, "view" | "edit">();
  for (const p of schema?.properties ?? []) {
    if (!p.perms) continue;
    const r = columnRule(p, who);
    if (!r.view) out.set(p.id, "view");
    else if (!r.edit) out.set(p.id, "edit");
  }
  if (schema) hideComputed(schema, out, others);
  return out;
}

/** Every property name a formula reads: prop("X"), and x.prop("X") on related rows. */
function propNames(node: FNode, out = new Set<string>()): Set<string> {
  if (node.t === "call") {
    if (node.name === "prop") for (const a of node.args) if (a.t === "str") out.add(a.v);
    node.args.forEach((a) => propNames(a, out));
  } else if (node.t === "list") node.items.forEach((x) => propNames(x, out));
  else if (node.t === "un") propNames(node.x, out);
  else if (node.t === "bin") [node.a, node.b].forEach((x) => propNames(x, out));
  else if (node.t === "cond") [node.c, node.a, node.b].forEach((x) => propNames(x, out));
  return out;
}

/** Properties a formula reads, by id (its own database's; names it does not know are left to `foreign`). */
function formulaReads(schema: DbSchema, p: DbProperty): { own: string[]; foreign: string[] } {
  const ast = p.formula ? compileFormula(p.formula.expr) : null;
  if (!ast || ast instanceof FormulaError) return { own: [], foreign: [] };
  const own: string[] = [];
  const foreign: string[] = [];
  for (const name of propNames(ast)) {
    const hit = findProp(schema, name);
    if (hit) own.push(hit.id);
    else foreign.push(name);
  }
  return { own, foreign };
}

/** Marks (in `denied`) every formula and rollup that reads, directly or through others, a property hidden from the person. */
function hideComputed(schema: DbSchema, denied: Map<string, "view" | "edit">, others?: OtherColumns): void {
  const computed = schema.properties.filter((p) => (p.type === "formula" && p.formula) || (p.type === "rollup" && p.rollup));
  if (!computed.length) return;
  const hidden = (id: string) => denied.get(id) === "view";
  const hiddenThere = (relationId: string, test: (schema: DbSchema, denied: ReadonlyMap<string, "view" | "edit">) => boolean) => {
    const rel = schema.properties.find((x) => x.id === relationId && x.type === "relation");
    const other = rel?.relation ? others?.(rel.relation.dbId) : undefined;
    return other ? test(other.schema, other.denied) : false;
  };
  const reads = new Map(computed.filter((p) => p.type === "formula").map((p) => [p.id, formulaReads(schema, p)]));
  for (let changed = true, round = 0; changed && round < 50; round++) {
    changed = false;
    for (const p of computed) {
      if (hidden(p.id)) continue;
      let hide = false;
      if (p.type === "rollup" && p.rollup) {
        const r = p.rollup;
        hide = hidden(r.relationPropId) || hiddenThere(r.relationPropId, (_s, d) => d.get(r.targetPropId) === "view");
      } else {
        const f = reads.get(p.id) ?? { own: [], foreign: [] };
        hide = f.own.some(hidden);
        // A formula over a relation (prop("Tasks").map(current.prop("Cost"))) reads the related database's properties.
        if (!hide && f.foreign.length) {
          for (const id of f.own) {
            if (hiddenThere(id, (s, d) => f.foreign.some((name) => { const x = findProp(s, name); return Boolean(x && d.get(x.id) === "view"); }))) hide = true;
          }
        }
      }
      if (hide) {
        denied.set(p.id, "view");
        changed = true;
      }
    }
  }
}

/** A row as the person may see it: values of hidden properties left out. */
export function stripRow(row: Note, denied: ReadonlyMap<string, "view" | "edit">): Note {
  if (!row.props || denied.size === 0) return row;
  let props: Record<string, PropValue> | null = null;
  for (const [id, kind] of denied) {
    if (kind !== "view" || !(id in row.props)) continue;
    props ??= { ...row.props };
    delete props[id];
  }
  return props ? { ...row, props } : row;
}

/** A database's schema as the person sees it: denied properties marked (`denied`: deniedColumns, with formulas and rollups); permission lists only for people who manage them. */
export function annotateSchema(db: Note, who: Who, denied: ReadonlyMap<string, "view" | "edit"> = deniedColumns(db.db, who)): Note {
  if (!db.db) return db;
  let changed = false;
  const properties = db.db.properties.map((p) => {
    const mark = denied.get(p.id);
    if (!p.perms && !mark) return p;
    changed = true;
    // Who is on the lists is the managers' business.
    const { perms, ...rest } = p;
    return { ...(who.full && perms ? { ...rest, perms } : rest), ...(mark ? { denied: mark } : {}) } as DbProperty;
  });
  return changed ? { ...db, db: { ...db.db, properties } } : db;
}

/** A pushed row with the stored value back on every property the person may not change. */
export function guardRow(stored: Note | null, pushed: Note, denied: ReadonlyMap<string, "view" | "edit">): Note {
  if (denied.size === 0) return pushed;
  const props: Record<string, PropValue> = { ...(pushed.props ?? {}) };
  let changed = false;
  for (const id of denied.keys()) {
    const had = stored?.props && id in stored.props ? stored.props[id] : undefined;
    const has = id in props ? props[id] : undefined;
    if (JSON.stringify(had ?? null) === JSON.stringify(has ?? null)) continue;
    changed = true;
    if (had === undefined) delete props[id];
    else props[id] = had;
  }
  return changed ? { ...pushed, props } : pushed;
}

/**
 * A pushed database schema from someone without full access: permissions
 * stay as stored, a protected property stays exactly as stored (and cannot
 * be dropped), and no new property arrives with permissions.
 */
export function guardSchema(stored: Note | null, pushed: Note): Note {
  if (!pushed.db) return pushed;
  const before = new Map((stored?.db?.properties ?? []).map((p) => [p.id, p]));
  const properties: DbProperty[] = [];
  const kept = new Set<string>();
  for (const p of pushed.db.properties) {
    const old = before.get(p.id);
    kept.add(p.id);
    if (old?.perms) properties.push(old);
    else {
      const { perms: _p, denied: _d, ...rest } = p;
      void _p;
      void _d;
      properties.push(rest);
    }
  }
  // A protected property someone without full access tried to delete comes back.
  for (const [id, p] of before) if (p.perms && !kept.has(id)) properties.push(p);
  // Nor may they put a protected property into a form (whoever answers it would write that column):
  // a form keeps such questions only where it already had them.
  const guarded = new Set([...before.values()].filter((p) => p.perms).map((p) => p.id));
  const storedViews = new Map((stored?.db?.views ?? []).map((v) => [v.id, v]));
  const views = guarded.size
    ? pushed.db.views.map((v) => {
        if (!v.form) return v;
        const had = new Set((storedViews.get(v.id)?.form?.questions ?? []).map((q) => q.prop));
        const questions = v.form.questions.filter((q) => !guarded.has(q.prop) || had.has(q.prop));
        return questions.length === v.form.questions.length ? v : { ...v, form: { ...v.form, questions } };
      })
    : pushed.db.views;
  return { ...pushed, db: { ...pushed.db, properties, views } };
}
