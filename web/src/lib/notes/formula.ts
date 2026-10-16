// zvena Documents formulas: a Notion "Formulas 2.0" subset. Pure: a tokenizer,
import { intlOf } from "@/i18n/locales";
import { PatternError, withPattern } from "@/lib/notes/safe-regex";
// a Pratt parser and an evaluator over one row's values.
//
//   prop("Price") * prop("Qty")
//   if(prop("Done"), "✅", "⏳")
//   dateBetween(prop("Due"), now(), "days") + " дн."
//   prop("Tags").length()          (method calls: x.fn(a) == fn(x, a))
//   map(prop("Tags"), upper(current))

export interface FDate {
  kind: "date";
  start: number;
  end?: number;
  /** Has a time of day (else a whole day). */
  time: boolean;
}
export type FValue = number | string | boolean | FDate | FValue[] | null;

export type FNode =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "list"; items: FNode[] }
  | { t: "id"; name: string }
  | { t: "call"; name: string; args: FNode[] }
  | { t: "un"; op: string; x: FNode }
  | { t: "bin"; op: string; a: FNode; b: FNode }
  | { t: "cond"; c: FNode; a: FNode; b: FNode };

export class FormulaError extends Error {}

export interface FEnv {
  /** A property of the current row by name; throws FormulaError when unknown. */
  prop: (name: string) => FValue;
  /** The row id (id()). */
  id?: string;
  /** "Now" in ms (fixed per evaluation for consistent results). */
  now?: number;
  locale?: string;
}

// ---------------------------------------------------------------------------
// Tokenizer

interface Tok {
  k: "num" | "str" | "id" | "op" | "eof";
  v: string;
  pos: number;
}

const OPS = ["==", "!=", ">=", "<=", "&&", "||", "+", "-", "*", "/", "%", "^", ">", "<", "!", "?", ":", "(", ")", ",", ".", "[", "]", "="];
const QUOTES: Record<string, string> = { '"': '"', "'": "'", "“": "”", "”": "”", "«": "»", "„": "“" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Comments: /* … */ and // … (Notion allows /* */).
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      // "5.format()": a dot before a name is a method call, not a decimal point.
      const m = /^(?:\d+(?:\.(?![\p{L}_$])\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(src.slice(i));
      const v = m ? m[0] : c;
      out.push({ k: "num", v, pos: i });
      i += v.length;
      continue;
    }
    if (c in QUOTES) {
      const close = QUOTES[c];
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== close && !(c === '"' && src[j] === "”")) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
          continue;
        }
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError(`Unclosed string at ${i + 1}`);
      out.push({ k: "str", v: s, pos: i });
      i = j + 1;
      continue;
    }
    const id = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ k: "op", v: op, pos: i });
      i += op.length;
      continue;
    }
    if (c === "≠" || c === "≥" || c === "≤") {
      out.push({ k: "op", v: c === "≠" ? "!=" : c === "≥" ? ">=" : "<=", pos: i });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected "${c}" at ${i + 1}`);
  }
  out.push({ k: "eof", v: "", pos: src.length });
  return out;
}

// ---------------------------------------------------------------------------
// Parser (Pratt)

const INFIX: Record<string, [number, number]> = {
  "?": [2, 1],
  or: [4, 5],
  "||": [4, 5],
  and: [6, 7],
  "&&": [6, 7],
  "==": [10, 11],
  "!=": [10, 11],
  "=": [10, 11],
  ">": [10, 11],
  ">=": [10, 11],
  "<": [10, 11],
  "<=": [10, 11],
  "+": [20, 21],
  "-": [20, 21],
  "*": [30, 31],
  "/": [30, 31],
  "%": [30, 31],
  "^": [41, 40],
  ".": [50, 51],
};

export function parseFormula(src: string): FNode {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (v: string) => {
    const t = next();
    if (t.k !== "op" || t.v !== v) throw new FormulaError(t.k === "eof" ? `Expected "${v}" at the end` : `Expected "${v}" at ${t.pos + 1}`);
  };
  const opOf = (t: Tok): string | null => {
    if (t.k === "op") return t.v;
    if (t.k === "id" && /^(and|or)$/i.test(t.v)) return t.v.toLowerCase();
    return null;
  };
  const args = (): FNode[] => {
    const list: FNode[] = [];
    if (peek().k === "op" && peek().v === ")") {
      next();
      return list;
    }
    for (;;) {
      list.push(expr(0));
      const t = next();
      if (t.k === "op" && t.v === ")") return list;
      if (!(t.k === "op" && t.v === ",")) throw new FormulaError(t.k === "eof" ? 'Expected ")" at the end' : `Expected "," or ")" at ${t.pos + 1}`);
    }
  };
  const prefix = (): FNode => {
    const t = next();
    if (t.k === "num") return { t: "num", v: Number(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "id") {
      const low = t.v.toLowerCase();
      if (low === "true" || low === "false") return { t: "bool", v: low === "true" };
      if (low === "not") return { t: "un", op: "!", x: expr(8) };
      if (peek().k === "op" && peek().v === "(") {
        next();
        return { t: "call", name: low, args: args() };
      }
      return { t: "id", name: t.v };
    }
    if (t.k === "op") {
      if (t.v === "(") {
        const e = expr(0);
        expect(")");
        return e;
      }
      if (t.v === "[") {
        const items: FNode[] = [];
        if (peek().k === "op" && peek().v === "]") {
          next();
          return { t: "list", items };
        }
        for (;;) {
          items.push(expr(0));
          const s = next();
          if (s.k === "op" && s.v === "]") return { t: "list", items };
          if (!(s.k === "op" && s.v === ",")) throw new FormulaError(`Expected "," or "]" at ${s.pos + 1}`);
        }
      }
      if (t.v === "-") return { t: "un", op: "-", x: expr(35) };
      if (t.v === "+") return expr(35);
      if (t.v === "!") return { t: "un", op: "!", x: expr(8) };
    }
    if (t.k === "eof") throw new FormulaError("Unexpected end of formula");
    throw new FormulaError(`Unexpected "${t.v}" at ${t.pos + 1}`);
  };
  function expr(minBp: number): FNode {
    let left = prefix();
    for (;;) {
      const t = peek();
      const op = opOf(t);
      if (!op || !(op in INFIX)) break;
      const [lbp, rbp] = INFIX[op];
      if (lbp < minBp) break;
      next();
      if (op === ".") {
        const name = next();
        if (name.k !== "id") throw new FormulaError(`Expected a function name after "." at ${name.pos + 1}`);
        let rest: FNode[] = [];
        if (peek().k === "op" && peek().v === "(") {
          next();
          rest = args();
        }
        left = { t: "call", name: name.v.toLowerCase(), args: [left, ...rest] };
        continue;
      }
      if (op === "?") {
        const a = expr(0);
        expect(":");
        const b = expr(rbp);
        left = { t: "cond", c: left, a, b };
        continue;
      }
      const right = expr(rbp);
      left = { t: "bin", op: op === "=" ? "==" : op === "and" ? "&&" : op === "or" ? "||" : op, a: left, b: right };
    }
    return left;
  }
  if (toks.length === 1) throw new FormulaError("Empty formula");
  const root = expr(0);
  const rest = peek();
  if (rest.k !== "eof") throw new FormulaError(`Unexpected "${rest.v}" at ${rest.pos + 1}`);
  return root;
}

/** Property names a formula reads (prop("…")), for rename and cycle checks. */
export function formulaProps(node: FNode): string[] {
  const out = new Set<string>();
  const walk = (n: FNode) => {
    switch (n.t) {
      case "call":
        if (n.name === "prop" && n.args[0]?.t === "str") out.add(n.args[0].v);
        n.args.forEach(walk);
        break;
      case "list":
        n.items.forEach(walk);
        break;
      case "un":
        walk(n.x);
        break;
      case "bin":
        walk(n.a);
        walk(n.b);
        break;
      case "cond":
        walk(n.c);
        walk(n.a);
        walk(n.b);
        break;
    }
  };
  walk(node);
  return [...out];
}

/** The formula text with prop("old") renamed to prop("new") (property renames). */
export function renamePropInFormula(src: string, from: string, to: string): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return src.replace(/prop\(\s*(["'“«])((?:\\.|(?!\1|”|»).)*)(["'”»])\s*\)/g, (all, _q, name: string) => (name.replace(/\\(.)/g, "$1") === from ? `prop("${esc(to)}")` : all));
}

// ---------------------------------------------------------------------------
// Values

const isDate = (v: FValue): v is FDate => typeof v === "object" && v !== null && !Array.isArray(v) && (v as FDate).kind === "date";

export function typeName(v: FValue): string {
  if (v === null) return "empty";
  if (Array.isArray(v)) return "list";
  if (isDate(v)) return "date";
  return typeof v;
}

function num(v: FValue, fn: string): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new FormulaError(`${fn}: expected a number, got ${typeName(v)}`);
}

function numReq(v: FValue, fn: string): number {
  const n = num(v, fn);
  return n === null ? 0 : n;
}

/** Any value as text ("Due: " + prop("Due") just works). */
function str(v: FValue, _fn: string, locale = "en"): string {
  return typeof v === "string" ? v : toText(v, locale);
}

function list(v: FValue): FValue[] {
  if (v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function date(v: FValue, fn: string): FDate | null {
  if (v === null) return null;
  if (isDate(v)) return v;
  if (typeof v === "string") {
    const d = parseDateText(v);
    if (d) return d;
  }
  throw new FormulaError(`${fn}: expected a date, got ${typeName(v)}`);
}

/** "2026-10-09" or "2026-10-09T14:30" (local time), as stored in date properties. */
export function parseDateText(s: string): FDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (Number.isNaN(d.getTime())) return null;
  return { kind: "date", start: d.getTime(), time: m[4] !== undefined };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A date as a property value string ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"). */
export function dateText(ms: number, time: boolean): string {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

function cleanNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : n < 0 ? "-Infinity" : "NaN";
  // Whole numbers as they are (timestamps have 13 digits).
  if (Number.isSafeInteger(n)) return String(n);
  // Hide float noise (0.1 + 0.2).
  return String(Number.parseFloat(n.toPrecision(12)));
}

export function toText(v: FValue, locale = "en"): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return cleanNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map((x) => toText(x, locale)).join(", ");
  const loc = intlOf(locale);
  const one = (ms: number) => new Date(ms).toLocaleString(loc, { month: "long", day: "numeric", year: "numeric", ...(v.time ? { hour: "numeric", minute: "2-digit" } : {}) });
  return v.end !== undefined ? `${one(v.start)} → ${one(v.end)}` : one(v.start);
}

function truthy(v: FValue): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function isEmpty(v: FValue): boolean {
  if (v === null || v === "" || v === false || v === 0) return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function equal(a: FValue, b: FValue): boolean {
  if (a === null || b === null) return (a === null || a === "") && (b === null || b === "");
  if (isDate(a) && isDate(b)) return a.start === b.start && a.end === b.end;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  return a === b;
}

function compare(a: FValue, b: FValue, op: string): boolean {
  if (a === null || b === null) return false;
  let x: number | string;
  let y: number | string;
  if (isDate(a) && isDate(b)) {
    x = a.start;
    y = b.start;
  } else if (typeof a === "number" && typeof b === "number") {
    x = a;
    y = b;
  } else if (typeof a === "string" && typeof b === "string") {
    x = a;
    y = b;
  } else if (typeof a === "boolean" && typeof b === "boolean") {
    x = Number(a);
    y = Number(b);
  } else throw new FormulaError(`Cannot compare ${typeName(a)} with ${typeName(b)}`);
  switch (op) {
    case ">":
      return x > y;
    case ">=":
      return x >= y;
    case "<":
      return x < y;
    default:
      return x <= y;
  }
}

// ---------------------------------------------------------------------------
// Dates

type Unit = "years" | "quarters" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds" | "milliseconds";

function unitOf(v: FValue, fn: string): Unit {
  const s = str(v, fn).toLowerCase().trim();
  const map: Record<string, Unit> = {
    y: "years", year: "years", years: "years", год: "years", года: "years", лет: "years",
    q: "quarters", quarter: "quarters", quarters: "quarters",
    month: "months", months: "months", месяц: "months", месяца: "months", месяцев: "months",
    w: "weeks", week: "weeks", weeks: "weeks", неделя: "weeks", недели: "weeks", недель: "weeks",
    d: "days", day: "days", days: "days", день: "days", дня: "days", дней: "days",
    h: "hours", hour: "hours", hours: "hours", час: "hours", часа: "hours", часов: "hours",
    m: "minutes", minute: "minutes", minutes: "minutes", минута: "minutes", минуты: "minutes", минут: "minutes",
    s: "seconds", second: "seconds", seconds: "seconds",
    ms: "milliseconds", millisecond: "milliseconds", milliseconds: "milliseconds",
  };
  const u = map[s];
  if (!u) throw new FormulaError(`${fn}: unknown unit "${s}"`);
  return u;
}

/** Months later, keeping to the end of a shorter month (Jan 31 + 1 month = Feb 28, as in Notion). */
function addMonths(d: Date, n: number): void {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
}

function addTo(ms: number, n: number, unit: Unit): number {
  const d = new Date(ms);
  switch (unit) {
    case "years":
      addMonths(d, n * 12);
      break;
    case "quarters":
      addMonths(d, n * 3);
      break;
    case "months":
      addMonths(d, n);
      break;
    case "weeks":
      d.setDate(d.getDate() + n * 7);
      break;
    case "days":
      d.setDate(d.getDate() + n);
      break;
    case "hours":
      return ms + n * 3_600_000;
    case "minutes":
      return ms + n * 60_000;
    case "seconds":
      return ms + n * 1000;
    case "milliseconds":
      return ms + n;
  }
  return d.getTime();
}

/** Wall-clock ms (local fields as UTC) so day counts ignore DST shifts. */
const wall = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
};

function between(a: number, b: number, unit: Unit): number {
  if (unit === "years" || unit === "quarters" || unit === "months") {
    const da = new Date(a);
    const db = new Date(b);
    let months = (da.getFullYear() - db.getFullYear()) * 12 + (da.getMonth() - db.getMonth());
    // Not a full month yet: step back toward zero.
    if (months > 0 && addTo(b, months, "months") > a) months--;
    else if (months < 0 && addTo(b, months, "months") < a) months++;
    return unit === "years" ? Math.trunc(months / 12) : unit === "quarters" ? Math.trunc(months / 3) : months;
  }
  const diff = wall(a) - wall(b);
  const per = { weeks: 604_800_000, days: 86_400_000, hours: 3_600_000, minutes: 60_000, seconds: 1000, milliseconds: 1 }[unit];
  return Math.trunc(diff / per);
}

function isoWeek(ms: number): number {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7);
}

/** Moment-style tokens: YYYY YY MMMM MMM MM M DD D Do dddd ddd HH H hh h mm ss A a [literal]. */
export function formatDate(ms: number, fmt: string, locale = "en"): string {
  const d = new Date(ms);
  const loc = intlOf(locale);
  const hasDay = /D/.test(fmt.replace(/\[[^\]]*\]/g, ""));
  const monthName = (style: "long" | "short") => {
    if (hasDay && locale === "ru") {
      // Russian needs the genitive with a day number ("9 октября").
      const part = new Intl.DateTimeFormat(loc, { day: "numeric", month: style }).formatToParts(d).find((p) => p.type === "month");
      return (part?.value ?? "").replace(/\.$/, "");
    }
    return new Intl.DateTimeFormat(loc, { month: style }).format(d).replace(/\.$/, "");
  };
  const h12 = d.getHours() % 12 || 12;
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => String(d.getFullYear()).slice(-2),
    MMMM: () => monthName("long"),
    MMM: () => monthName("short"),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    Do: () => (locale === "ru" ? `${d.getDate()}-е` : `${d.getDate()}${["th", "st", "nd", "rd"][d.getDate() % 10 > 3 || [11, 12, 13].includes(d.getDate() % 100) ? 0 : d.getDate() % 10]}`),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => d.toLocaleDateString(loc, { weekday: "long" }),
    ddd: () => d.toLocaleDateString(loc, { weekday: "short" }),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    hh: () => pad(h12),
    h: () => String(h12),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    A: () => (d.getHours() < 12 ? "AM" : "PM"),
    a: () => (d.getHours() < 12 ? "am" : "pm"),
    W: () => String(isoWeek(ms)),
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a|W/g, (m, lit: string | undefined) => (lit !== undefined ? lit : (tokens[m]?.() ?? m)));
}

// ---------------------------------------------------------------------------
// Evaluator

type Fn = (args: FValue[], env: FEnv) => FValue;

function round(n: number, places = 0): number {
  const f = 10 ** places;
  return Math.round(n * f + Number.EPSILON * Math.sign(n)) / f;
}

function numbersOf(args: FValue[], fn: string): number[] {
  const out: number[] = [];
  for (const a of args.flatMap(list)) {
    const n = num(a, fn);
    if (n !== null) out.push(n);
  }
  return out;
}

/**
 * The user's pattern through lib/notes/safe-regex.ts: shapes that backtrack
 * exponentially are refused, the server runs patterns in linear time, text is
 * capped — a pattern cannot be stopped once running, and formulas also run
 * on the server for published pages.
 */
function withRegex<T>(src: FValue, flags: string, text: string, fn: string, run: (re: RegExp, text: string) => T): T {
  const s = str(src, fn);
  try {
    return withPattern(s, flags, text, run);
  } catch (e) {
    if (e instanceof PatternError) throw new FormulaError(`${fn}: ${e.message} "${s}"`);
    throw e;
  }
}

const MAX_TEXT = 1_000_000;

const FNS: Record<string, Fn> = {
  // Logic
  not: ([a]) => !truthy(a ?? null),
  empty: ([a]) => isEmpty(a ?? null),
  equal: ([a, b]) => equal(a ?? null, b ?? null),
  unequal: ([a, b]) => !equal(a ?? null, b ?? null),
  larger: ([a, b]) => compare(a ?? null, b ?? null, ">"),
  largereq: ([a, b]) => compare(a ?? null, b ?? null, ">="),
  smaller: ([a, b]) => compare(a ?? null, b ?? null, "<"),
  smallereq: ([a, b]) => compare(a ?? null, b ?? null, "<="),
  // Math
  add: ([a, b], env) => plus(a ?? null, b ?? null, env.locale),
  subtract: ([a, b]) => arith("-", a ?? null, b ?? null),
  multiply: ([a, b]) => arith("*", a ?? null, b ?? null),
  divide: ([a, b]) => arith("/", a ?? null, b ?? null),
  mod: ([a, b]) => arith("%", a ?? null, b ?? null),
  pow: ([a, b]) => arith("^", a ?? null, b ?? null),
  unaryminus: ([a]) => (num(a ?? null, "unaryMinus") === null ? null : -numReq(a ?? null, "unaryMinus")),
  unaryplus: ([a]) => (typeof a === "string" ? toNumber(a) : num(a ?? null, "unaryPlus")),
  abs: ([a]) => mapNum(a, Math.abs, "abs"),
  ceil: ([a]) => mapNum(a, Math.ceil, "ceil"),
  floor: ([a]) => mapNum(a, Math.floor, "floor"),
  sqrt: ([a]) => mapNum(a, Math.sqrt, "sqrt"),
  cbrt: ([a]) => mapNum(a, Math.cbrt, "cbrt"),
  exp: ([a]) => mapNum(a, Math.exp, "exp"),
  ln: ([a]) => mapNum(a, Math.log, "ln"),
  log10: ([a]) => mapNum(a, Math.log10, "log10"),
  log2: ([a]) => mapNum(a, Math.log2, "log2"),
  sign: ([a]) => mapNum(a, Math.sign, "sign"),
  round: ([a, p]) => {
    const n = num(a ?? null, "round");
    return n === null ? null : round(n, p === undefined ? 0 : numReq(p, "round"));
  },
  min: (args) => {
    const ns = numbersOf(args, "min");
    return ns.length ? Math.min(...ns) : null;
  },
  max: (args) => {
    const ns = numbersOf(args, "max");
    return ns.length ? Math.max(...ns) : null;
  },
  sum: (args) => numbersOf(args, "sum").reduce((s, n) => s + n, 0),
  mean: (args) => {
    const ns = numbersOf(args, "mean");
    return ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : null;
  },
  median: (args) => {
    const ns = numbersOf(args, "median").sort((x, y) => x - y);
    if (!ns.length) return null;
    const m = Math.floor(ns.length / 2);
    return ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2;
  },
  pi: () => Math.PI,
  e: () => Math.E,
  tonumber: ([a]) => toNumber(a ?? null),
  // Text
  format: ([a], env) => toText(a ?? null, env.locale),
  length: ([a]) => (Array.isArray(a) ? a.length : str(a ?? null, "length").length),
  concat: (args, env) => (args.some(Array.isArray) ? args.flatMap(list) : args.map((a) => str(a, "concat", env.locale)).join("")),
  join: (args, env) => {
    // join(list, sep) (2.0) or join(sep, a, b, …) (1.0).
    if (Array.isArray(args[0])) return args[0].map((x) => toText(x, env.locale)).join(str(args[1] ?? "", "join"));
    const [sep, ...rest] = args;
    return rest.flatMap(list).map((x) => toText(x, env.locale)).join(str(sep ?? "", "join"));
  },
  lower: ([a]) => str(a ?? null, "lower").toLowerCase(),
  upper: ([a]) => str(a ?? null, "upper").toUpperCase(),
  trim: ([a]) => str(a ?? null, "trim").trim(),
  repeat: ([a, n]) => {
    const s = str(a ?? null, "repeat");
    const k = Math.max(0, Math.min(1000, numReq(n ?? 0, "repeat")));
    // Nested repeats grow a thousandfold each: stop before the tab runs out of memory.
    if (s.length * k > MAX_TEXT) throw new FormulaError("repeat: the text is too long");
    return s.repeat(k);
  },
  padstart: ([a, n, p]) => str(a ?? null, "padStart").padStart(Math.min(1000, numReq(n ?? 0, "padStart")), str(p ?? " ", "padStart")),
  padend: ([a, n, p]) => str(a ?? null, "padEnd").padEnd(Math.min(1000, numReq(n ?? 0, "padEnd")), str(p ?? " ", "padEnd")),
  substring: ([a, s, e]) => str(a ?? null, "substring").substring(numReq(s ?? 0, "substring"), e === undefined ? undefined : numReq(e, "substring")),
  slice: ([a, s, e]) => {
    const st = numReq(s ?? 0, "slice");
    const en = e === undefined ? undefined : numReq(e, "slice");
    return Array.isArray(a) ? a.slice(st, en) : str(a ?? null, "slice").slice(st, en);
  },
  contains: ([a, b]) => (Array.isArray(a) ? a.some((x) => equal(x, b ?? null)) : str(a ?? null, "contains").includes(str(b ?? null, "contains"))),
  includes: ([a, b]) => (Array.isArray(a) ? a.some((x) => equal(x, b ?? null)) : str(a ?? null, "includes").includes(str(b ?? null, "includes"))),
  startswith: ([a, b]) => str(a ?? null, "startsWith").startsWith(str(b ?? null, "startsWith")),
  endswith: ([a, b]) => str(a ?? null, "endsWith").endsWith(str(b ?? null, "endsWith")),
  test: ([a, r]) => withRegex(r ?? "", "", str(a ?? null, "test"), "test", (re, t) => re.test(t)),
  match: ([a, r]) => withRegex(r ?? "", "g", str(a ?? null, "match"), "match", (re, t) => t.match(re)) ?? [],
  replace: ([a, r, s]) => withRegex(r ?? "", "", str(a ?? null, "replace"), "replace", (re, t) => t.replace(re, str(s ?? "", "replace"))),
  replaceall: ([a, r, s]) => withRegex(r ?? "", "g", str(a ?? null, "replaceAll"), "replaceAll", (re, t) => t.replace(re, str(s ?? "", "replaceAll"))),
  split: ([a, sep]) => str(a ?? null, "split").split(str(sep ?? "", "split")),
  link: ([label]) => str(label ?? null, "link"),
  style: ([a]) => a ?? null,
  unstyle: ([a]) => a ?? null,
  // Dates
  now: (_a, env) => ({ kind: "date", start: env.now ?? Date.now(), time: true }),
  today: (_a, env) => {
    const d = new Date(env.now ?? Date.now());
    return { kind: "date", start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), time: false };
  },
  minute: ([a]) => datePart(a, "minute", (d) => d.getMinutes()),
  hour: ([a]) => datePart(a, "hour", (d) => d.getHours()),
  day: ([a]) => datePart(a, "day", (d) => d.getDay() || 7),
  date: ([a]) => datePart(a, "date", (d) => d.getDate()),
  week: ([a]) => {
    const d = date(a ?? null, "week");
    return d ? isoWeek(d.start) : null;
  },
  month: ([a]) => datePart(a, "month", (d) => d.getMonth() + 1),
  year: ([a]) => datePart(a, "year", (d) => d.getFullYear()),
  dateadd: ([a, n, u]) => shift(a, n, u, 1, "dateAdd"),
  datesubtract: ([a, n, u]) => shift(a, n, u, -1, "dateSubtract"),
  datebetween: ([a, b, u]) => {
    const x = date(a ?? null, "dateBetween");
    const y = date(b ?? null, "dateBetween");
    if (!x || !y) return null;
    return between(x.start, y.start, unitOf(u ?? "days", "dateBetween"));
  },
  daterange: ([a, b]) => {
    const x = date(a ?? null, "dateRange");
    const y = date(b ?? null, "dateRange");
    if (!x) return null;
    return { kind: "date", start: x.start, ...(y ? { end: y.start } : {}), time: x.time || Boolean(y?.time) };
  },
  datestart: ([a]) => {
    const d = date(a ?? null, "dateStart");
    return d ? { kind: "date", start: d.start, time: d.time } : null;
  },
  dateend: ([a]) => {
    const d = date(a ?? null, "dateEnd");
    return d ? { kind: "date", start: d.end ?? d.start, time: d.time } : null;
  },
  formatdate: ([a, f], env) => {
    const d = date(a ?? null, "formatDate");
    return d ? formatDate(d.start, str(f ?? "MMMM D, YYYY", "formatDate"), env.locale) : "";
  },
  parsedate: ([a]) => {
    const s = str(a ?? null, "parseDate");
    const d = parseDateText(s);
    if (d) return d;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : { kind: "date", start: t, time: /\d:\d/.test(s) };
  },
  timestamp: ([a]) => {
    const d = date(a ?? null, "timestamp");
    return d ? d.start : null;
  },
  fromtimestamp: ([a]) => {
    const n = num(a ?? null, "fromTimestamp");
    return n === null ? null : { kind: "date", start: n, time: true };
  },
  // Lists
  at: ([a, i]) => {
    const l = list(a ?? null);
    const n = numReq(i ?? 0, "at");
    return l[n < 0 ? l.length + n : n] ?? null;
  },
  first: ([a]) => list(a ?? null)[0] ?? null,
  last: ([a]) => {
    const l = list(a ?? null);
    return l[l.length - 1] ?? null;
  },
  reverse: ([a]) => (Array.isArray(a) ? [...a].reverse() : str(a ?? null, "reverse").split("").reverse().join("")),
  sort: ([a]) =>
    [...list(a ?? null)].sort((x, y) => {
      if (typeof x === "number" && typeof y === "number") return x - y;
      if (isDate(x) && isDate(y)) return x.start - y.start;
      return toText(x).localeCompare(toText(y));
    }),
  unique: ([a]) => {
    const out: FValue[] = [];
    for (const x of list(a ?? null)) if (!out.some((y) => equal(x, y))) out.push(x);
    return out;
  },
  flat: ([a]) => list(a ?? null).flatMap(list),
  // Other
  id: (_a, env) => env.id ?? "",
};

const LAZY = ["prop", "if", "ifs", "and", "or", "let", "lets", "map", "filter", "find", "findindex", "some", "every", "count"];

/** Is this a function name the evaluator knows (any case)? */
export function isKnownFunction(name: string): boolean {
  const n = name.toLowerCase();
  return n in FNS || LAZY.includes(n);
}

/** Function names a formula calls that the evaluator does not know. */
export function unknownFunctions(node: FNode): string[] {
  const out = new Set<string>();
  const walk = (n: FNode) => {
    if (n.t === "call") {
      if (!isKnownFunction(n.name)) out.add(n.name);
      n.args.forEach(walk);
    } else if (n.t === "list") n.items.forEach(walk);
    else if (n.t === "un") walk(n.x);
    else if (n.t === "bin") {
      walk(n.a);
      walk(n.b);
    } else if (n.t === "cond") {
      walk(n.c);
      walk(n.a);
      walk(n.b);
    }
  };
  walk(node);
  return [...out];
}

function toNumber(v: FValue): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isDate(v)) return v.start;
  if (typeof v === "string") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return v.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
}

function mapNum(a: FValue | undefined, f: (n: number) => number, fn: string): FValue {
  const n = num(a ?? null, fn);
  return n === null ? null : f(n);
}

function datePart(a: FValue | undefined, fn: string, f: (d: Date) => number): FValue {
  const d = date(a ?? null, fn);
  return d ? f(new Date(d.start)) : null;
}

function shift(a: FValue | undefined, n: FValue | undefined, u: FValue | undefined, sign: number, fn: string): FValue {
  const d = date(a ?? null, fn);
  if (!d) return null;
  const k = numReq(n ?? 0, fn) * sign;
  const unit = unitOf(u ?? "days", fn);
  return { kind: "date", start: addTo(d.start, k, unit), ...(d.end !== undefined ? { end: addTo(d.end, k, unit) } : {}), time: d.time || ["hours", "minutes", "seconds", "milliseconds"].includes(unit) };
}

function plus(a: FValue, b: FValue, locale = "en"): FValue {
  if (typeof a === "string" || typeof b === "string") return str(a, "+", locale) + str(b, "+", locale);
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  return arith("+", a, b);
}

function arith(op: string, a: FValue, b: FValue): FValue {
  if (a === null && b === null) return null;
  // Empty numbers count as 0 next to a number (Notion).
  const x = numReq(a, op);
  const y = numReq(b, op);
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? null : x / y;
    case "%":
      return y === 0 ? null : x % y;
    default:
      return x ** y;
  }
}

const MAX_STEPS = 200_000;

export function evalFormula(node: FNode, env: FEnv): FValue {
  let steps = 0;
  const vars: Map<string, FValue>[] = [];
  const lookup = (name: string): FValue => {
    for (let i = vars.length - 1; i >= 0; i--) if (vars[i].has(name)) return vars[i].get(name) as FValue;
    throw new FormulaError(`Unknown name "${name}"`);
  };
  const withVars = <T>(scope: Map<string, FValue>, f: () => T): T => {
    vars.push(scope);
    try {
      return f();
    } finally {
      vars.pop();
    }
  };
  const ev = (n: FNode): FValue => {
    if (++steps > MAX_STEPS) throw new FormulaError("Formula is too complex");
    switch (n.t) {
      case "num":
        return n.v;
      case "str":
        return n.v;
      case "bool":
        return n.v;
      case "list":
        return n.items.map(ev);
      case "id":
        return lookup(n.name);
      case "un": {
        const x = ev(n.x);
        if (n.op === "!") return !truthy(x);
        const v = num(x, "-");
        return v === null ? null : -v;
      }
      case "cond":
        return truthy(ev(n.c)) ? ev(n.a) : ev(n.b);
      case "bin": {
        if (n.op === "&&") return truthy(ev(n.a)) && truthy(ev(n.b));
        if (n.op === "||") return truthy(ev(n.a)) || truthy(ev(n.b));
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case "+":
            return plus(a, b, env.locale);
          case "==":
            return equal(a, b);
          case "!=":
            return !equal(a, b);
          case ">":
          case ">=":
          case "<":
          case "<=":
            return compare(a, b, n.op);
          default:
            return arith(n.op, a, b);
        }
      }
      case "call":
        return call(n);
    }
  };
  // Lazy forms (conditions, variables, list callbacks) first, then plain functions.
  const call = (n: Extract<FNode, { t: "call" }>): FValue => {
    const a = n.args;
    switch (n.name) {
      case "prop": {
        if (a.length !== 1) throw new FormulaError('prop: use prop("Name")');
        return env.prop(str(ev(a[0]), "prop"));
      }
      case "if":
        if (a.length < 2) throw new FormulaError("if: needs a condition and a value");
        return truthy(ev(a[0])) ? ev(a[1]) : a[2] ? ev(a[2]) : null;
      case "ifs": {
        for (let i = 0; i + 1 < a.length; i += 2) if (truthy(ev(a[i]))) return ev(a[i + 1]);
        return a.length % 2 ? ev(a[a.length - 1]) : null;
      }
      case "and":
        return a.every((x) => truthy(ev(x)));
      case "or":
        return a.some((x) => truthy(ev(x)));
      case "let": {
        if (a.length !== 3 || a[0].t !== "id") throw new FormulaError("let: use let(name, value, expression)");
        const scope = new Map<string, FValue>([[a[0].name, ev(a[1])]]);
        return withVars(scope, () => ev(a[2]));
      }
      case "lets": {
        if (a.length < 3 || a.length % 2 === 0) throw new FormulaError("lets: use lets(a, 1, b, 2, expression)");
        const scope = new Map<string, FValue>();
        return withVars(scope, () => {
          for (let i = 0; i + 1 < a.length; i += 2) {
            const id = a[i];
            if (id.t !== "id") throw new FormulaError("lets: names must be plain words");
            scope.set(id.name, ev(a[i + 1]));
          }
          return ev(a[a.length - 1]);
        });
      }
      case "map":
      case "filter":
      case "find":
      case "findindex":
      case "some":
      case "every":
      case "count": {
        const items = list(ev(a[0] ?? { t: "list", items: [] }));
        const body = a[1];
        if (!body) return n.name === "count" ? items.filter(truthy).length : items;
        const run = (x: FValue, i: number) => withVars(new Map<string, FValue>([["current", x], ["index", i]]), () => ev(body));
        switch (n.name) {
          case "map":
            return items.map(run);
          case "filter":
            return items.filter((x, i) => truthy(run(x, i)));
          case "find":
            return items.find((x, i) => truthy(run(x, i))) ?? null;
          case "findindex":
            return items.findIndex((x, i) => truthy(run(x, i)));
          case "some":
            return items.some((x, i) => truthy(run(x, i)));
          case "every":
            return items.every((x, i) => truthy(run(x, i)));
          default:
            return items.filter((x, i) => truthy(run(x, i))).length;
        }
      }
    }
    const fn = FNS[n.name];
    if (!fn) throw new FormulaError(`Unknown function "${n.name}"`);
    return fn(a.map(ev), env);
  };
  return ev(node);
}

/** The functions the editor lists, with a signature and a one-line help. */
export interface FormulaFuncDoc {
  name: string;
  group: "props" | "logic" | "math" | "text" | "date" | "list";
  sig: string;
  en: string;
  ru: string;
}

export const FORMULA_DOCS: FormulaFuncDoc[] = [
  { name: "if", group: "logic", sig: "if(condition, then, else)", en: "A value depending on a condition.", ru: "Значение в зависимости от условия." },
  { name: "ifs", group: "logic", sig: "ifs(cond1, value1, cond2, value2, …, else)", en: "The value of the first true condition.", ru: "Значение первого истинного условия." },
  { name: "empty", group: "logic", sig: "empty(value)", en: "True if the value is empty.", ru: "Истина, если значение пустое." },
  { name: "and", group: "logic", sig: "a and b", en: "True if both are true.", ru: "Истина, если оба условия истинны." },
  { name: "or", group: "logic", sig: "a or b", en: "True if either is true.", ru: "Истина, если хотя бы одно истинно." },
  { name: "not", group: "logic", sig: "not value", en: "The opposite of a condition.", ru: "Отрицание условия." },
  { name: "let", group: "logic", sig: "let(name, value, expression)", en: "Names a value to reuse.", ru: "Даёт значению имя для повторного использования." },
  { name: "round", group: "math", sig: "round(number, places)", en: "Rounds a number.", ru: "Округляет число." },
  { name: "sum", group: "math", sig: "sum(a, b, …)", en: "Adds numbers (lists too).", ru: "Сумма чисел (и списков)." },
  { name: "mean", group: "math", sig: "mean(a, b, …)", en: "The average.", ru: "Среднее значение." },
  { name: "median", group: "math", sig: "median(a, b, …)", en: "The middle value.", ru: "Медиана." },
  { name: "min", group: "math", sig: "min(a, b, …)", en: "The smallest number.", ru: "Наименьшее число." },
  { name: "max", group: "math", sig: "max(a, b, …)", en: "The largest number.", ru: "Наибольшее число." },
  { name: "abs", group: "math", sig: "abs(number)", en: "The absolute value.", ru: "Модуль числа." },
  { name: "ceil", group: "math", sig: "ceil(number)", en: "Rounds up.", ru: "Округление вверх." },
  { name: "floor", group: "math", sig: "floor(number)", en: "Rounds down.", ru: "Округление вниз." },
  { name: "sqrt", group: "math", sig: "sqrt(number)", en: "The square root.", ru: "Квадратный корень." },
  { name: "pow", group: "math", sig: "pow(base, exponent) or a ^ b", en: "Raises to a power.", ru: "Возведение в степень." },
  { name: "mod", group: "math", sig: "mod(a, b) or a % b", en: "The remainder.", ru: "Остаток от деления." },
  { name: "toNumber", group: "math", sig: "toNumber(value)", en: "Turns text or a date into a number.", ru: "Превращает текст или дату в число." },
  { name: "format", group: "text", sig: "format(value)", en: "Turns any value into text.", ru: "Превращает значение в текст." },
  { name: "length", group: "text", sig: "length(text or list)", en: "The number of characters or items.", ru: "Число символов или элементов." },
  { name: "concat", group: "text", sig: "concat(a, b, …)", en: "Joins texts or lists.", ru: "Склеивает тексты или списки." },
  { name: "join", group: "text", sig: "join(list, separator)", en: "Joins a list with a separator.", ru: "Склеивает список через разделитель." },
  { name: "contains", group: "text", sig: "contains(text, part)", en: "True if the text has the part.", ru: "Истина, если текст содержит часть." },
  { name: "replace", group: "text", sig: "replace(text, pattern, with)", en: "Replaces the first match.", ru: "Заменяет первое совпадение." },
  { name: "replaceAll", group: "text", sig: "replaceAll(text, pattern, with)", en: "Replaces every match.", ru: "Заменяет все совпадения." },
  { name: "lower", group: "text", sig: "lower(text)", en: "Lowercase.", ru: "Строчные буквы." },
  { name: "upper", group: "text", sig: "upper(text)", en: "Uppercase.", ru: "Прописные буквы." },
  { name: "trim", group: "text", sig: "trim(text)", en: "Removes spaces at the ends.", ru: "Убирает пробелы по краям." },
  { name: "slice", group: "text", sig: "slice(text, start, end)", en: "Part of a text or list.", ru: "Часть текста или списка." },
  { name: "split", group: "text", sig: "split(text, separator)", en: "Splits text into a list.", ru: "Делит текст на список." },
  { name: "test", group: "text", sig: "test(text, pattern)", en: "True if the pattern matches.", ru: "Истина, если шаблон совпадает." },
  { name: "repeat", group: "text", sig: "repeat(text, times)", en: "Repeats a text.", ru: "Повторяет текст." },
  { name: "now", group: "date", sig: "now()", en: "The current date and time.", ru: "Текущие дата и время." },
  { name: "today", group: "date", sig: "today()", en: "Today's date.", ru: "Сегодняшняя дата." },
  { name: "dateAdd", group: "date", sig: 'dateAdd(date, 3, "days")', en: "Adds time to a date.", ru: "Прибавляет время к дате." },
  { name: "dateSubtract", group: "date", sig: 'dateSubtract(date, 1, "months")', en: "Subtracts time from a date.", ru: "Вычитает время из даты." },
  { name: "dateBetween", group: "date", sig: 'dateBetween(a, b, "days")', en: "Time between two dates.", ru: "Время между двумя датами." },
  { name: "formatDate", group: "date", sig: 'formatDate(date, "D MMMM YYYY")', en: "A date as text.", ru: "Дата в виде текста." },
  { name: "dateStart", group: "date", sig: "dateStart(date)", en: "The start of a date range.", ru: "Начало диапазона дат." },
  { name: "dateEnd", group: "date", sig: "dateEnd(date)", en: "The end of a date range.", ru: "Конец диапазона дат." },
  { name: "dateRange", group: "date", sig: "dateRange(start, end)", en: "A date range.", ru: "Диапазон дат." },
  { name: "year", group: "date", sig: "year(date)", en: "The year.", ru: "Год." },
  { name: "month", group: "date", sig: "month(date)", en: "The month (1–12).", ru: "Месяц (1–12)." },
  { name: "date", group: "date", sig: "date(date)", en: "The day of the month.", ru: "День месяца." },
  { name: "day", group: "date", sig: "day(date)", en: "The weekday (1 = Monday).", ru: "День недели (1 = понедельник)." },
  { name: "week", group: "date", sig: "week(date)", en: "The ISO week number.", ru: "Номер недели (ISO)." },
  { name: "timestamp", group: "date", sig: "timestamp(date)", en: "Milliseconds since 1970.", ru: "Миллисекунды с 1970 года." },
  { name: "map", group: "list", sig: "map(list, current * 2)", en: "Changes every item (current, index).", ru: "Меняет каждый элемент (current, index)." },
  { name: "filter", group: "list", sig: "filter(list, current > 1)", en: "Keeps the matching items.", ru: "Оставляет подходящие элементы." },
  { name: "find", group: "list", sig: "find(list, condition)", en: "The first matching item.", ru: "Первый подходящий элемент." },
  { name: "some", group: "list", sig: "some(list, condition)", en: "True if any item matches.", ru: "Истина, если подходит хоть один." },
  { name: "every", group: "list", sig: "every(list, condition)", en: "True if all items match.", ru: "Истина, если подходят все." },
  { name: "count", group: "list", sig: "count(list, condition)", en: "How many items match.", ru: "Сколько элементов подходит." },
  { name: "first", group: "list", sig: "first(list)", en: "The first item.", ru: "Первый элемент." },
  { name: "last", group: "list", sig: "last(list)", en: "The last item.", ru: "Последний элемент." },
  { name: "at", group: "list", sig: "at(list, index)", en: "The item at a position (from 0).", ru: "Элемент по номеру (с 0)." },
  { name: "sort", group: "list", sig: "sort(list)", en: "Sorts a list.", ru: "Сортирует список." },
  { name: "unique", group: "list", sig: "unique(list)", en: "Drops repeated items.", ru: "Убирает повторы." },
  { name: "reverse", group: "list", sig: "reverse(list)", en: "Reverses a list.", ru: "Переворачивает список." },
];
