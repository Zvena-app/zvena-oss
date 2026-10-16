/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) KALEIDOS INC Sucursal en España SL
 */

"use strict";

goog.provide("app.util.text_position_data");

goog.scope(function () {
  const self = app.util.text_position_data;
  const document = goog.global.document;

  function getRangeRects(node, start, end) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return [...range.getClientRects()].filter((r) => r.width > 0);
  }

  self.parse_text_nodes = function(parent, textNode, textAlign) {
    const content = textNode.textContent;
    const textSize = content.length;

    let from = 0;
    let to = 0;
    let current = "";
    let result = [];
    let prevRect = null;

    // This variable is to make sure there are not infinite loops
    // when we don't advance `to` we store true and then force to
    // advance `to` on the next iteration if the condition is true again
    let safeguard = false;

    while (to < textSize) {
      const rects = getRangeRects(textNode, from, to + 1);
      const splitByWords = textAlign == "justify" && content[to].trim() == "";

      if (rects.length > 1 && safeguard) {
        from++;
        to++;
        safeguard = false;

      } else if (rects.length > 1 || splitByWords) {
        const position = prevRect;

        result.push({
          node: parent,
          position: position,
          text: current
        });

        if (splitByWords) {
          to++;
        }

        from = to;
        current = "";
        safeguard = true;
      } else {
        prevRect = rects[0];
        current += content[to];
        to = to + 1;
        safeguard = false;
      }
    }

    // to == textSize
    const rects = getRangeRects(textNode, from, to);
    result.push({node: parent, position: rects[0], text: current});
    return result;
  };

  // --------------------------------------------------------------------
  // zvena: Figma "Truncate text" (+ "Max lines").
  //
  // The HTML layout keeps the paragraph set inside the box (max-height) or
  // inside "Max lines" (-webkit-line-clamp), see
  // app.main.ui.shapes.text.styles/generate-paragraph-set-styles. Its bottom
  // edge is the cut line: every line whose box goes below it is hidden and
  // the last visible line ends with an ellipsis. The SVG renderer draws the
  // position-data, so the cut is done on the DOM before it is measured: the
  // paragraph set is swapped for a truncated clone (React keeps owning the
  // original, which is put back right after measuring).
  // --------------------------------------------------------------------

  const ELLIPSIS = "…";
  const CUT_TOLERANCE = 0.5;

  function contentTextNodes(container) {
    const result = [];
    const spans = container.querySelectorAll(".text-node");
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (span.classList.contains("list-marker")) {
        continue;
      }
      const children = span.childNodes;
      for (let j = 0; j < children.length; j++) {
        if (children[j].nodeType === Node.TEXT_NODE) {
          result.push(children[j]);
        }
      }
    }
    return result;
  }

  function lineHeightOf(textNode) {
    const element = textNode.parentElement;
    if (!element) return null;
    const value = parseFloat(goog.global.getComputedStyle(element).lineHeight);
    return isNaN(value) ? null : value;
  }

  function charRect(textNode, index) {
    const range = document.createRange();
    range.setStart(textNode, index);
    range.setEnd(textNode, index + 1);
    const rects = range.getClientRects();
    let result = null;
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (rect.width > 0 || (result === null && rect.height > 0)) {
        result = rect;
      }
    }
    return result;
  }

  // Bottom of the line box of a character: the glyph box is centered in the
  // line-height box (half-leading), so center + line-height / 2.
  function lineBottom(rect, lineHeight) {
    const half = lineHeight !== null ? lineHeight / 2 : rect.height / 2;
    return rect.top + rect.height / 2 + half;
  }

  // true: below the cut, false: visible, null: no box to tell.
  function isHidden(textNode, index, cutoff, lineHeight) {
    const rect = charRect(textNode, index);
    if (rect === null) return null;
    return lineBottom(rect, lineHeight) > cutoff + CUT_TOLERANCE;
  }

  function findCut(nodes, cutoff) {
    for (let k = 0; k < nodes.length; k++) {
      const node = nodes[k];
      const length = node.length;
      if (length === 0) continue;
      const lineHeight = lineHeightOf(node);
      // The text flows downwards: if the last character is visible the
      // whole node is.
      if (isHidden(node, length - 1, cutoff, lineHeight) === false) continue;
      for (let index = 0; index < length; index++) {
        if (isHidden(node, index, cutoff, lineHeight) === true) {
          // Never split a surrogate pair
          const code = node.data.charCodeAt(index);
          if (index > 0 && code >= 0xdc00 && code <= 0xdfff) {
            return { node: k, index: index - 1 };
          }
          return { node: k, index: index };
        }
      }
    }
    return null;
  }

  function lastNonEmpty(nodes, from) {
    for (let k = from; k >= 0; k--) {
      if (nodes[k].length > 0) return k;
    }
    return -1;
  }

  function trimEnd(text) {
    return text.replace(/\s+$/, "");
  }

  function dropLastChar(text) {
    if (text.length >= 2) {
      const code = text.charCodeAt(text.length - 1);
      if (code >= 0xdc00 && code <= 0xdfff) {
        return text.slice(0, -2);
      }
    }
    return text.slice(0, -1);
  }

  function hasText(paragraph) {
    const nodes = contentTextNodes(paragraph);
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].length > 0) return true;
    }
    return false;
  }

  function truncate(container, cutoff) {
    const nodes = contentTextNodes(container);
    const first = nodes.findIndex((node) => node.length > 0);
    if (first < 0) return false;

    let cut = findCut(nodes, cutoff);
    if (cut === null) return false;

    // Figma always keeps the first line, even if the box is shorter.
    if (cut.node === first && cut.index === 0) {
      const rect = charRect(nodes[first], 0);
      if (rect === null) return false;
      cutoff = lineBottom(rect, lineHeightOf(nodes[first]));
      cut = findCut(nodes, cutoff);
      if (cut === null) return false;
    }

    // 1. Drop everything from the cut on.
    const cutNode = nodes[cut.node];
    cutNode.data = cutNode.data.slice(0, cut.index);
    for (let k = cut.node + 1; k < nodes.length; k++) {
      nodes[k].data = "";
    }

    const paragraphs = container.querySelectorAll(".paragraph");
    const cutParagraph = cutNode.parentElement
      ? cutNode.parentElement.closest(".paragraph")
      : null;
    let hide = false;
    let lastVisible = null;
    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      if (hide || (paragraph === cutParagraph && !hasText(paragraph))) {
        paragraph.style.display = "none";
        hide = true;
      } else {
        lastVisible = paragraph;
      }
      if (paragraph === cutParagraph) {
        hide = true;
      }
    }
    // The last visible paragraph has no paragraph spacing after it.
    if (lastVisible !== null) {
      lastVisible.style.marginBottom = "0px";
    }

    // 2. End the last visible line with an ellipsis that fits on it.
    let k = lastNonEmpty(nodes, cut.node);
    if (k < 0) return true;
    let node = nodes[k];
    node.data = trimEnd(node.data) + ELLIPSIS;

    for (let guard = 0; guard < 10000; guard++) {
      if (isHidden(node, node.length - 1, cutoff, lineHeightOf(node)) !== true) {
        break;
      }
      const text = dropLastChar(node.data); // without the ellipsis
      if (text.length === 0) {
        node.data = "";
        k = lastNonEmpty(nodes, k - 1);
        if (k < 0) break;
        node = nodes[k];
        node.data = trimEnd(node.data) + ELLIPSIS;
      } else {
        node.data = trimEnd(dropLastChar(text)) + ELLIPSIS;
      }
    }
    return true;
  }

  /**
   * Truncates the text layout of `root` (a `.text-node-html` element).
   * Returns a function restoring the original DOM, or null when there is
   * nothing to cut.
   */
  self.truncate_layout = function (root) {
    const paragraphSet = root ? root.querySelector(".paragraph-set") : null;
    if (!paragraphSet) return null;

    let cutoff = paragraphSet.getBoundingClientRect().bottom;

    // Cheap check on the original: is the last character below the cut?
    const nodes = contentTextNodes(paragraphSet);
    const last = lastNonEmpty(nodes, nodes.length - 1);
    if (last < 0) return null;
    const lastNode = nodes[last];

    // zvena: with "Vertical trim" (CSS text-box-trim) the box ends at the
    // baseline of its last line, so a visible line goes below the cut by
    // its trimmed descent (less than half a line).
    if (root.dataset && root.dataset.verticalTrim === "true" &&
        goog.global.CSS && goog.global.CSS.supports &&
        goog.global.CSS.supports("text-box-trim", "trim-both")) {
      const lineHeight = lineHeightOf(lastNode);
      if (lineHeight !== null) {
        cutoff += lineHeight / 2;
      }
    }
    if (isHidden(lastNode, lastNode.length - 1, cutoff, lineHeightOf(lastNode)) === false) {
      return null;
    }

    const clone = paragraphSet.cloneNode(true);
    paragraphSet.replaceWith(clone);
    const restore = function () {
      clone.replaceWith(paragraphSet);
    };

    try {
      if (!truncate(clone, cutoff)) {
        restore();
        return null;
      }
    } catch (cause) {
      restore();
      throw cause;
    }
    return restore;
  };
});
