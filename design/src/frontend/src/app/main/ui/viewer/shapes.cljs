;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.viewer.shapes
  "The main container for a frame in viewer mode"
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.geom.shapes :as gsh]
   [app.common.types.shape.interactions :as ctsi]
   [app.main.data.viewer :as dv]
   [app.main.refs :as refs]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.shapes.bool :as bool]
   [app.main.ui.shapes.circle :as circle]
   [app.main.ui.shapes.frame :as frame]
   [app.main.ui.shapes.group :as group]
   [app.main.ui.shapes.image :as image]
   [app.main.ui.shapes.path :as path]
   [app.main.ui.shapes.rect :as rect]
   [app.main.ui.shapes.shape :refer [shape-container]]
   [app.main.ui.shapes.svg-raw :as svg-raw]
   [app.main.ui.shapes.text :as text]
   [app.main.ui.viewer.zvena.proto :as zproto]
   [app.main.ui.viewer.zvena.scroll :as zscroll] ;; zvena: scroll overflow & sticky
   [app.main.ui.viewer.zvena.variables :as zvars] ;; zvena: prototype variables
   [app.main.ui.viewer.zvena.variants :as zvariants]
   [app.util.dom :as dom]
   [app.util.object :as obj]
   [app.util.timers :as tm]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def base-frame-ctx (mf/create-context nil))
(def frame-offset-ctx (mf/create-context nil))

(def ^:private ref:viewer-show-interactions
  (l/derived :show-interactions refs/viewer-local))

(defn- find-relative-to-base-frame
  [shape objects overlays-ids base-frame]
  (cond
    (cfh/frame-shape? shape) shape
    (or (empty? overlays-ids) (nil? shape) (cfh/root? shape)) base-frame
    :else (find-relative-to-base-frame (cfh/get-parent objects (:id shape)) objects overlays-ids base-frame)))

(defn- ignore-frame-shape
  [shape objects manual?]
  (let [shape (cond-> shape ;; When the the interaction is not manual and its origin is a frame,
                ;; we need to ignore it on all the find-frame calculations
                (and (:frame-id shape) (not manual?))
                (assoc :type :rect))
        objects (assoc objects (:id shape) shape)]
    [shape objects]))

(defn- containing-overlay
  "zvena: the open overlay that contains `shape` or, when it is not inside
  one, the top overlay (Figma \"Swap overlay\")."
  [objects shape overlays]
  (let [ids (into #{} (map :id) overlays)
        own (d/seek #(contains? ids %)
                    (cfh/get-parent-ids-seq-with-self objects (:id shape)))]
    (if (some? own)
      (d/seek #(= own (:id %)) overlays)
      (last overlays))))

(defn- activate-interaction
  [interaction shape base-frame frame-offset objects overlays]
  (case (:action-type interaction)
    :navigate
    (when-let [frame-id (:destination interaction)]
      (let [viewer-section (dom/get-element "viewer-section")
            scroll (if (:preserve-scroll interaction)
                     (dom/get-scroll-pos viewer-section)
                     0)]
        (st/emit! (dv/set-nav-scroll scroll)
                  (dv/go-to-frame frame-id (:animation interaction)))))

    :open-overlay
    (let [manual?                    (= :manual (:overlay-pos-type interaction))
          [shape objects]            (ignore-frame-shape shape objects manual?)
          dest-frame-id              (:destination interaction)
          dest-frame                 (get objects dest-frame-id)
          relative-to-id             (if manual?
                                       (if (= (:type shape) :frame) ;; manual interactions are always from "self"
                                         (:frame-id shape)
                                         (:id shape))
                                       (:position-relative-to interaction))
          relative-to-shape          (or (get objects relative-to-id) base-frame)
          close-click-outside        (:close-click-outside interaction)
          background-overlay         (:background-overlay interaction)
          overlays-ids               (set (map :id overlays))
          relative-to-base-frame     (find-relative-to-base-frame relative-to-shape objects overlays-ids base-frame)
          fixed-base?                (cfh/fixed? objects relative-to-id)
          [position snap-to]         (ctsi/calc-overlay-position interaction
                                                                 shape
                                                                 objects
                                                                 relative-to-shape
                                                                 relative-to-base-frame
                                                                 dest-frame
                                                                 frame-offset)]
      (when dest-frame-id
        (st/emit! (dv/open-overlay dest-frame-id
                                   position
                                   snap-to
                                   close-click-outside
                                   background-overlay
                                   (:animation interaction)
                                   fixed-base?))))

    :toggle-overlay
    (let [manual?                    (= :manual (:overlay-pos-type interaction))
          [shape objects]            (ignore-frame-shape shape objects manual?)
          dest-frame-id              (:destination interaction)
          dest-frame                 (get objects dest-frame-id)
          relative-to-id             (if (= :manual (:overlay-pos-type interaction))
                                       (if (= (:type shape) :frame) ;; manual interactions are always from "self"
                                         (:frame-id shape)
                                         (:id shape))
                                       (:position-relative-to interaction))
          relative-to-shape          (or (get objects relative-to-id) base-frame)
          overlays-ids               (set (map :id overlays))
          relative-to-base-frame     (find-relative-to-base-frame relative-to-shape objects overlays-ids base-frame)
          fixed-base?                (cfh/fixed? objects (:id base-frame))
          [position snap-to]         (ctsi/calc-overlay-position interaction
                                                                 shape
                                                                 objects
                                                                 relative-to-shape
                                                                 relative-to-base-frame
                                                                 dest-frame
                                                                 frame-offset)

          close-click-outside        (:close-click-outside interaction)
          background-overlay         (:background-overlay interaction)]
      (when dest-frame-id
        (st/emit! (dv/toggle-overlay dest-frame-id
                                     position
                                     snap-to
                                     close-click-outside
                                     background-overlay
                                     (:animation interaction)
                                     fixed-base?))))

    :close-overlay
    (let [dest-frame-id (or (:destination interaction)
                            (if (and (= (:type shape) :frame)
                                     (some #(= (:id %) (:id shape)) overlays))
                              (:id shape)
                              (:frame-id shape)))]
      (st/emit! (dv/close-overlay dest-frame-id (:animation interaction))))

    :prev-screen
    (st/emit! (rt/nav-back-local))

    :open-url
    (st/emit! (dom/open-new-window (:url interaction)))

    ;; zvena: Figma "Scroll to"
    :scroll-to
    ;; zvena: scroll overflow — the scrolling boards around the layer
    ;; scroll first, then the viewer scrolls to the outermost one
    (zproto/scroll-to! (zscroll/scroll-to! interaction objects) objects)

    ;; zvena: Figma "Change to" (interactive components)
    :change-to
    (zvariants/change-to! interaction shape objects)

    ;; zvena: Figma "Swap overlay": the overlay of the layer (or the top
    ;; one) is replaced by the destination, placed with the interaction
    ;; overlay options
    :swap-overlay
    (let [manual?                (= :manual (:overlay-pos-type interaction))
          [shape objects]        (ignore-frame-shape shape objects manual?)
          dest-frame-id          (:destination interaction)
          dest-frame             (get objects dest-frame-id)
          relative-to-id         (if manual?
                                   (if (= (:type shape) :frame)
                                     (:frame-id shape)
                                     (:id shape))
                                   (:position-relative-to interaction))
          relative-to-shape      (or (get objects relative-to-id) base-frame)
          overlays-ids           (set (map :id overlays))
          relative-to-base-frame (find-relative-to-base-frame relative-to-shape objects overlays-ids base-frame)
          fixed-base?            (cfh/fixed? objects relative-to-id)
          [position snap-to]     (ctsi/calc-overlay-position interaction
                                                             shape
                                                             objects
                                                             relative-to-shape
                                                             relative-to-base-frame
                                                             dest-frame
                                                             frame-offset)
          current                (containing-overlay objects shape overlays)]
      (when (some? dest-frame-id)
        (when (and (some? current) (not= (:id current) dest-frame-id))
          (st/emit! (dv/close-overlay (:id current))))
        (st/emit! (dv/open-overlay dest-frame-id
                                   position
                                   snap-to
                                   (:close-click-outside interaction)
                                   (:background-overlay interaction)
                                   (:animation interaction)
                                   fixed-base?))))

    ;; zvena: Figma variables in prototypes (Set variable, Conditional)
    :set-variable
    (zvars/set-variable! interaction)

    :conditional
    (doseq [action (zvars/branch-actions interaction objects)]
      (activate-interaction action shape base-frame frame-offset objects overlays))

    nil))

;; Perform the opposite action of an interaction, if possible
(defn- deactivate-interaction
  [interaction shape base-frame frame-offset objects overlays]
  (case (:action-type interaction)
    :open-overlay
    (let [frame-id (or (:destination interaction)
                       (if (= (:type shape) :frame)
                         (:id shape)
                         (:frame-id shape)))]
      (st/emit! (dv/close-overlay frame-id)))

    :toggle-overlay
    (let [manual?                    (= :manual (:overlay-pos-type interaction))
          [shape objects]            (ignore-frame-shape shape objects manual?)
          dest-frame-id              (:destination interaction)
          dest-frame                 (get objects dest-frame-id)
          relative-to-id             (if (= :manual (:overlay-pos-type interaction))
                                       (if (= (:type shape) :frame) ;; manual interactions are always from "self"
                                         (:frame-id shape)
                                         (:id shape))
                                       (:position-relative-to interaction))
          relative-to-shape          (or (get objects relative-to-id) base-frame)
          overlays-ids               (set (map :id overlays))
          relative-to-base-frame     (find-relative-to-base-frame relative-to-shape objects overlays-ids base-frame)
          fixed-base?                (cfh/fixed? objects (:id base-frame))
          [position snap-to]         (ctsi/calc-overlay-position interaction
                                                                 shape
                                                                 objects
                                                                 relative-to-shape
                                                                 relative-to-base-frame
                                                                 dest-frame
                                                                 frame-offset)

          close-click-outside        (:close-click-outside interaction)
          background-overlay         (:background-overlay interaction)]
      (when dest-frame-id
        (st/emit! (dv/toggle-overlay dest-frame-id
                                     position
                                     snap-to
                                     close-click-outside
                                     background-overlay
                                     (:animation interaction)
                                     fixed-base?))))


    :close-overlay
    (let [manual?                    (= :manual (:overlay-pos-type interaction))
          [shape objects]            (ignore-frame-shape shape objects manual?)
          dest-frame-id              (:destination interaction)
          dest-frame                 (get objects dest-frame-id)
          relative-to-id             (if (= :manual (:overlay-pos-type interaction))
                                       (if (= (:type shape) :frame) ;; manual interactions are always from "self"
                                         (:frame-id shape)
                                         (:id shape))
                                       (:position-relative-to interaction))
          relative-to-shape          (or (get objects relative-to-id) base-frame)
          close-click-outside        (:close-click-outside interaction)
          background-overlay         (:background-overlay interaction)
          overlays-ids               (set (map :id overlays))
          relative-to-base-frame     (find-relative-to-base-frame relative-to-shape objects overlays-ids base-frame)
          fixed-base?                (cfh/fixed? objects (:id base-frame))
          [position snap-to]         (ctsi/calc-overlay-position interaction
                                                                 shape
                                                                 objects
                                                                 relative-to-shape
                                                                 relative-to-base-frame
                                                                 dest-frame
                                                                 frame-offset)]
      (when dest-frame-id
        (st/emit! (dv/open-overlay dest-frame-id
                                   position
                                   snap-to
                                   close-click-outside
                                   background-overlay
                                   (:animation interaction)
                                   fixed-base?))))

    ;; zvena: a While hovering / While pressing "Change to" reverts by
    ;; itself when the hover / press ends (the layer under the pointer
    ;; is another one by then), see `zvariants/change-to!`
    :change-to
    nil

    nil))

(defn- on-pointer-down
  [event shape base-frame frame-offset objects overlays]
  (let [interactions (->> (:interactions shape)
                          (filter #(or (= (:event-type %) :click)
                                       (= (:event-type %) :mouse-press))))
        ;; zvena: Figma "On drag"
        drag-interactions (->> (:interactions shape)
                               (filterv #(= (:event-type %) :drag)))
        activate (fn [interaction]
                   (activate-interaction interaction shape base-frame frame-offset objects overlays))]
    (cond
      (seq drag-interactions)
      ;; With a drag trigger the press waits to know if it becomes a
      ;; drag; a release without moving runs the click interactions.
      (let [press-interactions (filterv #(= (:event-type %) :mouse-press) interactions)
            click-interactions (filterv #(= (:event-type %) :click) interactions)]
        (dom/stop-propagation event)
        (run! activate press-interactions)
        (zproto/track-drag! event
                            #(run! activate drag-interactions)
                            #(run! activate click-interactions)))

      (seq interactions)
      (do
        (dom/stop-propagation event)
        (doseq [interaction interactions]
          (activate interaction))))))

(defn- on-pointer-up
  [event shape base-frame frame-offset objects overlays]
  (let [interactions (->> (:interactions shape)
                          (filter #(= (:event-type %) :mouse-press)))]
    (when (seq interactions)
      (dom/stop-propagation event)
      (doseq [interaction interactions]
        (deactivate-interaction interaction shape base-frame frame-offset objects overlays)))))

(defn- on-pointer-enter
  [event shape base-frame frame-offset objects overlays]
  (let [interactions (->> (:interactions shape)
                          (filter #(or (= (:event-type %) :mouse-enter)
                                       (= (:event-type %) :mouse-over))))]
    (when (seq interactions)
      (dom/stop-propagation event)
      (doseq [interaction interactions]
        (activate-interaction interaction shape base-frame frame-offset objects overlays)))))

(defn- on-pointer-leave
  [event shape base-frame frame-offset objects overlays]
  (let [interactions     (->> (:interactions shape)
                              (filter #(= (:event-type %) :mouse-leave)))
        interactions-inv (->> (:interactions shape)
                              (filter #(= (:event-type %) :mouse-over)))]
    (when (or (seq interactions) (seq interactions-inv))
      (dom/stop-propagation event)
      (doseq [interaction interactions]
        (activate-interaction interaction shape base-frame frame-offset objects overlays))
      (doseq [interaction interactions-inv]
        (deactivate-interaction interaction shape base-frame frame-offset objects overlays)))))

(defn- on-key-mount
  "zvena: Figma Key/Gamepad trigger. Listens to the keys of the shape key
  interactions while it is rendered; returns the cleanup function."
  [shape base-frame frame-offset objects overlays]
  (zproto/listen-keys! shape
                       #(activate-interaction % shape base-frame frame-offset objects overlays)))

(defn- on-load
  [shape base-frame frame-offset objects overlays]
  (let [interactions (->> (:interactions shape)
                          (filter #(= (:event-type %) :after-delay)))]
    (loop [interactions (seq interactions)
           sems []]
      (if-let [interaction (first interactions)]
        (let [sem (tm/schedule (:delay interaction)
                               #(activate-interaction interaction shape base-frame frame-offset objects overlays))]
          (recur (next interactions)
                 (conj sems sem)))
        sems))))

(mf/defc interaction
  [{:keys [shape interactions show-interactions]}]
  (let [{:keys [x y width height]} (:selrect shape)]
    (when-not (empty? interactions)
      [:rect {:x (- x 1)
              :y (- y 1)
              :width (+ width 2)
              :height (+ height 2)
              :fill "var(--color-accent-tertiary)"
              :stroke "var(--color-accent-tertiary)"
              :stroke-width (if show-interactions 1 0)
              :fill-opacity (if show-interactions 0.2 0)
              :pointer-events "none"
              :transform (gsh/transform-str shape)}])))

;; --- WASM viewer hotspots ---
;; In WASM viewer mode the frame pixels come from a WASM snapshot, so we don't
;; render the SVG visuals at all. We only render the actionable areas (hotspots)
;; on top of the image: a transparent hit/highlight rect per interactive shape,
;; wired to the same interaction handlers as the regular SVG tree.

(mf/defc hotspot*
  [{:keys [shape all-objects]}]
  (let [base-frame   (mf/use-ctx base-frame-ctx)
        frame-offset (mf/use-ctx frame-offset-ctx)
        show-interactions (mf/deref ref:viewer-show-interactions)
        overlays     (mf/deref refs/viewer-overlays)
        interactions (:interactions shape)
        {:keys [x y width height]} (:selrect shape)

        on-pd (mf/use-fn (mf/deps shape base-frame frame-offset all-objects overlays)
                         #(on-pointer-down % shape base-frame frame-offset all-objects overlays))
        on-pu (mf/use-fn (mf/deps shape base-frame frame-offset all-objects overlays)
                         #(on-pointer-up % shape base-frame frame-offset all-objects overlays))
        on-pe (mf/use-fn (mf/deps shape base-frame frame-offset all-objects overlays)
                         #(on-pointer-enter % shape base-frame frame-offset all-objects overlays))
        on-pl (mf/use-fn (mf/deps shape base-frame frame-offset all-objects overlays)
                         #(on-pointer-leave % shape base-frame frame-offset all-objects overlays))]

    (mf/with-effect []
      (let [sems (on-load shape base-frame frame-offset all-objects overlays)]
        (partial run! tm/dispose! sems)))

    ;; zvena: Key/Gamepad trigger
    (mf/with-effect [shape base-frame frame-offset all-objects overlays]
      (on-key-mount shape base-frame frame-offset all-objects overlays))

    [:g {:style {:cursor (when (ctsi/actionable? interactions) "pointer")}
         :on-pointer-down on-pd
         :on-pointer-up on-pu
         :on-pointer-enter on-pe
         :on-pointer-leave on-pl}
     [:rect {:x (- x 1)
             :y (- y 1)
             :width (+ width 2)
             :height (+ height 2)
             :fill "var(--color-accent-tertiary)"
             :stroke "var(--color-accent-tertiary)"
             :stroke-width (if show-interactions 1 0)
             :fill-opacity (if show-interactions 0.2 0)
             ;; This rect is the only hit target, so it must always capture
             ;; pointer events even when fully transparent.
             :pointer-events "all"
             :transform (gsh/transform-str shape)}]]))

(mf/defc frame-hotspots*
  "Renders interaction hotspots for a frame subtree (WASM viewer mode).
  `objects` must be the prepared (vbox-space) objects and `frame` the prepared
  frame; only shapes with interactions produce a hotspot.

  Optional `shape-filter` is a predicate that receives the shape id and returns
  true when it should be included (used to split fixed-scroll vs normal layers)."
  [{:keys [objects all-objects shape-filter frame]}]
  (let [all-objects (or all-objects objects)
        frame-id    (:id frame)
        ids         (cond->> (cons frame-id (cfh/get-children-ids objects frame-id))
                      shape-filter (filter shape-filter))
        hotspots    (->> ids
                         (keep #(get objects %))
                         ;; zvena: + the interactions of the main component
                         (map zvariants/with-interactions)
                         (filter (fn [s] (and (not (:hidden s))
                                              (seq (:interactions s))))))]
    [:g {}
     (for [shape hotspots]
       [:> hotspot* {:key (str (:id shape))
                     :shape shape
                     :all-objects all-objects}])]))


;; TODO: use-memo use-fn

(defn generic-wrapper-factory
  "Wrap some svg shape and add interaction controls"
  [component]
  (mf/fnc generic-wrapper
    {::mf/wrap-props false}
    [props]
    (let [shape              (unchecked-get props "shape")
          childs             (unchecked-get props "childs")
          frame              (unchecked-get props "frame")
          objects            (unchecked-get props "objects")
          all-objects        (or (unchecked-get props "all-objects") objects)
          base-frame         (mf/use-ctx base-frame-ctx)
          frame-offset       (mf/use-ctx frame-offset-ctx)
          show-interactions  (mf/deref ref:viewer-show-interactions)
          overlays           (mf/deref refs/viewer-overlays)
          ;; zvena: an instance runs the interactions of its main
          ;; component too (Figma interactive components); `ishape` is
          ;; the shape with all of them, for the interaction handlers
          ishape             (mf/with-memo [shape]
                               (zvariants/with-interactions shape))
          interactions       (:interactions ishape)
          svg-element?       (and (= :svg-raw (:type shape))
                                  (not= :svg (get-in shape [:content :tag])))

          ;; The objects parameter has the shapes that we must draw. It may be a subset of
          ;; all-objects in some cases (e.g. if there are fixed elements). But for interactions
          ;; handling we need access to all objects inside the page.

          ;; zvena: `overlays` in the deps (Swap overlay reads them)
          on-pointer-down
          (mf/use-fn (mf/deps ishape base-frame frame-offset all-objects overlays)
                     #(on-pointer-down % ishape base-frame frame-offset all-objects overlays))

          on-pointer-up
          (mf/use-fn (mf/deps ishape base-frame frame-offset all-objects overlays)
                     #(on-pointer-up % ishape base-frame frame-offset all-objects overlays))

          on-pointer-enter
          (mf/use-fn (mf/deps ishape base-frame frame-offset all-objects overlays)
                     #(on-pointer-enter % ishape base-frame frame-offset all-objects overlays))

          on-pointer-leave
          (mf/use-fn (mf/deps ishape base-frame frame-offset all-objects overlays)
                     #(on-pointer-leave % ishape base-frame frame-offset all-objects overlays))]

      (mf/with-effect []
        (let [sems (on-load ishape base-frame frame-offset all-objects overlays)]
          (partial run! tm/dispose! sems)))

      ;; zvena: Key/Gamepad trigger
      (mf/with-effect [ishape base-frame frame-offset all-objects overlays]
        (on-key-mount ishape base-frame frame-offset all-objects overlays))

      (if-not svg-element?
        [:> shape-container {:shape shape
                             :cursor (when (ctsi/actionable? interactions) "pointer")
                             :on-pointer-down on-pointer-down
                             :on-pointer-up on-pointer-up
                             :on-pointer-enter on-pointer-enter
                             :on-pointer-leave on-pointer-leave}

         [:& component {:shape shape
                        :frame frame
                        :childs childs
                        :is-child-selected? true
                        :objects objects}]

         [:& interaction {:shape shape
                          :interactions interactions
                          :show-interactions show-interactions}]]

        ;; Don't wrap svg elements inside a <g> otherwise some can break
        [:& component {:shape shape
                       :frame frame
                       :childs childs
                       :objects objects}]))))

(defn frame-wrapper
  [shape-container]
  ;; zvena: scroll overflow & sticky — boards that scroll (or the screen
  ;; with sticky layers) get the scroll runtime, the rest render as before
  (generic-wrapper-factory (zscroll/frame-shape shape-container base-frame-ctx)))

(defn group-wrapper
  [shape-container]
  (generic-wrapper-factory (group/group-shape shape-container)))

(defn bool-wrapper
  [shape-container]
  (generic-wrapper-factory (bool/bool-shape shape-container)))

(defn svg-raw-wrapper
  [shape-container]
  (generic-wrapper-factory (svg-raw/svg-raw-shape shape-container)))

(defn rect-wrapper
  []
  (generic-wrapper-factory rect/rect-shape))

(defn image-wrapper
  []
  (generic-wrapper-factory image/image-shape))

(defn path-wrapper
  []
  (generic-wrapper-factory path/path-shape))

(defn text-wrapper
  []
  ;; zvena: renders the texts bound to a variable with its value
  (generic-wrapper-factory (zvars/text-shape-wrapper text/text-shape)))

(defn circle-wrapper
  []
  (generic-wrapper-factory circle/circle-shape))

(declare shape-container-factory)

(defn frame-container-factory
  [objects all-objects]
  (let [shape-container (shape-container-factory objects all-objects)
        frame-wrapper   (frame-wrapper shape-container)
        lookup-xf       (keep (d/getf objects))]
    (mf/fnc frame-container
      {::mf/wrap-props false}
      [props]
      (let [shape  (unchecked-get props "shape")
            childs (into [] lookup-xf (:shapes shape))
            props  (obj/merge props
                              #js {:childs childs
                                   :objects objects
                                   :all-objects all-objects})]
        [:> frame-wrapper props]))))

(defn group-container-factory
  [objects all-objects]
  (let [shape-container (shape-container-factory objects all-objects)
        group-wrapper (group-wrapper shape-container)]
    (mf/fnc group-container
      {::mf/wrap-props false}
      [props]
      (let [childs   (mapv #(get objects %) (:shapes (unchecked-get props "shape")))
            props    (obj/merge! #js {} props
                                 #js {:childs childs
                                      :objects objects
                                      :all-objects all-objects})]
        (when (not-empty childs)
          [:> group-wrapper props])))))

(defn bool-container-factory
  [objects all-objects]
  (let [shape-container (shape-container-factory objects all-objects)
        bool-wrapper (bool-wrapper shape-container)]
    (mf/fnc bool-container
      {::mf/wrap-props false}
      [props]
      (let [childs (->> (cfh/get-children-ids objects (:id (unchecked-get props "shape")))
                        (select-keys objects))
            props  (obj/merge! #js {} props
                               #js {:childs childs
                                    :objects objects})]
        [:> bool-wrapper props]))))

(defn svg-raw-container-factory
  [objects all-objects]
  (let [shape-container (shape-container-factory objects all-objects)
        svg-raw-wrapper (svg-raw-wrapper shape-container)]
    (mf/fnc svg-raw-container
      {::mf/wrap-props false}
      [props]
      (let [childs (mapv #(get objects %) (:shapes (unchecked-get props "shape")))
            props  (obj/merge! #js {} props
                               #js {:childs childs
                                    :objects objects})]
        [:> svg-raw-wrapper props]))))

(mf/defc variant-instance*
  "zvena: an instance switched to another variant by a Figma \"Change
  to\" interaction: the main of `component-id` is rendered in its place
  (see `app.main.ui.viewer.zvena.variants`)."
  [{:keys [shape frame component-id objects all-objects]}]
  (let [all-objects  (or all-objects objects)
        built        (mf/with-memo [shape component-id all-objects]
                       (zvariants/build-instance shape all-objects component-id))
        objects*     (mf/with-memo [objects built]
                       (merge objects (:objects built)))
        all-objects* (mf/with-memo [all-objects built]
                       (merge all-objects (:objects built)))
        container    (mf/with-memo [objects* all-objects*]
                       (shape-container-factory objects* all-objects*))]
    (when (some? built)
      [:> container #js {:shape (:root built) :frame frame}])))

(defn shape-container-factory
  [objects all-objects]
  (let [path-wrapper   (path-wrapper)
        text-wrapper   (text-wrapper)
        rect-wrapper   (rect-wrapper)
        image-wrapper  (image-wrapper)
        circle-wrapper (circle-wrapper)]
    (mf/fnc shape-container
      {::mf/wrap-props false
       ::mf/wrap [mf/memo]}
      [props]
      (let [shape   (unchecked-get props "shape")
            frame   (unchecked-get props "frame")

            ;; zvena: prototype variables: visibility, text and colors
            ;; bound to variables take their values in this session
            vars-ref    (mf/with-memo [shape] (zvars/shape-ref shape))
            shape       (zvars/apply-vars shape (mf/deref vars-ref) all-objects)

            ;; zvena: Figma "Change to": the variant this instance shows
            ;; in the prototype (nil: the instance as it is)
            shape-id    (:id shape)
            variant-ref (mf/with-memo [shape-id]
                          (zvariants/instance-ref shape-id))
            variant     (mf/deref variant-ref)
            variant     (when (and (some? variant)
                                   (not (zvariants/variant-root? shape))
                                   (zvariants/can-build? variant))
                          variant)

            group-container
            (mf/with-memo [objects]
              (group-container-factory objects all-objects))

            frame-container
            (mf/with-memo [objects]
              (frame-container-factory objects all-objects))

            bool-container
            (mf/with-memo [objects]
              (bool-container-factory objects all-objects))

            svg-raw-container
            (mf/with-memo [objects]
              (svg-raw-container-factory objects all-objects))]
        (when (and shape (not (:hidden shape)))
          (if (some? variant)
            ;; zvena: the instance shows another variant
            [:> variant-instance* {:shape shape
                                   :frame frame
                                   :component-id variant
                                   :objects objects
                                   :all-objects all-objects}]

            (let [shape (if frame
                          (gsh/translate-to-frame shape frame)
                          shape)

                  opts #js {:shape shape
                            :objects objects
                            :all-objects all-objects}]
              (case (:type shape)
                :frame   [:> frame-container opts]
                :text    [:> text-wrapper opts]
                :rect    [:> rect-wrapper opts]
                :path    [:> path-wrapper opts]
                :image   [:> image-wrapper opts]
                :circle  [:> circle-wrapper opts]
                :group   [:> group-container {:shape shape :frame frame :objects objects}]
                :bool    [:> bool-container {:shape shape :frame frame :objects objects}]
                :svg-raw [:> svg-raw-container {:shape shape :frame frame :objects objects}]))))))))
