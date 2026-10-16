// Server-only: who the composer suggests as a person types an address — the
// people they wrote to or heard from (written-to counts more), and the
// members of their own workspaces. Nobody else's address book is ever read.

import { sql } from "../store";
import { mailDb } from "./schema";
import type { Contact } from "./types";

const like = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function suggestContacts(userId: string, raw: string, limit = 8): Contact[] {
  mailDb();
  const q = raw.trim().slice(0, 100);
  const out: Contact[] = [];
  const seen = new Set<string>();
  const add = (c: Contact) => {
    const k = c.address.toLowerCase();
    if (seen.has(k) || out.length >= limit) return;
    seen.add(k);
    out.push(c);
  };
  // Members of the person's workspaces (verified addresses only).
  const members = sql(
    `SELECT DISTINCT u.name, u.email FROM members m JOIN members me ON me.ws_id = m.ws_id AND me.user_id = ?
     JOIN users u ON u.id = m.user_id WHERE u.id != ? AND u.email IS NOT NULL AND u.blocked_at IS NULL
       AND (lower(u.email) LIKE ? ESCAPE '\\' OR lower(u.name) LIKE ? ESCAPE '\\') LIMIT ?`
  ).all(userId, userId, like(q), like(q), limit) as { name: string; email: string }[];
  const contacts = sql(
    `SELECT name, email FROM mail_contacts WHERE user_id = ? AND (email LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
     ORDER BY sent * 3 + received DESC, last_at DESC LIMIT ?`
  ).all(userId, like(q), like(q), limit * 2) as { name: string; email: string }[];
  // Written-to people first, then members, then the rest.
  for (const c of contacts.slice(0, 3)) add({ name: c.name, address: c.email, member: false });
  for (const m of members) add({ name: m.name, address: m.email, member: true });
  for (const c of contacts) add({ name: c.name, address: c.email, member: false });
  return out;
}
