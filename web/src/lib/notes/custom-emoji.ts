// Server-only: a workspace's custom emoji (Notion's Settings → Emoji). An
// emoji is an image already uploaded to Documents (it counts against the
// quota like any file) under a :name:; editors add and remove them, every
// member uses them in text, comments and page icons.

import { sql } from "../store";
import { EMOJI_FILE_RE, EMOJI_NAME_RE } from "./emoji";

export { emojiName } from "./emoji";

export interface CustomEmoji {
  name: string;
  url: string;
  createdBy: string | null;
  createdAt: number;
}

export const MAX_CUSTOM_EMOJI = 500;

export function listEmoji(ws: string): CustomEmoji[] {
  return (sql("SELECT name, file, created_by, created_at FROM custom_emoji WHERE ws = ? ORDER BY name").all(ws) as { name: string; file: string; created_by: string | null; created_at: number }[]).map((r) => ({
    name: r.name,
    url: r.file,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export type AddEmojiResult = { ok: true; emoji: CustomEmoji } | { ok: false; error: "bad name" | "bad file" | "taken" | "limit" };

export function addEmoji(ws: string, name: string, url: string, by: string, now = Date.now()): AddEmojiResult {
  if (!EMOJI_NAME_RE.test(name)) return { ok: false, error: "bad name" };
  if (!EMOJI_FILE_RE.test(url)) return { ok: false, error: "bad file" };
  if (sql("SELECT 1 FROM custom_emoji WHERE ws = ? AND name = ?").get(ws, name)) return { ok: false, error: "taken" };
  const n = sql("SELECT COUNT(*) AS n FROM custom_emoji WHERE ws = ?").get(ws) as { n: number };
  if (Number(n.n) >= MAX_CUSTOM_EMOJI) return { ok: false, error: "limit" };
  sql("INSERT INTO custom_emoji (ws, name, file, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(ws, name, url, by, now);
  return { ok: true, emoji: { name, url, createdBy: by, createdAt: now } };
}

export function removeEmoji(ws: string, name: string): boolean {
  return Number(sql("DELETE FROM custom_emoji WHERE ws = ? AND name = ?").run(ws, name).changes) > 0;
}
