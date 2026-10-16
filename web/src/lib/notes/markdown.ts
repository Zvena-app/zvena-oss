// zvena Documents Markdown helpers (pure):
// - mdToHtml: a small, safe renderer for HTML export and previews (escapes
//   everything, then adds headings, lists, to-dos, quotes, code, tables,
//   emphasis, links; [Title](note:<id>) becomes an in-app page link);
// - blocksToMarkdown: BlockNote block JSON → Markdown (export) without an
//   editor instance.

import { iconText, inlineText, sanitizeBlocks } from "./model";
import { personName } from "./people";
import type { Note } from "./types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(src: string): string {
  // Code spans first (their content is literal).
  const codes: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // Links: [text](url) — note:<id>, http(s), mailto only. The opening tag is
  // held aside like code, so "_" or "*" in a URL never turns into emphasis.
  const tags: string[] = [];
  const hold = (tag: string) => `\u0001${tags.push(tag) - 1}\u0001`;
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const u = url.replace(/&amp;/g, "&");
    if (/^note:[A-Za-z0-9_-]{6,64}$/.test(u)) return `${hold(`<a class="nt-md-note" data-note="${esc(u.slice(5))}" href="#">`)}${text}</a>`;
    if (/^(https?:|mailto:)/i.test(u)) return `${hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">`)}${text}</a>`;
    return text;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  // Date mentions exported as @2026-10-16 / @2026-10-16T07:00 (🔔 = with a reminder) show as chips.
  s = s.replace(/@(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?( ?🔔(?:at|5m|10m|15m|30m|1h|2h|day|1d|2d|1w)?)?/gu, (whole, y: string, mo: string, d: string, h?: string, mi?: string, bell?: string) => {
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0));
    if (Number.isNaN(date.getTime()) || date.getDate() !== Number(d)) return whole;
    const text = `${date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}${h ? ` ${h}:${mi}` : ""}`;
    return `<span class="nt-md-date">${text}${bell ? " 🔔" : ""}</span>`;
  });
  return s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => tags[Number(i)] ?? "").replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const listStack: ("ul" | "ol")[] = [];
  const closeLists = () => {
    while (listStack.length) out.push(`</${listStack.pop()}>`);
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      closeLists();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      closeLists();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeLists();
      const lvl = Math.min(4, h[1].length);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeLists();
      out.push("<hr>");
      i++;
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const depth = Math.floor(li[1].replace(/\t/g, "  ").length / 2);
      const kind: "ul" | "ol" = /\d/.test(li[2]) ? "ol" : "ul";
      while (listStack.length > depth + 1) out.push(`</${listStack.pop()}>`);
      if (listStack.length < depth + 1) {
        listStack.push(kind);
        out.push(`<${kind}>`);
      } else if (listStack[listStack.length - 1] !== kind) {
        out.push(`</${listStack.pop()}>`);
        listStack.push(kind);
        out.push(`<${kind}>`);
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(li[3]);
      if (task) out.push(`<li class="nt-md-task"><input type="checkbox" disabled${task[1].trim() ? " checked" : ""}>${inline(task[2])}</li>`);
      else out.push(`<li>${inline(li[3])}</li>`);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      closeLists();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${body.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      closeLists();
      i++;
      continue;
    }
    closeLists();
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*([-*+]|\d+[.)])\s|\s*>|\s*```|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  closeLists();
  return out.join("");
}

// ---------------------------------------------------------------------------
// Blocks → Markdown

interface StyledText {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  href?: string;
  content?: unknown;
  props?: Record<string, unknown>;
}

/** A link target that survives Markdown: spaces and parentheses would end it early. */
function mdUrl(url: string): string {
  return url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Markers hug the text: "**bold **" is not bold in Markdown, so edge spaces go outside. */
function wrap(t: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t) as RegExpExecArray;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : t;
}

/** A code span whose fence is longer than any backtick run inside it. */
function codeSpan(t: string): string {
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return longest ? `${fence} ${t} ${fence}` : `\`${t}\``;
}

function mdInline(content: unknown, lookup?: (id: string) => Note | undefined): string {
  if (!Array.isArray(content)) return inlineText(content);
  return content
    .map((raw) => {
      const n = raw as StyledText;
      if (!n || typeof n !== "object") return "";
      if (n.type === "link") return `[${mdInline(n.content, lookup)}](${mdUrl(n.href ?? "")})`;
      if (n.type === "mention") {
        // A reminder rides along as 🔔<code>, so a Markdown copy imports back with it.
        if (n.props?.date) return `@${String(n.props.date)}${n.props.remind ? ` 🔔${String(n.props.remind)}` : ""}`;
        // A person: their name (never the id).
        if (n.props?.userId || n.props?.name) return `@${personName(String(n.props?.userId ?? "")) || String(n.props?.name ?? "") || "?"}`;
        const t = lookup?.(String(n.props?.noteId ?? ""))?.title;
        return t ? `[${t}]` : "";
      }
      if (n.type === "inlineEquation") return `$${String(n.props?.latex ?? "")}$`;
      if (n.type === "customEmoji") return `:${String(n.props?.name ?? "")}:`;
      if (n.type === "linkMention") return `[${String(n.props?.title || n.props?.url || "")}](${mdUrl(String(n.props?.url ?? ""))})`;
      if (n.type !== "text") return mdInline(n.content, lookup);
      let t = n.text ?? "";
      if (!t) return "";
      const st = n.styles ?? {};
      if (st.code) return codeSpan(t);
      if (st.bold) t = wrap(t, "**");
      if (st.italic) t = wrap(t, "*");
      if (st.strike) t = wrap(t, "~~");
      return t;
    })
    .join("");
}

interface MdBlock {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown[];
}

export function blocksToMarkdown(input: unknown, lookup?: (id: string) => Note | undefined, depth = 0): string {
  if (!Array.isArray(input)) return "";
  // Exported as the page reads: open suggestions are not part of it yet.
  const blocks: unknown[] = depth === 0 ? sanitizeBlocks(input) : input;
  const pad = "  ".repeat(depth);
  const out: string[] = [];
  let num = 0;
  for (const raw of blocks) {
    const b = raw as MdBlock;
    if (!b || typeof b !== "object") continue;
    if (b.type === "synced") {
      // A synced block exports the content it shows (loops stop after a few levels).
      const src = depth < 8 ? lookup?.(String(b.props?.noteId ?? "")) : undefined;
      if (src?.synced) out.push(blocksToMarkdown(src.content, lookup, depth + 1));
      continue;
    }
    if (b.type === "columnList" || b.type === "column") {
      // Markdown has no columns: their blocks follow one another.
      num = 0;
      out.push(blocksToMarkdown(b.children, lookup, depth));
      continue;
    }
    if (b.type === "tabs") {
      // Nor tabs: each tab's title in bold, then its blocks.
      num = 0;
      for (const tab of (b.children ?? []) as typeof b[]) {
        const title = String(tab.props?.title ?? "").trim();
        if (title) out.push(`${"  ".repeat(depth)}**${title.replace(/([*_`\\])/g, "\\$1")}**`);
        out.push(blocksToMarkdown(tab.children, lookup, depth));
      }
      continue;
    }
    const text = mdInline(b.content, lookup);
    const p = b.props ?? {};
    if (b.type !== "numberedListItem") num = 0;
    let line = "";
    switch (b.type) {
      case "heading":
        line = `${"#".repeat(Number(p.level) || 1)} ${text}`;
        break;
      case "bulletListItem":
      case "toggleListItem":
        line = `${pad}- ${text}`;
        break;
      case "numberedListItem":
        num += 1;
        line = `${pad}${num}. ${text}`;
        break;
      case "checkListItem":
        line = `${pad}- [${p.checked ? "x" : " "}] ${text}`;
        break;
      case "quote":
        line = `> ${text}`;
        break;
      case "callout":
        line = `> ${iconText(String(p.icon ?? "")) ? `${iconText(String(p.icon))} ` : ""}${text}`;
        break;
      case "codeBlock": {
        // The fence outgrows any ``` run inside the code.
        const code = inlineText(b.content);
        const fence = "`".repeat(Math.max(2, ...(code.match(/`+/g) ?? []).map((r) => r.length)) + 1);
        line = `${fence}${String(p.language ?? "")}\n${code}\n${fence}`;
        break;
      }
      case "divider":
        line = "---";
        break;
      case "image":
        line = `![${String(p.caption || p.name || "")}](${mdUrl(String(p.url ?? ""))})`;
        break;
      case "video":
      case "audio":
      case "file":
      case "pdf":
        line = `[${String(p.name || p.caption || p.url || "file")}](${mdUrl(String(p.url ?? ""))})`;
        break;
      case "bookmark":
      case "embed":
        line = `[${String(p.title || p.url || "")}](${mdUrl(String(p.url ?? ""))})`;
        break;
      case "equation":
        line = `$$\n${String(p.latex ?? "")}\n$$`;
        break;
      case "mermaid":
        line = `\`\`\`mermaid\n${String(p.code ?? "")}\n\`\`\``;
        break;
      case "design":
        line = `> 🎨 ${String(p.name || "Design")}`;
        break;
      case "page":
      case "database": {
        const n = lookup?.(String(p.noteId ?? ""));
        line = n ? `[${iconText(n.icon) ? `${iconText(n.icon)} ` : ""}${n.title || "Untitled"}](${n.id})` : "";
        break;
      }
      case "toc":
      case "breadcrumb":
      case "button":
        line = "";
        break;
      case "table": {
        const rows = ((b.content as { rows?: { cells?: unknown[] }[] })?.rows ?? []).map((r) => (r.cells ?? []).map((c) => mdInline((c as { content?: unknown })?.content ?? c, lookup).replace(/\|/g, "\\|").replace(/\n/g, " ")));
        if (rows.length) {
          const w = Math.max(...rows.map((r) => r.length));
          const fill = (r: string[]) => [...r, ...Array(w - r.length).fill("")];
          line = [`| ${fill(rows[0]).join(" | ")} |`, `| ${Array(w).fill("---").join(" | ")} |`, ...rows.slice(1).map((r) => `| ${fill(r).join(" | ")} |`)].join("\n");
        }
        break;
      }
      default:
        line = depth > 0 ? `${pad}${text}` : text;
    }
    out.push(line);
    if (Array.isArray(b.children) && b.children.length) {
      const listy = ["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"].includes(b.type ?? "");
      out.push(blocksToMarkdown(b.children, lookup, listy ? depth + 1 : depth));
    }
  }
  // Blank lines between top-level blocks; list items stay tight.
  return out
    .filter((l) => l !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** One note as a Markdown document (title + properties + body). */
export function noteToMarkdown(n: Note, lookup?: (id: string) => Note | undefined, propLines?: string[]): string {
  const head = `# ${iconText(n.icon) ? `${iconText(n.icon)} ` : ""}${n.title || "Untitled"}`;
  const props = propLines?.length ? `\n\n${propLines.join("\n")}` : "";
  const body = blocksToMarkdown(n.content, lookup);
  return `${head}${props}\n\n${body}\n`;
}
