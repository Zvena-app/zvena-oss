"use client";

// Notion's Import dialog: a tile per source (Evernote, Trello, Asana,
// Confluence, Text & Markdown, CSV, HTML, Word, Google Docs, Dropbox Paper,
// Jira, Notion); a tile picks files of its kind. Big imports show how far
// they got.

import { useRef, useState } from "react";
import { BookOpen, Box, Bug, FileArchive, FileCode2, FileSpreadsheet, FileText, FileType, ListChecks, NotebookPen, SquareKanban, X } from "lucide-react";
import { useNotes } from "./context";
import { Modal, toast } from "./ui";
import { importFile } from "./importer";
import type { NotesKey } from "@/lib/notes/i18n";

const ALL = ".zip,.md,.markdown,.txt,.html,.htm,.csv,.enex,.docx,.json";

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const api = useNotes();
  const { t, store } = api;
  const input = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState(ALL);
  const [busy, setBusy] = useState<{ file: number; files: number; done: number; total: number } | null>(null);
  const run = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files];
    setBusy({ file: 1, files: list.length, done: 0, total: 0 });
    let total = 0;
    let last: string | null = null;
    for (const [i, f] of list.entries()) {
      setBusy({ file: i + 1, files: list.length, done: 0, total: 0 });
      try {
        const r = await importFile(f, store, api.upload, null, (done, all) => setBusy({ file: i + 1, files: list.length, done, total: all }));
        total += r.pages;
        if (r.root) last = r.root.id;
      } catch {
        toast(`${t("import.failed")} (${f.name})`);
      }
    }
    setBusy(null);
    if (total) toast(t("import.done", { n: total }));
    onClose();
    if (last) api.open(last);
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
    <Modal onClose={busy ? () => {} : onClose} label={t("import.title")} className="nt-import">
      <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{t("import.title")}</div>
          <div style={{ fontSize: 13, color: "var(--nt-text-2)", marginTop: 4 }}>{t("import.hint")}</div>
        </div>
        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} disabled={Boolean(busy)} onClick={onClose}>
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
