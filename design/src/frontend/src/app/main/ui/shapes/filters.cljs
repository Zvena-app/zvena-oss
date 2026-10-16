;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.shapes.filters
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.geom.shapes.bounds :as gsb]
   [app.common.math :as mth]
   [app.common.types.color :as cc]
   [app.common.types.shape.zvena-effects :as zfx] ;; zvena
   [app.common.uuid :as uuid]
   [app.main.ui.shapes.zvena-effects :as zfxr] ;; zvena
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn get-filter-id []
  (dm/str "filter-" (uuid/next)))

(defn filter-str
  [filter-id shape]
  (when (or (seq (->> (:shadow shape) (remove :hidden)))
            (and (:blur shape)
                 (-> shape :blur :hidden not)
                 (= :layer-blur (-> shape :blur :type)))
            ;; zvena: Figma's noise / texture are steps of the same filter
            (zfx/has-render-effects? shape))
    (str/ffmt "url(#%)" filter-id)))

(mf/defc color-matrix*
  [{:keys [color]}]
  (let [{:keys [color opacity]} color
        [r g b a] (cc/hex->rgba color opacity)
        [r g b] [(/ r 255) (/ g 255) (/ b 255)]]
    [:feColorMatrix
     {:type "matrix"
      :values (str/ffmt "0 0 0 0 % 0 0 0 0 % 0 0 0 0 % 0 0 0 % 0" r g b a)}]))

(mf/defc drop-shadow-filter*
  [{:keys [filter-in filter-id params]}]

  (let [{:keys [color offset-x offset-y blur spread]} params]
    [:*
     [:feColorMatrix {:in "SourceAlpha" :type "matrix"
                      :values "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"}]
     (when (> spread 0)
       [:feMorphology {:radius spread
                       :operator "dilate"
                       :in "SourceAlpha"
                       :result filter-id}])

     (when (< spread 0)
       [:feMorphology {:radius (- spread)
                       :operator "erode"
                       :in "SourceAlpha"
                       :result filter-id}])

     [:feOffset {:dx offset-x :dy offset-y}]
     [:feGaussianBlur {:stdDeviation (/ blur 2)}]
     [:> color-matrix* {:color color}]

     ;; zvena: Figma's "Show behind transparent areas" unchecked: the
     ;; layer knocks the shadow out (shadows without the flag: as before)
     (when-not (zfx/shadow-show-behind? params)
       [:feComposite {:operator "out" :in2 "SourceAlpha"}])

     [:feBlend {:mode "normal"
                :in2 filter-in
                :result filter-id}]]))

(mf/defc inner-shadow-filter*
  [{:keys [filter-in filter-id params]}]

  (let [{:keys [color offset-x offset-y blur spread]} params]
    [:*
     [:feColorMatrix {:in "SourceAlpha" :type "matrix"
                      :values "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                      :result "hardAlpha"}]

     (when (> spread 0)
       [:feMorphology {:radius spread
                       :operator "erode"
                       :in "SourceAlpha"
                       :result filter-id}])

     [:feOffset {:dx offset-x :dy offset-y}]
     [:feGaussianBlur {:stdDeviation (/ blur 2)}]

     [:feComposite {:in2 "hardAlpha"
                    :operator "arithmetic"
                    :k2 "-1"
                    :k3 "1"}]

     [:> color-matrix* {:color color}]

     [:feBlend {:mode "normal"
                :in2 filter-in
                :result filter-id}]]))

(mf/defc background-blur-filter*
  [{:keys [filter-id params]}]
  [:*
   [:feGaussianBlur {:in "BackgroundImage"
                     :stdDeviation (/ (:value params) 2)}]
   [:feComposite {:in2 "SourceAlpha"
                  :operator "in"
                  :result filter-id}]])

(mf/defc layer-blur-filter*
  [{:keys [filter-id params]}]

  [:feGaussianBlur {:stdDeviation (:value params)
                    :result filter-id}])

(mf/defc image-fix-filter* [{:keys [filter-id]}]
  [:feFlood {:flood-opacity 0 :result filter-id}])

(mf/defc blend-filters* [{:keys [filter-id filter-in params]}]
  ;; zvena: Figma's texture roughens the layer's graphic
  (if-let [texture (:zvena-texture params)]
    [:> zfxr/texture-blend* {:filter-id filter-id
                             :filter-in filter-in
                             :texture texture}]
    [:feBlend {:mode "normal"
               :in "SourceGraphic"
               :in2 filter-in
               :result filter-id}]))

(mf/defc filter-entry* [{:keys [entry]}]
  ;; zvena: the filter components read `filterId` / `filterIn` (rumext
  ;; props of `*` components); with "filter-id" keys every step lost its
  ;; result name and its second input, so only the last drop shadow was
  ;; drawn and an inner shadow replaced the layer itself
  (let [props #js {:filterId (:id entry)
                   :filterIn (:filter-in entry)
                   :params (:params entry)}]
    (case (:type entry)
      :drop-shadow [:> drop-shadow-filter* props]
      :inner-shadow [:> inner-shadow-filter* props]
      :background-blur [:> background-blur-filter* props]
      :layer-blur [:> layer-blur-filter* props]
      :image-fix [:> image-fix-filter* props]
      :blend-filters [:> blend-filters* props]
      :zvena-noise [:> zfxr/noise-filter* props] ;; zvena
      nil)))

(defn change-filter-in
  "Adds the previous filter as `filter-in` parameter"
  [filters]
  (map #(assoc %1 :filter-in %2) filters (cons nil (map :id filters))))

(defn- add-zvena-filters
  "zvena: Figma's texture (on the step that draws the layer) and noise
  (over the layer and its inner shadows, under the layer blur)."
  [filters shape]
  (let [texture (zfx/visible-texture shape)
        noise   (zfx/visible-noise shape)]
    (if (and (nil? texture) (nil? noise))
      filters
      (let [filters (cond->> filters
                      (some? texture)
                      (mapv #(if (= :blend-filters (:type %))
                               (assoc % :params {:zvena-texture texture})
                               %)))
            [before after] (split-with #(not= :layer-blur (:type %)) filters)]
        (if (some? noise)
          (-> (vec before)
              (conj {:id "zvena-noise" :type :zvena-noise :params noise})
              (into after))
          (vec filters))))))

(defn- unique-ids
  "zvena: step results are named after the shadow ids, which old shadows
  lack (nil) or may share; the chain needs distinct names."
  [filters]
  (into [] (map-indexed (fn [index entry]
                          (assoc entry :id (dm/str "f" index "-" (:id entry))))) filters))

(defn filter-coords
  [bounds selrect padding]
  (if (or (mth/close? 0.01 (:width selrect))
          (mth/close? 0.01 (:height selrect)))

    ;; We cannot use "objectBoundingbox" if the shape doesn't have width/height
    ;; From the SVG spec (https://www.w3.org/TR/SVG11/coords.html#ObjectBoundingBox
    ;; Keyword objectBoundingBox should not be used when the geometry of the applicable element
    ;; has no width or no height, such as the case of a horizontal or vertical line, even when
    ;; the line has actual thickness when viewed due to having a non-zero stroke width since
    ;; stroke width is ignored for bounding box calculations. When the geometry of the
    ;; applicable element has no width or height and objectBoundingBox is specified, then
    ;; the given effect (e.g., a gradient or a filter) will be ignored.
    (let [filter-width  (+ (:width bounds) (* 2 (:horizontal padding)))
          filter-height (+ (:height bounds) (* 2 (:vertical padding)))
          filter-x      (- (:x bounds) #_(:x selrect) (:horizontal padding))
          filter-y      (- (:y bounds) #_(:y selrect) (:vertical padding))
          filter-units  "userSpaceOnUse"]
      [filter-x filter-y filter-width filter-height filter-units])

    ;; If the width/height is not zero we use objectBoundingBox as it's more stable
    (let [filter-width  (/ (+ (:width bounds) (* 2 (:horizontal padding))) (:width selrect))
          filter-height (/ (+ (:height bounds) (* 2 (:vertical padding))) (:height selrect))
          filter-x      (/ (- (:x bounds) (:x selrect) (:horizontal padding)) (:width selrect))
          filter-y      (/ (- (:y bounds) (:y selrect) (:vertical padding)) (:height selrect))
          filter-units  "objectBoundingBox"]
      [filter-x filter-y filter-width filter-height filter-units])))

(mf/defc filters*
  [{:keys [filter-id shape]}]

  (let [shape'        (update shape :shadow reverse)
        filters       (-> shape' gsb/shape->filters (add-zvena-filters shape) unique-ids change-filter-in) ;; zvena
        bounds        (gsb/get-rect-filter-bounds (:selrect shape) filters (or (-> shape :blur :value) 0))
        padding       (gsb/calculate-padding shape)
        ;; zvena: an unclipped texture moves pixels up to its radius out
        texture       (zfx/visible-texture shape)
        padding       (if (and (some? texture) (not (:clip texture)))
                        (-> padding
                            (update :horizontal + (:radius texture))
                            (update :vertical + (:radius texture)))
                        padding)
        selrect       (:selrect shape)

        [filter-x filter-y filter-width filter-height filter-units]
        (filter-coords bounds selrect padding)]

    (when (or (> (count filters) 2)
              (zfx/has-render-effects? shape)) ;; zvena
      [:filter {:id          filter-id
                :x           filter-x
                :y           filter-y
                :width       filter-width
                :height      filter-height
                :filterUnits filter-units
                :color-interpolation-filters "sRGB"}
       (for [[index entry] (d/enumerate filters)]
         [:> filter-entry* {:key (dm/str filter-id "-" index)
                            :entry entry}])])))

