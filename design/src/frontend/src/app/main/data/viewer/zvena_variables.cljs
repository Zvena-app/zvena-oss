;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.viewer.zvena-variables
  "zvena: the variables of a prototype in the viewer (Figma variables in
  prototypes).

  The variables are the boolean, string, number and color tokens of the
  active sets of the viewed file (the view-only bundle carries the
  tokens lib). Their initial values are the resolved token values; the
  layers bound to a variable resolve it with the variable modes of their
  frames (see app.main.data.workspace.tokens.zvena-modes).

  The values set while the prototype runs (Set variable) live in the
  viewer state under [:viewer :zvena-vars] ({name value}). So they are
  kept while navigating between screens and overlays, and they are
  dropped when the viewer bundle is (re)loaded, when the viewer is left
  and when the prototype restarts (`reset-variables`)."
  (:require
   [app.common.data.macros :as dm]
   [app.common.types.shape.interactions :as ctsi]
   [app.common.types.shape.zvena-vars :as ctsv]
   [app.common.types.tokens-lib :as ctob]
   [app.main.data.workspace.tokens.zvena-modes :as zvm]
   [app.main.store :as st]
   [okulary.core :as l]
   [potok.v2.core :as ptk]))

;; --- Session values

(def ^:private state-path [:viewer :zvena-vars])

(def vars-ref
  "{name value} of the variables set in this prototype session."
  (l/derived #(get-in % state-path) st/state))

(defn reset-variables
  "`state` with the variables back to their initial values."
  [state]
  (if (map? (:viewer state))
    (update state :viewer dissoc :zvena-vars)
    state))

(defn reset
  "Event: the variables back to their initial values (restart)."
  []
  (ptk/reify ::reset
    ptk/UpdateEvent
    (update [_ state]
      (reset-variables state))))

(defn set-value
  "Event: the variable `name` takes `value` for the rest of the session."
  [name value]
  (ptk/reify ::set-value
    ptk/UpdateEvent
    (update [_ state]
      (if (and (string? name)
               (some? value)
               (map? (:viewer state)))
        (update-in state state-path assoc name value)
        state))))

;; --- Initial values

(defonce ^:private cache (volatile! nil))

(defn- tokens-lib
  [state]
  (let [lib (dm/get-in state [:viewer :file :data :tokens-lib])]
    (when (ctob/tokens-lib? lib)
      lib)))

(defn- mode-entry
  "{:tokens :values} of the variables of `lib` under the mode `mode-key`
  (nil: the file-wide themes); `theme-ids` is the override chain that
  gives that mode. Cached by tokens lib and mode."
  [lib mode-key theme-ids]
  (let [entries (let [c @cache]
                  (if (and (some? c) (identical? lib (:lib c)))
                    (:entries c)
                    (do (vreset! cache {:lib lib :entries {}})
                        {})))]
    (or (get entries mode-key)
        (let [lib*   (if (and (some? lib) (some? mode-key))
                       (zvm/apply-theme-ids lib theme-ids)
                       lib)
              tokens (or (some-> lib* ctob/get-tokens-in-active-sets) {})
              entry  {:tokens tokens
                      :values (ctsv/resolve-token-values tokens)}]
          (vswap! cache assoc-in [:entries mode-key] entry)
          entry))))

(defn initial-values
  "{name value} of the variables when the prototype starts."
  ([] (initial-values @st/state))
  ([state]
   (:values (mode-entry (tokens-lib state) nil nil))))

(defn variable-type
  "The type (:boolean, :string, :number or :color) of the variable
  `name`, nil when there is none."
  [state name]
  (let [type (dm/get-in (mode-entry (tokens-lib state) nil nil) [:tokens name :type])]
    (when (contains? ctsv/variable-types type)
      type)))

(defn layer-initial-values
  "Initial values of the variables as seen from the layer `id` of
  `objects`: with the variable modes of the frames around it."
  [state objects id]
  (let [lib       (tokens-lib state)
        theme-ids (when (and (some? lib) (map? objects))
                    (zvm/layer-theme-ids objects id))
        mode-key  (when (seq theme-ids)
                    (zvm/mode-key lib theme-ids))]
    (:values (mode-entry lib mode-key theme-ids))))

(defn lookup
  "Function from a variable name to its current value (the one set in
  this session, else the initial one)."
  ([] (lookup @st/state))
  ([state]
   (let [session (get-in state state-path)
         initial (initial-values state)]
     (fn [name]
       (if (contains? session name)
         (get session name)
         (get initial name))))))

;; --- Actions

(defn set-variable!
  "Runs a Set variable interaction: its variable takes the value of its
  expression. Nothing happens when the variable does not exist or the
  value can not be computed (Figma ignores invalid expressions too)."
  [interaction]
  (let [state (deref st/state)
        name  (:variable interaction)
        type  (when (string? name) (variable-type state name))
        value (when (some? type)
                (ctsv/eval-for-type (:value-expr interaction) type (lookup state)))]
    (when (some? value)
      (st/emit! (set-value name value)))))

(defn branch-actions
  "The actions of the Conditional `interaction` to run now: its if
  actions when the condition holds, else its else actions. Actions that
  point to a missing destination are left out."
  [interaction objects]
  (let [holds?  (ctsv/eval-condition (:condition interaction) (lookup))
        actions (if holds?
                  (:then-actions interaction)
                  (:else-actions interaction))]
    (into []
          (filter (fn [action]
                    (and (map? action)
                         (let [destination (:destination action)]
                           (or (not (ctsi/has-destination action))
                               (nil? destination)
                               (contains? objects destination))))))
          actions)))
