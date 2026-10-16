"use client";

// Notion's Map view and the map under the Place picker. Tiles come from our
// server (/api/maps/tile, lib/maps.ts) — the page never talks to a map
// provider. Pan by dragging, zoom with the buttons, a double click, a pinch,
// the keyboard, or the wheel once the map is in use (a page scrolls over a
// map it has not touched). Pins that crowd together become one numbered
// cluster; a pin opens the page's card; editors drag pins to move places.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MapPin, Minus, Plus, Maximize } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { CardProps, RowIcon } from "./views";
import { Popover } from "../ui";
import { NoteIcon } from "../NoteIcon";
import { propValue } from "@/lib/notes/db";
import { clampZoom, clusterPins, fitPins, fromScreen, toScreen, visibleTiles, type LatLng, type Pin } from "@/lib/notes/geo";
import { displayTitle } from "@/lib/notes/model";
import { isPlaceValue, type DbProperty, type PlaceValue } from "@/lib/notes/types";

/** Notion loads at most this many pins; the rest wait for a narrower filter. */
export const MAP_PIN_LIMIT = 100;

export interface MapPinData extends Pin {
  icon?: string;
  label: string;
}

interface SlippyMapProps {
  pins: readonly MapPinData[];
  height: number;
  /** Shown first (else the view fits every pin). */
  start?: { center: LatLng; zoom: number };
  labels: { zoomIn: string; zoomOut: string; fit: string; attribution: string; unavailable: string; cluster: (n: number) => string };
  onPin?: (id: string, el: HTMLElement) => void;
  /** Editors: a pin dragged to another point. */
  onMove?: (id: string, at: LatLng) => void;
  /** A click on the map itself (not on a pin). */
  onMapClick?: (at: LatLng) => void;
  compact?: boolean;
}

export function SlippyMap({ pins, height, start, labels, onPin, onMove, onMapClick, compact }: SlippyMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: height });
  const [view, setView] = useState<{ center: LatLng; zoom: number } | null>(start ?? null);
  const [active, setActive] = useState(false);
  const [broken, setBroken] = useState(0);
  const [dragPin, setDragPin] = useState<{ id: string; at: LatLng } | null>(null);
  const pan = useRef<{ x: number; y: number; center: LatLng; moved: boolean } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const lastWheel = useRef(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The first view shows every pin (once the box has a size).
  const fitted = useMemo(() => (size.w ? fitPins(pins, size.w, size.h) : null), [pins, size.w, size.h]);
  const cur = view ?? fitted ?? { center: { lat: 30, lng: 10 }, zoom: 2 };
  const zoomAt = (to: number, at?: { x: number; y: number }) => {
    const z = clampZoom(to);
    if (z === cur.zoom) return;
    if (!at) return setView({ center: cur.center, zoom: z });
    // The point under the cursor stays put.
    const p = fromScreen(at, cur.center, cur.zoom, size.w, size.h);
    const q = toScreen(p, cur.center, z, size.w, size.h);
    setView({ center: fromScreen({ x: size.w / 2 + (q.x - at.x), y: size.h / 2 + (q.y - at.y) }, cur.center, z, size.w, size.h), zoom: z });
  };

  // The wheel zooms only a map in use; otherwise the page scrolls as usual.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!active && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel.current < 180) return;
      lastWheel.current = now;
      const r = el.getBoundingClientRect();
      zoomAt(cur.zoom + (e.deltaY < 0 ? 1 : -1), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const tiles = size.w ? visibleTiles(cur.center, cur.zoom, size.w, size.h) : [];
  const shown = pins.map((p) => (dragPin?.id === p.id ? { ...p, ...dragPin.at } : p));
  const clusters = clusterPins(shown, cur.zoom, compact ? 36 : 44);
  const byId = new Map(shown.map((p) => [p.id, p]));

  return (
    <div
      ref={box}
      className="nt-map"
      data-active={active || undefined}
      style={{ height }}
      tabIndex={0}
      role="application"
      onBlur={() => setActive(false)}
      onKeyDown={(e) => {
        const step = 96;
        const move = (dx: number, dy: number) => setView({ center: fromScreen({ x: size.w / 2 + dx, y: size.h / 2 + dy }, cur.center, cur.zoom, size.w, size.h), zoom: cur.zoom });
        if (e.key === "ArrowLeft") move(-step, 0);
        else if (e.key === "ArrowRight") move(step, 0);
        else if (e.key === "ArrowUp") move(0, -step);
        else if (e.key === "ArrowDown") move(0, step);
        else if (e.key === "+" || e.key === "=") zoomAt(cur.zoom + 1);
        else if (e.key === "-") zoomAt(cur.zoom - 1);
        else return;
        e.preventDefault();
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".nt-map-pin, .nt-map-ctrl, .nt-map-attr")) return;
        setActive(true);
        touches.current.set(e.pointerId, local(e));
        if (touches.current.size === 2) {
          const [a, b] = [...touches.current.values()];
          pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
          pan.current = null;
          return;
        }
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        pan.current = { ...local(e), center: cur.center, moved: false };
      }}
      onPointerMove={(e) => {
        if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, local(e));
        if (pinch.current && touches.current.size === 2) {
          const [a, b] = [...touches.current.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d / pinch.current > 1.6 || d / pinch.current < 0.62) {
            zoomAt(cur.zoom + (d > pinch.current ? 1 : -1), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            pinch.current = d;
          }
          return;
        }
        const p = pan.current;
        if (!p) return;
        const at = local(e);
        const dx = at.x - p.x;
        const dy = at.y - p.y;
        if (!p.moved && Math.hypot(dx, dy) < 3) return;
        p.moved = true;
        setView({ center: fromScreen({ x: size.w / 2 - dx, y: size.h / 2 - dy }, p.center, cur.zoom, size.w, size.h), zoom: cur.zoom });
      }}
      onPointerUp={(e) => {
        touches.current.delete(e.pointerId);
        if (touches.current.size < 2) pinch.current = null;
        const p = pan.current;
        pan.current = null;
        if (p && !p.moved && onMapClick) onMapClick(fromScreen(local(e), cur.center, cur.zoom, size.w, size.h));
      }}
      onPointerCancel={(e) => {
        touches.current.delete(e.pointerId);
        pan.current = null;
        pinch.current = null;
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".nt-map-pin, .nt-map-ctrl")) return;
        zoomAt(cur.zoom + 1, local(e));
      }}
    >
      <div className="nt-map-tiles" aria-hidden>
        {tiles.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={t.key}
            src={`/api/maps/tile/${t.z}/${t.x}/${t.y}.png`}
            alt=""
            draggable={false}
            style={{ left: t.left, top: t.top }}
            onError={() => setBroken((n) => n + 1)}
            onLoad={() => broken && setBroken(0)}
          />
        ))}
      </div>
      {clusters.map((c) => {
        const s = toScreen(c, cur.center, cur.zoom, size.w, size.h);
        if (s.x < -40 || s.y < -40 || s.x > size.w + 40 || s.y > size.h + 60) return null;
        const style: CSSProperties = { left: s.x, top: s.y };
        if (c.ids.length > 1) {
          return (
            <button
              type="button"
              key={`c-${c.ids[0]}`}
              className="nt-map-pin nt-map-cluster nt-btn-reset"
              style={style}
              aria-label={labels.cluster(c.ids.length)}
              title={labels.cluster(c.ids.length)}
              onClick={() => setView({ center: { lat: c.lat, lng: c.lng }, zoom: clampZoom(cur.zoom + 2) })}
            >
              {c.ids.length}
            </button>
          );
        }
        const pin = byId.get(c.ids[0]) as MapPinData;
        return (
          <PinButton
            key={pin.id}
            pin={pin}
            style={style}
            draggable={Boolean(onMove)}
            onClick={(el) => onPin?.(pin.id, el)}
            onDrag={(pt) => setDragPin({ id: pin.id, at: fromScreen(local(pt), cur.center, cur.zoom, size.w, size.h) })}
            onDrop={(pt) => {
              setDragPin(null);
              onMove?.(pin.id, fromScreen(local(pt), cur.center, cur.zoom, size.w, size.h));
            }}
          />
        );
      })}
      <div className="nt-map-ctrl" role="group">
        <button type="button" className="nt-btn-reset" aria-label={labels.zoomIn} title={labels.zoomIn} onClick={() => zoomAt(cur.zoom + 1)}>
          <Plus />
        </button>
        <button type="button" className="nt-btn-reset" aria-label={labels.zoomOut} title={labels.zoomOut} onClick={() => zoomAt(cur.zoom - 1)}>
          <Minus />
        </button>
        {pins.length > 0 && (
          <button type="button" className="nt-btn-reset" aria-label={labels.fit} title={labels.fit} onClick={() => setView(fitPins(pins, size.w, size.h))}>
            <Maximize />
          </button>
        )}
      </div>
      {broken > 3 && <div className="nt-map-note">{labels.unavailable}</div>}
      <a className="nt-map-attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
        {labels.attribution}
      </a>
    </div>
  );
}

/** A pin: the page's icon in Notion's round marker; editors may drag it. */
function PinButton({ pin, style, draggable, onClick, onDrag, onDrop }: { pin: MapPinData; style: CSSProperties; draggable: boolean; onClick: (el: HTMLElement) => void; onDrag: (pt: { clientX: number; clientY: number }) => void; onDrop: (pt: { clientX: number; clientY: number }) => void }) {
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  return (
    <button
      type="button"
      className="nt-map-pin nt-btn-reset"
      style={style}
      aria-label={pin.label}
      title={pin.label}
      onPointerDown={(e) => {
        if (!draggable) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
        d.moved = true;
        onDrag(e);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) onDrop(e);
        else onClick(e.currentTarget);
      }}
      onClick={(e) => {
        // A draggable pin opens on pointer up; the keyboard (detail 0) and plain pins open here.
        if (!draggable || e.detail === 0) onClick(e.currentTarget);
      }}
    >
      <span className="nt-map-pin-head">{pin.icon ? <NoteIcon icon={pin.icon} /> : <MapPin />}</span>
    </button>
  );
}

/** The view's Place property: the one it is set to, else the first. */
export function mapProp(ctl: DbCtl): DbProperty | undefined {
  const props = ctl.schema?.properties ?? [];
  return props.find((p) => p.id === ctl.view?.map?.prop && p.type === "place") ?? props.find((p) => p.type === "place");
}

export function MapView({ ctl, compact }: { ctl: DbCtl; compact?: boolean }) {
  const { t } = ctl.api;
  const prop = mapProp(ctl);
  const [card, setCard] = useState<{ id: string; el: HTMLElement } | null>(null);
  const located = useMemo(() => (prop ? ctl.rows.filter((r) => isPlaceValue(propValue(r, prop))) : []), [ctl.rows, prop]);
  const pins = useMemo<MapPinData[]>(
    () =>
      located.slice(0, MAP_PIN_LIMIT).map((r) => {
        const v = propValue(r, prop as DbProperty) as PlaceValue;
        return { id: r.id, lat: v.lat, lng: v.lng, label: `${displayTitle(r, t("page.untitled"))} — ${v.name}`, ...(r.icon && !ctl.view?.hideIcons ? { icon: r.icon } : {}) };
      }),
    [located, prop, t, ctl.view?.hideIcons]
  );
  const height = compact ? 280 : (ctl.view?.map?.height ?? 480);
  if (!prop) {
    return (
      <div className="nt-map-empty">
        <MapPin />
        <b>{t("map.noPlace")}</b>
        <span>{t("map.noPlaceHint")}</span>
        {!ctl.readOnly && (
          <button
            type="button"
            className="nt-btn nt-btn-primary nt-btn-reset"
            onClick={() => {
              const p = ctl.addProp("place");
              ctl.updateView({ map: { ...(ctl.view?.map ?? {}), prop: p.id } });
            }}
          >
            {t("map.addPlace")}
          </button>
        )}
      </div>
    );
  }
  const row = card ? ctl.rows.find((r) => r.id === card.id) : undefined;
  const move = async (id: string, at: LatLng) => {
    const r = ctl.allRows.find((x) => x.id === id);
    const old = r ? propValue(r, prop) : null;
    if (!r || !isPlaceValue(old)) return;
    const lat = Math.round(at.lat * 1e6) / 1e6;
    const lng = Math.round(at.lng * 1e6) / 1e6;
    ctl.setValue(r, prop, { ...old, lat, lng });
    // The moved pin gets the address of where it now stands (its name stays).
    try {
      const res = await fetch(`/api/maps/reverse?lat=${lat}&lng=${lng}&lang=${ctl.api.locale}`, { credentials: "same-origin" });
      const j = (await res.json()) as { place?: PlaceValue | null };
      const now = ctl.api.store.get(id);
      const cur = now?.props?.[prop.id];
      if (j.place?.address && now && isPlaceValue(cur) && cur.lat === lat && cur.lng === lng) ctl.setValue(now, prop, { ...cur, address: j.place.address });
    } catch {
      // Offline: the coordinates are saved, the address follows next time.
    }
  };
  return (
    <div className="nt-map-view" data-compact={compact || undefined}>
      {located.length === 0 && <div className="nt-map-banner">{t("map.empty")}</div>}
      {located.length > MAP_PIN_LIMIT && <div className="nt-map-banner">{t("map.limit", { n: MAP_PIN_LIMIT, total: located.length })}</div>}
      <SlippyMap
        key={`${prop.id}:${height}`}
        pins={pins}
        height={height}
        compact={compact}
        labels={{ zoomIn: t("map.zoomIn"), zoomOut: t("map.zoomOut"), fit: t("map.fit"), attribution: t("map.attribution"), unavailable: t("map.unavailable"), cluster: (n) => t("map.cluster", { n }) }}
        onPin={(id, el) => setCard({ id, el })}
        onMove={ctl.readOnly ? undefined : (id, at) => void move(id, at)}
      />
      {card && row && (
        <Popover anchor={card.el} placement="top-start" offset={8} onClose={() => setCard(null)}>
          <div className="nt-card nt-map-card" role="button" tabIndex={0} onClick={() => (setCard(null), ctl.openRow(row.id))} onKeyDown={(e) => e.key === "Enter" && (setCard(null), ctl.openRow(row.id))}>
            <div className="nt-card-body">
              <div className="nt-card-title">
                {!ctl.view?.hideIcons && <RowIcon row={row} />}
                <span>{displayTitle(row, t("page.untitled"))}</span>
              </div>
              <CardProps ctl={ctl} row={row} />
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}
