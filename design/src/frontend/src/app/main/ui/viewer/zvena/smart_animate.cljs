;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.viewer.zvena.smart-animate
  "zvena: Figma \"Smart animate\" transition for the viewer.

  When navigating from board A to board B, the layers of B that have a
  layer with the same name path (names of the parents below the board
  plus its own name) in A are animated from their A position, size,
  rotation, opacity and fill color to their B values; the rest of the
  layers dissolve (A ones fade out, B ones fade in).

  It works FLIP-style on the rendered SVG: both boards are rendered (A
  on top of B, see `app.main.ui.viewer`), A shows only its unmatched
  layers fading out while B layers are moved back to where they were in
  A with CSS transforms and animated to their final place with the Web
  Animations API."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.math :as mth]
   [app.main.ui.viewer.zvena.easing :as ez]
   [cuerdas.core :as str]))

;; --- DOM helpers

(defn- query-nodes
  [^js root selector]
  (if (some? root)
    (vec (js/Array.from (.querySelectorAll root selector)))
    []))

(defn- shape-nodes
  [root id]
  (query-nodes root (dm/str "[id=\"shape-" id "\"]")))

(defn- painted?
  [^js node]
  (let [fill (.-fill (js/getComputedStyle node))]
    (and (some? fill) (not= fill "") (not= fill "none"))))

(defn- fill-nodes
  "Elements painting the fills of the shape. The board is also drawn,
  without fills, in the svg of the fixed layers; that copy is skipped."
  [root id]
  (->> (query-nodes root (dm/str "[id=\"fills-" id "\"] > *"))
       (filterv painted?)))

;; zvena: public, also used by the variant transitions (Change to)
(defn run-animation!
  [^js node keyframes opts]
  (try
    (.animate node (clj->js keyframes) (clj->js opts))
    (catch :default _ nil)))

(defn set-style!
  [^js node prop value]
  (.setProperty (.-style node) prop value))

;; --- Layers matching

(defn- visible-layers
  "Ids of the rendered (not hidden) layers inside the board, in tree
  order."
  [objects board-id]
  (letfn [(walk [id]
            (let [shape (get objects id)]
              (when (and (some? shape) (not (:hidden shape)))
                (cons id (mapcat walk (:shapes shape))))))]
    (vec (mapcat walk (dm/get-in objects [board-id :shapes])))))

(defn- name-path
  "Names of the parents (below the board) and of the layer itself."
  [objects board-id id]
  (let [parents (->> (cfh/get-parent-ids objects id)
                     (take-while #(not= % board-id))
                     (reverse))]
    (conj (mapv #(dm/get-in objects [% :name]) parents)
          (dm/get-in objects [id :name]))))

(defn- match-layers
  "Map of B layer id -> A layer id, matching by name path; layers with
  the same path are paired in tree order."
  [objects a-board b-board a-ids b-ids]
  (let [a-groups (group-by #(name-path objects a-board %) a-ids)]
    (loop [ids b-ids counts {} result {}]
      (if-let [id (first ids)]
        (let [k (name-path objects b-board id)
              i (get counts k 0)
              a (get-in a-groups [k i])]
          (recur (rest ids)
                 (assoc counts k (inc i))
                 (cond-> result (some? a) (assoc id a))))
        result))))

;; --- Geometry

(defn- layer-box
  "Layer box in the user units of a viewport whose viewbox starts at
  `origin`, moved by `shift`."
  [shape origin shift]
  (let [{:keys [x y width height]} (:selrect shape)]
    {:x (+ (- x (:x origin)) (:x shift))
     :y (+ (- y (:y origin)) (:y shift))
     :w width
     :h height}))

(def identity-map {:sx 1 :sy 1 :tx 0 :ty 0})

(defn inverse-box
  "Box `box` mapped by the inverse of the scale+translate `m`."
  [{:keys [sx sy tx ty]} {:keys [x y w h]}]
  {:x (/ (- x tx) sx)
   :y (/ (- y ty) sy)
   :w (/ w sx)
   :h (/ h sy)})

(defn compose
  "Scale+translate map equivalent to applying `inner` and then `outer`."
  [outer inner]
  {:sx (* (:sx outer) (:sx inner))
   :sy (* (:sy outer) (:sy inner))
   :tx (+ (* (:sx outer) (:tx inner)) (:tx outer))
   :ty (+ (* (:sy outer) (:ty inner)) (:ty outer))})

(defn safe-scale
  [a b]
  (if (> (mth/abs b) 0.01)
    (/ a b)
    1))

(defn- px [v] (dm/str (mth/precision v 3) "px"))
(defn- num [v] (dm/str (mth/precision v 5)))

(defn- translate [x y] (dm/str "translate(" (px x) ", " (px y) ")"))
(defn- rotate [deg] (dm/str "rotate(" (num deg) "deg)"))
(defn- scale [sx sy] (dm/str "scale(" (num sx) ", " (num sy) ")"))

(defn- center [{:keys [x y w h]}]
  [(+ x (/ w 2)) (+ y (/ h 2))])

(defn flip-transforms
  "[from to] CSS transforms that take the B layer (box `b`, rotation
  `rb`) to look like box `a` with rotation `ra`, and back to identity."
  [a ra b rb sx sy]
  (if (and (mth/almost-zero? ra) (mth/almost-zero? rb))
    [(str/join " " [(translate (:x a) (:y a)) (scale sx sy) (translate (- (:x b)) (- (:y b)))])
     (str/join " " [(translate (:x b) (:y b)) (scale 1 1) (translate (- (:x b)) (- (:y b)))])]

    (let [[cax cay] (center a)
          [cbx cby] (center b)]
      [(str/join " " [(translate cax cay) (rotate ra) (translate (- cax) (- cay))
                      (translate (:x a) (:y a)) (scale sx sy) (translate (- (:x b)) (- (:y b)))
                      (translate cbx cby) (rotate (- rb)) (translate (- cbx) (- cby))])
       (str/join " " [(translate cbx cby) (rotate rb) (translate (- cbx) (- cby))
                      (translate (:x b) (:y b)) (scale 1 1) (translate (- (:x b)) (- (:y b)))
                      (translate cbx cby) (rotate (- rb)) (translate (- cbx) (- cby))])])))

;; --- Fills

(defn- solid-fill
  "The color and opacity of a shape with exactly one solid fill."
  [shape]
  (let [fills (vec (or (:fills shape) []))]
    (when (= 1 (count fills))
      (let [fill (first fills)]
        (when (and (string? (:fill-color fill))
                   (nil? (:fill-color-gradient fill))
                   (nil? (:fill-image fill)))
          {:color (:fill-color fill)
           :opacity (d/nilv (:fill-opacity fill) 1)})))))

(defn animate-fill!
  [root a-shape b-shape opts]
  (when-not (or (cfh/text-shape? a-shape) (cfh/text-shape? b-shape))
    (let [fa (solid-fill a-shape)
          fb (solid-fill b-shape)]
      (when (and (some? fa) (some? fb) (not= fa fb))
        (doseq [node (fill-nodes root (:id b-shape))]
          (run-animation! node
                    [{:fill (:color fa) :fillOpacity (:opacity fa)}
                     {:fill (:color fb) :fillOpacity (:opacity fb)}]
                    opts))))))

(defn- opacity
  [shape]
  (d/nilv (:opacity shape) 1))

;; --- Animation

(defn animate!
  "Runs the smart animate transition between the rendered `orig-frame`
  (inside `orig-node`) and `frame` (inside `current-node`). Calls
  `on-complete` when it finishes."
  [{:keys [animation orig-node current-node objects orig-frame frame zoom orig-size size on-complete]}]
  (let [duration (max 0 (or (:duration animation) 300))
        easing   (ez/css-easing animation)
        opts-in  {:duration duration :easing easing :fill "backwards"}
        opts-out {:duration duration :easing easing :fill "forwards"}]

    (if (or (nil? orig-node) (nil? current-node) (nil? orig-frame) (nil? frame))
      (on-complete)

      (let [a-board (:id orig-frame)
            b-board (:id frame)
            zoom    (if (and (number? zoom) (pos? zoom)) zoom 1)

            ca      (.getBoundingClientRect ^js orig-node)
            cb      (.getBoundingClientRect ^js current-node)
            ;; position of the A viewport in B user units
            shift   {:x (/ (- (.-left ca) (.-left cb)) zoom)
                     :y (/ (- (.-top ca) (.-top cb)) zoom)}
            no-shift {:x 0 :y 0}

            a-ids   (visible-layers objects a-board)
            b-ids   (visible-layers objects b-board)
            matches (match-layers objects a-board b-board a-ids b-ids)
            a-matched (into #{} (vals matches))

            depth   (fn [id] (count (cfh/get-parent-ids objects id)))

            ;; text layers whose content changed crossfade instead of
            ;; being scaled (Figma does the same)
            crossfade?
            (fn [b-id]
              (let [a (get objects (get matches b-id))
                    b (get objects b-id)]
                (and (cfh/text-shape? a)
                     (cfh/text-shape? b)
                     (not= (:content a) (:content b)))))

            a-crossfade (into #{} (comp (filter crossfade?) (map matches)) (keys matches))]

        ;; A is drawn over B and only shows what leaves the screen
        (set-style! orig-node "z-index" "2")
        (set-style! orig-node "pointer-events" "none")

        ;; A board background and strokes are replaced by B ones
        (doseq [node (concat (query-nodes orig-node (dm/str "[id=\"fills-" a-board "\"]"))
                             (query-nodes orig-node (dm/str "[id^=\"strokes-\"][id$=\"-" a-board "\"]")))]
          (set-style! node "opacity" "0"))

        ;; B board background color goes from A color to B color
        (animate-fill! current-node (get objects a-board) (get objects b-board) opts-in)

        ;; A top level layers: matched ones are hidden (B copies move
        ;; instead), the rest dissolve out
        (doseq [id (dm/get-in objects [a-board :shapes])
                :let [shape (get objects id)]
                :when (and (some? shape) (not (:hidden shape)))]
          (cond
            (contains? a-crossfade id)
            nil

            (contains? a-matched id)
            (doseq [node (shape-nodes orig-node id)]
              (set-style! node "opacity" "0"))

            :else
            (doseq [node (shape-nodes orig-node id)]
              (run-animation! node
                        [{:opacity (if (cfh/frame-shape? shape) 1 (opacity shape))}
                         {:opacity 0}]
                        opts-out))))

        ;; B unmatched layers whose parent is the board or a matched
        ;; layer dissolve in
        (doseq [id b-ids
                :let [shape (get objects id)]
                :when (and (not (contains? matches id))
                           (let [parent-id (:parent-id shape)]
                             (or (= parent-id b-board)
                                 (contains? matches parent-id))))]
          (doseq [node (shape-nodes current-node id)]
            (run-animation! node
                      [{:opacity 0}
                       {:opacity (if (cfh/frame-shape? shape) 1 (opacity shape))}]
                      opts-in)))

        ;; Matched layers, parents first so the children compensate the
        ;; transform of their animated parents
        (loop [pairs (sort-by (comp depth key) matches)
               flips {}]
          (when-let [[b-id a-id] (first pairs)]
            (let [a-shape (get objects a-id)
                  b-shape (get objects b-id)

                  anc-id  (d/seek #(contains? flips %) (cfh/get-parent-ids objects b-id))
                  anc     (if (some? anc-id) (get flips anc-id) identity-map)

                  a-box   (layer-box a-shape orig-size shift)
                  b-box   (layer-box b-shape size no-shift)
                  ra      (d/nilv (:rotation a-shape) 0)
                  rb      (d/nilv (:rotation b-shape) 0)

                  frame?  (cfh/frame-shape? b-shape)
                  op-a    (opacity a-shape)
                  op-b    (opacity b-shape)]

              (cond
                ;; inside a rotated parent: it just follows its parent
                (= anc ::complex)
                (do
                  (animate-fill! current-node a-shape b-shape opts-in)
                  (recur (rest pairs) (assoc flips b-id ::complex)))

                ;; text with another content: moves and crossfades
                (crossfade? b-id)
                (let [a-box' (inverse-box anc a-box)
                      dx     (- (:x a-box') (:x b-box))
                      dy     (- (:y a-box') (:y b-box))]
                  (doseq [node (shape-nodes current-node b-id)]
                    (set-style! node "transform-box" "view-box")
                    (run-animation! node
                              [{:transform (translate dx dy) :transformOrigin "0px 0px" :opacity 0}
                               {:transform (translate 0 0) :transformOrigin "0px 0px" :opacity op-b}]
                              opts-in))
                  (when (contains? (set (dm/get-in objects [a-board :shapes])) a-id)
                    (doseq [node (shape-nodes orig-node a-id)]
                      (set-style! node "transform-box" "view-box")
                      (run-animation! node
                                [{:transform (translate 0 0) :transformOrigin "0px 0px" :opacity op-a}
                                 {:transform (translate (- dx) (- dy)) :transformOrigin "0px 0px" :opacity 0}]
                                opts-out)))
                  (recur (rest pairs) (assoc flips b-id ::complex)))

                :else
                (let [a-box'   (inverse-box anc a-box)
                      sx       (safe-scale (:w a-box') (:w b-box))
                      sy       (safe-scale (:h a-box') (:h b-box))
                      rotated? (not (and (mth/almost-zero? ra) (mth/almost-zero? rb)))
                      moved?   (or rotated?
                                   (not (mth/close? sx 1))
                                   (not (mth/close? sy 1))
                                   (not (mth/close? (:x a-box') (:x b-box)))
                                   (not (mth/close? (:y a-box') (:y b-box))))
                      fade?    (and (not frame?) (not (mth/close? op-a op-b)))
                      [from to] (flip-transforms a-box' ra b-box rb sx sy)

                      own      {:sx sx :sy sy
                                :tx (- (:x a-box') (* sx (:x b-box)))
                                :ty (- (:y a-box') (* sy (:y b-box)))}]

                  (when (or moved? fade?)
                    (doseq [node (shape-nodes current-node b-id)]
                      (when moved?
                        (set-style! node "transform-box" "view-box"))
                      (run-animation! node
                                [(cond-> {}
                                   moved? (assoc :transform from :transformOrigin "0px 0px")
                                   fade?  (assoc :opacity op-a))
                                 (cond-> {}
                                   moved? (assoc :transform to :transformOrigin "0px 0px")
                                   fade?  (assoc :opacity op-b))]
                                opts-in)))

                  (animate-fill! current-node a-shape b-shape opts-in)

                  (recur (rest pairs)
                         (assoc flips b-id (if rotated? ::complex (compose anc own)))))))))

        ;; Completion
        (let [done (volatile! false)
              finish (fn []
                       (when-not @done
                         (vreset! done true)
                         (on-complete)))
              anim (run-animation! current-node [{:opacity 1} {:opacity 1}] {:duration duration})]
          (if (some? anim)
            (set! (.-onfinish ^js anim) finish)
            (js/setTimeout finish duration)))))
    nil))
