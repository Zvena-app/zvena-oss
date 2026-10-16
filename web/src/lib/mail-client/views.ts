// Views of the mailbox (Notion Mail's views): a named set of filters shown as
// a tab and in the rail, and the search box's own little language. Pure
// (server, browser, tests). The store compiles a filter to SQL; new mail is
// checked against the same filter in memory (`matches`) to decide whether it
// deserves a notification, so both must agree (tests/unit/mail.test.ts).

/** Where a message is, as bits of mail_messages.boxes (folders, or Gmail's system labels). */
export const BOX = { inbox: 1, sent: 2, drafts: 4, trash: 8, spam: 16 } as const;
export type Box = keyof typeof BOX | "archive" | "any";
export const BOXES: readonly Box[] = ["inbox", "sent", "drafts", "archive", "spam", "trash", "any"];
/** Not in any of these: archived (Notion Mail's Archive is "everything that left the inbox"). */
export const LIVE_MASK = BOX.inbox | BOX.sent | BOX.drafts | BOX.trash | BOX.spam;

export interface ViewFilter {
  /** Where to look; "any" is everything but spam and trash. */
  box?: Box;
  /** Sender address or name contains. */
  from?: string;
  /** A recipient (To, Cc) contains. */
  to?: string;
  /** The subject contains. */
  subject?: string;
  /** Words anywhere (subject, body, people): full-text. */
  text?: string;
  /** Has any of these labels (label ids). */
  labels?: string[];
  /** One mailbox only (account id). */
  account?: string;
  unread?: boolean;
  starred?: boolean;
  attachment?: boolean;
  /** Received on or after / before (ms). */
  after?: number;
  before?: number;
  /** Snoozed (and not back yet). */
  snoozed?: boolean;
}

export const SYSTEM_VIEWS = ["inbox", "unread", "starred", "snoozed", "sent", "drafts", "archive", "spam", "trash"] as const;
export type SystemView = (typeof SYSTEM_VIEWS)[number];

export function isSystemView(v: unknown): v is SystemView {
  return typeof v === "string" && (SYSTEM_VIEWS as readonly string[]).includes(v);
}

/** The filter behind each built-in view. */
export function systemFilter(v: SystemView): ViewFilter {
  switch (v) {
    case "inbox":
      return { box: "inbox" };
    case "unread":
      return { box: "inbox", unread: true };
    case "starred":
      return { box: "any", starred: true };
    case "snoozed":
      return { box: "any", snoozed: true };
    case "sent":
      return { box: "sent" };
    case "drafts":
      return { box: "drafts" };
    case "archive":
      return { box: "archive" };
    case "spam":
      return { box: "spam" };
    case "trash":
      return { box: "trash" };
  }
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

/** A filter from untrusted JSON (a saved view, a request): unknown fields and bad values dropped. */
export function cleanFilter(v: unknown): ViewFilter {
  if (!v || typeof v !== "object") return {};
  const r = v as Record<string, unknown>;
  const f: ViewFilter = {};
  if (typeof r.box === "string" && (BOXES as readonly string[]).includes(r.box)) f.box = r.box as Box;
  for (const k of ["from", "to", "subject", "text"] as const) {
    const s = str(r[k]);
    if (s) f[k] = s;
  }
  if (Array.isArray(r.labels)) {
    const labels = r.labels.filter((x): x is string => typeof x === "string" && ID_RE.test(x)).slice(0, 20);
    if (labels.length) f.labels = labels;
  }
  if (typeof r.account === "string" && ID_RE.test(r.account)) f.account = r.account;
  for (const k of ["unread", "starred", "attachment", "snoozed"] as const) if (typeof r[k] === "boolean") f[k] = r[k] as boolean;
  for (const k of ["after", "before"] as const) if (typeof r[k] === "number" && Number.isFinite(r[k]) && (r[k] as number) > 0) f[k] = Math.floor(r[k] as number);
  return f;
}

/** The message fields a filter reads (a row of the store, or new mail before it is stored). */
export interface Matchable {
  accountId: string;
  boxes: number;
  fromAddr: string;
  fromName: string;
  /** To and Cc, addresses and names. */
  recipients: string;
  subject: string;
  /** Text for "words anywhere" (snippet or body). */
  text: string;
  labels: readonly string[];
  seen: boolean;
  flagged: boolean;
  attachment: boolean;
  date: number;
  snoozedUntil: number | null;
}

const has = (hay: string, needle: string) => hay.toLocaleLowerCase().includes(needle.toLocaleLowerCase());

function inBox(boxes: number, box: Box): boolean {
  switch (box) {
    case "any":
      return (boxes & (BOX.trash | BOX.spam)) === 0;
    case "archive":
      return (boxes & LIVE_MASK) === 0;
    case "inbox":
    case "sent":
    case "drafts":
      return (boxes & BOX[box]) !== 0 && (boxes & (BOX.trash | BOX.spam)) === 0;
    default:
      return (boxes & BOX[box]) !== 0;
  }
}

/** Whether one message is in a view (the same rules as `compileFilter`). */
export function matches(m: Matchable, f: ViewFilter, now = Date.now()): boolean {
  const box = f.box ?? "any";
  if (!inBox(m.boxes, box)) return false;
  const snoozed = m.snoozedUntil !== null && m.snoozedUntil > now;
  if (f.snoozed === true && !snoozed) return false;
  if (f.snoozed !== true && box === "inbox" && snoozed) return false;
  if (f.account && m.accountId !== f.account) return false;
  if (f.from && !has(`${m.fromName} ${m.fromAddr}`, f.from)) return false;
  if (f.to && !has(m.recipients, f.to)) return false;
  if (f.subject && !has(m.subject, f.subject)) return false;
  if (f.text && !f.text.split(/\s+/).filter(Boolean).every((w) => has(`${m.subject} ${m.fromName} ${m.fromAddr} ${m.recipients} ${m.text}`, w))) return false;
  if (f.labels?.length && !f.labels.some((l) => m.labels.includes(l))) return false;
  if (f.unread === true && m.seen) return false;
  if (f.unread === false && !m.seen) return false;
  if (f.starred === true && !m.flagged) return false;
  if (f.starred === false && m.flagged) return false;
  if (f.attachment === true && !m.attachment) return false;
  if (f.after && m.date < f.after) return false;
  if (f.before && m.date >= f.before) return false;
  return true;
}

const likeOf = (s: string) => `%${s.toLocaleLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Words for SQLite FTS5: each a quoted prefix ("word"*), all required; "" when nothing searchable is left. */
/** A user id as the index's owner token (hex: one token whatever the id's characters). */
export function ftsOwner(userId: string): string {
  return Buffer.from(userId, "utf8").toString("hex").toUpperCase();
}

export function ftsQuery(text: string): string {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/["*^:(){}[\]]/g, "").trim())
    .filter((w) => w.length > 0)
    .slice(0, 12);
  return words.map((w) => `"${w}"*`).join(" AND ");
}

/**
 * A filter as SQL over mail_messages AS m (the owner's rows only: the caller
 * adds m.user_id = ?). Every value is a parameter.
 */
export function compileFilter(f: ViewFilter, now = Date.now(), owner?: string): { where: string; params: (string | number)[] } {
  const w: string[] = [];
  const p: (string | number)[] = [];
  const box = f.box ?? "any";
  const bad = BOX.trash | BOX.spam;
  switch (box) {
    case "any":
      w.push(`(m.boxes & ${bad}) = 0`);
      break;
    case "archive":
      w.push(`(m.boxes & ${LIVE_MASK}) = 0`);
      break;
    case "inbox":
    case "sent":
    case "drafts":
      w.push(`(m.boxes & ${BOX[box]}) != 0 AND (m.boxes & ${bad}) = 0`);
      break;
    default:
      w.push(`(m.boxes & ${BOX[box]}) != 0`);
  }
  if (f.snoozed === true) {
    w.push("m.snoozed_until IS NOT NULL AND m.snoozed_until > ?");
    p.push(now);
  } else if (box === "inbox") {
    w.push("(m.snoozed_until IS NULL OR m.snoozed_until <= ?)");
    p.push(now);
  }
  if (f.account) {
    w.push("m.account_id = ?");
    p.push(f.account);
  }
  if (f.from) {
    w.push("lower(m.from_name || ' ' || m.from_addr) LIKE ? ESCAPE '\\'");
    p.push(likeOf(f.from));
  }
  if (f.to) {
    w.push("lower(m.to_json || ' ' || m.cc_json) LIKE ? ESCAPE '\\'");
    p.push(likeOf(f.to));
  }
  if (f.subject) {
    w.push("lower(m.subject) LIKE ? ESCAPE '\\'");
    p.push(likeOf(f.subject));
  }
  if (f.text) {
    const q = ftsQuery(f.text);
    if (q) {
      // The owner's rows inside the index (never a match over everyone's mail filtered afterwards).
      w.push("m.n IN (SELECT rowid FROM mail_fts WHERE mail_fts MATCH ?)");
      p.push(owner ? `owner : "${ftsOwner(owner)}" AND {subject people body} : (${q})` : `{subject people body} : (${q})`);
    }
  }
  if (f.labels?.length) {
    w.push("EXISTS (SELECT 1 FROM mail_message_labels l WHERE l.message_n = m.n AND l.label_id IN (SELECT value FROM json_each(?)))");
    p.push(JSON.stringify(f.labels));
  }
  if (f.unread === true) w.push("m.seen = 0");
  if (f.unread === false) w.push("m.seen = 1");
  if (f.starred === true) w.push("m.flagged = 1");
  if (f.starred === false) w.push("m.flagged = 0");
  if (f.attachment === true) w.push("m.has_att = 1");
  if (f.after) {
    w.push("m.date >= ?");
    p.push(f.after);
  }
  if (f.before) {
    w.push("m.date < ?");
    p.push(f.before);
  }
  return { where: w.join(" AND "), params: p };
}

// --- The search box ----------------------------------------------------------------

export interface ParsedSearch {
  filter: ViewFilter;
  /** label:name terms, for the caller to turn into label ids. */
  labelNames: string[];
}

const IN_BOX: Record<string, Box> = { inbox: "inbox", sent: "sent", drafts: "drafts", draft: "drafts", archive: "archive", archived: "archive", spam: "spam", junk: "spam", trash: "trash", bin: "trash", anywhere: "any", all: "any" };

function day(v: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

/**
 * "from:anna has:attachment invoice" → a filter. Operators: from: to:
 * subject: label: in: is:(unread|read|starred) has:attachment
 * before:/after:YYYY-MM-DD; "quoted values" may hold spaces; the rest is
 * words anywhere. Search looks everywhere but spam and trash unless in: says.
 */
export function parseSearch(q: string): ParsedSearch {
  const filter: ViewFilter = { box: "any" };
  const labelNames: string[] = [];
  const words: string[] = [];
  for (const m of q.slice(0, 500).matchAll(/(-?)(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g)) {
    const [, , op0, quoted, bare, phrase, word] = m;
    if (op0) {
      const op = op0.toLowerCase();
      const v = (quoted ?? bare ?? "").trim();
      if (!v) continue;
      const lv = v.toLowerCase();
      if (op === "from") filter.from = v;
      else if (op === "to" || op === "cc") filter.to = v;
      else if (op === "subject") filter.subject = v;
      else if (op === "label") labelNames.push(v);
      else if (op === "in" && IN_BOX[lv]) filter.box = IN_BOX[lv];
      else if (op === "is" && lv === "unread") filter.unread = true;
      else if (op === "is" && lv === "read") filter.unread = false;
      else if (op === "is" && (lv === "starred" || lv === "flagged")) filter.starred = true;
      else if (op === "is" && lv === "snoozed") filter.snoozed = true;
      else if (op === "has" && (lv === "attachment" || lv === "attachments")) filter.attachment = true;
      else if ((op === "before" || op === "after") && day(v) !== null) filter[op] = day(v) as number;
      else words.push(`${op0}:${v}`);
      continue;
    }
    const w = (phrase ?? word ?? "").trim();
    if (w) words.push(w);
  }
  if (words.length) filter.text = words.join(" ").slice(0, 200);
  return { filter, labelNames };
}
