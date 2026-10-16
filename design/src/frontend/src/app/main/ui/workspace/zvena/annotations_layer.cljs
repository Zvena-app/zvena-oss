;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.annotations-layer
  "zvena: Figma Dev Mode annotations on the canvas. Every annotated layer
  gets a dashed outline and a callout card to its right (note + pinned
  properties with live values). Only drawn in Dev Mode; a click on a card
  selects its layer, a double click edits the annotation."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.rect :as grc]
   [app.common.types.shape.zvena :as ctsz]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zvena-devmode :as zdev]
   [app.main.store :as st]
   [app.main.ui.workspace.viewport.utils :as vwu]
   [app.main.ui.workspace.zvena.annotation-props :as zap]
   [app.util.dom :as dom]
   [clojure.string :as str]
   [rumext.v2 :as mf]))

;; Card size in screen pixels (the card keeps its size at any zoom)
(def ^:private card-width 240)
(def ^:private card-max-height 480)

(mf/defc annotation-callout*
  {::mf/wrap [mf/memo]
   ::mf/private true}
  [{:keys [shape zoom is-selected can-edit]}]
  (let [id       (:id shape)
        points   (:points shape)
        rect     (grc/points->rect points)
        x2       (:x2 rect)
        y1       (:y1 rect)
        y2       (:y2 rect)
        inv      (/ 1 zoom)

        ;; the leader line leaves the layer's right edge near its top
        anchor-y (+ y1 (min (/ (- y2 y1) 2) (* 14 inv)))
        card-x   (+ x2 (* 32 inv))
        card-y   (- anchor-y (* 14 inv))

        text     (ctsz/annotation shape)
        props    (ctsz/annotation-props shape)

        on-pointer-down
        (mf/use-fn
         (mf/deps id)
         (fn [event]
           (when (dom/left-mouse? event)
             (dom/prevent-default event)
             (dom/stop-propagation event)
             (st/emit! (dws/select-shape id)))))

        on-double-click
        (mf/use-fn
         (mf/deps id can-edit)
         (fn [event]
           (dom/stop-propagation event)
           (when can-edit
             (st/emit! (zdev/start-annotation id)))))]

    (when (and (some? rect) (seq points))
      [:g {:class (stl/css-case :callout true
                                :selected is-selected)}
       [:polygon {:class (stl/css :outline)
                  :points (str/join " " (map #(dm/str (:x %) "," (:y %)) points))
                  :style {:stroke-width inv
                          :stroke-dasharray (dm/str (* 4 inv) " " (* 3 inv))}}]
       [:line {:class (stl/css :leader)
               :x1 x2 :y1 anchor-y
               :x2 card-x :y2 anchor-y
               :style {:stroke-width inv}}]
       [:circle {:class (stl/css :anchor)
                 :cx x2 :cy anchor-y
                 :r (* 3 inv)}]

       [:foreignObject {:x 0
                        :y 0
                        :width card-width
                        :height card-max-height
                        :class (stl/css :card-holder)
                        :transform (vwu/text-transform {:x card-x :y card-y} zoom)}
        [:div {:class (stl/css :card)
               :data-testid "zvena-annotation-card"
               :on-pointer-down on-pointer-down
               :on-double-click on-double-click}
         [:div {:class (stl/css :card-title)} (:name shape)]
         (when (some? text)
           [:div {:class (stl/css :card-text)} text])
         (when (seq props)
           [:dl {:class (stl/css :card-props)}
            (for [prop props]
              [:div {:key prop :class (stl/css :card-prop)}
               [:dt (zap/prop-label prop)]
               [:dd (or (zap/prop-value shape prop) "—")]])])]]])))

(defn- annotated-shapes
  [objects]
  (into []
        (filter (fn [shape]
                  (and (ctsz/annotated? shape)
                       (not= uuid/zero (:id shape))
                       (not (:hidden shape))
                       (not (cfh/hidden-parent? objects (:id shape))))))
        (vals objects)))

(mf/defc annotations-layer*
  "Mounted by the viewports in Dev Mode only."
  [{:keys [objects zoom selected can-edit]}]
  (let [shapes (mf/with-memo [objects]
                 (annotated-shapes objects))
        zoom   (if (and (number? zoom) (pos? zoom)) zoom 1)]
    (when (seq shapes)
      [:g {:class (stl/css :annotations-layer)}
       (for [shape shapes]
         [:> annotation-callout* {:key (dm/str (:id shape))
                                  :shape shape
                                  :zoom zoom
                                  :can-edit can-edit
                                  :is-selected (contains? selected (:id shape))}])])))
