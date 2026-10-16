"use client";

// Notion's Import dialog: a tile per source (Evernote, Trello, Asana,
// Confluence, Text & Markdown, CSV, HTML, Word, Google Docs, Dropbox Paper,
// Jira, Notion); a tile picks files of its kind. Big imports show how far
// they got and can be cancelled; files a ZIP left out (too large, over the
// import's limits, damaged) are listed when it is done.

import { useRef, useState } from "react";
import { BookOpen, Box, Bug, FileArchive, FileCode2, FileSpreadsheet, FileText, FileType, ListChecks, NotebookPen, SquareKanban, X } from "lucide-react";
import { useNotes } from "./context";
import { Modal, toast } from "./ui";
import { importFile } from "./importer";
import type { NotesKey } from "@/lib/notes/i18n";
import { ZipError, type SkipReason, type SkippedEntry } from "@/lib/notes/zip";

const SKIP_KEY: Record<SkipReason, NotesKey> = {
  "too-large": "import.skip.tooLarge",
  budget: "import.skip.budget",
  "too-many": "import.skip.tooMany",
  "too-deep": "import.skip.tooDeep",
  ratio: "import.skip.ratio",
  corrupt: "import.skip.corrupt",
  unsupported: "import.skip.unsupported",
  encrypted: "import.skip.encrypted",
};
/** Rows of the report shown at most (the rest is a count). */
const REPORT_ROWS = 100;

const ALL = ".zip,.md,.markdown,.txt,.html,.htm,.csv,.enex,.docx,.json";

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const api = useNotes();
  const { t, store } = api;
  const input = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState(ALL);
  const [busy, setBusy] = useState<{ file: number; files: number; done: number; total: number } | null>(null);
  const [report, setReport] = useState<{ pages: number; rows: SkippedEntry[]; more: number; last: string | null } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const finish = (last: string | null) => {
    onClose();
    if (last) api.open(last);
  };
  const run = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files];
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy({ file: 1, files: list.length, done: 0, total: 0 });
    let total = 0;
    let last: string | null = null;
    const rows: SkippedEntry[] = [];
    let more = 0;
    for (const [i, f] of list.entries()) {
      setBusy({ file: i + 1, files: list.length, done: 0, total: 0 });
      try {
        const r = await importFile(f, store, api.upload, null, (done, all) => setBusy({ file: i + 1, files: list.length, done, total: all }), ctl.signal);
        total += r.pages;
        if (r.root) last = r.root.id;
        for (const x of r.skipped ?? []) rows.push({ ...x, name: !x.name ? f.name : list.length > 1 ? `${f.name}/${x.name}` : x.name });
        more += r.skippedMore ?? 0;
      } catch (e) {
        if (ctl.signal.aborted) break;
        toast(`${t(e instanceof ZipError ? "import.badZip" : "import.failed")} (${f.name})`);
      }
    }
    abort.current = null;
    setBusy(null);
    if (ctl.signal.aborted) toast(t("import.cancelled"));
    else if (total) toast(t("import.done", { n: total }));
    if (rows.length && !ctl.signal.aborted) {
      setReport({ pages: total, rows, more, last });
      return;
    }
    finish(last);
  };
  const pick = (acc: string) => {
    setAccept(acc);
    setTimeout(() => input.current?.click(), 0);
  };
  // Notion's order of sources.
  const tiles: { key: string; icon: React.ReactNode; title: NotesKey; hint: NotesKey; accept: string }[] = [
    { key: "enex", icon: <NotebookPen />, title: "import.evernote", hint: "import.evernoteHint", accept: ".enex" },
    { key: "trello", icon: <SquareKanban />, title: "import.trello", hint: "import.trelloHint", accept: ".json" },
    { key: "asana", icon: <ListChecks />, title: "import.asana", hint: "import.asanaHint", accept: ".csv" },
    { key: "confluence", icon: <BookOpen />, title: "import.confluence", hint: "import.confluenceHint", accept: ".zip" },
    { key: "md", icon: <FileText />, title: "import.markdown", hint: "import.markdownHint", accept: ".md,.markdown,.txt,.zip" },
    { key: "csv", icon: <FileSpreadsheet />, title: "import.csv", hint: "import.csvHint", accept: ".csv" },
    { key: "html", icon: <FileCode2 />, title: "import.html", hint: "import.htmlHint", accept: ".html,.htm,.zip" },
    { key: "word", icon: <FileType />, title: "import.word", hint: "import.wordHint", accept: ".docx" },
    { key: "gdocs", icon: <FileType />, title: "import.gdocs", hint: "import.gdocsHint", accept: ".docx,.html,.htm,.zip" },
    { key: "dropbox", icon: <Box />, title: "import.dropbox", hint: "import.dropboxHint", accept: ".md,.docx,.zip" },
    { key: "jira", icon: <Bug />, title: "import.jira", hint: "import.jiraHint", accept: ".csv" },
    { key: "notion", icon: <FileArchive />, title: "import.notion", hint: "import.notionHint", accept: ".zip" },
  ];
  return (
    <Modal onClose={busy ? () => {} : report ? () => finish(report.last) : onClose} label={t("import.title")} className="nt-import">
      <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{t("import.title")}</div>
          <div style={{ fontSize: 13, color: "var(--nt-text-2)", marginTop: 4 }}>{t("import.hint")}</div>
        </div>
        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} disabled={Boolean(busy)} onClick={report ? () => finish(report.last) : onClose}>
          <X />
        </button>
      </div>
      <input ref={input} type="file" multiple hidden accept={accept} onChange={(e) => void run(e.target.files)} />
      {busy ? (
        <div className="nt-panel-empty nt-import-progress" role="status">
          <div>{busy.files > 1 ? t("import.runningFile", { n: busy.file, total: busy.files }) : t("import.running", { n: busy.files })}</div>
          {busy.total > 0 && (
            <>
              <div className="nt-import-bar">
                <span style={{ width: `${Math.round((busy.done / busy.total) * 100)}%` }} />
              </div>
              <small>{t("import.progress", { done: busy.done, total: busy.total })}</small>
            </>
          )}
          <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={() => abort.current?.abort()}>
            {t("import.cancel")}
          </button>
        </div>
      ) : report ? (
        <div className="nt-import-report" role="status">
          <b>{t("import.skippedTitle")}</b>
          <p>{t("import.skippedHint", { n: report.pages })}</p>
          <ul>
            {report.rows.slice(0, REPORT_ROWS).map((x, i) => (
              <li key={i}>
                <span className="nt-import-report-name">{x.name}</span>
                <small>{t(SKIP_KEY[x.reason], { n: x.count ?? 0 })}</small>
              </li>
            ))}
          </ul>
          {report.rows.length + report.more > REPORT_ROWS && <small>{t("import.skippedMore", { n: report.rows.length + report.more - REPORT_ROWS })}</small>}
          <div className="nt-import-report-actions">
            <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" onClick={() => finish(report.last)}>
              {t("import.ok")}
            </button>
          </div>
        </div>
      ) : (
        <div className="nt-import-grid">
          {tiles.map((x) => (
            <button type="button" key={x.key} className="nt-import-tile nt-btn-reset" onClick={() => pick(x.accept)}>
              {x.icon}
              <span>
                <b>{t(x.title)}</b>
                <small>{t(x.hint)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
