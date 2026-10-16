"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleCheck, Database, FileText, Lock } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import type { MessageKey } from "@/lib/i18n";

interface Ws {
  id: string;
  name: string;
  /** May start pages in their Private (an editor or the owner). */
  canCreate: boolean;
}

interface Dest {
  id: string;
  kind: "page" | "database";
  title: string;
  icon: string;
  path: string;
}

type Target = { type: "private" } | { type: "page" | "database"; id: string };

const ERRORS: Record<number, MessageKey> = { 403: "clip.error.forbidden", 404: "clip.error.notFound", 413: "clip.error.tooLarge", 429: "clip.error.rate", 507: "clip.error.quota" };

export function ClipForm({ workspaces, ws: initialWs, initial, untitled }: { workspaces: Ws[]; ws: string; initial: { url: string; title: string; text: string }; untitled: string }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initial.title);
  const [text, setText] = useState(initial.text);
  const [ws, setWs] = useState(initialWs);
  const [q, setQ] = useState("");
  const [dests, setDests] = useState<Dest[] | null>(null);
  const canCreate = workspaces.find((w) => w.id === ws)?.canCreate ?? false;
  const [target, setTarget] = useState<Target | null>(canCreate ? { type: "private" } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ path: string; title: string } | null>(null);
  const seq = useRef(0);

  // Destinations of the workspace: the recently edited ones, or what the search finds.
  useEffect(() => {
    const my = ++seq.current;
    const timer = setTimeout(
      () => {
        void fetch(`/api/clipper/destinations?ws=${encodeURIComponent(ws)}&q=${encodeURIComponent(q.trim())}`, { cache: "no-store" })
          .then((r) => (r.ok ? (r.json() as Promise<{ results: Dest[] }>) : { results: [] }))
          .then((j) => my === seq.current && setDests(j.results))
          .catch(() => my === seq.current && setDests([]));
      },
      q ? 200 : 0
    );
    return () => clearTimeout(timer);
  }, [ws, q]);

  const save = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    const mode = initial.url ? "bookmark" : "text";
    const body = { ws, target, mode, url: initial.url, title: title.trim() || untitled, text };
    const res = await fetch("/api/notes/clip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!res) return setError(t(navigator.onLine === false ? "clip.error.offline" : "common.error"));
    if (!res.ok) return setError(t(ERRORS[res.status] ?? "common.error"));
    const j = (await res.json()) as { path: string; title: string };
    setDone(j);
  };

  if (done) {
    return (
      <div className="zv-clip-done" data-test="clip-done">
        <div className="zv-panel-icon">
          <CircleCheck />
        </div>
        <h1 style={{ textAlign: "center" }}>{t("clip.saved")}</h1>
        <div className="zv-stack">
          <a className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block" href={done.path} data-test="clip-open">
            {t("clip.open")}
          </a>
        </div>
      </div>
    );
  }

  const row = (key: string, sel: boolean, icon: ReactNode, label: string, sub: string, onPick: () => void, kind?: string) => (
    <button type="button" key={key} role="option" aria-selected={sel} className="zv-clip-row" data-test="clip-dest" data-id={key} data-kind={kind} onClick={onPick}>
      {icon}
      <span className="zv-clip-row-text">
        <span className="zv-clip-row-title">{label}</span>
        {sub && <span className="zv-clip-row-path">{sub}</span>}
      </span>
    </button>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h1>{t("clip.title")}</h1>
      <label className="zv-field">
        <span className="zv-label">{t("clip.pageTitle")}</span>
        <input className="zv-input" data-test="clip-title" value={title} maxLength={300} placeholder={untitled} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {initial.url && <p className="zv-clip-link">{initial.url}</p>}
      <label className="zv-field">
        <span className="zv-label">{t("clip.note")}</span>
        <textarea className="zv-input" data-test="clip-text" value={text} maxLength={20000} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="zv-field">
        <span className="zv-label">{t("clip.addTo")}</span>
        {workspaces.length > 1 && (
          <select
            className="zv-select"
            aria-label={t("clip.workspace")}
            value={ws}
            onChange={(e) => {
              const next = e.target.value;
              setWs(next);
              setDests(null);
              setTarget(workspaces.find((w) => w.id === next)?.canCreate ? { type: "private" } : null);
            }}
            style={{ width: "100%", marginBottom: 6 }}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <input className="zv-input" type="search" data-test="clip-search" value={q} placeholder={t("clip.search")} aria-label={t("clip.search")} onChange={(e) => setQ(e.target.value)} />
        <div className="zv-clip-dest" role="listbox" aria-label={t("clip.addTo")}>
          {canCreate && !q && row("private", target?.type === "private", <Lock />, t("clip.private"), t("clip.privateHint"), () => setTarget({ type: "private" }))}
          {!q && dests && dests.length > 0 && <div className="zv-clip-label">{t("clip.recent")}</div>}
          {dests?.map((d) =>
            row(
              d.id,
              target?.type !== "private" && target?.id === d.id,
              d.icon ? <span className="zv-clip-icon">{d.icon}</span> : d.kind === "database" ? <Database /> : <FileText />,
              d.title || untitled,
              [d.path, d.kind === "database" ? t("clip.database") : ""].filter(Boolean).join(" · "),
              () => setTarget({ type: d.kind, id: d.id }),
              d.kind
            )
          )}
          {dests && dests.length === 0 && q && <div className="zv-clip-label">{t("clip.none")}</div>}
        </div>
      </div>
      {error && (
        <p className="zv-banner zv-banner-error" role="alert" data-test="clip-error" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}
      <button type="submit" className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block" data-test="clip-save" disabled={busy || !target || (!initial.url && !text.trim())}>
        {busy ? t("clip.saving") : t("clip.save")}
      </button>
      {!initial.url && !text.trim() && <p className="zv-muted zv-small">{t("clip.empty")}</p>}
    </form>
  );
}
