// zvena's sections in the order every sidebar lists them: one workspace,
// the same way between its parts everywhere. Design is the Penpot fork on
// its own host; /design here syncs the workspace's team and sends people there.
// Mail is personal (the person's own mailboxes), the same in every workspace.

export type ProductId = "home" | "docs" | "projects" | "calendar" | "mail" | "design" | "templates" | "team";

export const PRODUCTS: readonly ProductId[] = ["home", "docs", "projects", "calendar", "mail", "design", "templates", "team"];

export function productHref(id: ProductId, ws?: string | null): string {
  const q = ws ? `?ws=${encodeURIComponent(ws)}` : "";
  switch (id) {
    case "home":
      return `/home${q}`;
    case "docs":
      return `/docs${q}`;
    case "projects":
      return `/projects${q}`;
    case "calendar":
      return `/calendar${q}`;
    case "mail":
      return `/mail${q}`;
    case "design":
      return `/design${q}`;
    case "templates":
      return `/templates${q}`;
    case "team":
      return `/team${q}`;
  }
}
