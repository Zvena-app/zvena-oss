;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.common.geom.shapes.flex-layout.baseline
  "zvena: first text baseline of a flex layout child, for Figma's
  \"Align text baseline\" (`:layout-align-items :baseline` on a row)."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes.points :as gpo]
   [app.common.types.shape.layout :as ctl]))

;; Every `position-data` box ends at the text's ideographic baseline (the
;; bottom of the font content area: the svg text renderer draws it with
;; `dominant-baseline: ideographic`). The alphabetic baseline sits above it
;; by the font descent, about a fifth of the content area for common fonts
;; (ascent ~0.8em, descent ~0.2em). Texts set in the same font share the
;; ratio, so they line up exactly.
(def ^:private descent-ratio 0.2)

(defn- text-baseline
  "Distance from the top of a text shape to its first line baseline"
  [shape]
  (let [position-data (get shape :position-data)
        top           (dm/get-in shape [:selrect :y])]
    (when (and (d/not-empty? position-data) (d/num? top))
      (let [baseline
            (reduce (fn [result {:keys [y height]}]
                      (if (d/num? y height)
                        (min result (- y (* descent-ratio height)))
                        result))
                    ##Inf
                    position-data)]
        (when (d/num? baseline)
          (- baseline top))))))

(defn- top-offset
  "Distance along the vertical axis of `container-points` from its top edge
  to the topmost of `points`"
  [container-points points]
  (let [origin (gpo/origin container-points)
        vv     (gpo/start-vv container-points 1)]
    (reduce (fn [result point]
              (min result (gpt/dot (gpt/to-vec origin point) vv)))
            ##Inf
            points)))

(defn- get-points
  "Points of a shape in the bounds map (values are usually delays)"
  [bounds id]
  (let [points (get bounds id)]
    (if (delay? points) @points points)))

(declare shape-baseline)

(defn- container-baseline
  "Baseline of the first child with text: in layout order for flex
  layouts, the topmost one for other boards and groups (as CSS does)."
  [shape bounds objects]
  (when-let [shape-points (get-points bounds (dm/get-prop shape :id))]
    (let [child-points
          (fn [child]
            (get-points bounds (dm/get-prop child :id)))

          children
          (->> (get shape :shapes)
               (keep (d/getf objects))
               (remove :hidden)
               (remove ctl/item-absolute?))

          children
          (if (ctl/flex-layout? shape)
            (cond->> children (not (ctl/reverse? shape)) reverse)
            (sort-by (fn [child]
                       (if-let [points (child-points child)]
                         (top-offset shape-points points)
                         ##Inf))
                     children))]

      (some (fn [child]
              (when-let [points (child-points child)]
                (when-let [baseline (shape-baseline child bounds objects)]
                  (+ (top-offset shape-points points) baseline))))
            children))))

(defn shape-baseline
  "Distance from the top of `shape` to its first text baseline, or nil
  when there is no text inside."
  [shape bounds objects]
  (cond
    (cfh/text-shape? shape)
    (text-baseline shape)

    (or (cfh/frame-shape? shape)
        (cfh/group-shape? shape))
    (container-baseline shape bounds objects)

    :else
    nil))
