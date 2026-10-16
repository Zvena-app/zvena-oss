"use client";

// An issue's or a project's place in the ecosystem, shown on it: the
// documents that mention it or were written for it, its designs — live — and
// one click to start a document or a design for it.

import { useState, type ReactNode } from "react";
import { FilePlus2, PenTool } from "lucide-react";
import { eco, EcoHttpError } from "./client";
import { useEt } from "./i18n";
import { GoalCondition } from "./GoalCondition";
import { Related } from "./Related";
import "./eco.css";

import type { RefKind } from "@/lib/eco/refs";

const ISSUE_RELATED = ["note", "design", "project"] as const;
const PROJECT_RELATED = ["note", "design"] as const;

export function IssueEcosystem({ ws, issueId, canEdit }: { ws: string; issueId: string; canEdit: boolean }) {
  // A goal: the issue closes itself when a live number reaches its target.
  return <EcoPanel ws={ws} refKey={`issue:${issueId}`} kinds={ISSUE_RELATED} canEdit={canEdit} top={<GoalCondition ws={ws} issueId={issueId} canEdit={canEdit} />} />;
}

/** A project is one folder in every product: its documents and designs, here on the project. */
export function ProjectEcosystem({ ws, projectId, canEdit }: { ws: string; projectId: string; canEdit: boolean }) {
  return <EcoPanel ws={ws} refKey={`project:${projectId}`} kinds={PROJECT_RELATED} canEdit={canEdit} />;
}

function EcoPanel({ ws, refKey, kinds, canEdit, top }: { ws: string; refKey: string; kinds: readonly RefKind[]; canEdit: boolean; top?: ReactNode }) {
  const et = useEt();
  const [busy, setBusy] = useState<"doc" | "design" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (what: "doc" | "design") => {
    setBusy(what);
    setError(null);
    // Design opens in its own tab (it is its own app); the document opens here.
    const tab = what === "design" ? window.open("about:blank", "_blank") : null;
    try {
      const r = what === "doc" ? await eco.docFor(ws, refKey) : await eco.designFor(ws, refKey);
      if (tab) tab.location.href = r.url;
      else location.href = r.url;
    } catch (e) {
      tab?.close();
      setError(e instanceof EcoHttpError && e.status === 403 ? et("noAccess") : et("failed"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="pj-section eco-root eco-issue-eco">
      {top}
      <Related ws={ws} refKey={refKey} kinds={kinds} canEdit={canEdit} />
      {canEdit && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <button type="button" className="eco-btn" disabled={busy !== null} onClick={() => void start("doc")}>
            <FilePlus2 size={14} />
            {et("docForIssue")}
          </button>
          <button type="button" className="eco-btn" disabled={busy !== null} onClick={() => void start("design")}>
            <PenTool size={14} />
            {et("designForIssue")}
          </button>
        </div>
      )}
      {error && <div className="eco-related-note">{error}</div>}
    </section>
  );
}
