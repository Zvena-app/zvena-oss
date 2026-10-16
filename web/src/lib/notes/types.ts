// zvena Documents: the data model shared by the browser store, the sync route
// and the public pages (/n/<id>).
//
// Everything is a note: a page, a database, or a database row (a page whose
// parent is a database). A page's body is BlockNote's block JSON; a database
// keeps its schema (properties + views) and its rows are separate notes, so a
// row opens as a full page with its own body, as in Notion.

import type { Automation } from "./automations";
import type { SiteOptions } from "./sites";

export type NoteKind = "page" | "database";

/** Notion's nine colors (text and background variants share the names). */
export const NOTE_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface NoteCover {
  kind: "color" | "gradient" | "image";
  /** A palette key (color/gradient) or an image URL (uploads are same-origin). */
  value: string;
  /** Vertical focus of an image cover, 0–100 (%). */
  y: number;
}

export type PropType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "created_time"
  | "last_edited_time"
  | "formula"
  | "relation"
  | "rollup"
  | "files"
  | "unique_id"
  | "person"
  | "created_by"
  | "last_edited_by"
  | "button"
  | "place"
  | "verification";

export const PROP_TYPES: readonly PropType[] = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "created_time",
  "last_edited_time",
  "formula",
  "relation",
  "rollup",
  "files",
  "unique_id",
  "person",
  "created_by",
  "last_edited_by",
  "button",
  "place",
  "verification",
];

/** Property types whose values are computed, never typed in. */
export const COMPUTED_TYPES: readonly PropType[] = ["created_time", "last_edited_time", "formula", "rollup", "unique_id", "created_by", "last_edited_by"];

/** Property types without a stored value (a Button runs actions when clicked). */
export const NO_VALUE_TYPES: readonly PropType[] = ["button"];

export type RollupFn =
  | "show_original"
  | "show_unique"
  | "count"
  | "count_values"
  | "count_unique"
  | "count_empty"
  | "count_not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "earliest"
  | "latest"
  | "date_range"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked";

export const ROLLUP_FNS: readonly RollupFn[] = [
  "show_original",
  "show_unique",
  "count",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest",
  "latest",
  "date_range",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
];

export interface SelectOption {
  id: string;
  name: string;
  color: NoteColor;
  /** Status only: the group the option belongs to. */
  group?: "todo" | "doing" | "done";
}

/** Notion's currencies (ISO code per number format; its API names). */
export const CURRENCY_FORMATS = {
  dollar: "USD",
  canadian_dollar: "CAD",
  australian_dollar: "AUD",
  singapore_dollar: "SGD",
  euro: "EUR",
  pound: "GBP",
  yen: "JPY",
  rupee: "INR",
  won: "KRW",
  yuan: "CNY",
  real: "BRL",
  lira: "TRY",
  rupiah: "IDR",
  franc: "CHF",
  hong_kong_dollar: "HKD",
  new_zealand_dollar: "NZD",
  krona: "SEK",
  norwegian_krone: "NOK",
  danish_krone: "DKK",
  mexican_peso: "MXN",
  rand: "ZAR",
  new_taiwan_dollar: "TWD",
  zloty: "PLN",
  baht: "THB",
  forint: "HUF",
  koruna: "CZK",
  shekel: "ILS",
  chilean_peso: "CLP",
  philippine_peso: "PHP",
  dirham: "AED",
  colombian_peso: "COP",
  riyal: "SAR",
  ringgit: "MYR",
  leu: "RON",
  argentine_peso: "ARS",
  uruguayan_peso: "UYU",
  peruvian_sol: "PEN",
} as const;
export type CurrencyFormat = keyof typeof CURRENCY_FORMATS;
export type NumberFormat = "number" | "comma" | "percent" | CurrencyFormat;
export const NUMBER_FORMATS: readonly NumberFormat[] = ["number", "comma", "percent", ...(Object.keys(CURRENCY_FORMATS) as CurrencyFormat[])];
export const isCurrency = (f: string | undefined): f is CurrencyFormat => typeof f === "string" && f in CURRENCY_FORMATS;

export interface DbProperty {
  id: string;
  name: string;
  type: PropType;
  options?: SelectOption[];
  numberFormat?: NumberFormat;
  /** Number: digits after the point, 0–6 (Notion's "Decimal places"; unset: as typed). */
  decimals?: number;
  /** Formula: Notion-style expression over the row (prop("Name") …). */
  formula?: { expr: string };
  /** Relation: rows of another (or the same) database; two-way when synced. */
  relation?: { dbId: string; syncedPropId?: string };
  /** Unique ID: the text before the number ("TASK" → TASK-12). */
  prefix?: string;
  /** Rollup: aggregates a property of the rows a relation points to. */
  rollup?: { relationPropId: string; targetPropId: string; fn: RollupFn };
  /** On row pages: hidden while empty, or always (Notion's "Property visibility"). */
  pageVis?: "hideEmpty" | "hide";
  /** Date / created / edited time: how dates read (default "full": October 9, 2026). */
  dateFormat?: "full" | "mdy" | "dmy" | "ymd" | "relative";
  /** 12- or 24-hour clock (default: the locale's). */
  timeFormat?: "12" | "24";
  /** Person / relation: at most one person or page ("Limit to 1"). */
  single?: boolean;
  /** Notion's property description (a hint on the column header and the page). */
  description?: string;
  /** Number (and number formulas / rollups): shown as a bar or a ring of `divide` (Notion's "Show as"). */
  show?: { as: "bar" | "ring"; color?: NoteColor; divide?: number; number?: boolean };
  /** Button: its label and the actions a click runs (automations.ts, run on the server). */
  /** `by`: who set its actions up (the server's word). */
  button?: { label: string; actions: import("./automations").AutoAction[]; by?: string };
  /**
   * Column permissions (Notion): who may see and who may edit this property's
   * values — user ids and "group:<id>"; a list left out means everyone with
   * access to the database. People with full access always may. The server
   * enforces it (lib/notes/column-perms.ts).
   */
  perms?: { view?: string[]; edit?: string[] };
  /** Pull only (never stored): the person pulling may not see ("view") or not change ("edit") this property's values. */
  denied?: "view" | "edit";
}

export type FilterOp =
  | "contains"
  | "not_contains"
  | "is"
  | "is_not"
  | "empty"
  | "not_empty"
  | "checked"
  | "unchecked"
  | "gt"
  | "lt"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  /** A date within a range relative to today (value: past_week … next_year). */
  | "within"
  | "gte"
  | "lte"
  | "starts_with"
  | "ends_with";

export interface DbFilter {
  id: string;
  prop: string;
  op: FilterOp;
  value?: string;
}

/** Notion's advanced filter: rules and nested groups joined by "and" / "or". */
export interface DbFilterGroup {
  id: string;
  conj: "and" | "or";
  items: (DbFilter | DbFilterGroup)[];
}

export const isFilterGroup = (x: DbFilter | DbFilterGroup): x is DbFilterGroup => Array.isArray((x as DbFilterGroup).items);

/** Nesting below the top-level advanced filter (Notion allows groups in groups). */
export const MAX_FILTER_DEPTH = 2;

export interface DbSort {
  prop: string;
  dir: "asc" | "desc";
}

export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "chart" | "form" | "map" | "dashboard" | "feed";
export const VIEW_TYPES: readonly ViewType[] = ["table", "board", "list", "gallery", "calendar", "timeline", "chart", "form", "map", "dashboard", "feed"];

/** A form question: one database property; the property name is the question (Notion Forms). */
export interface FormQuestion {
  prop: string;
  help?: string;
  required?: boolean;
  /** Conditional logic: shown only when an earlier question's answer meets this. */
  when?: FormCondition;
}

/** "Show when <question> is / is not <value>, or is filled / empty" (lib/notes/form-logic.ts). */
export interface FormCondition {
  prop: string;
  op: "is" | "is_not" | "filled" | "empty";
  value?: string;
}

/** Notion Forms: a view whose public link adds a row per response. */
export interface FormSpec {
  title?: string;
  description?: string;
  questions: FormQuestion[];
  /** The public form id while it accepts responses (signed-in owners). */
  shareId?: string;
  /** Shown after a response is sent. */
  thanks?: string;
  /** Who may answer (Notion): anyone with the link (default), or signed-in members of the workspace only. */
  access?: "workspace";
  /** Members' responses leave out who sent them (by default a member's response is created by them). */
  anonymous?: true;
}

/** Property types a form can ask for. */
export const FORM_PROP_TYPES: readonly PropType[] = ["title", "text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "email", "phone"];

export const FORM_ID_RE = /^[A-Za-z0-9_-]{10,40}$/;

/** Chart view settings (Notion Charts). */
export interface ChartSpec {
  type: "column" | "bar" | "line" | "donut";
  /** The property rows are grouped by (X axis / slices). */
  x?: string;
  /** Count rows, or aggregate a number property. */
  y?: { fn: "count" | "sum" | "average" | "median" | "min" | "max"; prop?: string };
  sort?: "x" | "asc" | "desc";
  labels?: boolean;
  /** Series: each X group split by this property (stacked columns / bars, one line each). */
  group?: string;
  /** A line adds up as it goes (a running total). */
  cumulative?: boolean;
  /** Chart height (Notion's Small / Medium / Large; medium unset). */
  height?: "small" | "large";
  /** Leave out groups whose value is 0. */
  omitZero?: boolean;
}

/** Timeline scale: how much time one screen shows. */
export type TimelineZoom = "week" | "month" | "quarter" | "year";

/**
 * Notion's conditional color: the first rule (top first) whose conditions
 * all hold colors the row (table, list), the card (board, gallery) or, with
 * `prop`, only that property's cell.
 */
export interface ColorRule {
  id: string;
  color: Exclude<NoteColor, "default">;
  /** A property id: color only that cell; absent: the whole row or card. */
  prop?: string;
  /** All must hold ("and"); a rule without a complete condition colors nothing. */
  filters: DbFilter[];
}

export const MAX_COLOR_RULES = 20;

export interface DbView {
  id: string;
  name: string;
  type: ViewType;
  /**
   * The data source the view shows (Notion, 2025): the database itself
   * (absent, or its own id), one of its other data sources (a database note
   * under it, `DbSchema.dataSource`), or a data source linked from another
   * database (`DbSchema.linked`).
   */
  source?: string;
  /** Conditional color rules, in priority order (table, board, list, gallery). */
  colors?: ColorRule[];
  filters: DbFilter[];
  /** Advanced filter (applies together with the simple filters). */
  filterGroup?: DbFilterGroup;
  sorts: DbSort[];
  /** Board: the select/status property that makes the columns. */
  groupBy?: string;
  /** Calendar and timeline: the date property. */
  dateProp?: string;
  /** Timeline: a separate end date property (Notion's "Use separate start and end dates"); the start is `dateProp`. */
  endProp?: string;
  /** Timeline scale. */
  zoom?: TimelineZoom;
  /** Timeline: hide the title column on the left. */
  hideTable?: boolean;
  /** Calendar: a week at a time instead of the month. */
  calMode?: "week";
  /** Board: lanes by this property (Notion's sub-group). */
  subGroupBy?: string;
  /** Grouping by a date: how dates fall into groups (default month). */
  groupDate?: "relative" | "day" | "week" | "month" | "year";
  /** Groups oldest / A first ("asc", the default) or newest / Z first. */
  groupOrder?: "asc" | "desc";
  /** The page template "New" starts from in this view (Notion's default template "For this view"). */
  template?: string;
  /** Form view settings. */
  form?: FormSpec;
  /** Chart view settings. */
  chart?: ChartSpec;
  /** Table footer calculations by property id (Notion's "Calculate"). */
  calcs?: Record<string, RollupFn>;
  /** Property ids hidden in this view (the title is always shown). */
  hidden: string[];
  /** Table column widths (px) by property id. */
  widths: Record<string, number>;
  /** Property order in this view (missing ids follow in schema order). */
  order?: string[];
  /** Gallery / board card preview (galleries default to page content, boards to none). */
  preview?: "none" | "cover" | "content";
  /** Gallery / board card size. */
  cardSize?: "small" | "medium" | "large";
  /** Wrap long cell text instead of cutting it. */
  wrap?: boolean;
  /** Table columns that wrap (Notion's "Wrap column"), when not all of them do. */
  wrapCols?: string[];
  /** Table columns up to and including this property stay put on sideways scroll (Notion's "Freeze up to column"). */
  freeze?: string;
  /** A linked view block's own views carry its id; the database itself shows the views without one. */
  scope?: string;
  // Layout options (Notion's Layout panel).
  /** Inline database without its title ("Show database title" off). */
  hideTitle?: boolean;
  /** Table without vertical lines between columns. */
  noLines?: boolean;
  /** Rows and cards without page icons. */
  hideIcons?: boolean;
  /** Where rows open: side peek (default), center peek or full page. */
  openIn?: "center" | "full";
  /** Rows shown before "Load more" (default 50). */
  limit?: 10 | 25 | 50 | 100;
  /** Board columns without their option color ("Color columns" off). */
  plainCols?: boolean;
  /** Calendar without Saturday and Sunday ("Show weekends" off). */
  noWeekends?: boolean;
  /** Groups (board columns) hidden in this view, by group key. */
  hiddenGroups?: string[];
  /** Leave out groups without rows ("Hide empty groups"). */
  hideEmpty?: boolean;
  /** Card preview images fit inside instead of filling ("Fit image"). */
  fitImage?: boolean;
  /** Map: the Place property the pins come from, and the map height (px). */
  map?: { prop?: string; height?: number };
  /** Dashboard: widgets, each another view of this database (scope "dash:<this view id>"), in rows. */
  dashboard?: { widgets: DashboardWidget[] };
  /** Feed: posts without their page content or without their comments (both shown by default). */
  feed?: { hideContent?: boolean; hideComments?: boolean };
}

/** A section of the property panel on a database page (Notion's "Customize layout"). */
export interface LayoutSection {
  id: string;
  name: string;
  /** Property ids, in order. */
  props: string[];
  /** Starts folded. */
  collapsed?: boolean;
  /** Empty properties stay out of the section. */
  hideEmpty?: boolean;
}

/** How a database's pages show their properties (Notion's database page layouts). */
export interface PageLayout {
  /** Properties pinned under the page title, at most 4. */
  header?: string[];
  /** The property panel above the page body (default) or beside it on wide screens. */
  panel?: "top" | "side";
  /** Property sections; properties in none of them come first, untitled. */
  sections?: LayoutSection[];
}

/** One tile of a dashboard view: a view of the database, so wide (columns of 4). */
export interface DashboardWidget {
  id: string;
  viewId: string;
  width: 1 | 2 | 3 | 4;
}

/**
 * A database's schema. In Notion (2025) a database holds one or more data
 * sources, each with its own properties, rows, templates and automations.
 * Here the database note's own properties, rows (notes under it), templates
 * and automations are its first data source; each further data source is a
 * database note under it marked `dataSource`, with the same shape (its rows
 * are notes under that note). The views stay with the database and name
 * the data source they show (`DbView.source`). Devices that predate data
 * sources keep seeing the first one as the whole database.
 */
export interface DbSchema {
  properties: DbProperty[];
  views: DbView[];
  /** Notion's sub-items: a two-way relation of the database to itself (parent ↔ children). */
  subItems?: { parentProp: string; childProp: string };
  /** Database automations ("when … do …"). */
  automations?: Automation[];
  /** Timeline dependencies: a two-way relation of the database to itself (blocked by ↔ blocking). */
  deps?: { blockedBy: string; blocking: string };
  /** A page template new rows start from (Notion's "Set as default"). */
  defaultTemplate?: string;
  /** How the database's pages lay out their properties. */
  layout?: PageLayout;
  /** Notion's wiki: the Owner (person) and Verification properties of its pages. */
  wiki?: { owner?: string; verification?: string };
  /** This database note is a data source of the database it sits in (not a database of its own). */
  dataSource?: true;
  /** The first data source's own name and icon, when they are not the database's. */
  label?: { name?: string; icon?: string };
  /** Data sources of other databases shown in this one ("Link existing data source"). */
  linked?: string[];
}

export interface DateValue {
  start: string;
  end?: string;
  /** A reminder ("day", "1d", "2d", "1w": 9:00 on the day or days before). */
  remind?: string;
}

/** A Place property value (Notion's map pins): a name, an address and coordinates. */
export interface PlaceValue {
  name: string;
  address?: string;
  lat: number;
  lng: number;
}

export const isPlaceValue = (v: PropValue | undefined): v is PlaceValue =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as PlaceValue).lat === "number" && typeof (v as PlaceValue).lng === "number";
export const isDateValue = (v: PropValue | undefined): v is DateValue => typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as DateValue).start === "string";

/**
 * A wiki page's verification (Notion): verified by someone, through a
 * calendar day or indefinitely (no `until`). The daily upkeep turns an
 * expired one to "unverified" and keeps its date (it reads "Expired").
 */
export interface VerificationValue {
  state: "verified" | "unverified";
  /** Who verified it (a user id). */
  by?: string;
  /** When it was verified (ms). */
  at?: number;
  /** Verified through this day ("YYYY-MM-DD"); none: indefinitely. */
  until?: string;
}

/** Person values are user ids (string[]); created by / last edited by come from Note.createdBy / editedBy. */
export type PropValue = string | number | boolean | string[] | DateValue | PlaceValue | VerificationValue | null;

export interface NoteStyle {
  /** Notion's page Style: "default" (and "sans", how older pages said it) is the sans UI font; "serif" and "mono" opt in. */
  font?: "default" | "serif" | "mono" | "sans";
  small?: boolean;
  full?: boolean;
  locked?: boolean;
  /** "Customize page": backlinks expanded or off (default: behind a button)… */
  backlinks?: "expanded" | "off";
  /** …and page comments off (default: shown). */
  comments?: "off";
}

/** A public, read-only copy at /n/<id> (key = proof of ownership for guests), with its site settings. */
export interface NoteShare extends SiteOptions {
  id: string;
  key: string;
  at: number;
}

/** A page comment (Notion's page discussion). */
export interface NoteComment {
  id: string;
  text: string;
  at: number;
  author: string;
  resolved?: boolean;
  /** Inline discussion: the thread id its text mark carries (absent: page comment). */
  thread?: string;
  /** Inline discussion: the commented text (first comment of a thread). */
  quote?: string;
  /** Emoji reactions: who reacted with each emoji. */
  reactions?: Record<string, string[]>;
  /** Who wrote it (user id; set by the server, the name above is for display). */
  authorId?: string;
  /** Its author changed the text since (Notion's "edited"). */
  editedAt?: number;
  /**
   * A suggested edit (lib/notes/suggestions.ts): this entry is the suggestion
   * itself, the first of its thread (`thread` = the id its marks carry), with
   * no text of its own. `state`: an editor accepted or rejected it (`by`, `at`).
   */
  suggestion?: NoteSuggestion;
}

export interface NoteSuggestion {
  state?: "accepted" | "rejected";
  /** Who accepted or rejected it (user id; set by the server). */
  by?: string;
  at?: number;
}

export interface Note {
  id: string;
  /** A page or database id; null = top level (Private). */
  parentId: string | null;
  kind: NoteKind;
  title: string;
  /** An emoji, or "" for none. */
  icon: string;
  cover: NoteCover | null;
  /** BlockNote blocks (pages and rows). */
  content: unknown[];
  /** Databases only. */
  db?: DbSchema;
  /** Rows only: values by property id (the title lives in `title`). */
  props?: Record<string, PropValue>;
  /** A database page template (hidden from rows; "New ▾" copies it). */
  template?: boolean;
  /** The content of a synced block: shown wherever a "synced" block points at it, never listed. */
  synced?: boolean;
  /** Runtime only, never stored: formula, rollup and relation-title values. */
  computed?: Record<string, PropValue>;
  /** Shown inside its parent page as a block rather than as a sub-page. */
  inline?: boolean;
  /** Sibling order (fractional, ascending). */
  order: number;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  /** Who created it and who last changed it: user ids, or "form" / "automation:<id>" (set by the server, never trusted from a device). */
  createdBy?: string;
  editedBy?: string;
  /** Co-editing: the hash of `content` as a live session wrote it (lib/notes/collab-shared.ts); any other hash = edited outside a session. */
  ysnap?: string;
  /**
   * Top-level pages only: the sidebar section that holds it — someone's
   * Private ("private:<user id>") or a teamspace ("ts:<id>"); absent: the
   * workspace's shared pages. Sub-pages follow their parent. The server
   * normalizes it and derives access from it (lib/notes/access.ts).
   */
  space?: string;
  /** Pull only (never stored or pushed): what the person pulling may do with it. */
  access?: NoteAccessInfo;
  style?: NoteStyle;
  share?: NoteShare;
  comments?: NoteComment[];
}

export const NOTE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Notion's page access levels, highest first. */
export type AccessLevel = "full" | "edit" | "comment" | "view";
export const ACCESS_LEVELS: readonly AccessLevel[] = ["full", "edit", "comment", "view"];

export interface NoteAccessInfo {
  level: AccessLevel;
  /** The page itself is "Only people invited". */
  restricted?: boolean;
  /** Reached through a share: the person cannot open the page above it (Notion's "Shared" section). */
  shared?: boolean;
}

/** A sidebar section key as stored in Note.space. */
export const SPACE_RE = /^(private:[A-Za-z0-9_-]{6,64}|ts:[A-Za-z0-9_-]{6,40})$/;

/** Limits that keep one note syncable and the browser store responsive. */
export const NOTE_LIMITS = {
  titleChars: 2000,
  noteBytes: 2_500_000,
  /** Everything one signed-in user keeps on the server. */
  userBytes: 500_000_000,
  userNotes: 50_000,
  pullPage: 300,
  pushBatch: 80,
  uploadBytes: 50 * 1024 * 1024,
};
