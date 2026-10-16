"use client";

// The list of everything that can be made, as tiles (Canva's "Create a
// design"): type to filter, click to make it. Each tile is a plain link to
// /new, so it opens instantly, works with a middle click (new tab) and needs
// no script to work. Used by the "+ Create" popover and Home's hero.

import { useMemo, useState, type ReactNode } from "react";
import { FileText, ListTodo, Maximize2, Monitor, Presentation, Printer, RectangleVertical, Search, Smartphone, Square, Table2 } from "lucide-react";
import { CREATE_ITEMS, CREATE_TEMPLATES, createHref, itemHint, itemLabel, matchCreate, templateHref, templateLabel, type CreateGroup, type CreateItem } from "@/lib/create";
import { useI18n } from "@/lib/i18n-react";
import { ct } from "./i18n";
import "../ds/ds.css";
import "./create.css";

const ICONS: Record<string, ReactNode> = {
  doc: <FileText />,
  table: <Table2 />,
  issue: <ListTodo />,
  presentation: <Presentation />,
  social: <Square />,
  story: <RectangleVertical />,
  mobile: <Smartphone />,
  website: <Monitor />,
  a4: <Printer />,
  blank: <Maximize2 />,
};

const GROUPS: CreateGroup[] = ["write", "plan", "design"];

export function CreateTile({ item, ws, size = "md", forRef }: { item: CreateItem; ws: string; size?: "md" | "lg"; forRef?: string }) {
  const { locale } = useI18n();
  return (
    <a className={`zc-tile zc-tile-${size}`} href={createHref(item, ws, { forRef })} data-create={item.id}>
      <span className="zc-tile-icon" style={{ "--zc-tint": item.tint } as React.CSSProperties}>
        {ICONS[item.id]}
      </span>
      <span className="zc-tile-text">
        <span className="zc-tile-label">{itemLabel(item, locale)}</span>
        <span className="zc-tile-hint">{item.size ? `${item.size[0]} × ${item.size[1]}` : itemHint(item, locale)}</span>
      </span>
    </a>
  );
}

export function CreatePicker({ ws, autoFocus = false, forRef, templates = true }: { ws: string; autoFocus?: boolean; forRef?: string; templates?: boolean }) {
  const { locale } = useI18n();
  const [q, setQ] = useState("");
  const items = useMemo(() => matchCreate(CREATE_ITEMS, q, (x) => `${itemLabel(x, locale)} ${itemHint(x, locale)}`), [q, locale]);
  const tpls = useMemo(() => (templates ? matchCreate(CREATE_TEMPLATES, q, (x) => templateLabel(x, locale)) : []), [q, templates, locale]);
  return (
    <div className="zc-picker">
      <label className="zc-search">
        <Search />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={ct("search", locale)}
          autoFocus={autoFocus}
          onKeyDown={(e) => {
            // Enter makes the first match, the way a search box should.
            if (e.key !== "Enter") return;
            const first = items[0];
            if (first) location.href = createHref(first, ws, { forRef });
            else if (tpls[0]) location.href = templateHref(tpls[0], ws, locale);
          }}
          aria-label={ct("search", locale)}
        />
      </label>
      {items.length === 0 && tpls.length === 0 && <p className="zc-empty">{ct("nothing", locale)}</p>}
      {GROUPS.map((g) => {
        const list = items.filter((x) => x.group === g);
        if (!list.length) return null;
        return (
          <section key={g} className="zc-group">
            <h3 className="zc-group-title">{ct(g, locale)}</h3>
            <div className="zc-grid">
              {list.map((item) => (
                <CreateTile key={item.id} item={item} ws={ws} forRef={forRef} />
              ))}
            </div>
          </section>
        );
      })}
      {tpls.length > 0 && (
        <section className="zc-group">
          <h3 className="zc-group-title">
            {ct("templates", locale)}
            <a className="zc-group-more" href={`/templates?ws=${encodeURIComponent(ws)}`}>
              {ct("allTemplates", locale)}
            </a>
          </h3>
          <div className="zc-tpls">
            {tpls.map((t) => (
              <a key={t.id} className="zc-tpl" href={templateHref(t, ws, locale)}>
                <span className="zc-tpl-emoji" aria-hidden>
                  {t.emoji}
                </span>
                {templateLabel(t, locale)}
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
