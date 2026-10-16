"use client";

// Formula, relation, rollup and files properties: Notion's formula editor,
// "Related to" setup, rollup settings, and the relation / files cell pickers.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Database, FileText, Link2, Paperclip, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { Menu, Popover, toast } from "../ui";
import { PropIcon } from "./cells";
import type { DbCtl } from "./useDatabase";
import { previewFormula, relationIds, rollupFnsFor, fileItem, parseFileItem } from "@/lib/notes/compute";
import { FORMULA_DOCS, type FormulaFuncDoc } from "@/lib/notes/formula";
import { msg } from "@/i18n/runtime";
import { valueText } from "@/lib/notes/db";
import { displayTitle, safeUrl } from "@/lib/notes/model";
import { hasSeveralSources, hostOf, sourceName } from "@/lib/notes/sources";
import type { DbProperty, Note, RollupFn } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { NoteIcon } from "../NoteIcon";

// ---------------------------------------------------------------------------
// Formula editor

type Suggestion = { kind: "prop"; prop: DbProperty } | { kind: "fn"; doc: FormulaFuncDoc };

/** The identifier being typed just before the caret (for filtering suggestions). */
function wordBefore(text: string, caret: number): string {
  const m = /[\p{L}_$][\p{L}\p{N}_$]*$/u.exec(text.slice(0, caret));
  return m ? m[0] : "";
}

export function FormulaEditor({ ctl, prop, anchor, onClose }: { ctl: DbCtl; prop: DbProperty; anchor: HTMLElement; onClose: () => void }) {
  const { t, locale, snap } = ctl.api;
  const [expr, setExpr] = useState(prop.formula?.expr ?? "");
  const [caret, setCaret] = useState(expr.length);
  const [hover, setHover] = useState<Suggestion | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const schema = ctl.schema;
  const sample = ctl.rows[0] ?? ctl.allRows[0];
  const preview = useMemo(() => (schema ? previewFormula(expr, sample, schema, snap.byId, locale) : { value: null, error: null }), [expr, sample, schema, snap.byId, locale]);
  const word = wordBefore(expr, caret).toLowerCase();
  const props = (schema?.properties ?? []).filter((p) => p.id !== prop.id && (!word || p.name.toLowerCase().includes(word)));
  const fns = FORMULA_DOCS.filter((d) => !word || d.name.toLowerCase().startsWith(word));
  const groups = (["logic", "math", "text", "date", "list"] as const).map((g) => ({ g, items: fns.filter((d) => d.group === g) })).filter((x) => x.items.length);
  const shown = hover ?? (fns[0] && word ? { kind: "fn" as const, doc: fns[0] } : null);

  const save = () => {
    if (expr !== (prop.formula?.expr ?? "")) ctl.updateProp(prop.id, { formula: { expr } });
    onClose();
  };
  const insert = (s: Suggestion) => {
    const el = ta.current;
    const pos = el?.selectionStart ?? caret;
    const start = pos - wordBefore(expr, pos).length;
    const text = s.kind === "prop" ? `prop("${s.prop.name.replace(/"/g, '\\"')}")` : `${s.doc.name}()`;
    const next = expr.slice(0, start) + text + expr.slice(pos);
    const at = start + text.length - (s.kind === "fn" ? 1 : 0);
    setExpr(next);
    setCaret(at);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };
  const resultText = preview.value === null ? "" : typeof preview.value === "boolean" ? (preview.value ? "✓ true" : "✗ false") : valueText(prop, preview.value, locale);

  return (
    <Popover anchor={anchor} onClose={save} placement="bottom-start" className="nt-formula-pop">
      <div className="nt-formula">
        <div className="nt-formula-head">
          <PropIcon type="formula" />
          <span>{prop.name}</span>
        </div>
        <textarea
          ref={ta}
          className="nt-formula-input"
          autoFocus
          spellCheck={false}
          value={expr}
          placeholder={t("formula.placeholder")}
          onChange={(e) => {
            setExpr(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Tab" && word && (props[0] || fns[0])) {
              e.preventDefault();
              insert(props[0] ? { kind: "prop", prop: props[0] } : { kind: "fn", doc: fns[0] });
            }
          }}
          onFocus={(e) => {
            const v = e.target.value.length;
            e.target.setSelectionRange(v, v);
          }}
        />
        <div className="nt-formula-status" data-error={preview.error ? "true" : undefined}>
          {preview.error ? (
            preview.error
          ) : sample ? (
            <>
              <span className="nt-formula-status-label">{t("formula.result", { title: displayTitle(sample, t("db.untitled")) })}</span>
              <b>{resultText || "—"}</b>
            </>
          ) : (
            t("formula.noRows")
          )}
          <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" onClick={save}>
            {t("formula.done")}
          </button>
        </div>
        <div className="nt-formula-body">
          <div className="nt-formula-list" onMouseLeave={() => setHover(null)}>
            {props.length > 0 && <div className="nt-menu-label">{t("formula.props")}</div>}
            {props.map((p) => (
              <button type="button" key={p.id} className="nt-mi nt-btn-reset" onMouseEnter={() => setHover({ kind: "prop", prop: p })} onClick={() => insert({ kind: "prop", prop: p })}>
                <span className="nt-mi-icon">
                  <PropIcon type={p.type} />
                </span>
                <span className="nt-mi-label">{p.name}</span>
              </button>
            ))}
            {groups.map(({ g, items }) => (
              <div key={g}>
                <div className="nt-menu-label">{t(`formula.group.${g}` as NotesKey)}</div>
                {items.map((d) => (
                  <button type="button" key={d.name} className="nt-mi nt-btn-reset" onMouseEnter={() => setHover({ kind: "fn", doc: d })} onClick={() => insert({ kind: "fn", doc: d })}>
                    <span className="nt-mi-icon nt-formula-fn-icon">ƒ</span>
                    <span className="nt-mi-label nt-mono">{d.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="nt-formula-help">
            {shown?.kind === "prop" ? (
              <>
                <div className="nt-formula-help-title">
                  <PropIcon type={shown.prop.type} /> {shown.prop.name}
                </div>
                <p>{t(`prop.${shown.prop.type}` as NotesKey)}</p>
                <code>{`prop("${shown.prop.name}")`}</code>
              </>
            ) : shown?.kind === "fn" ? (
              <>
                <div className="nt-formula-help-title nt-mono">{shown.doc.name}</div>
                <p>{locale === "ru" ? shown.doc.ru : ((locale === "en" ? undefined : msg("docs", locale, `fn.${shown.doc.name}`)) ?? shown.doc.en)}</p>
                <code>{shown.doc.sig}</code>
              </>
            ) : (
              <p className="nt-formula-help-empty">{t("formula.help")}</p>
            )}
          </div>
        </div>
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Relation setup ("Related to")

export function RelationSetup({ ctl, prop, anchor, onClose, placement = "right-start" }: { ctl: DbCtl; prop: DbProperty; anchor: HTMLElement; onClose: () => void; placement?: "right-start" | "bottom-start" }) {
  const { t, snap } = ctl.api;
  const [q, setQ] = useState("");
  // Every data source is a target (Notion, 2025): one of a database with several says which database it is in.
  const labelOf = (n: Note) => {
    const host = hostOf(n, snap.byId);
    if (host) return t("src.ofDb", { source: sourceName(host, n, t("db.untitled")), db: displayTitle(host, t("db.untitled")) });
    return hasSeveralSources(n, snap.list) ? t("src.ofDb", { source: sourceName(n, n, t("db.untitled")), db: displayTitle(n, t("db.untitled")) }) : displayTitle(n, t("db.untitled"));
  };
  const dbs = snap.list.filter((n) => n.kind === "database" && n.trashedAt === null && n.db && !n.template && labelOf(n).toLowerCase().includes(q.trim().toLowerCase()));
  const target = prop.relation ? snap.byId.get(prop.relation.dbId) : undefined;
  const twoWay = Boolean(prop.relation?.syncedPropId);
  const self = ctl.db?.id;
  return (
    <Popover anchor={anchor} placement={placement} onClose={onClose}>
      <div className="nt-relsetup">
        <div className="nt-menu-label">{t("relation.pick")}</div>
        <div className="nt-menu-input-wrap">
          <input className="nt-input" autoFocus value={q} placeholder={t("relation.searchDb")} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="nt-relsetup-list">
          {dbs.length === 0 && <div className="nt-panel-empty">{t("relation.noDbs")}</div>}
          {dbs.map((d) => (
            <button
              type="button"
              key={d.id}
              className="nt-mi nt-btn-reset"
              onClick={() => {
                ctl.linkRelation(prop.id, d.id, twoWay && d.id === prop.relation?.dbId);
                // A relation still named "Relation" takes the database's name.
                if (prop.name === t("prop.relation") || prop.name === t("prop.text")) ctl.updateProp(prop.id, { name: (hostOf(d, snap.byId) ? sourceName(d, d, t("db.untitled")) : displayTitle(d, t("db.untitled"))).slice(0, 100) });
              }}
            >
              <span className="nt-mi-icon">{d.icon ? <span><NoteIcon icon={d.icon} /></span> : <Database />}</span>
              <span className="nt-mi-label">
                {labelOf(d)}
                {d.id === self && <small className="nt-relsetup-self"> · {t("relation.thisDb")}</small>}
              </span>
              {d.id === prop.relation?.dbId && <Check size={14} />}
            </button>
          ))}
        </div>
        {target && (
          <button type="button" className="nt-relsetup-toggle nt-btn-reset" role="switch" aria-checked={twoWay} onClick={() => ctl.linkRelation(prop.id, target.id, !twoWay)}>
            <span>
              <b>{t("relation.twoWay", { db: displayTitle(target, t("db.untitled")) })}</b>
              <small>{t("relation.twoWayHint")}</small>
            </span>
            <span className="nt-mi-toggle" data-on={twoWay ? "true" : "false"} />
          </button>
        )}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Rollup setup

function Picker({ label, value, icon, children }: { label: string; value: string; icon?: ReactNode; children: (close: () => void, el: HTMLElement) => ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div className="nt-rollup-row">
      <span className="nt-rollup-label">{label}</span>
      <button type="button" className="nt-rollup-pick nt-btn-reset" onClick={(e) => setEl(e.currentTarget)}>
        {icon}
        <span>{value}</span>
        <ChevronDown size={14} />
      </button>
      {el && children(() => setEl(null), el)}
    </div>
  );
}

export function RollupSetup({ ctl, prop, anchor, onClose, placement = "right-start" }: { ctl: DbCtl; prop: DbProperty; anchor: HTMLElement; onClose: () => void; placement?: "right-start" | "bottom-start" }) {
  const { t, snap } = ctl.api;
  const cfg = prop.rollup;
  const relations = (ctl.schema?.properties ?? []).filter((p) => p.type === "relation" && p.relation);
  const rel = relations.find((p) => p.id === cfg?.relationPropId);
  const tdb = rel?.relation ? snap.byId.get(rel.relation.dbId) : undefined;
  const tprops = tdb?.db?.properties ?? [];
  const tprop = tprops.find((p) => p.id === cfg?.targetPropId);
  const fns = rollupFnsFor(tprop);
  const set = (patch: Partial<NonNullable<DbProperty["rollup"]>>) => {
    const next = { relationPropId: cfg?.relationPropId ?? "", targetPropId: cfg?.targetPropId ?? "", fn: cfg?.fn ?? ("show_original" as RollupFn), ...patch };
    if (!rollupFnsFor(tprops.find((p) => p.id === next.targetPropId)).includes(next.fn)) next.fn = "show_original";
    ctl.updateProp(prop.id, { rollup: next });
  };
  return (
    <Popover anchor={anchor} placement={placement} onClose={onClose}>
      <div className="nt-rollup">
        {relations.length === 0 ? (
          <div className="nt-panel-empty">{t("rollup.needRelation")}</div>
        ) : (
          <>
            <Picker label={t("rollup.relation")} value={rel?.name ?? t("rollup.pick")} icon={<ArrowUpRight size={14} />}>
              {(close, el) => (
                <Popover anchor={el} onClose={close}>
                  <Menu width={220} onClose={close} groups={[{ key: "r", items: relations.map((p) => ({ key: p.id, label: p.name, icon: <PropIcon type="relation" />, checked: p.id === rel?.id, onSelect: () => (set({ relationPropId: p.id, targetPropId: "" }), close()) })) }]} />
                </Popover>
              )}
            </Picker>
            <Picker label={t("rollup.property")} value={tprop?.name ?? t("rollup.pick")} icon={tprop ? <PropIcon type={tprop.type} size={14} /> : undefined}>
              {(close, el) => (
                <Popover anchor={el} onClose={close}>
                  <Menu width={220} onClose={close} groups={[{ key: "p", items: tprops.map((p) => ({ key: p.id, label: p.name, icon: <PropIcon type={p.type} />, checked: p.id === tprop?.id, onSelect: () => (set({ targetPropId: p.id }), close()) })) }]} />
                </Popover>
              )}
            </Picker>
            <Picker label={t("rollup.calculate")} value={t(`rollup.fn.${cfg?.fn ?? "show_original"}` as NotesKey)}>
              {(close, el) => (
                <Popover anchor={el} onClose={close}>
                  <Menu width={220} onClose={close} groups={[{ key: "f", items: fns.map((f) => ({ key: f, label: t(`rollup.fn.${f}` as NotesKey), checked: f === (cfg?.fn ?? "show_original"), onSelect: () => (set({ fn: f }), close()) })) }]} />
                </Popover>
              )}
            </Picker>
          </>
        )}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Relation cell picker

export function RelationEditor({ ctl, prop, row, anchor, onClose }: { ctl: DbCtl; prop: DbProperty; row: Note; anchor: HTMLElement | null; onClose: () => void }) {
  const { t, snap, store } = ctl.api;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const target = prop.relation ? snap.byId.get(prop.relation.dbId) : undefined;
  const linked = relationIds(row, prop, snap.byId);
  if (!target || target.trashedAt !== null) {
    return (
      <Popover anchor={anchor} onClose={onClose}>
        <div className="nt-selectpop">
          <div className="nt-panel-empty">{prop.relation ? t("relation.missing") : t("relation.pick")}</div>
        </div>
      </Popover>
    );
  }
  const query = q.trim().toLowerCase();
  // Read-only members see the linked pages (and can open them), nothing to add.
  const ro = ctl.readOnly;
  const candidates = snap.list
    .filter((n) => !ro && n.parentId === target.id && n.trashedAt === null && !n.template && n.id !== row.id && !linked.includes(n.id))
    .filter((n) => !query || n.title.toLowerCase().includes(query))
    .sort((a, b) => a.order - b.order)
    .slice(0, 100);
  // "Limit to 1 page": the page picked replaces the one linked.
  const set = (ids: string[]) => ctl.setRelation(row.id, prop, prop.single ? ids.slice(-1) : ids);
  const create = () => {
    if (ro) return;
    const title = q.trim();
    const n = ctl.api.newRow(target.id, { title, stay: true });
    store.update(n.id, { title });
    set([...linked, n.id]);
    setQ("");
  };
  const rows: { kind: "add"; note: Note }[] = candidates.map((note) => ({ kind: "add", note }));
  const item = (n: Note, on: boolean, idx?: number) => (
    <div key={n.id} className="nt-opt-row nt-rel-row" data-active={idx === active || undefined} onMouseEnter={() => idx !== undefined && setActive(idx)} onClick={() => (ro ? ctl.api.open(n.id, { peek: true }) : on ? set(linked.filter((x) => x !== n.id)) : set([...linked, n.id]))}>
      <span className="nt-rel-icon"><NoteIcon icon={n.icon} fallback={<FileText size={16} />} /></span>
      <span className="nt-rel-title">{displayTitle(n, t("db.untitled"))}</span>
      <button
        type="button"
        className="nt-item-act nt-btn-reset"
        title={t("relation.open")}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
          ctl.api.open(n.id, { peek: true });
        }}
      >
        <ArrowUpRight size={14} />
      </button>
      {ro ? null : on ? <X size={14} className="nt-rel-x" aria-label={t("relation.unlink")} /> : <Plus size={14} className="nt-rel-x" />}
    </div>
  );
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="nt-selectpop nt-relpop">
        <div className="nt-selectpop-input">
          <Search size={14} style={{ color: "var(--nt-text-3)" }} />
          <input
            autoFocus
            value={q}
            placeholder={t("relation.search")}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(rows.length, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const r = rows[active];
                if (r) set([...linked, r.note.id]);
                else if (q.trim()) create();
              } else if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="nt-relpop-db">
          <ArrowUpRight size={12} />
          {target.icon && <span><NoteIcon icon={target.icon} /></span>}
          {displayTitle(target, t("db.untitled"))}
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto", padding: "2px 0 6px" }}>
          {linked.length > 0 && <div className="nt-selectpop-hint">{t("relation.linked")}</div>}
          {linked.map((id) => {
            const n = snap.byId.get(id);
            return n ? item(n, true) : null;
          })}
          {(rows.length > 0 || (q.trim() && !ro)) && <div className="nt-selectpop-hint">{t("relation.more")}</div>}
          {rows.map((r, i) => item(r.note, false, i))}
          {q.trim() && !ro && (
            <div className="nt-opt-row" data-active={active === rows.length || undefined} onMouseEnter={() => setActive(rows.length)} onClick={create}>
              <Plus size={14} style={{ color: "var(--nt-text-2)" }} />
              <span style={{ fontSize: 14 }}>{t("relation.newIn", { db: displayTitle(target, t("db.untitled")) })}</span>
              <b style={{ fontSize: 14, marginInlineStart: 4 }}>{q.trim()}</b>
            </div>
          )}
          {!linked.length && !rows.length && !q.trim() && <div className="nt-panel-empty">{t("relation.none")}</div>}
        </div>
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Files cell editor

export function FilesEditor({ ctl, prop, row, anchor, onClose }: { ctl: DbCtl; prop: DbProperty; row: Note; anchor: HTMLElement | null; onClose: () => void }) {
  const { t } = ctl.api;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [linking, setLinking] = useState(false);
  const raw = row.props?.[prop.id];
  const items = (Array.isArray(raw) ? raw : []).map((x) => ({ raw: x, ...parseFileItem(x) }));
  const set = (list: string[]) => ctl.setValue(row, prop, list);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const added: string[] = [];
    for (const f of [...files].slice(0, 20)) {
      try {
        added.push(fileItem(await ctl.api.upload(f), f.name));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(false);
    const cur = ctl.api.store.get(row.id)?.props?.[prop.id];
    set([...(Array.isArray(cur) ? cur : []), ...added]);
  };
  const addLink = () => {
    const url = link.trim();
    if (!url) return;
    const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    if (!safeUrl(full)) return;
    set([...items.map((i) => i.raw), fileItem(full, parseFileItem(full).name)]);
    setLink("");
    setLinking(false);
  };
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="nt-filespop">
        <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
        {items.length === 0 && <div className="nt-selectpop-hint">{t("files.empty")}</div>}
        {items.map((f, i) => (
          <div key={i} className="nt-opt-row nt-file-row">
            <Paperclip size={14} style={{ color: "var(--nt-text-2)", flex: "none" }} />
            {safeUrl(f.url) ? (
              <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="nt-file-row-name">
                {f.name}
              </a>
            ) : (
              <span className="nt-file-row-name">{f.name}</span>
            )}
            <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("files.remove")} title={t("files.remove")} onClick={() => set(items.filter((_, j) => j !== i).map((x) => x.raw))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {linking ? (
          <div className="nt-filespop-link">
            <input
              className="nt-input"
              autoFocus
              value={link}
              placeholder={t("files.linkPlaceholder")}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addLink();
                else if (e.key === "Escape") setLinking(false);
              }}
            />
            <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" onClick={addLink}>
              <Link2 size={14} />
            </button>
          </div>
        ) : (
          <div className="nt-filespop-actions">
            <button type="button" className="nt-mi nt-btn-reset" disabled={busy} onClick={() => input.current?.click()}>
              <span className="nt-mi-icon">
                <Upload />
              </span>
              <span className="nt-mi-label">{busy ? t("files.uploading") : t("files.upload")}</span>
            </button>
            <button type="button" className="nt-mi nt-btn-reset" onClick={() => setLinking(true)}>
              <span className="nt-mi-icon">
                <Link2 />
              </span>
              <span className="nt-mi-label">{t("files.link")}</span>
              <ChevronRight size={14} style={{ marginInlineStart: "auto", color: "var(--nt-text-3)" }} />
            </button>
          </div>
        )}
      </div>
    </Popover>
  );
}
