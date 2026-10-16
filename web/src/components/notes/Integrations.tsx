"use client";

// zvena Documents: Notion's integrations — "Connections" in Settings (create
// an internal integration, its capabilities, secret and webhook) and the
// page menu's "Connections" (which integrations may see this page).

import { useEffect, useState } from "react";
import { Check, Copy, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useNotes } from "./context";
import { Menu, Popover, toast } from "./ui";
import type { NotesKey } from "@/lib/notes/i18n";
import type { Note } from "@/lib/notes/types";

interface Caps {
  read: boolean;
  update: boolean;
  insert: boolean;
  readComments: boolean;
  insertComments: boolean;
  users: "none" | "names" | "emails";
}

interface Integration {
  id: string;
  name: string;
  icon: string;
  caps?: Caps;
  webhook?: { url: string; events: string[] } | null;
}

const EVENTS = ["page.created", "page.content_updated", "page.properties_updated", "page.deleted", "database.created", "database.schema_updated", "database.deleted", "data_source.created", "data_source.schema_updated", "data_source.deleted", "comment.created"] as const;
const CAP_KEYS: [keyof Omit<Caps, "users" | "read">, NotesKey][] = [
  ["update", "api.capUpdate"],
  ["insert", "api.capInsert"],
  ["readComments", "api.capReadComments"],
  ["insertComments", "api.capInsertComments"],
];
const DEFAULT_CAPS: Caps = { read: true, update: true, insert: true, readComments: true, insertComments: true, users: "names" };

async function call(method: string, url: string, body?: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { method, credentials: "same-origin", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return r.ok ? j : { error: j.error ?? String(r.status), status: r.status };
  } catch {
    return null;
  }
}

/** A secret shown once, with a copy button. */
function Secret({ label, value }: { label: string; value: string }) {
  const { t } = useNotes();
  const [copied, setCopied] = useState(false);
  return (
    <div className="nt-api-secret" role="status">
      <div className="nt-api-secret-label">{label}</div>
      <div className="nt-api-secret-row">
        <code>{value}</code>
        <button
          type="button"
          className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? t("api.copied") : t("api.copy")}
        </button>
      </div>
      <div className="nt-api-hint">{t("api.secretOnce")}</div>
    </div>
  );
}

function CapsEditor({ caps, onChange, disabled }: { caps: Caps; onChange: (c: Caps) => void; disabled?: boolean }) {
  const { t } = useNotes();
  return (
    <div className="nt-api-caps">
      <label className="nt-api-check">
        <input type="checkbox" checked disabled />
        {t("api.capRead")}
      </label>
      {CAP_KEYS.map(([k, label]) => (
        <label key={k} className="nt-api-check">
          <input type="checkbox" checked={caps[k]} disabled={disabled} onChange={(e) => onChange({ ...caps, [k]: e.target.checked })} />
          {t(label)}
        </label>
      ))}
      <label className="nt-api-field">
        <span>{t("api.users")}</span>
        <select className="nt-input" value={caps.users} disabled={disabled} onChange={(e) => onChange({ ...caps, users: e.target.value as Caps["users"] })}>
          <option value="none">{t("api.usersNone")}</option>
          <option value="names">{t("api.usersNames")}</option>
          <option value="emails">{t("api.usersEmails")}</option>
        </select>
      </label>
    </div>
  );
}

function WebhookEditor({ item, ws, onSaved }: { item: Integration; ws: string; onSaved: (it: Integration, secret?: string) => void }) {
  const { t } = useNotes();
  const [url, setUrl] = useState(item.webhook?.url ?? "");
  const [events, setEvents] = useState<string[]>(item.webhook?.events ?? [...EVENTS]);
  const save = async (remove = false) => {
    if (!remove && !/^https:\/\/\S+$/i.test(url.trim())) return toast(t("api.webhookBad"));
    const r = await call("PATCH", `/api/notes/integrations?ws=${encodeURIComponent(ws)}`, { id: item.id, webhook: remove ? null : { url: url.trim(), events } });
    if (!r || r.error) return toast(t("api.failed"));
    if (remove) setUrl("");
    onSaved(r.integration as Integration, typeof r.webhookSecret === "string" ? r.webhookSecret : undefined);
  };
  return (
    <div className="nt-api-webhook">
      <div className="nt-api-sub">{t("api.webhook")}</div>
      <input className="nt-input" type="url" inputMode="url" placeholder={t("api.webhookUrl")} value={url} onChange={(e) => setUrl(e.target.value)} />
      <div className="nt-api-sub-small">{t("api.webhookEvents")}</div>
      <div className="nt-api-caps">
        {EVENTS.map((e) => (
          <label key={e} className="nt-api-check">
            <input type="checkbox" checked={events.includes(e)} onChange={(ev) => setEvents(ev.target.checked ? [...events, e] : events.filter((x) => x !== e))} />
            {t(`api.ev.${e}` as NotesKey)}
          </label>
        ))}
      </div>
      <div className="nt-api-actions">
        <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" onClick={() => void save()}>
          {t("api.webhookSave")}
        </button>
        {item.webhook && (
          <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={() => void save(true)}>
            {t("api.webhookRemove")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings → Connections: the workspace's integrations (editors manage them). */
export function IntegrationsPanel() {
  const { t, user } = useNotes();
  const ws = user?.ws.id ?? "";
  const editor = user?.ws.role === "owner" || user?.ws.role === "editor";
  const [list, setList] = useState<Integration[] | null>(null);
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Caps>(DEFAULT_CAPS);
  const [shown, setShown] = useState<{ id: string; label: string; value: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!ws) return;
    let live = true;
    void call("GET", `/api/notes/integrations?ws=${encodeURIComponent(ws)}`).then((r) => {
      if (live) setList(r && Array.isArray(r.integrations) ? (r.integrations as Integration[]) : []);
    });
    return () => {
      live = false;
    };
  }, [ws]);
  if (!user) return null;
  const replace = (it: Integration) => setList((cur) => (cur ?? []).map((x) => (x.id === it.id ? it : x)));
  const create = async () => {
    const r = await call("POST", `/api/notes/integrations?ws=${encodeURIComponent(ws)}`, { name: name.trim() || t("api.namePlaceholder"), caps });
    if (!r || r.error) return toast(r?.status === 409 ? t("api.limit") : t("api.failed"));
    const it = r.integration as Integration;
    setList((cur) => [...(cur ?? []), it]);
    setShown({ id: it.id, label: t("api.secret"), value: String(r.secret) });
    setOpen(it.id);
    setName("");
    setCaps(DEFAULT_CAPS);
  };
  return (
    <div className="nt-api">
      <p className="nt-api-hint">
        {t("api.intro")}{" "}
        <a href="/developers" target="_blank" rel="noreferrer">
          {t("api.docs")}
        </a>
      </p>
      {list?.length === 0 && <p className="nt-api-hint">{t("api.empty")}</p>}
      {(list ?? []).map((it) => (
        <div key={it.id} className="nt-api-item" data-open={open === it.id || undefined}>
          <button type="button" className="nt-api-head nt-btn-reset" aria-expanded={open === it.id} onClick={() => setOpen(open === it.id ? null : it.id)}>
            <span className="nt-api-icon">{it.icon || <Plug size={14} />}</span>
            <span className="nt-api-name">{it.name}</span>
            {it.webhook && <span className="nt-api-tag">{t("api.webhook")}</span>}
          </button>
          {shown?.id === it.id && <Secret label={shown.label} value={shown.value} />}
          {open === it.id && editor && it.caps && (
            <div className="nt-api-body">
              <div className="nt-api-sub">{t("api.caps")}</div>
              <CapsEditor
                caps={it.caps}
                onChange={async (c) => {
                  const r = await call("PATCH", `/api/notes/integrations?ws=${encodeURIComponent(ws)}`, { id: it.id, caps: c });
                  if (!r || r.error) return toast(t("api.failed"));
                  replace(r.integration as Integration);
                }}
              />
              <WebhookEditor
                item={it}
                ws={ws}
                onSaved={(next, secret) => {
                  replace(next);
                  if (secret) setShown({ id: it.id, label: t("api.webhookSecret"), value: secret });
                }}
              />
              <div className="nt-api-actions">
                <button
                  type="button"
                  className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset"
                  onClick={async () => {
                    if (!window.confirm(t("api.rotateConfirm"))) return;
                    const r = await call("PATCH", `/api/notes/integrations?ws=${encodeURIComponent(ws)}`, { id: it.id, rotate: true });
                    if (!r || r.error || typeof r.secret !== "string") return toast(t("api.failed"));
                    setShown({ id: it.id, label: t("api.secret"), value: r.secret });
                  }}
                >
                  <RefreshCw size={14} />
                  {t("api.rotate")}
                </button>
                <button
                  type="button"
                  className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset nt-api-danger"
                  onClick={async () => {
                    if (!window.confirm(t("api.revokeConfirm", { name: it.name }))) return;
                    const r = await call("DELETE", `/api/notes/integrations?ws=${encodeURIComponent(ws)}`, { id: it.id });
                    if (!r || r.error) return toast(t("api.failed"));
                    setList((cur) => (cur ?? []).filter((x) => x.id !== it.id));
                  }}
                >
                  <Trash2 size={14} />
                  {t("api.revoke")}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      {editor ? (
        <div className="nt-api-new">
          <div className="nt-api-sub">{t("api.new")}</div>
          <input className="nt-input" placeholder={t("api.namePlaceholder")} aria-label={t("api.name")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <CapsEditor caps={caps} onChange={setCaps} />
          <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" onClick={() => void create()}>
            <Plus size={14} />
            {t("api.create")}
          </button>
        </div>
      ) : (
        <p className="nt-api-hint">{t("api.editorsOnly")}</p>
      )}
    </div>
  );
}

/** Page menu → Connections: integrations that may see this page (connected here or above). */
export function ConnectionsMenu({ note, anchor, onClose, onManage }: { note: Note; anchor: HTMLElement; onClose: () => void; onManage: () => void }) {
  const { t, user, snap } = useNotes();
  const ws = user?.ws.id ?? "";
  const [data, setData] = useState<{ integrations: Integration[]; direct: string[]; inherited: { id: string; from: string }[] } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!ws) return;
    let live = true;
    void call("GET", `/api/notes/connections?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(note.id)}`).then((r) => {
      if (live && r && !r.error) setData(r as unknown as NonNullable<typeof data>);
    });
    return () => {
      live = false;
    };
  }, [note.id, ws, version]);
  const toggle = async (id: string, on: boolean) => {
    const r = await call(on ? "POST" : "DELETE", `/api/notes/connections?ws=${encodeURIComponent(ws)}`, { integration: id, noteId: note.id });
    if (!r || r.error) return toast(t("api.failed"));
    setVersion((v) => v + 1);
  };
  const items = (data?.integrations ?? []).map((it) => {
    const direct = data?.direct.includes(it.id) ?? false;
    const inherited = data?.inherited.find((x) => x.id === it.id);
    const from = inherited ? snap.byId.get(inherited.from)?.title || t("page.untitled") : "";
    return {
      key: it.id,
      label: it.name,
      icon: <span className="nt-api-icon">{it.icon || <Plug size={14} />}</span>,
      hint: inherited && !direct ? t("conn.inherited", { page: from }) : direct ? t("conn.disconnect") : t("conn.connect"),
      toggle: true,
      checked: direct || Boolean(inherited),
      onSelect: () => {
        if (!inherited || direct) void toggle(it.id, !direct);
      },
    };
  });
  return (
    <Popover anchor={anchor} onClose={onClose} placement="left-start">
      <Menu
        width={300}
        header={<div className="nt-api-hint" style={{ padding: "8px 12px 4px" }}>{t("conn.hint")}</div>}
        groups={[
          { key: "list", items: items.length ? items : [{ key: "none", label: t("conn.none"), disabled: true, onSelect: () => undefined }] },
          { key: "manage", items: [{ key: "manage", label: t("conn.manage"), icon: <Plug />, onSelect: () => (onClose(), onManage()) }] },
        ]}
      />
    </Popover>
  );
}
