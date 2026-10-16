"use client";

// The assistant's panels: suggestions and automatic changes on an
// issue (lib/projects/autopilot.ts), and the assistant's tools, computed on
// the server by smart suggestions (triage) or rules (lib/projects/assist.ts). Proposals
// change nothing until confirmed; several changes (sub-issues) are listed
// with checkboxes and created only on confirmation.

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, Clock, Lightbulb, ListTree, MessagesSquare, Tags, Undo2, Wand2, X } from "lucide-react";
import type { Health, IssueDetail, IssueFilter, Priority, Suggestion } from "@/lib/projects/types";
import { api, errorText, invalidateAll, localToday, saveIssue, toast, useLookups } from "./data";
import { PriorityIcon, uiColor } from "./icons";
import { useT } from "./i18n";
import { Link } from "./router";
import { Avatar, confirmDialog, Modal, Spinner } from "./ui";

function useRun<T>() {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<T | null>(null);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api<T>("assist", { method: "POST", body });
      setRes(r);
      return r;
    } catch (e) {
      toast(errorText(e, t), "error");
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, res, setRes, run };
}

function Panel({ icon, title, children, onClose }: { icon: ReactNode; title: string; children: ReactNode; onClose: () => void }) {
  const { t } = useT();
  return (
    <div className="pj-assist-panel">
      <div className="pj-assist-panel-head">
        {icon}
        <b>{title}</b>
        <button type="button" className="pj-link pj-small" onClick={onClose}>
          {t("c.close")}
        </button>
      </div>
      {children}
    </div>
  );
}

export function AssistNote() {
  const { t } = useT();
  const L = useLookups();
  return <p className="pj-small pj-muted pj-assist-note">{L.b.smart === "on" ? t("as.rulesSmart") : L.b.smart === "off" ? t("as.rulesOff") : t("as.rules")}</p>;
}

/** Who proposed a triage: smart suggestions with their confidence, or the rules. */
function SourceBadge({ source, confidence }: { source: "model" | "rules"; confidence?: number }) {
  const { t } = useT();
  return (
    <span className="pj-assist-source" data-source={source}>
      {source === "model" ? t("as.bySmart", { p: Math.round((confidence ?? 0) * 100) }) : t("as.byRules")}
    </span>
  );
}

// --- Suggestions on an issue (autopilot) -------------------------------------------

/**
 * What was done automatically or is proposed on this issue: fields filled in (Undo), and
 * suggestions a person accepts or dismisses — whom to call, a duplicate,
 * "the comment says it's done". Nothing here changes without the click.
 */
export function IssueSuggestions({ issue, canEdit }: { issue: IssueDetail; canEdit: boolean }) {
  const { t } = useT();
  const L = useLookups();
  const [busy, setBusy] = useState<string | null>(null);
  const list = issue.suggestions ?? [];
  if (!list.length) return null;
  const act = async (s: Suggestion, action: "accept" | "dismiss" | "undo") => {
    setBusy(s.id);
    try {
      await api(`suggestions/${s.id}`, { method: "POST", body: { action } });
      invalidateAll();
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(null);
    }
  };
  const describe = (s: Suggestion): ReactNode => {
    const v = s.value;
    switch (s.kind) {
      case "priority":
        return (
          <>
            <PriorityIcon priority={(v.priority ?? 0) as Priority} size={13} /> {t(s.state === "applied" ? "sg.applied.priority" : "sg.open.priority", { v: t(`prio.${(v.priority ?? 0) as 0}`) })}
          </>
        );
      case "label": {
        const l = v.labelId ? L.label.get(v.labelId) : null;
        return (
          <>
            {l && <span className="pj-dot" style={{ background: uiColor(l.color) }} />} {t(s.state === "applied" ? "sg.applied.label" : "sg.open.label", { v: l?.name ?? "—" })}
          </>
        );
      }
      case "project":
        return t(s.state === "applied" ? "sg.applied.project" : "sg.open.project", { v: (v.projectId && L.project.get(v.projectId)?.name) || "—" });
      case "assignee": {
        const p = v.userId ? L.person.get(v.userId) : null;
        return (
          <>
            {p && <Avatar name={p.name} id={p.id} size={16} src={p.avatar} />} {t("sg.open.assignee", { v: p?.name ?? "—" })}
          </>
        );
      }
      case "duplicate":
        return (
          <>
            {t("sg.open.duplicate")}{" "}
            <Link to={`/issue/${v.identifier}`}>
              {v.identifier} {v.title}
            </Link>
          </>
        );
      case "done":
        return t("sg.open.done");
    }
  };
  const acceptLabel = (s: Suggestion) => (s.kind === "duplicate" ? t("sg.markDuplicate") : s.kind === "done" ? t("sg.close") : s.kind === "assignee" ? t("sg.assign") : t("sg.accept"));
  return (
    <section className="pj-suggest" aria-label={t("sg.label")}>
      {list.map((s) => (
        <div key={s.id} className="pj-suggest-row" data-state={s.state}>
          <Lightbulb size={14} className="pj-suggest-icon" aria-hidden />
          <span className="pj-suggest-text">{describe(s)}</span>
          <span className="pj-suggest-conf">
            {Math.round(s.confidence * 100)}%
          </span>
          {canEdit && (
            <span className="pj-suggest-actions">
              {s.state === "applied" ? (
                <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" disabled={busy === s.id} onClick={() => void act(s, "undo")}>
                  <Undo2 size={13} />
                  {t("sg.undo")}
                </button>
              ) : (
                <>
                  <button type="button" className="pj-btn pj-btn-sm" disabled={busy === s.id} onClick={() => void act(s, "accept")}>
                    <Check size={13} />
                    {acceptLabel(s)}
                  </button>
                  <button type="button" className="pj-icon-btn" aria-label={t("sg.dismiss")} title={t("sg.dismiss")} disabled={busy === s.id} onClick={() => void act(s, "dismiss")}>
                    <X size={14} />
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      ))}
    </section>
  );
}

// --- On an issue ---------------------------------------------------------------

export function AssistIssue({ issue, canEdit }: { issue: IssueDetail; canEdit: boolean }) {
  const { t } = useT();
  const L = useLookups();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"breakdown" | "digest" | "triage" | null>(null);
  const bd = useRun<{ items: { title: string; done: boolean }[] }>();
  const dg = useRun<{
    comments: number;
    participants: { userId: string | null; comments: number }[];
    decisions: { commentId: string; authorId: string | null; text: string }[];
    questions: { commentId: string; authorId: string | null; text: string }[];
    actions: { commentId: string; authorId: string | null; text: string }[];
    latest: { authorId: string | null; text: string } | null;
  }>();
  const tr = useRun<{ priority: Priority | null; priorityReason: string | null; labels: { id: string; reason: string }[]; source: "model" | "rules"; confidence?: number }>();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);

  const createSubs = async () => {
    const items = (bd.res?.items ?? []).filter((_, i) => picked.has(i));
    if (!items.length) return;
    const ok = await confirmDialog({ title: t("as.confirm"), body: items.map((i) => `• ${i.title}`).join("\n"), ok: t("as.applySelected", { n: items.length }) });
    if (!ok) return;
    setCreating(true);
    try {
      for (const it of items) {
        const done = it.done ? L.statusesOf(issue.teamId).find((s) => s.category === "completed")?.id : undefined;
        await api("issues", { method: "POST", body: { teamId: issue.teamId, title: it.title, parentId: issue.id, projectId: issue.projectId ?? undefined, cycleId: issue.cycleId ?? undefined, statusId: done } });
      }
      invalidateAll();
      setPanel(null);
      bd.setRes(null);
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setCreating(false);
    }
  };

  const who = (id: string | null) => (id ? (L.person.get(id)?.name ?? t("act.former")) : t("act.someone"));

  return (
    <section className="pj-section pj-assist">
      <button type="button" className="pj-assist-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Wand2 size={14} />
        {t("as.title")}
        <ChevronDown size={14} className="pj-chev" data-collapsed={!open || undefined} />
      </button>
      {open && (
        <>
          <div className="pj-assist-actions">
            {canEdit && (
              <button
                type="button"
                className="pj-btn pj-btn-sm"
                onClick={() => {
                  setPanel("breakdown");
                  void bd.run({ action: "breakdown", issueId: issue.id }).then((r) => r && setPicked(new Set(r.items.map((_, i) => i).filter((i) => !r.items[i].done))));
                }}
              >
                <ListTree size={14} />
                {t("as.breakdown")}
              </button>
            )}
            <button
              type="button"
              className="pj-btn pj-btn-sm"
              onClick={() => {
                setPanel("digest");
                void dg.run({ action: "digest", issueId: issue.id });
              }}
            >
              <MessagesSquare size={14} />
              {t("as.digest")}
            </button>
            {canEdit && (
              <button
                type="button"
                className="pj-btn pj-btn-sm"
                onClick={() => {
                  setPanel("triage");
                  void tr.run({ action: "triage", title: issue.title, description: issue.description, teamId: issue.teamId });
                }}
              >
                <Tags size={14} />
                {t("as.triage")}
              </button>
            )}
          </div>
          <AssistNote />
          {panel === "breakdown" && (
            <Panel icon={<ListTree size={14} />} title={t("as.breakdown")} onClose={() => setPanel(null)}>
              {bd.busy ? (
                <Spinner />
              ) : !bd.res?.items.length ? (
                <p className="pj-small pj-muted">{t("as.breakdownNone")}</p>
              ) : (
                <>
                  <ul className="pj-assist-list">
                    {bd.res.items.map((it, i) => (
                      <li key={i}>
                        <label className="pj-check-row">
                          <input type="checkbox" checked={picked.has(i)} onChange={() => setPicked((s) => (s.has(i) ? (s.delete(i), new Set(s)) : new Set(s).add(i)))} />
                          <span className={it.done ? "pj-muted" : ""}>{it.title}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="pj-btn pj-btn-sm pj-btn-primary" disabled={!picked.size || creating} onClick={() => void createSubs()}>
                    {t("as.applySelected", { n: picked.size })}
                  </button>
                </>
              )}
            </Panel>
          )}
          {panel === "digest" && (
            <Panel icon={<MessagesSquare size={14} />} title={t("as.digest")} onClose={() => setPanel(null)}>
              {dg.busy || !dg.res ? (
                <Spinner />
              ) : dg.res.comments === 0 ? (
                <p className="pj-small pj-muted">{t("as.nothing")}</p>
              ) : (
                <div className="pj-digest">
                  <div className="pj-digest-people">
                    {t("as.participants")}:{" "}
                    {dg.res.participants.map((p) => (
                      <span key={p.userId ?? "x"} className="pj-tag">
                        {who(p.userId)} · {p.comments}
                      </span>
                    ))}
                  </div>
                  {(
                    [
                      ["as.decisions", dg.res.decisions],
                      ["as.actions", dg.res.actions],
                      ["as.questions", dg.res.questions],
                    ] as const
                  ).map(([k, list]) =>
                    list.length ? (
                      <div key={k}>
                        <div className="pj-digest-h">{t(k)}</div>
                        <ul>
                          {list.map((x, i) => (
                            <li key={i}>
                              <a href={`#comment-${x.commentId}`}>{who(x.authorId)}</a>: {x.text}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null
                  )}
                  {dg.res.latest && (
                    <div>
                      <div className="pj-digest-h">{t("as.latest")}</div>
                      <p>
                        {who(dg.res.latest.authorId)}: {dg.res.latest.text}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </Panel>
          )}
          {panel === "triage" && (
            <Panel icon={<Tags size={14} />} title={t("as.triage")} onClose={() => setPanel(null)}>
              {tr.busy || !tr.res ? (
                <Spinner />
              ) : tr.res.priority === null && !tr.res.labels.length ? (
                <p className="pj-small pj-muted">{t("as.triageNone")}</p>
              ) : (
                <div className="pj-triage">
                  <SourceBadge source={tr.res.source} confidence={tr.res.confidence} />
                  {tr.res.priority !== null && (
                    <div className="pj-triage-row">
                      <PriorityIcon priority={tr.res.priority} />
                      <span>
                        {t(`prio.${tr.res.priority}`)} <span className="pj-muted">— «{tr.res.priorityReason}»</span>
                      </span>
                      <button
                        type="button"
                        className="pj-btn pj-btn-sm"
                        disabled={issue.priority === tr.res.priority}
                        onClick={() => void saveIssue(issue.id, { priority: tr.res?.priority }, { priority: tr.res?.priority as Priority })}
                      >
                        {t("as.apply")}
                      </button>
                    </div>
                  )}
                  {tr.res.labels.map((l) => {
                    const label = L.label.get(l.id);
                    if (!label) return null;
                    const has = issue.labelIds.includes(l.id);
                    return (
                      <div className="pj-triage-row" key={l.id}>
                        <span className="pj-dot" style={{ background: uiColor(label.color) }} />
                        <span>
                          {label.name} <span className="pj-muted">— «{l.reason}»</span>
                        </span>
                        <button type="button" className="pj-btn pj-btn-sm" disabled={has} onClick={() => void saveIssue(issue.id, { addLabelIds: [l.id] }, { labelIds: [...issue.labelIds, l.id] })}>
                          {t("as.apply")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          )}
        </>
      )}
    </section>
  );
}

// --- Description template (create dialog) ---------------------------------------

export function DescribeButton({ onUse }: { onUse: (r: { title: string; description: string }) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const r = useRun<{ title: string; description: string }>();
  return (
    <>
      <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" onClick={() => setOpen(true)} title={t("as.describeHint")}>
        <Wand2 size={14} />
        {t("as.describe")}
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)} label={t("as.describe")} width={520}>
          <div className="pj-form">
            <h2>{t("as.describe")}</h2>
            <p className="pj-small pj-muted">{t("as.describeHint")}</p>
            <textarea className="pj-input pj-textarea" autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} aria-label={t("as.describe")} />
            {r.res && <pre className="pj-preview">{`${r.res.title}\n\n${r.res.description}`}</pre>}
            <AssistNote />
            <div className="pj-row-end">
              <button type="button" className="pj-btn" disabled={!text.trim() || r.busy} onClick={() => void r.run({ action: "describe", request: text })}>
                {t("as.describe")}
              </button>
              <button
                type="button"
                className="pj-btn pj-btn-primary"
                disabled={!r.res}
                onClick={() => {
                  if (r.res) onUse(r.res);
                  setOpen(false);
                }}
              >
                {t("as.use")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// --- On a project or cycle -------------------------------------------------------

export function BlockersPanel({ projectId, cycleId }: { projectId?: string; cycleId?: string }) {
  const { t } = useT();
  const L = useLookups();
  const r = useRun<{
    open: number;
    blocked: { issue: { id: string; identifier: string; title: string }; by: { id: string; identifier: string; title: string; status: string; assigneeId: string | null; outside: boolean }[] }[];
    roots: { id: string; identifier: string; title: string; blocks: number; assigneeId: string | null }[];
  }>();
  const [shown, setShown] = useState(false);
  return (
    <div className="pj-assist-inline">
      <button
        type="button"
        className="pj-btn pj-btn-sm"
        onClick={() => {
          setShown(true);
          void r.run({ action: "blockers", projectId, cycleId });
        }}
      >
        <AlertTriangle size={14} />
        {t("as.blockers")}
      </button>
      {shown && (
        <Panel icon={<AlertTriangle size={14} />} title={t("as.blockers")} onClose={() => setShown(false)}>
          {r.busy || !r.res ? (
            <Spinner />
          ) : !r.res.blocked.length ? (
            <p className="pj-small pj-muted">{t("as.blockersNone")}</p>
          ) : (
            <div className="pj-digest">
              <div className="pj-digest-h">{t("as.roots")}</div>
              <ul>
                {r.res.roots.map((x) => (
                  <li key={x.id}>
                    <Link to={`/issue/${x.identifier}`}>{x.identifier}</Link> {x.title} — ×{x.blocks}
                    {x.assigneeId && <span className="pj-muted"> · {L.person.get(x.assigneeId)?.name}</span>}
                  </li>
                ))}
              </ul>
              {r.res.blocked.map((b) => (
                <div key={b.issue.id} className="pj-blocker">
                  <Link to={`/issue/${b.issue.identifier}`}>{b.issue.identifier}</Link> {b.issue.title}{" "}
                  <span className="pj-muted">{t("as.blockedBy")}</span>{" "}
                  {b.by.map((x, i) => (
                    <span key={x.id}>
                      {i > 0 && ", "}
                      <Link to={`/issue/${x.identifier}`}>{x.identifier}</Link> <span className="pj-muted">({x.status}{x.outside ? `, ${t("as.outside")}` : ""})</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
          <AssistNote />
        </Panel>
      )}
    </div>
  );
}

export function DraftUpdateButton({ projectId, onDraft }: { projectId: string; onDraft: (d: { health: Health; body: string }) => void }) {
  const { t } = useT();
  const r = useRun<{ health: Health; body: string }>();
  return (
    <button type="button" className="pj-btn pj-btn-sm" disabled={r.busy} onClick={() => void r.run({ action: "projectUpdate", projectId }).then((x) => x && onDraft(x))}>
      <Wand2 size={14} />
      {t("as.projectUpdate")}
    </button>
  );
}

export function CycleReportButton({ cycleId }: { cycleId: string }) {
  const { t } = useT();
  const r = useRun<{ text: string }>();
  const [shown, setShown] = useState(false);
  return (
    <div className="pj-assist-inline">
      <button
        type="button"
        className="pj-btn pj-btn-sm"
        onClick={() => {
          setShown(true);
          void r.run({ action: "cycleReport", cycleId });
        }}
      >
        <Wand2 size={14} />
        {t("as.cycleReport")}
      </button>
      {shown && (
        <Panel icon={<Wand2 size={14} />} title={t("as.cycleReport")} onClose={() => setShown(false)}>
          {r.busy || !r.res ? <Spinner /> : <pre className="pj-preview">{r.res.text}</pre>}
          <AssistNote />
        </Panel>
      )}
    </div>
  );
}

// --- Workspace: overdue and stale ------------------------------------------------

export function StaleDialog({ onClose, onFilter }: { onClose: () => void; onFilter: (f: IssueFilter) => void }) {
  const { t } = useT();
  const L = useLookups();
  const r = useRun<{
    overdue: { id: string; identifier: string; title: string; dueDate: string; assigneeId: string | null; days: number }[];
    stuck: { id: string; identifier: string; title: string; assigneeId: string | null; days: number }[];
    unassignedUrgent: { id: string; identifier: string; title: string }[];
  }>();
  const [days, setDays] = useState(7);
  useEffect(() => {
    void r.run({ action: "stale", days: 7, today: localToday() });
    // Runs once when the dialog opens; later runs follow the days select.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const person = (id: string | null) => (id ? <Avatar name={L.person.get(id)?.name ?? "?"} id={id} size={16} /> : null);
  return (
    <Modal onClose={onClose} label={t("as.stale")} width={640}>
      <div className="pj-form">
        <h2>
          <Clock size={18} /> {t("as.stale")}
        </h2>
        <label className="pj-small">
          {t("as.stuck", { n: days })}{" "}
          <select
            className="pj-select pj-select-sm"
            value={days}
            onChange={(e) => {
              const n = Number(e.target.value);
              setDays(n);
              void r.run({ action: "stale", days: n, today: localToday() });
            }}
          >
            {[3, 7, 14, 30].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {r.busy || !r.res ? (
          <Spinner />
        ) : !r.res.overdue.length && !r.res.stuck.length && !r.res.unassignedUrgent.length ? (
          <p className="pj-muted">{t("as.nothing")}</p>
        ) : (
          <div className="pj-digest pj-stale">
            {r.res.overdue.length > 0 && (
              <>
                <div className="pj-digest-h">
                  {t("as.overdue")} ({r.res.overdue.length}){" "}
                  <button
                    type="button"
                    className="pj-link pj-small"
                    onClick={() => {
                      onFilter({ due: "overdue" });
                      onClose();
                    }}
                  >
                    {t("f.filter")}
                  </button>
                </div>
                <ul>
                  {r.res.overdue.map((x) => (
                    <li key={x.id}>
                      {person(x.assigneeId)} <Link to={`/issue/${x.identifier}`} onNavigate={onClose}>{x.identifier}</Link> {x.title} <span className="pj-overdue">— {t("as.days", { n: x.days })}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {r.res.stuck.length > 0 && (
              <>
                <div className="pj-digest-h">{t("as.stuck", { n: days })}</div>
                <ul>
                  {r.res.stuck.map((x) => (
                    <li key={x.id}>
                      {person(x.assigneeId)} <Link to={`/issue/${x.identifier}`} onNavigate={onClose}>{x.identifier}</Link> {x.title} <span className="pj-muted">— {t("as.days", { n: x.days })}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {r.res.unassignedUrgent.length > 0 && (
              <>
                <div className="pj-digest-h">{t("as.unassignedUrgent")}</div>
                <ul>
                  {r.res.unassignedUrgent.map((x) => (
                    <li key={x.id}>
                      <Link to={`/issue/${x.identifier}`} onNavigate={onClose}>{x.identifier}</Link> {x.title}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <AssistNote />
      </div>
    </Modal>
  );
}

