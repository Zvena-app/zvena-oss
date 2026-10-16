;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.viewport.zvena-smart-selection
  "zvena: Figma's smart selection. When the selected layers form an evenly
  spaced row or column (same parent, no auto layout, no overlaps, equal
  gaps), a pink handle shows in every gap; dragging any of them changes
  all the gaps at once (the first layer stays, the others move), with
  the spacing shown while hovering or dragging."
  (:require
   [app.common.data.macros :as dm]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.math :as mth]
   [app.common.types.modifiers :as ctm]
   [app.common.types.shape.layout :as ctl]
   [app.main.constants :as mconst]
   [app.main.data.workspace.modifiers :as dwm]
   [app.main.data.workspace.transforms :as dwt]
   [app.main.features :as features]
   [app.main.store :as st]
   [app.main.ui.css-cursors :as cur]
   [app.main.ui.flex-controls.common :as fcc]
   [app.util.dom :as dom]
   [rumext.v2 :as mf]))

;; Gaps that differ by less than this count as equal (Figma rounds too).
(def ^:private tolerance 0.51)

(defn- bounds
  "The axis-aligned bounds of a layer (rotated ones included)."
  [shape]
  (if-let [points (not-empty (:points shape))]
    (grc/points->rect points)
    (:selrect shape)))

(defn- axis-row
  "The layers sorted along `axis` and their gap, when they form an evenly
  spaced row (:x) or column (:y) without overlaps."
  [items axis]
  (let [[start end] (if (= axis :x) [:x1 :x2] [:y1 :y2])
        sorted      (vec (sort-by #(get-in % [:rect start]) items))
        gaps        (mapv (fn [a b] (- (get-in b [:rect start]) (get-in a [:rect end])))
                          sorted (rest sorted))]
    (when (and (seq gaps)
               (every? #(> % -0.01) gaps)
               (< (- (reduce max gaps) (reduce min gaps)) tolerance))
      {:axis  axis
       :items sorted
       :gap   (/ (reduce + gaps) (count gaps))})))

(defn smart-row
  "The smart selection formed by `shapes` (with `objects` to check their
  parent), or nil."
  [objects shapes]
  (when (>= (count shapes) 2)
    (let [parent-ids (into #{} (map :parent-id) shapes)
          parent     (get objects (first parent-ids))]
      (when (and (= 1 (count parent-ids))
                 (not (ctl/any-layout? parent))
                 (not-any? :blocked shapes)
                 (not-any? :hidden shapes))
        (let [items (mapv (fn [shape] {:id (:id shape) :rect (bounds shape)}) shapes)]
          (or (axis-row items :x)
              (axis-row items :y)))))))

(defn- gap-rects
  "The area of each gap of `row`: between two neighbours, across the
  range they share (or both ranges when they don't overlap)."
  [{:keys [axis items]}]
  (mapv (fn [a b]
          (let [ra (:rect a)
                rb (:rect b)]
            (if (= axis :x)
              (let [y1 (max (:y1 ra) (:y1 rb))
                    y2 (min (:y2 ra) (:y2 rb))
                    [y1 y2] (if (> y2 y1) [y1 y2] [(min (:y1 ra) (:y1 rb)) (max (:y2 ra) (:y2 rb))])]
                {:x (:x2 ra) :y y1 :width (- (:x1 rb) (:x2 ra)) :height (- y2 y1)})
              (let [x1 (max (:x1 ra) (:x1 rb))
                    x2 (min (:x2 ra) (:x2 rb))
                    [x1 x2] (if (> x2 x1) [x1 x2] [(min (:x1 ra) (:x1 rb)) (max (:x2 ra) (:x2 rb))])]
                {:x x1 :y (:y2 ra) :width (- x2 x1) :height (- (:y1 rb) (:y2 ra))}))))
        items (rest items)))

(defn- move-tree
  "Modifiers that move the n-th layer of `row` by n times `delta` along
  its axis."
  [{:keys [axis items]} delta]
  (into {}
        (map-indexed
         (fn [idx {:keys [id]}]
           (let [d (* idx delta)]
             [id {:modifiers (ctm/move-modifiers
                              (if (= axis :x) (gpt/point d 0) (gpt/point 0 d)))}])))
        items))

(mf/defc smart-selection*
  [{:keys [objects shapes zoom]}]
  (let [row       (mf/with-memo [objects shapes]
                    (smart-row objects shapes))
        hover*    (mf/use-state false)
        hover?    (deref hover*)
        drag*     (mf/use-state nil)
        drag      (deref drag*)
        start-ref (mf/use-ref nil)
        wasm?     (features/active-feature? @st/state "render-wasm/v1")

        calc-tree
        (mf/use-fn
         (mf/deps zoom)
         (fn [pos]
           (when-let [{:keys [row point]} (mf/ref-val start-ref)]
             (let [axis   (:axis row)
                   delta  (/ (get (gpt/to-vec point pos) axis) zoom)
                   gap    (max 0 (mth/round (+ (:gap row) delta)))
                   change (- gap (:gap row))]
               [gap (move-tree row change)]))))

        on-pointer-down
        (mf/use-fn
         (mf/deps row)
         (fn [event]
           (when (and (some? row) (= 0 (.-button event)))
             (dom/stop-propagation event)
             (dom/prevent-default event)
             (dom/capture-pointer event)
             (mf/set-ref-val! start-ref {:row row :point (dom/get-client-position event) :last nil})
             (reset! drag* {:gap (:gap row)}))))

        on-pointer-move
        (mf/use-fn
         (mf/deps calc-tree wasm?)
         (fn [event]
           (when (some? (mf/ref-val start-ref))
             (let [pos (dom/get-client-position event)
                   [gap tree] (calc-tree pos)]
               (mf/set-ref-val! start-ref (assoc (mf/ref-val start-ref) :last pos))
               (reset! drag* {:gap gap})
               (if wasm?
                 (st/emit! (dwm/set-wasm-modifiers tree))
                 (st/emit! (dwm/set-modifiers tree)))))))

        on-lost-pointer-capture
        (mf/use-fn
         (mf/deps calc-tree wasm?)
         (fn [event]
           (dom/release-pointer event)
           (when-let [{:keys [last]} (mf/ref-val start-ref)]
             (if wasm?
               (when (some? last)
                 (let [[_ tree] (calc-tree last)]
                   (st/emit! (dwm/apply-wasm-modifiers tree)
                             (dwt/finish-transform))))
               (when (some? last)
                 (st/emit! (dwm/apply-modifiers)))))
           (mf/set-ref-val! start-ref nil)
           (reset! drag* nil)))

        on-pointer-enter (mf/use-fn #(reset! hover* true))
        on-pointer-leave (mf/use-fn #(reset! hover* false))]

    (mf/with-effect []
      (fn []
        (when (some? (mf/ref-val start-ref))
          (fcc/clear-transform-preview!))))

    (when (some? row)
      (let [axis     (:axis row)
            rects    (gap-rects row)
            active?  (or hover? (some? drag))
            value    (if (some? drag) (:gap drag) (:gap row))
            stroke   (/ 1 zoom)
            pill-w   (/ fcc/flex-display-pill-width zoom)
            pill-h   (/ fcc/flex-display-pill-height zoom)
            cursor   (if (= axis :x)
                       (cur/get-dynamic "resize-ew" 0)
                       (cur/get-dynamic "resize-ew" 90))]
        [:g {:class "zvena-smart-selection"}
         (when active?
           (for [[idx r] (map-indexed vector rects)]
             [:rect {:key (dm/str "area-" idx)
                     :x (:x r) :y (:y r)
                     :width (max 0 (:width r)) :height (max 0 (:height r))
                     :style {:fill mconst/distance-color
                             :opacity 0.2
                             :pointer-events "none"}}]))

         (for [[idx r] (map-indexed vector rects)]
           (let [;; a short pill across the gap, as in Figma
                 len  (/ 16 zoom)
                 thick (/ 4 zoom)
                 cx   (+ (:x r) (/ (:width r) 2))
                 cy   (+ (:y r) (/ (:height r) 2))
                 [w h] (if (= axis :x)
                         [thick (min len (max thick (:height r)))]
                         [(min len (max thick (:width r))) thick])
                 ;; a wider transparent target, easier to grab
                 hit  (/ 8 zoom)]
             [:g {:key (dm/str "handle-" idx)}
              [:rect {:x (- cx (/ (max w hit) 2))
                      :y (- cy (/ (max h hit) 2))
                      :width (max w hit)
                      :height (max h hit)
                      :class cursor
                      :data-testid "zvena-smart-gap"
                      :style {:fill "transparent"}
                      :on-pointer-enter on-pointer-enter
                      :on-pointer-leave on-pointer-leave
                      :on-pointer-down on-pointer-down
                      :on-pointer-move on-pointer-move
                      :on-lost-pointer-capture on-lost-pointer-capture}]
              [:rect {:x (- cx (/ w 2))
                      :y (- cy (/ h 2))
                      :width w
                      :height h
                      :rx (/ thick 2)
                      :style {:fill mconst/distance-color
                              :stroke "#ffffff"
                              :stroke-width stroke
                              :pointer-events "none"}}]]))

         (when active?
           (let [r (first rects)
                 cx (+ (:x r) (/ (:width r) 2))
                 cy (+ (:y r) (/ (:height r) 2))
                 [px py] (if (= axis :x)
                           [(- cx (/ pill-w 2)) (+ (:y r) (:height r) (/ 6 zoom))]
                           [(+ (:x r) (:width r) (/ 6 zoom)) (- cy (/ pill-h 2))])]
             [:g {:style {:pointer-events "none"}}
              [:& fcc/flex-display-pill
               {:x px :y py
                :width pill-w :height pill-h
                :font-size (/ mconst/font-size zoom)
                :border-radius (/ fcc/flex-display-pill-border-radius zoom)
                :color mconst/distance-color
                :value value}]]))]))))
