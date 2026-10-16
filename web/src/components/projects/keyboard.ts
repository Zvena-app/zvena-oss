"use client";

// iOS Safari keeps the layout viewport (and 100dvh) when the on-screen
// keyboard opens: a bottom sheet or a sticky comment box ends up under it.
// While a component that needs it is mounted, this publishes the keyboard's
// height as --pj-kb, the visible height as --pj-vh and .pj-kb-open on <html> (from
// visualViewport), and the CSS lifts the sheet / composer by it
// (app/responsive/projects.css). Where the browser already resizes the page
// for the keyboard (Android with interactive-widget=resizes-content) the gap
// is 0 and nothing is set.

import { useEffect } from "react";

let users = 0;
let off: (() => void) | null = null;

function start(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  let raf = 0;
  const update = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.classList.toggle("pj-kb-open", kb > 40);
      if (kb > 40) {
        root.style.setProperty("--pj-kb", `${kb}px`);
        root.style.setProperty("--pj-vh", `${Math.round(vv.height)}px`);
      } else {
        root.style.removeProperty("--pj-kb");
        root.style.removeProperty("--pj-vh");
      }
    });
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
  return () => {
    cancelAnimationFrame(raf);
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    root.classList.remove("pj-kb-open");
    root.style.removeProperty("--pj-kb");
    root.style.removeProperty("--pj-vh");
  };
}

/** Keeps --pj-kb / --pj-vh current while the calling component is mounted. */
export function useKeyboardInset(): void {
  useEffect(() => {
    if (users++ === 0) off = start();
    return () => {
      if (--users === 0) {
        off?.();
        off = null;
      }
    };
  }, []);
}
