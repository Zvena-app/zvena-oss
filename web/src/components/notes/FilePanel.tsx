"use client";

// Notion's media popover for image / video / audio / file blocks: "Upload"
// (a file from the device) or "Embed link" (a URL; YouTube, Vimeo and Loom
// links in a video block become an embed).

import { useRef, useState } from "react";
import { useBlockNoteEditor, useExtension } from "@blocknote/react";
import { FilePanelExtension } from "@blocknote/core/extensions";
import { useNotes } from "./context";
import { NOTE_LIMITS } from "@/lib/notes/types";
import type { NotesEditor } from "./blocks";
import type { NotesKey } from "@/lib/notes/i18n";

const ACCEPT: Record<string, string> = { image: "image/*", video: "video/*", audio: "audio/*", file: "*/*" };
const CHOOSE: Record<string, NotesKey> = { image: "file.chooseImage", video: "file.chooseVideo", audio: "file.chooseAudio", file: "file.chooseFile" };
const EMBED: Record<string, NotesKey> = { image: "file.embedImage", video: "file.embedVideo", audio: "file.embedAudio", file: "file.embedFile" };

function isVideoHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return /^(youtube\.com|m\.youtube\.com|youtu\.be|vimeo\.com|loom\.com)$/.test(h);
  } catch {
    return false;
  }
}

export function NotionFilePanel({ blockId }: { blockId: string }) {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const panel = useExtension(FilePanelExtension);
  const { t, upload } = useNotes();
  const [tab, setTab] = useState<"upload" | "embed">("upload");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const block = editor.getBlock(blockId);
  if (!block) return null;
  const type = block.type in ACCEPT ? block.type : "file";
  const done = () => panel.closeMenu();
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const u = await upload(f);
      editor.updateBlock(block, { props: { name: f.name, url: u } } as never);
      done();
    } catch {
      // upload() reported the problem
    } finally {
      setBusy(false);
    }
  };
  const embed = () => {
    const v = url.trim();
    if (!v) return;
    const full = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    if (type === "video" && isVideoHost(full)) editor.replaceBlocks([block], [{ type: "embed", props: { url: full } }] as never);
    else editor.updateBlock(block, { props: { name: full.split("/").pop()?.split("?")[0] || full, url: full } } as never);
    done();
  };
  return (
    <div className="nt-popover nt-filepanel" style={{ position: "static" }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="nt-emoji-tabs">
        <button type="button" className="nt-emoji-tab nt-btn-reset" data-active={tab === "upload" || undefined} onClick={() => setTab("upload")}>
          {t("file.upload")}
        </button>
        <button type="button" className="nt-emoji-tab nt-btn-reset" data-active={tab === "embed" || undefined} onClick={() => setTab("embed")}>
          {t("file.embed")}
        </button>
      </div>
      <div className="nt-filepanel-body">
        {tab === "upload" ? (
          <>
            <input ref={input} type="file" hidden accept={ACCEPT[type]} onChange={(e) => void onFile(e.target.files?.[0])} />
            <button type="button" className="nt-btn nt-btn-plain nt-btn-reset" style={{ width: "100%" }} disabled={busy} onClick={() => input.current?.click()}>
              {busy ? t("file.uploading") : t(CHOOSE[type])}
            </button>
            <div className="nt-filepanel-hint">{t("file.hint", { mb: Math.round(NOTE_LIMITS.uploadBytes / 1024 / 1024) })}</div>
          </>
        ) : (
          <>
            <input className="nt-input" autoFocus value={url} placeholder={t("file.linkPlaceholder")} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && embed()} />
            <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" style={{ width: "100%", marginTop: 8 }} disabled={!url.trim()} onClick={embed}>
              {t(EMBED[type])}
            </button>
            <div className="nt-filepanel-hint">{t("file.linkHint")}</div>
          </>
        )}
      </div>
    </div>
  );
}
