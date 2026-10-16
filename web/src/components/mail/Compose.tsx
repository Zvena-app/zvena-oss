"use client";

// The composer (Notion Mail's): From, To / Cc / Bcc with suggestions (people
// one wrote to, workspace members), the subject, zvena's editor, attachments,
// snippets, a link to a Docs page (with a prompt to share it with recipients
// who cannot open it), the signature, the quoted original folded below.
// Drafts save as one types (here and in the mailbox's Drafts folder). Send
// waits a few seconds for Undo; Send later picks a time.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, FileText, Maximize2, Minimize2, MoreHorizontal, Paperclip, Send, Sparkle, Trash2, X } from "lucide-react";
import { eco } from "@/components/eco/client";
import { toast } from "@/components/zvena/ds";
import type { Addr, Contact, Draft, DraftAttachment, MailMessage } from "@/lib/mail-client/types";
import { api, closeComposer, loadBoot, MailApiError, openComposer, refreshAll, setState, useMail, type ComposerState } from "./data";
import { EMAIL_RE, fullDate, parseAddrs, quoteHtml, sizeText } from "./format";
import { useMt, mt } from "./i18n";
import { SendLaterPicker } from "./Pickers";
import { Menu, Popover } from "./ui";
import type { ComposeEditorHandle } from "./ComposeEditor";

const ComposeEditor = dynamic(() => import("./ComposeEditor"), { ssr: false, loading: () => <div className="zm-editor zm-editor-loading" /> });

const SAVE_DELAY = 1500;

export function Composers() {
  const composers = useMail((s) => s.composers);
  const floating = composers.filter((c) => !c.inline);
  // A reply whose conversation is not open shows as a window too.
  const route = useMail((s) => s.route);
  const strays = composers.filter((c) => c.inline && c.draft.threadId !== route.thread);
  const list = [...floating, ...strays];
  if (!list.length) return null;
  return (
    <div className="zm-composers">
      {list.map((c) => (
        <ComposeWindow key={c.id} c={c} />
      ))}
    </div>
  );
}

function ComposeWindow({ c }: { c: ComposerState }) {
  const { t } = useMt();
  const [big, setBig] = useState(false);
  const toggle = () => setState((s) => ({ composers: s.composers.map((x) => (x.id === c.id ? { ...x, minimized: !x.minimized } : x)) }));
  return (
    <div className="zm-compose-win" data-min={c.minimized || undefined} data-big={big || undefined} role="dialog" aria-label={c.draft.subject || t("compose.new")}>
      <div className="zm-compose-title" onClick={toggle}>
        <span>{c.draft.subject || (c.draft.mode === "new" ? t("compose.new") : t(`compose.mode.${c.draft.mode}`))}</span>
        <span className="zm-compose-title-tools" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="zm-icon-btn" onClick={toggle} aria-label={c.minimized ? t("compose.restore") : t("compose.minimize")}>
            <ChevronDown size={14} style={c.minimized ? { transform: "rotate(180deg)" } : undefined} />
          </button>
          <button type="button" className="zm-icon-btn zm-compose-big" onClick={() => setBig((v) => !v)} aria-label={big ? t("compose.shrink") : t("compose.expand")}>
            {big ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" className="zm-icon-btn" onClick={() => closeComposer(c.id)} aria-label={t("compose.close")}>
            <X size={14} />
          </button>
        </span>
      </div>
      {!c.minimized && <ComposeForm c={c} />}
    </div>
  );
}

export function InlineComposer({ c }: { c: ComposerState }) {
  return (
    <div className="zm-compose-inline">
      <ComposeForm c={c} inline />
    </div>
  );
}

function ComposeForm({ c, inline }: { c: ComposerState; inline?: boolean }) {
  const { t, locale } = useMt();
  const boot = useMail((s) => s.boot);
  const ws = useMail((s) => s.ws);
  const quoted = useMail((s) => (c.quoteOf ? Object.values(s.threads).flatMap((th) => th?.messages ?? []).find((m) => m.id === c.quoteOf) : undefined));
  const [d, setD] = useState<Draft>(c.draft);
  const [showCc, setShowCc] = useState(c.draft.cc.length > 0 || c.draft.bcc.length > 0);
  const [showQuote, setShowQuote] = useState(c.draft.mode === "forward");
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState(0);
  const [pop, setPop] = useState<{ kind: "snippets" | "docs" | "later" | "more"; anchor: HTMLElement } | null>(null);
  const [share, setShare] = useState<{ note: string; title: string; missing: string[] } | null>(null);
  const editor = useRef<ComposeEditorHandle | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(d);
  useEffect(() => {
    latest.current = d;
  });
  const account = boot?.accounts.find((a) => a.id === d.accountId) ?? boot?.accounts[0];

  /** The message as it goes out: the text, the signature, the quoted original. */
  const signature = account?.signature ?? "";
  const fullHtml = useCallback(async () => {
    const body = (await editor.current?.html()) ?? "";
    const sig = signature ? `<div class="zv-signature"><br>--<br>${signature}</div>` : "";
    const q = quoted ? `<br>${quoteHtml(quoted, locale, latest.current.mode === "forward")}` : "";
    return `${body}${sig}${q}`;
  }, [signature, quoted, locale]);

  const snapshot = useCallback(async (): Promise<Draft> => ({ ...latest.current, html: await fullHtml(), blocks: editor.current?.blocks() ?? latest.current.blocks, updatedAt: Date.now() }), [fullHtml]);

  const saving = useRef<Promise<unknown> | null>(null);
  const save = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    try {
      const draft = await snapshot();
      saving.current = api(`drafts/${encodeURIComponent(draft.id)}`, { method: "PUT", json: draft });
      await saving.current;
    } catch {
      dirty.current = true;
    }
  }, [snapshot]);

  const changed = useCallback(() => {
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY);
  }, [save]);

  useEffect(() => {
    // Leaving (closing the window, another page) saves what was typed.
    return () => {
      if (timer.current) clearTimeout(timer.current);
      void save();
    };
  }, [save]);

  const set = (patch: Partial<Draft>) => {
    setD((x) => ({ ...x, ...patch }));
    changed();
  };

  const send = async (sendAt?: number) => {
    if (busy) return;
    const all = [...d.to, ...d.cc, ...d.bcc];
    if (!all.length) {
      toast(t("compose.noRecipients"), { kind: "error" });
      return;
    }
    const bad = all.find((a) => !EMAIL_RE.test(a.address));
    if (bad) {
      toast(t("compose.badAddress", { address: bad.address }), { kind: "error" });
      return;
    }
    if (uploads > 0) {
      toast(t("compose.uploading"), { kind: "error" });
      return;
    }
    setBusy(true);
    if (timer.current) clearTimeout(timer.current);
    dirty.current = false;
    // A save on its way must land before the send takes the draft (it would bring it back).
    await saving.current?.catch(() => undefined);
    try {
      const draft = await snapshot();
      const r = await api<{ outbox: { id: string; sendAt: number } }>("send", { method: "POST", json: { draft, ws, ...(sendAt ? { sendAt } : {}), ...(c.forward?.length && d.mode === "forward" ? { forwardAttachments: c.forward } : {}) } });
      closeComposer(c.id);
      const undoMs = Math.max(0, r.outbox.sendAt - Date.now());
      const undo = async () => {
        try {
          const back = await api<{ draft: Draft }>(`outbox/${r.outbox.id}`, { method: "DELETE" });
          openComposer({ ...c, draft: back.draft, minimized: false });
          toast(mt("toast.unsent"));
        } catch {
          toast(mt("err.alreadySent"), { kind: "error" });
        }
        void loadBoot();
      };
      if (sendAt) toast(t("toast.scheduled", { when: fullDate(r.outbox.sendAt, locale) }), { undo, ms: 6000 });
      else if (undoMs > 800) toast(t("toast.sending"), { undo, ms: undoMs });
      else toast(t("toast.sent"));
      setTimeout(() => refreshAll(), undoMs + 1500);
      void loadBoot();
    } catch (e) {
      dirty.current = true;
      const code = e instanceof MailApiError ? e.code : "";
      toast(code === "bad address" ? t("compose.badAddress", { address: "" }) : code === "attachments too big" ? t("compose.tooBig") : t("err.generic"), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (timer.current) clearTimeout(timer.current);
    dirty.current = false;
    closeComposer(c.id);
    await api(`drafts/${encodeURIComponent(d.id)}`, { method: "DELETE" }).catch(() => undefined);
    toast(t("toast.discarded"));
    void loadBoot();
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      if (f.size > 25 * 1024 * 1024) {
        toast(t("compose.tooBig"), { kind: "error" });
        continue;
      }
      setUploads((n) => n + 1);
      try {
        const res = await fetch(`/api/mail/upload?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f, headers: { "content-type": f.type || "application/octet-stream" } });
        if (!res.ok) throw new Error(String(res.status));
        const { attachment } = (await res.json()) as { attachment: DraftAttachment };
        setD((x) => ({ ...x, attachments: [...x.attachments, attachment] }));
        changed();
      } catch {
        toast(t("compose.uploadFailed", { name: f.name }), { kind: "error" });
      } finally {
        setUploads((n) => n - 1);
      }
    }
  };

  const linkDoc = async (card: { key: string; title: string; url: string }) => {
    const note = card.key.slice(5);
    editor.current?.insertLink(new URL(card.url, location.origin).toString(), card.title || t("untitled"));
    changed();
    const emails = [...d.to, ...d.cc, ...d.bcc].map((a) => a.address);
    if (!emails.length) return;
    try {
      const r = await api<{ canShare: boolean; missing: string[]; title: string }>(`docs-access?ws=${encodeURIComponent(ws)}&note=${encodeURIComponent(note)}&emails=${encodeURIComponent(emails.join(","))}`);
      if (r.canShare && r.missing.length) setShare({ note, title: r.title || card.title, missing: r.missing });
    } catch {
      // The prompt is a convenience.
    }
  };

  const shareDoc = async (level: "view" | "comment" | "edit") => {
    if (!share) return;
    let ok = 0;
    for (const email of share.missing) {
      const res = await fetch(`/api/notes/page-invite?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(share.note)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "email", email, level }) }).catch(() => null);
      if (res?.ok) ok++;
    }
    toast(ok ? t("share.done", { n: ok }) : t("err.generic"), { kind: ok ? "success" : "error" });
    setShare(null);
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
    // The composer's own keys never reach the list (E, #, J…).
    e.stopPropagation();
  };

  if (!boot || !account) return null;
  return (
    <form className="zm-compose" onKeyDown={onKey} onSubmit={(e) => (e.preventDefault(), void send())} data-inline={inline || undefined}>
      {boot.accounts.length > 1 && (
        <label className="zm-compose-row">
          <span className="zm-compose-label">{t("from")}</span>
          <select className="zm-select" value={account.id} onChange={(e) => set({ accountId: e.target.value })}>
            {boot.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ? `${a.name} <${a.email}>` : a.email}
              </option>
            ))}
          </select>
        </label>
      )}
      <AddrRow label={t("to")} value={d.to} onChange={(to) => set({ to })} autoFocus={!inline && d.mode !== "reply" && d.mode !== "replyAll"} extra={!showCc ? <button type="button" className="zm-link-btn" onClick={() => setShowCc(true)}>{t("cc")} / {t("bcc")}</button> : null} />
      {showCc && <AddrRow label={t("cc")} value={d.cc} onChange={(cc) => set({ cc })} />}
      {showCc && <AddrRow label={t("bcc")} value={d.bcc} onChange={(bcc) => set({ bcc })} />}
      {!inline || d.mode === "forward" ? (
        <input className="zm-compose-subject" value={d.subject} onChange={(e) => set({ subject: e.target.value })} placeholder={t("subject")} aria-label={t("subject")} />
      ) : null}
      <ComposeEditor
        handle={editor}
        initialBlocks={c.draft.blocks}
        initialHtml={c.draft.blocks?.length ? undefined : c.draft.html}
        locale={locale}
        placeholder={t("compose.placeholder")}
        onChange={changed}
        autoFocus={inline || d.mode === "reply" || d.mode === "replyAll"}
      />
      {account.signature && <div className="zm-signature" dangerouslySetInnerHTML={{ __html: account.signature }} />}
      {quoted && (
        <div className="zm-quote">
          <button type="button" className="zm-quote-toggle" onClick={() => setShowQuote((v) => !v)} aria-label={t("compose.showQuote")} title={t("compose.showQuote")}>
            <MoreHorizontal size={14} />
          </button>
          {showQuote && <QuotePreview m={quoted} forward={d.mode === "forward"} />}
        </div>
      )}
      {(d.attachments.length > 0 || (c.forward?.length && d.mode === "forward")) && (
        <div className="zm-atts">
          {d.mode === "forward" && quoted?.attachments.filter((a) => c.forward?.includes(a.id)).map((a) => (
            <span key={a.id} className="zm-att">
              <Paperclip size={14} />
              <span className="zm-att-name">{a.filename}</span>
              <span className="zm-att-size">{sizeText(a.size, locale)}</span>
            </span>
          ))}
          {d.attachments.map((a) => (
            <span key={a.id} className="zm-att">
              <Paperclip size={14} />
              <span className="zm-att-name">{a.filename}</span>
              <span className="zm-att-size">{sizeText(a.size, locale)}</span>
              <button type="button" className="zm-chip-x" aria-label={t("compose.removeAttachment", { name: a.filename })} onClick={() => set({ attachments: d.attachments.filter((x) => x.id !== a.id) })}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {share && (
        <div className="zm-share-bar" role="alert">
          <span>{t("share.prompt", { n: share.missing.length, title: share.title, who: share.missing.slice(0, 2).join(", ") })}</span>
          <button type="button" className="zv-btn zv-btn-sm zv-btn-primary" onClick={() => void shareDoc("view")}>
            {t("share.view")}
          </button>
          <button type="button" className="zv-btn zv-btn-sm" onClick={() => void shareDoc("comment")}>
            {t("share.comment")}
          </button>
          <button type="button" className="zv-btn zv-btn-sm zv-btn-ghost" onClick={() => setShare(null)}>
            {t("share.skip")}
          </button>
        </div>
      )}
      <div className="zm-compose-bar">
        <span className="zm-send-group">
          <button type="submit" className="zv-btn zv-btn-primary zm-send" disabled={busy} title={`${t("compose.send")} · ⌘↵`}>
            <Send size={14} />
            {t("compose.send")}
          </button>
          <button type="button" className="zv-btn zv-btn-primary zm-send-more" aria-label={t("compose.sendLater")} title={t("compose.sendLater")} onClick={(e) => setPop({ kind: "later", anchor: e.currentTarget })}>
            <ChevronDown size={14} />
          </button>
        </span>
        <label className="zm-icon-btn" title={t("compose.attach")} aria-label={t("compose.attach")}>
          <Paperclip size={16} />
          <input type="file" multiple hidden onChange={(e) => (void attach(e.target.files), (e.target.value = ""))} />
        </label>
        <button type="button" className="zm-icon-btn" title={t("compose.snippets")} aria-label={t("compose.snippets")} onClick={(e) => setPop({ kind: "snippets", anchor: e.currentTarget })}>
          <Sparkle size={16} />
        </button>
        <button type="button" className="zm-icon-btn" title={t("compose.linkDoc")} aria-label={t("compose.linkDoc")} onClick={(e) => setPop({ kind: "docs", anchor: e.currentTarget })}>
          <FileText size={16} />
        </button>
        {uploads > 0 && <span className="zm-uploading">{t("compose.uploading")}</span>}
        <span className="zm-bar-fill" />
        <button type="button" className="zm-icon-btn" title={t("compose.discard")} aria-label={t("compose.discard")} onClick={() => void discard()}>
          <Trash2 size={16} />
        </button>
      </div>
      {pop?.kind === "snippets" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={280}>
          <Menu
            onClose={() => setPop(null)}
            search
            placeholder={t("snippets.search")}
            empty={t("snippets.empty")}
            items={boot.snippets.map((s) => ({ id: s.id, label: s.name, run: () => void editor.current?.insertHtml(s.html).then(changed) }))}
          />
        </Popover>
      )}
      {pop?.kind === "docs" && <DocPicker anchor={pop.anchor} ws={ws} onClose={() => setPop(null)} onPick={(card) => void linkDoc(card)} />}
      {pop?.kind === "later" && <SendLaterPicker anchor={pop.anchor} onClose={() => setPop(null)} onPick={(at) => void send(at)} />}
    </form>
  );
}

function QuotePreview({ m, forward }: { m: MailMessage; forward: boolean }) {
  const { locale } = useMt();
  return <div className="zm-quote-body" dangerouslySetInnerHTML={{ __html: quoteHtml(m, locale, forward) }} />;
}

/** Addresses as chips, with suggestions as one types. */
function AddrRow({ label, value, onChange, autoFocus, extra }: { label: string; value: Addr[]; onChange: (v: Addr[]) => void; autoFocus?: boolean; extra?: React.ReactNode }) {
  const { t } = useMt();
  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<Contact[]>([]);
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const q = text.trim();
    if (!q) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSugg([]);
      return;
    }
    const tm = setTimeout(() => {
      void api<{ contacts: Contact[] }>(`contacts?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setSugg(r.contacts.filter((c) => !value.some((v) => v.address.toLowerCase() === c.address.toLowerCase())));
          setI(0);
        })
        .catch(() => setSugg([]));
    }, 120);
    return () => clearTimeout(tm);
  }, [text, value]);
  const add = (list: Addr[]) => {
    const next = [...value];
    for (const a of list) if (a.address && !next.some((x) => x.address.toLowerCase() === a.address.toLowerCase())) next.push(a);
    onChange(next);
    setText("");
    setSugg([]);
  };
  const commit = () => {
    if (text.trim()) add(parseAddrs(text));
  };
  return (
    <div className="zm-compose-row" onClick={() => input.current?.focus()}>
      <span className="zm-compose-label">{label}</span>
      <span className="zm-addrs">
        {value.map((a) => (
          <span key={a.address} className="zm-addr" data-bad={!EMAIL_RE.test(a.address) || undefined} title={a.address}>
            {a.name || a.address}
            <button type="button" className="zm-chip-x" aria-label={t("compose.removeAddress", { address: a.address })} onClick={() => onChange(value.filter((x) => x !== a))}>
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          className="zm-addr-input"
          value={text}
          autoFocus={autoFocus}
          aria-label={label}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v)) add(parseAddrs(v));
            else setText(v);
          }}
          onPaste={(e) => {
            const v = e.clipboardData.getData("text");
            if (/[,;\n]/.test(v)) {
              e.preventDefault();
              add(parseAddrs(v));
            }
          }}
          onBlur={() => setTimeout(commit, 150)}
          onKeyDown={(e) => {
            if (sugg.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setI((x) => (e.key === "ArrowDown" ? Math.min(x + 1, sugg.length - 1) : Math.max(x - 1, 0)));
            } else if ((e.key === "Enter" || e.key === "Tab") && (sugg.length || text.trim())) {
              if (e.key === "Enter") e.preventDefault();
              if (sugg[i]) add([{ name: sugg[i].name, address: sugg[i].address }]);
              else commit();
            } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
        />
      </span>
      {extra}
      {sugg.length > 0 && (
        <div className="zm-sugg" role="listbox">
          {sugg.map((c, n) => (
            <button
              key={c.address}
              type="button"
              role="option"
              aria-selected={n === i}
              className="zm-sugg-item"
              onMouseDown={(e) => {
                e.preventDefault();
                add([{ name: c.name, address: c.address }]);
              }}
            >
              <span className="zm-sugg-name">{c.name || c.address}</span>
              {c.name && <span className="zm-sugg-addr">{c.address}</span>}
              {c.member && <span className="zm-chip">{t("compose.member")}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Finds a Docs page to link (zvena's search, pages only). */
function DocPicker({ anchor, ws, onClose, onPick }: { anchor: HTMLElement; ws: string; onClose: () => void; onPick: (c: { key: string; title: string; url: string }) => void }) {
  const { t } = useMt();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ key: string; title: string; url: string; sub?: string }[]>([]);
  useEffect(() => {
    const ac = new AbortController();
    const tm = setTimeout(() => {
      void eco
        .search(ws, q, ac.signal)
        .then((r) => setHits(r.hits.filter((h) => h.kind === "note").slice(0, 12)))
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(tm);
      ac.abort();
    };
  }, [q, ws]);
  return (
    <Popover anchor={anchor} onClose={onClose} width={320} label={t("compose.linkDoc")}>
      <div className="zm-menu">
        <input className="zm-menu-search" autoFocus value={q} placeholder={t("docs.find")} onChange={(e) => setQ(e.target.value)} />
        <div className="zm-menu-items">
          {hits.map((h) => (
            <button
              key={h.key}
              type="button"
              className="zm-menu-item"
              onClick={() => {
                onClose();
                onPick(h);
              }}
            >
              <span className="zm-menu-icon">
                <FileText size={15} />
              </span>
              <span className="zm-menu-label">{h.title || t("untitled")}</span>
              {h.sub && <span className="zm-menu-hint">{h.sub}</span>}
            </button>
          ))}
          {!hits.length && <div className="zm-menu-empty">{t("docs.none")}</div>}
        </div>
      </div>
    </Popover>
  );
}
