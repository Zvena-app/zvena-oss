// Patterns that people type into formulas (test, match, replace, replaceAll)
// run wherever the formula is computed: in the browser, and on the server for
// published pages (anyone may open one) and background readers. A JavaScript
// pattern cannot be stopped once it runs, so a slow one would stall the
// whole server process. Three layers keep that from happening:
//
//  1. checkPattern(): a small parser refuses the shapes that backtrack
//     exponentially — back-references, alternation or nested groups under a
//     repetition ((a|a)+, (\w|\d)*, ((ab)+c)*), and repeated groups whose
//     repeated parts are not cut apart by a different character ((a+)+,
//     (a+a)+, (.+,)*). Ordinary patterns such as ^(\d+,)*\d+$ pass.
//  2. On the server the pattern is compiled for V8's linear-time engine
//     (the "l" flag, enabled once at first use), so even polynomial shapes
//     such as \w*\w*\w*! stay linear. A pattern the linear engine cannot run
//     (lookarounds) runs only when it has at most one repetition, on a
//     shorter text.
//  3. Text length is capped, and a pattern that once took too long is
//     refused for a while.
// No dependency: re2 would need a native build.

export class PatternError extends Error {}

export const MAX_PATTERN = 300;
/** Longest text a pattern is run on. */
export const MAX_INPUT = 20_000;
/** Longest text for a pattern the linear engine cannot run. */
export const MAX_INPUT_BACKTRACKING = 2_000;

const SLOW_MS = 50;
const BLOCK_MS = 5 * 60_000;

// --- 1. Shape check -----------------------------------------------------------

/** What one atom of a pattern can match, coarsely (for "are these two disjoint?"). */
type CharTest = (c: string) => boolean;

interface Atom {
  /** Single-character atoms: what they match (undefined for groups, anchors, lookarounds). */
  test?: CharTest;
  group?: GroupInfo;
  /** Repeated (min..max with max > 1), or optional (?). */
  quant: "none" | "optional" | "repeat";
}

interface GroupInfo {
  atoms: Atom[];
  alternation: boolean;
  /** Anything inside is repeated or optional (directly or in a nested group). */
  repeats: boolean;
  nestedGroups: boolean;
  lookaround: boolean;
}

const ANY: CharTest = () => true;
const DIGIT: CharTest = (c) => c >= "0" && c <= "9";
const WORD: CharTest = (c) => /\w/.test(c);
const SPACE: CharTest = (c) => /\s/.test(c);
const not = (t: CharTest): CharTest => (c) => !t(c);

// Representative characters for the overlap check: all of ASCII and a few others.
const SAMPLE: string[] = [...Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)), " ", "é", "я", "中", " ", "😀"];

function overlaps(a: CharTest, b: CharTest): boolean {
  return SAMPLE.some((c) => a(c) && b(c));
}

function escapeTest(ch: string): CharTest {
  switch (ch) {
    case "d":
      return DIGIT;
    case "D":
      return not(DIGIT);
    case "w":
      return WORD;
    case "W":
      return not(WORD);
    case "s":
      return SPACE;
    case "S":
      return not(SPACE);
    case "n":
      return (c) => c === "\n";
    case "t":
      return (c) => c === "\t";
    case "r":
      return (c) => c === "\r";
    case "x":
    case "u":
    case "c":
    case "p":
    case "P":
      return ANY; // a code we don't decode here: assume it may match anything
    default:
      return (c) => c === ch;
  }
}

/** Parses a bracket class starting after "[" ; returns its test and the index after "]". */
function bracket(s: string, i: number): { test: CharTest; end: number } {
  let negated = false;
  if (s[i] === "^") {
    negated = true;
    i++;
  }
  const parts: CharTest[] = [];
  // In JavaScript "[]" is an empty class: the first "]" always closes.
  while (i < s.length && s[i] !== "]") {
    let lo: string | CharTest;
    if (s[i] === "\\") {
      const e = s[i + 1] ?? "";
      i += 2;
      lo = "dDwWsS".includes(e) ? escapeTest(e) : e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : "xucpP".includes(e) ? ANY : e;
    } else lo = s[i++];
    if (typeof lo === "string" && s[i] === "-" && s[i + 1] !== undefined && s[i + 1] !== "]") {
      let hi = s[i + 1];
      i += 2;
      if (hi === "\\") {
        hi = s[i] ?? "";
        i++;
      }
      const a = lo;
      parts.push((c) => c >= a && c <= hi);
    } else if (typeof lo === "string") {
      const a = lo;
      parts.push((c) => c === a);
    } else parts.push(lo);
  }
  const t: CharTest = (c) => parts.some((p) => p(c));
  return { test: negated ? not(t) : t, end: i + 1 };
}

/** Reads a quantifier at s[i] ("*", "+", "?", "{n}", "{n,}", "{n,m}" and a lazy "?"). */
function quantifier(s: string, i: number): { quant: Atom["quant"]; end: number } | null {
  const c = s[i];
  let quant: Atom["quant"];
  let end: number;
  if (c === "*" || c === "+") {
    quant = "repeat";
    end = i + 1;
  } else if (c === "?") {
    quant = "optional";
    end = i + 1;
  } else if (c === "{") {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i, i + 24));
    if (!m) return null; // a literal "{"
    const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
    quant = max > 1 ? "repeat" : max === 1 && Number(m[1]) === 0 ? "optional" : "none";
    end = i + m[0].length;
  } else return null;
  if (s[end] === "?") end++;
  return { quant, end };
}

/**
 * Throws PatternError when the pattern has a shape that can backtrack
 * exponentially. Returns how many repetitions it has and whether it uses
 * lookarounds (for the server's choice of engine).
 */
export function checkPattern(s: string): { repeats: number; lookaround: boolean } {
  if (s.length > MAX_PATTERN) throw new PatternError(`pattern too long (at most ${MAX_PATTERN} characters)`);
  const stack: GroupInfo[] = [{ atoms: [], alternation: false, repeats: false, nestedGroups: false, lookaround: false }];
  let repeats = 0;
  let lookaround = false;
  let i = 0;
  const top = () => stack[stack.length - 1];
  const push = (a: Atom) => top().atoms.push(a);
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const e = s[i + 1] ?? "";
      if (/[1-9]/.test(e) || e === "k") throw new PatternError("back-references are not supported");
      i += 2;
      if (e === "b" || e === "B") push({ quant: "none" });
      else push({ test: escapeTest(e), quant: "none" });
    } else if (c === "[") {
      const b = bracket(s, i + 1);
      push({ test: b.test, quant: "none" });
      i = b.end;
    } else if (c === "(") {
      let look = false;
      if (s.startsWith("(?=", i) || s.startsWith("(?!", i)) {
        look = true;
        i += 3;
      } else if (s.startsWith("(?<=", i) || s.startsWith("(?<!", i)) {
        look = true;
        i += 4;
      } else if (s.startsWith("(?:", i)) i += 3;
      else if (s.startsWith("(?<", i)) {
        const close = s.indexOf(">", i);
        i = close < 0 ? s.length : close + 1;
      } else i += 1;
      if (look) lookaround = true;
      stack.push({ atoms: [], alternation: false, repeats: false, nestedGroups: false, lookaround: look });
    } else if (c === ")") {
      if (stack.length === 1) throw new PatternError("unbalanced parenthesis");
      const g = stack.pop() as GroupInfo;
      const parent = top();
      parent.nestedGroups = true;
      if (g.repeats) parent.repeats = true;
      if (g.alternation) parent.alternation = true;
      push({ group: g, quant: "none" });
      i++;
    } else if (c === "|") {
      top().alternation = true;
      i++;
    } else if (c === "^" || c === "$") {
      push({ quant: "none" });
      i++;
    } else {
      const q = quantifier(s, i);
      if (q) {
        const atoms = top().atoms;
        const prev = atoms[atoms.length - 1];
        if (!prev) throw new PatternError("nothing to repeat");
        if (q.quant !== "none") {
          if (prev.quant !== "none") throw new PatternError("pattern too slow (a repetition of a repetition)");
          prev.quant = q.quant;
          top().repeats = true;
          if (q.quant === "repeat") {
            repeats++;
            if (prev.group) refuseAmbiguousRepeat(prev.group);
          }
        }
        i = q.end;
      } else {
        push({ test: c === "." ? (x) => x !== "\n" && x !== "\r" : (x) => x === c, quant: "none" });
        i++;
      }
    }
  }
  if (stack.length !== 1) throw new PatternError("unbalanced parenthesis");
  return { repeats, lookaround };
}

/**
 * A repeated group may hold repetitions only when each of them is followed,
 * inside the group, by a single character that it cannot match itself —
 * (\d+,)* is fine, (a+)+, (a+a)+ and (.+,)* are not. No alternation and no
 * nested groups with anything repeated or alternated.
 */
function refuseAmbiguousRepeat(g: GroupInfo): void {
  const slow = () => new PatternError("pattern too slow (a repeated group that can match the same text in many ways)");
  if (g.alternation) throw slow();
  if (!g.repeats) return;
  const atoms = g.atoms;
  for (let k = 0; k < atoms.length; k++) {
    const a = atoms[k];
    if (a.group && (a.group.repeats || a.group.alternation || a.quant !== "none")) throw slow();
    if (a.quant === "none") continue;
    const next = atoms[k + 1];
    if (!a.test || !next || !next.test || next.quant !== "none" || overlaps(a.test, next.test)) throw slow();
  }
}

// --- 2./3. Running ------------------------------------------------------------

let linear: boolean | null = null;

/** The server turns on V8's linear-time engine once; browsers don't have it. */
function linearEngine(): boolean {
  if (linear !== null) return linear;
  linear = false;
  if (typeof window !== "undefined") return linear;
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const v8 = proc?.getBuiltinModule?.("node:v8") as { setFlagsFromString?: (f: string) => void } | undefined;
    v8?.setFlagsFromString?.("--enable-experimental-regexp-engine");
    new RegExp("a", "l");
    linear = true;
  } catch {
    linear = false;
  }
  return linear;
}

const compiled = new Map<string, { re: RegExp; maxInput: number }>();
const slowUntil = new Map<string, number>();

/** A RegExp for a user's pattern (flags "" or "g"), or PatternError. */
export function safeRegExp(src: string, flags = ""): { re: RegExp; maxInput: number } {
  const key = `${flags}/${src}`;
  const blocked = slowUntil.get(key);
  if (blocked !== undefined) {
    if (Date.now() < blocked) throw new PatternError("pattern too slow (it took too long on this text before)");
    slowUntil.delete(key);
  }
  const hit = compiled.get(key);
  if (hit) {
    hit.re.lastIndex = 0;
    return hit;
  }
  const shape = checkPattern(src);
  let out: { re: RegExp; maxInput: number } | null = null;
  if (linearEngine()) {
    try {
      out = { re: new RegExp(src, flags + "l"), maxInput: MAX_INPUT };
    } catch {
      // Lookarounds: the linear engine can't run them; see below.
    }
  }
  if (!out) {
    let re: RegExp;
    try {
      re = new RegExp(src, flags);
    } catch {
      throw new PatternError("invalid pattern");
    }
    if (linear && shape.repeats > 1) throw new PatternError("pattern too complex (lookarounds with more than one repetition)");
    out = { re, maxInput: linear ? MAX_INPUT_BACKTRACKING : MAX_INPUT };
  }
  if (compiled.size > 500) compiled.clear();
  compiled.set(key, out);
  return out;
}

/** Runs fn(re) on `text` for a user's pattern, with the length cap and the slow-pattern brake. */
export function withPattern<T>(src: string, flags: string, text: string, fn: (re: RegExp, text: string) => T): T {
  const { re, maxInput } = safeRegExp(src, flags);
  if (text.length > maxInput) throw new PatternError(`text too long for a pattern (at most ${maxInput} characters)`);
  const t0 = Date.now();
  try {
    return fn(re, text);
  } finally {
    if (Date.now() - t0 > SLOW_MS) {
      if (slowUntil.size > 500) slowUntil.clear();
      slowUntil.set(`${flags}/${src}`, Date.now() + BLOCK_MS);
    }
  }
}
