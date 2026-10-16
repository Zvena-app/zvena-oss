// Keyboard helpers shared by every section: how a shortcut reads on this
// platform, and whether a key press belongs to someone typing. Pure, so
// tests and server code can use them too.

/** "⌘" on Apple devices, "Ctrl" elsewhere. */
export function isApple(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** A shortcut as written in the design system (["⌘", "K"]) the way this platform shows it. */
export function formatKeys(keys: readonly string[], apple: boolean): string[] {
  return keys.map((k) => {
    if (apple) return k;
    if (k === "⌘") return "Ctrl";
    if (k === "⌥") return "Alt";
    if (k === "⇧") return "Shift";
    return k;
  });
}

/** True when a key event happens in a text field, an editor or any contentEditable. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
  }
  return false;
}

/** True when a visible dialog, menu or popover other than `except` is open (a single-key shortcut must not fire then). */
export function overlayOpen(doc: Document, except?: Element | null): boolean {
  const open = doc.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"]');
  for (const el of open) {
    if (except && except.contains(el)) continue;
    // Mounted but hidden (a closed palette, a listbox inside a closed popover) does not count.
    if (el.closest('[hidden], [aria-hidden="true"]') || el.getClientRects().length === 0) continue;
    return true;
  }
  return false;
}
