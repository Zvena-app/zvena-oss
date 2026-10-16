// zvena Documents: what changed between two versions of a page (Page
// history highlights). Pure: blocks are compared as a flat list (nesting
// kept as depth), matched by block id first, then by identical text;
// a block whose text changed gets a word-level diff.

export interface FlatBlock {
  id?: string;
  type: string;
  text: string;
  depth: number;
  props: Record<string, unknown>;
}

export type WordOp = { op: "same" | "add" | "del"; text: string };

export interface BlockDiff {
  status: "same" | "added" | "removed" | "changed";
  /** The block as it is in the newer version (the older one for "removed"). */
  block: FlatBlock;
  /** "changed": the block in the older version. */
  old?: FlatBlock;
  /** "changed" with different text: the words added and removed. */
  words?: WordOp[];
}

interface Inline {
  type?: string;
  text?: string;
  content?: unknown;
  props?: Record<string, unknown>;
}

/** Plain text of BlockNote inline content (links, mentions and equations read as their text). */
export function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    // A table: its cells, row by row.
    const t = content as { type?: string; rows?: { cells?: unknown[] }[] } | null;
    if (t && t.type === "tableContent" && Array.isArray(t.rows)) {
      return t.rows.map((r) => (r.cells ?? []).map((c) => inlineText(typeof c === "object" && c !== null && "content" in c ? (c as { content: unknown }).content : c)).join(" | ")).join("\n");
    }
    return "";
  }
  let s = "";
  for (const raw of content) {
    const n = raw as Inline;
    if (!n || typeof n !== "object") continue;
    if (typeof n.text === "string") s += n.text;
    else if (n.type === "link") s += inlineText(n.content);
    else if (n.type === "mention") s += `@${String(n.props?.label ?? n.props?.date ?? n.props?.noteId ?? n.props?.userId ?? "")}`;
    else if (n.type === "inlineEquation") s += String(n.props?.latex ?? "");
  }
  return s;
}

/** A page's blocks in reading order, children after their parent. */
export function flattenBlocks(blocks: unknown, depth = 0, out: FlatBlock[] = []): FlatBlock[] {
  if (!Array.isArray(blocks) || depth > 40) return out;
  for (const raw of blocks) {
    const b = raw as { id?: unknown; type?: unknown; props?: unknown; content?: unknown; children?: unknown };
    if (!b || typeof b !== "object") continue;
    const props = typeof b.props === "object" && b.props !== null ? (b.props as Record<string, unknown>) : {};
    let text = inlineText(b.content);
    // Blocks without inline text read as what they hold (a code block's code, an image's caption or link…).
    if (!text) text = String(props.code ?? props.latex ?? props.caption ?? props.name ?? props.url ?? props.title ?? "");
    out.push({ ...(typeof b.id === "string" ? { id: b.id } : {}), type: typeof b.type === "string" ? b.type : "paragraph", text, depth, props });
    flattenBlocks(b.children, depth + 1, out);
  }
  return out;
}

/** Above this many token pairs a block's change is shown whole (removed text, then the new text). */
const MAX_PAIRS = 4_000_000;

/** Word-level changes from `a` to `b` (whitespace kept with the words, so joining the texts gives each side back). */
export function diffWords(a: string, b: string): WordOp[] {
  if (a === b) return a ? [{ op: "same", text: a }] : [];
  const x = a.match(/\s+|[^\s]+/g) ?? [];
  const y = b.match(/\s+|[^\s]+/g) ?? [];
  if (x.length * y.length > MAX_PAIRS) {
    return [...(a ? [{ op: "del" as const, text: a }] : []), ...(b ? [{ op: "add" as const, text: b }] : [])];
  }
  // Longest common subsequence of tokens, then walk it.
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops: WordOp[] = [];
  const push = (op: WordOp["op"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += text;
    else ops.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push("same", x[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("del", x[i++]);
    else push("add", y[j++]);
  }
  while (i < n) push("del", x[i++]);
  while (j < m) push("add", y[j++]);
  return ops;
}

const propsKey = (p: Record<string, unknown>) => JSON.stringify(p, Object.keys(p).sort());

/**
 * What changed from `before` to `after` (BlockNote block arrays), in the
 * newer version's order, removed blocks where they used to be.
 */
export function diffBlocks(before: unknown, after: unknown): BlockDiff[] {
  const a = flattenBlocks(before);
  const b = flattenBlocks(after);
  // Pair blocks: same id, then (for the rest) the same type and text, in order.
  const pairOfB = new Map<number, number>();
  const usedA = new Set<number>();
  const byId = new Map<string, number>();
  a.forEach((x, i) => x.id && !byId.has(x.id) && byId.set(x.id, i));
  b.forEach((y, j) => {
    const i = y.id ? byId.get(y.id) : undefined;
    if (i !== undefined && !usedA.has(i)) {
      pairOfB.set(j, i);
      usedA.add(i);
    }
  });
  const loose = new Map<string, number[]>();
  a.forEach((x, i) => {
    if (usedA.has(i)) return;
    const k = `${x.type}\u0000${x.text}`;
    loose.set(k, [...(loose.get(k) ?? []), i]);
  });
  b.forEach((y, j) => {
    if (pairOfB.has(j)) return;
    const list = loose.get(`${y.type}\u0000${y.text}`);
    const i = list?.shift();
    if (i !== undefined) {
      pairOfB.set(j, i);
      usedA.add(i);
    }
  });
  const out: BlockDiff[] = [];
  let next = 0;
  // Removed blocks of `a` up to (not including) index `upto`.
  const flushRemoved = (upto: number) => {
    for (; next < upto; next++) if (!usedA.has(next)) out.push({ status: "removed", block: a[next] });
  };
  b.forEach((y, j) => {
    const i = pairOfB.get(j);
    if (i === undefined) {
      out.push({ status: "added", block: y });
      return;
    }
    if (i >= next) flushRemoved(i);
    const x = a[i];
    if (x.text === y.text && x.type === y.type && propsKey(x.props) === propsKey(y.props)) out.push({ status: "same", block: y });
    else out.push({ status: "changed", block: y, old: x, ...(x.text !== y.text ? { words: diffWords(x.text, y.text) } : {}) });
    if (i + 1 > next) next = i + 1;
  });
  flushRemoved(a.length);
  return out;
}

/** True when the diff holds a change at all. */
export const hasChanges = (d: readonly BlockDiff[]) => d.some((x) => x.status !== "same");
