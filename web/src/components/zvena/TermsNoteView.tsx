// The Terms note's markup from already-translated strings: "By continuing,
// you agree to the {terms} and acknowledge the {privacy}." Server pages render
// it directly (no dictionary in the browser); TermsNote does the same from
// client code with useI18n().

import { Fragment } from "react";

export function TermsNoteView({ text, termsLink, privacyLink, className = "zv-terms" }: { text: string; termsLink: string; privacyLink: string; className?: string }) {
  const parts = text.split("\u0000");
  return (
    <p className={className}>
      {parts.map((part, i) =>
        i === 0 ? (
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <Fragment key={i}>
            <a href={part[0] === "t" ? "/legal/terms" : "/legal/privacy"}>{part[0] === "t" ? termsLink : privacyLink}</a>
            {part.slice(1)}
          </Fragment>
        )
      )}
    </p>
  );
}

/** The vars that mark where the two links go in the translated sentence. */
export const TERMS_MARKS = { terms: "\u0000t", privacy: "\u0000p" };
