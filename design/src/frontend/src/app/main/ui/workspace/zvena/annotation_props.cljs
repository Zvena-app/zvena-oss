;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.annotation-props
  "zvena: the properties a Dev Mode annotation can pin (as in Figma) and
  their live values on the annotated layer, so a pinned property always
  shows the current value."
  (:require
   [app.common.types.text :as txt]
   [app.main.ui.formats :as fmt]
   [app.util.i18n :refer [tr]]
   [clojure.string :as str]))

(def all-props
  ["width" "height" "fill" "stroke" "radius" "opacity" "font" "padding" "gap"])

(defn prop-label
  [prop]
  (case prop
    "width"   (tr "zvena.devmode.prop.width")
    "height"  (tr "zvena.devmode.prop.height")
    "fill"    (tr "zvena.devmode.prop.fill")
    "stroke"  (tr "zvena.devmode.prop.stroke")
    "radius"  (tr "zvena.devmode.prop.radius")
    "opacity" (tr "zvena.devmode.prop.opacity")
    "font"    (tr "zvena.devmode.prop.font")
    "padding" (tr "zvena.devmode.prop.padding")
    "gap"     (tr "zvena.devmode.prop.gap")
    prop))

(defn- percent
  [value]
  (when (number? value)
    (str (fmt/format-number (* 100 value) {:precision 0}) "%")))

(defn- color-str
  [color opacity]
  (when (string? color)
    (let [color (str/upper-case color)]
      (if (and (number? opacity) (< opacity 1))
        (str color " " (percent opacity))
        color))))

(defn- fill-str
  [{:keys [fill-color fill-opacity fill-color-gradient fill-image]}]
  (cond
    (some? fill-color)          (color-str fill-color fill-opacity)
    (some? fill-color-gradient) (tr "zvena.devmode.prop.gradient")
    (some? fill-image)          (tr "zvena.devmode.prop.image")
    :else                       nil))

(defn prop-value
  "The current value of `prop` on `shape` as display text, nil when the
  layer has no such property."
  [shape prop]
  (case prop
    "width"
    (fmt/format-pixels (:width shape))

    "height"
    (fmt/format-pixels (:height shape))

    "fill"
    (some-> (:fills shape) seq first fill-str)

    "stroke"
    (when-let [stroke (some-> (:strokes shape) seq first)]
      (str/trim (str (fmt/format-pixels (:stroke-width stroke)) " "
                     (or (color-str (:stroke-color stroke) (:stroke-opacity stroke)) ""))))

    "radius"
    (let [radii (into [] (keep #(get shape %)) [:r1 :r2 :r3 :r4])]
      (when (seq radii)
        (if (apply = radii)
          (fmt/format-pixels (first radii))
          (str/join " " (map fmt/format-pixels radii)))))

    "opacity"
    (percent (if (number? (:opacity shape)) (:opacity shape) 1))

    "font"
    (when (= :text (:type shape))
      (when-let [node (first (txt/node-seq txt/is-text-node? (:content shape)))]
        (not-empty
         (str/join " " (remove str/blank?
                               [(str (:font-family node))
                                (some-> (:font-size node) (str "px"))
                                (str (:font-weight node))])))))

    "padding"
    (when (some? (:layout shape))
      (let [{:keys [p1 p2 p3 p4]} (:layout-padding shape)]
        (str/join " " (map #(fmt/format-pixels (or % 0)) [p1 p2 p3 p4]))))

    "gap"
    (when (some? (:layout shape))
      (let [{:keys [row-gap column-gap]} (:layout-gap shape)]
        (str (fmt/format-pixels (or row-gap 0)) " / " (fmt/format-pixels (or column-gap 0)))))

    nil))

(defn applicable-props
  "The properties `shape` has, in Figma's order."
  [shape]
  (filterv #(some? (prop-value shape %)) all-props))
