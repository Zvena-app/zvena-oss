// zvena Documents: pure edits of a database's views and page layout —
// dashboards and their widget views (scope "dash:<dashboard id>"), copying
// and deleting views with what belongs to them, and the page layout's
// pinned properties and groups. No DOM; shared by the UI and the tests.

import { dashScope, defaultView, shortId } from "./model";
import type { DashboardWidget, DbSchema, DbView, PageLayout, ViewType } from "./types";

/** Notion pins at most this many properties under a page title. */
export const MAX_PINNED = 4;

/** A view's copy with a new id; a dashboard's widgets are copied with it. */
export function copyView(views: readonly DbView[], view: DbView, name: string): DbView[] {
  const copy: DbView = { ...structuredClone(view), id: shortId(), name };
  // A shared form's link stays with the original (closing it from the copy would close that one).
  if (copy.form?.shareId) delete copy.form.shareId;
  if (view.type !== "dashboard") return [copy];
  const pairs = views.filter((v) => v.scope === dashScope(view.id)).map((v) => ({ from: v.id, to: { ...structuredClone(v), id: shortId(), scope: dashScope(copy.id) } }));
  copy.dashboard = {
    widgets: (view.dashboard?.widgets ?? []).flatMap((w) => {
      const p = pairs.find((x) => x.from === w.viewId);
      return p ? [{ ...w, id: shortId(), viewId: p.to.id }] : [];
    }),
  };
  return [copy, ...pairs.map((p) => p.to)];
}

/** The views without one of them (and, for a dashboard, without its widget views). */
export function withoutView(views: readonly DbView[], viewId: string): DbView[] {
  return views.filter((v) => v.id !== viewId && v.scope !== dashScope(viewId));
}

/** A dashboard's widgets with `fn` applied, widget views added or removed. */
export function withWidgets(schema: DbSchema, dashId: string, fn: (w: DashboardWidget[]) => DashboardWidget[], opts: { add?: DbView[]; drop?: string[] } = {}): DbSchema {
  const views = [...schema.views.filter((v) => !opts.drop?.includes(v.id)), ...(opts.add ?? [])];
  return { ...schema, views: views.map((v) => (v.id === dashId ? { ...v, dashboard: { widgets: fn(v.dashboard?.widgets ?? []) } } : v)) };
}

/** A new widget's view: the layout's defaults, scoped to the dashboard. */
export function newWidgetView(type: ViewType, name: string, schema: DbSchema, dashId: string): DbView {
  const v = defaultView(type, name, schema);
  v.scope = dashScope(dashId);
  return v;
}

/** The page layout with a property moved into a group (or out of all of them: null). */
export function withPropInSection(layout: PageLayout, propId: string, sectionId: string | null): PageLayout {
  const sections = (layout.sections ?? []).map((s) => ({ ...s, props: s.props.filter((p) => p !== propId) }));
  const to = sections.find((s) => s.id === sectionId);
  if (to) to.props = [...to.props, propId];
  return { ...layout, sections };
}

/** Pins or unpins a property under the title (at most four; a pinned property leaves its group). */
export function withPinned(layout: PageLayout, propId: string, on: boolean): PageLayout {
  const header = layout.header ?? [];
  if (!on) return { ...layout, header: header.filter((p) => p !== propId) };
  if (header.includes(propId) || header.length >= MAX_PINNED) return layout;
  return { ...withPropInSection(layout, propId, null), header: [...header, propId] };
}
