"use client";

// Notion's "No access" screen: a link to a page this person cannot open.
// Signed in, they can ask for access — the page's full-access people hear of
// it and approve in the Share menu. The answer never says whether the page
// exists (the server answers the same either way).

import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { useNotes } from "./context";
import { toast } from "./ui";

/** Pauses between checks while the server says the page is readable: about 15 s in all (a slow server, a big first sync). */
const WAITS = [400, 700, 1000, 1500, 2000, 2700, 3200, 3500];

export function NoAccess({ noteId, onHome }: { noteId: string; onHome: () => void }) {
  const { t, user, syncNow } = useNotes();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  // The workspace the link names (?ws=), else the open one.
  const ws = (typeof location !== "undefined" && new URLSearchParams(location.search).get("ws")) || user?.ws.id || "";
  // Not here yet is not "no access": the page may simply not have reached this device (a link opened
  // before the first sync lands, a page made elsewhere). Ask the server first; while it says the
  // person may read it, pull and wait — the page replaces this screen as soon as it arrives.
  const [checking, setChecking] = useState(Boolean(user && ws));
  const pull = useRef(syncNow);
  useEffect(() => {
    pull.current = syncNow;
  });
  useEffect(() => {
    if (!user || !ws) return;
    let live = true;
    let tries = 0;
    const again = () => {
      // Out of time: the screen says what it can (the page shows the moment it arrives, even after).
      if (tries >= WAITS.length) return setChecking(false);
      setTimeout(() => live && void check(), WAITS[tries++]);
    };
    const check = async () => {
      try {
        const r = await fetch(`/api/notes/access?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(noteId)}`, { credentials: "same-origin", cache: "no-store" });
        if (!live) return;
        // Only the server's own answer ends the wait: the person may not read it.
        if (r.status === 401 || r.status === 403 || r.status === 404) return setChecking(false);
        if (r.ok) pull.current();
        again();
      } catch {
        // A slow or busy server, a dropped connection: try again within the window.
        if (live) again();
      }
    };
    void check();
    return () => {
      live = false;
    };
  }, [noteId, ws, user]);
  if (checking)
    return (
      <div className="nt-noaccess nt-noaccess-wait" aria-busy="true" role="status" data-test="noaccess-wait">
        <span className="nt-noaccess-spin" aria-hidden />
        <p>{t("noaccess.opening")}</p>
      </div>
    );
  const ask = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/notes/access-request?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(noteId)}`, { method: "POST", credentials: "same-origin" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { status?: string };
      if (j.status === "has") location.reload();
      else setSent(true);
    } catch {
      toast(t("access.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nt-noaccess" role="status">
      <Lock className="nt-noaccess-icon" />
      <h1>{t("noaccess.title")}</h1>
      <p>{user ? (sent ? t("noaccess.sent") : t("noaccess.hint")) : t("page.notFoundHint")}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        {user && !sent && ws && (
          <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" disabled={busy} onClick={() => void ask()}>
            {t("noaccess.request")}
          </button>
        )}
        <button type="button" className="nt-btn nt-btn-plain nt-btn-reset" onClick={onHome}>
          {t("page.goHome")}
        </button>
      </div>
    </div>
  );
}
