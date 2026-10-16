import type { ReactNode } from "react";
import type { TplNode, TplRow } from "@/components/notes/templates";

// A Docs template as it reads, rendered from the template itself
// (components/notes/templates.ts, its English build): the page's blocks,
// its databases as tables with their sample rows, its sub-pages. Read-only
// and static — nothing here runs the editor or saves anything.

type B = Record<string, unknown>;

const DAY_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDate = (ymd: unknown) => (typeof ymd === "string" && /^\d{4}-\d{2}-\d{2}/.test(ymd) ? DAY_FMT.format(new Date(`${ymd.slice(0, 10)}T12:00:00Z`)) : "");

const VIEW_NAMES: Record<string, string> = { table: "Table", board: "Board", list: "List", gallery: "Gallery", calendar: "Calendar", timeline: "Timeline", chart: "Chart" };

function Inline({ content }: { content: unknown }): ReactNode {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content.map((raw, i) => {
    const c = raw as B;
    if (c.type === "mention") {
      const date = fmtDate((c.props as B | undefined)?.date);
      return date ? (
        <span key={i} className="zt-mention">
          {date}
        </span>
      ) : null;
    }
    const text = typeof c.text === "string" ? c.text : "";
    const st = (c.styles as B | undefined) ?? {};
    let out: ReactNode = text;
    if (st.code) out = <code>{out}</code>;
    if (st.italic) out = <em>{out}</em>;
    if (st.bold) out = <strong>{out}</strong>;
    return <span key={i}>{out}</span>;
  });
}

const empty = (content: unknown) => content === undefined || content === "" || (Array.isArray(content) && content.length === 0);

function Blocks({ blocks, depth }: { blocks: B[]; depth: number }): ReactNode {
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Consecutive list items share one list.
    const list = b.type === "bulletListItem" ? "ul" : b.type === "numberedListItem" ? "ol" : b.type === "checkListItem" ? "check" : null;
    if (list) {
      const items: B[] = [];
      while (i < blocks.length && blocks[i].type === b.type) items.push(blocks[i++]);
      i--;
      const lis = items.map((it, k) => (
        <li key={k} data-checked={list === "check" ? Boolean((it.props as B | undefined)?.checked) || undefined : undefined}>
          {list === "check" && <span className="zt-box" aria-hidden="true" />}
          <Inline content={it.content} />
          {Array.isArray(it.children) && it.children.length > 0 && <Blocks blocks={it.children as B[]} depth={depth} />}
        </li>
      ));
      out.push(list === "ol" ? <ol key={i}>{lis}</ol> : <ul key={i} className={list === "check" ? "zt-checks" : undefined}>{lis}</ul>);
      continue;
    }
    out.push(<Block key={i} b={b} depth={depth} />);
  }
  return out;
}

function Block({ b, depth }: { b: B; depth: number }): ReactNode {
  const props = (b.props as B | undefined) ?? {};
  switch (b.type) {
    case "heading": {
      // The page's own title is the h2 of the preview: its headings sit below it.
      const level = Number(props.level) || 1;
      const H = level === 1 ? "h3" : "h4";
      return <H className={`zt-h zt-h${level}`}><Inline content={b.content} /></H>;
    }
    case "paragraph":
      return empty(b.content) ? null : (
        <p>
          <Inline content={b.content} />
        </p>
      );
    case "callout":
      return (
        <div className="zt-callout">
          <span aria-hidden="true">{String(props.icon ?? "")}</span>
          <div>
            <Inline content={b.content} />
          </div>
        </div>
      );
    case "quote":
      return (
        <blockquote>
          <Inline content={b.content} />
        </blockquote>
      );
    case "divider":
      return <hr />;
    case "codeBlock":
      return (
        <pre>
          <code>{typeof b.content === "string" ? b.content : ""}</code>
        </pre>
      );
    case "mermaid":
      return (
        <figure className="zt-embed">
          <figcaption>Diagram (Mermaid)</figcaption>
          <pre>
            <code>{String(props.code ?? "")}</code>
          </pre>
        </figure>
      );
    case "toc":
      return <p className="zt-embed zt-muted">Table of contents</p>;
    case "design":
      return <p className="zt-embed zt-muted">A live frame from zvena Design goes here</p>;
    case "toggleListItem":
      return (
        <details className="zt-toggle">
          <summary>
            <Inline content={b.content} />
          </summary>
          {Array.isArray(b.children) && <Blocks blocks={b.children as B[]} depth={depth} />}
        </details>
      );
    case "columnList":
      return (
        <div className="zt-cols">
          {((b.children as B[] | undefined) ?? []).map((c, i) => (
            <div key={i}>
              <Blocks blocks={(c.children as B[] | undefined) ?? []} depth={depth} />
            </div>
          ))}
        </div>
      );
    default:
      return empty(b.content) ? null : (
        <p>
          <Inline content={b.content} />
        </p>
      );
  }
}

function cell(v: TplRow["values"][string], type: string): ReactNode {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean" || type === "checkbox") return <span className="zt-box" data-checked={v === true || undefined} aria-label={v ? "Yes" : "No"} />;
  if (typeof v === "object" && "option" in v) return <span className="zt-chip">{v.option}</span>;
  if (typeof v === "object" && "options" in v)
    return v.options.map((o) => (
      <span className="zt-chip" key={o}>
        {o}
      </span>
    ));
  if (typeof v === "object" && "start" in (v as object)) return fmtDate((v as { start?: unknown }).start);
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "string") return v;
  return null;
}

/** `named`: show its name (an inline database; a template that is a database has it as the page title). */
function Database({ node, named = true }: { node: TplNode; named?: boolean }) {
  const props = node.props ?? [];
  const rows = node.rows ?? [];
  const views = (node.views ?? [{ type: "table", name: "Table" }]).map((v) => v.name || VIEW_NAMES[v.type] || v.type);
  return (
    <div className="zt-db">
      <div className="zt-db-head">
        {named ? (
          <b>
            {node.icon} {node.title}
          </b>
        ) : (
          <span />
        )}
        <span className="zt-views" aria-label="Views">
          {views.map((v) => (
            <span key={v}>{v}</span>
          ))}
        </span>
      </div>
      <div className="zt-db-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              {props.map((p) => (
                <th key={p.key}>{p.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={props.length + 1} className="zt-muted">
                  Empty — add your first row
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.icon ? `${r.icon} ` : ""}
                    {r.title}
                  </td>
                  {props.map((p) => (
                    <td key={p.key}>{cell(r.values[p.key], p.type)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One node of the template: a page (blocks, then what is under it) or a database. */
export function TemplatePreview({ node, depth = 0 }: { node: TplNode; depth?: number }) {
  if (node.kind === "database") return <Database node={node} named={depth > 0} />;
  const kids = node.children ?? [];
  return (
    <>
      <Blocks blocks={(node.content ?? []) as B[]} depth={depth} />
      {kids.map((c, i) =>
        c.kind === "database" ? (
          <Database key={i} node={c} />
        ) : depth >= 2 ? (
          <p key={i} className="zt-subpage">
            {c.icon} {c.title}
          </p>
        ) : (
          <details key={i} className="zt-subpage">
            <summary>
              {c.icon} {c.title}
            </summary>
            <div className="zt-subpage-body">
              <TemplatePreview node={c} depth={depth + 1} />
            </div>
          </details>
        )
      )}
    </>
  );
}

/** A line about what the template is made of, from the template itself. */
export function templateSummary(node: TplNode): string {
  const dbs: TplNode[] = [];
  let pages = 0;
  const walk = (n: TplNode, root: boolean) => {
    if (n.kind === "database") dbs.push(n);
    else if (!root) pages++;
    for (const c of n.children ?? []) walk(c, false);
  };
  walk(node, true);
  const parts: string[] = [];
  if (node.kind === "database") {
    const views = [...new Set((node.views ?? [{ type: "table" }]).map((v) => VIEW_NAMES[v.type] ?? v.type))];
    parts.push(`A database with ${views.length === 1 ? `a ${views[0].toLowerCase()} view` : `${views.slice(0, -1).join(", ")} and ${views.at(-1)} views`}`);
    const rows = node.rows?.length ?? 0;
    if (rows) parts.push(`${rows} sample ${rows === 1 ? "row" : "rows"}`);
  } else {
    parts.push("A page");
    if (dbs.length) parts.push(dbs.length === 1 ? "a database" : `${dbs.length} databases`);
    if (pages) parts.push(pages === 1 ? "one sub-page" : `${pages} sub-pages`);
  }
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.` : `${parts[0]}.`;
}
