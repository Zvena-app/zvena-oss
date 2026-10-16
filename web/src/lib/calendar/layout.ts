// zvena Calendar: where events sit in a day column when they overlap. Pure.
// Notion Calendar's way: events that overlap share the column side by side,
// each as wide as the free columns to its right allow; a cluster of
// overlapping events is laid out on its own.

export interface Span {
  id: string;
  /** Minutes from the column's top. */
  top: number;
  bottom: number;
}

export interface Placed extends Span {
  /** 0-based column and how many columns it spans, of `cols`. */
  col: number;
  span: number;
  cols: number;
}

/** Events shorter than this still take this much room (a 5-minute call is readable). */
export const MIN_MINUTES = 20;

export function layoutDay(spans: readonly Span[]): Placed[] {
  const items = [...spans].map((s) => ({ ...s, bottom: Math.max(s.bottom, s.top + MIN_MINUTES) })).sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.id.localeCompare(b.id));
  const out: Placed[] = [];
  let cluster: (Span & { col: number })[] = [];
  let clusterEnd = -Infinity;
  let columns: number[] = [];
  const flush = () => {
    const cols = columns.length;
    for (const c of cluster) {
      // Widen into the columns to the right that stay free for the whole event.
      let span = 1;
      while (c.col + span < cols && !cluster.some((o) => o !== c && o.col === c.col + span && o.top < c.bottom && o.bottom > c.top)) span++;
      out.push({ id: c.id, top: c.top, bottom: c.bottom, col: c.col, span, cols });
    }
    cluster = [];
    columns = [];
  };
  for (const s of items) {
    if (cluster.length && s.top >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    let col = columns.findIndex((end) => end <= s.top);
    if (col < 0) {
      col = columns.length;
      columns.push(s.bottom);
    } else columns[col] = s.bottom;
    cluster.push({ ...s, col });
    clusterEnd = Math.max(clusterEnd, s.bottom);
  }
  if (cluster.length) flush();
  return out;
}

/** All-day and multi-day bars of a week: each gets the first row free across its days. */
export function layoutBars<T extends { id: string; from: number; to: number }>(bars: readonly T[]): (T & { row: number })[] {
  const sorted = [...bars].sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from) || a.id.localeCompare(b.id));
  const rows: number[][] = [];
  return sorted.map((b) => {
    let row = rows.findIndex((r) => r.every((x, i) => i % 2 === 1 || !(b.from <= r[i + 1] && b.to >= x)));
    if (row < 0) {
      row = rows.length;
      rows.push([]);
    }
    rows[row].push(b.from, b.to);
    return { ...b, row };
  });
}
