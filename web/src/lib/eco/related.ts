// "Related": everything an object is linked with, both ways, as cards the
// person may see. Server-only.

import { cardsFor, type Viewer } from "./cards";
import { ensureIndexed } from "./indexer";
import { backlinksOf, linksOf } from "./links";
import { parseRefKey } from "./refs";
import type { Related, RelatedItem } from "./types";

/** Which way of linking says most about the pair (one row per object in the panel). */
const RANK: Record<string, number> = { manual: 6, converted: 5, embed: 4, mention: 3, link: 2, relation: 1 };

export async function relatedOf(v: Viewer, key: string): Promise<Related> {
  const ref = parseRefKey(key);
  if (!ref) return { ref: key, items: [], indexing: false };
  // What links to something hidden from this person (a private team's issue) is not theirs to know.
  if (!(await cardsFor(v, [key])).length) return { ref: key, items: [], indexing: false };
  const indexing = !ensureIndexed(v.wsId);
  const best = new Map<string, { via: string; dir: "out" | "in"; manual: boolean }>();
  const consider = (other: string, via: string, dir: "out" | "in") => {
    // A design file's links include its frames' links: the file itself is not related to itself.
    if (other === key || other.startsWith(`${key}/`)) return;
    const prev = best.get(other);
    const manual = via === "manual" || Boolean(prev?.manual);
    if (!prev || (RANK[via] ?? 0) > (RANK[prev.via] ?? 0)) best.set(other, { via, dir, manual });
    else if (manual) prev.manual = true;
  };
  for (const l of linksOf(v.wsId, key)) consider(l.dst, l.via, "out");
  for (const l of backlinksOf(v.wsId, key)) consider(l.src, l.via, "in");
  const cards = await cardsFor(v, [...best.keys()]);
  const items: RelatedItem[] = cards.map((card) => {
    const b = best.get(card.key)!;
    return { card, via: b.via, dir: b.dir, manual: b.manual };
  });
  return { ref: key, items, indexing };
}
