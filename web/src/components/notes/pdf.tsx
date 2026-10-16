"use client";

// zvena Documents: Notion's PDF block — a PDF shown in the page, with its
// own height (drag the bottom edge). Only files uploaded to zvena are shown
// in place (served sandboxed by /api/notes/file); a link to a PDF on another
// site stays a link, so opening a page never makes the browser fetch it.

import { useContext, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { ArrowUpRight, FileText } from "lucide-react";
import { ReadOnlyContext, useNotesMaybe } from "./context";
import { notesT } from "@/lib/notes/i18n";
import { NOTE_LIMITS } from "@/lib/notes/types";

const MIN_H = 240;
const MAX_H = 1600;
const DEFAULT_H = 640;

/** A PDF of ours (same-origin upload), the only kind shown in place. */
export function ownPdf(url: string): boolean {
  return /^\/api\/notes\/file\/[a-f0-9]{40}\.pdf(?:\?.*)?$/.test(url);
}

export const PdfBlock = createReactBlockSpec(
  { type: "pdf", propSchema: { url: { default: "" }, name: { default: "" }, height: { default: DEFAULT_H, type: "number" } }, content: "none" },
  {
    render: function PdfRender(props) {
      const p = props.block.props;
      const ro = useContext(ReadOnlyContext);
      const readOnly = ro.readOnly || !props.editor.isEditable;
      const ctx = useNotesMaybe();
      const t = (k: Parameters<typeof notesT>[1], vars?: Record<string, string | number>) => notesT(ctx?.locale ?? "en", k, vars);
      const input = useRef<HTMLInputElement>(null);
      const [busy, setBusy] = useState(false);
      const [link, setLink] = useState("");
      const [h, setH] = useState<number | null>(null);
      const height = Math.min(MAX_H, Math.max(MIN_H, h ?? (p.height || DEFAULT_H)));

      const onFile = async (f: File | undefined) => {
        if (!f || !ctx) return;
        setBusy(true);
        try {
          const url = await ctx.upload(f);
          props.editor.updateBlock(props.block, { props: { url, name: f.name } });
        } catch {
          // upload() reported the problem
        } finally {
          setBusy(false);
        }
      };

      if (!p.url) {
        if (readOnly) return <div className="nt-media-input" contentEditable={false}><FileText />{t("pdf.empty")}</div>;
        return (
          <div className="nt-pdf-empty" contentEditable={false}>
            <div className="nt-media-input">
              <FileText />
              {t("pdf.add")}
            </div>
            <div className="nt-pdf-actions">
              <input ref={input} type="file" hidden accept="application/pdf,.pdf" onChange={(e) => void onFile(e.target.files?.[0])} />
              <button type="button" className="nt-btn nt-btn-plain nt-btn-reset" disabled={busy || !ctx} onClick={() => input.current?.click()}>
                {busy ? t("file.uploading") : t("pdf.upload")}
              </button>
              <input
                className="nt-input"
                value={link}
                placeholder={t("pdf.link")}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !link.trim()) return;
                  const v = link.trim();
                  const url = v.startsWith("/") ? v : /^https?:\/\//i.test(v) ? v : `https://${v}`;
                  props.editor.updateBlock(props.block, { props: { url, name: url.split("/").pop()?.split("?")[0] || url } });
                }}
              />
            </div>
            <div className="nt-filepanel-hint">{t("file.hint", { mb: Math.round(NOTE_LIMITS.uploadBytes / 1024 / 1024) })}</div>
          </div>
        );
      }

      if (!ownPdf(p.url)) {
        // Another site's PDF: a link, never loaded by the page.
        const safe = /^https?:\/\//i.test(p.url);
        return (
          <div className="nt-pdf-link" contentEditable={false}>
            <FileText />
            {safe ? (
              <a href={p.url} target="_blank" rel="noopener noreferrer nofollow">
                {p.name || p.url}
              </a>
            ) : (
              <span>{p.name || p.url}</span>
            )}
            <ArrowUpRight size={14} />
          </div>
        );
      }

      const startResize = (e: React.PointerEvent) => {
        if (readOnly) return;
        e.preventDefault();
        const y0 = e.clientY;
        const h0 = height;
        const iframe = (e.currentTarget.parentElement?.querySelector("iframe") ?? null) as HTMLIFrameElement | null;
        // The iframe would swallow the pointer while dragging over it.
        if (iframe) iframe.style.pointerEvents = "none";
        let last = h0;
        const move = (ev: PointerEvent) => {
          last = Math.min(MAX_H, Math.max(MIN_H, Math.round(h0 + ev.clientY - y0)));
          setH(last);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          if (iframe) iframe.style.pointerEvents = "";
          setH(null);
          if (last !== p.height) props.editor.updateBlock(props.block, { props: { height: last } });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      };

      return (
        <div className="nt-pdf" contentEditable={false}>
          <iframe src={p.url} title={p.name || "PDF"} style={{ height }} loading="lazy" />
          <div className="nt-pdf-bar">
            <FileText size={14} />
            <a href={`${p.url}${p.url.includes("?") ? "&" : "?"}download=${encodeURIComponent(p.name || "document.pdf")}`} download={p.name || undefined}>
              {p.name || "PDF"}
            </a>
          </div>
          {!readOnly && <div className="nt-pdf-resize" role="separator" aria-orientation="horizontal" aria-label={t("pdf.resize")} onPointerDown={startResize} />}
        </div>
      );
    },
  }
);
