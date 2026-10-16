;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.viewer.zvena.scroll
  "zvena: Figma prototype scroll behavior in the viewer (SVG renderer).

  - A board with an overflow direction (Horizontal, Vertical, Both
    directions) that clips its content is a scroll container: its
    children are drawn inside a group translated by the board scroll
    position, under the board clip, so hover, clicks and overlays keep
    working on the real shapes. The mouse wheel / trackpad and a pointer
    drag (with momentum, as on a phone) scroll it; the innermost board
    that can still scroll in that direction takes the gesture and the
    rest goes up to the outer boards and the viewer, as browsers chain
    scrolling. Scrollbars are not shown (Figma shows none).
  - Fixed children of a scrolling board (Penpot `:fixed-scroll`) stay
    in place over the content; Sticky children scroll until they reach
    its top edge (the left edge of a horizontal board) and stay there.
    Sticky children of the presented board itself pin to the top of the
    viewer while the viewer scrolls the board.
  - Scroll positions live in `positions`, {board id -> {:x :y}}: shared
    by the two SVGs of a screen (fixed and not fixed layers), kept when
    the zoom changes and dropped once the board is no longer shown.

  Boards without these settings are drawn by the regular
  `app.main.ui.shapes.frame/frame-shape`, exactly as before. Data:
  `app.common.types.shape.zvena` (overflow, scroll-position)."
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.shape.zvena :as ctsz]
   [app.main.ui.shapes.frame :as frame]
   [app.main.ui.viewer.zvena.easing :as ez]
   [app.util.dom :as dom]
   [app.util.dom.normalize-wheel :as nw]
   [app.util.timers :as tm]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

;; --- State

;; {board id -> {:x :y}}: how far each scrolling board on screen is
;; scrolled, in board units
(defonce ^:private positions (l/atom {}))

;; {board id -> {:max-x :max-y}}: scroll range of each board, registered
;; by the instance that draws its content
(defonce ^:private ranges (volatile! {}))

;; {board id -> number of rendered instances}
(defonce ^:private mounts (volatile! {}))

;; {board id -> animation frame id} (Scroll to, momentum)
(defonce ^:private anims (volatile! {}))

;; the board that took the current pointer drag
(defonce ^:private drag-owner (volatile! nil))

(def ^:private origin {:x 0 :y 0})

(defn- position-ref
  [id]
  (l/derived #(get % id origin) positions))

(defn get-position
  "zvena: scroll position {:x :y} of the board `id` in the viewer."
  [id]
  (get @positions id origin))

(defn- clamp
  [v lo hi]
  (-> v (max lo) (min hi)))

(defn- set-position!
  "Scrolls the board `id` to (x, y), clamped to its range. Returns true
  when it moved."
  [id x y]
  (when (and (number? x) (number? y)
             (not (js/isNaN x)) (not (js/isNaN y)))
    (let [{:keys [max-x max-y]} (get @ranges id)
          old (get-position id)
          nx  (clamp x 0 (or max-x 0))
          ny  (clamp y 0 (or max-y 0))]
      (when (or (not= nx (:x old)) (not= ny (:y old)))
        (swap! positions assoc id {:x nx :y ny})
        true))))

(defn- cancel-animation!
  [id]
  (when-let [raf-id (get @anims id)]
    (tm/cancel-af! raf-id)
    (vswap! anims dissoc id)))

(defn- retain!
  [id]
  (vswap! mounts update id (fnil inc 0)))

(defn- release!
  "One instance of the board `id` is gone. Once none is left (the zoom
  re-creates them in the same render) its scroll is dropped, so the
  board starts at the top the next time it is shown, as in Figma."
  [id]
  (vswap! mounts update id (fnil dec 1))
  (tm/schedule
   (fn []
     (when-not (pos? (get @mounts id 0))
       (vswap! mounts dissoc id)
       (vswap! ranges dissoc id)
       (cancel-animation! id)
       (swap! positions dissoc id)))))

;; --- Geometry

(defn- sort-children
  "Children in paint order, as `app.main.ui.shapes.frame/frame-shape`."
  [shape childs]
  (if (ctl/any-layout? shape)
    (ctl/sort-layout-children-z-index
     childs
     (and (ctl/flex-layout? shape) (ctl/reverse? shape)))
    childs))

(defn- split-children
  "[scrolling sticky fixed] children of a board, each in layer order.
  Only a board that scrolls by itself keeps its fixed children apart
  (the fixed children of a screen are drawn by the screen fixed layer)."
  [childs own?]
  (reduce (fn [[scrolling sticky fixed] child]
            (case (ctsz/scroll-position child)
              :sticky [scrolling (conj sticky child) fixed]
              :fixed  (if own?
                        [scrolling sticky (conj fixed child)]
                        [(conj scrolling child) sticky fixed])
              [(conj scrolling child) sticky fixed]))
          [[] [] []]
          childs))

(defn- scroll-range
  "How far the board scrolls: the bounds of its (not fixed, visible)
  children past its right and bottom edges, plus the auto layout
  padding. Figma does not scroll to content above or left of a board."
  [shape childs overflow]
  (let [content (->> childs
                     (remove :hidden)
                     (gsh/shapes->rect))
        selrect (:selrect shape)
        [_ pad-right pad-bottom _] (if (ctl/any-layout? shape)
                                     (ctl/paddings shape)
                                     [0 0 0 0])
        h?      (contains? #{:horizontal :both} overflow)
        v?      (contains? #{:vertical :both} overflow)]
    (if (or (nil? content) (nil? selrect))
      {:max-x 0 :max-y 0}
      {:max-x (if h?
                (max 0 (- (+ (:x2 content) (or pad-right 0)) (:x2 selrect)))
                0)
       :max-y (if v?
                (max 0 (- (+ (:y2 content) (or pad-bottom 0)) (:y2 selrect)))
                0)})))

(defn- translate-str
  "SVG transform that moves the content by (-x, -y) along the board
  axes (a rotated board scrolls along its own axes)."
  [shape x y]
  (when-not (and (zero? x) (zero? y))
    (let [m (:transform shape)
          v (if (some? m)
              (gpt/subtract (gpt/transform (gpt/point x y) m)
                            (gpt/transform (gpt/point 0 0) m))
              (gpt/point x y))]
      (dm/str "translate(" (- (:x v)) "," (- (:y v)) ")"))))

(defn- sticky-offset
  "[dx dy] that keeps the sticky `child` at the visible top (or left)
  edge: `view-x`/`view-y` are the visible top-left corner in content
  coordinates, `fx`/`fy` the board top-left corner and `limit-x2` /
  `limit-y2` the end of the scrolling content."
  [child pin-x? pin-y? view-x view-y fx fy limit-x2 limit-y2]
  (let [{:keys [x y x2 y2]} (:selrect child)
        dx (if (and pin-x? (number? x))
             (-> (- view-x (max x fx))
                 (max 0)
                 (min (max 0 (- limit-x2 x2))))
             0)
        dy (if (and pin-y? (number? y))
             (-> (- view-y (max y fy))
                 (max 0)
                 (min (max 0 (- limit-y2 y2))))
             0)]
    [dx dy]))

(defn- node-scale
  "Screen pixels per board unit (the viewer zoom)."
  [^js node]
  (let [ctm (when (some? node) (.getScreenCTM node))
        s   (when (some? ctm) (js/Math.hypot (.-a ctm) (.-b ctm)))]
    (if (and (number? s) (pos? s)) s 1)))

(defn- viewer-top
  "Top edge of the viewer area, in the units of the board drawn inside
  `node`."
  [^js node]
  (let [section (dom/get-element "viewer-section")
        ctm     (when (some? node) (.getScreenCTM node))]
    (when (and (some? section) (some? ctm) (not (zero? (.-d ctm))))
      (/ (- (.-top (.getBoundingClientRect section)) (.-f ctm))
         (.-d ctm)))))

;; --- Wheel / trackpad

(defn- on-wheel!
  [^js event ^js node id]
  (when-not (or (.-ctrlKey event) (.-metaKey event))
    (let [norm    (nw/normalize-wheel event)
          dx      (.-pixelX ^js norm)
          dy      (.-pixelY ^js norm)
          ;; a mouse wheel with Shift scrolls sideways
          [dx dy] (if (and (.-shiftKey event) (zero? dx)) [dy 0] [dx dy])
          {:keys [max-x max-y]} (get @ranges id)
          both?   (and (pos? (or max-x 0)) (pos? (or max-y 0)))
          ;; a board that scrolls one way only takes the gestures along
          ;; that way, the others go on to the outer boards / the viewer
          [dx dy] (cond
                    both? [dx dy]
                    (> (js/Math.abs dx) (js/Math.abs dy)) [dx 0]
                    :else [0 dy])
          scale   (node-scale node)
          {:keys [x y]} (get-position id)]
      (when (set-position! id (+ x (/ dx scale)) (+ y (/ dy scale)))
        (cancel-animation! id)
        (.preventDefault event)
        (.stopPropagation event)))))

;; --- Pointer drag

(def ^:private drag-threshold 4)

(defn- can-scroll?
  "True when the board `id` scrolls along the main direction of a
  (dx, dy) pointer movement."
  [id dx dy]
  (let [{:keys [max-x max-y]} (get @ranges id)]
    (if (> (js/Math.abs dx) (js/Math.abs dy))
      (pos? (or max-x 0))
      (pos? (or max-y 0)))))

(defn- fling!
  "Momentum after a drag: keeps scrolling at `vx`, `vy` (board units per
  millisecond), slowing down."
  [id vx vy]
  (cancel-animation! id)
  (let [state (volatile! {:vx vx :vy vy :t nil})
        step  (fn step [ts]
                (let [{:keys [vx vy t]} @state
                      dt     (if (some? t) (min 64 (max 0 (- ts t))) 16)
                      {:keys [x y]} (get-position id)
                      moved? (set-position! id (+ x (* vx dt)) (+ y (* vy dt)))
                      decay  (js/Math.pow 0.95 (/ dt 16))
                      vx     (* vx decay)
                      vy     (* vy decay)]
                  (vreset! state {:vx vx :vy vy :t ts})
                  (if (and moved? (> (js/Math.hypot vx vy) 0.01))
                    (vswap! anims assoc id (tm/raf step))
                    (vswap! anims dissoc id))))]
    (vswap! anims assoc id (tm/raf step))))

(defn- start-drag!
  "Pointer drag on a scrolling board, as a finger on a phone. The press
  becomes a scroll once it moves a few pixels along a direction the
  board scrolls; the innermost board takes it (its listeners run first)."
  [^js event ^js node id]
  (vreset! drag-owner nil)
  (let [scale   (node-scale node)
        start-x (.-clientX event)
        start-y (.-clientY event)
        start   (get-position id)
        state   (volatile! :pending)
        samples (volatile! [])
        cleanup (volatile! nil)

        finish!
        (fn [_]
          (vreset! state :done)
          (when-let [f @cleanup]
            (vreset! cleanup nil)
            (f)))

        on-move
        (fn [^js e]
          (let [dx (- (.-clientX e) start-x)
                dy (- (.-clientY e) start-y)]
            (case @state
              :pending
              (when (> (+ (* dx dx) (* dy dy)) (* drag-threshold drag-threshold))
                (let [can? (can-scroll? id dx dy)]
                  (if (and can? (nil? @drag-owner))
                    (do
                      (vreset! drag-owner id)
                      (vreset! state :dragging)
                      (cancel-animation! id)
                      (some-> (.getSelection js/window) (.removeAllRanges)))
                    (finish! nil))))

              :dragging
              (do
                (.preventDefault e)
                (set-position! id
                               (- (:x start) (/ dx scale))
                               (- (:y start) (/ dy scale)))
                (let [{:keys [x y]} (get-position id)
                      sample [(.now js/performance) x y]]
                  (vswap! samples
                          (fn [s]
                            (let [s (conj s sample)
                                  n (count s)]
                              (if (> n 5) (subvec s (- n 5)) s))))))

              nil)))

        on-up
        (fn [_]
          (when (= @state :dragging)
            (let [s          @samples
                  [t1 x1 y1] (first s)
                  [t2 x2 y2] (peek s)
                  dt         (when (and (some? t1) (some? t2)) (- t2 t1))]
              (when (and (some? dt)
                         (pos? dt)
                         (< (- (.now js/performance) t2) 80))
                (let [vx (/ (- x2 x1) dt)
                      vy (/ (- y2 y1) dt)]
                  (when (> (js/Math.hypot vx vy) 0.05)
                    (fling! id vx vy))))))
          (finish! nil))]

    (.addEventListener js/window "pointermove" on-move)
    (.addEventListener js/window "pointerup" on-up)
    (.addEventListener js/window "pointercancel" finish!)
    (vreset! cleanup
             (fn []
               (.removeEventListener js/window "pointermove" on-move)
               (.removeEventListener js/window "pointerup" on-up)
               (.removeEventListener js/window "pointercancel" finish!)))
    nil))

;; --- Scroll to

(defn- animate-to!
  [id to-x to-y duration easing-f]
  (cancel-animation! id)
  (let [{from-x :x from-y :y} (get-position id)
        start (volatile! nil)
        step  (fn step [ts]
                (when (nil? @start) (vreset! start ts))
                (let [p (min 1 (/ (- ts @start) duration))
                      v (easing-f p)]
                  (set-position! id
                                 (+ from-x (* (- to-x from-x) v))
                                 (+ from-y (* (- to-y from-y) v)))
                  (if (< p 1)
                    (vswap! anims assoc id (tm/raf step))
                    (vswap! anims dissoc id))))]
    (vswap! anims assoc id (tm/raf step))))

(defn scroll-to!
  "zvena: Figma Scroll to for a layer inside scrolling boards. Every
  scrolling board around the destination (shown on screen) scrolls to
  bring it to its top-left corner, the innermost one with the
  interaction offset, animated as the interaction. Returns the
  interaction the viewer scrolls to next: aimed at the outermost
  scrolling board, or the same interaction when the layer is not inside
  one. `objects` are the viewer objects (board viewbox space)."
  [interaction objects]
  (let [dest-id    (:destination interaction)
        dest       (get objects dest-id)
        containers (when (some? dest)
                     (into []
                           (comp (keep #(get objects %))
                                 (filter ctsz/scroll-container?)
                                 (filter #(contains? @mounts (:id %))))
                           (cfh/get-parent-ids objects dest-id)))]
    (if (empty? containers)
      interaction
      (let [offset    (:scroll-offset interaction)
            animation (:animation interaction)
            duration  (or (:duration animation) 0)
            easing-f  (when (and (some? animation) (pos? duration))
                        (ez/easing-fn animation))]
        (loop [target dest
               boards (seq containers)
               first? true]
          (when-let [board (first boards)]
            (let [id (:id board)
                  tr (:selrect target)
                  br (:selrect board)
                  {:keys [max-x max-y]} (get @ranges id)
                  x  (-> (- (:x tr) (:x br) (if first? (or (:x offset) 0) 0))
                         (clamp 0 (or max-x 0)))
                  y  (-> (- (:y tr) (:y br) (if first? (or (:y offset) 0) 0))
                         (clamp 0 (or max-y 0)))]
              (if (some? easing-f)
                (animate-to! id x y duration easing-f)
                (do
                  (cancel-animation! id)
                  (set-position! id x y)))
              (recur board (next boards) false))))
        (assoc interaction
               :destination (:id (peek containers))
               :scroll-offset nil)))))

;; --- Rendering

(def ^:private fixed-layer-key
  "Marker on the objects of the fixed layer SVG of a screen (see
  `app.main.ui.viewer.interactions/viewport-svg*`)."
  :app.main.ui.viewer.interactions/fixed)

(defn- touch-action
  [overflow]
  (case overflow
    :horizontal "pan-y"
    :vertical   "pan-x"
    "none"))

(defn frame-shape
  "zvena: `app.main.ui.shapes.frame/frame-shape` for the viewer. A board
  that scrolls by itself, or the presented board when it has sticky
  layers, is drawn by `scroll-frame`; any other board by the regular
  frame shape. `base-ctx` is the viewer context holding the presented
  board."
  [shape-wrapper base-ctx]
  (let [plain-frame
        (frame/frame-shape shape-wrapper)

        scroll-frame
        (mf/fnc scroll-frame
          {::mf/wrap-props false}
          [props]
          (let [shape        (unchecked-get props "shape")
                childs       (unchecked-get props "childs")
                objects      (unchecked-get props "objects")
                own?         (true? (unchecked-get props "own"))
                page?        (true? (unchecked-get props "page"))
                id           (:id shape)
                overflow     (if own? (ctsz/overflow shape) :none)
                fixed-layer? (true? (get objects fixed-layer-key))

                [scrolling sticky fixed]
                (mf/with-memo [shape childs own?]
                  (split-children (sort-children shape childs) own?))

                srange
                (mf/with-memo [shape scrolling sticky overflow]
                  (scroll-range shape (into scrolling sticky) overflow))

                pos-ref  (mf/with-memo [id] (position-ref id))
                pos      (mf/deref pos-ref)
                sx       (if own? (:x pos) 0)
                sy       (if own? (:y pos) 0)

                top*     (mf/use-state nil)
                top      (deref top*)

                node-ref (mf/use-ref nil)

                on-pointer-down
                (mf/use-fn
                 (mf/deps id)
                 (fn [event]
                   (let [^js native (dom/event->native-event event)]
                     (when (and (some? native)
                                (= 0 (.-button native))
                                (not (false? (.-isPrimary native))))
                       (start-drag! native (mf/ref-val node-ref) id)))))]

            ;; the board is on screen (its scroll is dropped when it goes)
            (mf/with-effect [id own?]
              (when own?
                (retain! id)
                (fn [] (release! id))))

            ;; the instance that draws the content knows the scroll range
            (mf/with-effect [id own? srange scrolling sticky]
              (when (and own? (or (seq scrolling) (seq sticky)))
                (vswap! ranges assoc id srange)
                (let [{:keys [x y]} (get-position id)]
                  (set-position! id x y))))

            ;; wheel / trackpad and touch: not passive, so a board that
            ;; scrolls stops the viewer scroll
            (mf/with-effect [id own?]
              (let [node (mf/ref-val node-ref)]
                (when (and own? (some? node))
                  (let [touch          (volatile! nil)
                        on-wheel       (fn [event] (on-wheel! event node id))
                        on-touch-start (fn [^js event]
                                         (let [^js t (aget (.-touches event) 0)]
                                           (vreset! touch (when (some? t)
                                                            [(.-clientX t) (.-clientY t)]))))
                        on-touch-move  (fn [^js event]
                                         (let [^js t (aget (.-touches event) 0)
                                               start @touch]
                                           (when (and (some? t) (some? start) (.-cancelable event))
                                             (let [dx (- (.-clientX t) (first start))
                                                   dy (- (.-clientY t) (second start))]
                                               (when (can-scroll? id dx dy)
                                                 (.preventDefault event))))))]
                    (.addEventListener node "wheel" on-wheel #js {:passive false})
                    (.addEventListener node "touchstart" on-touch-start #js {:passive true})
                    (.addEventListener node "touchmove" on-touch-move #js {:passive false})
                    (fn []
                      (.removeEventListener node "wheel" on-wheel #js {:passive false})
                      (.removeEventListener node "touchstart" on-touch-start #js {:passive true})
                      (.removeEventListener node "touchmove" on-touch-move #js {:passive false}))))))

            ;; sticky layers of the presented board follow the viewer
            (mf/with-effect [page? shape sticky]
              (when (and page? (seq sticky))
                (let [section   (dom/get-element "viewer-section")
                      raf       (volatile! nil)
                      update!   (fn [_]
                                  (vreset! raf nil)
                                  (reset! top* (viewer-top (mf/ref-val node-ref))))
                      on-scroll (fn [_]
                                  (when (nil? @raf)
                                    (vreset! raf (tm/raf update!))))]
                  (update! nil)
                  (when (some? section)
                    (.addEventListener section "scroll" on-scroll #js {:passive true}))
                  (.addEventListener js/window "resize" on-scroll)
                  (fn []
                    (when-let [raf-id @raf]
                      (tm/cancel-af! raf-id))
                    (when (some? section)
                      (.removeEventListener section "scroll" on-scroll #js {:passive true}))
                    (.removeEventListener js/window "resize" on-scroll)))))

            (let [selrect  (:selrect shape)
                  fx       (:x selrect)
                  fy       (:y selrect)
                  view-x   (+ fx sx)
                  view-y   (+ (if (and page? (number? top)) (max fy top) fy) sy)
                  limit-x2 (+ (:x2 selrect) (:max-x srange))
                  limit-y2 (+ (:y2 selrect) (:max-y srange))
                  pin-x?   (= overflow :horizontal)
                  pin-y?   (not pin-x?)]

              [:> frame/frame-container #js {:shape shape}
               [:g.frame-children {:ref node-ref
                                   :on-pointer-down (when own? on-pointer-down)
                                   :style {:touch-action (when own? (touch-action overflow))}}

                ;; the whole board takes the wheel and drags, also where
                ;; it has no fill (not on the screen fixed layer, which
                ;; must let the pointer through)
                (when (and own? (not fixed-layer?))
                  [:rect {:x (dm/get-prop shape :x)
                          :y (dm/get-prop shape :y)
                          :width (dm/get-prop shape :width)
                          :height (dm/get-prop shape :height)
                          :transform (gsh/transform-str shape)
                          :fill "transparent"}])

                [:g {:transform (translate-str shape sx sy)}
                 (for [item scrolling]
                   [:& shape-wrapper {:key (dm/str (:id item)) :shape item}])]

                (for [item sticky]
                  (let [[dx dy] (sticky-offset item pin-x? pin-y? view-x view-y
                                               fx fy limit-x2 limit-y2)]
                    [:g {:key (dm/str "sticky-" (:id item))
                         :transform (translate-str shape (- sx dx) (- sy dy))}
                     [:& shape-wrapper {:shape item}]]))

                (for [item fixed]
                  [:& shape-wrapper {:key (dm/str (:id item)) :shape item}])]])))]

    (mf/fnc zvena-frame-shape
      {::mf/wrap-props false}
      [props]
      (let [shape  (unchecked-get props "shape")
            childs (unchecked-get props "childs")
            base   (mf/use-ctx base-ctx)
            own?   (ctsz/scroll-container? shape)
            page?  (and (some? base)
                        (= (:id shape) (:id base))
                        (boolean (some ctsz/sticky? childs)))]
        (if (or own? page?)
          [:> scroll-frame #js {:shape shape
                                :childs childs
                                :objects (unchecked-get props "objects")
                                :own own?
                                :page page?}]
          [:> plain-frame props])))))
