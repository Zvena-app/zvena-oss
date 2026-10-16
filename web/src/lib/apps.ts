// zvena's own apps around the web app: the installed web app (install
// prompt), the desktop app (clients/desktop: Electron, `zvena://` links) and
// the phone apps (clients/mobile: Capacitor). Browser-only helpers, plus the
// pure link mapping the tests cover.

/** The app's link for a page of this site: https://zvena.app/docs?ws=a#Page → zvena://docs?ws=a#Page (null: another site). */
export function desktopLink(href: string, origin: string): string | null {
  try {
    const u = new URL(href, origin);
    if (u.origin !== new URL(origin).origin) return null;
    return `zvena://${u.pathname.replace(/^\/+/, "")}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/** Inside the desktop app (its user agent says so, and its preload names itself). */
export function inDesktopApp(): boolean {
  if (typeof navigator === "undefined") return false;
  const w = typeof window !== "undefined" ? (window as unknown as { zvenaDesktop?: { isDesktop?: boolean } }) : null;
  return / zvena-desktop\//.test(navigator.userAgent) || Boolean(w?.zvenaDesktop?.isDesktop);
}

/** Inside the iOS or Android app. */
export function inMobileApp(): boolean {
  if (typeof navigator === "undefined") return false;
  const cap = typeof window !== "undefined" ? (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor : undefined;
  return / zvena-mobile\//.test(navigator.userAgent) || Boolean(cap?.isNativePlatform?.());
}

// ---------------------------------------------------------------- "Open links in desktop app"

const DESKTOP_KEY = "zvena-desktop-links";

/** Notion's "Open links in desktop app": this browser's choice. */
export function opensInDesktop(): boolean {
  try {
    return localStorage.getItem(DESKTOP_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOpensInDesktop(on: boolean): void {
  try {
    if (on) localStorage.setItem(DESKTOP_KEY, "1");
    else localStorage.removeItem(DESKTOP_KEY);
  } catch {
    // Private mode: this page view only.
  }
}

/** Hands the page to the desktop app (the browser asks the system for zvena://). */
export function openInDesktop(href: string): boolean {
  const link = desktopLink(href, location.origin);
  if (!link) return false;
  location.href = link;
  return true;
}

/**
 * Whether this page load should go to the desktop app: the setting is on,
 * we are in a browser (not one of our apps), and the person arrived from
 * somewhere else (a link in mail or chat), not by moving around in zvena.
 */
export function shouldHandOff(): boolean {
  if (!opensInDesktop() || inDesktopApp() || inMobileApp()) return false;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.type !== "navigate") return false;
    if (document.referrer && new URL(document.referrer).origin === location.origin) return false;
    return !sessionStorage.getItem("zvena-stay-in-browser");
  } catch {
    return false;
  }
}

/** "Open here instead": this tab stays in the browser for its session. */
export function stayInBrowser(): void {
  try {
    sessionStorage.setItem("zvena-stay-in-browser", "1");
  } catch {
    // Private mode: nothing to remember.
  }
}

// ---------------------------------------------------------------- install prompt

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** Starts listening for the browser's install offer (once, from the service worker's registration). */
export function watchInstall(): void {
  if (typeof window === "undefined" || (window as unknown as { __zvInstall?: boolean }).__zvInstall) return;
  (window as unknown as { __zvInstall?: boolean }).__zvInstall = true;
  installed = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  window.addEventListener("beforeinstallprompt", (e) => {
    // Our own button offers it (Settings → Apps), not the browser's banner.
    e.preventDefault();
    deferred = e as InstallPrompt;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    notify();
  });
}

export function installState(): "available" | "installed" | "unavailable" {
  if (installed) return "installed";
  return deferred ? "available" : "unavailable";
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Shows the browser's install dialog; true when the person installed. */
export async function promptInstall(): Promise<boolean> {
  const p = deferred;
  if (!p) return false;
  deferred = null;
  await p.prompt();
  const choice = await p.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  notify();
  return choice.outcome === "accepted";
}
