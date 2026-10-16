// Injected into the tab being clipped (an isolated world, at the person's
// click): reads the page without changing it. Readability works on a copy
// of the document; the article and the selection are cleaned in inert
// documents (nothing loads or runs there), with every URL made absolute.

import { Readability } from "@mozilla/readability";
import { absUrl, pickSrcset } from "./lib/urls.js";

const DROP = "script,style,noscript,template,link,meta,object,embed,form,input,button,select,textarea,dialog,canvas,svg";
const LAZY = ["data-src", "data-lazy-src", "data-original", "data-url", "data-hi-res-src"];

function metaContent(doc, names) {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return "";
}

/** Absolute URLs, no scripts, styles, handlers or classes: what the server is sent. */
function clean(root, base) {
  root.querySelectorAll(DROP).forEach((el) => el.remove());
  // <picture>: the <img> inside stays, with the best source picked below.
  root.querySelectorAll("picture source").forEach((el) => el.remove());
  for (const el of root.querySelectorAll("*")) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || n === "style" || n === "class" || n === "id" || (n.startsWith("data-") && !LAZY.includes(n))) el.removeAttribute(a.name);
    }
  }
  for (const a of root.querySelectorAll("a[href]")) {
    const href = absUrl(a.getAttribute("href"), base);
    if (href) a.setAttribute("href", href);
    else a.replaceWith(...a.childNodes);
  }
  for (const img of root.querySelectorAll("img")) {
    const set = img.getAttribute("srcset") || img.getAttribute("data-srcset");
    const lazy = LAZY.map((n) => img.getAttribute(n)).find(Boolean);
    const raw = img.getAttribute("src") || "";
    // Lazy loaders keep a tiny placeholder in src and the real picture elsewhere.
    const candidate = (set && pickSrcset(set)) || (lazy && (!raw || /^data:/.test(raw)) ? lazy : raw);
    const src = absUrl(candidate, base, { image: true });
    for (const n of ["srcset", "sizes", "data-srcset", "loading", "decoding", ...LAZY]) img.removeAttribute(n);
    if (src) img.setAttribute("src", src);
    else img.remove();
  }
  for (const el of root.querySelectorAll("video[src], audio[src], iframe[src], source[src]")) {
    const src = absUrl(el.getAttribute("src"), base);
    if (src) el.setAttribute("src", src);
    else el.remove();
  }
  for (const el of root.querySelectorAll("[poster]")) el.removeAttribute("poster");
  return root;
}

function inert() {
  return document.implementation.createHTMLDocument("");
}

function cleanHtml(html, base) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return clean(doc.body, base).innerHTML.trim();
}

function selectionHtml(base) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  const doc = inert();
  const box = doc.createElement("div");
  for (let i = 0; i < sel.rangeCount; i++) box.appendChild(doc.importNode(sel.getRangeAt(i).cloneContents(), true));
  return clean(box, base).innerHTML.trim();
}

function favicon(base) {
  const link = [...document.querySelectorAll("link[rel][href]")].find((l) => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(l.getAttribute("rel") || ""));
  return absUrl(link?.getAttribute("href") || "/favicon.ico", base, { image: true });
}

globalThis.__zvExtract = ({ article = true } = {}) => {
  const base = document.baseURI;
  const out = {
    url: location.href,
    title: metaContent(document, ["og:title", "twitter:title"]) || document.title || "",
    siteName: metaContent(document, ["og:site_name", "application-name"]),
    excerpt: metaContent(document, ["og:description", "twitter:description", "description"]),
    cover: absUrl(metaContent(document, ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]), base, { image: true }),
    favicon: favicon(base),
    byline: "",
    content: "",
    selection: selectionHtml(base),
  };
  if (article) {
    try {
      const copy = document.cloneNode(true);
      const r = new Readability(copy, { keepClasses: false, charThreshold: 200 }).parse();
      if (r?.content) {
        out.content = cleanHtml(r.content, base);
        if (r.title) out.title = r.title;
        out.byline = r.byline || "";
        out.excerpt ||= r.excerpt || "";
        out.siteName ||= r.siteName || "";
      }
    } catch {
      // A page Readability cannot read: the main region as it is.
    }
    if (!out.content) {
      const main = document.querySelector("article, main, [role=main]") || document.body;
      if (main) out.content = cleanHtml(main.innerHTML, base);
    }
  }
  return out;
};
