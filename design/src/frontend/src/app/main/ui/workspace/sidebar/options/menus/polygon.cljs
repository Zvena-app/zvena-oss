;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.polygon
  "zvena: Figma's polygon/star properties — the number of corners or points,
  for a star the inner radius ratio, and the corner radius. Shown for shapes drawn with the
  Polygon and Star tools."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.math :as mth]
   [app.main.data.workspace.drawing.polygon :as dwpg]
   [app.main.store :as st]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.controls.numeric-input :refer [numeric-input*]]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(mf/defc polygon-menu*
  [{:keys [shape]}]
  (let [id     (:id shape)
        params (dwpg/polygon-params shape)
        star?  (= :star (:kind params))

        on-count-change
        (mf/use-fn
         (mf/deps id)
         (fn [value]
           (when (number? value)
             (st/emit! (dwpg/update-polygon [id] {:count value})))))

        on-ratio-change
        (mf/use-fn
         (mf/deps id)
         (fn [value]
           (when (number? value)
             (st/emit! (dwpg/update-polygon [id] {:ratio (/ value 100)})))))

        ;; zvena: Figma's corner radius for polygons and stars
        on-radius-change
        (mf/use-fn
         (mf/deps id)
         (fn [value]
           (when (number? value)
             (st/emit! (dwpg/update-polygon [id] {:radius value})))))]

    (when params
      [:section {:class (stl/css :element-set)
                 :aria-label (tr (if star? "workspace.toolbar.star" "workspace.toolbar.polygon"))}
       [:div {:class (stl/css :element-title)}
        [:> title-bar* {:collapsable false
                        :title (tr (if star? "workspace.toolbar.star" "workspace.toolbar.polygon"))
                        :class (stl/css :title-spacing)}]]
       [:div {:class (stl/css :element-content)}
        [:div {:class (stl/css :field)
               :title (tr (if star? "zvena.polygon.points" "zvena.polygon.count"))}
         [:> numeric-input* {:class (stl/css :numeric-input)
                             :icon (if star? "star" "polygon")
                             :min 3
                             :max 60
                             :step 1
                             :id "zvena-polygon-count"
                             :on-change on-count-change
                             :value (:count params)}]]
        (when star?
          [:div {:class (stl/css :field)
                 :title (tr "zvena.polygon.ratio")}
           [:> numeric-input* {:class (stl/css :numeric-input)
                               :text-icon "%"
                               :min 1
                               :max 99
                               :step 1
                               :id "zvena-star-ratio"
                               :on-change on-ratio-change
                               :value (mth/round (* 100 (:ratio params)))}]])
        [:div {:class (stl/css :field)
               :title (tr "workspace.options.radius")}
         [:> numeric-input* {:class (stl/css :numeric-input)
                             :icon "corner-radius"
                             :min 0
                             :step 1
                             :id "zvena-polygon-radius"
                             :on-change on-radius-change
                             :value (mth/precision (or (:radius params) 0) 2)}]]]])))

;; zvena: Figma's ellipse arc — start angle, sweep and inner ratio.
(mf/defc ellipse-arc-menu*
  [{:keys [shape]}]
  (let [id     (:id shape)
        params (dwpg/ellipse-arc-params shape)

        on-change
        (mf/use-fn
         (mf/deps id)
         (fn [k scale]
           (fn [value]
             (when (number? value)
               (st/emit! (dwpg/update-ellipse-arc [id] {k (/ value scale)}))))))

        on-start (mf/with-memo [on-change] (on-change :start 1))
        on-sweep (mf/with-memo [on-change] (on-change :sweep 100))
        on-ratio (mf/with-memo [on-change] (on-change :ratio 100))]

    (when params
      [:section {:class (stl/css :element-set)
                 :aria-label (tr "zvena.ellipse.arc")}
       [:div {:class (stl/css :element-title)}
        [:> title-bar* {:collapsable false
                        :title (tr "zvena.ellipse.arc")
                        :class (stl/css :title-spacing)}]]
       [:div {:class (stl/css :element-content)}
        [:div {:class (stl/css :field) :title (tr "zvena.ellipse.start")}
         [:> numeric-input* {:class (stl/css :numeric-input)
                             :icon "rotation"
                             :min -360 :max 360 :step 1
                             :id "zvena-arc-start"
                             :on-change on-start
                             :value (mth/round (:start params))}]]
        [:div {:class (stl/css :field) :title (tr "zvena.ellipse.sweep")}
         [:> numeric-input* {:class (stl/css :numeric-input)
                             :icon "percentage"
                             :min 1 :max 100 :step 1
                             :id "zvena-arc-sweep"
                             :on-change on-sweep
                             :value (mth/round (* 100 (:sweep params)))}]]
        [:div {:class (stl/css :field) :title (tr "zvena.ellipse.ratio")}
         [:> numeric-input* {:class (stl/css :numeric-input)
                             :icon "ellipse"
                             :min 0 :max 99 :step 1
                             :id "zvena-arc-ratio"
                             :on-change on-ratio
                             :value (mth/round (* 100 (:ratio params)))}]]]])))
