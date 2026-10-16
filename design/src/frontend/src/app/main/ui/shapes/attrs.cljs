;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.shapes.attrs
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.math :as mth]
   [app.common.files.helpers :as cfh]
   [app.common.geom.shapes :as gsh]
   [app.common.json :as json]
   [app.common.svg :as csvg]
   [app.common.types.color :as clr]
   [app.common.types.shape :refer [stroke-caps-line stroke-caps-marker]]
   [app.common.types.shape.radius :as ctsr]
   [app.common.types.shape.zvena-effects :as zfx] ;; zvena
   [app.util.object :as obj]
   [cuerdas.core :as str]))

(defn- calculate-dasharray
  [style width dash gap]
  (let [w+5  (+ 5 width)
        w+1  (+ 1 width)
        w+10 (+ 10 width)]
    (case style
      :mixed  (str/concat "" w+5 "," w+5 "," w+1 "," w+5)
      :dotted (str/concat "0," w+5)
      :dashed (str/concat "" (or dash w+10) "," (or gap w+10))
      "")))

(defn- get-border-props*
  [shape]
  (case (ctsr/radius-mode shape)
    :radius-1
    (let [radius (gsh/shape-corners-1 shape)]
      #js {:rx radius :ry radius})

    :radius-4
    (let [[r1 r2 r3 r4] (gsh/shape-corners-4 shape)
          x      (dm/get-prop shape :x)
          y      (dm/get-prop shape :y)
          width  (dm/get-prop shape :width)
          height (dm/get-prop shape :height)
          top    (- width r1 r2)
          right  (- height r2 r3)
          bottom (- width r3 r4)
          left   (- height r4 r1)]
      #js {:d (dm/str
               "M" (+ x r1) "," y " "
               "h" top " "
               "a" r2 "," r2 " 0 0 1 " r2 "," r2 " "
               "v" right " "
               "a" r3 "," r3 " 0 0 1 " (- r3) "," r3 " "
               "h" (- bottom) " "
               "a" r4 "," r4 " 0 0 1 " (- r4) "," (- r4) " "
               "v" (- left) " "
               "a" r1 "," r1 " 0 0 1 " r1 "," (- r1) " "
               "z")})))

(defn corner-smoothing
  "zvena: Figma's corner smoothing (0..1) of a layer, from its zvena
  plugin data (set in the radius panel or by the Figma import)."
  [shape]
  (let [v (or (dm/get-in shape [:plugin-data :zvena "smoothing"])
              (dm/get-in shape [:plugin-data :shared/zvena "smoothing"]))
        v (when (string? v) (js/parseFloat v))]
    (if (and (number? v) (not (js/isNaN v)))
      (mth/clamp v 0 1)
      0)))

(defn- smooth-corner
  "Path parameters of one smoothed corner (Figma's squircle, after
  figma-squircle by Phong Pham, MIT)."
  [radius smoothing budget]
  (let [radius    (min radius budget)
        p         (min (* (+ 1 smoothing) radius) budget)
        smoothing (if (pos? radius) (min smoothing (- (/ budget radius) 1)) 0)
        rad       (fn [deg] (* deg (/ js/Math.PI 180)))
        arc       (* 90 (- 1 smoothing))
        arc-len   (* (js/Math.sin (rad (/ arc 2))) radius (js/Math.sqrt 2))
        alpha     (/ (- 90 arc) 2)
        p3-p4     (* radius (js/Math.tan (rad (/ alpha 2))))
        beta      (* 45 smoothing)
        c         (* p3-p4 (js/Math.cos (rad beta)))
        d         (* c (js/Math.tan (rad beta)))
        b         (/ (- p arc-len c d) 3)
        a         (* 2 b)]
    {:r radius :p p :a a :b b :c c :d d :l arc-len}))

(defn smooth-rect-path
  [x y width height [r1 r2 r3 r4] smoothing]
  (let [budget (/ (min width height) 2)
        tl (smooth-corner r1 smoothing budget)
        tr (smooth-corner r2 smoothing budget)
        br (smooth-corner r3 smoothing budget)
        bl (smooth-corner r4 smoothing budget)
        corner
        (fn [{:keys [r p a b c d l]} sx sy horizontal?]
          ;; sx/sy: direction of travel; horizontal? whether the corner
          ;; starts along a horizontal edge
          (if (pos? r)
            (if horizontal?
              (dm/str "c" (* sx a) ",0 " (* sx (+ a b)) ",0 " (* sx (+ a b c)) "," (* sy d) " "
                      "a" r "," r " 0 0 1 " (* sx l) "," (* sy l) " "
                      "c" (* sx d) "," (* sy c) " " (* sx d) "," (* sy (+ b c)) " " (* sx d) "," (* sy (+ a b c)) " ")
              (dm/str "c0," (* sy a) " 0," (* sy (+ a b)) " " (* sx d) "," (* sy (+ a b c)) " "
                      "a" r "," r " 0 0 1 " (* sx l) "," (* sy l) " "
                      "c" (* sx c) "," (* sy d) " " (* sx (+ b c)) "," (* sy d) " " (* sx (+ a b c)) "," (* sy d) " "))
            (if horizontal?
              (dm/str "l" (* sx p) ",0 l0," (* sy p) " ")
              (dm/str "l0," (* sy p) " l" (* sx p) ",0 "))))]
    (dm/str "M" (+ x (- width (:p tr))) "," y " "
            (corner tr 1 1 true)
            "L" (+ x width) "," (+ y (- height (:p br))) " "
            (corner br -1 1 false)
            "L" (+ x (:p bl)) "," (+ y height) " "
            (corner bl -1 -1 true)
            "L" x "," (+ y (:p tl)) " "
            (corner tl 1 -1 false)
            "Z")))

(defn get-border-props
  [shape]
  (let [smoothing (corner-smoothing shape)]
    (if (and (pos? smoothing) (not= :radius-0 (ctsr/radius-mode shape))
             (some pos? (gsh/shape-corners-4 shape)))
      #js {:d (smooth-rect-path (dm/get-prop shape :x) (dm/get-prop shape :y)
                                (dm/get-prop shape :width) (dm/get-prop shape :height)
                                (gsh/shape-corners-4 shape) smoothing)}
      (get-border-props* shape))))

(defn add-border-props!
  [props shape]
  (obj/merge! props (get-border-props shape)))

(defn add-fill!
  ([attrs fill-data render-id index type]
   (add-fill! attrs fill-data render-id index type "none"))
  ([attrs fill-data render-id index type fill-default]
   (let [index (if (some? index) (dm/str "-" index) "")]
     (cond
       (contains? fill-data :fill-image)
       (let [id (dm/str "fill-image-" render-id)]
         (obj/set! attrs "fill" (dm/str "url(#" id ")")))

       (some? (:fill-color-gradient fill-data))
       (let [id (dm/str "fill-color-gradient-" render-id index)]
         (obj/set! attrs "fill" (dm/str "url(#" id ")")))

       (contains? fill-data :fill-color)
       (obj/set! attrs "fill" (:fill-color fill-data))

       :else
       (obj/set! attrs "fill" fill-default))

     (when (contains? fill-data :fill-opacity)
       (obj/set! attrs "fillOpacity" (:fill-opacity fill-data)))

     (when (and (= :text type)
                (nil? (:fill-color-gradient fill-data))
                (nil? (:fill-color fill-data)))
       (obj/set! attrs "fill" "black"))

     attrs)))

(defn add-stroke!
  [attrs data render-id index open-path?]
  (let [style (:stroke-style data :solid)]
    (when-not (= style :none)
      (let [width       (:stroke-width data 1)
            dash        (:stroke-dash data)
            gap         (:stroke-gap data)
            gradient    (:stroke-color-gradient data)
            color       (:stroke-color data)
            opacity     (:stroke-opacity data)]

        (obj/set! attrs "strokeWidth" width)

        (if (some? gradient)
          (let [gradient-id (dm/str "stroke-color-gradient-" render-id "-" index)]
            (obj/set! attrs "stroke" (str/ffmt "url(#%)" gradient-id)))

          (when (some? color)
            (obj/set! attrs "stroke" color)))

        (when (some? opacity)
          (obj/set! attrs "strokeOpacity" opacity))

        (when (not= style :svg)
          (obj/set! attrs "strokeDasharray" (calculate-dasharray style width dash gap)))

        ;; For simple line caps we use svg stroke-line-cap attribute. This
        ;; only works if all caps are the same and we are not using the tricks
        ;; for inner or outer strokes.
        (let [caps-start (:stroke-cap-start data)
              caps-end   (:stroke-cap-end data)
              alignment  (:stroke-alignment data)]
          (cond
            (and (contains? stroke-caps-line caps-start)
                 (= caps-start caps-end)
                 (or open-path?
                     (and (not= :inner alignment)
                          (not= :outer alignment)))
                 (not= :dotted style))
            (obj/set! attrs "strokeLinecap" (name caps-start))

            (= :dotted style)
            (obj/set! attrs "strokeLinecap" "round"))

          (when (or open-path?
                    (and (not= :inner alignment)
                         (not= :outer alignment)))

            ;; For other cap types we use markers.
            (when (or (contains? stroke-caps-marker caps-start)
                      (and (contains? stroke-caps-line caps-start)
                           (not= caps-start caps-end)))
              (obj/set! attrs "markerStart" (str/ffmt "url(#marker-%-%)" render-id (name caps-start))))

            (when (or (contains? stroke-caps-marker caps-end)
                      (and (contains? stroke-caps-line caps-end)
                           (not= caps-start caps-end)))
              (obj/set! attrs "markerEnd" (str/ffmt "url(#marker-%-%)" render-id (name caps-end))))))))

    attrs))

(defn get-svg-props
  [shape render-id]
  (let [attrs (get shape :svg-attrs {})
        defs  (get shape :svg-defs {})]

    (if (and (empty? defs)
             (empty? attrs))
      #js {}
      (-> attrs
          (csvg/update-attr-ids
           (fn [id]
             (if (contains? defs id)
               (dm/str render-id "-" id)
               id)))
          (dissoc :id)
          (json/->js :key-fn name)))))

(defn get-fill-style
  ([fill-data index render-id type]
   (add-fill! #js {} fill-data render-id index type))
  ([fill-data index render-id type fill-default]
   (add-fill! #js {} fill-data render-id index type fill-default)))

(defn add-fill-props!
  ([props shape render-id]
   (add-fill-props! props shape 0 render-id))

  ([props shape position render-id]
   (let [shape-fills  (get shape :fills)
         shape-shadow (get shape :shadow)

         shape-blur   (get shape :blur)

         svg-attrs    (get-svg-props shape render-id)
         svg-styles   (obj/get svg-attrs "style")

         shape-type   (dm/get-prop shape :type)

         style        (-> (obj/get props "style")
                          (obj/clone)
                          (obj/merge! svg-styles))

         url-fill?    (or ^boolean (some? (:fill-image shape))
                          ^boolean (cfh/image-shape? shape)
                          ^boolean (> (count shape-fills) 1)
                          ^boolean (some? (some :fill-color-gradient shape-fills))
                          ^boolean (some? (some :fill-image shape-fills)))

         props        (if (cfh/frame-shape? shape)
                        props
                        (if (or (some? (->> shape-shadow (remove :hidden) seq))
                                (and (some? shape-blur) (not ^boolean (:hidden shape-blur)))
                                ;; zvena: Figma's noise / texture
                                ^boolean (zfx/has-render-effects? shape))
                          (obj/set! props "filter" (dm/fmt "url(#filter-%)" render-id))
                          props))]

     (cond
       ;; If the shape comes from an imported SVG (we know because
       ;; it has the :svg-attrs atribute), and it does not have an
       ;; own fill, we set a default black fill. This will be
       ;; inherited by child nodes, and is for emulating the
       ;; behavior of standard SVG, in that a node that has no
       ;; explicit fill has a default fill of black. This may be
       ;; reset to normal if a Penpot frame shape appears below
       ;; (see main.ui.shapes.frame/frame-container).
       (and ^boolean (contains? shape :svg-attrs)
            ^boolean (or ^boolean (= :svg-raw shape-type)
                         ^boolean (= :group shape-type))
            ^boolean (empty? shape-fills))
       (let [wstyle (get shape :wrapper-styles)
             fill   (obj/get wstyle "fill")
             fill   (d/nilv fill clr/black)]
         (obj/set! style "fill" fill))

       ^boolean url-fill?
       (do
         (obj/unset! style "fill")
         (obj/unset! style "fillOpacity")
         (obj/set! props "fill" (dm/fmt "url(#fill-%-%)" position render-id)))

       (and ^boolean (some? svg-styles)
            ^boolean (obj/contains? svg-styles "fill"))
       (let [fill    (obj/get svg-styles "fill")
             opacity (obj/get svg-styles "fillOpacity")]
         (when (some? fill)
           (obj/set! style "fill" fill))
         (when (some? opacity)
           (obj/set! style "fillOpacity" opacity)))

       (and ^boolean (some? svg-attrs)
            ^boolean (empty? shape-fills))
       (let [fill    (obj/get svg-attrs "fill")
             opacity (obj/get svg-attrs "fillOpacity")]
         (when (some? fill)
           (obj/set! style "fill" fill))
         (when (some? opacity)
           (obj/set! style "fillOpacity" opacity)))

       ^boolean (d/not-empty? shape-fills)
       (let [fill (nth shape-fills 0)
             svg-fill (obj/get svg-attrs "fill")
             fill-default (d/nilv svg-fill "none")]
         (obj/merge! style (get-fill-style fill render-id 0 shape-type fill-default)))

       (and ^boolean (cfh/path-shape? shape)
            ^boolean (empty? shape-fills))
       (obj/set! style "fill" "none"))

     (-> props
         (obj/merge! svg-attrs)
         (obj/set! "style" style)))))
