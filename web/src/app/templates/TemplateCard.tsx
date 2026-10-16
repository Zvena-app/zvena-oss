import type { CSSProperties, ReactNode } from "react";
import "@/components/zvena/create/create.css";

// One template in the gallery: icon, name, a line about it, and "Use". The
// icon is the page's emoji (Docs templates) or a line icon on a tinted tile,
// like "What will you create?" (Design templates).
export function TemplateCard({ icon, tint, title, description, href, disabled, label }: { icon: string | ReactNode; tint?: string; title: string; description?: string; href: string; disabled: boolean; label: string }) {
  return (
    <div className="zv-tile" style={{ cursor: "default" }}>
      {typeof icon === "string" ? (
        <span style={{ fontSize: 26 }} aria-hidden="true">
          {icon}
        </span>
      ) : (
        <span className="zc-tile-icon" style={{ "--zc-tint": tint } as CSSProperties} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="zv-tile-title">{title}</span>
      {description && <span className="zv-tile-meta">{description}</span>}
      <span style={{ marginTop: "auto", paddingTop: 8 }}>
        {disabled ? (
          <span className="zv-badge">{label}</span>
        ) : (
          <a className="zv-btn zv-btn-sm" href={href}>
            {label}
          </a>
        )}
      </span>
    </div>
  );
}
