;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.colorpicker.zvena-image
  "zvena: Figma's image fill properties — scale mode (Fill, Fit, Crop,
  Tile, Stretch), tile size, crop zoom and position, a 90° rotate button
  and the seven adjustment sliders."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.math :as mth]
   [app.common.types.color :as cc]
   [app.main.ui.components.select :refer [select]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn- slider-row
  [{:keys [label value min max step on-change format]}]
  (mf/html
   [:label {:class (stl/css :slider-row)}
    [:span {:class (stl/css :slider-label)} label]
    [:input {:type "range"
             :class (stl/css :slider)
             :min min :max max :step (or step 1)
             :value value
             :on-change on-change}]
    [:span {:class (stl/css :slider-value)} (if format (format value) (str value))]]))

(mf/defc image-controls*
  [{:keys [image on-change]}]
  (let [mode     (cc/image-scale-mode image)
        crop     (merge {:zoom 1 :x 0.5 :y 0.5} (:crop image))
        adjust   (:adjust image)

        set-image!
        (mf/use-fn
         (mf/deps on-change)
         (fn [image] (on-change image)))

        on-mode
        (mf/use-fn
         (mf/deps image set-image!)
         (fn [mode]
           (let [mode (keyword mode)]
             (set-image!
              (cond-> (assoc image
                             :scale-mode mode
                             ;; renderers that only know keep-aspect-ratio
                             :keep-aspect-ratio (not= mode :stretch))
                (and (= mode :tile) (nil? (:tile-scale image))) (assoc :tile-scale 100)
                (and (= mode :crop) (nil? (:crop image))) (assoc :crop {:zoom 1 :x 0.5 :y 0.5}))))))

        on-tile
        (mf/use-fn
         (mf/deps image set-image!)
         (fn [event]
           (let [v (-> (dom/get-target-val event) (d/parse-double 100) (mth/clamp 1 1000))]
             (set-image! (assoc image :tile-scale v)))))

        on-crop
        (mf/use-fn
         (mf/deps image crop set-image!)
         (fn [event]
           (let [target (dom/get-target event)
                 k      (keyword (dom/get-data target "key"))
                 v      (d/parse-double (dom/get-value target) 0)
                 v      (if (= k :zoom) (mth/clamp (/ v 100) 1 10) (mth/clamp (/ v 100) 0 1))]
             (set-image! (assoc image :crop (assoc crop k v))))))

        on-rotate
        (mf/use-fn
         (mf/deps image set-image!)
         (fn [_]
           (set-image! (assoc image :rotation (mod (+ 90 (d/nilv (:rotation image) 0)) 360)))))

        on-adjust
        (mf/use-fn
         (mf/deps image set-image!)
         (fn [event]
           (let [target (dom/get-target event)
                 k      (keyword (dom/get-data target "key"))
                 v      (-> (dom/get-value target) (d/parse-integer 0) (mth/clamp -100 100))
                 adj    (-> (assoc (:adjust image) k v)
                            (->> (into {} (remove (fn [[_ v]] (zero? v))))))]
             (set-image! (if (seq adj) (assoc image :adjust adj) (dissoc image :adjust))))))

        on-reset
        (mf/use-fn
         (mf/deps image set-image!)
         (fn [_] (set-image! (dissoc image :adjust))))]

    [:div {:class (stl/css :image-props)}
     [:div {:class (stl/css :mode-row)}
      [:& select
       {:default-value (name mode)
        :options [{:value "fill" :label (tr "zvena.image.fill")}
                  {:value "fit" :label (tr "zvena.image.fit")}
                  {:value "crop" :label (tr "zvena.image.crop")}
                  {:value "tile" :label (tr "zvena.image.tile")}
                  {:value "stretch" :label (tr "zvena.image.stretch")}]
        :on-change on-mode}]
      [:> icon-button* {:variant "ghost"
                        :aria-label (tr "zvena.image.rotate")
                        :icon i/rotation
                        :on-click on-rotate}]]

     (when (= mode :tile)
       (slider-row {:label (tr "zvena.image.tile-scale")
                    :value (d/nilv (:tile-scale image) 100)
                    :min 5 :max 400 :step 5
                    :on-change on-tile
                    :format #(dm/str % "%")}))

     (when (= mode :crop)
       [:*
        [:label {:class (stl/css :slider-row)}
         [:span {:class (stl/css :slider-label)} (tr "zvena.image.zoom")]
         [:input {:type "range" :class (stl/css :slider) :min 100 :max 500 :step 5
                  :data-key "zoom" :value (mth/round (* 100 (:zoom crop))) :on-change on-crop}]
         [:span {:class (stl/css :slider-value)} (dm/str (mth/round (* 100 (:zoom crop))) "%")]]
        [:label {:class (stl/css :slider-row)}
         [:span {:class (stl/css :slider-label)} "X"]
         [:input {:type "range" :class (stl/css :slider) :min 0 :max 100
                  :data-key "x" :value (mth/round (* 100 (:x crop))) :on-change on-crop}]
         [:span {:class (stl/css :slider-value)} (dm/str (mth/round (* 100 (:x crop))) "%")]]
        [:label {:class (stl/css :slider-row)}
         [:span {:class (stl/css :slider-label)} "Y"]
         [:input {:type "range" :class (stl/css :slider) :min 0 :max 100
                  :data-key "y" :value (mth/round (* 100 (:y crop))) :on-change on-crop}]
         [:span {:class (stl/css :slider-value)} (dm/str (mth/round (* 100 (:y crop))) "%")]]])

     [:div {:class (stl/css :adjust-title)}
      [:span (tr "zvena.image.adjustments")]
      (when (cc/image-adjusted? image)
        [:button {:class (stl/css :reset) :on-click on-reset} (tr "zvena.image.reset")])]
     (for [k cc/image-adjust-keys]
       [:label {:key (name k) :class (stl/css :slider-row)}
        [:span {:class (stl/css :slider-label)} (tr (dm/str "zvena.image." (name k)))]
        [:input {:type "range" :class (stl/css :slider) :min -100 :max 100
                 :data-key (name k) :value (get adjust k 0) :on-change on-adjust}]
        [:span {:class (stl/css :slider-value)} (str (get adjust k 0))]])]))
