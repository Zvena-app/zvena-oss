// zvena Documents: a small syntax highlighter for code blocks (Notion colors
// code by language). A single-pass scanner per language family — comments,
// strings, numbers, keywords, functions, types, tags — good enough to read
// code at a glance, with no dependency. Pure: returns token ranges.

export type TokenClass = "comment" | "string" | "number" | "keyword" | "function" | "type" | "tag" | "attr" | "prop" | "builtin";
export interface Token {
  from: number;
  to: number;
  cls: TokenClass;
}

interface Spec {
  line?: string[];
  block?: [string, string][];
  strings?: string[];
  keywords?: Set<string>;
  /** Keywords match case-insensitively (SQL). */
  ci?: boolean;
  /** Capitalized names read as types. */
  types?: boolean;
  /** "key": → property (JSON, YAML keys). */
  keys?: boolean;
  kind?: "markup" | "css" | "markdown";
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE = words(`abstract as async await auto bool boolean break byte case catch char class const constexpr continue
  debugger def default defer delete do double dyn else enum explicit export extends extern final finally float fn for foreach
  from func function get go goto if impl implements import in include inline instanceof int interface internal is keyof let long
  loop match mod module mut namespace new nullptr of object operator override package private protected pub public readonly ref
  return sealed set short signed sizeof static struct super switch synchronized template this throw throws trait try type typedef
  typename typeof union unsafe unsigned use using val var virtual void volatile when where while with yield echo elseif declare
  crate self string number any unknown never`);
const PYTHON = words(`and as assert async await break class continue def del elif else except finally for from global if import in
  is lambda nonlocal not or pass raise return try while with yield match case self`);
const SHELL = words(`if then else elif fi for in do done while until case esac function return local export echo exit set unset
  source alias cd read shift trap sudo`);
const SQL = words(`select from where and or not insert into values update set delete create table drop alter add join left right
  inner outer full cross on as group by order having limit offset distinct union all case when then else end is in between like
  exists primary key foreign references index view default asc desc count sum avg min max with returning begin commit rollback`);
const RUBY = words(`def end class module if elsif else unless while until for in do return yield begin rescue ensure raise require
  attr_accessor attr_reader self then case when puts lambda proc`);
const LUA = words(`and break do else elseif end for function goto if in local not or repeat return then until while`);
const R = words(`if else repeat while function for in next break library require return`);
const HASKELL = words(`case class data deriving do else if import in infix instance let module newtype of then type where`);
const PASCAL = words(`and array begin case const div do downto else end file for function goto if in label mod nil not of or
  procedure program record repeat set then to type until var while with uses writeln readln integer real boolean string`);
const MATLAB = words(`break case catch continue else elseif end for function global if otherwise parfor persistent return switch
  try while disp`);
const POWERSHELL = words(`begin break catch class continue data define do dynamicparam else elseif end exit filter finally for
  foreach from function if in param process return switch throw trap try until using var while`);
const LITERALS = words(`true false null undefined None True False nil NaN Infinity TRUE FALSE NULL`);

const SPECS: Record<string, Spec> = {
  javascript: { line: ["//"], block: [["/*", "*/"]], strings: ["'", '"', "`"], keywords: C_LIKE, types: true },
  c: { line: ["//"], block: [["/*", "*/"]], strings: ["'", '"'], keywords: C_LIKE, types: true },
  go: { line: ["//"], block: [["/*", "*/"]], strings: ["'", '"', "`"], keywords: C_LIKE, types: true },
  python: { line: ["#"], strings: ["'", '"'], keywords: PYTHON, types: true },
  bash: { line: ["#"], strings: ["'", '"'], keywords: SHELL },
  ruby: { line: ["#"], strings: ["'", '"'], keywords: RUBY, types: true },
  r: { line: ["#"], strings: ["'", '"'], keywords: R },
  powershell: { line: ["#"], block: [["<#", "#>"]], strings: ["'", '"'], keywords: POWERSHELL, ci: true },
  sql: { line: ["--"], block: [["/*", "*/"]], strings: ["'", '"'], keywords: SQL, ci: true },
  lua: { line: ["--"], strings: ["'", '"'], keywords: LUA },
  haskell: { line: ["--"], block: [["{-", "-}"]], strings: ['"'], keywords: HASKELL, types: true },
  pascal: { line: ["//"], block: [["{", "}"], ["(*", "*)"]], strings: ["'"], keywords: PASCAL, ci: true },
  matlab: { line: ["%"], strings: ["'", '"'], keywords: MATLAB },
  latex: { line: ["%"], strings: [] },
  yaml: { line: ["#"], strings: ["'", '"'], keys: true },
  json: { strings: ['"'], keys: true },
  dockerfile: { line: ["#"], strings: ["'", '"'], keywords: words("FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD AS"), ci: false },
  graphql: { line: ["#"], strings: ['"'], keywords: words("query mutation subscription fragment on type input enum interface union schema scalar extend implements directive"), types: true },
  html: { kind: "markup" },
  css: { kind: "css" },
  markdown: { kind: "markdown" },
};
// Languages that read like another.
const SAME: Record<string, string> = {
  typescript: "javascript", java: "javascript", kotlin: "javascript", swift: "javascript", dart: "javascript", scala: "javascript",
  csharp: "javascript", php: "javascript", cpp: "c", rust: "javascript", xml: "html", scss: "css",
};

const isIdStart = (c: string) => /[A-Za-z_$À-￿]/.test(c);
const isId = (c: string) => /[\w$À-￿]/.test(c);
const MAX = 20_000;

/** Tokens of `code` in `language` (unknown languages and very long code: none). */
export function tokenize(code: string, language: string | undefined): Token[] {
  const lang = (language ?? "").toLowerCase();
  const spec = SPECS[SAME[lang] ?? lang];
  if (!spec || !code || code.length > MAX) return [];
  if (spec.kind === "markup") return markup(code);
  if (spec.kind === "css") return css(code);
  if (spec.kind === "markdown") return markdown(code);
  return generic(code, spec);
}

function generic(code: string, spec: Spec): Token[] {
  const out: Token[] = [];
  const n = code.length;
  let i = 0;
  const nextNonSpace = (j: number) => {
    while (j < n && (code[j] === " " || code[j] === "\t")) j++;
    return code[j];
  };
  outer: while (i < n) {
    for (const lc of spec.line ?? []) {
      if (code.startsWith(lc, i)) {
        let j = code.indexOf("\n", i);
        if (j < 0) j = n;
        out.push({ from: i, to: j, cls: "comment" });
        i = j;
        continue outer;
      }
    }
    for (const [a, b] of spec.block ?? []) {
      if (code.startsWith(a, i)) {
        let j = code.indexOf(b, i + a.length);
        j = j < 0 ? n : j + b.length;
        out.push({ from: i, to: j, cls: "comment" });
        i = j;
        continue outer;
      }
    }
    const ch = code[i];
    if (spec.strings?.includes(ch)) {
      const triple = code.startsWith(ch.repeat(3), i) && (ch === '"' || ch === "'");
      const close = triple ? ch.repeat(3) : ch;
      let j = i + close.length;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code.startsWith(close, j)) {
          j += close.length;
          break;
        }
        // Plain quotes end at the line's end (backticks and triples span lines).
        if (code[j] === "\n" && !triple && ch !== "`") break;
        j++;
      }
      const end = Math.min(j, n);
      out.push({ from: i, to: end, cls: spec.keys && nextNonSpace(end) === ":" ? "prop" : "string" });
      i = end;
      continue;
    }
    if (/\d/.test(ch) && (i === 0 || !isId(code[i - 1]))) {
      const m = /^(0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(code.slice(i, i + 64));
      if (m) {
        out.push({ from: i, to: i + m[0].length, cls: "number" });
        i += m[0].length;
        continue;
      }
    }
    if (isIdStart(ch)) {
      let j = i + 1;
      while (j < n && isId(code[j])) j++;
      const word = code.slice(i, j);
      const key = spec.ci ? word.toLowerCase() : word;
      let cls: TokenClass | null = null;
      if (LITERALS.has(word)) cls = "builtin";
      else if (spec.keywords?.has(key) || (spec.ci && spec.keywords?.has(word.toUpperCase()))) cls = "keyword";
      else if (spec.keys && nextNonSpace(j) === ":" && /^\s*$/.test(code.slice(code.lastIndexOf("\n", i - 1) + 1, i).replace(/-\s*$/, ""))) cls = "prop";
      else if (nextNonSpace(j) === "(") cls = "function";
      else if (spec.types && /^[A-Z][a-z]/.test(word)) cls = "type";
      if (cls) out.push({ from: i, to: j, cls });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function markup(code: string): Token[] {
  const out: Token[] = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    if (code.startsWith("<!--", i)) {
      let j = code.indexOf("-->", i + 4);
      j = j < 0 ? n : j + 3;
      out.push({ from: i, to: j, cls: "comment" });
      i = j;
      continue;
    }
    if (code[i] === "<" && /[A-Za-z/!?]/.test(code[i + 1] ?? "")) {
      let j = i + 1;
      if (code[j] === "/" || code[j] === "!" || code[j] === "?") j++;
      const s = j;
      while (j < n && /[\w:.-]/.test(code[j])) j++;
      if (j > s) out.push({ from: s, to: j, cls: "tag" });
      // Attributes up to the tag's end.
      while (j < n && code[j] !== ">") {
        if (code[j] === '"' || code[j] === "'") {
          const q = code[j];
          let k = code.indexOf(q, j + 1);
          k = k < 0 ? n : k + 1;
          out.push({ from: j, to: k, cls: "string" });
          j = k;
          continue;
        }
        if (/[A-Za-z_:@]/.test(code[j])) {
          const a = j;
          while (j < n && /[\w:.@-]/.test(code[j])) j++;
          out.push({ from: a, to: j, cls: "attr" });
          continue;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function css(code: string): Token[] {
  const out: Token[] = [];
  const n = code.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const ch = code[i];
    if (code.startsWith("/*", i)) {
      let j = code.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      out.push({ from: i, to: j, cls: "comment" });
      i = j;
      continue;
    }
    if (code.startsWith("//", i) && depth >= 0 && (i === 0 || /\s/.test(code[i - 1]))) {
      let j = code.indexOf("\n", i);
      if (j < 0) j = n;
      out.push({ from: i, to: j, cls: "comment" });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = code.indexOf(ch, i + 1);
      j = j < 0 ? n : j + 1;
      out.push({ from: i, to: j, cls: "string" });
      i = j;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "@" || (ch === "#" && depth > 0)) {
      let j = i + 1;
      while (j < n && /[\w-]/.test(code[j])) j++;
      out.push({ from: i, to: j, cls: ch === "@" ? "keyword" : "number" });
      i = j;
      continue;
    }
    if (/\d/.test(ch) && depth > 0 && (i === 0 || !/[\w-]/.test(code[i - 1]))) {
      const m = /^\d*\.?\d+(px|em|rem|%|vh|vw|s|ms|deg|fr)?/.exec(code.slice(i, i + 32));
      if (m) {
        out.push({ from: i, to: i + m[0].length, cls: "number" });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z-]/.test(ch) && (i === 0 || !/[\w-]/.test(code[i - 1]))) {
      let j = i + 1;
      while (j < n && /[\w-]/.test(code[j])) j++;
      let k = j;
      while (k < n && (code[k] === " " || code[k] === "\t")) k++;
      if (depth > 0 && code[k] === ":") out.push({ from: i, to: j, cls: "prop" });
      else if (depth === 0) out.push({ from: i, to: j, cls: "tag" });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function markdown(code: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  for (const line of code.split("\n")) {
    if (/^#{1,6}\s/.test(line)) out.push({ from: pos, to: pos + line.length, cls: "keyword" });
    else {
      const re = /`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)/g;
      for (let m = re.exec(line); m; m = re.exec(line)) out.push({ from: pos + m.index, to: pos + m.index + m[0].length, cls: m[0][0] === "`" ? "string" : "function" });
    }
    pos += line.length + 1;
  }
  return out;
}
