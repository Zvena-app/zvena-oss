"use client";

// The steps of /welcome (page.tsx). Each one asks one thing, answers it the
// moment you choose (the theme changes as you click it, your name is saved
// before the next step) and can be skipped; Enter goes on.

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { ArrowLeft, Check, Copy, Monitor, Moon, Search, Sun, User, Users, Zap } from "lucide-react";
import { BrandMarkIcon } from "@/components/brand/BrandLogo";
import { applyTheme, readTheme, type Theme } from "@/components/notes/prefs";
import { dt, type DsKey } from "@/components/zvena/ds/i18n";
import { Kbd } from "@/components/zvena/ds/Kbd";
import "@/components/zvena/ds/ds.css";
import { writeLangCookie, type Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-react";
import { LOCALES, LOCALE_INFO } from "@/i18n/locales";

type Step = "name" | "theme" | "team" | "invite" | "done";
type Role = "editor" | "commenter" | "viewer";
type Sent = { email: string; status: "sent" | "queued" | "failed" | "link" | "member"; link?: string };

const ROLE_LABEL: Record<Role, DsKey> = { editor: "shareCanEdit", commenter: "shareCanComment", viewer: "shareCanView" };

async function call<T>(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  try {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as T };
  } catch {
    return { ok: false, status: 0, data: {} as T };
  }
}

const first = (name: string) => name.trim().split(/\s+/)[0] ?? "";

export function Welcome({ name: savedName, email, next, team: offerTeam, mailOn }: { name: string; email: string; next: string; team: boolean; mailOn: boolean }) {
  const { t, locale } = useI18n();
  const d = (k: DsKey, v?: Record<string, string | number>) => dt(locale, k, v);
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState(savedName);
  const [stored, setStored] = useState(savedName);
  const [theme, setThemeState] = useState<Theme>("system");
  const [withTeam, setWithTeam] = useState<boolean | null>(null);
  const [teamName, setTeamName] = useState("");
  const [ws, setWs] = useState<{ id: string; name: string } | null>(null);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [sent, setSent] = useState<Sent[]>([]);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);

  // The stored theme lives in this browser (read after hydration).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setThemeState(readTheme()), []);

  const steps: Step[] = ["name", "theme", ...(offerTeam ? (["team", ...(withTeam !== false ? ["invite"] : [])] as Step[]) : []), "done"];
  const at = steps.indexOf(step);

  const go = (s: Step) => {
    setError("");
    setStep(s);
    // The new question is read out and Tab starts from it.
    requestAnimationFrame(() => head.current?.focus());
  };
  const forward = () => go(steps[at + 1] ?? "done");
  const back = () => at > 0 && go(steps[at - 1]);

  const saveName = async (): Promise<boolean> => {
    const clean = name.trim();
    if (!clean || clean === stored) return true;
    const r = await call("PATCH", "/api/auth/profile", { name: clean });
    if (r.ok) setStored(clean);
    return r.ok;
  };

  const run = async (e: FormEvent | null, work: () => Promise<boolean | void>) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const ok = await work();
    setBusy(false);
    if (ok === false) setError(d("failed"));
  };

  const finish = () => {
    // A new team opens on its own Home; otherwise where the person was headed.
    const to = ws && next.startsWith("/home") ? `/home?ws=${encodeURIComponent(ws.id)}` : next;
    location.assign(to);
  };

  const greeting = first(name) || first(stored);

  let body: ReactNode;
  if (step === "name") {
    body = (
      <form onSubmit={(e) => run(e, async () => ((await saveName()) ? forward() : false))}>
        <Head ref={head} title={t("welcome.name.title")} lead={t("welcome.name.lead")} />
        <div className="zw-who">
          <span className="zw-avatar" aria-hidden>
            {(greeting[0] ?? "?").toUpperCase()}
          </span>
          <span className="zw-who-text">
            <span className="zw-who-name">{name.trim() || t("welcome.name.label")}</span>
            {email && <span className="zw-who-mail">{email}</span>}
          </span>
        </div>
        <label className="zw-field">
          <span className="zw-label">{t("welcome.name.label")}</span>
          <input className="zw-input" value={name} maxLength={120} autoFocus autoComplete="name" required onChange={(e) => setName(e.target.value)} data-test="welcome-name" />
        </label>
        <label className="zw-field">
          <span className="zw-label">{t("welcome.lang")}</span>
          <select
            className="zw-input"
            value={locale}
            onChange={(e) => {
              // The page comes back in the new language, with the name already saved.
              const l = e.target.value as Locale;
              void saveName().finally(() => {
                writeLangCookie(l);
                location.reload();
              });
            }}
            data-test="welcome-lang"
          >
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {LOCALE_INFO[l].native}
              </option>
            ))}
          </select>
        </label>
        <Actions busy={busy} disabled={!name.trim()} label={t("welcome.continue")} />
      </form>
    );
  } else if (step === "theme") {
    const choices: { v: Theme; icon: ReactNode; label: string }[] = [
      { v: "light", icon: <Sun aria-hidden />, label: t("settings.theme.light") },
      { v: "dark", icon: <Moon aria-hidden />, label: t("settings.theme.dark") },
      { v: "system", icon: <Monitor aria-hidden />, label: t("settings.theme.system") },
    ];
    body = (
      <form onSubmit={(e) => run(e, async () => forward())}>
        <Head ref={head} title={t("welcome.theme.title")} lead={t("welcome.theme.lead")} />
        <div className="zw-themes" role="radiogroup" aria-label={t("welcome.theme.title")}>
          {choices.map((c) => (
            <button
              key={c.v}
              type="button"
              role="radio"
              aria-checked={theme === c.v}
              className="zw-theme"
              data-v={c.v}
              onClick={() => {
                applyTheme(c.v);
                setThemeState(c.v);
              }}
              data-test={`welcome-theme-${c.v}`}
            >
              <span className="zw-theme-art" aria-hidden>
                <span className="zw-theme-side" />
                <span className="zw-theme-main">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
              <span className="zw-theme-label">
                {c.icon}
                {c.label}
                {theme === c.v && <Check className="zw-theme-on" aria-hidden />}
              </span>
            </button>
          ))}
        </div>
        <Actions busy={busy} label={t("welcome.continue")} onBack={back} backLabel={t("common.back")} />
      </form>
    );
  } else if (step === "team") {
    body = (
      <form
        onSubmit={(e) =>
          run(e, async () => {
            if (!withTeam) return go("done");
            if (ws) return forward();
            const clean = teamName.trim() || d("shareTeamDefault", { name: greeting || "zvena" });
            const r = await call<{ workspace?: { id: string; name: string }; error?: string }>("POST", "/api/ws", { name: clean });
            if (r.status === 409) {
              setError(t("welcome.team.limit"));
              return;
            }
            if (!r.ok || !r.data.workspace) return false;
            setWs({ id: r.data.workspace.id, name: r.data.workspace.name });
            forward();
          })
        }
      >
        <Head ref={head} title={t("welcome.team.title")} lead={t("welcome.team.lead")} />
        <div className="zw-choices" role="radiogroup" aria-label={t("welcome.team.title")}>
          <Choice on={withTeam === false} icon={<User aria-hidden />} title={t("welcome.team.solo")} hint={t("welcome.team.soloHint")} onPick={() => setWithTeam(false)} test="welcome-solo" />
          <Choice
            on={withTeam === true}
            icon={<Users aria-hidden />}
            title={t("welcome.team.with")}
            hint={t("welcome.team.withHint")}
            onPick={() => {
              setWithTeam(true);
              setTeamName((v) => v || d("shareTeamDefault", { name: greeting || "zvena" }));
            }}
            test="welcome-team"
          />
        </div>
        {withTeam && (
          <label className="zw-field">
            <span className="zw-label">{d("shareTeamName")}</span>
            <input className="zw-input" value={teamName} maxLength={80} autoFocus={!ws} disabled={Boolean(ws)} onChange={(e) => setTeamName(e.target.value)} data-test="welcome-team-name" />
          </label>
        )}
        <Actions busy={busy} disabled={withTeam === null || (withTeam && !teamName.trim())} label={t("welcome.continue")} onBack={back} backLabel={t("common.back")} />
      </form>
    );
  } else if (step === "invite" && ws) {
    const copy = async (url: string) => {
      await navigator.clipboard.writeText(url).catch(() => {});
      setCopied(url);
    };
    const status = (s: Sent) =>
      s.status === "sent" ? d("shareSent", { email: s.email }) : s.status === "queued" ? d("shareQueued", { email: s.email }) : s.status === "member" ? d("shareMember", { email: s.email }) : s.status === "link" ? d("shareByLink", { email: s.email }) : d("shareFailed", { email: s.email });
    body = (
      <form
        onSubmit={(e) =>
          run(e, async () => {
            if (!emails.trim()) return forward();
            const r = await call<{ results?: Sent[]; bad?: string[] }>("POST", `/api/ws/share?ws=${encodeURIComponent(ws.id)}`, { emails, role });
            const bad = r.data.bad ?? [];
            if (r.data.results) setSent((prev) => [...prev, ...(r.data.results as Sent[])]);
            if (bad.length) {
              setEmails(bad.join(", "));
              setError(d("shareBad", { list: bad.join(", ") }));
              return;
            }
            if (!r.ok) return false;
            setEmails("");
          })
        }
      >
        <Head ref={head} title={t("welcome.invite.title")} lead={t("welcome.invite.lead", { ws: ws.name })} />
        {!mailOn && <p className="zw-note">{d("shareNoMail")}</p>}
        <label className="zw-field">
          <span className="zw-label">{d("shareEmails")}</span>
          <textarea className="zw-input zw-emails" rows={3} value={emails} autoFocus placeholder="name@company.com" onChange={(e) => setEmails(e.target.value)} data-test="welcome-emails" />
        </label>
        <div className="zw-row">
          <select className="zw-input zw-role" value={role} aria-label={t("ws.inviteRole")} onChange={(e) => setRole(e.target.value as Role)}>
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
              <option key={r} value={r}>
                {d(ROLE_LABEL[r])}
              </option>
            ))}
          </select>
          <button type="submit" className="zw-btn" disabled={busy || !emails.trim()} data-test="welcome-send">
            {t("welcome.invite.send")}
          </button>
        </div>
        {sent.length > 0 && (
          <ul className="zw-sent" aria-live="polite">
            {sent.map((s, i) => (
              <li key={`${s.email}-${i}`} data-status={s.status}>
                {s.status === "sent" || s.status === "queued" || s.status === "member" ? <Check aria-hidden /> : <span className="zw-dot" aria-hidden />}
                <span>{status(s)}</span>
                {s.link && (
                  <button type="button" className="zw-link" onClick={() => void copy(s.link as string)}>
                    {copied === s.link ? d("shareCopied") : d("shareCopy")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="zw-invite-link">
          <span className="zw-label">{d("shareLink")}</span>
          {link ? (
            <div className="zw-row">
              <input className="zw-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={d("shareLink")} data-test="welcome-link" />
              <button type="button" className="zw-btn zw-btn-quiet" onClick={() => void copy(link)}>
                {copied === link ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied === link ? d("shareCopied") : d("shareCopy")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="zw-btn zw-btn-quiet zw-btn-start"
              disabled={busy}
              onClick={() =>
                void run(null, async () => {
                  const r = await call<{ url?: string }>("POST", `/api/ws/invites?ws=${encodeURIComponent(ws.id)}`, { role, days: 7, maxUses: 50 });
                  if (!r.ok || !r.data.url) return false;
                  setLink(r.data.url);
                  await copy(r.data.url);
                })
              }
              data-test="welcome-make-link"
            >
              <Copy aria-hidden />
              {d("shareCopy")}
            </button>
          )}
        </div>
        <div className="zw-actions">
          <button type="button" className="zw-back" onClick={back}>
            <ArrowLeft aria-hidden />
            {t("common.back")}
          </button>
          <button type="button" className="zw-btn zw-btn-primary" onClick={forward} data-test="welcome-next">
            {sent.length || link ? t("welcome.continue") : t("welcome.skip")}
          </button>
        </div>
      </form>
    );
  } else {
    body = (
      <div>
        <Head ref={head} title={greeting ? t("welcome.done.title", { name: greeting }) : t("welcome.done.titleNoName")} lead={t("welcome.done.lead")} />
        <ul className="zw-tips">
          <li>
            <span className="zw-tip-icon" aria-hidden>
              <Search />
            </span>
            <span className="zw-tip-text">{t("welcome.done.palette")}</span>
            <Kbd keys={["⌘", "K"]} />
          </li>
          <li>
            <span className="zw-tip-icon" aria-hidden>
              <Zap />
            </span>
            <span className="zw-tip-text">{t("welcome.done.create")}</span>
          </li>
        </ul>
        <div className="zw-actions">
          <button type="button" className="zw-back" onClick={back}>
            <ArrowLeft aria-hidden />
            {t("common.back")}
          </button>
          <button type="button" className="zw-btn zw-btn-primary" onClick={finish} autoFocus data-test="welcome-open">
            {t("welcome.done.open")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="zw-card">
      <div className="zw-top">
        <BrandMarkIcon className="zw-mark" />
        <ol className="zw-steps" aria-label={t("welcome.step", { n: at + 1, total: steps.length })}>
          {steps.map((s, i) => (
            <li key={s} data-on={i <= at || undefined} aria-current={i === at ? "step" : undefined} />
          ))}
        </ol>
      </div>
      {body}
      {error && (
        <p className="zw-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Head({ ref, title, lead }: { ref: Ref<HTMLHeadingElement>; title: string; lead: string }) {
  return (
    <>
      <h1 ref={ref} tabIndex={-1} className="zw-title">
        {title}
      </h1>
      <p className="zw-lead">{lead}</p>
    </>
  );
}

function Choice({ on, icon, title, hint, onPick, test }: { on: boolean; icon: ReactNode; title: string; hint: string; onPick: () => void; test: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className="zw-choice" onClick={onPick} data-test={test}>
      <span className="zw-choice-icon">{icon}</span>
      <span className="zw-choice-text">
        <span className="zw-choice-title">{title}</span>
        <span className="zw-choice-hint">{hint}</span>
      </span>
      <span className="zw-radio" aria-hidden>
        {on && <Check />}
      </span>
    </button>
  );
}

function Actions({ busy, disabled, label, onBack, backLabel }: { busy: boolean; disabled?: boolean; label: string; onBack?: () => void; backLabel?: string }) {
  return (
    <div className="zw-actions">
      {onBack ? (
        <button type="button" className="zw-back" onClick={onBack}>
          <ArrowLeft aria-hidden />
          {backLabel}
        </button>
      ) : (
        <span />
      )}
      <button type="submit" className="zw-btn zw-btn-primary" disabled={busy || disabled} data-test="welcome-next">
        {label}
      </button>
    </div>
  );
}
