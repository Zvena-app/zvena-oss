;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.common.types.shape.zvena-effects
  "zvena: Figma's Effects and the effect / layout grid styles.

  Shadows, the layer blur and the background blur stay in Penpot's own
  shape attributes (`:shadow`, `:blur`, `:background-blur`), so old files
  render exactly as before. What Penpot does not have is kept in
  plugin-data under the `:zvena` namespace (strings only, so the backend
  schema, the exporter and the WebGL renderer keep seeing plain shapes):

  Shape plugin-data
  - \"noise\"         Figma's Noise effect (transit, see `check-noise`)
  - \"texture\"       Figma's Texture effect (transit, see `check-texture`)
  - \"effect-style\"  applied effect style, \"<file-id>:<style-id>\"
  - \"grid-style\"    applied layout grid style, \"<file-id>:<style-id>\"

  File plugin-data
  - \"effect-style/<style-id>\"  {:id :name :description :value <effects>}
  - \"grid-style/<style-id>\"    {:id :name :description :value <grids>}

  An effect style value is the map of `get-effects`; a grid style value is
  a vector of Penpot frame grids. A shadow may carry `:show-behind false`
  (Figma's \"Show behind transparent areas\" unchecked); without the key
  it keeps Penpot's behaviour (shown behind)."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.transit :as t]
   [app.common.uuid :as uuid]
   [cuerdas.core :as str]))

(def plugin-ns :zvena)

;; Plugins (the Figma import among them) can only write shared plugin
;; data, so the shared `zvena` namespace is read as well.
(def shared-ns :shared/zvena)

(def noise-key "noise")
(def texture-key "texture")
(def effect-style-key "effect-style")
(def grid-style-key "grid-style")

(def effect-style-prefix "effect-style/")
(def grid-style-prefix "grid-style/")

(def effect-attrs
  "Penpot shape attributes that hold effects."
  [:shadow :blur :background-blur])

(def noise-types [:mono :duo :multi])

;; Figma's defaults
(def default-noise
  {:noise-type :mono
   :size 0.5
   :density 0.5
   :color {:color "#000000" :opacity 0.25}
   :color2 {:color "#FFFFFF" :opacity 0.25}
   :opacity 0.25
   :hidden false})

(def default-texture
  {:size 4
   :radius 4
   :clip true
   :hidden false})

;; --- Codecs

(defn- decode*
  [s]
  (when (and (string? s) (not (str/blank? s)))
    (try
      (t/decode-str s)
      (catch #?(:clj Throwable :cljs :default) _
        nil))))

(def ^:private decode
  (memoize decode*))

(defn- encode
  [v]
  (when (some? v)
    (t/encode-str v)))

(defn- finite
  [v default]
  (if (and (number? v) (d/num? v)) v default))

(defn- clamp
  [v lo hi]
  (max lo (min hi v)))

(defn- check-color
  [c default]
  (let [color   (:color c)
        opacity (:opacity c)]
    {:color   (if (and (string? color) (str/starts-with? color "#"))
                color
                (:color default))
     :opacity (clamp (finite opacity (:opacity default)) 0 1)}))

(defn check-noise
  "A well formed noise effect (or nil)."
  [noise]
  (when (map? noise)
    (let [type (:noise-type noise)]
      {:noise-type (if (some #(= type %) noise-types) type :mono)
       :size       (clamp (finite (:size noise) (:size default-noise)) 0.01 1000)
       :density    (clamp (finite (:density noise) (:density default-noise)) 0 1)
       :color      (check-color (:color noise) (:color default-noise))
       :color2     (check-color (:color2 noise) (:color2 default-noise))
       :opacity    (clamp (finite (:opacity noise) (:opacity default-noise)) 0 1)
       :hidden     (true? (:hidden noise))})))

(defn check-texture
  "A well formed texture effect (or nil)."
  [texture]
  (when (map? texture)
    {:size   (clamp (finite (:size texture) (:size default-texture)) 0.01 1000)
     :radius (clamp (finite (:radius texture) (:radius default-texture)) 0 1000)
     :clip   (not (false? (:clip texture)))
     :hidden (true? (:hidden texture))}))

(defn encode-noise
  [noise]
  (some-> noise check-noise encode))

(defn decode-noise
  [s]
  (some-> s decode check-noise))

(defn encode-texture
  [texture]
  (some-> texture check-texture encode))

(defn decode-texture
  [s]
  (some-> s decode check-texture))

;; --- Shape data

(defn get-data
  "The zvena plugin-data value of `key` on `shape`."
  [shape key]
  (when (some? shape)
    (or (dm/get-in shape [:plugin-data plugin-ns key])
        (dm/get-in shape [:plugin-data shared-ns key]))))

(defn get-noise
  [shape]
  (decode-noise (get-data shape noise-key)))

(defn get-texture
  [shape]
  (decode-texture (get-data shape texture-key)))

(defn visible-noise
  [shape]
  (let [noise (get-noise shape)]
    (when (and (some? noise) (not (:hidden noise)))
      noise)))

(defn visible-texture
  [shape]
  (let [texture (get-texture shape)]
    (when (and (some? texture) (not (:hidden texture)))
      texture)))

(defn has-render-effects?
  "True when the shape has a visible zvena effect (noise or texture) that
  the SVG renderer draws with the shape's filter."
  [shape]
  (and (some? (:plugin-data shape))
       (or (some? (visible-noise shape))
           (some? (visible-texture shape)))))

(defn without-render-effects
  "The shape without the zvena effects drawn by the filters (frames draw
  them once, on the outer layer)."
  [shape]
  (if (some? (:plugin-data shape))
    (-> shape
        (d/update-in-when [:plugin-data plugin-ns] dissoc noise-key texture-key)
        (d/update-in-when [:plugin-data shared-ns] dissoc noise-key texture-key))
    shape))

(defn shadow-show-behind?
  "Figma's \"Show behind transparent areas\". Penpot always showed the
  shadows behind, so a shadow without the flag keeps doing it."
  [shadow]
  (not (false? (:show-behind shadow))))

;; --- Effects as a whole (what an effect style holds)

(defn get-effects
  [shape]
  {:shadow          (into [] (:shadow shape))
   :blur            (:blur shape)
   :background-blur (:background-blur shape)
   :noise           (get-noise shape)
   :texture         (get-texture shape)})

(defn check-effects
  [effects]
  {:shadow          (into [] (filter map?) (:shadow effects))
   :blur            (let [b (:blur effects)] (when (map? b) b))
   :background-blur (let [b (:background-blur effects)] (when (map? b) b))
   :noise           (check-noise (:noise effects))
   :texture         (check-texture (:texture effects))})

(defn empty-effects?
  [effects]
  (and (empty? (:shadow effects))
       (nil? (:blur effects))
       (nil? (:background-blur effects))
       (nil? (:noise effects))
       (nil? (:texture effects))))

(defn- without-id
  [m]
  (when (some? m)
    (dissoc m :id)))

(defn normalize-effects
  "Effects without the ids, to compare them."
  [effects]
  (let [effects (check-effects effects)]
    (-> effects
        (update :shadow #(mapv without-id %))
        (update :blur without-id)
        (update :background-blur without-id))))

(defn same-effects?
  [a b]
  (= (normalize-effects a) (normalize-effects b)))

(defn set-attr-effects
  "`shape` with the Penpot attributes (shadows and blurs) of `effects`.
  The noise and the texture are plugin-data: see `plugin-effects`."
  [shape effects]
  (let [shadow  (into [] (:shadow effects))
        blur    (:blur effects)
        bblur   (:background-blur effects)]
    (cond-> shape
      (not= (into [] (:shadow shape)) shadow)
      (assoc :shadow shadow)

      (and (not= (:blur shape) blur) (some? blur))
      (assoc :blur blur)

      (and (some? (:blur shape)) (nil? blur))
      (dissoc :blur)

      (and (not= (:background-blur shape) bblur) (some? bblur))
      (assoc :background-blur bblur)

      (and (some? (:background-blur shape)) (nil? bblur))
      (dissoc :background-blur))))

(defn plugin-effects
  "The zvena plugin-data entries {key value} of `effects` (nil values
  remove the key)."
  [effects]
  {noise-key   (encode-noise (:noise effects))
   texture-key (encode-texture (:texture effects))})

;; --- Styles

(defn style-ref
  [file-id style-id]
  (str file-id ":" style-id))

(defn parse-style-ref
  "[file-id style-id] of a \"<file-id>:<style-id>\" reference."
  [s]
  (when (string? s)
    (let [[file-id style-id] (str/split s #":")
          file-id  (uuid/parse* file-id)
          style-id (uuid/parse* style-id)]
      (when (and (some? file-id) (some? style-id))
        [file-id style-id]))))

(defn style-ref-key
  "Shape plugin-data key of the applied style of `kind` (:effect / :grid)."
  [kind]
  (case kind
    :effect effect-style-key
    :grid   grid-style-key))

(defn style-prefix
  [kind]
  (case kind
    :effect effect-style-prefix
    :grid   grid-style-prefix))

(defn style-key
  "File plugin-data key of the style `style-id` of `kind`."
  [kind style-id]
  (str (style-prefix kind) style-id))

(defn shape-style-ref
  "[file-id style-id] of the style of `kind` applied to `shape`."
  [shape kind]
  (parse-style-ref (get-data shape (style-ref-key kind))))

(defn check-grids
  [grids]
  (into [] (filter #(and (map? %) (keyword? (:type %)))) grids))

(defn check-style-value
  [kind value]
  (case kind
    :effect (check-effects value)
    :grid   (check-grids value)))

(defn encode-style
  [kind style]
  (encode {:id          (:id style)
           :name        (str (:name style))
           :description (str (or (:description style) ""))
           :value       (check-style-value kind (:value style))}))

(defn- decode-style*
  [kind s]
  (let [m (decode s)]
    (when (and (map? m) (uuid? (:id m)) (string? (:name m)))
      (-> m
          (update :value #(check-style-value kind %))
          (assoc :kind kind)))))

(def decode-style
  (memoize decode-style*))

(defn get-styles
  "The styles of `kind` of a file data, sorted by name."
  [data kind]
  (let [prefix (style-prefix kind)]
    (->> (dm/get-in data [:plugin-data plugin-ns])
         (keep (fn [[k v]]
                 (when (and (string? k) (str/starts-with? k prefix))
                   (decode-style kind v))))
         (sort-by (comp str/lower :name))
         (into []))))

(defn get-style
  [data kind style-id]
  (when (some? style-id)
    (some->> (dm/get-in data [:plugin-data plugin-ns (style-key kind style-id)])
             (decode-style kind))))

(defn shape-style-value
  "What a style of `kind` takes from `shape`."
  [shape kind]
  (case kind
    :effect (get-effects shape)
    :grid   (into [] (:grids shape))))

(defn same-style-value?
  [kind a b]
  (case kind
    :effect (same-effects? a b)
    :grid   (= (check-grids a) (check-grids b))))
