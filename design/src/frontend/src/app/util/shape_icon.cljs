;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.util.shape-icon
  (:require
   [app.common.data.macros :as dm]
   [app.common.types.component :as ctk]
   [app.common.types.shape :as cts]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.shape.zvena :as ctsz]
   [app.common.types.zvena-slot :as zslot]))

(defn- get-bool-icon
  "Returns the icon for a boolean shape"
  [shape]
  (case (get shape :bool-type)
    :difference   "boolean-difference"
    :exclude      "boolean-exclude"
    :intersection "boolean-intersection"
    :union        "boolean-union"
    nil))

(defn- get-frame-icon
  "Returns the icon for a frame shape"
  [shape]
  (cond
    ;; zvena: Figma sections
    (ctsz/section? shape)
    "section"

    ;; zvena: Figma slots (app.common.types.zvena-slot)
    (zslot/slot? shape)
    "slot"

    (ctk/is-variant-container? shape)
    "component"

    (and (ctl/flex-layout? shape) (ctl/col? shape))
    "flex-horizontal"

    (and (ctl/flex-layout? shape) (ctl/row? shape))
    "flex-vertical"

    (ctl/grid-layout? shape)
    "flex-grid"

    :else
    "board"))

(defn get-shape-icon
  "Returns the icon for a shape based on its type and properties"
  [shape]
  (if (ctk/instance-head? shape)
    (if (ctk/main-instance? shape)
      (if (ctk/is-variant? shape)
        "variant"
        "component")
      "component-copy")
    (case (dm/get-prop shape :type)
      :frame (get-frame-icon shape)
      :image "img"
      :line (if (cts/has-images? shape)
              "img"
              "rectangle")
      :circle (if (cts/has-images? shape)
                "img"
                "ellipse")
      :path (cond
              (cts/has-images? shape) "img"
              ;; zvena: ellipse arcs, polygons and stars keep their icons
              :else (case (ctsz/get-data shape "shape")
                      "ellipse" "ellipse"
                      "polygon" "polygon"
                      "star"    "star"
                      "path"))
      :rect (cond
              ;; zvena: Figma slices
              (ctsz/slice? shape) "slice"
              (cts/has-images? shape) "img"
              :else "rectangle")
      :text "text"
      :group (if (:masked-group shape)
               "mask"
               "group")
      :bool (get-bool-icon shape)
      :svg-raw "img"
      nil)))

(defn get-shape-icon-by-type
  "Returns the icon for a shape based on its type"
  [type]
  (if (= type :component)
    "component"
    (case type
      :frame "board"
      :image "img"
      :shape "path"
      :text "text"
      :mask "mask"
      :group "group"
      nil)))
