import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTile, parseTile, reversePlace, searchPlaces, setMapsFetch, tileUrl, tilesTemplate, toPlace } from "@/lib/maps";
import { clusterPins, fitPins, fromScreen, project, toScreen, unproject, visibleTiles } from "@/lib/notes/geo";
import { blankNote, dashScope, defaultView, sanitizeNote } from "@/lib/notes/model";
import { copyView, newWidgetView, withPinned, withPropInSection, withWidgets, withoutView } from "@/lib/notes/dbviews";
import { applyView, valueText, withView } from "@/lib/notes/db";
import type { DbSchema, Note, PageLayout, PlaceValue } from "@/lib/notes/types";

test("tiles: addresses are checked, the upstream template falls back to OSM", () => {
  assert.deepEqual(parseTile("3", "5", "2.png"), { z: 3, x: 5, y: 2 });
  assert.equal(parseTile("3", "8", "2.png"), null);
  assert.equal(parseTile("20", "0", "0"), null);
  assert.equal(parseTile("2", "-1", "0"), null);
  assert.equal(parseTile("2", "1", "../../etc"), null);
  assert.equal(tilesTemplate("javascript:alert(1)"), "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(tilesTemplate("https://tiles.example.com/{z}/{x}/{y}.png"), "https://tiles.example.com/{z}/{x}/{y}.png");
  assert.equal(tileUrl({ z: 4, x: 3, y: 9 }, "https://t.example/{z}/{x}/{y}.png"), "https://t.example/4/3/9.png");
});

test("tiles: fetched once, then served from the disk cache; an old copy outlives an upstream failure", async () => {
  let calls = 0;
  let up = true;
  setMapsFetch(async (url) => {
    calls += 1;
    assert.match(url, /^https:\/\/tile\.openstreetmap\.org\/5\/10\/12\.png$/);
    return up ? new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }) : new Response("no", { status: 503 });
  });
  try {
    const t = { z: 5, x: 10, y: 12 };
    const [a, b] = await Promise.all([getTile(t), getTile(t)]);
    assert.deepEqual([...(a ?? [])], [137, 80, 78, 71]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    assert.ok(await getTile(t));
    assert.equal(calls, 1);
    // Past the cache's lifetime the upstream is asked again; failing, the old copy stays in service.
    up = false;
    const later = Date.now() + 31 * 86_400_000;
    assert.deepEqual([...((await getTile(t, later)) ?? [])], [137, 80, 78, 71]);
    assert.equal(calls, 2);
    assert.equal(await getTile({ z: 5, x: 11, y: 12 }), null);
  } finally {
    setMapsFetch(null);
  }
});

test("addresses: Nominatim answers become places, cached, at most one request a second", async () => {
  const asked: string[] = [];
  setMapsFetch(async (url) => {
    asked.push(url);
    if (url.includes("/reverse")) return Response.json({ name: "", display_name: "Unter den Linden, 1, Berlin", lat: "52.5163", lon: "13.3777" });
    return Response.json([{ name: "Berlin", display_name: "Berlin, Deutschland", lat: "52.5170", lon: "13.3889" }, { lat: "x", lon: "1" }]);
  });
  try {
    const started = Date.now();
    const first = await searchPlaces("  Berlin ", "ru");
    assert.deepEqual(first, [{ name: "Berlin", address: "Berlin, Deutschland", lat: 52.517, lng: 13.3889 }]);
    assert.deepEqual(await searchPlaces("berlin", "ru"), first);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /search\?format=jsonv2&limit=6&q=Berlin&accept-language=ru$/);
    const here = await reversePlace(52.51627, 13.37769, "ru");
    assert.equal(here?.name, "Unter den Linden");
    assert.equal(here?.lat, 52.51627);
    // The second upstream request waited for its slot.
    assert.ok(Date.now() - started >= 900, `waited ${Date.now() - started} ms`);
    assert.equal(toPlace({ lat: "100", lon: "0" }), null);
  } finally {
    setMapsFetch(null);
  }
});

test("map math: projection round-trips, tiles cover the view, crowded pins cluster", () => {
  const p = { lat: 55.75, lng: 37.62 };
  const back = unproject(project(p, 12), 12);
  assert.ok(Math.abs(back.lat - p.lat) < 1e-9 && Math.abs(back.lng - p.lng) < 1e-9);
  const s = toScreen(p, p, 10, 800, 400);
  assert.deepEqual(s, { x: 400, y: 200 });
  const there = fromScreen({ x: 400, y: 200 }, p, 10, 800, 400);
  assert.ok(Math.abs(there.lat - p.lat) < 1e-9);
  const tiles = visibleTiles(p, 3, 512, 256);
  assert.ok(tiles.length >= 2 && tiles.every((t) => t.z === 3 && t.y >= 0 && t.y < 8 && t.x >= 0 && t.x < 8));
  const near = [
    { id: "a", lat: 55.75, lng: 37.62 },
    { id: "b", lat: 55.7501, lng: 37.6201 },
    { id: "c", lat: 59.93, lng: 30.31 },
  ];
  assert.equal(clusterPins(near, 5).length, 2);
  assert.equal(clusterPins(near, 18).length, 3);
  const fit = fitPins(near, 800, 480);
  assert.ok(fit.zoom >= 4 && fit.zoom <= 7, `zoom ${fit.zoom}`);
  assert.deepEqual(fitPins([], 800, 480).zoom, 2);
});

function dbNote(schema: DbSchema): Note {
  const n = blankNote({ kind: "database", title: "Tasks" });
  n.db = schema;
  return n;
}

test("dashboards: widget views live with their widgets, never as tabs, and go with the dashboard", () => {
  const schema: DbSchema = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "where", name: "Place", type: "place" }], views: [defaultView("table", "Table")] };
  const dash = defaultView("dashboard", "Dashboard", schema);
  schema.views.push(dash);
  const chart = newWidgetView("chart", "Chart", schema, dash.id);
  const map = newWidgetView("map", "Map", schema, dash.id);
  let s = withWidgets(schema, dash.id, () => [{ id: "w1", viewId: chart.id, width: 2 }, { id: "w2", viewId: map.id, width: 4 }], { add: [chart, map] });
  assert.equal(map.map?.prop, "where");
  assert.equal(chart.scope, dashScope(dash.id));
  // A stray widget view, a nested dashboard and a widget pointing nowhere are dropped by the sanitizer.
  const stray = { ...defaultView("table", "Lost"), scope: dashScope("gone00") };
  const nested = { ...defaultView("dashboard", "Nested"), scope: dashScope(dash.id) };
  s = withWidgets({ ...s, views: [...s.views, stray, nested] }, dash.id, (w) => [...w, { id: "w3", viewId: nested.id, width: 1 }, { id: "w4", viewId: "nothere", width: 1 }]);
  const clean = sanitizeNote(dbNote(s))?.db as DbSchema;
  assert.deepEqual(clean.views.map((v) => v.name).sort(), ["Chart", "Dashboard", "Map", "Table"]);
  assert.deepEqual(clean.views.find((v) => v.id === dash.id)?.dashboard?.widgets.map((w) => w.id), ["w1", "w2"]);
  // Tabs show only the database's own views.
  assert.deepEqual(clean.views.filter((v) => !v.scope).map((v) => v.name).sort(), ["Dashboard", "Table"]);
  // A widget's view is edited alone; filters apply to it only.
  const s2 = withView(clean, chart.id, { filters: [{ id: "f", prop: "title", op: "contains", value: "x" }] });
  assert.equal(s2.views.find((v) => v.id === chart.id)?.filters.length, 1);
  assert.equal(s2.views.find((v) => v.id === map.id)?.filters.length, 0);
  // Copying the dashboard copies its widgets; deleting it deletes them.
  const copies = copyView(clean.views, clean.views.find((v) => v.id === dash.id)!, "Dashboard 2");
  assert.equal(copies.length, 3);
  assert.deepEqual(copies[0].dashboard?.widgets.map((w) => copies.some((c) => c.id === w.viewId && c.scope === dashScope(copies[0].id))), [true, true]);
  assert.deepEqual(withoutView(clean.views, dash.id).map((v) => v.name), ["Table"]);
});

test("places: filters match the name or the address; rows sort and search by the name", () => {
  const schema: DbSchema = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "where", name: "Place", type: "place" }], views: [] };
  const place = (name: string, address: string): PlaceValue => ({ name, address, lat: 52.5, lng: 13.4 });
  const rows = [
    blankNote({ kind: "page", title: "Office", props: { where: place("Офис", "Unter den Linden 1, Berlin") } }),
    blankNote({ kind: "page", title: "Home", props: { where: place("Дом", "Rue de Rivoli 10, Paris") } }),
    blankNote({ kind: "page", title: "Nowhere", props: {} }),
  ];
  const v = (op: "contains" | "not_contains" | "empty", value = "") => ({ ...defaultView("table", "T"), filters: [{ id: "f", prop: "where", op, value }] });
  assert.deepEqual(applyView(rows, v("contains", "berlin"), schema).map((r) => r.title), ["Office"]);
  assert.deepEqual(applyView(rows, v("not_contains", "berlin"), schema).map((r) => r.title), ["Home", "Nowhere"]);
  assert.deepEqual(applyView(rows, v("empty"), schema).map((r) => r.title), ["Nowhere"]);
  assert.equal(valueText(schema.properties[1], rows[0].props?.where ?? null), "Офис");
  const clean = sanitizeNote(rows[0]);
  assert.deepEqual(clean?.props?.where, place("Офис", "Unter den Linden 1, Berlin"));
  assert.equal(sanitizeNote({ ...rows[0], props: { where: { name: "x", lat: 200, lng: 0 } } })?.props?.where, undefined);
});

test("page layouts: up to four pinned properties, each property in one group, unknown ones dropped", () => {
  const schema: DbSchema = {
    properties: ["title", "a", "b", "c", "d", "e"].map((id) => ({ id, name: id, type: id === "title" ? ("title" as const) : ("text" as const) })),
    views: [defaultView("table", "T")],
  };
  let layout: PageLayout = { sections: [{ id: "s1", name: "Details", props: ["a", "b"] }] };
  for (const p of ["a", "c", "d", "e", "b"]) layout = withPinned(layout, p, true);
  assert.deepEqual(layout.header, ["a", "c", "d", "e"]);
  assert.deepEqual(layout.sections?.[0].props, ["b"]);
  layout = withPropInSection(withPinned(layout, "a", false), "a", "s1");
  assert.deepEqual(layout.sections?.[0].props, ["b", "a"]);
  const dirty = { ...schema, layout: { header: ["title", "a", "zz", "c", "d", "e", "b"], panel: "side", sections: [{ id: "s1", name: "One", props: ["a", "zz", "a"] }, { id: "s2", name: "Two", props: ["a", "b"], hideEmpty: true }, { id: "s1", name: "dup", props: [] }] } };
  const clean = sanitizeNote(dbNote(dirty as unknown as DbSchema))?.db?.layout;
  assert.deepEqual(clean, { header: ["a", "c", "d", "e"], panel: "side", sections: [{ id: "s1", name: "One", props: ["a"] }, { id: "s2", name: "Two", props: ["b"], hideEmpty: true }] });
});
