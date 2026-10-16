;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-component-props
  "zvena: Figma-like component properties (Boolean, Text, Instance swap)
  in the design tab:

  - `main-props*`: the Properties editor of a main component or variant set
    (create, rename, default value, applied layers, delete).
  - `copy-props*`: the property controls of a copy (toggle, text field,
    component picker); each change is an override of that copy.
  - `layer-binding*`: Figma's \"Apply property\" for a layer inside a main.

  Also Figma's preferred values of instance swap properties and its
  \"Expose properties from nested instances\" (the copies show the
  properties of the exposed nested instances under their own).

  Data model and events: app.main.data.workspace.zvena-component-props."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.variant :as cfv]
   [app.common.path-names :as cpn]
   [app.common.types.component :as ctk]
   [app.common.types.components-list :as ctkl]
   [app.common.types.file :as ctf]
   [app.common.types.variant :as ctv]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zvena-component-props :as zcp]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.dropdown :refer [dropdown]]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.controls.select :refer [select*]]
   [app.main.ui.ds.controls.switch :refer [switch*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.main.ui.ds.product.input-with-meta :refer [input-with-meta*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

;; --- Helpers

(defn- kind-icon
  [kind]
  (case kind
    :boolean i/switch
    :text    i/text
    :swap    i/component-copy
    i/component))

(defn- kind-label
  [kind]
  (case kind
    :boolean (tr "zvena.props.type.boolean")
    :text    (tr "zvena.props.type.text")
    :swap    (tr "zvena.props.type.swap")
    ""))

(defn- binding-label
  [kind]
  (case kind
    :boolean (tr "zvena.props.bind.boolean")
    :text    (tr "zvena.props.bind.text")
    :swap    (tr "zvena.props.bind.swap")
    ""))

(defn- component-label
  [component]
  (cpn/merge-path-item-with-dot (:path component) (:name component)))

(defn- swap-option-id
  [{:keys [file-id component-id]}]
  (str file-id "/" component-id))

(defn- parse-swap-option
  [id]
  (let [[file-id component-id] (str/split (str id) "/")]
    (zcp/parse-swap-value {:file-id file-id :component-id component-id})))

(defn- component-options
  "Options of an instance swap picker: the components of the current file
  and of its libraries, one entry per variant set (like the swap panel)."
  [libraries current-file-id]
  (->> (vals libraries)
       (mapcat (fn [file]
                 (let [data   (:data file)
                       local? (= (:id file) current-file-id)]
                   (->> (ctkl/components-seq data)
                        (remove #(cfv/is-secondary-variant? % data))
                        (map (fn [component]
                               {:id    (swap-option-id {:file-id (:id file) :component-id (:id component)})
                                :label (str (component-label component)
                                            (when-not local? (str " · " (:name file))))}))))))
       (sort-by :label)
       (vec)))

(defn- with-value-option
  "Makes sure the current value has an option (a secondary variant, a
  component of a library no longer linked...) and adds an empty entry when
  there is no value."
  [options libraries value]
  (if (nil? value)
    (into [{:id "none" :label (tr "zvena.props.no-component") :dimmed true}] options)
    (let [id (swap-option-id value)]
      (if (some #(= id (:id %)) options)
        options
        (let [component (ctf/get-component libraries (:file-id value) (:component-id value)
                                           :include-deleted? true)]
          (conj options {:id id
                         :label (if component
                                  (component-label component)
                                  (tr "zvena.props.missing-component"))}))))))

(defn- value-summary
  "Short text of a value, shown next to the property name (nil if none)."
  [kind value libraries]
  (case kind
    :boolean (if value (tr "zvena.props.true") (tr "zvena.props.false"))
    :text    (when-not (str/blank? value) value)
    :swap    (when value
               (some-> (ctf/get-component libraries (:file-id value) (:component-id value)
                                          :include-deleted? true)
                       :name))
    nil))

;; --- Controls

(mf/defc text-value-input*
  "Text field that commits on blur or Enter (Esc reverts). The parent sets a
  `:key` with the value so an external change remounts it."
  {::mf/private true}
  [{:keys [value on-commit aria-label]}]
  (let [initial-ref (mf/use-ref nil)

        on-focus
        (mf/use-fn
         (fn [event]
           ;; Compare with what the field showed, not with `value`: an input
           ;; drops the line breaks of a multi-paragraph text.
           (mf/set-ref-val! initial-ref (dom/get-target-val event))))

        on-blur
        (mf/use-fn
         (mf/deps on-commit)
         (fn [event]
           (let [initial   (mf/ref-val initial-ref)
                 new-value (dom/get-target-val event)]
             (mf/set-ref-val! initial-ref nil)
             (when (and (some? initial) (not= initial new-value))
               (if (str/blank? new-value)
                 ;; An empty text would leave an empty text layer: revert
                 (dom/set-value! (dom/get-target event) initial)
                 (on-commit new-value))))))

        on-key-down
        (mf/use-fn
         (fn [event]
           (let [node (dom/get-target event)]
             (cond
               (kbd/enter? event)
               (do (dom/stop-propagation event)
                   (dom/blur! node))

               (kbd/esc? event)
               (do (dom/stop-propagation event)
                   (dom/set-value! node (or (mf/ref-val initial-ref) ""))
                   (dom/blur! node))))))]

    [:> input* {:default-value value
                :aria-label aria-label
                :max-length 10000
                :on-focus on-focus
                :on-blur on-blur
                :on-key-down on-key-down}]))

(defn- with-preferred-options
  "Figma's preferred values: a \"Preferred\" group with them first, then the
  rest of the components."
  [options libraries preferred]
  (if (empty? preferred)
    options
    (let [by-id     (into {} (map (juxt :id identity)) options)
          pref-ids  (into #{} (map swap-option-id) preferred)
          pref-opts (mapv (fn [value]
                            (let [id (swap-option-id value)]
                              (or (get by-id id)
                                  {:id id
                                   :label (or (some-> (ctf/get-component libraries (:file-id value) (:component-id value)
                                                                         :include-deleted? true)
                                                      (component-label))
                                              (tr "zvena.props.missing-component"))})))
                          preferred)]
      (-> [{:type :group :name (tr "zvena.props.preferred.group")}]
          (into pref-opts)
          (conj {:type :group :name (tr "zvena.props.all-components")})
          (into (remove #(contains? pref-ids (:id %))) options)))))

(mf/defc swap-select*
  {::mf/private true}
  [{:keys [value options preferred libraries on-change]}]
  (let [options  (mf/with-memo [options libraries value preferred]
                   (-> (with-preferred-options options libraries preferred)
                       (with-value-option libraries value)))
        selected (if (some? value) (swap-option-id value) "none")

        on-select
        (mf/use-fn
         (mf/deps on-change)
         (fn [id]
           (when-let [new-value (parse-swap-option id)]
             (on-change new-value))))]

    [:> select* {:options options
                 :default-selected selected
                 :key selected
                 :on-change on-select}]))

(mf/defc add-prop-button*
  "The \"+\" of the Properties header, with the property type menu."
  {::mf/private true}
  [{:keys [on-add]}]
  (let [open* (mf/use-state false)
        open? (deref open*)

        on-toggle
        (mf/use-fn
         (mf/deps open?)
         (fn [event]
           (dom/stop-propagation event)
           (reset! open* (not open?))))

        on-close
        (mf/use-fn #(reset! open* false))

        on-select
        (mf/use-fn
         (mf/deps on-add)
         (fn [event]
           (dom/stop-propagation event)
           (let [kind (-> (dom/get-current-target event)
                          (dom/get-data "kind")
                          (keyword))]
             (reset! open* false)
             (on-add kind))))]

    [:div {:class (stl/css :add-wrapper)}
     [:> icon-button* {:variant "ghost"
                       :aria-label (tr "zvena.props.add")
                       :on-click on-toggle
                       :icon i/add}]
     [:& dropdown {:show open?
                   :on-close on-close}
      [:ul {:class (stl/css :add-dropdown)}
       (for [kind zcp/kinds]
         [:li {:key (name kind)
               :class (stl/css :add-dropdown-item)
               :data-kind (name kind)
               :on-click on-select}
          [:> icon* {:icon-id (kind-icon kind)
                     :size "s"}]
          [:span (kind-label kind)]])]]]))

;; --- Preferred values (instance swap)

(mf/defc preferred-item*
  {::mf/private true}
  [{:keys [owner-id prop-id value libraries]}]
  (let [on-remove
        (mf/use-fn
         (mf/deps owner-id prop-id value)
         #(st/emit! (zcp/remove-preferred owner-id prop-id value)))]
    [:li {:class (stl/css :preferred-item)}
     [:> icon* {:icon-id i/component
                :size "s"
                :class (stl/css :preferred-icon)}]
     [:span {:class (stl/css :preferred-name)}
      (or (value-summary :swap value libraries)
          (tr "zvena.props.missing-component"))]
     [:> icon-button* {:variant "ghost"
                       :aria-label (tr "zvena.props.preferred.remove")
                       :on-click on-remove
                       :icon i/remove}]]))

(mf/defc preferred-editor*
  "The preferred values of an instance swap property of a main: the list,
  with a picker to add components."
  {::mf/private true}
  [{:keys [owner-id prop swap-options libraries]}]
  (let [prop-id   (:id prop)
        preferred (:preferred prop)
        options   (mf/with-memo [swap-options preferred]
                    (let [pref-ids (into #{} (map swap-option-id) preferred)]
                      (into [{:id "none" :label (tr "zvena.props.preferred.add") :dimmed true}]
                            (remove #(contains? pref-ids (:id %)))
                            swap-options)))

        on-add
        (mf/use-fn
         (mf/deps owner-id prop-id)
         (fn [id]
           (when-let [value (parse-swap-option id)]
             (st/emit! (zcp/add-preferred owner-id prop-id value)))))]

    [:div {:class (stl/css :preferred)}
     (if (empty? preferred)
       [:div {:class (stl/css :editor-hint)}
        (tr "zvena.props.preferred.empty")]
       [:ul {:class (stl/css :preferred-list)}
        (for [value preferred]
          [:> preferred-item* {:key (swap-option-id value)
                               :owner-id owner-id
                               :prop-id prop-id
                               :value value
                               :libraries libraries}])])
     ;; Remounted after each change, so it shows "Add" again
     [:> select* {:options options
                  :default-selected "none"
                  :key (dm/str prop-id "-" (count preferred))
                  :on-change on-add}]]))

;; --- Main component / variant set

(mf/defc layer-check*
  {::mf/private true}
  [{:keys [owner-id prop layer label]}]
  (let [kind     (:type prop)
        prop-id  (:id prop)
        layer-id (:id layer)
        checked? (= prop-id (zcp/get-binding layer kind))

        on-change
        (mf/use-fn
         (mf/deps owner-id layer-id kind prop-id checked?)
         (fn [_]
           (st/emit! (zcp/bind-layer owner-id layer-id kind (when-not checked? prop-id)))))]

    [:> checkbox* {:id (dm/str "zvena-prop-" prop-id "-" layer-id)
                   :label label
                   :checked checked?
                   :on-change on-change}]))

(mf/defc main-prop-row*
  {::mf/private true}
  [{:keys [owner-id prop layers objects libraries swap-options is-variant-set is-expanded on-toggle-expand]}]
  (let [prop-id   (:id prop)
        kind      (:type prop)
        prop-name (:name prop)
        bound     (zcp/bound-layers layers prop)
        value     (zcp/current-value prop bound)
        summary   (value-summary kind value libraries)
        eligible  (filterv #(zcp/eligible? kind %) layers)

        on-rename
        (mf/use-fn
         (mf/deps owner-id prop-id prop-name)
         (fn [event]
           (let [name (str/trim (dom/get-target-val event))]
             (when (and (not (str/blank? name)) (not= name prop-name))
               (st/emit! (zcp/rename-prop owner-id prop-id name))))))

        on-delete
        (mf/use-fn
         (mf/deps owner-id prop-id)
         #(st/emit! (zcp/delete-prop owner-id prop-id)))

        on-expand
        (mf/use-fn
         (mf/deps prop-id on-toggle-expand)
         #(on-toggle-expand prop-id))

        on-default
        (mf/use-fn
         (mf/deps owner-id prop-id)
         (fn [value]
           (st/emit! (zcp/set-prop-default owner-id prop-id value))))]

    [:div {:class (stl/css :prop)}
     [:div {:class (stl/css :prop-row)}
      [:span {:class (stl/css :prop-icon)
              :title (kind-label kind)}
       [:> icon* {:icon-id (kind-icon kind)
                  :size "s"}]]
      [:div {:class (stl/css :prop-name)}
       (if (some? summary)
         [:> input-with-meta* {:value prop-name
                               :meta summary
                               :max-length zcp/max-name-length
                               :on-blur on-rename}]
         [:> input-with-meta* {:value prop-name
                               :max-length zcp/max-name-length
                               :on-blur on-rename}])]
      [:> icon-button* {:variant "ghost"
                        :aria-label (tr "zvena.props.edit")
                        :on-click on-expand
                        :icon (if is-expanded i/arrow-down i/arrow-right)}]
      [:> icon-button* {:variant "ghost"
                        :aria-label (tr "zvena.props.delete")
                        :on-click on-delete
                        :icon i/remove}]]

     (when is-expanded
       [:div {:class (stl/css :prop-editor)}
        [:div {:class (stl/css :editor-label)}
         (tr "zvena.props.default")]
        (case kind
          :boolean
          [:div {:class (stl/css :editor-switch)}
           [:> switch* {:default-checked (boolean value)
                        :on-change on-default}]]

          :text
          [:> text-value-input* {:key (dm/str prop-id "-" value)
                                 :value (or value "")
                                 :aria-label (tr "zvena.props.default")
                                 :on-commit on-default}]

          :swap
          [:> swap-select* {:value value
                            :options swap-options
                            :libraries libraries
                            :on-change on-default}]
          nil)

        ;; zvena: Figma's preferred values of an instance swap property
        (when (= kind :swap)
          [:*
           [:div {:class (stl/css :editor-label)}
            (tr "zvena.props.preferred")]
           [:> preferred-editor* {:owner-id owner-id
                                  :prop prop
                                  :swap-options swap-options
                                  :libraries libraries}]])

        [:div {:class (stl/css :editor-label)}
         (tr "zvena.props.applied-to")]
        (if (empty? eligible)
          [:div {:class (stl/css :editor-hint)}
           (tr "zvena.props.no-layers")]
          [:div {:class (stl/css :layer-list)}
           (for [layer eligible]
             (let [root  (when is-variant-set (zcp/find-main-root objects (:id layer)))
                   label (if root
                           (dm/str (:name root) " / " (:name layer))
                           (:name layer))]
               [:> layer-check* {:key (dm/str (:id layer))
                                 :owner-id owner-id
                                 :prop prop
                                 :layer layer
                                 :label label}]))])])]))

(mf/defc expose-check*
  {::mf/private true}
  [{:keys [owner-id layer label]}]
  (let [layer-id (:id layer)
        checked? (zcp/exposed? layer)

        on-change
        (mf/use-fn
         (mf/deps owner-id layer-id checked?)
         (fn [_]
           (st/emit! (zcp/set-exposed owner-id layer-id (not checked?)))))]

    [:> checkbox* {:id (dm/str "zvena-expose-" layer-id)
                   :label label
                   :checked checked?
                   :on-change on-change}]))

(mf/defc main-props*
  "Properties section of a main component root, of a variant main (the
  definitions are the ones of its variant set) or of a variant container."
  [{:keys [shape]}]
  (let [objects         (mf/deref refs/workspace-page-objects)
        libraries       (mf/deref refs/libraries)
        current-file-id (mf/use-ctx ctx/current-file-id)

        owner-id        (zcp/defs-owner-id shape)
        owner           (get objects owner-id)
        variant-set?    (ctk/is-variant-container? owner)

        defs            (mf/with-memo [objects owner]
                          (if owner (zcp/owner-defs objects owner) []))
        layers          (mf/with-memo [objects owner]
                          (if owner (zcp/owner-layers objects owner) []))
        nested          (mf/with-memo [objects owner]
                          (if owner (zcp/nested-instances objects owner) []))
        has-swap?       (some #(= :swap (:type %)) defs)
        swap-options    (mf/with-memo [libraries current-file-id has-swap?]
                          (if has-swap? (component-options libraries current-file-id) []))

        expanded*       (mf/use-state nil)
        expanded        (deref expanded*)

        on-add
        (mf/use-fn
         (mf/deps owner-id)
         (fn [kind]
           (let [prop-id (str (uuid/next))]
             (reset! expanded* prop-id)
             (st/emit! (zcp/add-prop owner-id kind {:prop-id prop-id})))))

        on-toggle-expand
        (mf/use-fn
         (fn [prop-id]
           (swap! expanded* #(if (= % prop-id) nil prop-id))))]

    (when (some? owner)
      [:div {:class (stl/css :props)}
       [:div {:class (stl/css :props-header)}
        [:span {:class (stl/css :props-title)}
         (tr "zvena.props.title")]
        [:> add-prop-button* {:on-add on-add}]]

       (if (empty? defs)
         [:div {:class (stl/css :props-empty)}
          (tr "zvena.props.empty")]
         [:div {:class (stl/css :prop-list)}
          (for [prop defs]
            [:> main-prop-row* {:key (:id prop)
                                :owner-id owner-id
                                :prop prop
                                :layers layers
                                :objects objects
                                :libraries libraries
                                :swap-options swap-options
                                :is-variant-set variant-set?
                                :is-expanded (= expanded (:id prop))
                                :on-toggle-expand on-toggle-expand}])])

       ;; zvena: Figma's "Expose properties from nested instances"
       (when (seq nested)
         [:div {:class (stl/css :nested-section)}
          [:div {:class (stl/css :editor-label)}
           (tr "zvena.props.nested.title")]
          [:div {:class (stl/css :layer-list)}
           (for [layer nested]
             (let [root  (when variant-set? (zcp/find-main-root objects (:id layer)))
                   label (if root
                           (dm/str (:name root) " / " (:name layer))
                           (:name layer))]
               [:> expose-check* {:key (dm/str (:id layer))
                                  :owner-id owner-id
                                  :layer layer
                                  :label label}]))]])])))

;; --- Copy

(mf/defc copy-prop-row*
  {::mf/private true}
  [{:keys [copy-id select-id prop layers libraries swap-options]}]
  (let [prop-id (:id prop)
        kind    (:type prop)
        value   (zcp/current-value prop layers)

        on-change
        (mf/use-fn
         (mf/deps copy-id prop-id select-id)
         (fn [value]
           (st/emit! (zcp/set-copy-value copy-id prop-id value select-id))))]

    [:div {:class (stl/css :value-row)}
     [:div {:class (stl/css :value-name)
            :title (:name prop)}
      (:name prop)]
     (case kind
       :boolean
       [:div {:class (stl/css :value-switch)}
        [:> switch* {:default-checked (boolean value)
                     :aria-label (:name prop)
                     :on-change on-change}]]

       :text
       [:div {:class (stl/css :value-control)}
        [:> text-value-input* {:key (dm/str prop-id "-" value)
                               :value (or value "")
                               :aria-label (:name prop)
                               :on-commit on-change}]]

       :swap
       [:div {:class (stl/css :value-control)}
        [:> swap-select* {:value value
                          :options swap-options
                          :preferred (:preferred prop)
                          :libraries libraries
                          :on-change on-change}]]
       nil)]))

(defn- variant-options
  "Options of a variant property of a copy (as in the component section)."
  [prop-name prop-vals]
  (->> prop-vals
       (d/seek #(= (:name %) prop-name))
       :value
       (mapv (fn [val]
               {:id val
                :label (if (str/blank? val) (str "(" (tr "labels.empty") ")") val)}))))

(mf/defc nested-variant-row*
  {::mf/private true}
  [{:keys [copy-id nested-id pos prop prop-vals]}]
  (let [options (mf/with-memo [prop-vals prop]
                  (variant-options (:name prop) prop-vals))
        pair    (ctv/find-boolean-pair (mapv :id options))
        value   (:value prop)

        on-select
        (mf/use-fn
         (mf/deps copy-id nested-id pos)
         (fn [new-value]
           (st/emit! (zcp/switch-nested-variant copy-id nested-id pos new-value))))

        on-toggle
        (mf/use-fn
         (mf/deps pair on-select)
         (fn [checked]
           (when-let [new-value (get (d/invert-map pair) checked)]
             (on-select new-value))))]

    (when (seq options)
      [:div {:class (stl/css :value-row)}
       [:div {:class (stl/css :value-name)
              :title (:name prop)}
        (:name prop)]
       (if (some? pair)
         [:div {:class (stl/css :value-switch)}
          [:> switch* {:default-checked (get pair value)
                       :aria-label (:name prop)
                       :key (dm/str value)
                       :on-change on-toggle}]]
         [:div {:class (stl/css :value-control)}
          [:> select* {:options options
                       :default-selected value
                       :key (dm/str value)
                       :on-change on-select}]])])))

(mf/defc nested-props*
  "An exposed nested instance in the Properties section of its parent
  copy: its variant properties and its own properties, edited on the
  nested copy while the parent copy stays selected."
  {::mf/private true}
  [{:keys [copy-id nested entries depth files libraries swap-options]}]
  (let [nested-id  (:id nested)
        component  (mf/with-memo [files nested]
                     (ctf/get-component files (:component-file nested) (:component-id nested)
                                        :include-deleted? true))
        variant?   (and (ctk/is-variant? component) (not (:deleted component)))
        fdata      (dm/get-in files [(:component-file nested) :data])
        mobjects   (when variant?
                     (dm/get-in fdata [:pages-index (:main-instance-page component) :objects]))
        variant-id (:variant-id component)
        prop-vals  (mf/with-memo [fdata mobjects variant-id]
                     (when (some? mobjects)
                       (cfv/extract-properties-values fdata mobjects variant-id)))

        on-select
        (mf/use-fn
         (mf/deps nested-id)
         #(st/emit! (dws/select-shapes (d/ordered-set nested-id))))]

    (when (or (seq entries) variant?)
      [:div {:class (stl/css :nested)
             :style {:padding-inline-start (dm/str (* 8 depth) "px")}}
       [:button {:class (stl/css :nested-title)
                 :title (tr "zvena.props.nested.select")
                 :on-click on-select}
        [:> icon* {:icon-id i/component-copy
                   :size "s"
                   :class (stl/css :value-name-icon)}]
        [:span {:class (stl/css :nested-name)}
         (:name nested)]]

       (when variant?
         (for [[pos prop] (map-indexed vector (:variant-properties component))]
           [:> nested-variant-row* {:key (dm/str nested-id "-" pos)
                                    :copy-id copy-id
                                    :nested-id nested-id
                                    :pos pos
                                    :prop prop
                                    :prop-vals prop-vals}]))

       (for [{:keys [prop layers]} entries]
         [:> copy-prop-row* {:key (:id prop)
                             :copy-id nested-id
                             :select-id copy-id
                             :prop prop
                             :layers layers
                             :libraries libraries
                             :swap-options swap-options}])])))

(defn- has-swap-entry?
  [entries]
  (some #(= :swap (dm/get-in % [:prop :type])) entries))

(defn- nested-shown?
  "Does the exposed nested instance have anything to show (its own
  properties or variant properties)?"
  [files {:keys [shape entries]}]
  (or (seq entries)
      (let [component (ctf/get-component files (:component-file shape) (:component-id shape)
                                         :include-deleted? true)]
        (and (ctk/is-variant? component) (not (:deleted component))))))

(mf/defc copy-props*
  "Property controls of a copy (instance) of a component with properties,
  followed by the ones of its exposed nested instances."
  [{:keys [shape]}]
  (let [objects         (mf/deref refs/workspace-page-objects)
        ;; All the loaded files (to follow references through libraries),
        ;; the linked libraries for the component picker
        files           (mf/deref refs/files)
        libraries       (mf/deref refs/libraries)
        current-file-id (mf/use-ctx ctx/current-file-id)

        entries         (mf/with-memo [files objects shape]
                          (zcp/copy-context files objects shape))
        exposed         (mf/with-memo [files objects shape]
                          (filterv (partial nested-shown? files)
                                   (zcp/exposed-context files objects shape)))
        has-swap?       (or (has-swap-entry? entries)
                            (some #(has-swap-entry? (:entries %)) exposed))
        swap-options    (mf/with-memo [libraries current-file-id has-swap?]
                          (if has-swap? (component-options libraries current-file-id) []))]

    (when (or (seq entries) (seq exposed))
      [:div {:class (stl/css :props)}
       [:div {:class (stl/css :props-header)}
        [:span {:class (stl/css :props-title)}
         (tr "zvena.props.title")]]
       (when (seq entries)
         [:div {:class (stl/css :prop-list)}
          (for [{:keys [prop layers]} entries]
            [:> copy-prop-row* {:key (:id prop)
                                :copy-id (:id shape)
                                :prop prop
                                :layers layers
                                :libraries libraries
                                :swap-options swap-options}])])
       (for [{nested :shape nested-entries :entries depth :depth} exposed]
         [:> nested-props* {:key (dm/str (:id nested))
                            :copy-id (:id shape)
                            :nested nested
                            :entries nested-entries
                            :depth depth
                            :files files
                            :libraries libraries
                            :swap-options swap-options}])])))

;; --- Layer inside a main

(mf/defc binding-row*
  {::mf/private true}
  [{:keys [kind owner-id layer defs]}]
  (let [layer-id (:id layer)
        options  (-> [{:id "none" :label (tr "zvena.props.not-applied") :dimmed true}]
                     (into (comp (filter #(= kind (:type %)))
                                 (map (fn [prop] {:id (:id prop) :label (:name prop)})))
                           defs)
                     (conj {:id "new" :label (tr "zvena.props.create")}))
        current  (zcp/get-binding layer kind)
        ;; A binding to a property that no longer exists shows as not applied
        current  (if (some #(= current (:id %)) options) current "none")

        on-change
        (mf/use-fn
         (mf/deps owner-id layer-id kind)
         (fn [id]
           (cond
             (= id "none") (st/emit! (zcp/bind-layer owner-id layer-id kind nil))
             (= id "new")  (st/emit! (zcp/add-prop owner-id kind {:layer-id layer-id}))
             :else         (st/emit! (zcp/bind-layer owner-id layer-id kind id)))))]

    [:div {:class (stl/css :value-row)}
     [:div {:class (stl/css :value-name)
            :title (binding-label kind)}
      [:> icon* {:icon-id (kind-icon kind)
                 :size "s"
                 :class (stl/css :value-name-icon)}]
      (binding-label kind)]
     [:div {:class (stl/css :value-control)}
      [:> select* {:options options
                   :default-selected current
                   :key (dm/str layer-id "-" (name kind) "-" current)
                   :on-change on-change}]]]))

(mf/defc expose-row*
  "Figma's \"Expose properties\" switch of a nested instance of a main."
  {::mf/private true}
  [{:keys [owner-id layer]}]
  (let [layer-id (:id layer)
        exposed? (zcp/exposed? layer)

        on-change
        (mf/use-fn
         (mf/deps owner-id layer-id)
         (fn [checked]
           (st/emit! (zcp/set-exposed owner-id layer-id checked))))]

    [:div {:class (stl/css :value-row)}
     [:div {:class (stl/css :value-name)
            :title (tr "zvena.props.nested.expose")}
      [:> icon* {:icon-id i/component-copy
                 :size "s"
                 :class (stl/css :value-name-icon)}]
      (tr "zvena.props.nested.expose")]
     [:div {:class (stl/css :value-switch)}
      [:> switch* {:default-checked exposed?
                   :aria-label (tr "zvena.props.nested.expose")
                   :on-change on-change}]]]))

(mf/defc layer-binding*
  "Figma's \"Apply property\" for a single selected layer inside a main:
  binds its visibility (Boolean), its text (Text) or, for a nested
  instance, the instance shown (Instance swap) to a property of the main,
  or creates the property from the layer. Renders nothing for other
  shapes, so it can be placed in the options of any shape type."
  [{:keys [shape]}]
  (let [objects  (mf/deref refs/workspace-page-objects)
        selected (mf/deref refs/selected-shapes)
        shape-id (:id shape)
        layer    (get objects shape-id)
        context  (mf/with-memo [objects shape-id]
                   (zcp/binding-context objects shape-id))]

    (when (and (some? context)
               (some? layer)
               (= 1 (count selected)))
      (let [owner (:owner context)
            defs  (:defs context)]
        [:div {:class (stl/css :props :binding)}
         [:div {:class (stl/css :props-header)}
          [:span {:class (stl/css :props-title)}
           (tr "zvena.props.binding-title")]]
         [:div {:class (stl/css :prop-list)}
          (for [kind zcp/kinds :when (zcp/eligible? kind layer)]
            [:> binding-row* {:key (name kind)
                              :kind kind
                              :owner-id (:id owner)
                              :layer layer
                              :defs defs}])
          ;; zvena: a nested instance can expose its properties
          (when (ctk/instance-head? layer)
            [:> expose-row* {:owner-id (:id owner)
                             :layer layer}])]]))))
