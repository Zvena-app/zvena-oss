// Server-only: the HTTP ends of single sign-on (app/api/sso/*): finishing a
// sign-in the way every other method does (lib/signin.ts), and the SAML
// "bounce" — the identity provider posts to the ACS from its own site, so
// the browser leaves our SameSite=Lax cookie out; a tiny page posts the same
// form again from our origin, this time with the cookie that binds the
// sign-in to the browser that started it.

import { NextResponse } from "next/server";
import { readCookie } from "../auth";
import { parseAcceptLanguage, resolveLocale, translate, UI_LANG_COOKIE } from "../i18n";
import { finishSignIn, signInError } from "../signin";
import { clearBindCookie, type SsoResult } from "./sso";

export function ssoFinish(req: Request, r: SsoResult): NextResponse {
  const res = r.ok
    ? finishSignIn(r.user, {
        next: r.next,
        guest: r.guest,
        isNew: r.isNew,
        personalName: translate(resolveLocale(readCookie(req, UI_LANG_COOKIE), parseAcceptLanguage(req.headers.get("accept-language"))), "ws.personal"),
      })
    : signInError(r.error, r.next);
  res.headers.append("set-cookie", clearBindCookie());
  return res;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The same-origin re-post of a SAML response (see above). */
export function samlBounce(action: string, fields: Record<string, string>, nonce: string | null): Response {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>zvena</title></head><body><form method="post" action="${esc(action)}">${inputs}<noscript><button type="submit">Continue</button></noscript></form><script${nonce ? ` nonce="${esc(nonce)}"` : ""}>document.forms[0].submit()</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** A form that posts itself to the identity provider (SAML's HTTP-POST binding), with our nonce on its script. */
export function selfPostingForm(html: string, nonce: string | null): Response {
  // node-saml's form submits through an inline onload handler, which our CSP refuses: a nonce'd script does it instead.
  const body = html.replace(/<body[^>]*>/i, "<body>").replace("</body>", `<script${nonce ? ` nonce="${esc(nonce)}"` : ""}>document.forms[0].submit()</script></body>`);
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
