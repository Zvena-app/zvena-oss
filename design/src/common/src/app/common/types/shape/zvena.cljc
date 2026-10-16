;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.common.types.shape.zvena
  "zvena: Figma-parity metadata kept in the shape's plugin-data under the
  `:zvena` namespace ({:zvena {\"key\" \"value\"}}), so the backend, the
  exporter and both renderers keep seeing plain shapes:

  - \"section\"         \"true\" on a frame makes it a Figma section
  - \"slice\"           \"true\" on a rect makes it a Figma slice
  - \"dev-status\"      \"ready\" | \"completed\" (Dev Mode, Ready for dev)
  - \"dev-status-by\"   who set the status (profile full name)
  - \"dev-status-at\"   when (ISO-8601)
  - \"annotation\"      Dev Mode annotation text
  - \"annotation-props\" pinned properties, comma separated (\"width,fill\")"
  (:require
   [app.common.data.macros :as dm]
   [app.common.uuid :as uuid]
   [clojure.string :as str]))

(def plugin-ns :zvena)

(def section-key "section")
(def slice-key "slice")
(def dev-status-key "dev-status")
(def dev-status-by-key "dev-status-by")
(def dev-status-at-key "dev-status-at")
(def annotation-key "annotation")
(def annotation-props-key "annotation-props")

(def dev-statuses #{"ready" "completed"})

(defn get-data
  "The zvena plugin-data value of `key` (a string) on `shape`. Plugins (the
  Figma import among them) can only write shared plugin data, so the
  `zvena` shared namespace is read as well."
  [shape key]
  (when (some? shape)
    (or (dm/get-in shape [:plugin-data plugin-ns key])
        (dm/get-in shape [:plugin-data :shared/zvena key]))))

(defn section?
  "True when `shape` is a frame marked as a Figma section."
  [shape]
  (and (some? shape)
       (= :frame (:type shape))
       (= "true" (get-data shape section-key))))

(defn slice?
  "True when `shape` is a Figma slice: a rect that only marks an area to
  export (it renders nothing and exports what lies beneath it)."
  [shape]
  (and (some? shape)
       (= :rect (:type shape))
       (= "true" (get-data shape slice-key))))

(defn top-level-frame?
  "A frame on the canvas root or directly inside a section: what Figma
  calls a top-level frame (it gets a title, a Dev Mode status...)."
  [objects shape]
  (and (some? shape)
       (= :frame (:type shape))
       (not= uuid/zero (:id shape))
       (let [parent-id (:parent-id shape)]
         (or (= uuid/zero parent-id)
             (section? (get objects parent-id))))))

(defn closest-section-id
  "`id` itself or its closest ancestor that is a section; uuid/zero when
  there is none (sections live on the canvas or inside other sections)."
  [objects id]
  (loop [id id
         n  0]
    (cond
      (or (nil? id) (= id uuid/zero) (> n 1000))
      uuid/zero

      (section? (get objects id))
      id

      :else
      (recur (dm/get-in objects [id :parent-id]) (inc n)))))

(defn dev-status
  "\"ready\" / \"completed\" when the frame is marked for development."
  [shape]
  (let [status (get-data shape dev-status-key)]
    (when (contains? dev-statuses status)
      status)))

(defn annotation
  "The annotation text of `shape`, nil when blank."
  [shape]
  (let [text (get-data shape annotation-key)]
    (when (and (string? text) (not (str/blank? text)))
      text)))

(defn annotation-props
  "The pinned properties of the annotation of `shape`, as a vector of
  strings (\"width\", \"fill\"...)."
  [shape]
  (let [value (get-data shape annotation-props-key)]
    (if (and (string? value) (not (str/blank? value)))
      (into []
            (comp (map str/trim)
                  (remove str/blank?)
                  (distinct))
            (str/split value #","))
      [])))

(defn annotated?
  [shape]
  (or (some? (annotation shape))
      (boolean (seq (annotation-props shape)))))

(defn expand-sections
  "Replaces every section in `shapes` by the frames it contains (sections
  inside sections too): Figma never treats a section as a screen to export
  or to prototype."
  [objects shapes]
  (into []
        (mapcat (fn [shape]
                  (if (section? shape)
                    (->> (:shapes shape)
                         (keep #(get objects %))
                         (filter #(= :frame (:type %)))
                         (expand-sections objects))
                    [shape])))
        shapes))

;; --- zvena: Figma prototype scroll behavior (Prototype tab)
;;
;; - "overflow"  on a frame: "horizontal" | "vertical" | "both" makes its
;;               overflowing content scroll in the prototype (absent or
;;               "none": No scrolling). Figma only scrolls frames that
;;               clip their content.
;; - "position"  on a layer: "sticky" (Figma Sticky). Figma's Fixed is
;;               Penpot's own `:fixed-scroll` attribute (Fix when
;;               scrolling), which wins over "sticky", so old files work.

(def overflow-key "overflow")
(def position-key "position")

(def overflows #{"horizontal" "vertical" "both"})

(defn overflow
  "zvena: Figma overflow direction of a frame: :none, :horizontal,
  :vertical or :both."
  [shape]
  (let [value (get-data shape overflow-key)]
    (if (and (some? shape)
             (= :frame (:type shape))
             (contains? overflows value))
      (keyword value)
      :none)))

(defn scroll-container?
  "zvena: true when the frame scrolls its content in the prototype: it
  has an overflow direction and clips its content."
  [shape]
  (and (some? shape)
       (= :frame (:type shape))
       (not (:show-content shape))
       (not (section? shape))
       (not= :none (overflow shape))))

(defn scroll-position
  "zvena: Figma position of a layer while its parent scrolls: :fixed
  (Penpot `:fixed-scroll`), :sticky or :scroll (Scroll with parent)."
  [shape]
  (cond
    (nil? shape) :scroll
    (true? (:fixed-scroll shape)) :fixed
    (= "sticky" (get-data shape position-key)) :sticky
    :else :scroll))

(defn sticky?
  [shape]
  (= :sticky (scroll-position shape)))

(defn fixed-in-scroll-board?
  "zvena: true for a fixed layer (`:fixed-scroll`) whose parent is a
  nested frame that scrolls: the frame itself keeps it in place, so the
  viewer does not lift it to the fixed layer of the screen."
  [objects shape]
  (and (some? shape)
       (true? (:fixed-scroll shape))
       (let [parent (get objects (:parent-id shape))]
         (and (scroll-container? parent)
              (not (top-level-frame? objects parent))))))
