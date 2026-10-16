"use client";

// Templates gallery (Notion's): categories, a live preview, "Use template".
// Loads with the templates themselves.

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useNotes } from "./context";
import { Modal } from "./ui";
import { TEMPLATES, TEMPLATE_CATEGORIES, instantiateTemplate, type TplNode } from "./templates";
import { blocksToMarkdown, mdToHtml } from "@/lib/notes/markdown";
import type { NotesKey } from "@/lib/notes/i18n";
import { iconText } from "@/lib/notes/model";

function previewHtml(node: TplNode, nameColumn: string): string {
  let md = `# ${iconText(node.icon)} ${node.title}\n\n`;
  if (node.kind === "page") md += blocksToMarkdown(node.content ?? []);
  else {
    const cols = [nameColumn, ...(node.props ?? []).map((p) => p.name)];
    md += `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |\n`;
    for (const r of node.rows ?? []) {
      const cells = (node.props ?? []).map((p) => {
        const v = r.values[p.key];
        if (v === undefined || v === null) return "";
        if (typeof v === "object" && "option" in v) return v.option;
        if (typeof v === "object" && "options" in v) return v.options.join(", ");
        if (typeof v === "object" && "start" in v) return v.start;
        if (typeof v === "boolean") return v ? "✓" : "";
        return String(v);
      });
      md += `| ${[`${r.icon ?? ""} ${r.title}`.trim(), ...cells].join(" | ")} |\n`;
    }
  }
  for (const c of node.children ?? []) md += `\n\n**${iconText(c.icon)} ${c.title}**`;
  return mdToHtml(md);
}

export function TemplatesDialog({ onClose }: { onClose: () => void }) {
  const api = useNotes();
  const { t, locale, store } = api;
  const [sel, setSel] = useState(TEMPLATES[0].key);
  const tpl = TEMPLATES.find((x) => x.key === sel) ?? TEMPLATES[0];
  const html = useMemo(() => previewHtml(tpl.build(locale), t("db.name")), [tpl, locale, t]);
  const use = () => {
    // Viewers and commenters may look, not add pages.
    if (api.readOnly) return;
    const root = instantiateTemplate(tpl, locale, store, null);
    onClose();
    api.open(root.id);
  };
  return (
    <Modal onClose={onClose} label={t("tpl.title")} className="nt-tpl">
      <div className="nt-tpl-wrap">
        <div className="nt-tpl-list">
          <h2>{t("tpl.title")}</h2>
          <p>{t("tpl.subtitle")}</p>
          {TEMPLATE_CATEGORIES.map((cat) => (
            <div key={cat} className="nt-tpl-group">
              {cat !== "start" && <div className="nt-menu-label">{t(`tpl.cat.${cat}` as NotesKey)}</div>}
              {TEMPLATES.filter((x) => x.category === cat).map((x) => (
                <div key={x.key} className="nt-item" data-active={x.key === sel || undefined} role="button" onClick={() => setSel(x.key)} onDoubleClick={use}>
                  <span className="nt-item-icon">{x.icon}</span>
                  <span className="nt-item-label">{t(`tpl.${x.key}` as NotesKey)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="nt-tpl-preview">
          <div className="nt-tpl-preview-head">
            <b style={{ fontSize: 14 }}>
              {tpl.icon} {t(`tpl.${tpl.key}` as NotesKey)}
            </b>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" disabled={api.readOnly} onClick={use}>
                {t("tpl.use")}
              </button>
              <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} onClick={onClose}>
                <X />
              </button>
            </div>
          </div>
          <div className="nt-tpl-preview-body nt-md" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </Modal>
  );
}
