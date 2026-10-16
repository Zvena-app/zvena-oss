// What the Mail API sends to the browser. Shared (server and browser); no
// secrets ever appear here (an account is its address, name and state).

import type { ViewFilter } from "./views";

export interface Addr {
  name: string;
  address: string;
}

export interface MailAccount {
  id: string;
  email: string;
  name: string;
  provider: string;
  /** new | syncing | ok | error | auth (the password stopped working). */
  state: string;
  error?: string;
  syncedAt?: number;
  signature: string;
  color: string;
  gmail: boolean;
  imap: { host: string; port: number; security: string };
  smtp: { host: string; port: number; security: string };
}

export interface MailLabel {
  id: string;
  accountId: string | null;
  kind: "folder" | "gmail" | "manual";
  name: string;
  color: string;
}

export interface MailView {
  id: string;
  name: string;
  icon: string;
  filter: ViewFilter;
  notify: boolean;
  /** A built-in view (inbox, sent…): its filter is fixed; its notifications can be turned on. */
  system: boolean;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  snippet: string;
  /** Who wrote in it, newest last ("me" for the person's own addresses). */
  people: { name: string; address: string; me: boolean }[];
  count: number;
  unread: boolean;
  starred: boolean;
  attachment: boolean;
  draft: boolean;
  at: number;
  snoozedUntil: number | null;
  labels: string[];
  accounts: string[];
  /** In the inbox (archive shows), in the trash (restore shows). */
  inbox: boolean;
  trash: boolean;
  spam: boolean;
}

export interface MailAttachment {
  id: string;
  filename: string;
  type: string;
  size: number;
  inline: boolean;
}

export interface MailMessage {
  id: string;
  threadId: string;
  accountId: string;
  msgid: string;
  subject: string;
  from: Addr;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  date: number;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  draft: boolean;
  trash: boolean;
  /** "none" not fetched yet, "ok" here, "error" could not be fetched. */
  body: "none" | "ok" | "error";
  /** HTML or plain text (decides how the frame is laid out). */
  html: boolean;
  /** Plain text (for quoting a reply). */
  text?: string;
  attachments: MailAttachment[];
  labels: string[];
  /** Remote images of this sender load without asking. */
  imagesAllowed: boolean;
  unsubscribe?: string;
  /** The person's own message. */
  mine: boolean;
}

export interface MailThread {
  id: string;
  subject: string;
  messages: MailMessage[];
  labels: string[];
  snoozedUntil: number | null;
}

export interface DraftAttachment {
  id: string;
  filename: string;
  type: string;
  size: number;
}

/** What the composer saves (drafts, undo send). */
export interface Draft {
  id: string;
  accountId: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  html: string;
  /** The editor's blocks (BlockNote), when written in zvena. */
  blocks?: unknown[];
  attachments: DraftAttachment[];
  /** The message replied to or forwarded. */
  replyTo?: string;
  mode: "new" | "reply" | "replyAll" | "forward";
  threadId?: string;
  updatedAt: number;
}

export interface OutboxItem {
  id: string;
  accountId: string;
  sendAt: number;
  state: "queued" | "sending" | "failed";
  error?: string;
  subject: string;
  to: string[];
}

export interface MailSnippet {
  id: string;
  name: string;
  html: string;
}

export interface MailPrefs {
  /** Seconds a sent message waits for "Undo" (0: off). */
  undoSeconds: number;
  /** Remote images load for every sender (proxied either way). */
  alwaysImages: boolean;
  /** The reading pane: beside the list, or the conversation fills the page. */
  pane: "split" | "full";
  /** Show conversations with several lines (Notion Mail's comfortable rows). */
  density: "compact" | "comfortable";
  /** The views shown as tabs over the list (ids), in order. */
  tabs: string[];
}

export const DEFAULT_PREFS: MailPrefs = { undoSeconds: 10, alwaysImages: false, pane: "split", density: "compact", tabs: ["inbox", "unread", "starred"] };

export interface Contact {
  name: string;
  address: string;
  /** A member of one of the person's workspaces. */
  member: boolean;
}
