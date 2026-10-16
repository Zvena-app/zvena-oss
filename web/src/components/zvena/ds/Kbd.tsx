"use client";

// Keycap: a shortcut shown next to its action, so people learn the keys by
// using the menus (design system: Keycap). Written the Apple way ("⌘", "K");
// on other platforms "⌘" reads "Ctrl".

import { useSyncExternalStore } from "react";
import { formatKeys, isApple } from "./keys";

const subscribe = () => () => {};
const apple = () => isApple(navigator.platform || navigator.userAgent);
// The server cannot know the platform: it renders the Apple form, the browser corrects it.
const appleOnServer = () => true;

export function useApple(): boolean {
  return useSyncExternalStore(subscribe, apple, appleOnServer);
}

export function Kbd({ keys, className }: { keys: readonly string[]; className?: string }) {
  const shown = formatKeys(keys, useApple());
  return (
    <span className={`ds-kbd-group${className ? ` ${className}` : ""}`} aria-hidden="true">
      {shown.map((k, i) => (
        <kbd key={i} className="ds-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}
