"use client";

// The cookie notice. zvena sets only necessary cookies (session, guest id,
// language, open workspace) and no analytics or advertising ones, so there
// is nothing to opt into: the notice informs once and is dismissed. It greets
// visitors — the website, shared pages and forms, invites — and stays out of
// the app, where it would sit over the sidebar and the selection bar.

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { isSitePath } from "@/lib/site";

const KEY = "zv-cookie-ok";
const VISITOR_PAGES = /^\/(n|f|join)\//;

/** The strings come translated from the root layout (server), so no dictionary loads in the browser for this. */
export function CookieNotice({ text, more, ok }: { text: string; more: string; ok: string }) {
  const path = usePathname();
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(KEY) !== "1") setShow(true);
    } catch {
      setShow(true);
    }
  }, []);
  if (!show || !(isSitePath(path) || VISITOR_PAGES.test(path ?? ""))) return null;
  return (
    <div className="zv-cookie" role="region" aria-label="cookie">
      <div>
        {text} <a href="/legal/cookies">{more}</a>
      </div>
      <div className="zv-actions">
        <button
          type="button"
          className="zv-btn zv-btn-primary zv-btn-sm"
          onClick={() => {
            try {
              localStorage.setItem(KEY, "1");
            } catch {
              // Private mode: hidden for this page view.
            }
            setShow(false);
          }}
        >
          {ok}
        </button>
      </div>
    </div>
  );
}
