"use client";

// The website's menus: dropdowns on wide screens (open on hover or click,
// Escape or a click outside closes), a full-screen menu behind the burger on
// narrow ones. The structure comes from PublicChrome (SITE_MENU).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Menu as MenuIcon, X } from "lucide-react";

export interface SiteMenu {
  label: string;
  href?: string;
  items?: { href: string; title: string; note?: string }[];
}

export function SiteNav({ menu }: { menu: SiteMenu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const hover = (i: number | null) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(i), i === null ? 160 : 60);
  };
  return (
    <nav className="zs-nav" aria-label="Main" ref={ref}>
      {menu.map((m, i) =>
        m.items ? (
          <div className="zs-nav-item" key={m.label} data-open={open === i || undefined} onMouseEnter={() => hover(i)} onMouseLeave={() => hover(null)}>
            <button type="button" className="zs-nav-trigger" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
              {m.label}
              <ChevronDown aria-hidden="true" />
            </button>
            <div className="zs-menu">
              {m.items.map((it) => (
                <Link key={it.href} href={it.href} onClick={() => setOpen(null)}>
                  <b>{it.title}</b>
                  {it.note && <span>{it.note}</span>}
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <Link key={m.label} className="zs-nav-link" href={m.href ?? "/"}>
            {m.label}
          </Link>
        )
      )}
    </nav>
  );
}

export function SiteMobileMenu({ menu, signedIn }: { menu: SiteMenu[]; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    document.documentElement.style.overflow = open ? "hidden" : "";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [open]);
  return (
    <>
      <button type="button" className="zs-burger" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <X /> : <MenuIcon />}
      </button>
      <div className="zs-mobile" data-open={open || undefined}>
        {menu.map((m) => (
          <section key={m.label}>
            {m.items ? (
              <>
                <h2>{m.label}</h2>
                {m.items.map((it) => (
                  <Link key={it.href} href={it.href} onClick={() => setOpen(false)}>
                    {it.title}
                  </Link>
                ))}
              </>
            ) : (
              <Link href={m.href ?? "/"} onClick={() => setOpen(false)}>
                {m.label}
              </Link>
            )}
          </section>
        ))}
        <div className="zs-mobile-actions">
          {signedIn ? (
            <Link className="zv-btn zv-btn-primary zv-btn-lg" href="/home">
              Open zvena
            </Link>
          ) : (
            <>
              <Link className="zv-btn zv-btn-primary zv-btn-lg" href="/signin">
                Get started for free
              </Link>
              <Link className="zv-btn zv-btn-lg" href="/signin">
                Sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </>
  );
}
