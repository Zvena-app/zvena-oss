// zvena (from an earlier converter): rendered HTML -> layer spec for
// the template builder (builder.js). Only the font Design ships (Source Sans
// Pro, served by Design itself) — no third-party font hosts.
//
// The design HTML is rendered in a hidden same-origin iframe at its real
// width; we walk the DOM with computed styles and measured boxes and emit
// frames (with auto layout when the element is a flex container or a block
// of stacked children), text layers (with styled runs), SVG vectors and
// image rectangles. Sizing (fix / hug / fill) is inferred by comparing the
// measured box with what hugging the children would give.

const INLINE_TAGS = new Set(["span", "b", "strong", "em", "i", "a", "small", "u", "s", "mark", "code", "sup", "sub", "br", "label", "abbr", "time", "del", "ins", "q", "cite"]);
const SKIP_TAGS = new Set(["style", "script", "meta", "link", "title", "head", "noscript", "template"]);
const FAMILY = "Source Sans Pro";

const round = (v) => Math.round(v * 100) / 100;
const px = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function fontFamiliesIn() {
  return [FAMILY];
}

function fontFaces(base) {
  const w = { 400: "regular", 600: "semibold", 700: "bold", 900: "black" };
  return Object.entries(w)
    .map(([weight, name]) => `@font-face{font-family:"${FAMILY}";font-weight:${weight};font-style:normal;src:url(${base}/fonts/sourcesanspro-${name}.woff2) format("woff2")}`)
    .join("");
}

// ---------------------------------------------------------------- colors

function parseColor(str) {
  if (!str) return null;
  const s = str.trim();
  if (s === "transparent") return null;
  let m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (m) {
    let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a <= 0.001) return null;
    const hex = "#" + [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, "0")).join("");
    return { c: hex.toUpperCase(), o: round(a) };
  }
  m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const o = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { c: ("#" + h.slice(0, 6)).toUpperCase(), o: round(o) };
  }
  return null;
}

// Split by commas that are not inside parentheses.
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseLinearGradient(str, w, h) {
  const m = str.match(/linear-gradient\((.*)\)\s*$/i);
  if (!m) return null;
  const parts = splitTop(m[1]);
  let angle = 180;
  const first = parts[0];
  if (/deg|turn|rad/.test(first) && !/rgb|#/.test(first)) {
    angle = first.includes("turn") ? parseFloat(first) * 360 : first.includes("rad") ? (parseFloat(first) * 180) / Math.PI : parseFloat(first);
    parts.shift();
  } else if (/^to /.test(first)) {
    const dir = first.slice(3).trim();
    const map = { top: 0, right: 90, bottom: 180, left: 270, "top right": 45, "right top": 45, "bottom right": 135, "right bottom": 135, "bottom left": 225, "left bottom": 225, "top left": 315, "left top": 315 };
    angle = map[dir] ?? 180;
    parts.shift();
  }
  const stops = [];
  parts.forEach((p, i) => {
    const cm = p.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i);
    if (!cm) return;
    const col = parseColor(cm[1]) || { c: "#000000", o: 0 };
    const pm = p.slice(cm.index + cm[1].length).match(/([\d.]+)%/);
    const pos = pm ? parseFloat(pm[1]) / 100 : parts.length > 1 ? i / (parts.length - 1) : 0;
    stops.push({ c: col.c, o: col.o, p: round(Math.max(0, Math.min(1, pos))) });
  });
  if (stops.length < 2) return null;
  // CSS angle -> start/end points in the unit box (CSS gradient line length).
  const a = (angle * Math.PI) / 180;
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const W = w || 1;
  const H = h || 1;
  const len = Math.abs(W * sin) + Math.abs(H * cos);
  const dx = (sin * len) / 2 / W;
  const dy = (-cos * len) / 2 / H;
  return { type: "linear", sx: round(0.5 - dx), sy: round(0.5 - dy), ex: round(0.5 + dx), ey: round(0.5 + dy), stops };
}

function parseShadows(str) {
  if (!str || str === "none") return [];
  const out = [];
  for (const part of splitTop(str)) {
    const cm = part.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i);
    const col = cm ? parseColor(cm[1]) : { c: "#000000", o: 0.25 };
    if (!col) continue;
    const rest = (cm ? part.replace(cm[1], "") : part).trim();
    const inset = /\binset\b/.test(rest);
    const nums = rest.replace(/\binset\b/, "").trim().split(/\s+/).map(px);
    out.push({ inset, x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, c: col.c, o: col.o });
  }
  return out;
}

// ---------------------------------------------------------------- naming

function humanize(s) {
  if (!s) return "";
  const t = s.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function nameFor(el, fallback) {
  const dn = el.getAttribute && el.getAttribute("data-name");
  if (dn) return dn.slice(0, 80);
  const tag = el.tagName.toLowerCase();
  const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean)[0];
  if (cls) return humanize(cls);
  const byTag = { header: "Header", footer: "Footer", nav: "Navigation", section: "Section", aside: "Sidebar", main: "Main", button: "Button", ul: "List", ol: "List", li: "List item", form: "Form", article: "Card" };
  return byTag[tag] || fallback;
}

// ---------------------------------------------------------------- text

function isInlineOnly(el, win) {
  let hasText = false;
  const directText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  for (const n of el.childNodes) {
    if (n.nodeType === 3) {
      if (n.textContent.trim()) hasText = true;
    } else if (n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      if (tag === "br") continue;
      if (!INLINE_TAGS.has(tag)) return false;
      const cs = win.getComputedStyle(n);
      if (cs.display === "none") continue;
      if (/flex|grid|block|table/.test(cs.display) && cs.display !== "inline-block") return false;
      if (n.querySelector("svg,img,div,p,ul,ol,h1,h2,h3,h4,h5,h6")) return false;
      // A boxed span on its own (badge, chip, pill) keeps its background as a frame;
      // a highlight inside running text stays a text run.
      if (hasBox(cs) && (cs.display === "inline-block" || !directText)) return false;
      if (n.textContent.trim()) hasText = true;
    } else if (n.nodeType !== 8) {
      return false;
    }
  }
  return hasText;
}

function hasBox(cs) {
  const bg = parseColor(cs.backgroundColor) || (cs.backgroundImage && cs.backgroundImage !== "none");
  const border = px(cs.borderTopWidth) + px(cs.borderRightWidth) + px(cs.borderBottomWidth) + px(cs.borderLeftWidth) > 0;
  const shadow = cs.boxShadow && cs.boxShadow !== "none";
  return Boolean(bg || border || shadow);
}

function textStyle(cs) {
  const fam = cs.fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  const size = px(cs.fontSize);
  const lh = cs.lineHeight === "normal" ? 1.2 : px(cs.lineHeight) / (size || 16);
  const ls = cs.letterSpacing === "normal" ? 0 : px(cs.letterSpacing);
  const deco = (cs.textDecorationLine || "").includes("underline") ? "underline" : (cs.textDecorationLine || "").includes("line-through") ? "line-through" : null;
  const tt = cs.textTransform;
  return {
    family: fam,
    weight: String(cs.fontWeight || 400),
    style: cs.fontStyle === "italic" ? "italic" : "normal",
    size: round(size),
    lineHeight: round(lh),
    letterSpacing: round(ls),
    color: parseColor(cs.color) || { c: "#000000", o: 1 },
    decoration: deco,
    transform: tt === "uppercase" || tt === "lowercase" || tt === "capitalize" ? tt : null,
  };
}

function sameStyle(a, b) {
  return a.family === b.family && a.weight === b.weight && a.style === b.style && a.size === b.size && a.color.c === b.color.c && a.color.o === b.color.o && a.decoration === b.decoration;
}

function collectText(el, win, base) {
  // Returns {chars, runs}; whitespace collapsed like CSS normal flow.
  let chars = "";
  const runs = [];
  const visit = (node, style) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        let t = n.textContent.replace(/\s+/g, " ");
        if (chars.endsWith(" ") || chars.endsWith("\n") || chars === "") t = t.replace(/^ /, "");
        if (!t) continue;
        if (style.transform === "uppercase" && base.transform !== "uppercase") t = t.toUpperCase();
        const start = chars.length;
        chars += t;
        if (!sameStyle(style, base)) runs.push({ start, end: chars.length, ...style });
      } else if (n.nodeType === 1) {
        const tag = n.tagName.toLowerCase();
        if (tag === "br") {
          chars = chars.replace(/ $/, "") + "\n";
          continue;
        }
        const cs = win.getComputedStyle(n);
        if (cs.display === "none") continue;
        visit(n, textStyle(cs));
      }
    }
  };
  visit(el, base);
  const lead = chars.length - chars.replace(/^\s+/, "").length;
  const trimmed = chars.trim();
  const fixed = runs
    .map((r) => ({ ...r, start: Math.max(0, r.start - lead), end: Math.min(trimmed.length, r.end - lead) }))
    .filter((r) => r.end > r.start);
  return { chars: trimmed, runs: fixed };
}

function contentBox(r, cs) {
  const l = px(cs.paddingLeft) + px(cs.borderLeftWidth);
  const t = px(cs.paddingTop) + px(cs.borderTopWidth);
  const rr = px(cs.paddingRight) + px(cs.borderRightWidth);
  const b = px(cs.paddingBottom) + px(cs.borderBottomWidth);
  return { x: r.left + l, y: r.top + t, w: Math.max(0, r.width - l - rr), h: Math.max(0, r.height - t - b) };
}

function textMetrics(el, doc) {
  const range = doc.createRange();
  range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0);
  const box = range.getBoundingClientRect();
  const lines = new Set(rects.map((q) => Math.round(q.top))).size;
  return { box, lines: Math.max(1, lines) };
}

function textNode(el, cs, win, doc, frameBox, name, natural = false) {
  const st = textStyle(cs);
  const { chars, runs } = collectText(el, win, st);
  if (!chars) return null;
  const tm = textMetrics(el, doc);
  const cb = frameBox || contentBox(el.getBoundingClientRect(), cs);
  if (natural) {
    // The label of a button/badge/avatar: its own text box, not the padded box
    // around it. Otherwise the frame looks like it hugs the label and collapses
    // to one line of text in the editor.
    const single1 = tm.lines <= 1;
    return {
      kind: "text",
      name: name || chars.slice(0, 40),
      x: single1 ? round(tm.box.left) : cb.x,
      y: round(tm.box.top),
      w: round(single1 ? tm.box.width + 1 : cb.w),
      h: round(tm.box.height),
      text: { chars, runs, ...st, align: { center: "center", right: "right", end: "right", justify: "justify" }[cs.textAlign] || "left", grow: single1 ? "auto-width" : "auto-height", single: single1 },
    };
  }
  const align = { center: "center", right: "right", end: "right", justify: "justify" }[cs.textAlign] || "left";
  const single = tm.lines <= 1;
  const naturalW = tm.box.width;
  // Auto width only when the text alone defines the box (no wider column).
  const autoW = single && Math.abs(cb.w - naturalW) <= 2;
  return {
    kind: "text",
    name: name || chars.slice(0, 40),
    x: cb.x,
    y: cb.y,
    w: round(autoW ? naturalW + 1 : cb.w),
    h: round(Math.max(cb.h, tm.box.height)),
    text: { chars, runs, ...st, align, grow: autoW ? "auto-width" : "auto-height", single },
  };
}

// ---------------------------------------------------------------- svg

function serializeSvg(el, win) {
  const clone = el.cloneNode(true);
  const color = win.getComputedStyle(el).color;
  const col = parseColor(color);
  const hex = col ? col.c : "#000000";
  const r = el.getBoundingClientRect();
  clone.setAttribute("width", String(Math.round(r.width)));
  clone.setAttribute("height", String(Math.round(r.height)));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.removeAttribute("class");
  clone.removeAttribute("style");
  let s = new XMLSerializer().serializeToString(clone);
  s = s.replace(/currentColor/gi, hex);
  // Stroke icons that rely on inherited presentation attributes.
  const cs = win.getComputedStyle(el);
  if (!/stroke=/.test(s) && cs.stroke && cs.stroke !== "none") s = s.replace("<svg", `<svg stroke="${parseColor(cs.stroke)?.c || hex}"`);
  return s;
}

// ---------------------------------------------------------------- main walk

function visualProps(cs, r) {
  const fills = [];
  const bgImg = cs.backgroundImage;
  if (bgImg && bgImg !== "none") {
    for (const layer of splitTop(bgImg).reverse()) {
      if (/^linear-gradient/i.test(layer)) {
        const g = parseLinearGradient(layer, r.width, r.height);
        if (g) fills.push(g);
      }
    }
  }
  const bg = parseColor(cs.backgroundColor);
  if (bg) fills.unshift({ type: "solid", c: bg.c, o: bg.o });
  const bw = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)];
  const bc = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].map(parseColor);
  const bs = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  const strokes = [];
  const sides = [];
  const uniform = bw.every((w) => w === bw[0]) && bc.every((c) => c && bc[0] && c.c === bc[0].c && c.o === bc[0].o);
  if (bw[0] > 0 && uniform && bs[0] !== "none") {
    strokes.push({ c: bc[0].c, o: bc[0].o, w: bw[0], style: bs[0] === "dashed" ? "dashed" : bs[0] === "dotted" ? "dotted" : "solid" });
  } else {
    ["top", "right", "bottom", "left"].forEach((side, i) => {
      if (bw[i] > 0 && bc[i] && bs[i] !== "none") sides.push({ side, w: bw[i], c: bc[i].c, o: bc[i].o });
    });
  }
  const rad = (v) => {
    if (String(v).includes("%")) return round((parseFloat(v) / 100) * Math.min(r.width, r.height));
    return Math.min(px(v), Math.min(r.width, r.height) / 2);
  };
  const radius = { tl: rad(cs.borderTopLeftRadius), tr: rad(cs.borderTopRightRadius), br: rad(cs.borderBottomRightRadius), bl: rad(cs.borderBottomLeftRadius) };
  const blurM = (cs.filter || "").match(/blur\(([\d.]+)px\)/);
  const bblurM = (cs.backdropFilter || cs.webkitBackdropFilter || "").match(/blur\(([\d.]+)px\)/);
  return {
    fills,
    strokes,
    sides,
    radius,
    shadows: parseShadows(cs.boxShadow),
    opacity: round(px(cs.opacity === "" ? 1 : cs.opacity)),
    blur: blurM ? px(blurM[1]) : 0,
    bgBlur: bblurM ? px(bblurM[1]) : 0,
  };
}

const ALIGN = { "flex-start": "start", start: "start", "self-start": "start", left: "start", normal: "stretch", stretch: "stretch", center: "center", "flex-end": "end", end: "end", "self-end": "end", right: "end", baseline: "start", "first baseline": "start", "last baseline": "end" };
const JUSTIFY = { normal: "start", "flex-start": "start", start: "start", left: "start", center: "center", "flex-end": "end", end: "end", right: "end", "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly", stretch: "start" };

function inFlowChildren(el, win) {
  const out = [];
  for (const c of el.children) {
    const tag = c.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    const cs = win.getComputedStyle(c);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    out.push(c);
  }
  return out;
}

function makeImage(el, cs, r, ox, oy, counter) {
  const v = visualProps(cs, r);
  const desc = el.getAttribute("data-photo") || el.getAttribute("alt") || "photo";
  counter.n++;
  return {
    kind: "image",
    name: `Photo / ${desc.slice(0, 40)}`,
    x: round(r.left - ox),
    y: round(r.top - oy),
    w: round(r.width),
    h: round(r.height),
    radius: v.radius,
    shadows: v.shadows,
    strokes: v.strokes,
    opacity: v.opacity,
    photo: { query: desc, n: counter.n, w: Math.round(r.width), h: Math.round(r.height) },
  };
}

function walk(el, win, doc, ox, oy, counter, depth) {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;
  const cs = win.getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || px(cs.opacity) === 0 && cs.opacity !== "") return null;
  const r = el.getBoundingClientRect();
  const abs = cs.position === "absolute" || cs.position === "fixed";

  if (tag === "svg") {
    if (r.width < 1 || r.height < 1) return null;
    return { kind: "svg", name: nameFor(el, "Icon").replace(/^Svg$/, "Icon"), x: round(r.left - ox), y: round(r.top - oy), w: round(r.width), h: round(r.height), svg: serializeSvg(el, win), abs };
  }
  if (tag === "img" || el.hasAttribute("data-photo")) {
    if (r.width < 1 || r.height < 1) return null;
    const n = makeImage(el, cs, r, ox, oy, counter);
    n.abs = abs;
    return n;
  }

  const v = visualProps(cs, r);
  const kids = inFlowChildren(el, win);
  const inlineOnly = isInlineOnly(el, win);

  if (tag === "input" || tag === "textarea" || tag === "select") {
    // Form controls become a box with their value or placeholder as text.
    const value = (el.value || el.getAttribute("placeholder") || "").trim();
    const node = { kind: "frame", name: nameFor(el, "Input"), x: round(r.left - ox), y: round(r.top - oy), w: round(r.width), h: round(r.height), fills: v.fills, strokes: v.strokes, radius: v.radius, shadows: v.shadows, opacity: v.opacity, clip: true, abs, children: [] };
    if (value) {
      const st = textStyle(cs);
      if (!el.value) st.color = { ...st.color, o: round(st.color.o * 0.55) };
      const cb = contentBox(r, cs);
      node.children.push({ kind: "text", name: el.value ? "Value" : "Placeholder", x: round(cb.x - r.left), y: round(cb.y - r.top), w: round(cb.w), h: round(cb.h), text: { chars: value, runs: [], ...st, align: "left", grow: "auto-height", single: true } });
    }
    node.layout = { dir: "row", wrap: false, rowGap: 0, colGap: 0, pad: [px(cs.paddingTop) + px(cs.borderTopWidth), px(cs.paddingRight) + px(cs.borderRightWidth), px(cs.paddingBottom) + px(cs.borderBottomWidth), px(cs.paddingLeft) + px(cs.borderLeftWidth)].map(round), align: "center", justify: "start" };
    node._grow = px(cs.flexGrow); node._alignSelf = cs.alignSelf; node._margins = [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)];
    return node;
  }

  if (!kids.length && !inlineOnly && !(el.textContent || "").trim()) {
    // Empty decorative box (divider, shape, colour block) -> rectangle.
    // An invisible flex spacer (flex: 1) is kept so the layout still pushes things apart.
    const spacer = px(cs.flexGrow) > 0 && el.parentElement && /flex/.test(win.getComputedStyle(el.parentElement).display);
    if (!spacer && (r.width < 0.5 || r.height < 0.5 || (!v.fills.length && !v.strokes.length && !v.shadows.length))) return null;
    const rect = { kind: "rect", name: nameFor(el, spacer && !v.fills.length ? "Spacer" : "Rectangle"), x: round(r.left - ox), y: round(r.top - oy), w: round(r.width), h: round(r.height), fills: v.fills, strokes: v.strokes, radius: v.radius, shadows: v.shadows, opacity: v.opacity, blur: v.blur, abs };
    rect._grow = px(cs.flexGrow); rect._alignSelf = cs.alignSelf; rect._margins = [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)];
    return rect;
  }

  // Pure text element without a box of its own -> a text layer.
  if (inlineOnly && !hasBox(cs) && px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.paddingLeft) + px(cs.paddingRight) === 0) {
    const t = textNode(el, cs, win, doc, null, el.getAttribute("data-name"));
    if (!t) return null;
    t.x = round(t.x - ox);
    t.y = round(t.y - oy);
    t.abs = abs;
    t.opacity = v.opacity;
    return t;
  }

  if (r.width < 0.5 && r.height < 0.5) return null;

  const node = {
    kind: "frame",
    name: nameFor(el, depth === 0 ? "Screen" : "Frame"),
    x: round(r.left - ox),
    y: round(r.top - oy),
    w: round(r.width),
    h: round(r.height),
    fills: v.fills,
    strokes: v.strokes,
    radius: v.radius,
    shadows: v.shadows,
    opacity: v.opacity,
    blur: v.blur,
    bgBlur: v.bgBlur,
    clip: cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.overflowY === "hidden" || cs.overflow === "clip",
    abs,
    children: [],
  };

  const pad = [
    px(cs.paddingTop) + px(cs.borderTopWidth),
    px(cs.paddingRight) + px(cs.borderRightWidth),
    px(cs.paddingBottom) + px(cs.borderBottomWidth),
    px(cs.paddingLeft) + px(cs.borderLeftWidth),
  ];

  if (inlineOnly) {
    // A button/badge/chip: frame with auto layout around one text layer.
    const cb = contentBox(r, cs);
    const t = textNode(el, cs, win, doc, cb, "Label", true);
    if (t) {
      t.x = round(t.x - r.left);
      t.y = round(t.y - r.top);
      node.children.push(t);
    }
    const align = { center: "center", right: "end", end: "end" }[cs.textAlign] || "start";
    const isFlex = /flex/.test(cs.display);
    node.layout = {
      dir: "row",
      wrap: false,
      rowGap: 0,
      colGap: 0,
      pad,
      align: isFlex ? ALIGN[cs.alignItems] || "center" : "center",
      justify: isFlex ? JUSTIFY[cs.justifyContent] || "start" : align,
    };
  } else {
    for (const k of kids) {
      const c = walk(k, win, doc, r.left, r.top, counter, depth + 1);
      if (c) node.children.push(c);
    }
    const flow = node.children.filter((c) => !c.abs);
    const isFlex = /flex/.test(cs.display);
    if (isFlex || flow.length > 0) {
      let dir = isFlex ? cs.flexDirection : "column";
      if (!isFlex && flow.length > 1) {
        // Inline-level children laid out in a row (e.g. inline-blocks).
        const sameRow = flow.every((c) => Math.abs(c.y - flow[0].y) < 2);
        if (sameRow) dir = "row";
      }
      const rowGap = cs.rowGap === "normal" ? 0 : px(cs.rowGap);
      const colGap = cs.columnGap === "normal" ? 0 : px(cs.columnGap);
      node.layout = {
        dir,
        wrap: isFlex && cs.flexWrap === "wrap",
        rowGap: round(rowGap),
        colGap: round(colGap),
        pad: pad.map(round),
        align: isFlex ? ALIGN[cs.alignItems] || "stretch" : "start",
        justify: isFlex ? JUSTIFY[cs.justifyContent] || "start" : "start",
      };
      if (!isFlex) {
        // Block flow: reproduce the exact vertical spacing with margins.
        const main = dir === "row" ? "x" : "y";
        const size = dir === "row" ? "w" : "h";
        let prevEnd = main === "y" ? pad[0] : pad[3];
        for (const c of flow) {
          const gap = round(c[main] - prevEnd);
          c.marginBefore = gap > 0.5 ? gap : 0;
          prevEnd = c[main] + c[size];
        }
      }
    }
  }

  // Borders on some sides only (dividers): absolute 1px rectangles.
  for (const s of v.sides) {
    const rect = { kind: "rect", name: `Border / ${s.side}`, abs: true, fills: [{ type: "solid", c: s.c, o: s.o }] };
    if (s.side === "top") Object.assign(rect, { x: 0, y: 0, w: node.w, h: s.w });
    if (s.side === "bottom") Object.assign(rect, { x: 0, y: node.h - s.w, w: node.w, h: s.w });
    if (s.side === "left") Object.assign(rect, { x: 0, y: 0, w: s.w, h: node.h });
    if (s.side === "right") Object.assign(rect, { x: node.w - s.w, y: 0, w: s.w, h: node.h });
    node.children.push(rect);
  }

  // Remember flex item facts for sizing inference.
  node._grow = px(cs.flexGrow);
  node._alignSelf = cs.alignSelf;
  node._margins = [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)];
  return node;
}

// ---------------------------------------------------------------- sizing

function hugSize(n) {
  // What the frame's size would be if it hugged its in-flow children.
  const L = n.layout;
  const flow = n.children.filter((c) => !c.abs);
  if (!L) return { w: n.w, h: n.h };
  const pad = L.pad;
  const row = L.dir.startsWith("row");
  const gapMain = row ? L.colGap : L.rowGap;
  let main = 0;
  let cross = 0;
  flow.forEach((c, i) => {
    const m = c.item ? c.item.margin : [0, 0, 0, 0];
    const cm = row ? c.w + m[1] + m[3] : c.h + m[0] + m[2];
    const cc = row ? c.h + m[0] + m[2] : c.w + m[1] + m[3];
    main += cm + (i ? gapMain : 0);
    cross = Math.max(cross, cc);
  });
  if (L.wrap) return { w: n.w, h: n.h };
  return row
    ? { w: main + pad[1] + pad[3], h: cross + pad[0] + pad[2] }
    : { w: cross + pad[1] + pad[3], h: main + pad[0] + pad[2] };
}

function inferSizing(n, parent) {
  for (const c of n.children || []) inferSizing(c, n);
  if (!parent || !parent.layout || n.abs) {
    if (n.abs) n.item = { absolute: true };
    if (n.kind === "frame" && n.layout) {
      const hug = hugSize(n);
      n.self = { h: Math.abs(hug.w - n.w) <= 1.5 ? "auto" : "fix", v: Math.abs(hug.h - n.h) <= 1.5 ? "auto" : "fix" };
    }
    return;
  }
  const L = parent.layout;
  const row = L.dir.startsWith("row");
  const pad = L.pad;
  const contentW = parent.w - pad[1] - pad[3];
  const contentH = parent.h - pad[0] - pad[2];
  const m = n._margins || [0, 0, 0, 0];
  const margin = [0, 0, 0, 0];
  if (n.marginBefore) {
    if (row) margin[3] = n.marginBefore;
    else margin[0] = n.marginBefore;
  } else if (m[0] || m[1] || m[2] || m[3]) {
    margin[0] = m[0]; margin[1] = m[1]; margin[2] = m[2]; margin[3] = m[3];
  }
  // Block-flow children start at the content edge; keep their cross offset.
  if (!row && L.align === "start") {
    const off = round(n.x - pad[3]);
    if (off > 0.5 && n.w + off <= contentW + 0.5 && Math.abs(n.w - contentW) > 1) margin[3] = Math.max(margin[3], off);
  }
  let h = "fix";
  let v = "fix";
  const hug = n.kind === "frame" && n.layout ? hugSize(n) : null;
  const crossStretch = (L.align === "stretch" && (!n._alignSelf || n._alignSelf === "auto" || n._alignSelf === "stretch" || n._alignSelf === "normal")) || n._alignSelf === "stretch";
  if (row) {
    if (n._grow > 0) h = "fill";
    else if (n.kind === "text") h = n.text.grow === "auto-width" ? "auto" : "fix";
    else if (hug && Math.abs(hug.w - n.w) <= 1.5) h = "auto";
    if (crossStretch && Math.abs(n.h + margin[0] + margin[2] - contentH) <= 1.5) v = "fill";
    else if (n.kind === "text") v = "auto";
    else if (hug && Math.abs(hug.h - n.h) <= 1.5) v = "auto";
  } else {
    if (n._grow > 0) v = "fill";
    else if (n.kind === "text") v = "auto";
    else if (hug && Math.abs(hug.h - n.h) <= 1.5) v = "auto";
    // A one-line text that is itself the widest child keeps its own width: making it
    // fill would pin the column to the browser's measure, and the editor's slightly
    // different text metrics then wrap it onto two lines.
    const definesWidth = n.kind === "text" && n.text.grow === "auto-width";
    if (!definesWidth && Math.abs(n.w + margin[1] + margin[3] - contentW) <= 1.5 && (crossStretch || L.align === "start")) h = "fill";
    else if (n.kind === "text") h = n.text.grow === "auto-width" ? "auto" : "fix";
    else if (hug && Math.abs(hug.w - n.w) <= 1.5) h = "auto";
  }
  if (n.kind === "text" && h === "fill") n.text.grow = "auto-height";
  n.item = { h, v, margin, alignSelf: n._alignSelf && ALIGN[n._alignSelf] && n._alignSelf !== "auto" && n._alignSelf !== "normal" ? ALIGN[n._alignSelf] : "auto" };
  if (n.kind === "frame" && n.layout) {
    n.self = { h: h === "auto" ? "auto" : "fix", v: v === "auto" ? "auto" : "fix" };
  }
}

// A frame cannot hug an axis in which a child fills it (Penpot collapses it to
// zero). Fix such axes at the measured size, bottom-up.
function settleHug(n) {
  for (const c of n.children || []) settleHug(c);
  if (n.kind !== "frame" || !n.layout) return;
  const flow = (n.children || []).filter((c) => c.item && !c.item.absolute);
  const fillH = flow.some((c) => c.item.h === "fill");
  const fillV = flow.some((c) => c.item.v === "fill");
  if (!n.self) n.self = { h: "fix", v: "fix" };
  if (fillH && n.self.h === "auto") n.self.h = "fix";
  if (fillV && n.self.v === "auto") n.self.v = "fix";
  if (n.item && !n.item.absolute) {
    if (fillH && n.item.h === "auto") n.item.h = "fix";
    if (fillV && n.item.v === "auto") n.item.v = "fix";
  }
}

function clean(n) {
  delete n._grow;
  delete n._alignSelf;
  delete n._margins;
  delete n.marginBefore;
  for (const c of n.children || []) clean(c);
  return n;
}

function countNodes(n) {
  return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
}

// ---------------------------------------------------------------- entry

export function extractHtml(text) {
  const m = text.match(/```html\s*([\s\S]*?)(```|$)/i);
  let html = m ? m[1] : text;
  html = html.replace(/<\/?(html|body|head)[^>]*>/gi, "").replace(/<!doctype[^>]*>/gi, "");
  return html.trim();
}

export function renderDoc(html, base) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${fontFaces(base)}html,body{margin:0;padding:0;background:transparent;-webkit-font-smoothing:antialiased}body{font-family:"${FAMILY}",sans-serif}*{box-sizing:border-box}h1,h2,h3,h4,h5,h6,p,ul,ol,figure,blockquote{margin:0}ul,ol{padding:0;list-style:none}button,input,select,textarea{font:inherit;color:inherit;letter-spacing:inherit;margin:0}button{padding:0;border:0;background:transparent;text-align:inherit}a{color:inherit;text-decoration:none}img,svg{display:block}img[data-photo]:not([src]){background:linear-gradient(135deg,#d7dde5,#eef1f5)}</style>
</head><body>${html}</body></html>`;
}

export async function htmlToSpec(html, { host, fontBase }) {
  const families = fontFamiliesIn(html);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-30000px;top:0;width:3000px;height:4000px;border:0;visibility:hidden";
  (host || document.body).appendChild(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write(renderDoc(html, fontBase || location.origin));
    doc.close();
    await new Promise((res) => (doc.readyState === "complete" ? res() : frame.addEventListener("load", res, { once: true })));
    try {
      await Promise.race([doc.fonts.ready, new Promise((r) => setTimeout(r, 6000))]);
      await Promise.all([400, 600, 700, 900].map((w) => doc.fonts.load(`${w} 16px "${FAMILY}"`).catch(() => null)));
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) {
      /* fonts optional */
    }
    const win = frame.contentWindow;
    const root = [...doc.body.children].find((c) => !SKIP_TAGS.has(c.tagName.toLowerCase()));
    if (!root) throw new Error("empty design");
    // The root keeps its own width; give the iframe room for it.
    const rw = Math.ceil(root.getBoundingClientRect().width) || 390;
    frame.style.width = `${Math.max(rw, 320)}px`;
    await new Promise((r) => setTimeout(r, 30));
    const rr = root.getBoundingClientRect();
    const counter = { n: 0 };
    const spec = walk(root, win, doc, rr.left, rr.top, counter, 0);
    if (!spec) throw new Error("nothing to convert");
    spec.x = 0;
    spec.y = 0;
    if (spec.kind !== "frame") {
      return { spec: { kind: "frame", name: "Design", x: 0, y: 0, w: spec.w, h: spec.h, fills: [], children: [spec], layout: null }, stats: { nodes: 2, images: counter.n } };
    }
    inferSizing(spec, null);
    settleHug(spec);
    // The root keeps its designed width; its height hugs unless a child fills it.
    spec.self = { h: "fix", v: spec.self && spec.self.v === "auto" ? "auto" : "fix" };
    clean(spec);
    if (!spec.fills.length) spec.fills = [{ type: "solid", c: "#FFFFFF", o: 1 }];
    spec.clip = true;
    return { spec, stats: { nodes: countNodes(spec), images: counter.n, families } };
  } finally {
    frame.remove();
  }
}
