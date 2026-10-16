;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.data.workspace.drawing.polygon
  "zvena: drawing handler for Figma's Polygon and Star tools.

   A press-and-drag draws the shape inside the dragged box (Shift keeps
   it square, Alt draws from the center); a click without a drag makes a
   100×100 one. The result is a closed path: a regular polygon (a
   triangle by default, as in Figma) or a five-point star with Figma's
   default inner radius of 38.2%, stretched to fill the box."
  (:require
   [app.common.data.macros :as dm]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes.flex-layout :as gslf]
   [app.common.geom.shapes.grid-layout :as gslg]
   [app.common.math :as mth]
   [app.common.types.container :as ctn]
   [app.common.types.path :as path]
   [app.common.types.shape :as cts]
   [app.common.types.shape-tree :as ctst]
   [app.common.types.shape.attrs :refer [default-color]]
   [app.common.types.shape.layout :as ctl]
   [app.common.uuid :as uuid]
   [app.common.files.changes-builder :as pcb]
   [app.common.types.path.impl :as path.impl]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.drawing.common :as common]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.streams :as ms]
   [app.util.mouse :as mse]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def default-polygon-count 3)
(def default-star-count 5)
(def default-star-ratio 0.382)

(defn- unit-vertices
  "Vertices of the shape on a unit circle, the first one at the top."
  ([tool] (unit-vertices tool (if (= tool :star) default-star-count default-polygon-count) default-star-ratio))
  ([tool count ratio]
   (if (= tool :star)
     (vec (for [i (range (* 2 count))]
            (let [r (if (even? i) 1 ratio)
                  a (- (/ (* i mth/PI) count) (/ mth/PI 2))]
              (gpt/point (* r (mth/cos a)) (* r (mth/sin a))))))
     (vec (for [i (range count)]
            (let [a (- (/ (* 2 i mth/PI) count) (/ mth/PI 2))]
              (gpt/point (mth/cos a) (mth/sin a))))))))

(defn- fit-to-rect
  "Stretches the vertices so their bounding box is `rect`."
  [vertices {:keys [x y width height]}]
  (let [xs   (map :x vertices)
        ys   (map :y vertices)
        minx (reduce min xs)
        miny (reduce min ys)
        sw   (- (reduce max xs) minx)
        sh   (- (reduce max ys) miny)]
    (mapv (fn [{px :x py :y}]
            (gpt/point (+ x (* width (/ (- px minx) sw)))
                       (+ y (* height (/ (- py miny) sh)))))
          vertices)))

(defn- box
  "The box dragged from `start` to `point`: Shift keeps it square, Alt
  makes `start` its center."
  [start point shift? alt?]
  (let [dx (- (:x point) (:x start))
        dy (- (:y point) (:y start))
        [dx dy] (if shift?
                  (let [d (max (mth/abs dx) (mth/abs dy))]
                    [(* d (if (neg? dx) -1 1)) (* d (if (neg? dy) -1 1))])
                  [dx dy])
        p1 (if alt? (gpt/point (- (:x start) dx) (- (:y start) dy)) start)
        p2 (gpt/point (+ (:x start) dx) (+ (:y start) dy))]
    (grc/make-rect p1 p2)))

(defn- shape-content
  ([tool rect] (shape-content tool rect nil nil))
  ([tool rect count ratio]
   (let [rect     (-> rect
                      (update :width max 1)
                      (update :height max 1))
         vertices (if count
                    (unit-vertices tool count (or ratio default-star-ratio))
                    (unit-vertices tool))]
     (path/points->content (fit-to-rect vertices rect) :close true))))

;; --- Editing after drawing (Figma's "Count" and "Ratio")

(defn polygon-params
  "The polygon/star parameters of a shape drawn with these tools, or nil."
  [shape]
  (when-let [data (dm/get-in shape [:plugin-data :zvena])]
    (let [kind (get data "shape")]
      (when (contains? #{"polygon" "star"} kind)
        {:kind   (keyword kind)
         :count  (or (some-> (get data "count") js/parseInt) (if (= kind "star") default-star-count default-polygon-count))
         :ratio  (or (some-> (get data "ratio") js/parseFloat) default-star-ratio)
         ;; zvena: Figma's corner radius of polygons and stars
         :radius (or (some-> (get data "radius") js/parseFloat) 0)}))))

(defn- params->plugin-data
  [{:keys [kind count ratio radius]}]
  {:zvena {"shape"  (name kind)
           "count"  (str count)
           "ratio"  (str ratio)
           "radius" (str (or radius 0))}})

(defn- rounded-corners
  "zvena: every vertex of the closed outline `vertices` replaced by a
  circular arc of `radius` (as a cubic bezier), shortened where the
  edges are too short for it, as Figma rounds polygons and stars."
  [vertices radius]
  (let [n (count vertices)]
    (mapv (fn [i]
            (let [v     (nth vertices i)
                  a     (nth vertices (mod (dec i) n))
                  b     (nth vertices (mod (inc i) n))
                  u1    (gpt/unit (gpt/to-vec v a))
                  u2    (gpt/unit (gpt/to-vec v b))
                  theta (mth/acos (mth/clamp (gpt/dot u1 u2) -1 1))
                  half  (mth/tan (/ theta 2))
                  t     (if (> half 1e-6) (/ radius half) 0)
                  t     (min t (/ (gpt/distance v a) 2) (/ (gpt/distance v b) 2))
                  r     (* t half)
                  h     (* (/ 4 3) (mth/tan (/ (- mth/PI theta) 4)) r)
                  p1    (gpt/add v (gpt/scale u1 t))
                  p2    (gpt/add v (gpt/scale u2 t))]
              {:p1 p1
               :p2 p2
               :c1 (gpt/add p1 (gpt/scale u1 (- h)))
               :c2 (gpt/add p2 (gpt/scale u2 (- h)))}))
          (range n))))

(defn- outline-content
  "The closed outline through `vertices`, its corners rounded by `radius`;
  `xform` maps every point (rotation/flip)."
  [vertices radius xform]
  (if (and (number? radius) (pos? radius))
    (let [corners (rounded-corners vertices radius)
          pt      (fn [p] (let [p (xform p)] {:x (:x p) :y (:y p)}))
          curve   (fn [{:keys [p2 c1 c2]}]
                    (let [p2 (xform p2) c1 (xform c1) c2 (xform c2)]
                      {:command :curve-to
                       :params {:x (:x p2) :y (:y p2)
                                :c1x (:x c1) :c1y (:y c1)
                                :c2x (:x c2) :c2y (:y c2)}}))]
      (path/content
       (-> [{:command :move-to :params (pt (:p1 (first corners)))}
            (curve (first corners))]
           (into (mapcat (fn [c] [{:command :line-to :params (pt (:p1 c))} (curve c)]))
                 (rest corners))
           (conj {:command :close-path}))))
    (path/points->content (mapv xform vertices) :close true)))

(defn- regenerate
  "Rebuilds the outline inside the shape's (unrotated) box, then applies the
  shape's rotation/flip around its center."
  [shape {:keys [kind count ratio] :as params}]
  (let [selrect   (:selrect shape)
        transform (:transform shape)
        center    (grc/rect->center selrect)
        vertices  (fit-to-rect (unit-vertices kind count ratio) selrect)
        ;; zvena: corners are rounded in the unrotated box, then the
        ;; rotation/flip applies to every point
        xform     (if (some? transform)
                    #(gmt/transform-point-center % center transform)
                    identity)]
    (-> shape
        (assoc :content (outline-content vertices (:radius params) xform))
        ;; zvena: keep the layer's other zvena data (bindings, notes…)
        (update-in [:plugin-data :zvena] merge (:zvena (params->plugin-data params))))))

(defn update-polygon
  "Changes the count (3–60), for stars the inner ratio (0.01–0.99), and
  the corner radius (zvena)."
  [ids changes]
  (ptk/reify ::update-polygon
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (dwsh/update-shapes
              ids
              (fn [shape]
                (if-let [params (polygon-params shape)]
                  (regenerate shape (-> (merge params changes)
                                        (update :count #(-> % (mth/round) (mth/clamp 3 60) int))
                                        (update :ratio #(mth/clamp % 0.01 0.99))
                                        (update :radius #(max 0 (or % 0)))))
                  shape)))))))

(defn- update-shape
  [tool rect]
  (fn [state]
    (update-in state [:workspace-drawing :object]
               (fn [object]
                 (let [content (shape-content tool rect)
                       selrect (path/calc-selrect content)]
                   (-> object
                       (assoc :content content)
                       (assoc :selrect selrect)
                       (assoc :points (grc/rect->points selrect))
                       (assoc :click-draw? false)))))))

(defn- setup-frame
  [start]
  (ptk/reify ::setup-frame
    ptk/UpdateEvent
    (update [_ state]
      (let [objects      (dsh/lookup-page-objects state)
            frame-id     (->> (ctst/top-nested-frame objects start)
                              (ctn/get-first-valid-parent objects)
                              :id)
            flex-layout? (ctl/flex-layout? objects frame-id)
            grid-layout? (ctl/grid-layout? objects frame-id)
            drop-index   (when flex-layout? (gslf/get-drop-index frame-id objects start))
            drop-cell    (when grid-layout? (gslg/get-drop-cell frame-id objects start))]
        (update-in state [:workspace-drawing :object]
                   (fn [object]
                     (-> object
                         (assoc :frame-id frame-id)
                         (assoc :parent-id frame-id)
                         (cond-> (some? drop-index)
                           (with-meta {:index drop-index}))
                         (cond-> (some? drop-cell)
                           (with-meta {:cell drop-cell})))))))))

(defn- finalize
  "A click without a drag makes a 100×100 shape at the click point."
  [tool start]
  (ptk/reify ::finalize
    ptk/UpdateEvent
    (update [_ state]
      (if (dm/get-in state [:workspace-drawing :object :click-draw?])
        ((update-shape tool (grc/make-rect (:x start) (:y start) 100 100)) state)
        state))))

(defn handle-drawing
  "Runs the click-and-drag interaction for :polygon or :star."
  [tool]
  (ptk/reify ::handle-drawing
    ptk/WatchEvent
    (watch [_ state stream]
      (let [stopper (mse/drag-stopper stream)
            zoom    (dm/get-in state [:workspace-local :zoom] 1)
            start   @ms/mouse-position
            content (shape-content tool (grc/make-rect (:x start) (:y start) 1 1))
            selrect (path/calc-selrect content)
            shape   (cts/setup-shape {:type :path
                                      :name (if (= tool :star) "Star" "Polygon")
                                      :plugin-data (params->plugin-data
                                                    {:kind tool
                                                     :count (if (= tool :star) default-star-count default-polygon-count)
                                                     :ratio default-star-ratio})
                                      :initialized? true
                                      :click-draw? true
                                      :frame-id uuid/zero
                                      :parent-id uuid/zero
                                      :fills [{:fill-color default-color
                                               :fill-opacity 1}]
                                      :strokes []
                                      :content content
                                      :selrect selrect
                                      :points (grc/rect->points selrect)})]
        (rx/concat
         (rx/of #(update % :workspace-drawing assoc :object shape))

         (->> ms/mouse-position
              ;; Same click/drag threshold as the box tools (10 screen px)
              (rx/filter #(> (* (gpt/distance % start) zoom) 10))
              (rx/with-latest-from ms/mouse-position-shift ms/mouse-position-alt)
              (rx/map (fn [[point shift? alt?]]
                        (update-shape tool (box start point shift? alt?))))
              (rx/take-until stopper))

         (rx/of
          (setup-frame start)
          (finalize tool start)
          (common/handle-finish-drawing)))))))

;; --- Ellipse arcs (zvena: Figma's ellipse Start / Sweep / Ratio)
;;
;; An ellipse with a partial sweep or an inner ratio becomes a path whose
;; parameters live in plugin-data {:zvena {"shape" "ellipse" "start" ..
;; "sweep" .. "ratio" ..}}, so the arc stays editable; the layer keeps the
;; full ellipse box, as in Figma.

(def default-arc {:start 0 :sweep 1 :ratio 0 :box [0 0 1 1]})

(defn- parse-box
  [v]
  (let [parts (some->> (some-> v (.split ",")) (map js/parseFloat) (vec))]
    (if (and (= 4 (count parts)) (every? #(and (number? %) (not (js/isNaN %))) parts))
      parts
      [0 0 1 1])))

(defn ellipse-arc-params
  "Start (degrees), sweep (0..1), ratio (0..0.99) and the full ellipse box
  as fractions of the layer's box, for an ellipse or an ellipse arc."
  [shape]
  (if (= :circle (:type shape))
    (assoc default-arc :kind :ellipse)
    (when-let [data (dm/get-in shape [:plugin-data :zvena])]
      (when (= "ellipse" (get data "shape"))
        {:kind  :ellipse
         :start (or (some-> (get data "start") js/parseFloat) 0)
         :sweep (or (some-> (get data "sweep") js/parseFloat) 1)
         :ratio (or (some-> (get data "ratio") js/parseFloat) 0)
         :box   (parse-box (get data "box"))}))))

(defn- arc-segments
  "Cubic segments of a unit-circle arc from a0 to a1 (radians), radius r,
  without the initial move."
  [a0 a1 r]
  (let [n    (max 1 (js/Math.ceil (/ (js/Math.abs (- a1 a0)) (/ js/Math.PI 2))))
        step (/ (- a1 a0) n)
        k    (* (/ 4 3) (js/Math.tan (/ step 4)))]
    (vec (for [i (range n)]
           (let [s  (+ a0 (* i step))
                 e  (+ s step)
                 p0 [(* r (js/Math.cos s)) (* r (js/Math.sin s))]
                 p3 [(* r (js/Math.cos e)) (* r (js/Math.sin e))]
                 c1 [(- (first p0) (* k r (js/Math.sin s))) (+ (second p0) (* k r (js/Math.cos s)))]
                 c2 [(+ (first p3) (* k r (js/Math.sin e))) (- (second p3) (* k r (js/Math.cos e)))]]
             {:command :curve-to :c1 c1 :c2 c2 :to p3})))))

(defn- ellipse-box
  "The full ellipse box in the layer's unrotated coordinates."
  [shape [bx by bw bh]]
  (let [{:keys [x y width height]} (:selrect shape)]
    (grc/make-rect (+ x (* bx width)) (+ y (* by height))
                   (max 0.01 (* bw width)) (max 0.01 (* bh height)))))

(defn- arc-content
  [shape {:keys [start sweep ratio box]}]
  (let [{:keys [x y width height]} (ellipse-box shape box)
        transform (:transform shape)
        origin    (grc/rect->center (:selrect shape))
        center    (gpt/point (+ x (/ width 2)) (+ y (/ height 2)))
        rx (/ width 2)
        ry (/ height 2)
        pt (fn [[ux uy]]
             (let [p (gpt/point (+ (:x center) (* rx ux)) (+ (:y center) (* ry uy)))
                   p (if (some? transform) (gmt/transform-point-center p origin transform) p)]
               {:x (:x p) :y (:y p)}))
        a0    (* (/ start 180) js/Math.PI)
        sweep (max 0.001 (min 1 sweep))
        a1    (+ a0 (* sweep 2 js/Math.PI))
        full? (>= sweep 0.999)
        ratio (max 0 (min 0.99 ratio))
        seg->cmd (fn [{:keys [c1 c2 to]}]
                   (let [c1 (pt c1) c2 (pt c2) to (pt to)]
                     {:command :curve-to
                      :params {:x (:x to) :y (:y to)
                               :c1x (:x c1) :c1y (:y c1)
                               :c2x (:x c2) :c2y (:y c2)}}))
        move  (fn [a r] {:command :move-to :params (pt [(* r (js/Math.cos a)) (* r (js/Math.sin a))])})
        line  (fn [a r] {:command :line-to :params (pt [(* r (js/Math.cos a)) (* r (js/Math.sin a))])})
        outer (into [(move a0 1)] (map seg->cmd) (arc-segments a0 a1 1))
        segs  (cond
                ;; ring: the outer circle plus the inner one drawn backwards
                (and full? (pos? ratio))
                (-> outer
                    (conj {:command :close-path})
                    (conj (move a0 ratio))
                    (into (map seg->cmd) (arc-segments a0 (- a0 (* 2 js/Math.PI)) ratio))
                    (conj {:command :close-path}))

                full?
                (conj outer {:command :close-path})

                ;; donut slice
                (pos? ratio)
                (-> outer
                    (conj (line a1 ratio))
                    (into (map seg->cmd) (arc-segments a1 a0 ratio))
                    (conj {:command :close-path}))

                ;; pie slice
                :else
                (-> outer
                    (conj {:command :line-to :params (pt [0 0])})
                    (conj {:command :close-path})))]
    (path.impl/from-plain segs)))

(defn- arc-plugin-data
  [{:keys [start sweep ratio box]}]
  {:zvena {"shape" "ellipse" "start" (str start) "sweep" (str sweep) "ratio" (str ratio)
           "box" (str/join "," box)}})

(defn- rebox
  "The ellipse box of `old` (in its unrotated frame) as fractions of the
  regenerated layer's box, so later edits keep the full ellipse."
  [old new box]
  (let [e      (ellipse-box old box)
        tf     (:transform old)
        ec     (grc/rect->center e)
        ec     (if (some? tf) (gmt/transform-point-center ec (grc/rect->center (:selrect old)) tf) ec)
        sr     (:selrect new)
        itf    (:transform-inverse new)
        ec     (if (some? itf) (gmt/transform-point-center ec (grc/rect->center sr) itf) ec)
        w      (max 0.01 (:width sr))
        h      (max 0.01 (:height sr))]
    [(/ (- (- (:x ec) (/ (:width e) 2)) (:x sr)) w)
     (/ (- (- (:y ec) (/ (:height e) 2)) (:y sr)) h)
     (/ (:width e) w)
     (/ (:height e) h)]))

(defn update-ellipse-arc
  "Sets an ellipse's start (degrees), sweep (0..1) and ratio (0..0.99)."
  [ids changes]
  (ptk/reify ::update-ellipse-arc
    ptk/WatchEvent
    (watch [it state _]
      (let [page-id (:current-page-id state)
            objects (dsh/lookup-page-objects state)
            update-fn
            (fn [shape]
              (if-let [params (ellipse-arc-params shape)]
                (let [params (-> (merge params changes)
                                 (update :start #(-> % (mth/clamp -360 360)))
                                 (update :sweep #(mth/clamp % 0.001 1))
                                 (update :ratio #(mth/clamp % 0 0.99)))
                      base   (if (= :circle (:type shape))
                               (path/convert-to-path shape objects)
                               shape)
                      result (path/update-geometry base (arc-content shape params))]
                  (-> result
                      (update :plugin-data merge
                              (arc-plugin-data (assoc params :box (rebox shape result (:box params)))))))
                shape))
            changes (-> (pcb/empty-changes it page-id)
                        (pcb/with-objects objects)
                        (pcb/update-shapes ids update-fn))]
        (rx/of (dch/commit-changes changes))))))
