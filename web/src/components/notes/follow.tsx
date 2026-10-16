"use client";

// zvena Documents: following a page (Notion's "Follow"): its edits and
// comments come to the follower's Inbox (lib/notes/follows.ts).

import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing } from "lucide-react";
import { following, setFollowing } from "@/lib/notes/prefs-client";
import { useNotes } from "./context";
import { toast } from "./ui";

/** Whether the person follows the page (null until known, or for a guest without a workspace), and the switch. */
export function useFollow(noteId: string): { on: boolean | null; toggle: () => void } {
  const api = useNotes();
  const ws = api.user?.ws.id ?? null;
  const [state, setState] = useState<{ key: string; on: boolean } | null>(null);
  const key = `${ws}:${noteId}`;
  useEffect(() => {
    if (!ws) return;
    let live = true;
    following(ws, noteId).then(
      (on) => live && setState({ key: `${ws}:${noteId}`, on }),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [noteId, ws]);
  const on = state?.key === key ? state.on : null;
  const toggle = useCallback(() => {
    if (!ws || on === null) return;
    setState({ key, on: !on });
    setFollowing(ws, noteId, !on).then(
      (now) => setState({ key, on: now }),
      () => {
        setState({ key, on });
        toast(api.t("notify.saveFailed"));
      }
    );
  }, [api, key, noteId, on, ws]);
  return { on: ws ? on : null, toggle };
}

/** The Follow / Following button (the Updates panel's header). */
export function FollowButton({ noteId }: { noteId: string }) {
  const { t } = useNotes();
  const { on, toggle } = useFollow(noteId);
  if (on === null) return null;
  return (
    <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset nt-follow-btn" aria-pressed={on} title={t("follow.hint")} onClick={toggle}>
      {on ? <BellRing size={14} /> : <Bell size={14} />}
      {on ? t("follow.following") : t("follow.follow")}
    </button>
  );
}
