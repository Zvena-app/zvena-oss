// What /docs shows before the workspace has loaded: the sidebar and an
// empty page in the real layout (Notion's), rendered on the server, so the
// first paint has the workspace, the menu and the user instead of a blank
// screen. Kept free of the editor, stores and the Documents dictionary: the
// server passes the labels. (The sidebar width and a closed sidebar are
// restored before paint by the root layout's script.)
import "./shell.css";
import { BrandMarkIcon } from "@/components/brand/BrandLogo";
import { PRODUCTS, type ProductId } from "@/lib/products";

export interface ShellLabels {
  notes: string;
  newPage: string;
  search: string;
  home: string;
  templates: string;
  /** zvena's sections, as the sidebar lists them (lib/products.ts). */
  apps: Record<ProductId, string>;
  pages: string;
  guest: string;
  sync: string;
  /** The sidebar's bottom group (Notion's Settings / Trash / Help); optional for older callers. */
  settings?: string;
  trash?: string;
  help?: string;
  appsTitle?: string;
}

export interface ShellUser {
  name: string;
  picture?: string;
  ws?: { name: string };
}

// The sidebar's stored width and closed state, before the first paint
// (the workspace reads the same keys). Run by the root layout (CSP nonce).
export const SHELL_RESTORE = `try{var d=document.documentElement,w=Number(localStorage.getItem("nt-sidebar-w"));if(w>=200&&w<=480)d.style.setProperty("--nt-shell-w",w+"px");if(localStorage.getItem("nt-sidebar-collapsed")==="1")d.setAttribute("data-nt-side-closed","1")}catch(e){}`;

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// The sidebar's lucide icons (search, house, layout-template, settings, trash-2, circle-help, pen-tool, users, square-pen, chevron-down, menu).
const ICONS = {
  search: "m21 21-4.34-4.34M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  home: "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  templates: "M4 3h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 14h4a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM14 14h6M14 17.5h6M14 21h6",
  settings: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  trash: "M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01",
  // The sections' lucide icons (file-text, list-todo, pen-tool, layout-template, users).
  docs: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8",
  projects: "M13 5h8M13 12h8M13 19h8M3 17l2 2 4-4M3 7l2 2 4-4",
  design: "M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414zM18 13l-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18M2.3 2.3l7.286 7.286",
  team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  newPage: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
  chev: "m6 9 6 6 6-6",
  menu: "M4 6h16M4 12h16M4 18h16",
};

export function NotesShell({ user, labels }: { user: ShellUser | null; labels: ShellLabels }) {
  const wsName = user?.ws?.name || (user ? user.name : labels.guest);
  const row = (icon: string, label: string) => (
    <div className="nt-shell-item" key={label}>
      <span className="nt-shell-icon">
        <Icon d={icon} />
      </span>
      <span className="nt-shell-label">{label}</span>
    </div>
  );
  return (
    <div className="nt-shell" aria-busy="true">
      <aside className="nt-shell-side">
        <div className="nt-shell-ws">
          <span className="nt-shell-ws-btn">
            <span className="nt-shell-avatar">{user ? wsName.trim().charAt(0).toUpperCase() : <BrandMarkIcon className="nt-shell-mark" />}</span>
            <span className="nt-shell-label nt-shell-ws-name">{wsName}</span>
            <span className="nt-shell-chev">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={ICONS.chev} />
              </svg>
            </span>
          </span>
          <span className="nt-shell-icon nt-shell-new" title={labels.newPage}>
            <Icon d={ICONS.newPage} />
          </span>
        </div>
        <div className="nt-shell-nav">
          {row(ICONS.search, labels.search)}
          {row(ICONS.home, labels.home)}
        </div>
        <div className="nt-shell-scroll">
          <div className="nt-shell-sec">{labels.pages}</div>
          {[62, 48, 70].map((w) => (
            <div className="nt-shell-row" key={w}>
              <span className="nt-shell-bar" style={{ width: `${w}%` }} />
            </div>
          ))}
          {/* The same rows as the workspace's sidebar: Design and Team, for people signed in. */}
          {user && (
            <>
              <div className="nt-shell-sec">{labels.appsTitle ?? "zvena"}</div>
              {PRODUCTS.filter((id) => id === "design" || id === "team").map((id) => row(ICONS[id], labels.apps[id]))}
            </>
          )}
          <div className="nt-shell-tools">
            {labels.settings && row(ICONS.settings, labels.settings)}
            {row(ICONS.templates, labels.templates)}
            {labels.trash && row(ICONS.trash, labels.trash)}
            {labels.help && row(ICONS.help, labels.help)}
          </div>
        </div>
      </aside>
      <main className="nt-shell-main">
        <div className="nt-shell-top">
          <span className="nt-shell-icon nt-shell-menu">
            <Icon d={ICONS.menu} />
          </span>
        </div>
        <div className="nt-shell-page">
          <span className="nt-shell-bar nt-shell-title" />
          {[92, 84, 88, 56].map((w) => (
            <span className="nt-shell-bar nt-shell-line" key={w} style={{ width: `${w}%` }} />
          ))}
        </div>
      </main>
    </div>
  );
}
