;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.viewer.zvena.variants
  "zvena: Figma interactive components for the viewer.

  - Interactions of a main component work in all its instances: a copy
    has its own interactions plus the ones of its main whose trigger it
    does not override (`with-interactions`).

  - \"Change to\": an instance shows another variant of its component
    set. The viewer keeps `state`, a map {instance id -> component id};
    an instance in the map is rendered with the main tree of that
    component, moved to the instance top-left (`build-instance`). The
    root keeps the instance id; the other layers get ids derived from
    (instance, main layer), so the interactions of the new variant layers
    work too (a button can switch back and forth).

  - \"While hovering\" / \"While pressing\" changes revert when the pointer
    leaves the layer / is released (Figma).

  - Instant, Dissolve and Smart animate transitions; smart animate pairs
    the layers with the same name path (as `smart-animate` does for
    boards) and animates them FLIP-style on the rendered SVG."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.modifiers :as gm]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.math :as mth]
   [app.common.types.modifiers :as ctm]
   [app.common.types.shape.interactions :as ctsi]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.text :as txt]
   [app.common.uuid :as uuid]
   [app.main.store :as st]
   [app.main.ui.viewer.zvena.easing :as ez]
   [app.main.ui.viewer.zvena.smart-animate :as sa]
   [app.util.timers :as tm]
   [okulary.core :as l]))

;; --- State

(defonce ^{:doc "zvena: {instance id -> component id} of the instances
  that show another variant. An instance not in the map is shown as it
  is in the file."}
  state
  (l/atom {}))

(defn instance-ref
  "A ref to the variant (component id) the instance `id` shows, or nil."
  [id]
  (l/derived #(get % id) state))

(defn variant-root?
  "True for the root of an instance rendered as another variant."
  [shape]
  (true? (::variant-root shape)))

;; --- File data

(defonce ^:private ctx-cache (volatile! nil))

(defn- make-ctx
  [viewer]
  (let [datas (into []
                    (keep :data)
                    (cons (:file viewer) (vals (:libraries viewer))))
        pages (into []
                    (comp (mapcat #(vals (:pages-index %)))
                          (keep (fn [page]
                                  (let [objects (when (map? page) (:objects page))]
                                    (when (map? objects) objects)))))
                    datas)]
    {:datas datas
     :pages pages}))

(defn- current-ctx
  "Components and pages of the viewed file and its libraries."
  []
  (let [viewer (:viewer @st/state)
        file   (:file viewer)
        libs   (:libraries viewer)
        cached @ctx-cache]
    (if (and (some? cached)
             (identical? file (:file cached))
             (identical? libs (:libs cached)))
      (:ctx cached)
      (let [ctx (make-ctx viewer)]
        (vreset! ctx-cache {:file file :libs libs :ctx ctx})
        ctx))))

(defn- lookup-shape
  [ctx id]
  (when (some? id)
    (some #(get % id) (:pages ctx))))

(defn- lookup-component
  "[file-data component] of a (not deleted) component."
  [ctx component-id]
  (when (some? component-id)
    (some (fn [data]
            (let [component (dm/get-in data [:components component-id])]
              (when (and (some? component) (not (:deleted component)))
                [data component])))
          (:datas ctx))))

(defn- main-tree
  "[root objects] of the main instance of the component."
  [data component]
  (let [objects (dm/get-in data [:pages-index (:main-instance-page component) :objects])
        root    (when (map? objects) (get objects (:main-instance-id component)))]
    (when (some? root)
      [root objects])))

(defn can-build?
  "True when the main of the component is available in the viewer."
  [component-id]
  (let [[data component] (lookup-component (current-ctx) component-id)]
    (some? (when (some? component) (main-tree data component)))))

;; --- Inherited interactions

(defn- merge-interactions
  "The `own` interactions plus the `inherited` ones whose trigger is not
  overridden by an own one."
  [own inherited]
  (cond
    (empty? inherited) own
    (empty? own)       (vec inherited)
    :else
    (into (vec own)
          (remove (fn [interaction]
                    (some #(ctsi/same-trigger? % interaction) own)))
          inherited)))

(defn- resolve-interactions
  "Interactions of the shape merged with the ones of its main (and of the
  main of its main...)."
  [ctx shape]
  (loop [result (:interactions shape)
         ref-id (:shape-ref shape)
         depth  0]
    (if (and (some? ref-id) (< depth 8))
      (if-let [ref (lookup-shape ctx ref-id)]
        (recur (merge-interactions result (:interactions ref))
               (:shape-ref ref)
               (inc depth))
        result)
      result)))

(defn with-interactions
  "zvena: the shape with the interactions it has in the viewer. As in
  Figma, an instance (and every layer of it) runs the interactions of
  its main component unless it overrides their trigger."
  [shape]
  (if (or (nil? shape)
          (nil? (:shape-ref shape))
          (::resolved shape))
    shape
    (let [interactions (resolve-interactions (current-ctx) shape)]
      (if (identical? interactions (:interactions shape))
        shape
        (assoc shape :interactions interactions)))))

;; --- Layers matching (by name path, as Figma smart animate)

(defn- name-path
  "Names of the layers below `root-id` down to `id` (the root path is [])."
  [objects root-id id]
  (loop [id id names () guard 0]
    (if (or (nil? id) (= id root-id) (> guard 128))
      (vec names)
      (let [shape (get objects id)]
        (if (nil? shape)
          (vec names)
          (recur (:parent-id shape) (cons (:name shape) names) (inc guard)))))))

(defn- match-ids
  "Map of `b` layer id -> `a` layer id; the layers with the same name path
  (relative to their roots) are paired in tree order."
  [a-objects a-root a-ids b-objects b-root b-ids]
  (let [a-index (reduce (fn [acc id]
                          (update acc (name-path a-objects a-root id) (fnil conj []) id))
                        {}
                        a-ids)]
    (loop [ids b-ids counts {} result {}]
      (if-let [id (first ids)]
        (let [k (name-path b-objects b-root id)
              i (get counts k 0)
              a (get-in a-index [k i])]
          (recur (rest ids)
                 (assoc counts k (inc i))
                 (cond-> result (some? a) (assoc id a))))
        result))))

;; --- Overrides

(defn- touched?
  [shape group]
  (contains? (:touched shape) group))

(defn- carry-text
  "Figma keeps the text of an instance when it changes variant, unless
  the variant changes it: `target` is the layer of the new variant,
  `source` the overridden layer of the instance and `main` the layer of
  the main the instance comes from. The text keeps its layout
  (position data) with the fills of the new variant."
  [target source main]
  (let [t-text (txt/content->text (:content target))
        s-text (txt/content->text (:content source))
        m-text (some-> (:content main) txt/content->text)]
    (if (and (seq (:position-data source))
             (not= s-text t-text)
             (or (nil? main) (= m-text t-text)))
      (let [dx    (- (dm/get-in target [:selrect :x]) (dm/get-in source [:selrect :x]))
            dy    (- (dm/get-in target [:selrect :y]) (dm/get-in source [:selrect :y]))
            fills (some-> (:position-data target) first :fills)]
        (-> target
            (assoc :content (txt/change-text (:content target) s-text))
            (assoc :position-data
                   (mapv (fn [data]
                           (cond-> (-> data
                                       (update :x + dx)
                                       (update :y + dy))
                             (some? fills)
                             (assoc :fills fills)))
                         (:position-data source)))))
      target)))

(defn- carry-overrides
  "The overrides of the instance layer `source` that the new variant does
  not change (it has the same value as `main`, the layer the instance
  comes from) are kept, as in Figma."
  [target source main]
  (cond-> target
    (and (touched? source :content-group)
         (cfh/text-shape? target)
         (cfh/text-shape? source)
         (some? (:content target))
         (some? (:content source)))
    (carry-text source main)

    (and (touched? source :fill-group)
         (not (cfh/text-shape? target))
         (some? main)
         (= (:fills main) (:fills target)))
    (assoc :fills (:fills source))

    (and (touched? source :visibility-group)
         (some? main)
         (= (:hidden main) (:hidden target)))
    (assoc :hidden (:hidden source))

    (and (touched? source :layer-effects-group)
         (some? main)
         (= (:opacity main) (:opacity target)))
    (assoc :opacity (:opacity source))))

;; --- Building the variant tree

(defonce ^:private virtual-ids (volatile! {}))

(defn- virtual-id
  "Stable id of the layer `main-id` rendered inside the instance `head-id`."
  [head-id main-id]
  (let [k [head-id main-id]]
    (or (get @virtual-ids k)
        (let [id (uuid/next)]
          (vswap! virtual-ids assoc k id)
          id))))

(defn- own-interactions
  "The interactions set on the instance itself (not inherited)."
  [shape]
  (if (contains? shape ::own-interactions)
    (::own-interactions shape)
    (:interactions shape)))

(defn build-instance
  "zvena: the layers that render the instance `inst` (a shape of
  `objects`, which has its layers too) as the main of `component-id`:
  the main tree moved to the instance top-left, its root with the
  instance id. Returns `{:root shape :objects {id shape}}` or nil."
  [inst objects component-id]
  (let [ctx              (current-ctx)
        [data component] (lookup-component ctx component-id)
        [main-root main-objects] (when (some? component) (main-tree data component))]
    (when (and (some? inst) (some? main-root))
      (let [head-id  (:id inst)
            delta    (gpt/point (- (dm/get-in inst [:selrect :x]) (dm/get-in main-root [:selrect :x]))
                                (- (dm/get-in inst [:selrect :y]) (dm/get-in main-root [:selrect :y])))
            main-ids (cfh/get-children-ids main-objects (:id main-root))
            ids-map  (into {(:id main-root) head-id}
                           (map (fn [id] [id (virtual-id head-id id)]))
                           main-ids)
            remap    #(get ids-map % %)

            ;; the layers of the instance, to keep its overrides
            src-ids  (cfh/get-children-ids objects head-id)
            matches  (match-ids objects head-id src-ids main-objects (:id main-root) main-ids)

            convert
            (fn [shape]
              (let [src      (some->> (get matches (:id shape)) (get objects))
                    frame-id (:frame-id shape)]
                (-> shape
                    (gsh/move delta)
                    (assoc :id (remap (:id shape)))
                    (assoc :parent-id (remap (:parent-id shape)))
                    (assoc :frame-id (if (contains? ids-map frame-id)
                                       (remap frame-id)
                                       (:frame-id inst)))
                    (d/update-when :shapes #(mapv remap %))
                    (cond-> (ctl/grid-layout? shape)
                      (ctl/remap-grid-cells ids-map))
                    ;; it reads as a copy of the main layer
                    (assoc :shape-ref (:id shape))
                    (assoc ::own-interactions (:interactions shape))
                    (assoc :interactions (resolve-interactions ctx shape))
                    (assoc ::resolved true)
                    (dissoc :main-instance :touched)
                    (cond-> (and (some? src) (seq (:touched src)))
                      (carry-overrides src (lookup-shape ctx (:shape-ref src)))))))

            root
            (-> (convert main-root)
                (assoc :id head-id
                       :parent-id (:parent-id inst)
                       :frame-id (:frame-id inst)
                       :name (:name inst)
                       :hidden (:hidden inst)
                       :fixed-scroll (:fixed-scroll inst)
                       :component-id (:id component)
                       :component-file (:id data)
                       ;; the instance own interactions win (Figma
                       ;; overrides), the rest come from the variant
                       :interactions (merge-interactions (own-interactions inst)
                                                         (resolve-interactions ctx main-root))
                       ::own-interactions (own-interactions inst)
                       ::variant-root true
                       ::real inst)
                (cond-> (some? (:component-root inst))
                  (assoc :component-root (:component-root inst)))
                (cond-> (nil? (:component-root inst))
                  (dissoc :component-root))
                (dissoc :variant-id :variant-name :variant-error)
                (cond-> (seq (:touched inst))
                  (carry-overrides inst (lookup-shape ctx (:shape-ref inst)))))]

        {:root root
         :objects (into {head-id root}
                        (map (fn [id]
                               (let [shape (convert (get main-objects id))]
                                 [(:id shape) shape])))
                        main-ids)}))))

;; --- Auto layout reflow

(defn- size-of
  [shape]
  [(dm/get-in shape [:selrect :width]) (dm/get-in shape [:selrect :height])])

(defn reflow-objects
  "zvena: `objects` with the auto layouts recomputed around the instances
  that show a variant of another size (`variants`: {instance id ->
  component id}), as Figma reflows the frame when \"Change to\" swaps a
  bigger or smaller variant: the siblings move and a hugging parent
  grows or shrinks. `objects` itself when nothing changes size."
  [objects variants]
  (let [resized
        (into {}
              (keep (fn [[inst-id component-id]]
                      (let [inst (get objects inst-id)]
                        (when (and (some? inst)
                                   (ctl/any-layout-immediate-child? objects inst))
                          (when-let [root (:root (build-instance inst objects component-id))]
                            (let [[w0 h0] (size-of inst)
                                  [w1 h1] (size-of root)]
                              (when (and (pos? w0) (pos? h0)
                                         (or (> (mth/abs (- w1 w0)) 0.01)
                                             (> (mth/abs (- h1 h0)) 0.01)))
                                [inst-id {:modifiers (ctm/resize-modifiers
                                                      (gpt/point (/ w1 w0) (/ h1 h0))
                                                      (gpt/point (dm/get-in inst [:selrect :x])
                                                                 (dm/get-in inst [:selrect :y])))}])))))))
              variants)]
    (if (empty? resized)
      objects
      (let [tree (gm/set-objects-modifiers resized objects)]
        (reduce-kv (fn [objects id {:keys [modifiers]}]
                     (if (and (some? modifiers) (contains? objects id))
                       (update objects id gsh/transform-shape modifiers)
                       objects))
                   objects
                   tree)))))

;; --- Transitions (Instant, Dissolve, Smart animate)

(defn- ghost?
  [^js node]
  (some? (.closest node "[data-zvena-ghost]")))

(defn- shape-selector
  [id]
  (dm/str "[id=\"shape-" id "\"]"))

(defn- live-nodes
  "Rendered nodes of the layer (not the transition copies)."
  ([id] (live-nodes js/document id))
  ([^js root id]
   (if (some? root)
     (->> (js/Array.from (.querySelectorAll root (shape-selector id)))
          (remove ghost?)
          (vec))
     [])))

(defn- tree-layers
  "{:objects :root :ids} of the layers rendered for the instance when it
  shows `value` (nil: the instance as it is in the file)."
  [real objects value]
  (if (nil? value)
    {:objects objects
     :root    (:id real)
     :ids     (into [(:id real)] (cfh/get-children-ids objects (:id real)))}
    (when-let [{:keys [root objects]} (build-instance real (assoc objects (:id real) real) value)]
      {:objects objects
       :root    (:id root)
       :ids     (into [(:id root)] (cfh/get-children-ids objects (:id root)))})))

(defn- box
  [shape]
  (let [{:keys [x y width height]} (:selrect shape)]
    {:x x :y y :w width :h height}))

(defn- opacity
  [shape]
  (d/nilv (:opacity shape) 1))

(defn- remove-later!
  [^js node duration]
  (js/setTimeout #(.remove node) (+ duration 50)))

(defn- smart-animate!
  "FLIP of the instance layers from `from-tree` to `to-tree` (see
  `tree-layers`); `head` is the rendered instance node and `ghost` a copy
  of the old rendering placed over it."
  [^js head ^js ghost from-tree to-tree opts-in]
  (let [o-objects (:objects from-tree)
        n-objects (:objects to-tree)
        matches   (match-ids o-objects (:root from-tree) (:ids from-tree)
                             n-objects (:root to-tree) (:ids to-tree))
        o-matched (into #{} (vals matches))
        head-id   (:root to-tree)
        depth     (fn [id] (count (cfh/get-parent-ids n-objects id)))]

    ;; the copy of the old rendering only shows the layers that leave
    (when (some? ghost)
      (doseq [id (:ids from-tree)
              :when (and (contains? o-matched id) (not= id (:root from-tree)))
              node (js/Array.from (.querySelectorAll ghost (shape-selector id)))]
        (sa/set-style! node "opacity" "0"))
      ;; the root background and strokes come from the new rendering
      (doseq [node (concat (js/Array.from (.querySelectorAll ghost (dm/str "[id=\"fills-" (:root from-tree) "\"]")))
                           (js/Array.from (.querySelectorAll ghost (dm/str "[id^=\"strokes-\"][id$=\"-" (:root from-tree) "\"]"))))]
        (sa/set-style! node "opacity" "0")))

    ;; new layers without a pair (below the root or a paired layer) fade in
    (doseq [id (:ids to-tree)
            :let [shape (get n-objects id)]
            :when (and (some? shape)
                       (not (contains? matches id))
                       (let [parent-id (:parent-id shape)]
                         (or (= parent-id head-id)
                             (contains? matches parent-id))))
            node (live-nodes head id)]
      (sa/run-animation! node
                         [{:opacity 0}
                          {:opacity (if (cfh/frame-shape? shape) 1 (opacity shape))}]
                         opts-in))

    ;; paired layers move from where they were, parents first so the
    ;; children compensate the transform of their parents
    (loop [pairs (sort-by (comp depth key) matches)
           flips {}]
      (when-let [[b-id a-id] (first pairs)]
        (let [a-shape (get o-objects a-id)
              b-shape (get n-objects b-id)
              anc-id  (d/seek #(contains? flips %) (cfh/get-parent-ids n-objects b-id))
              anc     (if (some? anc-id) (get flips anc-id) sa/identity-map)
              nodes   (if (= b-id head-id)
                        [head]
                        (live-nodes head b-id))]
          (cond
            (or (nil? a-shape) (nil? b-shape))
            (recur (rest pairs) flips)

            (= anc ::complex)
            (do
              (sa/animate-fill! head a-shape b-shape opts-in)
              (recur (rest pairs) (assoc flips b-id ::complex)))

            :else
            (let [ra       (d/nilv (:rotation a-shape) 0)
                  rb       (d/nilv (:rotation b-shape) 0)
                  a-box    (sa/inverse-box anc (box a-shape))
                  b-box    (box b-shape)
                  sx       (sa/safe-scale (:w a-box) (:w b-box))
                  sy       (sa/safe-scale (:h a-box) (:h b-box))
                  rotated? (not (and (mth/almost-zero? ra) (mth/almost-zero? rb)))
                  moved?   (or rotated?
                               (not (mth/close? sx 1))
                               (not (mth/close? sy 1))
                               (not (mth/close? (:x a-box) (:x b-box)))
                               (not (mth/close? (:y a-box) (:y b-box))))
                  frame?   (cfh/frame-shape? b-shape)
                  op-a     (opacity a-shape)
                  op-b     (opacity b-shape)
                  fade?    (and (not frame?) (not (mth/close? op-a op-b)))
                  [from to] (sa/flip-transforms a-box ra b-box rb sx sy)
                  own      {:sx sx :sy sy
                            :tx (- (:x a-box) (* sx (:x b-box)))
                            :ty (- (:y a-box) (* sy (:y b-box)))}]

              (when (or moved? fade?)
                (doseq [node nodes]
                  (when moved?
                    (sa/set-style! node "transform-box" "view-box"))
                  (sa/run-animation! node
                                     [(cond-> {}
                                        moved? (assoc :transform from :transformOrigin "0px 0px")
                                        fade?  (assoc :opacity op-a))
                                      (cond-> {}
                                        moved? (assoc :transform to :transformOrigin "0px 0px")
                                        fade?  (assoc :opacity op-b))]
                                     opts-in)))

              (sa/animate-fill! head a-shape b-shape opts-in)

              (recur (rest pairs)
                     (assoc flips b-id (if rotated? ::complex (sa/compose anc own)))))))))))

(defn- animate-transition!
  [{:keys [head-id old-node ghost animation from-tree to-tree] :as params} tries]
  (let [^js node (first (live-nodes head-id))]
    (cond
      ;; not rendered yet
      (and (or (nil? node) (identical? node old-node)) (< tries 4))
      (tm/raf #(animate-transition! params (inc tries)))

      (or (nil? node) (identical? node old-node))
      nil

      :else
      (let [^js ghost ghost
            duration (max 0 (or (:duration animation) 300))
            easing   (ez/css-easing animation)
            opts-in  {:duration duration :easing easing :fill "backwards"}
            opts-out {:duration duration :easing easing :fill "forwards"}
            shape    (get (:objects to-tree) head-id)]

        (when (some? ghost)
          (.setAttribute ghost "data-zvena-ghost" "true")
          (sa/set-style! ghost "pointer-events" "none")
          (.after ^js node ghost)
          (remove-later! ghost duration))

        (case (:animation-type animation)
          :dissolve
          (do
            (sa/run-animation! node
                               [{:opacity 0}
                                {:opacity (if (cfh/frame-shape? shape) 1 (opacity shape)) :offset 0.5}
                                {:opacity (if (cfh/frame-shape? shape) 1 (opacity shape))}]
                               opts-in)
            (when (some? ghost)
              (sa/run-animation! ghost [{:opacity 1} {:opacity 0}] opts-out)))

          :smart-animate
          (do
            (when (and (some? from-tree) (some? to-tree))
              (smart-animate! node ghost from-tree to-tree opts-in))
            (when (some? ghost)
              (sa/run-animation! ghost [{:opacity 1} {:opacity 0}] opts-out)))

          nil)))))

(defn- set-variant!
  [head-id value]
  (swap! state (fn [s]
                 (if (nil? value)
                   (dissoc s head-id)
                   (assoc s head-id value)))))

(defn- transition!
  "Shows the variant `value` (nil: the instance itself) in the instance
  `head-id`, with the interaction animation. `base` has the instance as
  in the file (`:real`) and the objects of its viewport (`:objects`)."
  [head-id value animation {:keys [real objects]}]
  (let [current (get @state head-id)]
    (when (not= current value)
      (if (contains? #{:dissolve :smart-animate} (:animation-type animation))
        (let [^js old-node (first (live-nodes head-id))
              ghost    (when (some? old-node) (.cloneNode old-node true))
              smart?   (= :smart-animate (:animation-type animation))
              params   {:head-id   head-id
                        :old-node  old-node
                        :ghost     ghost
                        :animation animation
                        :from-tree (when smart? (tree-layers real objects current))
                        :to-tree   (tree-layers real objects value)}]
          (set-variant! head-id value)
          ;; the new variant is rendered before the next frame
          (tm/raf #(animate-transition! params 0)))
        (set-variant! head-id value)))))

;; --- While hovering / While pressing

(defonce ^:private transients (volatile! []))
(defonce ^:private transient-counter (volatile! 0))

(defn- drop-transients!
  "Removes (and stops listening) the transient changes matching `pred`."
  [pred]
  (let [records @transients
        dropped (filterv pred records)]
    (vreset! transients (into [] (remove pred) records))
    (doseq [{:keys [cleanup]} dropped]
      (when (fn? cleanup) (cleanup)))))

(defn- inside?
  "True when the pointer target is inside the trigger layer (or inside the
  instance when the trigger layer is no longer rendered)."
  [^js target head-id trigger-id]
  (when (and (some? target) (fn? (.-closest target)))
    (let [selector (if (seq (live-nodes trigger-id))
                     (shape-selector trigger-id)
                     (shape-selector head-id))]
      (some? (.closest target selector)))))

(defn- listen-hover!
  [head-id trigger-id on-end]
  (let [on-over (fn [^js event]
                  (when-not (inside? (.-target event) head-id trigger-id)
                    (on-end)))
        ;; the pointer leaves the window
        on-out  (fn [^js event]
                  (when (nil? (.-relatedTarget event))
                    (on-end)))]
    (.addEventListener js/window "pointerover" on-over true)
    (.addEventListener js/window "pointermove" on-over true)
    (.addEventListener js/window "pointerout" on-out true)
    (fn []
      (.removeEventListener js/window "pointerover" on-over true)
      (.removeEventListener js/window "pointermove" on-over true)
      (.removeEventListener js/window "pointerout" on-out true))))

(defn- listen-press!
  [on-end]
  (let [on-up (fn [_] (on-end))]
    (.addEventListener js/window "pointerup" on-up true)
    (.addEventListener js/window "pointercancel" on-up true)
    (fn []
      (.removeEventListener js/window "pointerup" on-up true)
      (.removeEventListener js/window "pointercancel" on-up true))))

(defn- add-transient!
  "A change made by a While hovering / While pressing trigger: it goes
  back to `restore` when the hover / press ends. Ending one also ends the
  ones made after it on the same instance."
  [head-id restore kind trigger-id animation base]
  (let [rid    (vswap! transient-counter inc)
        ended? (volatile! false)
        on-end (fn []
                 (when-not @ended?
                   (vreset! ended? true)
                   ;; deferred: the listeners are removed from inside
                   ;; their own handler
                   (tm/schedule
                    (fn []
                      (when (some #(= rid (:id %)) @transients)
                        (drop-transients! #(and (= head-id (:head-id %))
                                                (>= (:id %) rid)))
                        (transition! head-id restore animation base))))))
        cleanup (case kind
                  :hover (listen-hover! head-id trigger-id on-end)
                  :press (listen-press! on-end))]
    (vswap! transients conj {:id rid :head-id head-id :cleanup cleanup})))

;; --- Change to

(defn- find-head
  "The instance that a Change to on `shape` switches: the nearest one
  (the layer or a parent) of the same variant set as `target`."
  [ctx objects shape target]
  (let [variant-id (:variant-id target)]
    (->> (cfh/get-parent-ids-seq-with-self objects (:id shape))
         (keep #(get objects %))
         (d/seek (fn [s]
                   (and (some? (:component-id s))
                        (or (nil? variant-id)
                            (= variant-id
                               (:variant-id (second (lookup-component ctx (:component-id s))))))))))))

(defn change-to!
  "zvena: runs the Figma \"Change to\" `interaction` triggered on `shape`;
  `objects` are the objects of the viewport that renders it."
  [interaction shape objects]
  (let [ctx        (current-ctx)
        target-id  (:variant-target interaction)
        [_ target] (lookup-component ctx target-id)
        head       (when (some? target) (find-head ctx objects shape target))]
    (when (and (some? head)
               (not= target-id (:component-id head)))
      (let [head-id   (:id head)
            real      (or (::real head) head)
            ;; back to its own variant the instance is shown as it is
            ;; (with its overrides)
            value     (when (not= target-id (:component-id real)) target-id)
            restore   (get @state head-id)
            animation (:animation interaction)
            base      {:real real
                       :objects (assoc objects head-id real)}]
        (when (or (nil? value) (can-build? value))
          (transition! head-id value animation base)
          (case (:event-type interaction)
            :mouse-over  (add-transient! head-id restore :hover (:id shape) animation base)
            :mouse-press (add-transient! head-id restore :press (:id shape) animation base)
            nil))))))

(defn reset-all!
  "zvena: every instance back to its variant (on navigation)."
  []
  (drop-transients! (constantly true))
  (when (seq @state)
    (reset! state {}))
  nil)
