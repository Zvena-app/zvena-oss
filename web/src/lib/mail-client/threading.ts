// Conversations: which messages belong together. Pure (server, browser, tests).
//
// A message names itself (Message-ID) and the messages it answers
// (In-Reply-To, References). Two messages are in one conversation when one
// names the other, directly or through a third (JWZ's rule, without the
// subject guessing: two unrelated mails called "Hello" stay apart). Gmail
// also tells its own thread id (X-GM-THRID); it is one more name the
// messages of a thread share. The store (store.ts) keeps these names and
// joins or merges conversations as messages arrive in any order.

const MAX_REFS = 60;
const MAX_ID = 250;

/** A Message-ID without its angle brackets and spaces, or "" when it is not one. */
export function cleanMsgId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const m = /<([^<>\s]{1,250})>/.exec(raw);
  const id = (m ? m[1] : raw.trim()).replace(/\s+/g, "");
  return id && id.length <= MAX_ID && !/[<>]/.test(id) ? id : "";
}

/** Every Message-ID in a References / In-Reply-To header, in order, each once. */
export function parseIdList(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  const found = [...raw.matchAll(/<([^<>\s]{1,250})>/g)].map((m) => m[1]);
  const list = found.length ? found : raw.split(/[\s,]+/).map(cleanMsgId).filter(Boolean);
  const out: string[] = [];
  for (const id of list) if (id && !out.includes(id)) out.push(id);
  return out;
}

export interface ThreadInput {
  msgid: string;
  inReplyTo?: string | null;
  references?: readonly string[] | null;
  /** Gmail's X-GM-THRID. */
  gmThread?: string | null;
}

export interface ThreadKeys {
  /** The names of this message (its own id; Gmail's thread). */
  own: string[];
  /** The names this message points at (what it answers; Gmail's thread). */
  refs: string[];
}

/** The keys the store joins conversations by. */
export function threadKeys(m: ThreadInput): ThreadKeys {
  const own: string[] = [];
  const refs: string[] = [];
  const id = cleanMsgId(m.msgid);
  if (id) own.push(id);
  // The newest references matter most: a very long chain keeps its last ones.
  const list = [...(m.references ?? []).map(cleanMsgId), cleanMsgId(m.inReplyTo ?? "")].filter((r) => r && r !== id);
  for (const r of list.slice(-MAX_REFS)) if (!refs.includes(r)) refs.push(r);
  if (m.gmThread && /^\d{1,24}$/.test(m.gmThread)) {
    own.push(`gm:${m.gmThread}`);
    refs.push(`gm:${m.gmThread}`);
  }
  return { own, refs };
}

// Reply and forward prefixes in the languages mail clients write them in.
const PREFIX_RE = /^\s*((re|fw|fwd|aw|wg|sv|vs|antw|rif|tr|r|odp|ynt|vá|enc|res)\s*(\[\d+\]|\(\d+\))?\s*[:：]\s*)+/i;

/** A subject without "Re:", "Fwd:", "AW:"… at its start. */
export function baseSubject(s: string): string {
  let out = s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 10 && PREFIX_RE.test(out); i++) out = out.replace(PREFIX_RE, "").trim();
  return out;
}

export function replySubject(s: string): string {
  return `Re: ${baseSubject(s)}`;
}

export function forwardSubject(s: string): string {
  return `Fwd: ${baseSubject(s)}`;
}

/** References of a reply: the parent's references, then the parent itself (RFC 5322 §3.6.4). */
export function replyReferences(parent: { msgid: string; references: readonly string[] }): string[] {
  const out = [...parent.references.map(cleanMsgId).filter(Boolean)];
  const id = cleanMsgId(parent.msgid);
  if (id && !out.includes(id)) out.push(id);
  return out.slice(-MAX_REFS);
}
