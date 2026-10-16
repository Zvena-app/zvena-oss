"use client";

// Notion's Place property editor: search an address or a place name (on
// Enter — the geocoder must not be asked as you type), or use the current
// location; a small map shows the chosen place, and a click on it moves the
// pin there. Lookups go through our server (/api/maps/*, lib/maps.ts).

import { useState } from "react";
import { ExternalLink, LocateFixed, MapPin, Search, Trash2 } from "lucide-react";
import { useNotes } from "../context";
import { Popover } from "../ui";
import { SlippyMap } from "./map";
import { osmLink } from "@/lib/notes/geo";
import { isPlaceValue, type PlaceValue, type PropValue } from "@/lib/notes/types";

type Status = "idle" | "busy" | "none" | "error" | "locating" | "denied";

async function lookup(url: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) return { ok: false };
    return { ok: true, value: await r.json() };
  } catch {
    return { ok: false };
  }
}

export function PlaceEditor({ value, anchor, onClose, onValue }: { value: PropValue; anchor: HTMLElement | null; onClose: () => void; onValue: (v: PlaceValue | null) => void }) {
  const { t, locale } = useNotes();
  const place = isPlaceValue(value) ? value : null;
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PlaceValue[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [name, setName] = useState(place?.name ?? "");

  const search = async () => {
    const query = q.trim();
    if (query.length < 2) return;
    setStatus("busy");
    const r = await lookup(`/api/maps/search?q=${encodeURIComponent(query)}&lang=${locale}`);
    const list = r.ok ? ((r.value as { results?: PlaceValue[] }).results ?? []) : [];
    setResults(list);
    setStatus(!r.ok ? "error" : list.length ? "idle" : "none");
  };
  const pick = (p: PlaceValue) => {
    onValue(p);
    onClose();
  };
  const named = async (lat: number, lng: number): Promise<PlaceValue> => {
    const r = await lookup(`/api/maps/reverse?lat=${lat}&lng=${lng}&lang=${locale}`);
    const found = r.ok ? (r.value as { place?: PlaceValue | null }).place : null;
    return found ?? { name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
  };
  const here = () => {
    if (!("geolocation" in navigator)) return setStatus("denied");
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      async (pos) => pick(await named(Math.round(pos.coords.latitude * 1e6) / 1e6, Math.round(pos.coords.longitude * 1e6) / 1e6)),
      () => setStatus("denied"),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }
    );
  };
  const note: Partial<Record<Status, string>> = {
    busy: "…",
    none: t("place.none"),
    error: t("place.unavailable"),
    locating: t("place.locating"),
    denied: t("place.denied"),
  };

  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="nt-place-editor">
        <div className="nt-menu-input-wrap nt-place-search">
          <Search />
          <input
            className="nt-input"
            autoFocus
            value={q}
            placeholder={t("place.search")}
            onChange={(e) => {
              setQ(e.target.value);
              if (status === "none" || status === "error") setStatus("idle");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void search();
              }
            }}
          />
        </div>
        {results.length > 0 ? (
          <div className="nt-menu-section" role="listbox">
            {results.map((p, i) => (
              <button type="button" key={`${p.lat},${p.lng},${i}`} role="option" aria-selected={false} className="nt-mi nt-btn-reset nt-place-result" onClick={() => pick(p)}>
                <span className="nt-mi-icon">
                  <MapPin />
                </span>
                <span className="nt-mi-label">
                  <span className="nt-place-name">{p.name}</span>
                  {p.address && p.address !== p.name && <span className="nt-place-address">{p.address}</span>}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="nt-place-hint">{note[status] ?? t("place.searchHint")}</div>
        )}
        <div className="nt-menu-section">
          <button type="button" className="nt-mi nt-btn-reset" onClick={here}>
            <span className="nt-mi-icon">
              <LocateFixed />
            </span>
            <span className="nt-mi-label">{t("place.current")}</span>
          </button>
        </div>
        {place && (
          <>
            <div className="nt-place-map">
              <SlippyMap
                pins={[{ id: "place", lat: place.lat, lng: place.lng, label: place.name }]}
                height={150}
                compact
                start={{ center: { lat: place.lat, lng: place.lng }, zoom: 15 }}
                labels={{ zoomIn: t("map.zoomIn"), zoomOut: t("map.zoomOut"), fit: t("map.fit"), attribution: t("map.attribution"), unavailable: t("map.unavailable"), cluster: (n) => t("map.cluster", { n }) }}
                onMapClick={async (at) => {
                  const lat = Math.round(at.lat * 1e6) / 1e6;
                  const lng = Math.round(at.lng * 1e6) / 1e6;
                  const found = await named(lat, lng);
                  onValue({ ...place, lat, lng, ...(found.address ? { address: found.address } : {}) });
                }}
              />
            </div>
            <div className="nt-place-current">
              <label className="nt-place-label" htmlFor="nt-place-name">
                {t("place.name")}
              </label>
              <input
                id="nt-place-name"
                className="nt-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name.trim() !== place.name && onValue({ ...place, name: name.trim().slice(0, 300) })}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
              {place.address && <div className="nt-place-address">{place.address}</div>}
            </div>
            <div className="nt-menu-section">
              <a className="nt-mi nt-btn-reset" href={osmLink(place)} target="_blank" rel="noopener noreferrer">
                <span className="nt-mi-icon">
                  <ExternalLink />
                </span>
                <span className="nt-mi-label">{t("place.openMap")}</span>
              </a>
              <button
                type="button"
                className="nt-mi nt-btn-reset"
                data-danger="true"
                onClick={() => {
                  onValue(null);
                  onClose();
                }}
              >
                <span className="nt-mi-icon">
                  <Trash2 />
                </span>
                <span className="nt-mi-label">{t("place.remove")}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </Popover>
  );
}
