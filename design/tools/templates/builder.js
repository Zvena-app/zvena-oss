// zvena: builds template layers in Design from the specs of convert.js.
// Runs as a plugin inside the Design editor (the `penpot` global of the
// plugin runtime); build.mjs loads it with the specs filled in. The builder
// is an earlier plugin's, without the assistant UI and photo search.

// ---------------------------------------------------------------- helpers

function hexOpacity(c) {
  return c && typeof c === "object" ? c : { c: "#000000", o: 1 };
}

function fillsOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    if (f.type === "solid") out.push({ fillColor: f.c, fillOpacity: f.o ?? 1 });
    else if (f.type === "linear") {
      out.push({
        fillColorGradient: {
          type: "linear",
          startX: f.sx, startY: f.sy, endX: f.ex, endY: f.ey, width: 1,
          stops: f.stops.map((s) => ({ color: s.c, opacity: s.o ?? 1, offset: s.p })),
        },
      });
    }
  }
  return out;
}

function strokesOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((s) => ({
    strokeColor: s.c, strokeOpacity: s.o ?? 1, strokeWidth: s.w, strokeAlignment: "inner",
    strokeStyle: s.style || "solid",
  }));
}

function shadowsOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((s) => ({
    style: s.inset ? "inner-shadow" : "drop-shadow",
    offsetX: s.x, offsetY: s.y, blur: s.blur, spread: s.spread, hidden: false,
    color: { color: s.c, opacity: s.o ?? 1 },
  }));
}

function applyRadius(shape, r) {
  if (!r) return;
  if (r.tl === r.tr && r.tr === r.br && r.br === r.bl) {
    if (r.tl) shape.borderRadius = r.tl;
  } else {
    shape.borderRadiusTopLeft = r.tl;
    shape.borderRadiusTopRight = r.tr;
    shape.borderRadiusBottomRight = r.br;
    shape.borderRadiusBottomLeft = r.bl;
  }
}

function applyVisual(shape, n) {
  try { if (n.fills) shape.fills = fillsOf(n.fills); } catch (e) { /* unsupported fill */ }
  try { if (n.strokes && n.strokes.length) shape.strokes = strokesOf(n.strokes); } catch (e) { /* ignore */ }
  try { if (n.shadows && n.shadows.length) shape.shadows = shadowsOf(n.shadows); } catch (e) { /* ignore */ }
  applyRadius(shape, n.radius);
  if (typeof n.opacity === "number" && n.opacity < 1) shape.opacity = n.opacity;
  if (n.blur) try { shape.blur = { value: n.blur, hidden: false }; } catch (e) { /* ignore */ }
  if (n.bgBlur) try { shape.backgroundBlur = { value: n.bgBlur, hidden: false }; } catch (e) { /* ignore */ }
}

const fontCache = new Map();
function findFont(family) {
  const key = (family || "").toLowerCase();
  if (fontCache.has(key)) return fontCache.get(key);
  let font = null;
  try {
    // exact name first: findByName matches substrings ("Inter" → "Inter Tight")
    font = penpot.fonts.all.find((f) => f.name.toLowerCase() === key) || penpot.fonts.findByName(family) || null;
  } catch (e) { font = null; }
  if (!font && key !== "source sans pro") font = findFont("Source Sans Pro");
  fontCache.set(key, font);
  return font;
}

function pickVariant(font, weight, style) {
  if (!font || !font.variants || !font.variants.length) return undefined;
  const w = String(weight || 400);
  const st = style === "italic" ? "italic" : "normal";
  let best = null;
  let bestScore = Infinity;
  for (const v of font.variants) {
    const vw = Number(v.fontWeight) || 400;
    const vs = v.fontStyle === "italic" ? "italic" : "normal";
    const score = Math.abs(vw - Number(w)) + (vs === st ? 0 : 1000);
    if (score < bestScore) { best = v; bestScore = score; }
  }
  return best || undefined;
}

function styleText(target, t, isRange) {
  const font = findFont(t.family);
  if (font) {
    const v = pickVariant(font, t.weight, t.style);
    try {
      if (isRange) font.applyToRange(target, v); else font.applyToText(target, v);
    } catch (e) { /* keep default font */ }
  }
  if (t.size) target.fontSize = String(t.size);
  if (t.lineHeight) target.lineHeight = String(t.lineHeight);
  if (typeof t.letterSpacing === "number") target.letterSpacing = String(t.letterSpacing);
  if (t.color) target.fills = [{ fillColor: t.color.c, fillOpacity: t.color.o ?? 1 }];
  if (t.decoration) target.textDecoration = t.decoration;
  if (!isRange && t.transform) target.textTransform = t.transform;
}

// ---------------------------------------------------------------- builder

function buildText(n) {
  const t = penpot.createText(n.text.chars || " ");
  if (!t) return null;
  t.name = n.name || n.text.chars.slice(0, 40);
  styleText(t, n.text, false);
  if (n.text.align) t.align = n.text.align;
  if (n.text.valign) t.verticalAlign = n.text.valign;
  for (const r of n.text.runs || []) {
    try { styleText(t.getRange(r.start, r.end), r, true); } catch (e) { /* skip run */ }
  }
  t.growType = n.text.grow === "auto-width" ? "auto-width" : "fixed";
  if (n.text.grow !== "auto-width") {
    t.resize(Math.max(1, n.w), Math.max(1, n.h));
    if (n.text.grow === "auto-height") t.growType = "auto-height";
  }
  return t;
}

function buildNode(n, parent, ox, oy) {
  let s = null;
  if (n.kind === "text") {
    s = buildText(n);
  } else if (n.kind === "svg") {
    try { s = penpot.createShapeFromSvg(n.svg); } catch (e) { s = null; }
    if (s) {
      s.name = n.name || "Icon";
      if (n.w > 0 && n.h > 0) s.resize(n.w, n.h);
    }
  } else if (n.kind === "image" || n.kind === "rect") {
    s = penpot.createRectangle();
    s.name = n.name || (n.kind === "image" ? "Image" : "Rectangle");
    s.resize(Math.max(1, n.w), Math.max(1, n.h));
    applyVisual(s, n);
    if (n.kind === "image") s.fills = [{ fillColor: "#E3E8EF", fillOpacity: 1 }];
  } else {
    s = penpot.createBoard();
    s.name = n.name || "Frame";
    s.resize(Math.max(1, n.w), Math.max(1, n.h));
    s.fills = [];
    applyVisual(s, n);
    s.clipContent = !!n.clip;
  }
  if (!s) return null;

  // Place first (absolute coordinates); layouts reposition afterwards.
  s.x = ox + n.x;
  s.y = oy + n.y;

  if (parent) {
    const lay = parent.flex;
    if (lay && !n.item?.absolute) lay.appendChild(s);
    else parent.appendChild(s);
    if (n.item && s.layoutChild) {
      const lc = s.layoutChild;
      try {
        if (n.item.absolute) {
          lc.absolute = true;
          s.x = ox + n.x;
          s.y = oy + n.y;
        } else {
          const m = n.item.margin;
          if (m && (m[0] || m[1] || m[2] || m[3])) {
            lc.marginType = "multiple";
            lc.topMargin = m[0]; lc.rightMargin = m[1]; lc.bottomMargin = m[2]; lc.leftMargin = m[3];
          }
          if (n.item.alignSelf && n.item.alignSelf !== "auto") lc.alignSelf = n.item.alignSelf;
        }
      } catch (e) { /* layout child props unsupported here */ }
    }
  }

  if (n.kind === "frame") {
    if (n.layout) {
      const L = s.addFlexLayout();
      L.dir = n.layout.dir;
      L.wrap = n.layout.wrap ? "wrap" : "nowrap";
      L.rowGap = n.layout.rowGap || 0;
      L.columnGap = n.layout.colGap || 0;
      const p = n.layout.pad || [0, 0, 0, 0];
      L.paddingType = "multiple";
      L.topPadding = p[0]; L.rightPadding = p[1]; L.bottomPadding = p[2]; L.leftPadding = p[3];
      L.alignItems = n.layout.align || "start";
      L.justifyContent = n.layout.justify || "start";
      if (n.layout.alignContent) L.alignContent = n.layout.alignContent;
    }
    // Penpot lays out a flex frame from the top of the layer list down, so the
    // first DOM child must be appended last. Absolute decorations that come
    // before the flow keep their place under it (appended first).
    const kids = n.children || [];
    if (n.layout) {
      const firstFlow = kids.findIndex((c) => !(c.item && c.item.absolute));
      const before = firstFlow < 0 ? kids : kids.slice(0, firstFlow).filter((c) => c.item && c.item.absolute);
      const flow = kids.filter((c) => !(c.item && c.item.absolute));
      const after = firstFlow < 0 ? [] : kids.slice(firstFlow).filter((c) => c.item && c.item.absolute);
      for (const c of before) buildNode(c, s, s.x, s.y);
      for (const c of flow.slice().reverse()) buildNode(c, s, s.x, s.y);
      for (const c of after) buildNode(c, s, s.x, s.y);
    } else {
      for (const c of kids) buildNode(c, s, s.x, s.y);
    }
  }

  // Sizing after children exist so "auto" (hug) resolves against real content.
  if (parent && parent.flex && n.item && !n.item.absolute && s.layoutChild) {
    try {
      s.layoutChild.horizontalSizing = n.item.h || "fix";
      s.layoutChild.verticalSizing = n.item.v || "fix";
    } catch (e) { /* ignore */ }
  } else if (n.kind === "frame" && n.layout && n.self) {
    try {
      if (n.self.h) s.flex.horizontalSizing = n.self.h;
      if (n.self.v) s.flex.verticalSizing = n.self.v;
    } catch (e) { /* ignore */ }
  }
  if (n.kind === "frame" && n.layout && n.self && parent && parent.flex) {
    // A frame inside a layout: its own hug flags live on the layout object too.
    try {
      if (n.self.h === "auto") s.flex.horizontalSizing = "auto";
      if (n.self.v === "auto") s.flex.verticalSizing = "auto";
    } catch (e) { /* ignore */ }
  }
  if (n.kind === "frame" && n.layout) {
    // Adding the flex layout made the frame hug its content while the children
    // went in; an axis that should stay fixed goes back to its measured size
    // (a 52px button around a 20px label, a round 44px avatar).
    const eff = parent && parent.flex && n.item && !n.item.absolute ? n.item : n.self || { h: "fix", v: "fix" };
    const fixW = eff.h === "fix" && Math.abs(s.width - n.w) > 0.5;
    const fixH = eff.v === "fix" && Math.abs(s.height - n.h) > 0.5;
    if (fixW || fixH) {
      try { s.resize(fixW ? Math.max(1, n.w) : s.width, fixH ? Math.max(1, n.h) : s.height); } catch (e) { /* ignore */ }
    }
  }
  return s;
}

// ---------------------------------------------------------------- run

const SPECS = __SPECS__;
let left = 0;
for (const { name, spec } of SPECS) {
  const root = buildNode({ ...spec, name, x: 0, y: 0 }, null, left, 0);
  if (root && spec.layout && spec.self) {
    try {
      root.flex.horizontalSizing = spec.self.h || "fix";
      root.flex.verticalSizing = spec.self.v || "fix";
    } catch (e) { /* ignore */ }
  }
  left += Math.round(spec.w) + 160;
}
penpot.closePlugin();
