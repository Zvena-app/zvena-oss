"use client";

// Notion's Export dialog: format (PDF, HTML, Markdown & CSV), databases as
// the current or the default view, everything or no files and images,
// sub-pages (in folders), and for PDF the page format and the scale. The
// same dialog exports the whole workspace (Settings → Export all).

import { useEffect, useState } from "react";
import { useNotes } from "./context";
import { Modal, toast } from "./ui";
import { exportPart } from "./lazy";
import type { ExportOptions, PageFormat } from "./export";
import type { NotesKey } from "@/lib/notes/i18n";
import { displayTitle } from "@/lib/notes/model";
import type { Note } from "@/lib/notes/types";

const PREF = "nt-export";
const DEFAULTS: ExportOptions = { format: "pdf", databases: "current", content: "all", subpages: false, folders: true, pageFormat: "A4", scale: 100 };

function remembered(): ExportOptions {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREF) || "{}") as Partial<ExportOptions>) };
  } catch {
    return DEFAULTS;
  }
}

const PAGE_FORMATS: PageFormat[] = ["A4", "A3", "Letter", "Legal", "Tabloid"];

/** `note`: the page to export; null: the whole workspace (always with sub-pages, never as PDF). */
export function ExportDialog({ note, onClose }: { note: Note | null; onClose: () => void }) {
  const { t, snap, locale, user } = useNotes();
  const workspace = note === null;
  const [o, setO] = useState<ExportOptions>(() => {
    const r = remembered();
    return workspace ? { ...r, format: r.format === "pdf" ? "md" : r.format, subpages: true } : r;
  });
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => void exportPart.load().catch(() => {}), []);
  const set = (patch: Partial<ExportOptions>) => setO((cur) => ({ ...cur, ...patch }));
  const hasKids = workspace || snap.list.some((n) => n.parentId === note?.id && n.trashedAt === null);

  const run = async () => {
    try {
      localStorage.setItem(PREF, JSON.stringify({ ...o, subpages: workspace ? remembered().subpages : o.subpages }));
    } catch {
      // Private mode: the choices are not remembered.
    }
    setBusy({ done: 0, total: 0 });
    try {
      const m = await exportPart.load();
      const roots = workspace ? snap.list.filter((n) => n.parentId === null && n.trashedAt === null && !n.synced).map((n) => n.id) : [note.id];
      const zipName = workspace ? `${user?.ws.name || "zvena"} ${new Date().toISOString().slice(0, 10)}` : displayTitle(note, t("page.untitled"));
      await m.runExport(roots, o, { all: snap.list, byId: snap.byId, locale, labels: { untitled: t("page.untitled") }, zipName }, (done, total) => setBusy({ done, total }));
      onClose();
    } catch {
      toast(t("export.failed"));
      setBusy(null);
    }
  };

  const row = (label: NotesKey, control: React.ReactNode, hint?: NotesKey) => (
    <div className="nt-export-row">
      <div>
        <div>{t(label)}</div>
        {hint && <p>{t(hint)}</p>}
      </div>
      {control}
    </div>
  );
  const select = <K extends keyof ExportOptions>(key: K, options: [ExportOptions[K], string][]) => (
    <select className="nt-select" value={String(o[key])} onChange={(e) => set({ [key]: options.find(([v]) => String(v) === e.target.value)?.[0] } as Partial<ExportOptions>)}>
      {options.map(([v, label]) => (
        <option key={String(v)} value={String(v)}>
          {label}
        </option>
      ))}
    </select>
  );
  const toggle = (key: "subpages" | "folders", label: NotesKey) => (
    <button type="button" role="switch" aria-checked={o[key]} aria-label={t(label)} className="nt-switch nt-btn-reset" onClick={() => set({ [key]: !o[key] })}>
      <span />
    </button>
  );

  return (
    <Modal onClose={busy ? () => {} : onClose} label={t("export.title")} className="nt-export">
      <div className="nt-export-body">
        <h2>{workspace ? t("export.titleAll") : t("export.title")}</h2>
        {row(
          "export.format",
          select(
            "format",
            workspace
              ? [
                  ["html", t("export.html")],
                  ["md", t("export.md")],
                ]
              : [
                  ["pdf", t("export.pdf")],
                  ["html", t("export.html")],
                  ["md", t("export.md")],
                ]
          )
        )}
        {row(
          "export.databases",
          select("databases", [
            ["current", t("export.currentView")],
            ["default", t("export.defaultView")],
          ])
        )}
        {row(
          "export.content",
          select("content", [
            ["all", t("export.everything")],
            ["nofiles", t("export.noFiles")],
          ])
        )}
        {!workspace && hasKids && row("export.subpages", toggle("subpages", "export.subpages"))}
        {o.format !== "pdf" && (workspace || o.subpages) && row("export.folders", toggle("folders", "export.folders"))}
        {o.format === "pdf" && (
          <>
            {row(
              "export.pageFormat",
              select(
                "pageFormat",
                PAGE_FORMATS.map((f) => [f, f] as [PageFormat, string])
              )
            )}
            {row(
              "export.scale",
              <input
                className="nt-input nt-export-scale"
                type="number"
                min={10}
                max={200}
                value={o.scale}
                onChange={(e) => set({ scale: Math.min(200, Math.max(10, Number(e.target.value) || 100)) })}
              />
            )}
          </>
        )}
        {busy && busy.total > 0 && <div className="nt-export-progress">{t("export.progress", { done: busy.done, total: busy.total })}</div>}
        <div className="nt-export-actions">
          <button type="button" className="nt-btn nt-btn-plain nt-btn-reset" disabled={Boolean(busy)} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" disabled={Boolean(busy)} onClick={() => void run()}>
            {busy ? t("export.exporting") : t("export.export")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
