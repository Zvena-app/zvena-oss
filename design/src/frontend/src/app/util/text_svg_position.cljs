;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.util.text-svg-position
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.transit :as transit]
   [app.common.types.text :as txt]
   [app.main.fonts :as fonts]
   [app.util.dom :as dom]
   [app.util.text-position-data :as tpd]
   [cuerdas.core :as str]
   [promesa.core :as p]))

(defn parse-text-nodes
  "Given a text node retrieves the rectangles for everyone of its paragraphs and its text."
  [parent-node direction text-node text-align]
  (letfn [(parse-entry [^js entry]
            (when (some? (.-position entry))
              {:node      (.-node entry)
               :position  (dom/bounding-rect->rect (.-position entry))
               :text      (.-text entry)
               :direction direction}))]
    (into []
          (keep parse-entry)
          (tpd/parse-text-nodes parent-node text-node text-align))))

(def load-promises (atom {}))

(defn load-font
  [font]
  (if (contains? @load-promises font)
    (get @load-promises font)
    (let [load-promise (dom/load-font font)]
      (swap! load-promises assoc font load-promise)
      load-promise)))

(defn resolve-font
  [node]
  (let [styles  (dom/get-computed-styles node)
        font    (dom/get-property-value styles "font")
        font    (if (or (not font) (empty? font))
                  ;; Firefox 95 won't return the font correctly.
                  ;; We can get the font shorthand with the font-size + font-family
                  (str/ffmt "% %"
                            (dom/get-property-value styles "font-size")
                            (dom/get-property-value styles "font-family"))
                  font)

        font-id (dom/get-property-value styles "--font-id")]

    (->> (fonts/ensure-loaded! font-id)
         (p/fmap (fn []
                   (when-not ^boolean (dom/check-font? font)
                     (load-font font))))
         (p/merr (fn [_cause]
                   (js/console.error (str/ffmt "Cannot load font %" font-id))
                   (p/resolved nil))))))


(defn- process-text-node
  [parent-node]
  (let [root       (dom/get-parent-with-selector parent-node ".text-node-html")
        paragraph  (dom/get-parent-with-selector parent-node ".paragraph")
        shape-x    (d/parse-double (dom/get-attribute root "data-x"))
        shape-y    (d/parse-double (dom/get-attribute root "data-y"))
        direction  (.-direction ^js (dom/get-computed-styles parent-node))
        text-align (.-textAlign ^js (dom/get-computed-styles paragraph))]

    (sequence
     (comp
      (mapcat #(parse-text-nodes parent-node direction % text-align))
      (map #(-> %
                (update-in [:position :x] + shape-x)
                (update-in [:position :y] + shape-y))))
     (seq (.-childNodes parent-node)))))

(defn- text-nodes-position-data
  "zvena: measures every text node of the layout `root` and maps it with
  `transform-data`. Texts with Figma's \"Truncate text\" are measured on a
  truncated copy of the layout (hidden lines removed, ellipsis added); it all
  runs synchronously so the original DOM is put back before React can see it."
  [root transform-data]
  (let [restore (when (= "true" (dom/get-data root "truncate"))
                  (tpd/truncate-layout root))]
    (try
      (into []
            (comp (mapcat process-text-node)
                  (map transform-data))
            (seq (dom/query-all root ".text-node")))
      (finally
        (when (fn? restore)
          (restore))))))

(defn calc-position-data
  [shape-id]
  (letfn [(get-prop [styles prop]
            (let [value (.getPropertyValue styles prop)]
              (when (and (some? value) (not= value ""))
                value)))

          ;; zvena: computed font-feature/variation-settings, nil when "normal"
          (css-settings [value]
            (when (and (some? value) (not= value "normal"))
              value))

          (transform-data [{:keys [node position text direction]}]
            (let [styles   (dom/get-computed-styles node)
                  position (assoc position :y (+ (dm/get-prop position :y)
                                                 (dm/get-prop position :height)))]
              (into position (filter val)
                    {:direction       direction
                     :font-family     (dm/str (get-prop styles "font-family"))
                     :font-size       (dm/str (get-prop styles "font-size"))
                     :font-weight     (dm/str (get-prop styles "font-weight"))
                     :text-transform  (dm/str (get-prop styles "text-transform"))
                     :text-decoration (dm/str (get-prop styles "text-decoration"))
                     :letter-spacing  (dm/str (get-prop styles "letter-spacing"))
                     :font-style      (dm/str (get-prop styles "font-style"))
                     ;; zvena: OpenType features and variable axes, so the SVG
                     ;; text draws the glyphs that were measured (old texts
                     ;; get none: "normal" is not stored)
                     :font-feature-settings   (css-settings (get-prop styles "font-feature-settings"))
                     :font-variation-settings (css-settings (get-prop styles "font-variation-settings"))
                     :fills           (or (transit/decode-str (get-prop styles "--fills"))
                                          txt/default-text-fills)
                     :text            text})))]

    (when (some? shape-id)
      (let [root       (dom/query (dm/fmt "#html-text-node-%" shape-id))
            text-nodes (dom/query-all root ".text-node")]
        (->> (p/all (map resolve-font text-nodes))
             (p/fmap (fn [_]
                       (text-nodes-position-data root transform-data))))))))
