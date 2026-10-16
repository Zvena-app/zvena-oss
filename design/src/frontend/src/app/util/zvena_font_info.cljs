;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.util.zvena-font-info
  "zvena: what a font supports, for Figma's \"Type settings\" panel: the
  OpenType feature tags of its GSUB / GPOS tables (unsupported features
  are greyed out, the stylistic sets are listed) and its variable axes
  (fvar table, the Variable tab).

  Read with opentype.js from the font file of the variant: the woff of a
  team (custom) font, which is the file the browser renders with, and the
  TTF of a Google font through the fonts proxy (the browser renders the
  woff2 of the same static instance, which opentype.js cannot read). The
  Google catalog and its CSS serve static instances only, so Google fonts
  have no axes; uploaded variable fonts do."
  (:require
   ["opentype.js" :as ot]
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.logging :as log]
   [app.common.uri :as u]
   [app.config :as cf]
   [app.main.fonts :as fonts]
   [cuerdas.core :as str]
   [promesa.core :as p]))

(log/set-level! :warn)

(def ^:private max-font-bytes
  "Bigger files (CJK fonts) are not read: the panel then offers every
  feature."
  (* 12 1024 1024))

(defn- variant-url
  [{:keys [backend family]} {:keys [id suffix ttf-url] :as variant}]
  (case backend
    :google
    (when (and (string? ttf-url) (re-find #"^https?://fonts\.gstatic\.com/s/" ttf-url))
      (str/replace ttf-url
                   #"^https?://fonts\.gstatic\.com/s"
                   (dm/str (u/join cf/public-uri "internal/gfonts/font"))))

    :custom
    (when-let [file-id (or (::fonts/woff1-file-id variant)
                           (::fonts/ttf-file-id variant)
                           (::fonts/otf-file-id variant))]
      (dm/str (u/join cf/public-uri (dm/str "assets/by-id/" file-id))))

    :builtin
    (dm/str (u/join cf/public-uri (dm/str "fonts/" family "-" (or suffix id) ".woff")))

    nil))

(defn- table-tags
  [^js table]
  (when (and (some? table) (array? (.-features table)))
    (map (fn [^js feature] (.-tag feature)) (.-features table))))

(defn- axis-name
  [^js axis]
  (let [name (.-name axis)]
    (cond
      (string? name) name
      (some? name)   (or (unchecked-get name "en")
                         (first (js/Object.values name)))
      :else          nil)))

(defn- parse-font-info
  [^js buffer]
  (let [^js font   (ot/parse buffer #js {:lowMemory true})
        ^js tables (.-tables font)
        ^js fvar   (.-fvar tables)
        features   (into #{}
                         (filter string?)
                         (concat (table-tags (.-gsub tables))
                                 (table-tags (.-gpos tables))))
        axes       (when (and (some? fvar) (array? (.-axes fvar)))
                     (into []
                           (keep (fn [^js axis]
                                   (let [tag (.-tag axis)
                                         min (.-minValue axis)
                                         max (.-maxValue axis)]
                                     (when (and (string? tag) (number? min) (number? max) (< min max))
                                       {:tag     tag
                                        :name    (axis-name axis)
                                        :min     min
                                        :max     max
                                        :default (d/nilv (.-defaultValue axis) min)}))))
                           (.-axes fvar)))]
    {:features features
     :axes     (or axes [])}))

(defn- fetch-font
  [url]
  (-> (js/fetch url #js {:credentials "same-origin"})
      (p/then (fn [^js response]
                (let [size (some-> (.. response -headers (get "content-length"))
                                   (d/parse-integer))]
                  (if (and (.-ok response)
                           (or (nil? size) (<= size max-font-bytes)))
                    (.arrayBuffer response)
                    (p/rejected (ex-info "font file not readable" {:url url}))))))
      (p/then (fn [^js buffer]
                (if (<= (.-byteLength buffer) max-font-bytes)
                  buffer
                  (p/rejected (ex-info "font file too big" {:url url})))))))

(defonce ^:private cache (atom {}))

(defn font-info
  "Promise of `{:features #{tag} :axes [{:tag :name :min :max :default}]}`
  for the variant `variant-id` of the font `font-id`, or nil when the font
  file cannot be read (the panel then offers every feature)."
  [font-id variant-id]
  (let [font    (when (string? font-id) (fonts/get-font-data font-id))
        variant (when (some? font) (fonts/get-variant font variant-id))
        url     (when (some? variant) (variant-url font variant))]
    (if (nil? url)
      (p/resolved nil)
      (or (get @cache url)
          (let [promise (-> (fetch-font url)
                            (p/then parse-font-info)
                            (p/catch (fn [cause]
                                       (log/wrn :hint "cannot read the font features"
                                                :font-id font-id
                                                :cause cause)
                                       nil)))]
            (swap! cache assoc url promise)
            promise)))))
