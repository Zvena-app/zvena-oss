;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.shapes.fills
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.geom.shapes.text :as gst]
   [app.common.types.color :as ctc]
   [app.config :as cf]
   [app.main.ui.shapes.attrs :as attrs]
   [app.main.ui.shapes.embed :as embed]
   [app.main.ui.shapes.gradients :as grad]
   [app.util.object :as obj]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def no-repeat-padding 1.05)

;; zvena: Figma's image fill — scale modes (fill/fit/stretch/tile/crop),
;; quarter-turn rotation and color adjustments (an SVG filter whose math is
;; shared with the WebGL renderer, see app.common.types.color).

(defn- adjust-filter
  [filter-id image]
  (let [matrix (ctc/image-adjust-matrix (:adjust image))
        table  (ctc/image-adjust-table (:adjust image))]
    ;; zvena: a plain function, so its hiccup is compiled with mf/html
    (mf/html
     [:filter {:id filter-id :color-interpolation-filters "sRGB"
               :x "0" :y "0" :width "100%" :height "100%"}
      [:feColorMatrix {:type "matrix" :values (str/join " " matrix)}]
      (when table
        (let [tv (str/join " " table)]
          (mf/html
           [:feComponentTransfer
            [:feFuncR {:type "table" :tableValues tv}]
            [:feFuncG {:type "table" :tableValues tv}]
            [:feFuncB {:type "table" :tableValues tv}]])))])))

(defn- image-fill-node
  [value fill-index render-id width height embed]
  (let [image    (:fill-image value)
        uri      (cf/resolve-file-media image)
        href     (get embed uri uri)
        mode     (ctc/image-scale-mode image)
        rotation (d/nilv (:rotation image) 0)
        quarter? (contains? #{90 270} rotation)
        iw       (max 1 (d/nilv (:width image) 100))
        ih       (max 1 (d/nilv (:height image) 100))
        img-id   (dm/str "fill-image-" render-id "-" fill-index)
        filt-id  (dm/str "fill-adjust-" render-id "-" fill-index)
        adjusted (ctc/image-adjusted? image)
        filt     (when adjusted (dm/str "url(#" filt-id ")"))
        opacity  (:fill-opacity value)
        ;; the image box before rotation, centered in the shape
        box      (fn [bw bh]
                   (if quarter?
                     {:x (/ (- width bh) 2) :y (/ (- height bw) 2) :width bh :height bw}
                     {:x (/ (- width bw) 2) :y (/ (- height bh) 2) :width bw :height bh}))
        rotate   (when-not (zero? rotation)
                   (dm/str "rotate(" rotation " " (/ width 2) " " (/ height 2) ")"))]
    (cond
      (= mode :tile)
      (let [scale   (/ (d/nilv (:tile-scale image) 100) 100)
            tile-w  (max 1 (* iw scale))
            tile-h  (max 1 (* ih scale))
            tile-id (dm/str "fill-tile-" render-id "-" fill-index)]
        (mf/html
         [:g {:key (dm/str fill-index)}
         (when adjusted (adjust-filter filt-id image))
         [:pattern {:id tile-id
                    :patternUnits "userSpaceOnUse"
                    :patternTransform rotate
                    :x 0 :y 0
                    :width tile-w
                    :height tile-h}
          [:image {:id img-id
                   :href href
                   :preserveAspectRatio "none"
                   :width tile-w
                   :height tile-h}]]
         [:rect {:width width
                 :height height
                 :filter filt
                 :fill (dm/str "url(#" tile-id ")")
                 :opacity opacity}]]))

      (= mode :crop)
      ;; covers the shape, zoomed and placed by its alignment
      (let [{:keys [zoom x y]} (merge {:zoom 1 :x 0.5 :y 0.5} (:crop image))
            rw  (if quarter? ih iw)
            rh  (if quarter? iw ih)
            sc  (* zoom (max (/ width rw) (/ height rh)))
            dw  (* rw sc)
            dh  (* rh sc)
            cx  (+ (* (- width dw) x) (/ dw 2))
            cy  (+ (* (- height dh) y) (/ dh 2))
            w   (* iw sc)
            h   (* ih sc)]
        (mf/html
         [:g {:key (dm/str fill-index) :opacity opacity}
         (when adjusted (adjust-filter filt-id image))
         [:image {:id img-id
                  :href href
                  :filter filt
                  :preserveAspectRatio "none"
                  :x (- cx (/ w 2))
                  :y (- cy (/ h 2))
                  :width w
                  :height h
                  :transform (when-not (zero? rotation) (dm/str "rotate(" rotation " " cx " " cy ")"))}]]))

      :else
      (let [{bx :x by :y bw :width bh :height} (box width height)]
        (mf/html
         [:g {:key (dm/str fill-index) :opacity opacity :transform rotate}
         (when adjusted (adjust-filter filt-id image))
         [:image {:id img-id
                  :href href
                  :filter filt
                  :x bx :y by :width bw :height bh
                  ;; Figma's Fill / Fit / Stretch
                  :preserveAspectRatio (case mode
                                         :fit  "xMidYMid meet"
                                         :fill "xMidYMid slice"
                                         "none")}]])))))

(mf/defc internal-fills
  {::mf/wrap-props false}
  [props]
  (let [shape      (unchecked-get props "shape")
        render-id  (unchecked-get props "render-id")

        type       (dm/get-prop shape :type)
        image      (get shape :fill-image)
        fills      (get shape :fills [])

        selrect    (dm/get-prop shape :selrect)

        bounds     (when (cfh/text-shape? shape)
                     (gst/shape->rect shape))

        metadata   (get shape :metadata)

        x          (dm/get-prop selrect :x)
        y          (dm/get-prop selrect :y)
        width      (dm/get-prop selrect :width)
        height     (dm/get-prop selrect :height)

        has-image? (or (some? metadata)
                       (some? image))

        uri        (cond
                     (some? metadata)
                     (cf/resolve-file-media metadata)

                     (some? image)
                     (cf/resolve-file-media image))

        uris       (into [uri]
                         (comp
                          (keep :fill-image)
                          (map cf/resolve-file-media))
                         fills)
        embed       (embed/use-data-uris uris)
        transform   (gsh/transform-str shape)

        pat-props   #js {:patternUnits (if (= :text type) "objectBoundingBox" "userSpaceOnUse")
                         :x (when-not (= :text type) x)
                         :y (when-not (= :text type) y)
                         :width width
                         :height height}

        pat-props   (if (or (= :path type) (= :bool type))
                      (obj/set! pat-props "patternTransform" transform)
                      pat-props)]

    (for [[obj-index obj] (d/enumerate (or (:position-data shape) [shape]))]
      [:* {:key (dm/str obj-index)}
       (for [[fill-index value] (reverse (d/enumerate (get obj :fills [])))]
         (when (some? (:fill-color-gradient value))
           (let [gradient  (:fill-color-gradient value)

                 from-p (-> (gpt/point (+ x (* width (:start-x gradient)))
                                       (+ y (* height (:start-y gradient)))))
                 to-p   (-> (gpt/point (+ x (* width (:end-x gradient)))
                                       (+ y (* height (:end-y gradient)))))

                 gradient
                 (cond-> gradient
                   (some? bounds)
                   (assoc
                    :start-x (/ (- (:x from-p) (:x bounds)) (:width bounds))
                    :start-y (/ (- (:y from-p) (:y bounds)) (:height bounds))
                    :end-x   (/ (- (:x to-p) (:x bounds)) (:width bounds))
                    :end-y   (/ (- (:y to-p) (:y bounds)) (:height bounds))))

                 props #js {:id (dm/str "fill-color-gradient-" render-id "-" fill-index)
                            :key (dm/str fill-index)
                            :gradient gradient
                            :shape obj}]
             (case (d/name (:type gradient))
               "linear" [:> grad/linear-gradient props]
               "radial" [:> grad/radial-gradient props]
               ("angular" "diamond") [:> grad/canvas-gradient props]
               nil))))


       (let [fill-id (dm/str "fill-" obj-index "-" render-id)]
         [:> :pattern (-> (obj/clone pat-props)
                          (obj/set! "id" fill-id)
                          (cond-> (and has-image? (nil? bounds))
                            (-> (obj/set! "width" (* width no-repeat-padding))
                                (obj/set! "height" (* height no-repeat-padding))))
                          (cond-> (some? bounds)
                            (-> (obj/set! "width" (:width bounds))
                                (obj/set! "height" (:height bounds)))))
          [:g
           (for [[fill-index value] (reverse (d/enumerate (get obj :fills [])))]
             (let [style (attrs/get-fill-style value fill-index render-id type)
                   props #js {:key (dm/str fill-index)
                              :width (d/nilv (:width bounds) width)
                              :height (d/nilv (:height bounds) height)
                              :style style}]
               (if (:fill-image value)
                 (image-fill-node value fill-index render-id width height embed)
                 [:> :rect props])))

           (when ^boolean has-image?
             [:g
              ;; We add this shape to add a padding so the patter won't repeat
              ;; Issue: https://tree.taiga.io/project/penpot/issue/5583
              [:rect {:x 0
                      :y 0
                      :width (* width no-repeat-padding)
                      :height (* height no-repeat-padding)
                      :fill "none"}]
              [:image {:href uri
                       :preserveAspectRatio "none"
                       :x 0
                       :y 0
                       :width width
                       :height height}]])]])])))

(mf/defc fills
  {::mf/wrap-props false}
  [props]
  (let [shape     (unchecked-get props "shape")
        type      (dm/get-prop shape :type)
        image     (:fill-image shape)
        fills     (:fills shape [])]

    (when (or (some? image)
              (or (= type :image)
                  (= type :text))
              (> (count fills) 1)
              (some :fill-color-gradient fills)
              (some :fill-image fills))
      [:> internal-fills props])))
