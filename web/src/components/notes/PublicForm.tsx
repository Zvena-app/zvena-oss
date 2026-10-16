"use client";

// A public zvena Documents form (/f/<id>): anyone with the link answers; each
// response becomes a page in the owner's database.

import "./notes.css";
import "./theme.css";
import Link from "next/link";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { BrandMarkIcon } from "@/components/brand/BrandLogo";
import { FormInput, type FormAnswer } from "./form-controls";
import { useNotesT } from "@/lib/notes/i18n";
import type { PublicForm as PublicFormT } from "@/lib/notes/server-store";
import { NoteIcon } from "./NoteIcon";
import { shownQuestions } from "@/lib/notes/form-logic";

type State = "idle" | "sending" | "sent" | "closed";

const empty = (v: FormAnswer) => v === undefined || v === false || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);

/** `who`: the visitor, as the server saw them — signed in or not, and a member of the form's workspace or not. */
export default function PublicForm({ form, who = { signedIn: false, member: false, name: "" } }: { form: PublicFormT | null; who?: { signedIn: boolean; member: boolean; name: string } }) {
  const { t } = useNotesT();
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<State>(form ? "idle" : "closed");
  const [failed, setFailed] = useState(false);

  // Conditional logic: the questions the answers so far call for (hidden ones are not sent).
  const shown = form ? shownQuestions(form.questions, answers) : new Set<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || state === "sending") return;
    const missing: Record<string, string> = {};
    for (const q of form.questions) if (shown.has(q.prop) && q.required && empty(answers[q.prop])) missing[q.prop] = t("form.requiredMissing");
    setErrors(missing);
    if (Object.keys(missing).length) {
      document.getElementById(`q-${Object.keys(missing)[0]}`)?.focus();
      return;
    }
    setState("sending");
    setFailed(false);
    try {
      const res = await fetch(`/api/notes/form/${encodeURIComponent(form.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: Object.fromEntries(Object.entries(answers).filter(([k]) => shown.has(k))) }),
      });
      if (res.status === 404) return setState("closed");
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; prop?: string };
      if (res.ok && data.ok) {
        setState("sent");
        window.scrollTo({ top: 0 });
        return;
      }
      if (data.prop) setErrors({ [data.prop]: data.error === "required" ? t("form.requiredMissing") : t("form.invalid") });
      else setFailed(true);
      setState("idle");
    } catch {
      setFailed(true);
      setState("idle");
    }
  };

  return (
    <div className="nt-pub nt-formpage">
      <header className="nt-pub-top">
        <span />
        <Link className="nt-pub-brand" href="/">
          <BrandMarkIcon className="nt-pub-mark" />
          {t("public.try")}
        </Link>
      </header>
      <main className="nt-formpage-main">
        {!form || state === "closed" ? (
          <div className="nt-form-card nt-formpage-msg">
            <p>{t("form.closed")}</p>
          </div>
        ) : (
          <>
            <div className="nt-form-card nt-formpage-head">
              {form.icon && <div className="nt-formpage-icon"><NoteIcon icon={form.icon} /></div>}
              <h1>{form.title || t("form.untitled")}</h1>
              {form.description && <p className="nt-formpage-desc">{form.description}</p>}
            </div>
            {form.membersOnly && !who.member ? (
              // Only the workspace's members may answer (Notion's "Only people in your workspace").
              <div className="nt-form-card nt-formpage-msg" data-test="form-gate">
                <p>{who.signedIn ? t("form.notMember", { name: who.name }) : t("form.membersOnly")}</p>
                <a className="nt-btn nt-btn-primary nt-btn-reset" href={`/signin?next=${encodeURIComponent(`/f/${form.id}`)}`}>
                  {who.signedIn ? t("form.switchAccount") : t("form.signInToAnswer")}
                </a>
              </div>
            ) : state === "sent" ? (
              <div className="nt-form-card nt-formpage-msg" role="status">
                <CircleCheck className="nt-formpage-ok" />
                <p>{form.thanks || t("form.thanksDefault")}</p>
                <button
                  type="button"
                  className="nt-btn nt-btn-reset"
                  onClick={() => {
                    setAnswers({});
                    setErrors({});
                    setState("idle");
                  }}
                >
                  {t("form.another")}
                </button>
              </div>
            ) : (
              <form onSubmit={submit} noValidate>
                {who.member && !form.anonymous && <p className="nt-formpage-recorded" data-test="form-recorded">{t("form.recorded", { name: who.name })}</p>}
                {form.questions.filter((q) => shown.has(q.prop)).map((q) => (
                  <div key={q.prop} className="nt-form-card nt-ff" data-error={errors[q.prop] ? "true" : undefined}>
                    <label className="nt-ff-label" id={`q-${q.prop}-label`} htmlFor={`q-${q.prop}`}>
                      {q.name}
                      {q.required && <span className="nt-ff-req" aria-label={t("form.required")}> *</span>}
                    </label>
                    {q.help && <div className="nt-ff-help">{q.help}</div>}
                    <FormInput
                      q={q}
                      id={`q-${q.prop}`}
                      value={answers[q.prop]}
                      labels={{ yes: t("form.yes") }}
                      onChange={(v) => {
                        setAnswers((a) => ({ ...a, [q.prop]: v }));
                        if (errors[q.prop]) setErrors(({ [q.prop]: _gone, ...rest }) => (void _gone, rest));
                      }}
                    />
                    {errors[q.prop] && <div className="nt-ff-error">{errors[q.prop]}</div>}
                  </div>
                ))}
                <div className="nt-formpage-actions">
                  {failed && <span className="nt-ff-error">{t("form.error")}</span>}
                  <button type="submit" className="nt-btn nt-btn-primary nt-btn-reset" disabled={state === "sending"}>
                    {state === "sending" ? t("form.sending") : t("form.submit")}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        <footer className="nt-formpage-foot">
          <Link href="/">{t("form.madeWith")}</Link>
          {" · "}
          <a href={`/report?url=${encodeURIComponent(typeof location === "undefined" ? "" : location.href)}`} rel="nofollow">
            {t("public.report")}
          </a>
        </footer>
      </main>
    </div>
  );
}
