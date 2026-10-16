"use client";

// Form view (Notion Forms): the questions are database properties — the
// property name is the question — and "Share form" opens a public link
// whose responses become pages of this database.

import { withWs } from "@/lib/notes/workspace";
import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, GitBranch, Plus, Share2, X } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { PropIcon } from "./cells";
import { Menu, Popover, toast } from "../ui";
import { FormInput } from "../form-controls";
import { newOption } from "@/lib/notes/db";
import { displayTitle } from "@/lib/notes/model";
import { FORM_PROP_TYPES, type DbProperty, type FormCondition, type FormQuestion, type FormSpec, type PropType } from "@/lib/notes/types";
import { FORM_CONDITION_OPS } from "@/lib/notes/form-logic";
import type { NotesKey } from "@/lib/notes/i18n";

const NEW_TYPES: PropType[] = ["text", "number", "select", "multi_select", "date", "checkbox", "email", "phone", "url"];

/** Choices of a single / multiple choice question (the property's options). */
function OptionsEditor({ ctl, prop }: { ctl: DbCtl; prop: DbProperty }) {
  const { t } = ctl.api;
  const options = prop.options ?? [];
  const multi = prop.type === "multi_select";
  const setOptions = (next: typeof options) => ctl.updateProp(prop.id, { options: next });
  return (
    <div className="nt-form-opts">
      {options.map((o) => (
        <div key={o.id} className="nt-form-opt">
          <span className="nt-form-opt-mark" data-multi={multi || undefined} />
          <input className="nt-form-opt-input" value={o.name} maxLength={200} onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))} />
          {prop.type !== "status" && (
            <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("db.deleteOption")} title={t("db.deleteOption")} onClick={() => setOptions(options.filter((x) => x.id !== o.id))}>
              <X />
            </button>
          )}
        </div>
      ))}
      {prop.type !== "status" && (
        <button type="button" className="nt-form-opt-add nt-btn-reset" onClick={() => setOptions([...options, newOption(prop, t("form.option", { n: options.length + 1 }))])}>
          <Plus />
          {t("form.addOption")}
        </button>
      )}
    </div>
  );
}

/** Conditional logic (Notion Forms): "Show when <an earlier question> is / is not <value>, is filled / empty". */
function LogicRow({ ctl, q, earlier, setQ }: { ctl: DbCtl; q: FormQuestion; earlier: DbProperty[]; setQ: (q: FormQuestion) => void }) {
  const { t } = ctl.api;
  const c = q.when;
  const src = c ? earlier.find((p) => p.id === c.prop) : undefined;
  if (!c || !src) {
    const add = () => {
      const first = earlier[earlier.length - 1];
      setQ({ ...q, when: { prop: first.id, op: first.options?.length ? "is" : "filled", ...(first.options?.length ? { value: first.options[0].id } : {}) } });
    };
    return (
      <button type="button" className="nt-form-logic-add nt-btn-reset" data-test="form-logic-add" onClick={add}>
        <GitBranch size={14} />
        {t("form.logicAdd")}
      </button>
    );
  }
  const set = (patch: Partial<FormCondition>) => setQ({ ...q, when: { ...c, ...patch } });
  const needsValue = c.op === "is" || c.op === "is_not";
  const choice = src.options && (src.type === "select" || src.type === "multi_select" || src.type === "status");
  const opLabel = (op: FormCondition["op"]): NotesKey => (src.type === "checkbox" ? (op === "filled" ? "form.op.checked" : "form.op.unchecked") : (`form.op.${op}` as NotesKey));
  return (
    <div className="nt-form-logic" data-test="form-logic">
      <GitBranch size={14} aria-hidden />
      <span>{t("form.showWhen")}</span>
      <select
        className="nt-form-logic-sel"
        aria-label={t("form.logicQuestion")}
        value={c.prop}
        onChange={(e) => {
          const p = earlier.find((x) => x.id === e.target.value);
          if (p) set({ prop: p.id, op: p.options?.length ? "is" : "filled", value: p.options?.[0]?.id });
        }}
      >
        {earlier.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select className="nt-form-logic-sel" aria-label={t("form.logicOp")} value={c.op} onChange={(e) => set({ op: e.target.value as FormCondition["op"] })}>
        {FORM_CONDITION_OPS.filter((op) => src.type !== "checkbox" || op === "filled" || op === "empty").map((op) => (
          <option key={op} value={op}>
            {t(opLabel(op))}
          </option>
        ))}
      </select>
      {needsValue &&
        (choice ? (
          <select className="nt-form-logic-sel" aria-label={t("form.logicValue")} value={c.value ?? ""} onChange={(e) => set({ value: e.target.value })}>
            {(src.options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : (
          <input className="nt-form-logic-sel" aria-label={t("form.logicValue")} value={c.value ?? ""} maxLength={200} onChange={(e) => set({ value: e.target.value })} />
        ))}
      <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("form.logicRemove")} title={t("form.logicRemove")} onClick={() => setQ({ ...q, when: undefined })}>
        <X />
      </button>
    </div>
  );
}

function QuestionCard({ ctl, q, prop, index, count, earlier, setQ, move, remove }: { ctl: DbCtl; q: FormQuestion; prop: DbProperty; index: number; count: number; earlier: DbProperty[]; setQ: (q: FormQuestion) => void; move: (d: -1 | 1) => void; remove: () => void }) {
  const { t } = ctl.api;
  const choice = prop.type === "select" || prop.type === "multi_select" || prop.type === "status";
  const id = `fq-${prop.id}`;
  return (
    <div className="nt-form-card nt-form-q">
      <div className="nt-form-q-head">
        <input
          className="nt-form-q-name"
          value={prop.name}
          maxLength={200}
          aria-label={t("form.addQuestion")}
          onChange={(e) => ctl.updateProp(prop.id, { name: e.target.value })}
          onBlur={(e) => !e.target.value.trim() && ctl.updateProp(prop.id, { name: t(`prop.${prop.type}` as NotesKey) })}
        />
        {q.required && <span className="nt-ff-req">*</span>}
      </div>
      <input className="nt-form-q-help" value={q.help ?? ""} maxLength={1000} placeholder={t("form.helpPlaceholder")} onChange={(e) => setQ({ ...q, help: e.target.value || undefined })} />
      {choice ? (
        <OptionsEditor ctl={ctl} prop={prop} />
      ) : (
        <FormInput q={{ prop: prop.id, type: prop.type, name: prop.name, help: "", required: false }} id={id} value={undefined} disabled labels={{ yes: t("form.yes") }} />
      )}
      {earlier.length > 0 && <LogicRow ctl={ctl} q={q} earlier={earlier} setQ={setQ} />}
      <div className="nt-form-q-foot">
        <span className="nt-form-q-type">
          <PropIcon type={prop.type} size={14} />
          {t(`prop.${prop.type}` as NotesKey)}
        </span>
        <span style={{ flex: 1 }} />
        <label className="nt-form-q-req">
          <input type="checkbox" checked={!!q.required} onChange={(e) => setQ({ ...q, required: e.target.checked || undefined })} />
          {t("form.required")}
        </label>
        <button type="button" className="nt-icon-btn nt-btn-reset" disabled={index === 0} aria-label={t("form.moveUp")} title={t("form.moveUp")} onClick={() => move(-1)}>
          <ArrowUp />
        </button>
        <button type="button" className="nt-icon-btn nt-btn-reset" disabled={index === count - 1} aria-label={t("form.moveDown")} title={t("form.moveDown")} onClick={() => move(1)}>
          <ArrowDown />
        </button>
        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("form.removeQuestion")} title={t("form.removeQuestion")} onClick={remove}>
          <X />
        </button>
      </div>
    </div>
  );
}

function SharePanel({ ctl, anchor, onClose }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void }) {
  const { t, user } = ctl.api;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const view = ctl.view;
  const db = ctl.db;
  if (!view || !db) return null;
  const shareId = view.form?.shareId;
  const url = shareId ? `${location.origin}/f/${shareId}` : "";
  // The freshest form (edits may land while a request is out).
  const current = (): FormSpec => ctl.api.store.get(ctl.host?.id ?? db.id)?.db?.views.find((v) => v.id === view.id)?.form ?? view.form ?? { questions: [] };
  const toggle = async () => {
    setBusy(true);
    try {
      if (shareId) {
        const res = await fetch(withWs("/api/notes/form"), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: shareId }) });
        if (!res.ok) throw new Error(String(res.status));
        ctl.updateView({ form: { ...current(), shareId: undefined } });
      } else {
        const res = await fetch(withWs("/api/notes/form"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dbId: ctl.host?.id ?? db.id, viewId: view.id }) });
        const data = (await res.json().catch(() => ({}))) as { id?: string };
        if (!res.ok || !data.id) throw new Error(String(res.status));
        ctl.updateView({ form: { ...current(), shareId: data.id } });
      }
    } catch {
      toast(t("form.shareError"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end">
      <div className="nt-form-share">
        {!user ? (
          <>
            <p>{t("form.signIn")}</p>
            <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" onClick={() => ctl.api.signIn()}>
              {t("form.signInBtn")}
            </button>
          </>
        ) : (
          <>
            <label className="nt-form-share-toggle">
              <span>
                <b>{t("form.accepting")}</b>
                <small>{t("form.acceptingHint", { db: displayTitle(db, t("db.untitled")) })}</small>
              </span>
              <button type="button" role="switch" aria-checked={!!shareId} className="nt-switch nt-btn-reset" disabled={busy} onClick={() => void toggle()}>
                <span />
              </button>
            </label>
            {/* Who may answer, and whether members' names go with their responses (Notion Forms). */}
            <label className="nt-form-share-row">
              <span>{t("form.who")}</span>
              <select
                className="nt-form-logic-sel"
                data-test="form-who"
                value={current().access ?? "anyone"}
                onChange={(e) => {
                  const { access: _a, ...rest } = current();
                  void _a;
                  ctl.updateView({ form: e.target.value === "workspace" ? { ...rest, access: "workspace" } : rest });
                }}
              >
                <option value="anyone">{t("form.whoAnyone")}</option>
                <option value="workspace">{t("form.whoMembers")}</option>
              </select>
            </label>
            <label className="nt-form-share-toggle">
              <span>
                <b>{t("form.anonymous")}</b>
                <small>{t("form.anonymousHint")}</small>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={!!current().anonymous}
                className="nt-switch nt-btn-reset"
                data-test="form-anonymous"
                onClick={() => {
                  const { anonymous, ...rest } = current();
                  ctl.updateView({ form: anonymous ? rest : { ...rest, anonymous: true } });
                }}
              >
                <span />
              </button>
            </label>
            {shareId && (
              <div className="nt-form-share-link">
                <input className="nt-input" readOnly value={url} onFocus={(e) => e.target.select()} />
                <button
                  type="button"
                  className="nt-btn nt-btn-reset"
                  onClick={() => {
                    void navigator.clipboard?.writeText(url).catch(() => undefined);
                    setCopied(true);
                    toast(t("form.copied"));
                  }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {t("form.copyLink")}
                </button>
                <a className="nt-btn nt-btn-reset" href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} />
                  {t("form.open")}
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </Popover>
  );
}

export function FormView({ ctl }: { ctl: DbCtl }) {
  const { t } = ctl.api;
  const [share, setShare] = useState<HTMLElement | null>(null);
  const [add, setAdd] = useState<HTMLElement | null>(null);
  const view = ctl.view;
  const db = ctl.db;
  const schema = ctl.schema;
  if (!view || !db || !schema) return null;
  const form: FormSpec = view.form ?? { questions: [] };
  const set = (patch: Partial<FormSpec>) => ctl.updateView({ form: { ...form, ...patch } });
  const items = form.questions
    .map((q) => ({ q, prop: schema.properties.find((p) => p.id === q.prop) }))
    .filter((x): x is { q: FormQuestion; prop: DbProperty } => !!x.prop && FORM_PROP_TYPES.includes(x.prop.type));
  const asked = new Set(items.map((x) => x.prop.id));
  const unused = schema.properties.filter((p) => FORM_PROP_TYPES.includes(p.type) && !asked.has(p.id));
  const setQuestions = (questions: FormQuestion[]) => set({ questions });
  const list = items.map((x) => x.q);
  return (
    <div className="nt-form-builder">
      <div className="nt-form-bar">
        <span className="nt-form-bar-note">{t("form.responsesNote")}</span>
        {form.shareId && <span className="nt-form-live">{t("form.live")}</span>}
        {!ctl.readOnly && (
          <button type="button" className="nt-btn nt-btn-reset" onClick={(e) => setShare(e.currentTarget)}>
            <Share2 size={14} />
            {t("form.share")}
          </button>
        )}
      </div>
      {/* Read-only members see the questions; the builder does not take input. */}
      <div className="nt-form-col" inert={ctl.readOnly || undefined}>
        <div className="nt-form-card nt-form-head">
          <input className="nt-form-title" value={form.title ?? ""} maxLength={200} placeholder={displayTitle(db, t("form.untitled"))} onChange={(e) => set({ title: e.target.value || undefined })} />
          <textarea className="nt-form-desc" rows={1} value={form.description ?? ""} maxLength={2000} placeholder={t("form.descPlaceholder")} onChange={(e) => set({ description: e.target.value || undefined })} />
        </div>
        {items.length === 0 && <div className="nt-form-card nt-form-empty">{t("form.empty")}</div>}
        {items.map(({ q, prop }, i) => (
          <QuestionCard
            key={prop.id}
            ctl={ctl}
            q={q}
            prop={prop}
            index={i}
            count={items.length}
            earlier={items.slice(0, i).map((x) => x.prop)}
            setQ={(next) => setQuestions(list.map((x) => (x.prop === q.prop ? next : x)))}
            move={(d) => {
              const next = [...list];
              const [x] = next.splice(i, 1);
              next.splice(i + d, 0, x);
              setQuestions(next);
            }}
            remove={() => setQuestions(list.filter((x) => x.prop !== q.prop))}
          />
        ))}
        <button type="button" className="nt-form-add nt-btn-reset" onClick={(e) => setAdd(e.currentTarget)}>
          <Plus />
          {t("form.addQuestion")}
        </button>
        <div className="nt-form-card nt-form-thanks">
          <div className="nt-form-thanks-label">{t("form.thanks")}</div>
          <input className="nt-form-q-help" value={form.thanks ?? ""} maxLength={1000} placeholder={t("form.thanksDefault")} onChange={(e) => set({ thanks: e.target.value || undefined })} />
        </div>
      </div>
      {share && <SharePanel ctl={ctl} anchor={share} onClose={() => setShare(null)} />}
      {add && (
        <Popover anchor={add} onClose={() => setAdd(null)}>
          <Menu
            width={260}
            groups={[
              ...(unused.length
                ? [
                    {
                      key: "existing",
                      label: t("form.existing"),
                      items: unused.map((p) => ({
                        key: p.id,
                        label: p.name,
                        icon: <PropIcon type={p.type} />,
                        onSelect: () => {
                          setQuestions([...list, { prop: p.id }]);
                          setAdd(null);
                        },
                      })),
                    },
                  ]
                : []),
              {
                key: "new",
                label: t("form.newType"),
                items: NEW_TYPES.map((type) => ({
                  key: type,
                  label: t(`prop.${type}` as NotesKey),
                  icon: <PropIcon type={type} />,
                  onSelect: () => {
                    const p = ctl.addProp(type);
                    if (type === "select" || type === "multi_select") {
                      const first = newOption(p, t("form.option", { n: 1 }));
                      ctl.updateProp(p.id, { options: [first, newOption({ ...p, options: [first] }, t("form.option", { n: 2 }))] });
                    }
                    // The view may have been re-read: append to its current questions.
                    const cur = ctl.api.store.get(ctl.host?.id ?? db.id)?.db?.views.find((v) => v.id === view.id)?.form ?? form;
                    ctl.updateView({ form: { ...cur, questions: [...cur.questions, { prop: p.id }] } });
                    setAdd(null);
                  },
                })),
              },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}
