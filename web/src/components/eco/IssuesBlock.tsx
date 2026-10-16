"use client";

// A live list of issues inside a document: a project's issues (its page in
// Documents shows its work as it moves) or the reader's own. Each issue's
// status icon opens its team's workflow; "Add issue" creates one in the
// project, linked to this page.

import { useContext, useEffect, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { CircleDot, FolderKanban, ListChecks, Plus } from "lucide-react";
import { currentWorkspace } from "@/lib/notes/workspace";
import { PageIdContext, ReadOnlyContext, useNotesMaybe } from "@/components/notes/context";
import type { Card } from "@/lib/eco/types";
import { cardStore, eco, EcoHttpError, keepTextSelection, useCard, useIssueList } from "./client";
import { CardView } from "./CardView";
import { useEt } from "./i18n";
import "./eco.css";

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function Row({ ws, card, editable }: { ws: string; card: Card; editable: boolean }) {
  const live = useCard(ws, card.key);
  const c = live === undefined ? card : live;
  if (!c) return null;
  return <CardView card={c} variant="block" statusWs={editable ? ws : undefined} />;
}

function Picker({ ws, onPick }: { ws: string; onPick: (p: { projectId: string; scope: "project" | "mine" }) => void }) {
  const et = useEt();
  const [projects, setProjects] = useState<{ id: string; name: string; icon: string | null; color: string }[] | null>(null);
  useEffect(() => {
    eco
      .projects(ws)
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]));
  }, [ws]);
  return (
    <div className="eco-root eco-issues-pick" contentEditable={false} onMouseDownCapture={keepTextSelection}>
      <div className="eco-related-head">
        <ListChecks size={14} />
        <span>{et("issuesOf")}</span>
      </div>
      <div className="eco-issues-options">
        <button type="button" className="eco-btn" onClick={() => onPick({ projectId: "", scope: "mine" })}>
          <CircleDot size={14} />
          {et("myIssues")}
        </button>
        {(projects ?? []).map((p) => (
          <button key={p.id} type="button" className="eco-btn" onClick={() => onPick({ projectId: p.id, scope: "project" })}>
            {p.icon ? <span>{p.icon}</span> : <FolderKanban size={14} style={{ color: p.color }} />}
            {p.name}
          </button>
        ))}
        {projects === null && <span className="eco-related-note">{et("loading")}</span>}
      </div>
    </div>
  );
}

function AddIssue({ ws, pageId, projectId }: { ws: string; pageId: string | null; projectId?: string }) {
  const et = useEt();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const t = title.trim();
    if (!t || !pageId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { card } = await eco.issueFromDoc(ws, { note: pageId, title: t, projectId, assigneeId: projectId ? undefined : "me" });
      cardStore(ws).seed([card]);
      setTitle("");
    } catch (e) {
      setError(e instanceof EcoHttpError && e.status === 403 ? et("noAccess") : et("failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="eco-new-issue">
        <Plus size={16} />
        <input
          value={title}
          placeholder={et("addIssue")}
          aria-label={et("addIssue")}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
      </div>
      {error && <div className="eco-related-note">{error}</div>}
    </>
  );
}

function List({ ws, projectId, mine, editable, pageId }: { ws: string; projectId?: string; mine: boolean; editable: boolean; pageId: string | null }) {
  const et = useEt();
  const [done, setDone] = useState(false);
  const { cards } = useIssueList(ws, { project: projectId, mine, done });
  const project = useCard(ws, projectId ? `project:${projectId}` : "");
  return (
    <div className="eco-root eco-issues" contentEditable={false} onMouseDownCapture={keepTextSelection}>
      <div className="eco-related-head">
        {mine ? (
          <>
            <CircleDot size={14} />
            <span>{et("myIssues")}</span>
          </>
        ) : project ? (
          <a className="eco-issues-title" href={project.url}>
            {project.icon ? <span>{project.icon}</span> : <FolderKanban size={14} style={{ color: project.color }} />}
            <span>{project.title}</span>
          </a>
        ) : (
          <span>{project === null ? et("unavailable") : et("loading")}</span>
        )}
        {cards && <span className="eco-count">{cards.length}</span>}
        <span className="eco-spacer" />
        <button type="button" className="eco-btn eco-btn-ghost" onClick={() => setDone((v) => !v)}>
          {done ? et("hideDone") : et("showDone")}
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {cards?.map((c) => (
          <Row key={c.key} ws={ws} card={c} editable={editable} />
        ))}
        {cards && cards.length === 0 && <div className="eco-related-empty">{et("noIssues")}</div>}
        {editable && (project || mine) && <AddIssue ws={ws} pageId={pageId} projectId={projectId} />}
      </div>
    </div>
  );
}

export const IssuesBlock = createReactBlockSpec(
  {
    type: "issues",
    propSchema: {
      projectId: { default: "" },
      // "project": the project's issues; "mine": the reader's own.
      scope: { default: "project" },
    },
    content: "none",
  },
  {
    render: function IssuesRender(props) {
      const et = useEt();
      const { projectId, scope } = props.block.props;
      const ro = useContext(ReadOnlyContext);
      const pageId = useContext(PageIdContext);
      const ctx = useNotesMaybe();
      const ws = ctx?.user ? currentWorkspace() : "";
      const editable = props.editor.isEditable && !ro.readOnly;
      if (!ws) {
        return (
          <div className="eco-card eco-block eco-missing" contentEditable={false}>
            <ListChecks size={14} />
            <span>{et("issues")}</span>
          </div>
        );
      }
      const mine = scope === "mine";
      if (!mine && !(projectId && ID_RE.test(projectId))) {
        if (!editable) return null;
        return <Picker ws={ws} onPick={(p) => props.editor.updateBlock(props.block, { props: p })} />;
      }
      return <List ws={ws} projectId={mine ? undefined : projectId} mine={mine} editable={editable} pageId={pageId} />;
    },
    toExternalHTML: function IssuesHTML() {
      const et = useEt();
      return <p>{et("issues")}</p>;
    },
  }
);
