;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-local-styles
  "zvena: the Design panel sections Figma shows when nothing is selected:
  Local variables (opens the Local variables dialog, see
  app.main.ui.workspace.zvena.variables-dialog) and Local styles (the
  file's text, color, effect and layout grid styles, grouped by folder)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.path-names :as cpn]
   [app.common.types.shape.zvena-effects :as zfx]
   [app.common.types.tokens-lib :as ctob]
   [app.main.data.modal :as modal]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.zvena-styles :as zst]
   [app.main.features :as features]
   [app.main.fonts :as fonts]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.color-bullet :as cb]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.workspace.sidebar.options.menus.typography :refer [typography-advanced-options*]]
   [app.main.ui.workspace.zvena.style-picker :as zsp]
   [app.main.ui.workspace.zvena.variables-dialog]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- group-styles
  "[[path [style ..]] ..]: top level first, then the folders by name."
  [items]
  (->> items
       (map dwl/extract-path-if-missing)
       (group-by #(or (:path %) ""))
       (sort-by key)
       (mapv (fn [[path items]]
               [path (vec (sort-by (comp str/lower str :name) items))]))))

(defn- folder-label
  [path]
  (str/join " / " (cpn/split-path path)))

;; --- Local variables

(mf/defc local-variables*
  {::mf/private true}
  []
  (let [tokens-lib (mf/deref refs/tokens-lib)
        total      (mf/with-memo [tokens-lib]
                     (if (some? tokens-lib)
                       (count (ctob/get-all-tokens-map tokens-lib))
                       0))
        open       (mf/use-fn #(st/emit! (modal/show :zvena-variables {})))]
    [:section {:class (stl/css :element-set)
               :aria-label (tr "zvena.variables.local-variables")}
     [:div {:class (stl/css :element-title)}
      [:> title-bar* {:collapsable false
                      :title (tr "zvena.variables.local-variables")}]]
     [:button {:class (stl/css :open-row)
               :type "button"
               :on-click open
               :data-testid "zvena-open-variables"}
      [:> i/icon* {:icon-id i/tokens :size "s" :class (stl/css :row-icon)}]
      [:span {:class (stl/css :row-name)} (tr "zvena.variables.open-variables")]
      (when (pos? total)
        [:span {:class (stl/css :row-meta)} total])]]))

;; --- Local styles

(mf/defc color-style-row*
  {::mf/private true}
  [{:keys [color file-id is-read-only]}]
  (let [edit-color
        (mf/use-fn
         (mf/deps color file-id)
         (fn [attrs]
           (let [name (cpn/merge-path-item (:path color) (:name color))]
             (st/emit! (dwl/update-color (-> attrs
                                             (assoc :id (:id color))
                                             (assoc :name name))
                                         file-id)))))

        on-click
        (mf/use-fn
         (mf/deps color edit-color is-read-only)
         (fn [event]
           (when-not is-read-only
             (modal/show! :colorpicker
                          {:x (.-clientX ^js event)
                           :y (.-clientY ^js event)
                           :on-accept edit-color
                           :origin :assets
                           :data color
                           :position :left}))))]
    [:div {:class (stl/css :style-row)
           :title (:name color)
           :on-click on-click
           :data-testid "zvena-color-style"}
     [:span {:class (stl/css :row-preview)}
      [:> cb/color-bullet* {:color color :mini true}]]
     [:span {:class (stl/css :row-name)} (:name color)]
     (when-not is-read-only
       [:span {:class (stl/css :row-action) :title (tr "zvena.variables.edit-style")}
        [:> i/icon* {:icon-id i/settings :size "s"}]])]))

(mf/defc text-style-row*
  {::mf/private true}
  [{:keys [typography file-id is-read-only]}]
  (let [open*      (mf/use-state false)
        open?      (deref open*)
        name-ref   (mf/use-ref nil)
        font-data  (fonts/get-font-data (:font-id typography))
        variant    (when (some? font-data)
                     (fonts/get-variant font-data (:font-variant-id typography)))
        meta-label (str (:font-size typography) " · "
                        (or (:name variant) (:font-weight typography)))

        on-change
        (mf/use-fn
         (mf/deps typography file-id)
         (fn [changes]
           (st/emit! (dwl/update-typography (merge typography changes) file-id))))

        on-name-blur
        (mf/use-fn
         (mf/deps on-change)
         (fn [event]
           (let [name (dom/get-target-val event)]
             (when-not (str/blank? name)
               (on-change {:name name})))))

        on-key-down
        (mf/use-fn
         (fn [event]
           (when (or (= "Enter" (.-key ^js event)) (= "Escape" (.-key ^js event)))
             (dom/blur! (dom/get-target event)))))

        toggle (mf/use-fn #(swap! open* not))
        close  (mf/use-fn #(reset! open* false))]

    (mf/with-effect [typography]
      (fonts/ensure-loaded! (:font-id typography)))

    [:*
     [:div {:class (stl/css :style-row)
            :title (:name typography)
            :on-click toggle
            :data-testid "zvena-text-style"}
      [:span {:class (stl/css :row-preview :text-preview)
              :style {:font-family (:font-family typography)
                      :font-weight (:font-weight typography)
                      :font-style (:font-style typography)}}
       "Ag"]
      [:span {:class (stl/css :row-name)} (:name typography)]
      [:span {:class (stl/css :row-meta)} meta-label]]
     (when open?
       [:> typography-advanced-options*
        {:is-visible true
         :typography typography
         :is-editable (not is-read-only)
         :name-input-ref name-ref
         :on-close close
         :on-change on-change
         :on-name-blur on-name-blur
         :on-key-down on-key-down
         :file-id file-id
         :is-asset? true
         :is-local true
         :navigate-to-library nil}])]))

(mf/defc zvena-style-row*
  "An effect or layout grid style: opens its editor."
  {::mf/private true}
  [{:keys [kind style is-read-only]}]
  (let [on-click
        (mf/use-fn
         (mf/deps kind style)
         (fn [event]
           (st/emit! (zst/open-style-editor kind (:id style)
                                            (zsp/editor-position (dom/get-current-target event))))))]
    [:div {:class (stl/css :style-row)
           :title (:name style)
           :on-click on-click
           :data-testid (str "zvena-" (name kind) "-style")}
     [:span {:class (stl/css :row-preview)}
      [:> i/icon* {:icon-id (zsp/style-icon kind (:value style)) :size "s"}]]
     [:span {:class (stl/css :row-name)} (:name style)]
     (when-not is-read-only
       [:span {:class (stl/css :row-action) :title (tr "zvena.variables.edit-style")}
        [:> i/icon* {:icon-id i/settings :size "s"}]])]))

(mf/defc style-groups*
  {::mf/private true}
  [{:keys [title groups render-row]}]
  [:div {:class (stl/css :style-kind)}
   [:div {:class (stl/css :kind-title)} title]
   (for [[path items] groups]
     [:div {:key (str "path-" path) :class (stl/css :style-group)}
      (when-not (str/blank? path)
        [:div {:class (stl/css :folder-title)} (folder-label path)])
      (for [item items]
        (render-row item))])])

(mf/defc local-styles*
  {::mf/private true}
  []
  (let [file-id      (mf/use-ctx ctx/current-file-id)
        read-only?   (boolean (mf/use-ctx ctx/workspace-read-only?))
        colors       (mf/deref refs/workspace-file-colors)
        typographies (mf/deref refs/workspace-file-typography)
        color-groups (mf/with-memo [colors] (group-styles (vals colors)))
        text-groups  (mf/with-memo [typographies] (group-styles (vals typographies)))
        ;; zvena: effect / layout grid styles (file plugin-data)
        plugin-data  (mf/deref refs/workspace-data)
        plugin-data  (:plugin-data plugin-data)
        effect-groups (mf/with-memo [plugin-data]
                        (group-styles (zfx/get-styles {:plugin-data plugin-data} :effect)))
        grid-groups   (mf/with-memo [plugin-data]
                        (group-styles (zfx/get-styles {:plugin-data plugin-data} :grid)))]
    (when (or (seq color-groups) (seq text-groups) (seq effect-groups) (seq grid-groups))
      [:section {:class (stl/css :element-set)
                 :aria-label (tr "zvena.variables.local-styles")}
       [:div {:class (stl/css :element-title)}
        [:> title-bar* {:collapsable false
                        :title (tr "zvena.variables.local-styles")}]]
       (when (seq text-groups)
         [:> style-groups* {:title (tr "zvena.variables.text-styles")
                            :groups text-groups
                            :render-row (fn [typography]
                                          (mf/html
                                           [:> text-style-row* {:key (str (:id typography))
                                                                :typography typography
                                                                :file-id file-id
                                                                :is-read-only read-only?}]))}])
       (when (seq color-groups)
         [:> style-groups* {:title (tr "zvena.variables.color-styles")
                            :groups color-groups
                            :render-row (fn [color]
                                          (mf/html
                                           [:> color-style-row* {:key (str (:id color))
                                                                 :color color
                                                                 :file-id file-id
                                                                 :is-read-only read-only?}]))}])
       (when (seq effect-groups)
         [:> style-groups* {:title (tr "zvena.styles.effect-styles")
                            :groups effect-groups
                            :render-row (fn [style]
                                          (mf/html
                                           [:> zvena-style-row* {:key (str (:id style))
                                                                 :kind :effect
                                                                 :style style
                                                                 :is-read-only read-only?}]))}])
       (when (seq grid-groups)
         [:> style-groups* {:title (tr "zvena.styles.grid-styles")
                            :groups grid-groups
                            :render-row (fn [style]
                                          (mf/html
                                           [:> zvena-style-row* {:key (str (:id style))
                                                                 :kind :grid
                                                                 :style style
                                                                 :is-read-only read-only?}]))}])])))

(mf/defc local-sections*
  "Rendered by the page options (nothing selected)."
  []
  (let [design-tokens? (features/use-feature "design-tokens/v1")]
    [:*
     (when design-tokens?
       [:> local-variables*])
     [:> local-styles*]]))
