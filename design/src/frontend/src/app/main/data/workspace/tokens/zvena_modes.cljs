;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.tokens.zvena-modes
  "zvena: Figma's variable modes applied per layer (\"Apply variable
  mode\"). Penpot's token themes play the part of Figma's modes and the
  theme groups the part of the collections.

  A frame, section, board or group may override the file-wide theme
  choice for everything inside it. The override lives in the layer's
  plugin-data (see app.common.types.shape.zvena):

    {:zvena {\"token-themes\" \"<theme-id>,<theme-id>\"}}

  Each listed theme replaces the active theme of its own group (exactly
  what activating it in the theme selector does), the other groups keep
  the file-wide choice. Overrides nest like Figma's: a layer resolves its
  tokens with the overrides of all its ancestors applied from the
  outermost to the innermost, so an inner layer wins for its groups.

  A main component only takes the overrides set on or inside it, not the
  ones of the frames around it: its values are synced to all its copies,
  so a main lying in a \"Dark\" section must not turn every copy dark (an
  override set on the main itself is copied with each new instance).

  Shapes outside any override resolve exactly as before. This namespace
  only holds the pure helpers and the token resolution; the propagation
  lives in app.main.data.workspace.tokens.propagation and the event that
  edits an override in app.main.data.workspace.tokens.zvena-variable-mode."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.types.component :as ctk]
   [app.common.types.shape.zvena :as ctsz]
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.helpers :as dsh]
   [app.main.data.style-dictionary :as sd]
   [app.main.data.tokenscript :as ts]
   [beicon.v2.core :as rx]
   [clojure.string :as str]))

(def themes-key
  "zvena plugin-data key of the variable-mode override of a layer."
  "token-themes")

(def ^:private max-depth 1000)

;; --- Reading / writing the override

(defn parse-theme-ids
  "The theme ids of a stored override value (comma separated uuids)."
  [value]
  (when (and (string? value) (not (str/blank? value)))
    (into []
          (comp (map str/trim)
                (keep uuid/parse*)
                (distinct))
          (str/split value #","))))

(defn format-theme-ids
  "The stored value of the override `ids`, nil (no override) when empty."
  [ids]
  (when (seq ids)
    (str/join "," (map str ids))))

(defn shape-theme-ids
  "The theme ids of the variable-mode override set on `shape` itself."
  [shape]
  (parse-theme-ids (ctsz/get-data shape themes-key)))

(defn layer-theme-ids
  "The theme ids of every override in effect at the layer `id` (its own
  and its ancestors' up to the main component root, if any), outermost
  first."
  [objects id]
  (loop [id  id
         acc ()
         n   0]
    (if (or (nil? id) (= id uuid/zero) (> n max-depth))
      (into [] cat acc)
      (let [shape (get objects id)
            acc   (if-let [ids (shape-theme-ids shape)]
                    (cons ids acc)
                    acc)]
        (if (ctk/main-instance? shape)
          (into [] cat acc)
          (recur (:parent-id shape) acc (inc n)))))))

(defn theme-group-theme-id
  "The theme of `group` chosen by the override `theme-ids`, if any."
  [tokens-lib theme-ids group]
  (when (some? tokens-lib)
    (d/seek (fn [id]
              (= group (:group (ctob/get-theme tokens-lib id))))
            theme-ids)))

(defn replace-group-theme
  "The override `theme-ids` with the theme of `group` replaced by
  `theme-id` (removed when nil). Ids of deleted themes are dropped."
  [tokens-lib theme-ids group theme-id]
  (let [kept (filterv (fn [id]
                        (when-let [theme (ctob/get-theme tokens-lib id)]
                          (not= group (:group theme))))
                      theme-ids)]
    (cond-> kept
      (some? theme-id) (conj theme-id))))

;; --- Themes in effect

(defn apply-theme-ids
  "`tokens-lib` with the themes `theme-ids` activated in order, each one
  replacing the active theme of its group. Mirrors what choosing those
  themes in the theme selector does (the hidden \"manual sets\" theme
  stops being active once a real theme is)."
  [tokens-lib theme-ids]
  (let [lib   (reduce ctob/activate-theme tokens-lib theme-ids)
        paths (ctob/get-active-theme-paths lib)]
    (if (or (= paths #{ctob/hidden-theme-path})
            (= lib tokens-lib))
      lib
      (ctob/set-active-themes lib (disj paths ctob/hidden-theme-path)))))

(defn mode-key
  "The set of active theme paths in effect under the override chain
  `theme-ids`; nil when it is the file-wide choice anyway."
  [tokens-lib theme-ids]
  (when (and (some? tokens-lib) (seq theme-ids))
    (let [paths (ctob/get-active-theme-paths (apply-theme-ids tokens-lib theme-ids))]
      (when (not= paths (ctob/get-active-theme-paths tokens-lib))
        paths))))

(defn layer-tokens-lib
  "`tokens-lib` as seen from the layer `id`: with the overrides of the
  layer and its ancestors applied."
  [tokens-lib objects id]
  (when (some? tokens-lib)
    (apply-theme-ids tokens-lib (layer-theme-ids objects id))))

(defn mode-tokens
  "The tokens of the active sets under the mode `mode-key`."
  [tokens-lib mode-key]
  (-> tokens-lib
      (ctob/set-active-themes mode-key)
      (ctob/get-tokens-in-active-sets)))

;; --- Index of the overridden layers of a page

(defn- page-overrides
  "{layer-id theme-ids} of the layers of `objects` that set an override."
  [objects]
  (reduce (fn [acc [id shape]]
            (if-let [ids (shape-theme-ids shape)]
              (assoc acc id ids)
              acc))
          {}
          (seq objects)))

(defn- nearest-override-id
  "The closest of `id` and its ancestors (up to the main component root,
  if any) that sets an override."
  [objects overrides id]
  (loop [id id
         n  0]
    (cond
      (or (nil? id) (> n max-depth))              nil
      (contains? overrides id)                    id
      (= id uuid/zero)                            nil
      (ctk/main-instance? (get objects id))       nil
      :else (recur (dm/get-in objects [id :parent-id]) (inc n)))))

(defn mode-index
  "{shape-id mode-key} of the shapes of `objects` (only those in `ids`
  when given) whose tokens resolve in another mode than the file-wide
  one because of an override on them or on an ancestor. An empty map
  when nothing on the page is overridden: the propagation then works
  exactly as upstream."
  ([tokens-lib objects]
   (mode-index tokens-lib objects nil))
  ([tokens-lib objects ids]
   (let [overrides (if (some? tokens-lib) (page-overrides objects) {})]
     (if (empty? overrides)
       {}
       (let [key-by-override
             (reduce-kv (fn [acc id _]
                          (assoc acc id (mode-key tokens-lib (layer-theme-ids objects id))))
                        {}
                        overrides)]
         (if (every? nil? (vals key-by-override))
           {}
           (reduce (fn [acc id]
                     (if-let [k (some->> (nearest-override-id objects overrides id)
                                         (get key-by-override))]
                       (assoc acc id k)
                       acc))
                   {}
                   (or ids (keys objects)))))))))

(defn subtree-ids
  "The layers `ids` and all their descendants."
  [objects ids]
  (into #{}
        (comp (filter #(contains? objects %))
              (mapcat #(cfh/get-children-ids-with-self objects %)))
        ids))

(defn file-mode-indexes
  "{page-id mode-index} of the pages of `fdata` that have overridden
  layers. With `scope` ({:page-id :ids}) only that page and those
  layers (and their children) are indexed."
  [tokens-lib fdata scope]
  (if (nil? tokens-lib)
    {}
    (reduce (fn [acc page-id]
              (let [objects (dm/get-in fdata [:pages-index page-id :objects])
                    ids     (when (some? scope)
                              (subtree-ids objects (:ids scope)))
                    index   (if (and (some? scope) (empty? ids))
                              {}
                              (mode-index tokens-lib objects ids))]
                (cond-> acc
                  (seq index) (assoc page-id index))))
            {}
            (if (some? scope)
              [(:page-id scope)]
              (:pages fdata)))))

;; --- Resolution

(defn resolve-tokens
  "Observable of the resolved `tokens`, the same way the file-wide
  propagation resolves them."
  [tokens]
  (if (contains? cf/flags :tokenscript)
    (rx/of (-> (ts/resolve-tokens tokens)
               (d/update-vals #(update % :resolved-value ts/tokenscript-symbols->penpot-unit))))
    (sd/resolve-tokens tokens)))

(defn resolve-modes
  "Observable of {mode-key resolved-tokens} for the `mode-keys`."
  [tokens-lib mode-keys]
  (let [mode-keys (into [] (comp (remove nil?) (distinct)) mode-keys)]
    (if (or (nil? tokens-lib) (empty? mode-keys))
      (rx/of {})
      (->> (rx/from mode-keys)
           (rx/mapcat (fn [k]
                        (->> (resolve-tokens (mode-tokens tokens-lib k))
                             (rx/map (fn [resolved] [k resolved])))))
           (rx/reduce conj {})))))

(defn apply-token-in-modes
  "Used by apply-token: an observable of the updates that give the
  shapes `shape-ids` (current page) lying inside an overridden layer the
  value `token` takes in their mode (apply-token first writes the
  file-wide value to all of them). nil when none of them is overridden."
  [state token shape-ids attributes on-update-shape]
  (when (and (fn? on-update-shape) (seq shape-ids))
    (let [tokens-lib (some-> (dsh/lookup-file-data state) (get :tokens-lib))
          objects    (dsh/lookup-page-objects state)
          index      (mode-index tokens-lib objects shape-ids)
          groups     (when (seq index)
                       (->> shape-ids
                            (filter #(contains? index %))
                            (group-by #(get index %))))]
      (when (seq groups)
        (->> (resolve-modes tokens-lib (keys groups))
             (rx/mapcat
              (fn [resolved-by-key]
                (->> groups
                     (keep (fn [[k ids]]
                             (let [value (dm/get-in resolved-by-key [k (:name token) :resolved-value])]
                               (when (some? value)
                                 (on-update-shape value (vec ids) attributes)))))
                     (map (fn [res]
                            (if (rx/observable? res) res (rx/of res))))
                     (apply rx/concat)))))))))
