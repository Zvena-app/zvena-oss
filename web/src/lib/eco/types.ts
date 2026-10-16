// What the ecosystem shows of an object, wherever it appears: a card in a
// "Related" panel, a live block in a document, a search result, a row on
// Home. Shared by the server (lib/eco/cards.ts) and the browser.

import type { RefKind } from "./refs";

export type StatusCategory = "backlog" | "unstarted" | "started" | "completed" | "canceled";

export interface Card {
  /** The ref key (note:<id>, issue:<id>, project:<id>, design:<file>[/<frame>]). */
  key: string;
  kind: RefKind;
  title: string;
  /** Where it opens (relative to zvena's origin). */
  url: string;
  /** An emoji (pages, projects). */
  icon?: string;
  /** A project's color, a status's color. */
  color?: string;
  /** Second line: the issue identifier, the page's parent, the design file. */
  sub?: string;
  /**
   * Issues: their workflow status (its id, and how full its icon is drawn:
   * a started status's place among the team's started ones); projects: their state.
   */
  status?: { id?: string; name: string; color: string; category: StatusCategory; fraction?: number };
  assignee?: { id: string; name: string } | null;
  /** Issues: YYYY-MM-DD. */
  due?: string | null;
  /** Issues: 0 none … 1 urgent … 4 low (Linear's scale). */
  priority?: number;
  /** Design frames: the preview picture. */
  image?: string;
  /** Projects: share of completed issues, 0–1. */
  progress?: number;
  updatedAt?: number;
}

/** One status of an issue's workflow, as its status menu shows it (board order). */
export interface StatusOption {
  id: string;
  name: string;
  color: string;
  category: StatusCategory;
  fraction: number;
}

/** One link as the "Related" panel shows it. */
export interface RelatedItem {
  card: Card;
  /** How they are linked: mention, link, embed, relation, converted, manual. */
  via: string;
  /** This object points at it (out) or it points at this object (in). */
  dir: "out" | "in";
  /** A person added it (and may remove it). */
  manual: boolean;
}

export interface Related {
  ref: string;
  items: RelatedItem[];
  /** The workspace is still being indexed: more links may appear. */
  indexing: boolean;
}

export interface SearchHit extends Card {
  /** A few words around the match (documents and issues). */
  snippet?: string;
}

export interface SearchResults {
  q: string;
  hits: SearchHit[];
}

export const LINK_VIAS = ["mention", "link", "embed", "relation", "converted", "manual"] as const;
export type LinkVia = (typeof LINK_VIAS)[number];

/** One line of the Inbox, whichever product it came from. */
export interface InboxItem {
  /** "eco:<id>" or "pj:<id>": which list it belongs to. */
  id: string;
  kind: string;
  card: Card | null;
  actor: { id: string; name: string } | null;
  text: string;
  at: number;
  read: boolean;
  /** Where it opens: the card's address, deep-linked to the block or comment when there is one. */
  url: string;
}
