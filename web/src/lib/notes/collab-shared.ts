// zvena Documents: what the co-editing server (collab.ts) and the browser
// provider (collab-client.ts) agree on. A page's body lives in a Yjs
// document while people edit it together; its JSON (note.content) is a
// snapshot written by the editors, so search, export, public pages and
// offline keep working. `ysnap` on the note is the hash of the JSON a
// co-editing session wrote: any other hash means the page was edited
// outside a session (offline, an older tab) and is merged back in.

/** The XML fragment BlockNote edits. */
export const COLLAB_FRAGMENT = "document-store";
/** Session metadata in the Y document: h = hash of the last snapshot, at = its time. */
export const COLLAB_META = "zvena";

/** One POST from a browser at most (base64 of a Yjs update). */
export const COLLAB_MAX_POST = 2_000_000;
/** A page's whole Yjs state at most (the JSON snapshot is capped at noteBytes). */
export const COLLAB_MAX_STATE = 20_000_000;

/** A short, fast hash of a page body (cyrb53 over its JSON), the same in the browser and on the server. */
export function contentHash(content: unknown): string {
  const s = JSON.stringify(content ?? []);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Notion-like cursor colors, one per person (stable across sessions). */
const CURSOR_COLORS = ["#d44c47", "#cb7b37", "#c29343", "#448361", "#337ea9", "#9065b0", "#c14c8a", "#787774"];
export function personColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length];
}

/** What the stream sends first: the server's state and who is here. */
export interface CollabInit {
  /** The whole document as one Yjs update (base64). */
  state: string;
  /** The server's state vector (base64): the browser sends back what it has beyond it. */
  sv: string;
  /** Awareness of everyone connected (base64), or "". */
  awareness: string;
  /** The document holds a session's content (else it waits for a seed). */
  seeded: boolean;
  /** This browser should seed it from the page's JSON (granted to one at a time). */
  seed: boolean;
  /** Over the limit of editors at once: this browser reads only. */
  full: boolean;
  /** The limit (0 = none). */
  limit: number;
  /** May this person change the document (role and limit). */
  canEdit: boolean;
  /** Reads only, but may mark the text of their own inline discussions (Can comment). */
  canComment?: boolean;
}
