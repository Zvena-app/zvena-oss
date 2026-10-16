"use client";

// A design comment becomes an issue: the person checks the title (the
// comment's first line), picks the team and, if they like, a project.

import { useState } from "react";
import { ArrowLeft, CircleDot } from "lucide-react";
import type { Card } from "@/lib/eco/types";
import { EcoHttpError } from "./client";
import { CardView } from "./CardView";
import { useEt } from "./i18n";
import { pulseHeaders } from "@/lib/pulse/client";
import "./eco.css";

export interface FromDesignProps {
  ws: string;
  thread: string;
  title: string;
  quote: string;
  where: string;
  back: string;
  teams: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

export function FromDesignForm({ ws, thread, title: first, quote, where, back, teams, projects }: FromDesignProps) {
  const et = useEt();
  const [title, setTitle] = useState(first);
  const [teamId, setTeam] = useState(teams[0]?.id ?? "");
  const [projectId, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Card | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/eco/issue-from-design?ws=${encodeURIComponent(ws)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...pulseHeaders() },
        body: JSON.stringify({ thread, title, teamId: teamId || undefined, projectId: projectId || undefined }),
      });
      const j = (await res.json().catch(() => null)) as { card?: Card; error?: string } | null;
      if (!res.ok || !j?.card) throw new EcoHttpError(res.status, j?.error ?? "error");
      setMade(j.card);
    } catch (e) {
      setError(e instanceof EcoHttpError && e.status === 403 ? et("noAccess") : et("failed"));
    } finally {
      setBusy(false);
    }
  };
  if (made) {
    return (
      <div className="eco-root" style={{ display: "grid", gap: 16 }}>
        <p className="zv-banner">{et("created")}</p>
        <CardView card={made} variant="block" />
        <div className="zv-actions">
          <a className="zv-btn zv-btn-primary" href={made.url}>
            {et("issueOpen")}
          </a>
          <a className="zv-btn" href={back}>
            <ArrowLeft />
            {et("backToDesign")}
          </a>
        </div>
      </div>
    );
  }
  return (
    <form
      className="eco-root"
      style={{ display: "grid", gap: 16 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && !busy) void create();
      }}
    >
      <figure className="zv-card" style={{ margin: 0 }}>
        <figcaption className="zv-muted zv-small" style={{ marginBottom: 6 }}>
          {et("comment")} · {where}
        </figcaption>
        <blockquote style={{ margin: 0, whiteSpace: "pre-wrap" }}>{quote}</blockquote>
      </figure>
      <label className="zv-field">
        <span>{et("title")}</span>
        <input className="zv-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoFocus required />
      </label>
      {teams.length > 1 && (
        <label className="zv-field">
          <span>{et("team")}</span>
          <select className="zv-select" value={teamId} onChange={(e) => setTeam(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {projects.length > 0 && (
        <label className="zv-field">
          <span>{et("project")}</span>
          <select className="zv-select" value={projectId} onChange={(e) => setProject(e.target.value)}>
            <option value="">{et("noProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="zv-banner zv-banner-error">{error}</p>}
      <div className="zv-actions">
        <button type="submit" className="zv-btn zv-btn-primary" disabled={busy || !title.trim()}>
          <CircleDot />
          {et("issueCreate")}
        </button>
        <a className="zv-btn" href={back}>
          <ArrowLeft />
          {et("backToDesign")}
        </a>
      </div>
    </form>
  );
}
