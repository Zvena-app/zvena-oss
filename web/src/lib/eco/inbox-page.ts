// The Inbox as the Inbox page and Home send it along (no round trip before it
// shows): the same reads, with the same access, as GET /api/eco/inbox — a
// guest of the workspace gets their own items there, a member theirs; anyone
// else gets nothing (the app's own fetch then says why).

import type { Locale } from "@/i18n/locales";
import { access } from "../http";
import { docsPresence } from "../notes/access";
import { inboxOf } from "./inbox";

export async function initialInbox(userId: string, wsId: string, locale: Locale): Promise<Awaited<ReturnType<typeof inboxOf>> | null> {
  try {
    if (!docsPresence(userId, wsId)?.guest && !access(userId, wsId, "read")) return null;
    return await inboxOf({ userId, wsId, locale }, { archived: false });
  } catch (e) {
    console.error(`[eco] page inbox failed (${e instanceof Error ? e.name : "error"})`);
    return null;
  }
}
