// Server-only: database properties and row values ↔ Notion's shapes
// (database property schemas, page property values).

import { parseFileItem, relationIds } from "../compute";
import { safeUrl, shortId } from "../model";
import { CURRENCY_FORMATS, isDateValue, isPlaceValue, NOTE_COLORS, type DbProperty, type DbSchema, type Note, type NoteColor, type PropType, type PropValue, type RollupFn, type SelectOption } from "../types";
import { cleanDate, InputError, noteIdOf, richPlain, toRichText, type Lookup } from "./richtext";
import { toUuid } from "./space";
import { isVerification, verificationState } from "../verification";

/** Our property type → Notion's. */
export const NOTION_TYPE: Record<PropType, string> = {
  title: "title",
  text: "rich_text",
  number: "number",
  select: "select",
  multi_select: "multi_select",
  status: "status",
  date: "date",
  checkbox: "checkbox",
  url: "url",
  email: "email",
  phone: "phone_number",
  created_time: "created_time",
  last_edited_time: "last_edited_time",
  formula: "formula",
  relation: "relation",
  rollup: "rollup",
  files: "files",
  unique_id: "unique_id",
  person: "people",
  created_by: "created_by",
  last_edited_by: "last_edited_by",
  button: "button",
  place: "place",
  verification: "verification",
};

const OUR_TYPE: Record<string, PropType> = Object.fromEntries(Object.entries(NOTION_TYPE).map(([ours, theirs]) => [theirs, ours as PropType]));

// Our currency format ids are Notion's API names; only plain numbers differ.
const NUMBER_FORMAT_OUT: Record<string, string> = { number: "number", comma: "number_with_commas", percent: "percent", ...Object.fromEntries(Object.keys(CURRENCY_FORMATS).map((k) => [k, k])) };
const NUMBER_FORMAT_IN: Record<string, DbProperty["numberFormat"]> = { number: "number", number_with_commas: "comma", percent: "percent", ...Object.fromEntries(Object.keys(CURRENCY_FORMATS).map((k) => [k, k as DbProperty["numberFormat"]])) };

const ROLLUP_OUT: Partial<Record<RollupFn, string>> = { count: "count_all", count_unique: "unique", earliest: "earliest_date", latest: "latest_date" };
const ROLLUP_IN: Record<string, RollupFn> = {
  count_all: "count",
  count: "count",
  unique: "count_unique",
  count_unique_values: "count_unique",
  earliest_date: "earliest",
  latest_date: "latest",
};

const COLORS = new Set<string>(NOTE_COLORS);
// Verification, as in Notion's API, is read only (people verify in the app).
const READ_ONLY: readonly PropType[] = ["formula", "rollup", "created_time", "last_edited_time", "created_by", "last_edited_by", "unique_id", "button", "verification"];

export interface ValueContext extends Lookup {
  user(id: string | undefined): Record<string, unknown>;
  /** A visible note (relations show only what the integration may see). */
  visible(id: string): boolean;
  absolute(url: string): string;
}

function option(o: SelectOption | undefined): { id: string; name: string; color: string } | null {
  return o ? { id: o.id, name: o.name, color: o.color } : null;
}

const STATUS_GROUPS: { key: "todo" | "doing" | "done"; name: string; color: string }[] = [
  { key: "todo", name: "To-do", color: "gray" },
  { key: "doing", name: "In progress", color: "blue" },
  { key: "done", name: "Complete", color: "green" },
];

/** A database's property schema in Notion's shape. */
export function schemaProperty(p: DbProperty, schema: DbSchema, notes: (id: string) => Note | null): Record<string, unknown> {
  const type = NOTION_TYPE[p.type];
  let config: Record<string, unknown> = {};
  switch (p.type) {
    case "number":
      config = { format: NUMBER_FORMAT_OUT[p.numberFormat ?? "number"] ?? "number" };
      break;
    case "select":
    case "multi_select":
      config = { options: (p.options ?? []).map(option) };
      break;
    case "status":
      config = {
        options: (p.options ?? []).map(option),
        groups: STATUS_GROUPS.map((g) => ({ id: g.key, name: g.name, color: g.color, option_ids: (p.options ?? []).filter((o) => (o.group ?? "todo") === g.key).map((o) => o.id) })),
      };
      break;
    case "formula":
      config = { expression: p.formula?.expr ?? "" };
      break;
    case "relation": {
      const synced = p.relation?.syncedPropId;
      const target = p.relation?.dbId ? notes(p.relation.dbId) : null;
      const mirror = synced ? target?.db?.properties.find((x) => x.id === synced) : undefined;
      config = {
        database_id: p.relation?.dbId ? toUuid(p.relation.dbId) : null,
        ...(mirror ? { type: "dual_property", dual_property: { synced_property_id: mirror.id, synced_property_name: mirror.name } } : { type: "single_property", single_property: {} }),
      };
      break;
    }
    case "rollup": {
      const rel = schema.properties.find((x) => x.id === p.rollup?.relationPropId);
      const target = rel?.relation?.dbId ? notes(rel.relation.dbId) : null;
      const tp = target?.db?.properties.find((x) => x.id === p.rollup?.targetPropId);
      const fn = p.rollup?.fn ?? "show_original";
      config = {
        relation_property_id: rel?.id ?? null,
        relation_property_name: rel?.name ?? null,
        rollup_property_id: tp?.id ?? null,
        rollup_property_name: tp?.name ?? null,
        function: ROLLUP_OUT[fn] ?? fn,
      };
      break;
    }
    case "unique_id":
      config = { prefix: p.prefix ?? null };
      break;
    default:
      config = {};
  }
  return { id: p.id, name: p.name, type, [type]: config };
}

/** Property names as Notion keys them (unique; a repeated name gets its id appended). */
export function propertyKeys(schema: DbSchema): Map<string, DbProperty> {
  const out = new Map<string, DbProperty>();
  for (const p of schema.properties) {
    // Hidden from this integration (column permissions, or a formula over such a column).
    if (p.denied === "view") continue;
    const key = out.has(p.name) || !p.name ? `${p.name || p.type} (${p.id})` : p.name;
    out.set(key, p);
  }
  return out;
}

/** The property a request names (by name or by id). */
export function findProperty(schema: DbSchema, key: string): DbProperty | undefined {
  for (const [k, p] of propertyKeys(schema)) if (k === key) return p;
  return schema.properties.find((p) => p.id === key || p.name === key);
}

function dateOut(v: PropValue | undefined): Record<string, unknown> | null {
  if (!isDateValue(v)) return null;
  return { start: v.start, end: v.end ?? null, time_zone: null };
}

function computedOut(v: PropValue | undefined): Record<string, unknown> {
  if (typeof v === "number") return { type: "number", number: v };
  if (typeof v === "boolean") return { type: "boolean", boolean: v };
  if (isDateValue(v)) return { type: "date", date: dateOut(v) };
  if (Array.isArray(v)) return { type: "string", string: v.join(", ") };
  return { type: "string", string: v === null || v === undefined ? null : String(v) };
}

/** One row value in Notion's page-property shape. */
export function propertyValue(row: Note, p: DbProperty, schema: DbSchema, ctx: ValueContext): Record<string, unknown> {
  const type = NOTION_TYPE[p.type];
  const v = row.props?.[p.id];
  const text = (s: string) => toRichText(s ? [{ type: "text", text: s, styles: {} }] : [], ctx);
  let value: unknown;
  switch (p.type) {
    case "title":
      value = text(row.title);
      break;
    case "text":
      value = text(typeof v === "string" ? v : "");
      break;
    case "number":
      value = typeof v === "number" ? v : null;
      break;
    case "select":
    case "status":
      value = option(p.options?.find((o) => o.id === v));
      break;
    case "multi_select":
      value = (Array.isArray(v) ? v : []).map((id) => option(p.options?.find((o) => o.id === id))).filter(Boolean);
      break;
    case "date":
      value = dateOut(v);
      break;
    case "checkbox":
      value = v === true;
      break;
    case "url":
    case "email":
    case "phone":
      value = typeof v === "string" && v ? v : null;
      break;
    case "files":
      value = (Array.isArray(v) ? v : []).map((item) => {
        const f = parseFileItem(item);
        const own = f.url.startsWith("/");
        return { name: f.name, type: own ? "file" : "external", ...(own ? { file: { url: ctx.absolute(f.url), expiry_time: null } } : { external: { url: f.url } }) };
      });
      break;
    case "relation": {
      const ids = relationIds(row, p).filter((id) => ctx.visible(id));
      return { id: p.id, type, relation: ids.map((id) => ({ id: toUuid(id) })), has_more: false };
    }
    case "rollup": {
      const c = row.computed?.[p.id];
      const fn = p.rollup?.fn ?? "show_original";
      const fnName = ROLLUP_OUT[fn] ?? fn;
      if (typeof c === "number") value = { type: "number", number: c, function: fnName };
      else if (isDateValue(c)) value = { type: "date", date: dateOut(c), function: fnName };
      else {
        const list = Array.isArray(c) ? c : c === null || c === undefined || c === "" ? [] : [String(c)];
        value = { type: "array", array: list.map((s) => ({ type: "rich_text", rich_text: text(String(s)) })), function: fnName };
      }
      break;
    }
    case "formula":
      value = computedOut(row.computed?.[p.id]);
      break;
    case "created_time":
      value = new Date(row.createdAt).toISOString();
      break;
    case "last_edited_time":
      value = new Date(row.updatedAt).toISOString();
      break;
    case "created_by":
      value = ctx.user(row.createdBy);
      break;
    case "last_edited_by":
      value = ctx.user(row.editedBy ?? row.createdBy);
      break;
    case "person":
      value = (Array.isArray(v) ? v : []).map((id) => ctx.user(id));
      break;
    case "unique_id":
      value = { prefix: p.prefix ?? null, number: typeof v === "number" ? v : null };
      break;
    case "place":
      value = isPlaceValue(v) ? { name: v.name, address: v.address ?? null, lat: v.lat, lon: v.lng } : null;
      break;
    case "button":
      value = {};
      break;
    // Notion's shape: state, who verified it, and the verified period.
    case "verification": {
      const state = verificationState(v);
      const ver = isVerification(v) ? v : null;
      value = {
        state,
        verified_by: ver && state !== "unverified" && ver.by ? ctx.user(ver.by) : null,
        date: ver && state !== "unverified" && ver.at ? { start: new Date(ver.at).toISOString(), end: ver.until ?? null, time_zone: null } : null,
      };
      break;
    }
  }
  return { id: p.id, type, [type]: value };
}

/** All of a row's properties, keyed like Notion (by property name). */
export function propertyValues(row: Note, schema: DbSchema, ctx: ValueContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of propertyKeys(schema)) out[key] = propertyValue(row, p, schema, ctx);
  return out;
}

// ---------------------------------------------------------------------------
// From requests

function pickOption(p: DbProperty, v: unknown, create: boolean): { id: string; created?: SelectOption } | null {
  if (v === null) return null;
  const r = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const byId = typeof r.id === "string" ? p.options?.find((o) => o.id === r.id) : undefined;
  if (byId) return { id: byId.id };
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 200) : "";
  if (!name) throw new InputError(`${p.name}: an option needs a name or id`);
  const found = p.options?.find((o) => o.name === name);
  if (found) return { id: found.id };
  if (!create) throw new InputError(`${p.name}: no option "${name}"`);
  const color = typeof r.color === "string" && COLORS.has(r.color) ? (r.color as NoteColor) : NOTE_COLORS[((p.options?.length ?? 0) % (NOTE_COLORS.length - 1)) + 1];
  const created: SelectOption = { id: shortId(), name, color };
  return { id: created.id, created };
}

export interface ValueWrite {
  title?: string;
  props: Record<string, PropValue>;
  /** Options to add to the schema (Notion creates unknown select options). */
  newOptions: { propId: string; option: SelectOption }[];
}

export interface WriteContext {
  /** Whether a page id may be a relation target (visible, in the relation's database). */
  related(id: string, dbId: string): boolean;
  /** Whether a user id may be put in a Person property (a member of the workspace). */
  member(id: string): boolean;
}

/** `properties` of a POST/PATCH /pages request on a database row. */
export function valuesFromRequest(schema: DbSchema, v: unknown, ctx: WriteContext): ValueWrite {
  const out: ValueWrite = { props: {}, newOptions: [] };
  if (v === undefined) return out;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new InputError("properties should be an object");
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const p = findProperty(schema, key);
    if (!p) throw new InputError(`${key} is not a property that exists`);
    if (READ_ONLY.includes(p.type)) throw new InputError(`${key} is a ${NOTION_TYPE[p.type]} property and cannot be set`);
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const type = NOTION_TYPE[p.type];
    const val = type in r ? r[type] : raw;
    switch (p.type) {
      case "title":
        out.title = richPlain(val).slice(0, 2000);
        break;
      case "text":
        out.props[p.id] = richPlain(val).slice(0, 20_000);
        break;
      case "number":
        if (val !== null && (typeof val !== "number" || !Number.isFinite(val))) throw new InputError(`${key}: a number or null`);
        out.props[p.id] = val as number | null;
        break;
      case "select":
      case "status": {
        const o = pickOption(p, val, p.type === "select");
        if (o?.created) out.newOptions.push({ propId: p.id, option: o.created });
        out.props[p.id] = o ? o.id : null;
        break;
      }
      case "multi_select": {
        if (!Array.isArray(val)) throw new InputError(`${key}: an array of options`);
        const ids: string[] = [];
        for (const x of val.slice(0, 100)) {
          const o = pickOption(p, x, true);
          if (!o) continue;
          if (o.created) {
            out.newOptions.push({ propId: p.id, option: o.created });
            p.options = [...(p.options ?? []), o.created];
          }
          if (!ids.includes(o.id)) ids.push(o.id);
        }
        out.props[p.id] = ids;
        break;
      }
      case "date": {
        if (val === null) {
          out.props[p.id] = null;
          break;
        }
        const d = (typeof val === "object" && val !== null ? val : {}) as Record<string, unknown>;
        const start = cleanDate(d.start);
        if (!start) throw new InputError(`${key}: date.start is not a valid date`);
        const end = d.end === undefined || d.end === null ? null : cleanDate(d.end);
        if (d.end !== undefined && d.end !== null && !end) throw new InputError(`${key}: date.end is not a valid date`);
        out.props[p.id] = { start, ...(end ? { end } : {}) };
        break;
      }
      case "checkbox":
        if (typeof val !== "boolean") throw new InputError(`${key}: true or false`);
        out.props[p.id] = val;
        break;
      case "url":
        if (val !== null && (typeof val !== "string" || !safeUrl(val))) throw new InputError(`${key}: an http(s) url or null`);
        out.props[p.id] = val === null ? null : (val as string).slice(0, 2000);
        break;
      case "email":
      case "phone":
        if (val !== null && typeof val !== "string") throw new InputError(`${key}: a string or null`);
        out.props[p.id] = val === null ? null : (val as string).slice(0, 320);
        break;
      case "files": {
        if (!Array.isArray(val)) throw new InputError(`${key}: an array of files`);
        out.props[p.id] = val.slice(0, 100).map((f) => {
          const x = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
          const url = typeof (x.external as Record<string, unknown> | undefined)?.url === "string" ? String((x.external as Record<string, unknown>).url) : "";
          if (!/^https:\/\//i.test(url) || !safeUrl(url)) throw new InputError(`${key}: files need an https external url`);
          const name = typeof x.name === "string" && x.name ? x.name.slice(0, 200) : "";
          return name ? `${url}#bn=${encodeURIComponent(name)}` : url;
        });
        break;
      }
      case "relation": {
        if (!Array.isArray(val)) throw new InputError(`${key}: an array of { id }`);
        const ids: string[] = [];
        for (const x of val.slice(0, 100)) {
          const id = noteIdOf((x as Record<string, unknown>)?.id);
          if (!id || !p.relation?.dbId || !ctx.related(id, p.relation.dbId)) throw new InputError(`${key}: a related page is missing or not shared with this integration`);
          if (!ids.includes(id)) ids.push(id);
        }
        out.props[p.id] = p.single ? ids.slice(0, 1) : ids;
        break;
      }
      case "person": {
        if (!Array.isArray(val)) throw new InputError(`${key}: an array of users`);
        const ids: string[] = [];
        for (const x of val.slice(0, 100)) {
          const raw = (x as Record<string, unknown>)?.id;
          const id = typeof raw === "string" ? raw : "";
          const own = ctx.member(id) ? id : ctx.member(id.replace(/-/g, "")) ? id.replace(/-/g, "") : null;
          if (!own) throw new InputError(`${key}: ${id || "?"} is not a member of this workspace`);
          if (!ids.includes(own)) ids.push(own);
        }
        out.props[p.id] = p.single ? ids.slice(0, 1) : ids;
        break;
      }
      case "place": {
        if (val === null) {
          out.props[p.id] = null;
          break;
        }
        const x = (typeof val === "object" && val !== null ? val : {}) as Record<string, unknown>;
        const lat = Number(x.lat);
        const lng = Number(x.lon ?? x.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new InputError(`${key}: place needs lat and lon`);
        out.props[p.id] = { name: typeof x.name === "string" ? x.name.slice(0, 300) : "", lat, lng, ...(typeof x.address === "string" && x.address ? { address: x.address.slice(0, 500) } : {}) };
        break;
      }
    }
  }
  return out;
}

/** A page outside a database has one property: its title. */
export function titleFromRequest(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null) throw new InputError("properties should be an object");
  const r = v as Record<string, unknown>;
  const entry = (r.title ?? r.Name ?? Object.values(r)[0]) as Record<string, unknown> | unknown[] | undefined;
  if (entry === undefined) return undefined;
  const val = Array.isArray(entry) ? entry : (entry as Record<string, unknown>).title;
  return richPlain(val).slice(0, 2000);
}

// --- Schema changes (POST / PATCH /databases) -----------------------------------

export interface SchemaWrite {
  schema: DbSchema;
  /** Mirror properties to add to other databases (two-way relations). */
  mirrors: { dbId: string; property: DbProperty }[];
}

function optionsFrom(v: unknown): SelectOption[] {
  const r = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const list = Array.isArray(r.options) ? r.options : [];
  return list.slice(0, 500).map((o, i) => {
    const x = (typeof o === "object" && o !== null ? o : {}) as Record<string, unknown>;
    const name = typeof x.name === "string" ? x.name.trim().slice(0, 200) : "";
    if (!name) throw new InputError("an option needs a name");
    const color = typeof x.color === "string" && COLORS.has(x.color) ? (x.color as NoteColor) : NOTE_COLORS[(i % (NOTE_COLORS.length - 1)) + 1];
    return { id: typeof x.id === "string" && /^[\w-]{1,40}$/.test(x.id) ? x.id : shortId(), name, color };
  });
}

/** A property definition from a request (`name` and one type key). */
function propertyFrom(name: string, v: unknown, schema: DbSchema, dbId: string, sourceTitle: string, targetTitle: (id: string) => string | null, prevId?: string): { property: DbProperty; mirror?: { dbId: string; property: DbProperty } } {
  const r = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const typeKey = typeof r.type === "string" ? r.type : Object.keys(r).find((k) => k in OUR_TYPE);
  const type = typeKey ? OUR_TYPE[typeKey] : undefined;
  // Verification comes with a wiki (turned into one in the app).
  if (!type || type === "button" || type === "verification") throw new InputError(`${name}: unsupported property type "${typeKey ?? "?"}"`);
  const config = (typeKey && typeof r[typeKey] === "object" && r[typeKey] !== null ? r[typeKey] : {}) as Record<string, unknown>;
  const p: DbProperty = { id: prevId ?? (type === "title" ? "title" : shortId()), name: name.slice(0, 200), type };
  if (type === "number") p.numberFormat = NUMBER_FORMAT_IN[String(config.format ?? "number")] ?? "number";
  if (type === "select" || type === "multi_select") p.options = optionsFrom(config);
  if (type === "status") p.options = [
    { id: "todo", name: "Not started", color: "default", group: "todo" },
    { id: "doing", name: "In progress", color: "blue", group: "doing" },
    { id: "done", name: "Done", color: "green", group: "done" },
  ];
  if (type === "formula") p.formula = { expr: typeof config.expression === "string" ? config.expression.slice(0, 4000) : "" };
  if (type === "unique_id" && typeof config.prefix === "string") p.prefix = config.prefix.replace(/[^\p{L}\p{N}_]/gu, "").toUpperCase().slice(0, 20);
  let mirror: { dbId: string; property: DbProperty } | undefined;
  if (type === "relation") {
    const target = noteIdOf(config.database_id);
    if (!target || targetTitle(target) === null) throw new InputError(`${name}: relation.database_id is missing or not shared with this integration`);
    p.relation = { dbId: target };
    if (config.type === "dual_property" || config.dual_property !== undefined) {
      const mirrorId = shortId();
      p.relation.syncedPropId = mirrorId;
      const back: DbProperty = { id: mirrorId, name: (sourceTitle || "Related").slice(0, 200), type: "relation", relation: { dbId, syncedPropId: p.id } };
      if (target === dbId) schema.properties.push(back);
      else mirror = { dbId: target, property: back };
    }
  }
  if (type === "rollup") {
    const rel = schema.properties.find((x) => x.type === "relation" && (x.id === config.relation_property_id || x.name === config.relation_property_name));
    if (!rel) throw new InputError(`${name}: rollup needs an existing relation property`);
    const fnRaw = String(config.function ?? "show_original");
    p.rollup = { relationPropId: rel.id, targetPropId: String(config.rollup_property_id ?? config.rollup_property_name ?? "title").slice(0, 40), fn: ROLLUP_IN[fnRaw] ?? (fnRaw as RollupFn) };
  }
  return { property: p, ...(mirror ? { mirror } : {}) };
}

/** A new database's schema from POST /databases `properties` (exactly one title). */
export function schemaFromRequest(v: unknown, dbId: string, title: string, targetTitle: (id: string) => string | null): SchemaWrite {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new InputError("properties should be an object");
  const schema: DbSchema = { properties: [], views: [] };
  const mirrors: SchemaWrite["mirrors"] = [];
  for (const [name, def] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
    const { property, mirror } = propertyFrom(name, def, schema, dbId, title, targetTitle);
    if (property.type === "title" && schema.properties.some((x) => x.type === "title")) throw new InputError("a database has exactly one title property");
    schema.properties.push(property);
    if (mirror) mirrors.push(mirror);
  }
  if (!schema.properties.some((p) => p.type === "title")) throw new InputError("a database needs a title property");
  // Rollups may point at relations listed after them.
  for (const p of schema.properties) if (p.type === "rollup" && p.rollup && !schema.properties.some((x) => x.id === p.rollup?.relationPropId)) throw new InputError(`${p.name}: rollup needs an existing relation property`);
  return { schema, mirrors };
}

/** PATCH /databases `properties`: rename ({ name }), retype (a type key), add, delete (null). */
export function patchSchema(schema: DbSchema, v: unknown, dbId: string, title: string, targetTitle: (id: string) => string | null): SchemaWrite {
  if (v === undefined) return { schema, mirrors: [] };
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new InputError("properties should be an object");
  const next: DbSchema = { ...schema, properties: schema.properties.map((p) => ({ ...p })) };
  const mirrors: SchemaWrite["mirrors"] = [];
  for (const [key, def] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
    const cur = findProperty(next, key);
    if (def === null) {
      if (!cur) continue;
      if (cur.type === "title") throw new InputError("the title property cannot be removed");
      next.properties = next.properties.filter((p) => p.id !== cur.id);
      next.views = next.views.map((view) => ({ ...view, filters: view.filters.filter((f) => f.prop !== cur.id), sorts: view.sorts.filter((s) => s.prop !== cur.id), hidden: view.hidden.filter((h) => h !== cur.id) }));
      continue;
    }
    const r = (typeof def === "object" && def !== null ? def : {}) as Record<string, unknown>;
    const rename = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 200) : undefined;
    const typeKey = Object.keys(r).find((k) => k in OUR_TYPE);
    if (cur && !typeKey) {
      if (rename) cur.name = rename;
      continue;
    }
    if (cur && typeKey && OUR_TYPE[typeKey] === cur.type) {
      if (rename) cur.name = rename;
      const config = (typeof r[typeKey] === "object" && r[typeKey] !== null ? r[typeKey] : {}) as Record<string, unknown>;
      if ((cur.type === "select" || cur.type === "multi_select") && Array.isArray(config.options)) {
        // Listed options are kept/added (by id or name); Notion does not delete options through the API.
        const given = optionsFrom(config);
        const merged = [...(cur.options ?? [])];
        for (const o of given) {
          const i = merged.findIndex((x) => x.id === o.id || x.name === o.name);
          if (i >= 0) merged[i] = { ...merged[i], name: o.name, color: o.color };
          else merged.push(o);
        }
        cur.options = merged;
      }
      if (cur.type === "number" && config.format !== undefined) cur.numberFormat = NUMBER_FORMAT_IN[String(config.format)] ?? cur.numberFormat;
      if (cur.type === "formula" && typeof config.expression === "string") cur.formula = { expr: config.expression.slice(0, 4000) };
      continue;
    }
    if (cur?.type === "title") throw new InputError("the title property cannot change type");
    const { property, mirror } = propertyFrom(rename ?? (cur ? cur.name : key), def, next, dbId, title, targetTitle, cur?.id);
    if (property.type === "title") throw new InputError("a database has exactly one title property");
    if (cur) next.properties = next.properties.map((p) => (p.id === cur.id ? property : p));
    else next.properties.push(property);
    if (mirror) mirrors.push(mirror);
  }
  return { schema: next, mirrors };
}
