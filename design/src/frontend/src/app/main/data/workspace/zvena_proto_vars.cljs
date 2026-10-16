;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-proto-vars
  "zvena: Figma variables in prototypes, editor side.

  - The variables are the boolean, string, number and color tokens of
    the active sets (`variables`, `resolved-values`).
  - A layer binds its visibility to a boolean variable and a text its
    content to a string or number variable (Figma \"Apply variable\"),
    stored in its plugin-data (see app.common.types.shape.zvena-vars).
    Binding also gives the layer the current value of the variable, as
    Figma shows it on the canvas.
  - The Set variable and Conditional actions are edited through the
    regular interaction events; the destinations of the actions inside
    a Conditional are made visible in the viewer here."
  (:require
   [app.common.logic.shapes :as cls]
   [app.common.types.shape.interactions :as ctsi]
   [app.common.types.shape.zvena-vars :as ctsv]
   [app.common.types.text :as txt]
   [app.common.types.tokens-lib :as ctob]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.data.workspace.undo :as dwu]
   [app.main.data.workspace.wasm-text :as dwwt]
   [app.main.data.workspace.zvena-component-props :as zcp]
   [app.main.features :as features]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

;; --- Variables

(defn variables
  "[{:name :type}] of the variables among `tokens` ({name token}),
  sorted by name."
  [tokens]
  (->> (vals tokens)
       (filter #(contains? ctsv/variable-types (:type %)))
       (map (fn [token] {:name (:name token) :type (:type token)}))
       (sort-by :name)
       (vec)))

(defn active-tokens
  "{name token} of the tokens of the active sets of the current file."
  [state]
  (or (some-> (dsh/lookup-file-data state)
              (get :tokens-lib)
              (ctob/get-tokens-in-active-sets))
      {}))

;; --- Layer bindings

(defn- sync-events
  "Events that give the layer `shape` the `value` of the variable bound to
  its `kind`, as Figma shows it on the canvas."
  [state shape kind value]
  (let [id (:id shape)]
    (case kind
      :visible
      (when (and (boolean? value)
                 (not= (boolean (:hidden shape)) (not value)))
        [(dwsh/update-shape-flags [id] {:hidden (not value)})])

      :text
      (let [text (when (some? value) (ctsv/format-value value))]
        (when (and (= :text (:type shape))
                   (some? text)
                   (some? (:content shape))
                   (not= text (txt/content->text (:content shape))))
          (cond-> [(dwsh/update-shapes [id] #(update % :content txt/change-text text))]
            (features/active-feature? state "render-wasm/v1")
            (conj (dwwt/resize-wasm-text-debounce id)))))

      nil)))

(defn bind-variable
  "Binds the `kind` (:visible or :text) of the layer `id` (current page)
  to the variable `name`; a nil `name` detaches it."
  [id kind name]
  (ptk/reify ::bind-variable
    ptk/WatchEvent
    (watch [_ state _]
      (let [objects (dsh/lookup-page-objects state)
            shape   (get objects id)
            key     (get ctsv/binding-keys kind)]
        (when (and (some? shape) (some? key))
          (let [value   (when (some? name)
                          (get (ctsv/resolve-token-values (active-tokens state)) name))
                undo-id (js/Symbol)]
            (rx/from
             (-> [(dwu/start-undo-transaction undo-id)
                  (zcp/set-zvena-data [[id key name]])]
                 (into (when (some? name)
                         (sync-events state shape kind value)))
                 (conj (dwu/commit-undo-transaction undo-id))))))))))

;; --- Actions inside a Conditional

(defn- nested-destinations
  "Destinations of the actions inside the Conditional `interaction` (and
  its nested conditionals)."
  [interaction]
  (when (ctsi/conditional? interaction)
    (->> (concat (:then-actions interaction) (:else-actions interaction))
         (mapcat (fn [action]
                   (cons (when (ctsi/has-destination action)
                           (:destination action))
                         (nested-destinations action))))
         (filter uuid?))))

(defn show-nested-destinations
  "Makes the destinations of the actions inside the Conditional
  `interaction` visible in the viewer, as a top level destination is."
  [interaction]
  (ptk/reify ::show-nested-destinations
    ptk/WatchEvent
    (watch [_ state _]
      (let [objects (dsh/lookup-page-objects state)
            ids     (->> (nested-destinations interaction)
                         (filter #(contains? objects %))
                         (distinct)
                         (vec))]
        (when (seq ids)
          (rx/of (dwsh/update-shapes ids cls/show-in-viewer)))))))
