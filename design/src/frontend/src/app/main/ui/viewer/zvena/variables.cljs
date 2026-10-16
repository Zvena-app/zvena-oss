;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.viewer.zvena.variables
  "zvena: Figma variables in the viewer (see
  app.main.data.viewer.zvena-variables for the state).

  - The layers that read variables are rendered with their values:
    visibility bound to a boolean variable, text content bound to a
    string or number variable (rendered as HTML text, the stored layout
    is for the old text) and the fills / strokes of a color token once
    the prototype has set that variable (until then the shape keeps the
    value stored in the file, which already honours the variable modes).
  - Set variable and Conditional actions (`set-variable!`,
    `branch-actions`, run by app.main.ui.viewer.shapes).
  - R restarts the prototype, as in Figma: back to the first screen with
    the variables reset (unless a Key/Gamepad trigger uses R)."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.geom.shapes :as gsh]
   [app.common.types.fills :as types.fills]
   [app.common.types.shape.zvena-vars :as ctsv]
   [app.common.types.text :as txt]
   [app.main.data.tinycolor :as tinycolor]
   [app.main.data.viewer :as dv]
   [app.main.data.viewer.zvena-variables :as zvv]
   [app.main.fonts :as fonts]
   [app.main.store :as st]
   [app.main.ui.shapes.text.fo-text :as fo]
   [app.main.ui.viewer.zvena.variants :as zvariants]
   [app.util.dom :as dom]
   [goog.events :as events]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

;; --- Actions (called by the viewer interaction handlers)

(defn set-variable!
  [interaction]
  (zvv/set-variable! interaction))

(defn branch-actions
  [interaction objects]
  (zvv/branch-actions interaction objects))

;; --- Bound layers

(defn- shape-names
  "Variables the shape reads: its visibility and text bindings and the
  color tokens of its fills and strokes."
  [shape]
  (when (some? shape)
    (not-empty
     (into #{}
           (filter string?)
           [(ctsv/get-binding shape :visible)
            (ctsv/get-binding shape :text)
            (dm/get-in shape [:applied-tokens :fill])
            (dm/get-in shape [:applied-tokens :stroke-color])]))))

(defonce ^:private no-vars-ref
  (l/atom nil))

(defn shape-ref
  "A ref to the session values ({name value}) of the variables the shape
  reads; a constant nil ref for the shapes that read none."
  [shape]
  (if-let [names (shape-names shape)]
    (l/derived #(not-empty (select-keys % names)) zvv/vars-ref =)
    no-vars-ref))

(defn- value->fill
  [value]
  (when-let [tc (when (string? value)
                  (tinycolor/valid-color value))]
    {:fill-color (tinycolor/->hex-string tc)
     :fill-opacity (tinycolor/alpha tc)}))

(defn- apply-visible
  [shape value]
  (if (boolean? value)
    (assoc shape :hidden (not value))
    shape))

(defn- apply-text
  [shape value]
  (let [content (:content shape)]
    (if (or (nil? value) (nil? content))
      shape
      (let [text (ctsv/format-value value)]
        (if (= text (txt/content->text content))
          shape
          (-> shape
              (assoc :content (txt/change-text content text))
              (dissoc :position-data)
              (assoc ::text-override true)))))))

(defn- apply-fill
  [shape value]
  (if-let [fill (value->fill value)]
    (if (= :text (:type shape))
      (-> shape
          (d/update-when :content
                         (fn [content]
                           (txt/transform-nodes txt/is-text-node?
                                                #(assoc % :fills [fill])
                                                content)))
          (d/update-when :position-data
                         (fn [data]
                           (mapv #(assoc % :fills [fill]) data))))
      (update shape :fills
              (fn [fills]
                (types.fills/update
                 fills
                 (fn [fills]
                   (if (seq fills)
                     (assoc fills 0 (-> (first fills)
                                        (dissoc :fill-color-gradient :fill-image
                                                :fill-color-ref-id :fill-color-ref-file)
                                        (merge fill)))
                     [fill]))))))
    shape))

(defn- apply-stroke
  [shape value]
  (let [fill    (value->fill value)
        strokes (:strokes shape)]
    (if (and (some? fill) (seq strokes))
      (assoc shape :strokes
             (assoc (vec strokes) 0
                    (-> (first strokes)
                        (dissoc :stroke-color-gradient :stroke-image
                                :stroke-color-ref-id :stroke-color-ref-file)
                        (assoc :stroke-color (:fill-color fill)
                               :stroke-opacity (:fill-opacity fill)))))
      shape)))

(defn apply-vars
  "The shape as the prototype shows it now. `changed` are the session
  values of the variables it reads (from `shape-ref`) and `objects` the
  page objects (the variable modes of its frames)."
  [shape changed objects]
  (let [visible-var (ctsv/get-binding shape :visible)
        text-var    (ctsv/get-binding shape :text)]
    (if (and (nil? visible-var) (nil? text-var) (empty? changed))
      shape
      (let [initial    (when (or (some? visible-var) (some? text-var))
                         (zvv/layer-initial-values (deref st/state) objects (:id shape)))
            value-of   (fn [name]
                         (if (contains? changed name)
                           (get changed name)
                           (get initial name)))
            fill-var   (dm/get-in shape [:applied-tokens :fill])
            stroke-var (dm/get-in shape [:applied-tokens :stroke-color])]
        (cond-> shape
          (some? visible-var)
          (apply-visible (value-of visible-var))

          (and (some? text-var) (= :text (:type shape)))
          (apply-text (value-of text-var))

          (and (string? fill-var) (contains? changed fill-var))
          (apply-fill (get changed fill-var))

          (and (string? stroke-var) (contains? changed stroke-var))
          (apply-stroke (get changed stroke-var)))))))

;; --- Text bound to a variable

(defn- load-fonts!
  [content]
  (let [extract-fn (juxt :font-id :font-variant-id)
        default    (extract-fn txt/default-typography)]
    (->> (tree-seq map? :children content)
         (into #{default} (keep extract-fn))
         (run! (fn [[font-id variant-id]]
                 (when (some? font-id)
                   (fonts/ensure-loaded! font-id variant-id)))))))

(mf/defc text-override*
  "A text whose content comes from a variable. Its stored layout (position
  data) is for the old text, so it is laid out as HTML, overflowing its
  box as an auto-sized text would."
  {::mf/private true}
  [{:keys [shape]}]
  (let [content (:content shape)]
    (mf/with-effect [content]
      (load-fonts! content))

    [:foreignObject {:x (:x shape)
                     :y (:y shape)
                     :width (:width shape)
                     :height (:height shape)
                     :transform (gsh/transform-str shape)
                     :style {:overflow "visible"}}
     [:style ".text-node { background-clip: text;
                           -webkit-background-clip: text; }"]
     [:> fo/render-node* {:index 0
                          :shape shape
                          :node content}]]))

(defn text-shape-wrapper
  "zvena: the viewer text renderer `component` (wrap-props false), that
  renders a text bound to a variable whose value differs from the file
  text with that value."
  [component]
  (mf/fnc text-shape
    {::mf/wrap-props false}
    [props]
    (let [shape (unchecked-get props "shape")]
      (if (true? (get shape ::text-override))
        [:> text-override* {:shape shape}]
        [:> component props]))))

;; --- Restart (R)

(defonce ^:private last-restart-event
  (volatile! nil))

(defn- editable-target?
  [^js target]
  (and (some? target)
       (or (contains? #{"INPUT" "TEXTAREA" "SELECT"} (.-tagName target))
           (true? (.-isContentEditable target)))))

(defn- r-key-trigger?
  "True when a Key/Gamepad trigger of the prototype uses R alone."
  [state]
  (some (fn [page]
          (some (fn [shape]
                  (some #(and (= :key-press (:event-type %))
                              (= "r" (:key %))
                              (empty? (:key-modifiers %)))
                        (:interactions shape)))
                (vals (:objects page))))
        (vals (dm/get-in state [:viewer :pages]))))

(defn- restart-event?
  [^js event]
  (and (contains? #{"r" "R"} (.-key event))
       (not (or (.-ctrlKey event) (.-metaKey event) (.-altKey event) (.-shiftKey event)))
       (not (editable-target? (.-target event)))))

(defn use-restart-key
  "Hook: R restarts the prototype as in Figma (first screen of the first
  flow, variables and variants reset). Several viewports may use it, the
  key runs once."
  []
  (mf/with-effect []
    (let [on-key-down
          (fn [event]
            (let [native (dom/event->browser-event event)]
              (when (and (some? native)
                         (not (identical? native @last-restart-event))
                         (restart-event? native)
                         (not (r-key-trigger? (deref st/state))))
                (vreset! last-restart-event native)
                (zvariants/reset-all!)
                (st/emit! (zvv/reset)
                          (dv/go-to-frame-auto)))))
          key (events/listen js/document "keydown" on-key-down)]
      #(events/unlistenByKey key))))
