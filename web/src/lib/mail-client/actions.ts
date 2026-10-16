// Server-only: what a person does to conversations — archive, trash, spam,
// read, star, snooze, move, label — applied here at once (the list changes
// before the server answers) and queued for the mail server (mail_ops),
// which the account's worker carries over. An action on a conversation
// acts on its messages, as in Notion Mail and Gmail.
//
//                    plain IMAP (folders)            Gmail (labels)
//   archive          move to Archive (made if none)  remove \Inbox
//   move to inbox    move to INBOX                   add \Inbox
//   trash / spam     move to Trash / Junk            move to [Gmail]/Trash / Spam
//   restore          move to INBOX                   move to INBOX
//   delete forever   \Deleted + EXPUNGE              the same, in Trash
//   read / star      \Seen / \Flagged                the same
//   label            zvena's labels: here only; a    add / remove a Gmail label
//                    folder label: move into it
//   snooze           here only: hidden from the inbox until its time, then back on top, unread

import { sql, tx } from "../store";
import { placeholderUid, type OpItem } from "./imap";
import { mailChanged } from "./events";
import { folderByRole, messagesOfThreads, ownLabel, ownMessages, type MessageRow } from "./store";
import { BOX } from "./views";
import { enqueueOp } from "./worker";
import { accountById } from "./store";

export const ACTIONS = ["archive", "inbox", "trash", "restore", "spam", "notspam", "delete", "read", "unread", "star", "unstar", "snooze", "unsnooze", "move", "label", "unlabel"] as const;
export type MailAction = (typeof ACTIONS)[number];

export function isAction(v: unknown): v is MailAction {
  return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}

export class ActionError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

const MAX_SNOOZE = 366 * 86_400_000;

const item = (m: MessageRow): OpItem => ({ id: m.id, folder: m.folder, uid: Number(m.uid), ...(m.msgid ? { msgid: m.msgid } : {}) });

function byAccount(rows: MessageRow[]): Map<string, MessageRow[]> {
  const out = new Map<string, MessageRow[]>();
  for (const r of rows) {
    const list = out.get(r.account_id) ?? [];
    list.push(r);
    out.set(r.account_id, list);
  }
  return out;
}

/** Moves messages to a folder: locally now (a copy waiting for its new UID), on the server through the worker. */
function moveTo(accountId: string, rows: MessageRow[], to: { path: string } | null, role: "inbox" | "archive" | "trash" | "spam" | null, boxes: number, localPath?: string): void {
  const list = rows.filter((r) => !to || r.folder !== to.path);
  if (!list.length) return;
  const items = list.map(item);
  // Where the sync will find it again (Gmail: back in All Mail, whatever folder it was moved through).
  for (const r of list) sql("UPDATE mail_messages SET folder = ?, uid = ?, boxes = ? WHERE id = ?").run(localPath ?? to?.path ?? (role === "archive" ? "Archive" : r.folder), placeholderUid(), boxes, r.id);
  enqueueOp(
    accountId,
    "move",
    list.map((r) => r.id),
    { items, ...(to ? { to: to.path } : role ? { toRole: role } : {}) }
  );
}

function flags(accountId: string, rows: MessageRow[], add: string[], remove: string[]): void {
  if (!rows.length) return;
  enqueueOp(
    accountId,
    "flags",
    rows.map((r) => r.id),
    { items: rows.map(item), add, remove }
  );
}

function gmailLabels(accountId: string, rows: MessageRow[], add: string[], remove: string[]): void {
  if (!rows.length) return;
  enqueueOp(
    accountId,
    "labels",
    rows.map((r) => r.id),
    { items: rows.map(item), add, remove }
  );
}

/** Applies an action to the person's conversations (`threads`) or single messages (`messages`); returns how many messages changed. */
export function applyAction(userId: string, target: { threads?: string[]; messages?: string[] }, action: MailAction, arg: { until?: unknown; label?: unknown } = {}): number {
  const rows = [...(target.threads?.length ? messagesOfThreads(userId, target.threads) : []), ...(target.messages?.length ? ownMessages(userId, target.messages) : [])];
  if (!rows.length) return 0;
  const now = Date.now();
  let changed = 0;
  tx(() => {
    for (const [accountId, list] of byAccount(rows)) {
      const acct = accountById(accountId);
      if (!acct || acct.user_id !== userId) continue;
      const gmail = acct.gmail === 1;
      const live = list.filter((r) => (Number(r.boxes) & (BOX.trash | BOX.spam)) === 0);
      switch (action) {
        case "archive": {
          const inInbox = live.filter((r) => Number(r.boxes) & BOX.inbox);
          if (gmail) {
            for (const r of inInbox) sql("UPDATE mail_messages SET boxes = boxes & ~? WHERE id = ?").run(BOX.inbox, r.id);
            gmailLabels(accountId, inInbox, [], ["\\Inbox"]);
          } else moveTo(accountId, inInbox, folderByRole(accountId, "archive"), "archive", 0);
          changed += inInbox.length;
          break;
        }
        case "inbox": {
          // Received messages go back; one's own replies stay in Sent.
          const out = live.filter((r) => !(Number(r.boxes) & (BOX.inbox | BOX.sent | BOX.drafts)));
          if (gmail) {
            for (const r of out) sql("UPDATE mail_messages SET boxes = boxes | ? WHERE id = ?").run(BOX.inbox, r.id);
            gmailLabels(accountId, out, ["\\Inbox"], []);
          } else moveTo(accountId, out, folderByRole(accountId, "inbox") ?? { path: "INBOX" }, "inbox", BOX.inbox);
          changed += out.length;
          break;
        }
        case "trash":
        case "spam": {
          const role = action === "trash" ? "trash" : "spam";
          const bit = action === "trash" ? BOX.trash : BOX.spam;
          const target = list.filter((r) => !(Number(r.boxes) & bit));
          const folder = folderByRole(accountId, role);
          if (!folder) throw new ActionError(409, `no ${role} folder`);
          moveTo(accountId, target, folder, role, bit);
          changed += target.length;
          break;
        }
        case "restore":
        case "notspam": {
          const bit = action === "restore" ? BOX.trash : BOX.spam;
          const target = list.filter((r) => Number(r.boxes) & bit);
          moveTo(accountId, target, folderByRole(accountId, "inbox") ?? { path: "INBOX" }, "inbox", BOX.inbox, gmail ? folderByRole(accountId, "all")?.path : undefined);
          changed += target.length;
          break;
        }
        case "delete": {
          // Forever: only what is already in the trash or spam.
          const target = list.filter((r) => Number(r.boxes) & (BOX.trash | BOX.spam));
          if (!target.length) break;
          enqueueOp(
            accountId,
            "expunge",
            target.map((r) => r.id),
            { items: target.map(item) }
          );
          sql("DELETE FROM mail_messages WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(target.map((r) => r.id)));
          changed += target.length;
          break;
        }
        case "read":
        case "unread": {
          const seen = action === "read" ? 1 : 0;
          // Marking a conversation unread marks its newest message (Gmail, Notion Mail).
          const target = seen ? list.filter((r) => r.seen !== 1) : list.slice(-1).filter((r) => r.seen === 1);
          for (const r of target) sql("UPDATE mail_messages SET seen = ? WHERE id = ?").run(seen, r.id);
          flags(accountId, target, seen ? ["\\Seen"] : [], seen ? [] : ["\\Seen"]);
          changed += target.length;
          break;
        }
        case "star": {
          // A conversation is starred through its newest message.
          const target = list.some((r) => r.flagged === 1) ? [] : list.slice(-1);
          for (const r of target) sql("UPDATE mail_messages SET flagged = 1 WHERE id = ?").run(r.id);
          flags(accountId, target, ["\\Flagged"], []);
          changed += target.length;
          break;
        }
        case "unstar": {
          const target = list.filter((r) => r.flagged === 1);
          for (const r of target) sql("UPDATE mail_messages SET flagged = 0 WHERE id = ?").run(r.id);
          flags(accountId, target, [], ["\\Flagged"]);
          changed += target.length;
          break;
        }
        case "snooze": {
          const until = Number(arg.until);
          if (!Number.isFinite(until) || until <= now || until > now + MAX_SNOOZE) throw new ActionError(400, "bad time");
          for (const r of list) sql("UPDATE mail_messages SET snoozed_until = ? WHERE id = ?").run(Math.floor(until), r.id);
          changed += list.length;
          break;
        }
        case "unsnooze": {
          for (const r of list) sql("UPDATE mail_messages SET snoozed_until = NULL WHERE id = ?").run(r.id);
          changed += list.length;
          break;
        }
        case "move":
        case "label":
        case "unlabel": {
          const l = ownLabel(userId, arg.label);
          if (!l) throw new ActionError(404, "label not found");
          if (l.kind === "manual") {
            for (const r of list) {
              if (action === "unlabel") sql("DELETE FROM mail_message_labels WHERE message_n = ? AND label_id = ?").run(r.n, l.id);
              else sql("INSERT OR IGNORE INTO mail_message_labels (message_n, label_id) VALUES (?, ?)").run(r.n, l.id);
            }
            changed += list.length;
            break;
          }
          if (l.account_id !== accountId) break;
          if (l.kind === "gmail") {
            for (const r of live) {
              if (action === "unlabel") sql("DELETE FROM mail_message_labels WHERE message_n = ? AND label_id = ?").run(r.n, l.id);
              else sql("INSERT OR IGNORE INTO mail_message_labels (message_n, label_id) VALUES (?, ?)").run(r.n, l.id);
              if (action === "move") sql("UPDATE mail_messages SET boxes = boxes & ~? WHERE id = ?").run(BOX.inbox, r.id);
            }
            gmailLabels(accountId, live, action === "unlabel" ? [] : [l.path], action === "unlabel" ? [l.path] : action === "move" ? ["\\Inbox"] : []);
            changed += live.length;
            break;
          }
          // A folder of a plain IMAP server: the message is in it or not (labelling moves it there).
          if (action === "unlabel") {
            const inIt = list.filter((r) => r.folder === l.path);
            moveTo(accountId, inIt, folderByRole(accountId, "inbox") ?? { path: "INBOX" }, "inbox", BOX.inbox);
            changed += inIt.length;
          } else {
            const received = live.filter((r) => !(Number(r.boxes) & (BOX.sent | BOX.drafts)));
            moveTo(accountId, received, { path: l.path }, null, 0);
            for (const r of received) {
              sql("DELETE FROM mail_message_labels WHERE message_n = ? AND label_id IN (SELECT id FROM mail_labels WHERE account_id = ? AND kind = 'folder')").run(r.n, accountId);
              sql("INSERT OR IGNORE INTO mail_message_labels (message_n, label_id) VALUES (?, ?)").run(r.n, l.id);
            }
            changed += received.length;
          }
          break;
        }
      }
    }
  });
  const accounts = new Set(rows.map((r) => r.account_id));
  for (const a of accounts) mailChanged(userId, a);
  return changed;
}

/** Snoozed conversations whose time came: back on top of the inbox, unread (the clock). */
export function wakeSnoozed(now = Date.now()): number {
  const due = sql("SELECT id, user_id, account_id, folder, uid, seen FROM mail_messages WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? LIMIT 500").all(now) as {
    id: string;
    user_id: string;
    account_id: string;
    folder: string;
    uid: number;
    seen: number;
  }[];
  if (!due.length) return 0;
  const touched = new Map<string, string>();
  tx(() => {
    for (const r of due) {
      sql("UPDATE mail_messages SET snoozed_until = NULL, bumped_at = ? WHERE id = ?").run(now, r.id);
      touched.set(r.account_id, r.user_id);
    }
    // The newest message of each conversation comes back unread.
    const threads = sql("SELECT DISTINCT thread_id AS t FROM mail_messages WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(due.map((d) => d.id))) as { t: string }[];
    for (const t of threads) {
      const last = sql("SELECT id, account_id, folder, uid, seen FROM mail_messages WHERE thread_id = ? AND (boxes & ?) = 0 ORDER BY date DESC LIMIT 1").get(t.t, BOX.sent | BOX.drafts | BOX.trash | BOX.spam) as
        | { id: string; account_id: string; folder: string; uid: number; seen: number }
        | undefined;
      if (last && last.seen === 1) {
        sql("UPDATE mail_messages SET seen = 0 WHERE id = ?").run(last.id);
        enqueueOp(last.account_id, "flags", [last.id], { items: [{ id: last.id, folder: last.folder, uid: Number(last.uid) }], remove: ["\\Seen"] });
      }
    }
  });
  for (const [a, u] of touched) mailChanged(u, a, 1);
  return due.length;
}
