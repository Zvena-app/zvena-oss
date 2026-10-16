"use client";

// Answer inputs of a form question, shared by the form builder (as a
// disabled preview) and the public form page (no workspace context there).

import type { PropType } from "@/lib/notes/types";

export interface FormQuestionView {
  prop: string;
  type: PropType;
  name: string;
  help: string;
  required: boolean;
  options?: { id: string; name: string; color: string }[];
}

export type FormAnswer = string | boolean | string[] | undefined;

const INPUT_TYPE: Partial<Record<PropType, string>> = { email: "email", url: "url", phone: "tel", number: "number", date: "date" };

export function FormInput({
  q,
  value,
  onChange,
  disabled,
  id,
  labels,
}: {
  q: FormQuestionView;
  value: FormAnswer;
  onChange?: (v: FormAnswer) => void;
  disabled?: boolean;
  id: string;
  labels: { yes: string; placeholder?: string };
}) {
  const set = (v: FormAnswer) => onChange?.(v);
  if (q.type === "select" || q.type === "status" || q.type === "multi_select") {
    const multi = q.type === "multi_select";
    const picked = new Set(Array.isArray(value) ? value : typeof value === "string" && value ? [value] : []);
    return (
      <div className="nt-ff-options" role={multi ? "group" : "radiogroup"} aria-labelledby={`${id}-label`}>
        {(q.options ?? []).map((o) => (
          <label key={o.id} className="nt-ff-option" data-on={picked.has(o.id) || undefined}>
            <input
              type={multi ? "checkbox" : "radio"}
              name={id}
              disabled={disabled}
              checked={picked.has(o.id)}
              onChange={(e) => {
                if (!multi) return set(o.id);
                const next = new Set(picked);
                if (e.target.checked) next.add(o.id);
                else next.delete(o.id);
                set(next.size ? [...next] : undefined);
              }}
            />
            <span>{o.name}</span>
          </label>
        ))}
      </div>
    );
  }
  if (q.type === "checkbox")
    return (
      <label className="nt-ff-option" data-on={value === true || undefined}>
        <input type="checkbox" id={id} disabled={disabled} checked={value === true} onChange={(e) => set(e.target.checked || undefined)} />
        <span>{labels.yes}</span>
      </label>
    );
  if (q.type === "text")
    return (
      <textarea
        id={id}
        className="nt-ff-input nt-ff-textarea"
        rows={3}
        disabled={disabled}
        maxLength={20_000}
        placeholder={labels.placeholder}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => set(e.target.value)}
      />
    );
  return (
    <input
      id={id}
      className="nt-ff-input"
      type={INPUT_TYPE[q.type] ?? "text"}
      inputMode={q.type === "number" ? "decimal" : undefined}
      disabled={disabled}
      maxLength={q.type === "number" || q.type === "date" ? undefined : 2000}
      placeholder={labels.placeholder}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => set(e.target.value)}
    />
  );
}
