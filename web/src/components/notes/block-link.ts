"use client";

// zvena Documents: links to a block (Notion's "Copy link to block", an
// Inbox item about a comment, a search hit): `/docs#<page>&b=<block id>`.
// Opening one scrolls the page to that block and highlights it for a moment.

import { useEffect } from "react";

let pending: { page: string; block: string } | null = null;

const BLOCK_RE = /^[\w~-]{1,80}$/;

/** The block a page link points at (`…&b=<id>`), or null. */
export function blockOfHash(hash: string): string | null {
  const m = /[?&]b=([^&]+)/.exec(decodeURIComponent(hash));
  return m && BLOCK_RE.test(m[1]) ? m[1] : null;
}

/** A link to a database view (`…&v=<view id>`, "Copy link to view"): kept until a database with that view shows. */
let pendingView: string | null = null;
export function expectView(hash: string): void {
  const m = /[?&]v=([\w-]{1,64})/.exec(decodeURIComponent(hash));
  pendingView = m ? m[1] : null;
}
/** The linked view, once, for a database that has it. */
export function takeView(has: (id: string) => boolean): string | null {
  if (!pendingView || !has(pendingView)) return null;
  const v = pendingView;
  pendingView = null;
  return v;
}

/** The page about to open should show this block (a link without one leaves an earlier request alone). */
export function expectBlock(page: string, block: string | null | undefined): void {
  if (block && BLOCK_RE.test(block)) pending = { page, block };
  else if (pending && pending.page !== page) pending = null;
}

/**
 * Scrolls to a block of an editor on screen and highlights it for a moment.
 * The highlight is a box of its own over the block (the editor redraws any
 * class put on its own elements).
 */
export function flashBlock(root: ParentNode, id: string): boolean {
  const el = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"]`);
  const host = el?.closest<HTMLElement>(".nt-editor");
  if (!el || !host) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const box = el.getBoundingClientRect();
  const base = host.getBoundingClientRect();
  const flash = document.createElement("div");
  flash.className = "nt-block-flash";
  flash.dataset.for = id;
  flash.setAttribute("aria-hidden", "true");
  Object.assign(flash.style, { top: `${box.top - base.top}px`, left: `${box.left - base.left}px`, width: `${box.width}px`, height: `${box.height}px` });
  host.appendChild(flash);
  setTimeout(() => flash.remove(), 2400);
  return true;
}

/** Scrolls to and highlights the block a link asked for, once the page's editor shows it. */
export function useBlockLink(noteId: string): void {
  useEffect(() => {
    const want = pending?.page === noteId ? pending.block : null;
    if (!want) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const find = () => {
      // The editor loads after the page (its own part), and a live session a moment later.
      if (flashBlock(document, want)) {
        if (pending?.page === noteId) pending = null;
        return;
      }
      if (++tries < 80) timer = setTimeout(find, 150);
    };
    timer = setTimeout(find, 100);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [noteId]);
}
