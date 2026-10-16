;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-proto-vars
  "zvena: Figma variables in prototypes, editor UI.

  - `action-editor*`: the options of the Set variable and Conditional
    actions, inside an interaction of the Prototype tab. The actions of
    a Conditional branch are edited with the interaction item of the
    interactions menu (passed as `item-component`, it can not be
    required from here), so they offer every action, nested
    conditionals included.
  - `visibility-binding*` (Layer section) and `text-binding*` (Text
    section): Figma's \"Apply variable\" for the layer visibility
    (boolean variables) and the text content (string and number
    variables). Each renders nothing until the file has such variables
    or the layer is bound.

  The expressions are described in app.common.types.shape.zvena-vars."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.types.shape.interactions :as ctsi]
   [app.common.types.shape.zvena-vars :as ctsv]
   [app.main.data.workspace.zvena-proto-vars :as dwpv]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.select :refer [select]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

;; --- Helpers

(defn variable-action?
  "True for the actions this namespace edits."
  [interaction]
  (contains? #{:set-variable :conditional} (:action-type interaction)))

(defn action-summary
  "The text of a Set variable / Conditional action in its pill."
  [interaction]
  (case (:action-type interaction)
    :set-variable
    (let [name (:variable interaction)]
      (if (str/blank? name)
        (tr "zvena.proto-vars.action-set-variable")
        (tr "zvena.proto-vars.summary-set-variable" name)))

    :conditional
    (let [condition (:condition interaction)]
      (if (str/blank? condition)
        (tr "zvena.proto-vars.action-conditional")
        (tr "zvena.proto-vars.summary-conditional" condition)))

    "--"))

(defn- use-variables
  "[tokens variables initial-values] of the current file (tokens of the
  active sets)."
  []
  (let [tokens    (mf/deref refs/workspace-active-theme-sets-tokens)
        variables (mf/with-memo [tokens]
                    (dwpv/variables tokens))
        values    (mf/with-memo [tokens]
                    (ctsv/resolve-token-values tokens))]
    [tokens variables values]))

(defn- error-message
  [error]
  (case error
    :unknown-variable (tr "zvena.proto-vars.unknown-variable")
    :invalid          (tr "zvena.proto-vars.invalid-expression")
    nil))

;; --- Expression input

(mf/defc expression-input*
  "Text input of an expression, committed on blur / Enter, with a select
  that appends a {variable} reference."
  {::mf/private true}
  [{:keys [value placeholder error on-change variables label]}]
  (let [input-ref (mf/use-ref nil)
        value     (or value "")

        commit
        (mf/use-fn
         (mf/deps on-change value)
         (fn [event]
           (let [new-value (dom/get-value (dom/get-target event))]
             (when (not= new-value value)
               (on-change new-value)))))

        on-key-down
        (mf/use-fn
         (fn [event]
           (when (or (kbd/enter? event) (kbd/esc? event))
             (dom/blur! (dom/get-target event)))))

        insert-variable
        (mf/use-fn
         (mf/deps on-change value)
         (fn [name]
           (when (and (string? name) (not= name ""))
             (let [node    (mf/ref-val input-ref)
                   current (str/trim (if (some? node) (dom/get-value node) value))]
               (on-change (str current
                               (when-not (str/blank? current) " ")
                               "{" name "}"))))))

        insert-options
        (mf/with-memo [variables]
          (into [{:value "" :label (tr "zvena.proto-vars.insert-variable")}]
                (map (fn [{:keys [name]}] {:value name :label name}))
                variables))]

    [:*
     [:div {:class (stl/css :row)}
      [:div {:class (stl/css :row-label)} label]
      [:div {:class (stl/css :row-control)}
       [:> input* {:key value
                   :ref input-ref
                   :type "text"
                   :class (stl/css :expression-input)
                   :default-value value
                   :placeholder placeholder
                   :aria-label label
                   :hint-message (error-message error)
                   :hint-type (when (some? error) "error")
                   :on-key-down on-key-down
                   :on-blur commit}]]]

     (when (seq variables)
       [:div {:class (stl/css :row)}
        [:div {:class (stl/css :row-extra)}
         [:& select {:key (dm/str "insert-" value)
                     :default-value ""
                     :options insert-options
                     :searchable? true
                     :search-placeholder (tr "zvena.proto-vars.insert-variable")
                     :on-change insert-variable}]]])]))

;; --- Set variable

(defn- toggle-expr
  [name]
  (dm/str "not {" name "}"))

(mf/defc boolean-value*
  "Figma's true / false value of a boolean Set variable, plus Toggle and
  a free expression."
  {::mf/private true}
  [{:keys [name expr on-change variables error]}]
  (let [custom*  (mf/use-state false)
        custom?  (deref custom*)
        expr     (or expr "")
        current  (cond
                   (= expr "true")              "true"
                   (= expr "false")             "false"
                   (= expr (toggle-expr name))  "toggle"
                   (str/blank? expr)            nil
                   :else                        "expression")

        options  [{:value "true" :label "true"}
                  {:value "false" :label "false"}
                  {:value "toggle" :label (tr "zvena.proto-vars.toggle")}
                  {:value "expression" :label (tr "zvena.proto-vars.expression")}]

        on-select
        (mf/use-fn
         (mf/deps name on-change)
         (fn [value]
           (case value
             "true"       (do (reset! custom* false) (on-change "true"))
             "false"      (do (reset! custom* false) (on-change "false"))
             "toggle"     (do (reset! custom* false) (on-change (toggle-expr name)))
             "expression" (reset! custom* true)
             nil)))]

    [:*
     [:div {:class (stl/css :row)}
      [:div {:class (stl/css :row-label)} (tr "zvena.proto-vars.value")]
      [:div {:class (stl/css :row-control)}
       [:& select {:default-value (if custom? "expression" current)
                   :options options
                   :on-change on-select}]]]
     (when (or custom? (= current "expression"))
       [:> expression-input* {:value expr
                              :label (tr "zvena.proto-vars.expression")
                              :placeholder (toggle-expr name)
                              :error error
                              :variables variables
                              :on-change on-change}])]))

(mf/defc set-variable-editor*
  {::mf/private true}
  [{:keys [interaction index update-interaction tokens variables values]}]
  (let [name     (:variable interaction)
        expr     (:value-expr interaction)
        var-type (when (string? name)
                   (dm/get-in tokens [name :type]))
        var-type (when (contains? ctsv/variable-types var-type) var-type)
        missing? (and (string? name) (nil? var-type))

        options
        (mf/with-memo [variables name missing?]
          (cond-> [{:value "" :label (tr "zvena.proto-vars.select-variable") :disabled true}]
            :always  (into (map (fn [variable]
                                  {:value (:name variable)
                                   :label (:name variable)}))
                           variables)
            missing? (conj {:value name
                            :label (tr "zvena.proto-vars.missing-variable" name)})))

        error
        (mf/with-memo [expr var-type values]
          (when (some? var-type)
            (ctsv/expression-error expr var-type values)))

        change-variable
        (mf/use-fn
         (mf/deps index update-interaction)
         (fn [value]
           (when (and (string? value) (not= value ""))
             (update-interaction index #(ctsi/set-variable % value)))))

        change-value
        (mf/use-fn
         (mf/deps index update-interaction)
         (fn [value]
           (update-interaction index #(ctsi/set-value-expr % value))))]

    [:*
     [:div {:class (stl/css :row)}
      [:div {:class (stl/css :row-label)} (tr "zvena.proto-vars.variable")]
      [:div {:class (stl/css :row-control)}
       (if (or (seq variables) missing?)
         [:& select {:default-value (or name "")
                     :options options
                     :searchable? true
                     :search-placeholder (tr "zvena.proto-vars.select-variable")
                     :on-change change-variable}]
         [:div {:class (stl/css :hint)}
          (tr "zvena.proto-vars.no-variables")])]]

     (when (and (string? name) (seq variables) (nil? var-type))
       [:div {:class (stl/css :row)}
        [:div {:class (stl/css :row-full :hint :hint-error)}
         (tr "zvena.proto-vars.unknown-variable")]])

     (case var-type
       :boolean
       [:> boolean-value* {:name name
                           :expr expr
                           :error error
                           :variables variables
                           :on-change change-value}]

       (:number :string :color)
       [:> expression-input* {:value expr
                              :label (tr "zvena.proto-vars.value")
                              :placeholder (tr "zvena.proto-vars.value-placeholder")
                              :error error
                              :variables variables
                              :on-change change-value}]

       nil)]))

;; --- Conditional

(mf/defc branch*
  "The actions of a branch (if / else) of a Conditional, edited with the
  interaction item of the interactions menu."
  {::mf/private true}
  [{:keys [interaction index branch shape update-interaction item-component]}]
  (let [actions (get interaction branch)

        update-action
        (mf/use-fn
         (mf/deps index branch update-interaction)
         (fn [position update-fn]
           (update-interaction index #(ctsi/update-branch-action % branch position update-fn))))

        remove-action
        (mf/use-fn
         (mf/deps index branch update-interaction)
         (fn [position]
           (update-interaction index #(ctsi/remove-branch-action % branch position))))

        add-action
        (mf/use-fn
         (mf/deps index branch update-interaction shape)
         (fn []
           (update-interaction
            index
            (fn [interaction]
              (ctsi/add-branch-action interaction branch
                                      (ctsi/branch-action interaction (:id shape)))))))]

    [:div {:class (stl/css :branch)}
     (for [[position action] (d/enumerate actions)]
       ;; the index is only an id for the item (its updates go to the
       ;; branch), so it is unique among all the items of the shape
       [:> item-component {:key (dm/str (name branch) "-" position)
                           :index (dm/str index "-" (name branch) "-" position)
                           :shape shape
                           :interaction action
                           :is-continuation true
                           :update-interaction (fn [_ update-fn] (update-action position update-fn))
                           :remove-interaction (fn [_] (remove-action position))}])

     [:div {:class (stl/css :row)}
      [:> button* {:variant "ghost"
                   :type "button"
                   :icon i/add
                   :class (stl/css :add-button)
                   :on-click add-action}
       (tr "zvena.proto.add-action")]]]))

(mf/defc conditional-editor*
  {::mf/private true}
  [{:keys [interaction index shape update-interaction item-component variables values]}]
  (let [condition (:condition interaction)
        has-else? (some? (:else-actions interaction))

        error
        (mf/with-memo [condition values]
          (ctsv/expression-error condition nil values))

        change-condition
        (mf/use-fn
         (mf/deps index update-interaction)
         (fn [value]
           (update-interaction index #(ctsi/set-condition % value))))

        add-else
        (mf/use-fn
         (mf/deps index update-interaction)
         (fn []
           (update-interaction index ctsi/add-else)))

        remove-else
        (mf/use-fn
         (mf/deps index update-interaction)
         (fn []
           (update-interaction index ctsi/remove-else)))]

    [:*
     [:> expression-input* {:value condition
                            :label (tr "zvena.proto-vars.if")
                            :placeholder (tr "zvena.proto-vars.condition-placeholder")
                            :error error
                            :variables variables
                            :on-change change-condition}]

     [:> branch* {:interaction interaction
                  :index index
                  :branch :then-actions
                  :shape shape
                  :update-interaction update-interaction
                  :item-component item-component}]

     (if has-else?
       [:*
        [:div {:class (stl/css :row)}
         [:div {:class (stl/css :row-label :keyword)} (tr "zvena.proto-vars.else")]
         [:div {:class (stl/css :row-control :row-end)}
          [:> icon-button* {:variant "ghost"
                            :aria-label (tr "zvena.proto-vars.remove-else")
                            :on-click remove-else
                            :icon i/remove}]]]
        [:> branch* {:interaction interaction
                     :index index
                     :branch :else-actions
                     :shape shape
                     :update-interaction update-interaction
                     :item-component item-component}]]

       [:div {:class (stl/css :row)}
        [:> button* {:variant "ghost"
                     :type "button"
                     :icon i/add
                     :class (stl/css :add-button)
                     :on-click add-else}
         (tr "zvena.proto-vars.add-else")]])]))

;; --- Action editor

(mf/defc action-editor*
  "Options of a Set variable or Conditional interaction (inside the
  interaction item of the Prototype tab). `update-interaction` is
  (fn [index update-fn]) of the item and `item-component` the
  interaction item component itself."
  [{:keys [interaction index shape update-interaction item-component]}]
  (let [[tokens variables values] (use-variables)

        ;; the actions inside a conditional with a destination are shown
        ;; in the viewer, as a top level destination is
        update-interaction
        (mf/use-fn
         (mf/deps update-interaction interaction)
         (fn [index update-fn]
           (update-interaction index update-fn)
           (when (ctsi/conditional? interaction)
             (when-let [updated (try (update-fn interaction) (catch :default _ nil))]
               (st/emit! (dwpv/show-nested-destinations updated))))))]

    [:div {:class (stl/css :editor)}
     (case (:action-type interaction)
       :set-variable
       [:> set-variable-editor* {:interaction interaction
                                 :index index
                                 :update-interaction update-interaction
                                 :tokens tokens
                                 :variables variables
                                 :values values}]

       :conditional
       [:> conditional-editor* {:interaction interaction
                                :index index
                                :shape shape
                                :update-interaction update-interaction
                                :item-component item-component
                                :variables variables
                                :values values}]
       nil)]))

;; --- Layer bindings (Design tab)

(mf/defc binding-row*
  "Figma's \"Apply variable\" for the `kind` (:visible / :text) of a layer."
  {::mf/private true}
  [{:keys [shape kind label]}]
  (let [[_ variables _] (use-variables)
        types     (get ctsv/binding-types kind)
        variables (mf/with-memo [variables types]
                    (filterv #(contains? types (:type %)) variables))
        shape-id  (:id shape)
        current   (ctsv/get-binding shape kind)
        missing?  (and (some? current)
                       (not (some #(= current (:name %)) variables)))

        options
        (mf/with-memo [variables current missing?]
          (cond-> [{:value "" :label (tr "zvena.proto-vars.apply-variable")}]
            :always  (into (map (fn [{:keys [name]}] {:value name :label name}))
                           variables)
            missing? (conj {:value current
                            :label (tr "zvena.proto-vars.missing-variable" current)})))

        on-change
        (mf/use-fn
         (mf/deps shape-id kind)
         (fn [value]
           (st/emit! (dwpv/bind-variable shape-id kind
                                         (when (and (string? value) (not= value ""))
                                           value)))))

        detach
        (mf/use-fn
         (mf/deps shape-id kind)
         (fn []
           (st/emit! (dwpv/bind-variable shape-id kind nil))))]

    (when (or (seq variables) (some? current))
      [:div {:class (stl/css :binding-row)}
       [:div {:class (stl/css :binding-label)
              :title label}
        [:> i/icon* {:icon-id i/tokens
                     :size "s"
                     :class (stl/css :binding-icon)}]
        label]
       [:div {:class (stl/css :binding-control)}
        [:& select {:default-value (or current "")
                    :options options
                    :searchable? true
                    :search-placeholder (tr "zvena.proto-vars.apply-variable")
                    :on-change on-change}]]
       (when (some? current)
         [:> icon-button* {:variant "ghost"
                           :aria-label (tr "zvena.proto-vars.detach-variable")
                           :on-click detach
                           :icon i/detach}])])))

(mf/defc visibility-binding*
  "Layer visibility bound to a boolean variable; for the Layer section
  (`ids` the selected layers: only a single layer can be bound)."
  [{:keys [ids]}]
  (let [objects (mf/deref refs/workspace-page-objects)
        shape   (when (= 1 (count ids))
                  (get objects (first ids)))]
    (when (some? shape)
      [:> binding-row* {:shape shape
                        :kind :visible
                        :label (tr "zvena.proto-vars.visibility")}])))

(mf/defc text-binding*
  "Text content bound to a string or number variable; for the Text
  section of a single text layer."
  [{:keys [shape]}]
  (let [objects (mf/deref refs/workspace-page-objects)
        shape   (get objects (:id shape))]
    (when (= :text (:type shape))
      [:> binding-row* {:shape shape
                        :kind :text
                        :label (tr "zvena.proto-vars.text-content")}])))
