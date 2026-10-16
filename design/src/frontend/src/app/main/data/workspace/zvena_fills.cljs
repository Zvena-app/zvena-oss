;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-fills
  "zvena: Figma's Object menu commands Remove fill (Alt+/), Remove stroke
  (Shift+Alt+/) and Swap fill and stroke (Ctrl+Shift+X on non-text layers)."
  (:require
   [app.common.files.helpers :as cfh]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.shapes :as dwsh]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(defn- target-ids
  "Selected layers that carry their own fills (texts keep theirs in the
  content, groups have none)."
  [state]
  (let [objects (dsh/lookup-page-objects state)]
    (->> (dsh/lookup-selected state)
         (keep #(get objects %))
         (remove cfh/text-shape?)
         (remove cfh/group-shape?)
         (map :id))))

(defn remove-fill
  []
  (ptk/reify ::remove-fill
    ptk/WatchEvent
    (watch [_ state _]
      (if-let [ids (seq (target-ids state))]
        (rx/of (dwsh/update-shapes ids #(assoc % :fills []) {:attrs [:fills]}))
        (rx/empty)))))

(defn remove-stroke
  []
  (ptk/reify ::remove-stroke
    ptk/WatchEvent
    (watch [_ state _]
      (if-let [ids (seq (target-ids state))]
        (rx/of (dwsh/update-shapes ids #(assoc % :strokes []) {:attrs [:strokes]}))
        (rx/empty)))))

(defn- fill->stroke
  [fill]
  (cond-> {:stroke-style :solid
           :stroke-alignment :inner
           :stroke-width 1
           :stroke-opacity (:fill-opacity fill 1)}
    (:fill-color fill)          (assoc :stroke-color (:fill-color fill))
    (:fill-color-gradient fill) (assoc :stroke-color-gradient (:fill-color-gradient fill))
    (:fill-image fill)          (assoc :stroke-image (:fill-image fill))))

(defn- stroke->fill
  [stroke]
  (cond-> {:fill-opacity (:stroke-opacity stroke 1)}
    (:stroke-color stroke)          (assoc :fill-color (:stroke-color stroke))
    (:stroke-color-gradient stroke) (assoc :fill-color-gradient (:stroke-color-gradient stroke))
    (:stroke-image stroke)          (assoc :fill-image (:stroke-image stroke))))

(defn swap-fill-stroke
  []
  (ptk/reify ::swap-fill-stroke
    ptk/WatchEvent
    (watch [_ state _]
      (if-let [ids (seq (target-ids state))]
        (rx/of (dwsh/update-shapes
                ids
                (fn [shape]
                  (let [fills   (:fills shape [])
                        strokes (:strokes shape [])
                        ;; keep the stroke look (width, alignment) when the
                        ;; layer already had a stroke
                        base    (first strokes)]
                    (assoc shape
                           :fills (mapv stroke->fill strokes)
                           :strokes (mapv (fn [fill]
                                            (merge (fill->stroke fill)
                                                   (select-keys base [:stroke-width :stroke-alignment :stroke-style])))
                                          fills))))
                {:attrs [:fills :strokes]}))
        (rx/empty)))))
