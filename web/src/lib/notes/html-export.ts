// zvena Documents: BlockNote block JSON → standalone HTML, for "Export → HTML"
// and "Export → PDF" (Notion's exports). Pure: every link, file and database
// goes through the context, so an export can point page links at the files
// it writes, bundle or drop uploaded files, and render databases as tables.

import { iconText, sanitizeBlocks } from "./model";
import { personName } from "./people";

export interface HtmlContext {
  /** A page or database by id (titles of links and mentions, synced blocks). */
  lookup: (id: string) => { id: string; title: string; icon: string; synced?: boolean; content?: unknown[] } | undefined;
  /** Where a link to a page goes in this export (null: the page is not in it — plain text). */
  pageHref: (id: string) => string | null;
  /** An uploaded file's address in this export (null: left out, "No files or images"). */
  fileUrl: (url: string) => string | null;
  /** A database shown in the page (inline or full page): a table of its rows, or "". */
  databaseHtml?: (id: string) => string;
  untitled: string;
}

const TEXT: Record<string, string> = {
  gray: "#787774",
  brown: "#9f6b53",
  orange: "#d9730d",
  yellow: "#cb912f",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
  red: "#d44c47",
};
const BG: Record<string, string> = {
  gray: "#f1f1ef",
  brown: "#f4eeee",
  orange: "#fbecdd",
  yellow: "#fbf3db",
  green: "#edf3ec",
  blue: "#e7f3f8",
  purple: "#f6f3f9",
  pink: "#faf1f5",
  red: "#fdebec",
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const safeHref = (u: string) => /^(https?:|mailto:)/i.test(u);

const ALIGNS: ReadonlySet<string> = new Set(["center", "right", "justify"]);

function colorStyle(textColor: unknown, bg: unknown): string {
  const parts: string[] = [];
  if (typeof textColor === "string" && TEXT[textColor]) parts.push(`color:${TEXT[textColor]}`);
  if (typeof bg === "string" && BG[bg]) parts.push(`background:${BG[bg]}`);
  return parts.join(";");
}

interface Inline {
  type?: string;
  text?: string;
  styles?: Record<string, unknown>;
  href?: string;
  content?: unknown;
  props?: Record<string, unknown>;
}

export function inlineHtml(content: unknown, ctx: HtmlContext): string {
  if (typeof content === "string") return esc(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((raw) => {
      const n = raw as Inline;
      if (!n || typeof n !== "object") return "";
      if (n.type === "link") {
        const inner = inlineHtml(n.content, ctx);
        const href = String(n.href ?? "");
        const page = /^\/(docs|notes)(\?[^#]*)?#/.test(href) ? (/([A-Za-z0-9]{32})(?:[&?].*)?$/.exec(decodeURIComponent(href.split("#")[1] ?? ""))?.[1] ?? null) : null;
        if (page) {
          const to = ctx.pageHref(page);
          return to ? `<a href="${esc(to)}">${inner}</a>` : inner;
        }
        return safeHref(href) ? `<a href="${esc(href)}">${inner}</a>` : inner;
      }
      if (n.type === "mention") {
        const p = n.props ?? {};
        if (typeof p.userId === "string" && p.userId) return `<span class="mention">@${esc(personName(p.userId) || "?")}</span>`;
        if (typeof p.date === "string" && p.date) return `<span class="mention">@${esc(p.date.replace("T", " "))}</span>`;
        const target = ctx.lookup(String(p.noteId ?? ""));
        if (!target) return "";
        const label = `${iconText(target.icon) ? `${esc(iconText(target.icon))} ` : ""}${esc(target.title || ctx.untitled)}`;
        const to = ctx.pageHref(target.id);
        return to ? `<a class="mention" href="${esc(to)}">${label}</a>` : `<span class="mention">${label}</span>`;
      }
      if (n.type === "inlineEquation") return `<code class="eq">${esc(String(n.props?.latex ?? ""))}</code>`;
      if (n.type === "linkMention") {
        const url = String(n.props?.url ?? "");
        const label = esc(String(n.props?.title || url));
        return safeHref(url) ? `<a class="mention" href="${esc(url)}">${label}</a>` : label;
      }
      if (n.type === "customEmoji") {
        const url = ctx.fileUrl(String(n.props?.url ?? ""));
        const name = esc(String(n.props?.name ?? ""));
        return url ? `<img class="emoji" src="${esc(url)}" alt=":${name}:">` : `:${name}:`;
      }
      if (n.type !== "text") return inlineHtml(n.content, ctx);
      let t = esc(n.text ?? "").replace(/\n/g, "<br>");
      if (!t) return "";
      const st = n.styles ?? {};
      if (st.code) t = `<code>${t}</code>`;
      if (st.bold) t = `<strong>${t}</strong>`;
      if (st.italic) t = `<em>${t}</em>`;
      if (st.underline) t = `<u>${t}</u>`;
      if (st.strike) t = `<s>${t}</s>`;
      const style = colorStyle(st.textColor, st.backgroundColor);
      return style ? `<span style="${style}">${t}</span>` : t;
    })
    .join("");
}

interface Block {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown[];
}

const LIST: Record<string, "ul" | "ol"> = { bulletListItem: "ul", numberedListItem: "ol", checkListItem: "ul" };

function headingsOf(blocks: unknown, out: { level: number; text: string; id: string }[] = []): { level: number; text: string; id: string }[] {
  if (!Array.isArray(blocks)) return out;
  for (const raw of blocks) {
    const b = raw as Block;
    if (b?.type === "heading") out.push({ level: Math.min(4, Number(b.props?.level) || 1), text: plain(b.content), id: String(b.id ?? "") });
    if (Array.isArray(b?.children)) headingsOf(b.children, out);
  }
  return out;
}

function plain(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: Inline) => (c?.type === "text" ? (c.text ?? "") : plain(c?.content))).join("");
}

/** Blocks as HTML; `depth` guards synced blocks that show each other. */
export function blocksToHtml(input: unknown, ctx: HtmlContext, depth = 0, all: unknown = input): string {
  if (!Array.isArray(input) || depth > 12) return "";
  // Exported as the page reads: open suggestions are not part of it yet.
  const blocks: unknown[] = depth === 0 ? sanitizeBlocks(input) : input;
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i] as Block;
    if (!b || typeof b !== "object") {
      i++;
      continue;
    }
    const list = LIST[b.type ?? ""];
    if (list) {
      // A run of list items of one kind is one list.
      const items: string[] = [];
      while (i < blocks.length && LIST[(blocks[i] as Block)?.type ?? ""] === list && ((blocks[i] as Block).type === "checkListItem") === (b.type === "checkListItem")) {
        const x = blocks[i] as Block;
        const style = colorStyle(x.props?.textColor, x.props?.backgroundColor);
        const box = x.type === "checkListItem" ? `<input type="checkbox" disabled${x.props?.checked ? " checked" : ""}> ` : "";
        items.push(`<li${x.type === "checkListItem" ? ' class="todo"' : ""}${style ? ` style="${style}"` : ""}>${box}${inlineHtml(x.content, ctx)}${blocksToHtml(x.children, ctx, depth, all)}</li>`);
        i++;
      }
      out.push(`<${list}${b.type === "checkListItem" ? ' class="todos"' : ""}>${items.join("")}</${list}>`);
      continue;
    }
    out.push(blockHtml(b, ctx, depth, all));
    i++;
  }
  return out.join("\n");
}

function blockHtml(b: Block, ctx: HtmlContext, depth: number, all: unknown): string {
  const p = b.props ?? {};
  const style = colorStyle(p.textColor, p.backgroundColor);
  // Only the alignments there are; every attribute value escaped (a crafted page must not break out of the export's markup).
  const align = typeof p.textAlignment === "string" && ALIGNS.has(p.textAlignment) ? `text-align:${p.textAlignment}` : "";
  const attr = (extra = "") => {
    const s = [style, align, extra].filter(Boolean).join(";");
    return s ? ` style="${esc(s)}"` : "";
  };
  const kids = blocksToHtml(b.children, ctx, depth, all);
  const nested = kids ? `<div class="indent">${kids}</div>` : "";
  const text = inlineHtml(b.content, ctx);
  switch (b.type) {
    case "paragraph":
      return `<p${attr()}>${text || "&nbsp;"}</p>${nested}`;
    case "heading": {
      const lvl = Math.min(4, Math.max(1, Number(p.level) || 1));
      const h = `<h${lvl}${attr()}>${text}</h${lvl}>`;
      return p.isToggleable ? `<details open><summary>${h}</summary>${kids}</details>` : `${h}${nested}`;
    }
    case "toggleListItem":
      return `<details open${attr()}><summary>${text}</summary>${kids}</details>`;
    case "quote":
      return `<blockquote${attr()}>${text}${kids}</blockquote>`;
    case "callout": {
      const icon = iconText(String(p.icon ?? "")) || "💡";
      return `<div class="callout"${attr(BG[String(p.backgroundColor)] ? "" : "background:#f1f1ef")}><span class="callout-icon">${esc(icon)}</span><div>${text}${kids}</div></div>`;
    }
    case "codeBlock":
      return `<pre><code${p.language ? ` class="language-${esc(String(p.language))}"` : ""}>${esc(plain(b.content))}</code></pre>`;
    case "divider":
      return "<hr>";
    case "image": {
      const url = ctx.fileUrl(String(p.url ?? ""));
      if (!url) return "";
      const width = typeof p.previewWidth === "number" && p.previewWidth > 0 ? ` style="max-width:${Math.round(p.previewWidth)}px"` : "";
      return `<figure><img src="${esc(url)}" alt="${esc(String(p.caption || p.name || ""))}"${width}>${p.caption ? `<figcaption>${esc(String(p.caption))}</figcaption>` : ""}</figure>`;
    }
    case "video":
    case "audio": {
      const url = ctx.fileUrl(String(p.url ?? ""));
      if (!url) return "";
      return b.type === "video" ? `<video controls src="${esc(url)}"></video>` : `<audio controls src="${esc(url)}"></audio>`;
    }
    case "file":
    case "pdf": {
      const url = ctx.fileUrl(String(p.url ?? ""));
      const name = esc(String(p.name || p.caption || "file"));
      return url ? `<p class="file">📎 <a href="${esc(url)}">${name}</a></p>` : "";
    }
    case "bookmark":
    case "embed": {
      const url = String(p.url ?? "");
      if (!safeHref(url)) return "";
      return `<p class="bookmark"><a href="${esc(url)}">${esc(String(p.title || url))}</a>${p.description ? `<br><small>${esc(String(p.description))}</small>` : ""}</p>`;
    }
    case "equation":
      return `<pre class="eq">${esc(String(p.latex ?? ""))}</pre>`;
    case "mermaid":
      return `<pre class="mermaid">${esc(String(p.code ?? ""))}</pre>`;
    case "design":
      return `<p class="file">🎨 ${esc(String(p.name || "Design"))}</p>`;
    case "toc": {
      const heads = headingsOf(all);
      return heads.length ? `<nav class="toc">${heads.map((h) => `<div style="padding-left:${(h.level - 1) * 18}px">${esc(h.text)}</div>`).join("")}</nav>` : "";
    }
    case "page":
    case "database": {
      const id = String(p.noteId ?? "");
      const n = ctx.lookup(id);
      if (!n) return "";
      if (b.type === "database" && ctx.databaseHtml) {
        const table = ctx.databaseHtml(id);
        if (table) return table;
      }
      const label = `${iconText(n.icon) ? `${esc(iconText(n.icon))} ` : "📄 "}${esc(n.title || ctx.untitled)}`;
      const to = ctx.pageHref(id);
      return `<p class="link-to-page">${to ? `<a href="${esc(to)}">${label}</a>` : label}</p>`;
    }
    case "synced": {
      const src = ctx.lookup(String(p.noteId ?? ""));
      return src?.synced ? blocksToHtml(src.content, ctx, depth + 1, src.content) : "";
    }
    case "columnList":
      return `<div class="columns">${(b.children ?? []).map((c) => `<div class="column">${blocksToHtml((c as Block).children, ctx, depth, all)}</div>`).join("")}</div>`;
    case "column":
      return `<div class="column">${kids}</div>`;
    case "tabs":
      // A file has no script: each tab's title heads its blocks.
      return `<div class="tabs">${(b.children ?? []).map((c) => `<section class="tab">${String((c as Block).props?.title ?? "").trim() ? `<h4 class="tab-title">${esc(String((c as Block).props?.title).trim())}</h4>` : ""}${blocksToHtml((c as Block).children, ctx, depth, all)}</section>`).join("")}</div>`;
    case "tab":
      return `<section class="tab">${kids}</section>`;
    case "table": {
      const rows = ((b.content as { rows?: { cells?: unknown[] }[] })?.rows ?? []).map((r) => (r.cells ?? []).map((c) => inlineHtml((c as { content?: unknown })?.content ?? c, ctx)));
      if (!rows.length) return "";
      return `<table class="simple">${rows.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`).join("")}</table>`;
    }
    case "breadcrumb":
    case "button":
      return "";
    default:
      return text ? `<p${attr()}>${text}</p>${nested}` : nested;
  }
}

/** The stylesheet of an exported page (Notion's export look; print-ready). */
export const EXPORT_CSS = `
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Inter,ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;max-width:900px;margin:2em auto;padding:0 2em;color:rgb(55,53,47);line-height:1.5;font-size:16px;word-wrap:break-word}
h1.page-title{font-size:2.5rem;font-weight:700;margin:0.6em 0 0.4em;line-height:1.2}
.page-icon{font-size:4rem;line-height:1}
.page-cover{width:100%;height:30vh;max-height:280px;object-fit:cover;border-radius:3px;margin-bottom:1em}
h1{font-size:1.875rem;margin:1.6em 0 .3em}h2{font-size:1.5rem;margin:1.4em 0 .3em}h3{font-size:1.25rem;margin:1em 0 .3em}h4{font-size:1.0625rem;margin:.8em 0 .2em}
h1,h2,h3,h4{font-weight:600;line-height:1.3}
p{margin:.25em 0;min-height:1em}
a{color:inherit;text-decoration:underline;text-decoration-color:rgba(55,53,47,.4)}
.mention{color:rgba(55,53,47,.75);font-weight:500}
code{background:rgba(135,131,120,.15);color:#eb5757;border-radius:4px;padding:.2em .4em;font-size:85%;font-family:"SFMono-Regular",Menlo,Consolas,monospace}
pre{background:#f7f6f3;padding:1.2em 1.4em;border-radius:4px;overflow:auto;font-size:85%;white-space:pre-wrap}
pre code{background:none;color:inherit;padding:0;font-size:inherit}
blockquote{border-left:3px solid currentColor;margin:.4em 0;padding:0 0 0 .9em;font-size:1.1em}
.callout{display:flex;gap:.6em;padding:1em 1em 1em .8em;border-radius:4px;margin:.4em 0}
.callout-icon{font-size:1.3em;line-height:1.2}
hr{border:0;border-top:1px solid rgba(55,53,47,.16);margin:1em 0}
ul,ol{margin:.2em 0;padding-left:1.7em}
ul.todos{list-style:none;padding-left:.3em}
li.todo input{margin:0 .4em 0 0}
details>summary{cursor:pointer}details>summary>:is(h1,h2,h3,h4){display:inline}
.indent{padding-left:1.5em}
figure{margin:.6em 0}figure img{max-width:100%;border-radius:2px}figcaption{color:rgba(55,53,47,.6);font-size:.85em;margin-top:.3em}
video,audio{max-width:100%}
img.emoji{width:1.2em;height:1.2em;vertical-align:-.2em}
.bookmark{border:1px solid rgba(55,53,47,.16);border-radius:4px;padding:.7em .9em}
.columns{display:flex;gap:2em}.column{flex:1;min-width:0}
table{border-collapse:collapse;margin:.6em 0;font-size:.9em}
td,th{border:1px solid rgb(233,233,231);padding:.35em .55em;text-align:left;vertical-align:top}
th{background:#f7f6f3;font-weight:600;color:rgba(55,53,47,.75)}
.db-title{font-weight:600;font-size:1.25rem;margin:1.2em 0 .2em}
.toc div{padding:.15em 0;color:rgba(55,53,47,.75)}
.page-break{break-after:page}
.props{margin:.4em 0 1.2em}.props td{border:0;padding:.15em 1em .15em 0}.props td:first-child{color:rgba(55,53,47,.6);white-space:nowrap}
@media print{body{margin:0;max-width:none;padding:0}a{text-decoration:none}pre,blockquote,.callout,figure,table,tr{break-inside:avoid}}
`;
