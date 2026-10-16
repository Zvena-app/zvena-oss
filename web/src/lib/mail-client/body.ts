// Server-only: a message as its sandboxed frame shows it. The text is
// fetched when it is not here yet, made safe (sanitize.ts), and wrapped in a
// small document of its own: base styles, the light or dark page, links in a
// new tab. Remote images go through the proxy with a signature bound to the
// reader, so /api/mail/img is not an open proxy for anyone else.

import { mac, safeEqual } from "../auth";
import { config } from "../config";
import { fetchBody } from "./imap";
import { sanitizeHtml, textToHtml } from "./sanitize";
import { accountById, attachmentsOf, imagesAllowed, ownMessage, type MessageRow } from "./store";
import { prefsOf } from "./prefs";
import { withImap } from "./worker";

/** The proxy address of a remote image for this reader. */
export function proxied(userId: string, url: string): string {
  return `/api/mail/img?u=${encodeURIComponent(url)}&s=${mac("mail-img", `${userId}|${url}`)}`;
}

export function validProxy(userId: string, url: string, sig: string): boolean {
  return Boolean(url && sig) && safeEqual(mac("mail-img", `${userId}|${url}`), sig);
}

/** The message's text, fetched from the server when needed (null when it cannot be). */
export async function ensureBody(userId: string, row: MessageRow): Promise<MessageRow | null> {
  if (row.body === 1) return row;
  const acct = accountById(row.account_id);
  if (!acct || acct.user_id !== userId || Number(row.uid) <= 0) return row.body === 1 ? row : null;
  const ok = await withImap(acct, (c) => fetchBody(c, { n: Number(row.n), folder: row.folder, uid: Number(row.uid), text_part: row.text_part, html_part: row.html_part })).catch(() => false);
  return ok ? ownMessage(userId, row.id) : null;
}

const STYLE = (dark: boolean, plain: boolean) => `
:root { color-scheme: ${dark && plain ? "dark" : "light"}; }
html, body { margin: 0; padding: 0; }
body { font: 14px/1.55 "Zvena Sans", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: ${dark && plain ? "#e6e6e6" : "#1e1e1e"}; background: ${dark && plain ? "#2c2c2c" : "#ffffff"}; overflow-wrap: anywhere; padding: 0 14px 14px; }
a { color: ${dark && plain ? "#7cc4f8" : "#007be5"}; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
pre { white-space: pre-wrap; }
.zv-plain { white-space: pre-wrap; }
.zv-quote, blockquote.gmail_quote, .zv-plain blockquote { margin: 0 0 0 2px; padding-left: 12px; border-left: 2px solid ${dark && plain ? "#555" : "#d9d9d9"}; color: ${dark && plain ? "#b3b3b3" : "#6e6e6e"}; }
@font-face { font-family: "Zvena Sans"; font-weight: 100 900; src: url(/fonts/inter/inter-latin-wght-normal.woff2) format("woff2-variations"); }
`;

export interface RenderedBody {
  html: string;
  /** Remote images held back (the "Show images" bar). */
  blocked: number;
}

/** The frame's document of one of the person's messages, or null. */
export async function renderBody(userId: string, messageId: unknown, opts: { images?: boolean; dark?: boolean }): Promise<RenderedBody | null> {
  const first = ownMessage(userId, messageId);
  if (!first) return null;
  const row = await ensureBody(userId, first);
  if (!row) return { html: doc(`<p style="color:#707070">${first.snippet ? escape(first.snippet) : "…"}</p>`, Boolean(opts.dark), true), blocked: 0 };
  const allowed = opts.images === true || prefsOf(userId).alwaysImages || imagesAllowed(userId, row.from_addr);
  if (row.html) {
    const cids = new Map(attachmentsOf(Number(row.n)).filter((a) => a.cid && a.type.startsWith("image/")).map((a) => [a.cid as string, a.id]));
    const out = sanitizeHtml(row.html, {
      images: allowed,
      ownOrigin: appOrigin(),
      proxy: (u) => (/^https?:\/\//i.test(u) && u.length <= 2000 ? proxied(userId, u) : null),
      cid: (c) => {
        const id = cids.get(c);
        return id ? `/api/mail/att/${id}?inline=1` : null;
      },
    });
    const blocked = allowed ? 0 : out.remote;
    return { html: doc(out.html, Boolean(opts.dark), false, blocked), blocked };
  }
  return { html: doc(textToHtml(row.text ?? "", appOrigin()), Boolean(opts.dark), true), blocked: 0 };
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function doc(body: string, dark: boolean, plain: boolean, blocked = 0): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="zv-blocked" content="${blocked}"><base target="_blank"><style>${STYLE(dark, plain)}</style></head><body>${body}</body></html>`;
}

function appOrigin(): string {
  try {
    return new URL(config.appUrl).origin;
  } catch {
    return "";
  }
}

/**
 * The frame's own policy: no scripts, no forms, no frames; images only from
 * the image proxy and the message's own parts (and data:), fonts only zvena's
 * — never any other address of zvena, which a crafted style could otherwise
 * make the reader's browser call with their cookies.
 */
export function bodyCsp(): string {
  const o = appOrigin();
  const img = o ? `${o}/api/mail/img ${o}/api/mail/att/` : "'self'";
  const font = o ? `${o}/fonts/` : "'self'";
  return `default-src 'none'; img-src data: ${img}; style-src 'unsafe-inline'; font-src data: ${font}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox`;
}
