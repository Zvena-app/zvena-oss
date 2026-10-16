// Runs database automations on this device's own edits — for a guest's
// local-only workspace only. A signed-in workspace's automations run on the
// server (lib/notes/automations-server.ts) for every write, so they never
// run twice; this runner knows only "set" and "add a page" (notifications
// and webhooks need the server).

import { fires, resolveValues, type AutoAction } from "@/lib/notes/automations";
import { orderBetween } from "@/lib/notes/model";
import type { NotesStore } from "@/lib/notes/store";

/** "Set" and "add a page" in the local store (a guest's automations and buttons). */
export function runLocalActions(store: NotesStore, rowId: string, dbId: string, actions: readonly AutoAction[]): void {
  const db = store.get(dbId);
  const schema = db?.kind === "database" ? db.db : undefined;
  if (!schema) return;
  for (const act of actions) {
    if (act.type === "set") {
      const cur = store.get(rowId);
      const prop = schema.properties.find((p) => p.id === act.prop);
      if (!cur || !prop || prop.type === "relation") continue;
      const v = resolveValues({ [act.prop]: act.value }, schema)[act.prop] ?? null;
      if (prop.type === "title") store.update(cur.id, { title: typeof v === "string" ? v : "" });
      else store.update(cur.id, { props: { ...(cur.props ?? {}), [act.prop]: v } });
    } else if (act.type === "addPage") {
      const target = store.get(act.dbId);
      if (!target || target.kind !== "database" || target.trashedAt !== null) continue;
      const rows = store
        .all()
        .filter((n) => n.parentId === target.id && n.trashedAt === null && !n.template)
        .sort((x, y) => x.order - y.order);
      const tpl = act.templateId ? store.get(act.templateId) : undefined;
      const template = tpl?.template && tpl.parentId === target.id ? tpl : undefined;
      const props = { ...Object.fromEntries(Object.entries(template?.props ?? {}).filter(([k]) => target.db?.properties.find((p) => p.id === k)?.type !== "unique_id")), ...resolveValues(act.values, target.db) };
      store.create({
        kind: "page",
        parentId: target.id,
        title: act.title || template?.title || "",
        props,
        ...(template ? { icon: template.icon, cover: template.cover, content: structuredClone(template.content) } : {}),
        order: orderBetween(rows[rows.length - 1]?.order, undefined),
      });
    }
  }
}

export function runAutomations(store: NotesStore, onRun?: (name: string) => void): () => void {
  // Writes made by automations do not trigger automations (no chains, no loops).
  let running = false;
  return store.onLocalWrite((prev, next) => {
    if (running || !next.parentId) return;
    const db = store.get(next.parentId);
    const schema = db?.kind === "database" ? db.db : undefined;
    if (!schema?.automations?.length) return;
    // "Only if Jev agrees" needs the server (and an account): a local workspace skips those.
    const todo = schema.automations.filter((a) => !a.jev && fires(a, prev, next, schema));
    if (!todo.length) return;
    running = true;
    try {
      for (const a of todo) {
        runLocalActions(store, next.id, next.parentId, a.actions);
        onRun?.(a.name);
      }
    } finally {
      running = false;
    }
  });
}
