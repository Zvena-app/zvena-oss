;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.viewer.zvena.easing
  "zvena: Figma-like easing curves for prototype animations.

  Figma offers the CSS curves (linear, ease in/out...), the `back`
  curves, a custom cubic bezier and four spring presets. This namespace
  turns an interaction animation map into:

  - a CSS / Web Animations `easing` string (`css-easing`); springs are
    sampled into a `linear()` curve (with a cubic-bezier fallback for
    browsers without `linear()` support),
  - a plain progress function (`easing-fn`, 0..1 -> value) for the
    animations driven by `requestAnimationFrame` (Scroll to),
  - the physical duration of a spring (`spring-duration`)."
  (:require
   [app.common.data :as d]
   [app.common.math :as mth]
   [cuerdas.core :as str]))

;; --- Cubic bezier curves

;; zvena: values from Figma's easing menu
(def ^:private bezier-presets
  {:linear           [0 0 1 1]
   :ease             [0.25 0.1 0.25 1]
   :ease-in          [0.42 0 1 1]
   :ease-out         [0 0 0.58 1]
   :ease-in-out      [0.42 0 0.58 1]
   :ease-in-back     [0.3 -0.05 0.7 -0.5]
   :ease-out-back    [0.45 1.45 0.8 1]
   :ease-in-out-back [0.7 -0.4 0.4 1.4]})

(defn- clamp01
  [v]
  (max 0 (min 1 v)))

(defn normalize-bezier
  "A valid bezier vector: four numbers, with the x values in [0, 1] as
  CSS requires."
  [bezier]
  (let [[x1 y1 x2 y2] (if (and (sequential? bezier)
                               (= 4 (count bezier))
                               (every? number? bezier))
                        bezier
                        [0.42 0 0.58 1])]
    [(clamp01 x1) y1 (clamp01 x2) y2]))

(defn- bezier-coord
  [t p1 p2]
  ;; B(t) for a 1D cubic bezier with P0 = 0 and P3 = 1
  (let [u (- 1 t)]
    (+ (* 3 u u t p1)
       (* 3 u t t p2)
       (* t t t))))

(defn- bezier-coord-derivative
  [t p1 p2]
  (let [u (- 1 t)]
    (+ (* 3 u u p1)
       (* 6 u t (- p2 p1))
       (* 3 t t (- 1 p2)))))

(defn bezier-fn
  "Progress function (x -> y) of a CSS cubic-bezier curve."
  [bezier]
  (let [[x1 y1 x2 y2] (normalize-bezier bezier)]
    (fn [x]
      (cond
        (<= x 0) 0
        (>= x 1) 1
        :else
        ;; Newton iterations, falling back to bisection
        (let [t (loop [t x i 0]
                  (if (>= i 8)
                    t
                    (let [err (- (bezier-coord t x1 x2) x)
                          dx  (bezier-coord-derivative t x1 x2)]
                      (if (or (< (mth/abs err) 1e-6) (< (mth/abs dx) 1e-6))
                        t
                        (recur (- t (/ err dx)) (inc i))))))
              t (if (and (<= 0 t 1)
                         (< (mth/abs (- (bezier-coord t x1 x2) x)) 1e-4))
                  t
                  (loop [lo 0 hi 1 i 0]
                    (let [mid (/ (+ lo hi) 2)]
                      (if (>= i 30)
                        mid
                        (if (< (bezier-coord mid x1 x2) x)
                          (recur mid hi (inc i))
                          (recur lo mid (inc i)))))))]
          (bezier-coord t y1 y2))))))

;; --- Springs

;; zvena: Figma spring presets (mass, stiffness, damping)
(def ^:private spring-presets
  {:spring-gentle {:mass 1 :stiffness 100 :damping 15}
   :spring-quick  {:mass 1 :stiffness 300 :damping 20}
   :spring-bouncy {:mass 1 :stiffness 600 :damping 15}
   :spring-slow   {:mass 1 :stiffness 80  :damping 20}})

;; Rough curves for browsers without CSS `linear()`
(def ^:private spring-fallback-beziers
  {:spring-gentle [0.25 1.1 0.5 1]
   :spring-quick  [0.2 1.15 0.4 1]
   :spring-bouncy [0.35 1.6 0.6 1]
   :spring-slow   [0.3 0.1 0.2 1]})

(defn spring?
  [easing]
  (contains? spring-presets easing))

(defn- spring-position
  "Position (0 -> 1) of a damped spring released at rest from 0 towards
  1, at `t` seconds."
  [{:keys [mass stiffness damping]} t]
  (let [w0   (mth/sqrt (/ stiffness mass))
        zeta (/ damping (* 2 (mth/sqrt (* stiffness mass))))]
    (cond
      (< zeta 1)
      (let [wd (* w0 (mth/sqrt (- 1 (* zeta zeta))))]
        (- 1 (* (js/Math.exp (- (* zeta w0 t)))
                (+ (js/Math.cos (* wd t))
                   (* (/ (* zeta w0) wd) (js/Math.sin (* wd t)))))))

      (= zeta 1)
      (- 1 (* (js/Math.exp (- (* w0 t))) (+ 1 (* w0 t))))

      :else
      (let [s  (mth/sqrt (- (* zeta zeta) 1))
            r1 (* (- w0) (- zeta s))
            r2 (* (- w0) (+ zeta s))]
        (+ 1 (/ (- (* r2 (js/Math.exp (* r1 t)))
                   (* r1 (js/Math.exp (* r2 t))))
                (- r1 r2)))))))

(defn- spring-decay
  "Slowest exponential decay rate of the spring (1/s)."
  [{:keys [mass stiffness damping]}]
  (let [w0   (mth/sqrt (/ stiffness mass))
        zeta (/ damping (* 2 (mth/sqrt (* stiffness mass))))]
    (if (<= zeta 1)
      (* zeta w0)
      (* w0 (- zeta (mth/sqrt (- (* zeta zeta) 1)))))))

(defn spring-duration
  "Time (ms) a spring preset needs to settle (amplitude below 0.1%)."
  [easing]
  (if-let [params (get spring-presets easing)]
    (let [decay (spring-decay params)]
      (-> (/ (* 1000 (js/Math.log 1000)) (max decay 0.1))
          (mth/ceil)
          (max 100)
          (min 5000)
          (int)))
    300))

(defn- spring-fn
  [easing]
  (let [params   (get spring-presets easing)
        duration (/ (spring-duration easing) 1000)]
    (fn [p]
      (cond
        (<= p 0) 0
        (>= p 1) 1
        :else (spring-position params (* p duration))))))

(def ^:private linear-supported?
  (delay
    (boolean
     (and (exists? js/CSS)
          (fn? (.-supports js/CSS))
          (.supports js/CSS "animation-timing-function" "linear(0, 0.5, 1)")))))

(defn- fmt-num
  [v]
  (let [v (/ (mth/round (* v 10000)) 10000)]
    (str v)))

(defn- sampled-linear
  [f samples]
  (let [points (for [i (range (inc samples))]
                 (if (= i samples)
                   1
                   (f (/ i samples))))]
    (str "linear(" (str/join ", " (map fmt-num points)) ")")))

;; --- Public API

(defn easing-fn
  "Progress function for an animation map (`:easing` and, for a custom
  curve, `:easing-bezier`)."
  [{:keys [easing easing-bezier]}]
  (cond
    (spring? easing)
    (spring-fn easing)

    (= easing :custom-bezier)
    (bezier-fn easing-bezier)

    :else
    (bezier-fn (get bezier-presets easing [0 0 1 1]))))

(defn css-easing
  "CSS / Web Animations `easing` string for an animation map."
  [{:keys [easing easing-bezier]}]
  (let [easing (d/nilv easing :linear)]
    (cond
      (contains? #{:linear :ease :ease-in :ease-out :ease-in-out} easing)
      (name easing)

      (spring? easing)
      (if @linear-supported?
        (sampled-linear (spring-fn easing) 60)
        (let [[x1 y1 x2 y2] (get spring-fallback-beziers easing)]
          (str "cubic-bezier(" x1 ", " y1 ", " x2 ", " y2 ")")))

      :else
      (let [[x1 y1 x2 y2] (if (= easing :custom-bezier)
                            (normalize-bezier easing-bezier)
                            (get bezier-presets easing [0 0 1 1]))]
        (str "cubic-bezier(" (fmt-num x1) ", " (fmt-num y1) ", "
             (fmt-num x2) ", " (fmt-num y2) ")")))))

(defn curve-path
  "SVG path data (in a 0..`size` box, y down) previewing the easing of an
  animation map, as the curve graph Figma shows under the easing menu."
  [animation size pad]
  (let [f       (easing-fn animation)
        samples 48
        ;; leave room for overshooting curves
        inner   (- size (* 2 pad))
        to-x    (fn [p] (+ pad (* p inner)))
        to-y    (fn [v] (+ pad (* (- 1 v) inner)))]
    (->> (range (inc samples))
         (map (fn [i]
                (let [p (/ i samples)]
                  (str (if (zero? i) "M" "L")
                       (fmt-num (to-x p)) " "
                       (fmt-num (to-y (f p)))))))
         (str/join " "))))

(defn parse-bezier
  "Parses a \"x1, y1, x2, y2\" string (as typed in Figma's custom bezier
  field). Returns nil when it is not valid."
  [value]
  (let [parts (->> (str/split (str/trim (str value)) #"[\s,;]+")
                   (remove str/blank?)
                   (map d/parse-double))]
    (when (and (= 4 (count parts))
               (every? number? parts)
               (not-any? js/isNaN parts))
      (normalize-bezier (vec parts)))))

(defn format-bezier
  [bezier]
  (->> (normalize-bezier bezier)
       (map fmt-num)
       (str/join ", ")))
