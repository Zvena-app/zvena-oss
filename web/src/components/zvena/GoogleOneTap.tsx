"use client";

// Google One Tap for signed-out visitors (the sign-in page only). The
// nonce comes from our server with an HttpOnly cookie, Google signs it into
// the ID token, and the token is posted to /api/auth/google/onetap as a
// normal form (the server answers with the session cookie and a redirect).
// Google's script is loaded only here and only when Google sign-in is set up.

import { useEffect } from "react";

interface GoogleId {
  initialize(opts: Record<string, unknown>): void;
  prompt(): void;
  cancel(): void;
}
type GoogleWindow = Window & { google?: { accounts?: { id?: GoogleId } } };

const SRC = "https://accounts.google.com/gsi/client";

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as GoogleWindow).google?.accounts?.id) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    const s = existing ?? document.createElement("script");
    s.addEventListener("load", () => resolve(), { once: true });
    s.addEventListener("error", () => reject(new Error("gsi")), { once: true });
    if (!existing) {
      s.src = SRC;
      s.async = true;
      document.head.appendChild(s);
    }
  });
}

function submit(credential: string, next: string) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/api/auth/google/onetap";
  form.style.display = "none";
  for (const [name, value] of [
    ["credential", credential],
    ["next", next],
  ]) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

export function GoogleOneTap({ clientId, next = "/home" }: { clientId: string; next?: string }) {
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/google/nonce", { cache: "no-store", credentials: "same-origin" });
        if (!res.ok || cancelled) return;
        const { nonce } = (await res.json()) as { nonce: string };
        await loadScript();
        const id = (window as GoogleWindow).google?.accounts?.id;
        if (cancelled || !id) return;
        id.initialize({
          client_id: clientId,
          nonce,
          callback: (r: { credential?: string }) => r.credential && submit(r.credential, next),
          auto_select: false,
          cancel_on_tap_outside: true,
          context: "signin",
          itp_support: true,
          use_fedcm_for_prompt: true,
        });
        id.prompt();
      } catch {
        // Blocked by the browser or an extension: the regular buttons remain.
      }
    })();
    return () => {
      cancelled = true;
      try {
        (window as GoogleWindow).google?.accounts?.id?.cancel();
      } catch {
        // Not initialized.
      }
    };
  }, [clientId, next]);
  return null;
}
