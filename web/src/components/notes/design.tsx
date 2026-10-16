"use client";

// zvena: a live frame from Design inside a document page.
//
// The block keeps only ids (file, frame) and the frame's name. Members of the
// workspace see the frame's current picture: the block asks for the design's
// revision every 20 s while the page is visible, and a new revision reloads
// the picture (Design renders frame thumbnails as people edit). A click opens
// the design at that frame. On a public page (no workspace) only a caption
// shows: designs are never published through a document.

import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { ArrowUpRight, ChevronLeft, PenTool, RefreshCw } from "lucide-react";
import { currentWorkspace } from "@/lib/notes/workspace";
import { notesT, type NotesKey } from "@/lib/notes/i18n";
import { ReadOnlyContext, useNotesMaybe } from "./context";
import { Modal } from "./ui";

interface DesignFile {
  id: string;
  name: string;
  project: string;
  modifiedAt: string;
}

interface DesignFrame {
  id: string;
  name: string;
  pageName: string;
  width: number;
  height: number;
}

const POLL_MS = 20_000;

/** The page's language (blocks also render on public pages, outside the app's providers). */
function pageLang(): string {
  return (typeof document !== "undefined" && document.documentElement.lang) || "en";
}

function DesignPicker({ onPick, onClose }: { onPick: (f: { fileId: string; frameId: string; name: string; width: number; height: number }) => void; onClose: () => void }) {
  const t = (key: NotesKey, vars?: Record<string, string>) => notesT(pageLang(), key, vars);
  const ws = currentWorkspace();
  const [files, setFiles] = useState<DesignFile[] | null>(null);
  const [file, setFile] = useState<DesignFile | null>(null);
  const [frames, setFrames] = useState<DesignFrame[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch(`/api/design/files?ws=${encodeURIComponent(ws)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { files: DesignFile[] }).files : Promise.reject(new Error(String(r.status)))))
      .then(setFiles)
      .catch(() => setError(notesT(pageLang(), "dsgn.unavailable")));
  }, [ws]);
  useEffect(() => {
    if (!file) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrames(null);
    void fetch(`/api/design/frames?ws=${encodeURIComponent(ws)}&file=${encodeURIComponent(file.id)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { frames: DesignFrame[] }).frames : Promise.reject(new Error(String(r.status)))))
      .then(setFrames)
      .catch(() => setError(notesT(pageLang(), "dsgn.openFailed")));
  }, [file, ws]);
  return (
    <Modal onClose={onClose} label={t("dsgn.insert")} className="nt-design-picker">
      <div className="nt-design-picker-head">
        {file && (
          <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("dsgn.back")} onClick={() => (setFile(null), setFrames(null))}>
            <ChevronLeft />
          </button>
        )}
        <h2>{file ? file.name : t("dsgn.insert")}</h2>
      </div>
      {error && <p className="nt-design-picker-empty">{error}</p>}
      {!file && !error && (
        <div className="nt-design-picker-list">
          {files === null && <p className="nt-design-picker-empty">{t("app.loading")}</p>}
          {files?.length === 0 && <p className="nt-design-picker-empty">{t("dsgn.noFiles")}</p>}
          {files?.map((f) => (
            <button type="button" key={f.id} className="nt-design-picker-row nt-btn-reset" onClick={() => setFile(f)}>
              <PenTool size={16} />
              <span className="nt-design-picker-name">{f.name}</span>
              <span className="nt-design-picker-sub">{f.project}</span>
            </button>
          ))}
        </div>
      )}
      {file && !error && (
        <div className="nt-design-picker-list">
          {frames === null && <p className="nt-design-picker-empty">{t("app.loading")}</p>}
          {frames?.length === 0 && <p className="nt-design-picker-empty">{t("dsgn.noFrames")}</p>}
          {frames?.map((fr) => (
            <button
              type="button"
              key={fr.id}
              className="nt-design-picker-row nt-btn-reset"
              onClick={() => onPick({ fileId: file.id, frameId: fr.id, name: `${file.name} — ${fr.name}`, width: Math.round(fr.width), height: Math.round(fr.height) })}
            >
              <span className="nt-design-picker-frame" />
              <span className="nt-design-picker-name">{fr.name}</span>
              <span className="nt-design-picker-sub">
                {fr.pageName} · {Math.round(fr.width)}×{Math.round(fr.height)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function LiveFrame({ fileId, frameId, name, width, height }: { fileId: string; frameId: string; name: string; width: number; height: number }) {
  const t = (key: NotesKey, vars?: Record<string, string>) => notesT(pageLang(), key, vars);
  const ws = currentWorkspace();
  const [meta, setMeta] = useState<{ revn: number; hasImage: boolean; openUrl: string; name: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    void fetch(`/api/design/frame?ws=${encodeURIComponent(ws)}&file=${encodeURIComponent(fileId)}&frame=${encodeURIComponent(frameId)}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setMeta((await r.json()) as { revn: number; hasImage: boolean; openUrl: string; name: string });
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [fileId, frameId, ws]);
  useEffect(() => {
    load();
    const id = setInterval(() => document.visibilityState === "visible" && load(), POLL_MS);
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);
  const ratio = width > 0 && height > 0 ? `${width} / ${height}` : "16 / 10";
  const src = meta?.hasImage ? `/api/design/frame-image?ws=${encodeURIComponent(ws)}&file=${encodeURIComponent(fileId)}&frame=${encodeURIComponent(frameId)}&v=${meta.revn}` : null;
  return (
    <div className="nt-design" contentEditable={false}>
      <a className="nt-design-view" href={meta?.openUrl} target="_blank" rel="noopener" style={{ aspectRatio: ratio }} aria-label={t("dsgn.openNamed", { name })}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={name} loading="lazy" />
        ) : (
          <span className="nt-design-wait">
            {failed ? t("dsgn.gone") : t("dsgn.previewLater")}
          </span>
        )}
      </a>
      <div className="nt-design-bar">
        <PenTool size={14} />
        <span className="nt-design-name">{name}</span>
        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("dsgn.refresh")} title={t("dsgn.refresh")} onClick={load}>
          <RefreshCw size={14} />
        </button>
        {meta?.openUrl && (
          <a href={meta.openUrl} target="_blank" rel="noopener" className="nt-design-open">
            {t("dsgn.openInDesign")} <ArrowUpRight size={14} />
          </a>
        )}
      </div>
    </div>
  );
}

export const DesignBlock = createReactBlockSpec(
  {
    type: "design",
    propSchema: {
      fileId: { default: "" },
      frameId: { default: "" },
      name: { default: "" },
      width: { default: 0, type: "number" },
      height: { default: 0, type: "number" },
    },
    content: "none",
  },
  {
    render: function DesignRender(props) {
      const p = props.block.props;
      const ro = useContext(ReadOnlyContext);
      const ctx = useNotesMaybe();
      const t = (key: NotesKey, vars?: Record<string, string>) => notesT(ctx?.locale ?? pageLang(), key, vars);
      // Viewers and locked pages cannot place a design.
      const [picking, setPicking] = useState(!p.fileId && !ro.readOnly && props.editor.isEditable && Boolean(ctx));
      const inWorkspace = Boolean(ctx?.user && currentWorkspace());
      const pick = useMemo(
        () => (f: { fileId: string; frameId: string; name: string; width: number; height: number }) => {
          setPicking(false);
          props.editor.updateBlock(props.block, { props: f });
        },
        [props.editor, props.block]
      );
      if (!p.fileId) {
        return (
          <>
            <div className="nt-media-input" contentEditable={false} onClick={() => !ro.readOnly && props.editor.isEditable && inWorkspace && setPicking(true)}>
              <PenTool />
              {inWorkspace ? t("dsgn.pick") : t("dsgn.signIn")}
            </div>
            {picking && inWorkspace && <DesignPicker onPick={pick} onClose={() => setPicking(false)} />}
          </>
        );
      }
      if (!inWorkspace) {
        // A public page, or the documents of a guest: no access to designs.
        return (
          <div className="nt-design nt-design-public" contentEditable={false}>
            <PenTool size={16} />
            <span>{t("dsgn.named", { name: p.name || t("page.untitled") })}</span>
          </div>
        );
      }
      return <LiveFrame fileId={p.fileId} frameId={p.frameId} name={p.name} width={p.width} height={p.height} />;
    },
  }
);
