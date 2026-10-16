;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.shapes.gradients
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
   [app.main.ui.context :as muc]
   [app.main.ui.shapes.export :as ed]
   [app.util.object :as obj]
   [rumext.v2 :as mf]))

(defn- add-metadata!
  [props gradient]
  (-> props
      (obj/set! "penpot:gradient" "true")
      (obj/set! "penpot:start-x" (:start-x gradient))
      (obj/set! "penpot:start-y" (:start-y gradient))
      (obj/set! "penpot:end-x"   (:end-x gradient))
      (obj/set! "penpot:end-y"   (:end-y gradient))
      (obj/set! "penpot:width"   (:width gradient))))

(mf/defc linear-gradient
  {::mf/wrap-props false}
  [{:keys [id gradient shape force-transform]}]
  (let [transform (mf/with-memo [shape]
                    (when force-transform
                      (gsh/transform-matrix shape nil (gpt/point 0.5 0.5))))

        metadata? (mf/use-ctx ed/include-metadata-ctx)
        props     #js {:id id
                       :x1 (:start-x gradient)
                       :y1 (:start-y gradient)
                       :x2 (:end-x gradient)
                       :y2 (:end-y gradient)
                       :gradientTransform (dm/str transform)}]

    (when ^boolean metadata?
      (add-metadata! props gradient))

    [:> :linearGradient props
     (for [[index {:keys [offset color opacity]}] (d/enumerate (sort-by :offset (:stops gradient)))]
       [:stop {:key (dm/str id "-stop-" index)
               :offset (d/nilv offset 0)
               :stop-color color
               :stop-opacity opacity}])]))

(mf/defc radial-gradient
  {::mf/wrap-props false}
  [{:keys [id gradient shape]}]
  (let [path?         (cfh/path-shape? shape)

        transform     (when ^boolean path?
                        (dm/get-prop shape :transform))
        transform     (d/nilv transform gmt/base)

        transform-inv (when ^boolean path?
                        (dm/get-prop shape :transform-inverse))
        transform-inv (d/nilv transform-inv gmt/base)

        {:keys [start-x start-y end-x end-y] gwidth :width} gradient

        gstart-pt     (gpt/point start-x start-y)
        gend-pt       (gpt/point end-x end-y)
        gradient-vec  (gpt/to-vec gstart-pt gend-pt)

        angle         (+ (gpt/angle gradient-vec) 90)

        points        (dm/get-prop shape :points)
        bounds        (mf/with-memo [points]
                        (grc/points->rect points))
        selrect       (dm/get-prop shape :selrect)

        ;; Paths don't have a transform in SVG because we transform
        ;; the points we need to compensate the difference between the
        ;; original rectangle and the transformed one. This factor is
        ;; that calculation.
        factor        (if ^boolean path?
                        (/ (dm/get-prop selrect :height)
                           (dm/get-prop bounds :height))
                        1.0)

        transform     (mf/with-memo [gradient transform transform-inv factor]
                        (-> (gmt/matrix)
                            (gmt/translate gstart-pt)
                            (gmt/multiply transform)
                            (gmt/rotate angle)
                            (gmt/scale (gpt/point gwidth factor))
                            (gmt/multiply transform-inv)
                            (gmt/translate (gpt/negate gstart-pt))))

        metadata?     (mf/use-ctx ed/include-metadata-ctx)

        props         #js {:id id
                           :cx start-x
                           :cy start-y
                           :r (gpt/length gradient-vec)
                           :gradientTransform transform}]

    (when ^boolean metadata?
      (add-metadata! props gradient))

    [:> :radialGradient props
     (for [[index {:keys [offset color opacity]}] (d/enumerate (:stops gradient))]
       [:stop {:key (dm/str id "-stop-" index)
               :offset (d/nilv offset 0)
               :stop-color color
               :stop-opacity opacity}])]))

;; zvena: Figma's angular and diamond gradients. SVG has neither, so they
;; are drawn into a canvas (conic: createConicGradient; diamond: per pixel)
;; and used as an image pattern over the shape's box. Cached by gradient
;; and box aspect.

(defonce ^:private canvas-cache (js/Map.))

(defn- stops->rgba
  [stops]
  (->> stops
       (sort-by :offset)
       (mapv (fn [{:keys [color opacity offset]}]
               (let [n (js/parseInt (subs (or color "#000000") 1) 16)]
                 [(d/nilv offset 0)
                  (bit-and (bit-shift-right n 16) 255)
                  (bit-and (bit-shift-right n 8) 255)
                  (bit-and n 255)
                  (d/nilv opacity 1)])))))

(defn- sample
  "The [r g b a] of the stops at t (0..1)."
  [stops t]
  (let [t (max 0 (min 1 t))]
    (loop [[a & more] stops]
      (let [b (first more)]
        (cond
          (nil? b) (subvec a 1)
          (<= t (first b))
          (let [span (- (first b) (first a))
                f    (if (pos? span) (/ (- t (first a)) span) 0)
                f    (max 0 (min 1 f))]
            (mapv (fn [i] (+ (nth a i) (* f (- (nth b i) (nth a i))))) [1 2 3 4]))
          :else (recur more))))))

(defn- gradient-data-uri
  [{:keys [type start-x start-y end-x end-y width stops]} w h]
  (when (and (exists? js/document) (pos? w) (pos? h))
    (let [cw     (max 16 (min 512 (js/Math.round (if (>= w h) 256 (* 256 (/ w h))))))
          ch     (max 16 (min 512 (js/Math.round (if (>= h w) 256 (* 256 (/ h w))))))
          k      (str type ":" start-x ":" start-y ":" end-x ":" end-y ":" width ":" cw "x" ch ":" (pr-str stops))]
      (or (.get canvas-cache k)
          (let [canvas (.createElement js/document "canvas")
                _      (set! (.-width canvas) cw)
                _      (set! (.-height canvas) ch)
                ctx    (.getContext canvas "2d")
                cx     (* start-x cw)
                cy     (* start-y ch)
                dx     (- (* end-x cw) cx)
                dy     (- (* end-y ch) cy)
                stops' (stops->rgba stops)]
            (if (= type :angular)
              (let [g (.createConicGradient ctx (js/Math.atan2 dy dx) cx cy)]
                (doseq [[o r gg b a] stops']
                  (.addColorStop g o (str "rgba(" r "," gg "," b "," a ")")))
                (set! (.-fillStyle ctx) g)
                (.fillRect ctx 0 0 cw ch))
              ;; diamond: |u| + |v| along the handle axes (width = 2nd axis ratio)
              (let [len   (max 1e-6 (js/Math.hypot dx dy))
                    ux    (/ dx len) uy (/ dy len)
                    len2  (* len (d/nilv width 1))
                    img   (.createImageData ctx cw ch)
                    data  (.-data img)]
                (dotimes [y ch]
                  (dotimes [x cw]
                    (let [px (- (+ x 0.5) cx)
                          py (- (+ y 0.5) cy)
                          u  (js/Math.abs (+ (* px ux) (* py uy)))
                          v  (js/Math.abs (- (* py ux) (* px uy)))
                          t  (+ (/ u len) (/ v (max 1e-6 len2)))
                          [r gg b a] (sample stops' t)
                          i  (* 4 (+ x (* y cw)))]
                      (aset data i (js/Math.round r))
                      (aset data (+ i 1) (js/Math.round gg))
                      (aset data (+ i 2) (js/Math.round b))
                      (aset data (+ i 3) (js/Math.round (* 255 a))))))
                (.putImageData ctx img 0 0)))
            (let [uri (.toDataURL canvas "image/png")]
              (.set canvas-cache k uri)
              uri))))))

(mf/defc canvas-gradient
  {::mf/wrap-props false}
  [{:keys [id gradient shape]}]
  (let [selrect (when shape (dm/get-prop shape :selrect))
        w       (d/nilv (:width selrect) 100)
        h       (d/nilv (:height selrect) 100)
        uri     (mf/with-memo [gradient w h] (gradient-data-uri gradient w h))]
    (when uri
      [:pattern {:id id :patternContentUnits "objectBoundingBox" :width 1 :height 1}
       [:image {:href uri :width 1 :height 1 :preserveAspectRatio "none"}]])))

(mf/defc gradient
  {::mf/wrap-props false}
  [props]
  (let [attr     (unchecked-get props "attr")
        shape    (unchecked-get props "shape")
        id       (unchecked-get props "id")
        rid      (mf/use-ctx muc/render-id)

        id       (if (some? id)
                   id
                   (dm/str (name attr) "-" rid))

        gradient (get shape attr)
        props    #js {:id id
                      :gradient gradient
                      :shape shape}]

    (when (some? gradient)
      (case (:type gradient)
        :linear [:> linear-gradient props]
        :radial [:> radial-gradient props]
        (:angular :diamond) [:> canvas-gradient props]
        nil))))
