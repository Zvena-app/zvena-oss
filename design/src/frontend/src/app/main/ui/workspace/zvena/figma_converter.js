// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) zvena
//
// zvena: Figma → Design converter. Runs inside the editor as a built-in
// plugin (the `penpot` global of the plugin runtime). Its input comes as a
// plugin API extension, the `zvenaFigma` global:
//   doc        Figma REST "GET /v1/files/:key?geometry=paths" (or /nodes)
//   images     { imageRef: ImageData } — already uploaded into this file
//   progress   (done, total, label) => void
//   done       (summary) => void
// Every Figma page becomes a page here; frames, groups, shapes, text,
// vectors (as paths), auto layout, fills (solid, gradients, images with
// their scale mode), strokes, shadows, blurs, radii, constraints, opacity,
// blend modes, visibility and locks are carried over. Components become
// components; instances are imported as plain copies.
//
// zvena: a local .fig file is read in the browser by fig_file.js into the
// same REST shape, plus a few fields the REST API doesn't have:
// `absoluteTransform` (exact matrix of every node), `zvStrokePath` (the
// centerline of a vector, so strokes stay strokes), and `warnings` of the
// reader passed along in `zvenaFigma.warnings`. Masks (`isMask`) and
// per-region vector fills (`fillOverrideTable`) work for both inputs.

/* global penpot, zvenaFigma */

// The host passes the data as a global of the plugin compartment.
const F = typeof zvenaFigma !== "undefined" ? zvenaFigma : penpot.zvenaFigma;
const DOC = F.doc;
const IMAGES = F.images || {};

const stats = { nodes: 0, skipped: 0, pages: 0, components: 0, warnings: [] };
let total = 0;
let done = 0;

function warn(msg) {
  if (stats.warnings.length < 50) stats.warnings.push(msg);
}

// zvena: notes of the .fig reader come first
if (Array.isArray(F.warnings)) {
  for (const w of F.warnings) warn(String(w));
}

// ------------------------------------------------------------ geometry

const IDENTITY = [[1, 0, 0], [0, 1, 0]];

// eslint-disable-next-line no-unused-vars
function mul(m1, m2) {
  // 2x3 affine matrices [[a, c, tx], [b, d, ty]]
  const [a1, c1, x1] = m1[0];
  const [b1, d1, y1] = m1[1];
  const [a2, c2, x2] = m2[0];
  const [b2, d2, y2] = m2[1];
  return [
    [a1 * a2 + c1 * b2, a1 * c2 + c1 * d2, a1 * x2 + c1 * y2 + x1],
    [b1 * a2 + d1 * b2, b1 * c2 + d1 * d2, b1 * x2 + d1 * y2 + y1],
  ];
}

function apply(m, x, y) {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

// Rotation (degrees, clockwise on screen) and flip of a relative transform.
function angleOf(m) {
  return (Math.atan2(m[1][0], m[0][0]) * 180) / Math.PI;
}

function flippedOf(m) {
  return m[0][0] * m[1][1] - m[0][1] * m[1][0] < 0;
}

// The absolute matrix of a node: centered on its absolute bounding box
// (the box of the rotated shape shares its center), rotated by its
// absolute angle. Unrotated nodes land exactly on Figma's coordinates.
function absMatrix(n, angle, flipped) {
  const { w, h } = sizeOf(n);
  const b = n.absoluteBoundingBox || { x: 0, y: 0, width: w, height: h };
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const r = (angle * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const fx = flipped ? -1 : 1;
  // T(center) · R · S(flip) · T(-w/2, -h/2)
  const m = [[cos * fx, -sin, 0], [sin * fx, cos, 0]];
  const [ox, oy] = apply(m, -w / 2, -h / 2);
  m[0][2] = cx + ox;
  m[1][2] = cy + oy;
  return m;
}

// SVG path data in node space → absolute page coordinates.
function transformPath(d, m) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const out = [];
  let i = 0;
  let cmd = null;
  let cur = [0, 0];
  let start = [0, 0];
  const num = () => parseFloat(tokens[i++]);
  const pt = (x, y) => {
    const [px, py] = apply(m, x, y);
    return `${round(px)} ${round(py)}`;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    switch (cmd) {
      case "M": { const x = num(); const y = num(); cur = [x, y]; start = cur; out.push(`M ${pt(x, y)}`); cmd = "L"; break; }
      case "L": { const x = num(); const y = num(); cur = [x, y]; out.push(`L ${pt(x, y)}`); break; }
      case "H": { const x = num(); cur = [x, cur[1]]; out.push(`L ${pt(cur[0], cur[1])}`); break; }
      case "V": { const y = num(); cur = [cur[0], y]; out.push(`L ${pt(cur[0], cur[1])}`); break; }
      case "C": {
        const x1 = num(); const y1 = num(); const x2 = num(); const y2 = num(); const x = num(); const y = num();
        cur = [x, y];
        out.push(`C ${pt(x1, y1)} ${pt(x2, y2)} ${pt(x, y)}`);
        break;
      }
      case "Q": {
        const qx = num(); const qy = num(); const x = num(); const y = num();
        // quadratic → cubic (Design paths keep cubic curves)
        const c1 = [cur[0] + (2 / 3) * (qx - cur[0]), cur[1] + (2 / 3) * (qy - cur[1])];
        const c2 = [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y)];
        cur = [x, y];
        out.push(`C ${pt(c1[0], c1[1])} ${pt(c2[0], c2[1])} ${pt(x, y)}`);
        break;
      }
      case "Z":
      case "z": out.push("Z"); cur = start; cmd = null; break;
      default: i++; // unknown token: skip
    }
  }
  return out.join(" ");
}

// ------------------------------------------------------------ paints

function hex(c) {
  const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

function paintOpacity(p) {
  return (p.opacity ?? 1) * (p.color && p.color.a !== undefined ? p.color.a : 1);
}

function gradient(p, kind) {
  const hs = p.gradientHandlePositions || [];
  const [p0, p1, p2] = [hs[0] || { x: 0, y: 0.5 }, hs[1] || { x: 1, y: 0.5 }, hs[2] || { x: 0, y: 1 }];
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
  const width = Math.hypot(p2.x - p0.x, p2.y - p0.y) / len || 1;
  return {
    type: kind,
    startX: p0.x, startY: p0.y, endX: p1.x, endY: p1.y,
    width: kind === "linear" ? 1 : width,
    stops: (p.gradientStops || []).map((s) => ({
      color: hex(s.color), opacity: s.color.a ?? 1, offset: Math.max(0, Math.min(1, s.position)),
    })),
  };
}

const SCALE_MODE = { FILL: "fill", FIT: "fit", TILE: "tile", STRETCH: "fill" };

function fillOf(p) {
  if (p.visible === false) return null;
  switch (p.type) {
    case "SOLID":
      return { fillColor: hex(p.color), fillOpacity: paintOpacity(p) };
    case "GRADIENT_LINEAR":
      return { fillColorGradient: gradient(p, "linear"), fillOpacity: p.opacity ?? 1 };
    case "GRADIENT_RADIAL":
      return { fillColorGradient: gradient(p, "radial"), fillOpacity: p.opacity ?? 1 };
    case "GRADIENT_ANGULAR":
      return { fillColorGradient: gradient(p, "angular"), fillOpacity: p.opacity ?? 1 };
    case "GRADIENT_DIAMOND":
      return { fillColorGradient: gradient(p, "diamond"), fillOpacity: p.opacity ?? 1 };
    case "IMAGE": {
      const img = IMAGES[p.imageRef];
      if (!img) { warn("an image fill could not be downloaded"); return null; }
      let mode = SCALE_MODE[p.scaleMode] || "fill";
      // Figma's Crop comes as STRETCH + imageTransform (the visible part of
      // the image in 0..1 image space): approximated as a zoomed cover.
      let crop;
      const t = p.imageTransform;
      if (p.scaleMode === "STRETCH" && Array.isArray(t)) {
        const a = Math.abs(t[0][0]) || 1;
        const d = Math.abs(t[1][1]) || 1;
        const zoom = Math.max(1, Math.min(10, 1 / Math.max(a, d)));
        crop = {
          zoom,
          x: a < 1 ? Math.max(0, Math.min(1, t[0][2] / (1 - a))) : 0.5,
          y: d < 1 ? Math.max(0, Math.min(1, t[1][2] / (1 - d))) : 0.5,
        };
        mode = "crop";
      }
      const adjust = {};
      for (const k of ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"]) {
        const v = p.filters && p.filters[k];
        if (typeof v === "number" && v !== 0) adjust[k] = Math.round(Math.max(-1, Math.min(1, v)) * 100);
      }
      const rot = ((Math.round((p.rotation || 0) / 90) % 4) + 4) % 4 * 90;
      const data = Object.assign({}, img, {
        keepAspectRatio: true,
        scaleMode: mode,
        tileScale: mode === "tile" ? Math.max(1, Math.round((p.scalingFactor || 1) * 100)) : undefined,
        crop,
        rotation: rot || undefined,
        adjust: Object.keys(adjust).length ? adjust : undefined,
      });
      return { fillImage: data, fillOpacity: p.opacity ?? 1 };
    }
    default:
      warn(`${p.type} fill skipped`);
      return null;
  }
}

function fillsOf(paints) {
  if (!Array.isArray(paints)) return [];
  // Figma lists paints bottom → top; Design lists fills top → bottom.
  return paints.map(fillOf).filter(Boolean).reverse();
}

function strokesOf(n) {
  if (!Array.isArray(n.strokes) || !n.strokes.length) return [];
  const align = { INSIDE: "inner", OUTSIDE: "outer", CENTER: "center" }[n.strokeAlign] || "center";
  const width = n.strokeWeight ?? 1;
  const dashed = Array.isArray(n.strokeDashes) && n.strokeDashes.length > 0;
  const out = [];
  for (const p of n.strokes) {
    if (p.visible === false) continue;
    if (p.type !== "SOLID") { warn(`${p.type} stroke imported as its first stop color`); }
    const color = p.type === "SOLID" ? p.color : (p.gradientStops && p.gradientStops[0] && p.gradientStops[0].color) || { r: 0, g: 0, b: 0, a: 1 };
    out.push({
      strokeColor: hex(color),
      strokeOpacity: (p.opacity ?? 1) * (color.a ?? 1),
      strokeWidth: width,
      strokeAlignment: align,
      strokeStyle: dashed ? "dashed" : "solid",
    });
  }
  return out.reverse();
}

const BLEND = {
  PASS_THROUGH: "normal", NORMAL: "normal", DARKEN: "darken", MULTIPLY: "multiply", COLOR_BURN: "color-burn",
  LIGHTEN: "lighten", SCREEN: "screen", COLOR_DODGE: "color-dodge", OVERLAY: "overlay", SOFT_LIGHT: "soft-light",
  HARD_LIGHT: "hard-light", DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation",
  COLOR: "color", LUMINOSITY: "luminosity", LINEAR_BURN: "multiply", LINEAR_DODGE: "screen",
};

function applyEffects(s, n) {
  const shadows = [];
  for (const e of n.effects || []) {
    if (e.visible === false) continue;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      shadows.push({
        style: e.type === "INNER_SHADOW" ? "inner-shadow" : "drop-shadow",
        offsetX: e.offset ? e.offset.x : 0,
        offsetY: e.offset ? e.offset.y : 0,
        blur: e.radius || 0,
        spread: e.spread || 0,
        hidden: false,
        color: { color: hex(e.color), opacity: e.color.a ?? 1 },
      });
    } else if (e.type === "LAYER_BLUR") {
      try { s.blur = { value: Math.round((e.radius || 0) / 2), hidden: false }; } catch (_) { /* unsupported */ }
    } else if (e.type === "BACKGROUND_BLUR") {
      try { s.backgroundBlur = { value: Math.round((e.radius || 0) / 2), hidden: false }; } catch (_) { /* unsupported */ }
    } else {
      warn(`${e.type} effect skipped`);
    }
  }
  if (shadows.length) {
    try { s.shadows = shadows.reverse(); } catch (_) { /* unsupported */ }
  }
}

function applyCommon(s, n) {
  if (n.name) s.name = n.name;
  if (n.visible === false) s.visible = false;
  if (n.locked) s.blocked = true;
  if (typeof n.opacity === "number" && n.opacity < 1) s.opacity = n.opacity;
  if (n.blendMode && BLEND[n.blendMode] && BLEND[n.blendMode] !== "normal") {
    try { s.blendMode = BLEND[n.blendMode]; } catch (_) { /* unsupported */ }
  }
  if (n.constraints) {
    const H = { LEFT: "left", RIGHT: "right", CENTER: "center", LEFT_RIGHT: "leftright", SCALE: "scale" };
    const V = { TOP: "top", BOTTOM: "bottom", CENTER: "center", TOP_BOTTOM: "topbottom", SCALE: "scale" };
    try {
      if (H[n.constraints.horizontal]) s.constraintsHorizontal = H[n.constraints.horizontal];
      if (V[n.constraints.vertical]) s.constraintsVertical = V[n.constraints.vertical];
    } catch (_) { /* not inside a frame */ }
  }
}

function applyRadius(s, n) {
  try {
    if (Array.isArray(n.rectangleCornerRadii)) {
      const [tl, tr, br, bl] = n.rectangleCornerRadii;
      if (tl === tr && tr === br && br === bl) s.borderRadius = tl;
      else {
        s.borderRadiusTopLeft = tl; s.borderRadiusTopRight = tr;
        s.borderRadiusBottomRight = br; s.borderRadiusBottomLeft = bl;
      }
    } else if (n.cornerRadius) {
      s.borderRadius = n.cornerRadius;
    }
    // corner smoothing (0..1) is kept as zvena shared plugin data
    if (typeof n.cornerSmoothing === "number" && n.cornerSmoothing > 0) {
      s.setSharedPluginData("zvena", "smoothing", String(n.cornerSmoothing));
    }
  } catch (_) { /* shape without radius */ }
}

function applyPaints(s, n) {
  try { s.fills = fillsOf(n.fills); } catch (e) { warn(`fills of "${n.name}": ${e.message || e}`); }
  try { const st = strokesOf(n); if (st.length) s.strokes = st; } catch (e) { warn(`strokes of "${n.name}": ${e.message || e}`); }
  applyEffects(s, n);
}

// ------------------------------------------------------------ text

const fontCache = new Map();
function findFont(family) {
  const key = (family || "").toLowerCase();
  if (fontCache.has(key)) return fontCache.get(key);
  let font = null;
  try {
    font = penpot.fonts.all.find((f) => f.name.toLowerCase() === key) || null;
  } catch (_) { font = null; }
  if (!font && family) warn(`font "${family}" is not available; Inter is used`);
  if (!font && key !== "inter") font = findFont("Inter");
  fontCache.set(key, font);
  return font;
}

function pickVariant(font, weight, italic) {
  if (!font || !font.variants || !font.variants.length) return undefined;
  let best = null;
  let bestScore = Infinity;
  for (const v of font.variants) {
    const vw = Number(v.fontWeight) || 400;
    const vi = v.fontStyle === "italic";
    const score = Math.abs(vw - (weight || 400)) + (vi === !!italic ? 0 : 1000);
    if (score < bestScore) { best = v; bestScore = score; }
  }
  return best || undefined;
}

function styleText(target, st, isRange) {
  if (!st) return;
  const font = findFont(st.fontFamily);
  if (font) {
    const italic = !!st.italic || /italic/i.test(st.fontPostScriptName || "") || /italic/i.test(st.fontStyle || "");
    const v = pickVariant(font, st.fontWeight, italic);
    try { if (isRange) font.applyToRange(target, v); else font.applyToText(target, v); } catch (_) { /* keep default */ }
  }
  if (st.fontSize) target.fontSize = String(st.fontSize);
  if (st.lineHeightPx && st.fontSize && st.lineHeightUnit !== "INTRINSIC_%") {
    target.lineHeight = String(round(st.lineHeightPx / st.fontSize));
  }
  if (typeof st.letterSpacing === "number") target.letterSpacing = String(round(st.letterSpacing));
  if (st.textDecoration === "UNDERLINE") target.textDecoration = "underline";
  if (st.textDecoration === "STRIKETHROUGH") target.textDecoration = "line-through";
  const tcase = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" }[st.textCase];
  if (tcase) target.textTransform = tcase;
  if (Array.isArray(st.fills)) {
    const f = fillsOf(st.fills);
    if (f.length) target.fills = f;
  }
}

function buildText(n) {
  const chars = n.characters && n.characters.length ? n.characters : " ";
  const t = penpot.createText(chars);
  if (!t) return null;
  const base = Object.assign({}, n.style || {}, { fills: n.fills });
  styleText(t, base, false);
  const align = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" }[(n.style || {}).textAlignHorizontal];
  if (align) t.align = align;
  const valign = { TOP: "top", CENTER: "center", BOTTOM: "bottom" }[(n.style || {}).textAlignVertical];
  if (valign) t.verticalAlign = valign;
  // mixed styles: runs of equal override ids
  const ov = n.characterStyleOverrides || [];
  const table = n.styleOverrideTable || {};
  let i = 0;
  while (i < ov.length) {
    const id = ov[i];
    let j = i + 1;
    while (j < ov.length && ov[j] === id) j++;
    if (id && table[id]) {
      try { styleText(t.getRange(i, j), Object.assign({}, n.style || {}, table[id]), true); } catch (_) { /* skip run */ }
    }
    i = j;
  }
  return t;
}

// ------------------------------------------------------------ nodes

const CONTAINERS = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);
const VECTORS = new Set(["VECTOR", "STAR", "REGULAR_POLYGON", "LINE", "BOOLEAN_OPERATION"]);

function sizeOf(n) {
  if (n.size) return { w: n.size.x, h: n.size.y };
  const b = n.absoluteBoundingBox || { width: 1, height: 1 };
  return { w: b.width, h: b.height };
}

function relOf(n) {
  return Array.isArray(n.relativeTransform) ? n.relativeTransform : IDENTITY;
}

// Size, position and rotation of a shape from the node.
function place(s, n, angle, flipped) {
  const { w, h } = sizeOf(n);
  const b = n.absoluteBoundingBox || { x: 0, y: 0, width: w, height: h };
  try { s.resize(Math.max(0.01, w), Math.max(0.01, h)); } catch (_) { /* fixed-size shape */ }
  s.x = b.x + b.width / 2 - w / 2;
  s.y = b.y + b.height / 2 - h / 2;
  // zvena: with the exact matrix (.fig), a mirrored layer is turned so that
  // the horizontal flip (around its center, on screen axes) lands on it
  let rot = angle;
  const t = n.absoluteTransform;
  if (flipped && Array.isArray(t)) rot = (Math.atan2(t[1][0], -t[0][0]) * 180) / Math.PI;
  if (Math.abs(rot) > 0.01) { try { s.rotate(rot); } catch (_) { /* unsupported */ } }
  if (flipped) { try { s.flipX = true; } catch (_) { /* unsupported */ } }
}

// zvena: a .fig vector with its centerline (`zvStrokePath`) becomes one
// path with real strokes (editable, with caps and dashes).
function strokedPath(n, abs) {
  let p = null;
  try {
    p = fresh(penpot.createPath(), "d");
    p.name = n.name || "Vector";
    p.d = transformPath(n.zvStrokePath, abs);
    p.fills = n.zvStrokeFilled ? fillsOf(n.fills) : [];
    p.strokes = strokesOf(n).map((st) => Object.assign(st,
      n.zvStrokeCapStart ? { strokeCapStart: n.zvStrokeCapStart } : {},
      n.zvStrokeCapEnd ? { strokeCapEnd: n.zvStrokeCapEnd } : {}));
    applyEffects(p, n);
    return p;
  } catch (e) {
    if (p) { try { p.remove(); } catch (_) { /* ignore */ } }
    return null;
  }
}

function vectorNode(n, abs) {
  if (typeof n.zvStrokePath === "string" && n.zvStrokePath) {
    const sp = strokedPath(n, abs);
    if (sp) return sp;
  }
  const parts = [];
  // zvena: regions with their own fill (fillOverrideTable / overrideID)
  const table = n.fillOverrideTable || {};
  const make = (geometry, fills, regions) => {
    for (const g of geometry || []) {
      if (!g.path) continue;
      const p = fresh(penpot.createPath(), "d");
      p.name = n.name || "Vector";
      p.d = transformPath(g.path, abs);
      const ov = regions && g.overrideID !== undefined && g.overrideID !== null ? table[g.overrideID] : null;
      p.fills = ov && Array.isArray(ov.fills) ? fillsOf(ov.fills) : fills;
      p.strokes = [];
      parts.push(p);
    }
  };
  make(n.fillGeometry, fillsOf(n.fills), true);
  // Strokes come as their outline (Figma's strokeGeometry), filled with the stroke paint.
  if (Array.isArray(n.strokes) && n.strokes.some((p) => p.visible !== false)) {
    const strokeFills = fillsOf(n.strokes);
    make(n.strokeGeometry, strokeFills);
  }
  if (!parts.length) return null;
  let s = parts[0];
  if (parts.length > 1) {
    s = penpot.group(parts);
    if (s) s.name = n.name || "Vector";
  }
  if (s) applyEffects(s, n);
  return s;
}

function fresh(s, prop) {
  if (!s || prop in s) return s;
  try {
    const again = penpot.currentPage.getShapeById(s.id);
    return again && prop in again ? again : s;
  } catch (_) {
    return s;
  }
}

function count(n) {
  let c = 1;
  for (const k of n.children || []) c += count(k);
  return c;
}

function tick(label) {
  done++;
  if (done % 25 === 0 || done === total) {
    try { F.progress(done, total, label); } catch (_) { /* host gone */ }
  }
}

// `parentAngle`: the absolute rotation of the nearest frame-like parent
// (children of groups and booleans are placed relative to it, as in Figma).
function buildNode(n, parent, parentAngle) {
  tick(n.name);
  stats.nodes++;
  const rel = relOf(n);
  // zvena: the .fig reader gives every node its exact absolute matrix
  const absT = Array.isArray(n.absoluteTransform) ? n.absoluteTransform : null;
  const angle = absT ? angleOf(absT) : parentAngle + angleOf(rel);
  const flipped = absT ? flippedOf(absT) : flippedOf(rel);
  const abs = absT || absMatrix(n, angle, flipped);
  let s = null;

  try {
    if (n.type === "TEXT") {
      s = buildText(n);
      if (s) {
        place(s, n, angle, flipped);
        const resize = (n.style || {}).textAutoResize;
        s.growType = resize === "WIDTH_AND_HEIGHT" ? "auto-width" : resize === "HEIGHT" ? "auto-height" : "fixed";
      }
    } else if (n.type === "RECTANGLE") {
      s = penpot.createRectangle();
      place(s, n, angle, flipped);
      applyRadius(s, n);
      applyPaints(s, n);
    } else if (n.type === "ELLIPSE") {
      const arc = n.arcData;
      const fullCircle = !arc || (Math.abs(arc.endingAngle - arc.startingAngle - Math.PI * 2) < 0.001 && !arc.innerRadius);
      if (fullCircle) {
        s = penpot.createEllipse();
        place(s, n, angle, flipped);
        applyPaints(s, n);
      } else {
        s = vectorNode(n, abs);
      }
    } else if (VECTORS.has(n.type)) {
      s = vectorNode(n, abs);
    } else if (n.type === "GROUP") {
      const pairs = [];
      for (const c of n.children || []) {
        const k = buildNode(c, parent, parentAngle);
        if (k) pairs.push([k, c]);
      }
      // zvena: a group whose bottom layer is its only mask becomes a mask group
      const wholeMask = pairs.length > 1 && pairs[0][1].isMask && !pairs.slice(1).some((p) => p[1].isMask);
      const kids = wholeMask ? pairs.map((p) => p[0]) : applyMasks(pairs);
      if (kids.length) {
        s = penpot.group(kids);
        if (s && wholeMask) { try { s.makeMask(); } catch (_) { /* stays a plain group */ } }
        if (s) applyCommon(s, n);
      }
      return s; // children are already in place
    } else if (CONTAINERS.has(n.type)) {
      s = fresh(penpot.createBoard(), "clipContent");
      place(s, n, angle, flipped);
      applyRadius(s, n);
      applyPaints(s, n);
      try {
        s.clipContent = n.type === "SECTION" ? false : n.clipsContent !== false;
      } catch (_) { warn(`"${n.name}": clip content not set`); }
      // a Figma section becomes a zvena section (non-clipping, not a screen)
      if (n.type === "SECTION") {
        try { s.setSharedPluginData("zvena", "section", "true"); } catch (_) { /* older API */ }
        try { s.showInViewMode = false; } catch (_) { /* older API */ }
      }
    } else {
      stats.skipped++;
      warn(`${n.type} "${n.name}" skipped`);
      return null;
    }
  } catch (e) {
    stats.skipped++;
    warn(`"${n.name}": ${e.message || e}`);
    return null;
  }
  if (!s) return null;

  if (parent) {
    try {
      if (parent.flex && n.layoutPositioning !== "ABSOLUTE") parent.flex.appendChild(s);
      else parent.appendChild(s);
    } catch (_) { /* keep it on the page */ }
  }
  applyCommon(s, n);

  if (CONTAINERS.has(n.type)) {
    buildChildren(s, n, angle);
    if (n.type === "COMPONENT") {
      try { penpot.library.local.createComponent([s]); stats.components++; } catch (e) { warn(`component "${n.name}": ${e.message || e}`); }
    }
  }
  return s;
}

function applyAutoLayout(s, n) {
  if (n.layoutMode !== "HORIZONTAL" && n.layoutMode !== "VERTICAL") return false;
  const L = s.addFlexLayout();
  const row = n.layoutMode === "HORIZONTAL";
  L.dir = row ? "row" : "column";
  L.wrap = n.layoutWrap === "WRAP" ? "wrap" : "nowrap";
  const gap = n.itemSpacing || 0;
  const cross = n.counterAxisSpacing ?? 0;
  if (row) { L.columnGap = gap; L.rowGap = cross; } else { L.rowGap = gap; L.columnGap = cross; }
  L.paddingType = "multiple";
  L.topPadding = n.paddingTop || 0;
  L.rightPadding = n.paddingRight || 0;
  L.bottomPadding = n.paddingBottom || 0;
  L.leftPadding = n.paddingLeft || 0;
  L.justifyContent = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between" }[n.primaryAxisAlignItems] || "start";
  L.alignItems = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "start" }[n.counterAxisAlignItems] || "start";
  // zvena: "Strokes included in layout" is kept as zvena shared plugin data
  if (n.strokesIncludedInLayout === true) {
    try { s.setSharedPluginData("zvena", "strokes-in-layout", "true"); } catch (_) { /* older API */ }
  }
  return true;
}

function sizingOf(n, parentRow, axis) {
  // axis "h" | "v"
  const key = axis === "h" ? n.layoutSizingHorizontal : n.layoutSizingVertical;
  if (key === "HUG") return "auto";
  if (key === "FILL") return "fill";
  if (key === "FIXED") return "fix";
  // older files: layoutGrow / layoutAlign
  const primary = (axis === "h") === parentRow;
  if (primary && n.layoutGrow === 1) return "fill";
  if (!primary && n.layoutAlign === "STRETCH") return "fill";
  return "fix";
}

function buildChildren(s, n, angle) {
  const kids = n.children || [];
  const flex = applyAutoLayout(s, n);
  if (flex) {
    // Design lays a flex frame out from the top of its layer list: the first
    // item in the flow must be appended last.
    const flow = kids.filter((c) => c.layoutPositioning !== "ABSOLUTE");
    const absolute = kids.filter((c) => c.layoutPositioning === "ABSOLUTE");
    const row = n.layoutMode === "HORIZONTAL";
    const built = [];
    for (const c of flow.slice().reverse()) {
      const k = buildNode(c, s, angle);
      if (k) built.push([k, c]);
    }
    for (const c of absolute) {
      const k = buildNode(c, s, angle);
      if (k && k.layoutChild) { try { k.layoutChild.absolute = true; } catch (_) { /* ignore */ } }
    }
    for (const [k, c] of built) {
      if (!k.layoutChild) continue;
      try {
        k.layoutChild.horizontalSizing = sizingOf(c, row, "h");
        k.layoutChild.verticalSizing = sizingOf(c, row, "v");
      } catch (_) { /* ignore */ }
    }
    // the frame's own hug/fixed sizing
    const { w, h } = sizeOf(n);
    try {
      const hs = n.layoutSizingHorizontal === "HUG" || (row ? n.primaryAxisSizingMode === "AUTO" : n.counterAxisSizingMode === "AUTO");
      const vs = n.layoutSizingVertical === "HUG" || (row ? n.counterAxisSizingMode === "AUTO" : n.primaryAxisSizingMode === "AUTO");
      // fixed axes keep Figma's size; then hug axes follow the content
      if (!hs || !vs) s.resize(hs ? s.width : Math.max(0.01, w), vs ? s.height : Math.max(0.01, h));
      s.flex.horizontalSizing = hs ? "auto" : "fix";
      s.flex.verticalSizing = vs ? "auto" : "fix";
    } catch (_) { /* ignore */ }
  } else {
    // zvena: masks clip the layers above them
    const pairs = [];
    for (const c of kids) {
      const k = buildNode(c, s, angle);
      if (k) pairs.push([k, c]);
    }
    if (pairs.some((p) => p[1].isMask)) applyMasks(pairs);
  }
}

// zvena: a Figma mask (isMask) clips the layers above it in its parent;
// here the mask and those layers become a mask group (its bottom layer is
// the mask). Returns the shapes that remain at this level.
function applyMasks(pairs) {
  const out = [];
  let i = 0;
  while (i < pairs.length) {
    if (!pairs[i][1].isMask) { out.push(pairs[i][0]); i++; continue; }
    let j = i + 1;
    while (j < pairs.length && !pairs[j][1].isMask) j++;
    const members = pairs.slice(i, j).map((p) => p[0]);
    let g = null;
    if (members.length > 1) {
      try {
        g = penpot.group(members);
        if (g) { g.name = "Mask group"; g.makeMask(); }
      } catch (e) { warn(`mask "${pairs[i][1].name}": ${e.message || e}`); }
    }
    if (g) out.push(g);
    else for (const m of members) out.push(m);
    i = j;
  }
  return out;
}

// ------------------------------------------------------------ run

async function run() {
  const root = DOC.document || null;
  let pages = [];
  if (root && Array.isArray(root.children)) {
    pages = root.children.filter((c) => c.type === "CANVAS");
  } else if (DOC.nodes) {
    // /nodes: one or more subtrees, imported on the current page
    pages = [{ name: DOC.name || "Figma", children: Object.values(DOC.nodes).map((x) => x && x.document).filter(Boolean) }];
  }
  total = pages.reduce((acc, p) => acc + (p.children || []).reduce((a, c) => a + count(c), 0), 0) || 1;
  try { F.progress(0, total, ""); } catch (_) { /* ignore */ }

  let first = true;
  for (const pg of pages) {
    let page = penpot.currentPage;
    if (!first || (page && page.root && page.root.children && page.root.children.length)) {
      page = penpot.createPage();
      await penpot.openPage(page, false);
    }
    first = false;
    try { page.name = pg.name || "Page"; } catch (_) { /* keep name */ }
    stats.pages++;
    for (const c of pg.children || []) {
      buildNode(c, null, 0);
    }
  }
  try { F.done(stats); } catch (_) { /* ignore */ }
}

run()
  .catch((e) => {
    try { F.done(Object.assign(stats, { error: String((e && e.message) || e) })); } catch (_) { /* ignore */ }
  })
  .finally(() => penpot.closePlugin());
