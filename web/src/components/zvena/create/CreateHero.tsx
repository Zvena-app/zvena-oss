"use client";

// Home's "What will you create?" (Canva's homepage hero): the big question,
// the most used formats as tiles in one click, and "More" for the rest and
// the templates. For people who can only view the workspace it says so
// instead of offering buttons that would not work.

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { CREATE_ITEMS } from "@/lib/create";
import { useI18n } from "@/lib/i18n-react";
import { CreatePicker, CreateTile } from "./CreatePicker";
import { ct } from "./i18n";
import "./create.css";

const FIRST = ["doc", "table", "issue", "presentation", "social", "mobile", "website"];

export function CreateHero({ ws, canEdit, forRef }: { ws: string; canEdit: boolean; forRef?: string }) {
  const { locale } = useI18n();
  const [all, setAll] = useState(false);
  if (!canEdit) return <p className="zc-readonly">{ct("readOnly", locale)}</p>;
  const first = FIRST.map((id) => CREATE_ITEMS.find((x) => x.id === id)).filter((x) => x !== undefined);
  return (
    <section className="zc-hero" aria-labelledby="zc-hero-title">
      <h2 id="zc-hero-title" className="zc-hero-title">
        {ct("heroTitle", locale)}
      </h2>
      {all ? (
        <CreatePicker ws={ws} autoFocus forRef={forRef} />
      ) : (
        <div className="zc-hero-row">
          {first.map((item) => (
            <CreateTile key={item.id} item={item} ws={ws} size="lg" forRef={forRef} />
          ))}
          <button type="button" className="zc-tile zc-tile-lg zc-tile-more" onClick={() => setAll(true)}>
            <span className="zc-tile-icon">
              <MoreHorizontal />
            </span>
            <span className="zc-tile-text">
              <span className="zc-tile-label">{ct("more", locale)}</span>
            </span>
          </button>
        </div>
      )}
    </section>
  );
}
