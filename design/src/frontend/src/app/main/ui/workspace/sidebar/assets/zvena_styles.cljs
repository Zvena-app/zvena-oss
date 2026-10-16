;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.assets.zvena-styles
  "zvena: the effect styles and layout grid styles of a file in the Assets
  panel (the current file and each library). A click applies the style to
  the selection; the local ones are edited, duplicated and deleted from
  their context menu (double click: edit)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.zvena-styles :as zst]
   [app.main.store :as st]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.workspace.sidebar.assets.common :as cmm]
   [app.main.ui.workspace.zvena.style-picker :as zsp]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.strings :refer [matches-search]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn filter-styles
  "The styles whose name matches the search term, by name (reversed with
  the descending order)."
  [styles {:keys [term ordering]}]
  (cond->> styles
    (not (str/blank? term))
    (filter #(matches-search (:name %) term))

    :always
    (sort-by (comp str/lower :name))

    (= :desc ordering)
    (reverse)

    :always
    (vec)))

(def section-keys
  {:effect :zvena-effect-styles
   :grid   :zvena-grid-styles})

(mf/defc style-item*
  {::mf/private true}
  [{:keys [kind style file-id is-local]}]
  (let [read-only? (mf/use-ctx ctx/workspace-read-only?)
        menu*      (mf/use-state cmm/initial-context-menu-state)
        menu       (deref menu*)
        item-ref   (mf/use-ref nil)
        style-id   (:id style)

        open-editor
        (mf/use-fn
         (mf/deps kind style-id)
         (fn []
           (when-let [node (mf/ref-val item-ref)]
             (st/emit! (zst/open-style-editor kind style-id (zsp/editor-position node))))))

        on-click
        (mf/use-fn
         (mf/deps kind file-id style-id read-only?)
         (fn [_]
           (when-not read-only?
             (st/emit! (zst/apply-style-to-selection kind file-id style-id)))))

        on-double-click
        (mf/use-fn
         (mf/deps is-local read-only? open-editor)
         (fn [event]
           (when (and is-local (not read-only?))
             (dom/stop-propagation event)
             (open-editor))))

        on-context-menu
        (mf/use-fn
         (mf/deps is-local read-only?)
         (fn [event]
           (dom/prevent-default event)
           (dom/stop-propagation event)
           (when (and is-local (not read-only?))
             (swap! menu* cmm/open-context-menu (dom/get-client-position event)))))

        on-close-menu
        (mf/use-fn #(swap! menu* cmm/close-context-menu))

        on-duplicate
        (mf/use-fn
         (mf/deps kind style-id)
         #(st/emit! (zst/duplicate-style kind style-id)))

        on-delete
        (mf/use-fn
         (mf/deps kind style-id)
         #(st/emit! (zst/delete-style kind style-id)))

        options
        (mf/with-memo [open-editor on-duplicate on-delete]
          [{:name    (tr "workspace.assets.edit")
            :id      "zvena-style-edit"
            :handler open-editor}
           {:name    (tr "workspace.assets.duplicate")
            :id      "zvena-style-duplicate"
            :handler on-duplicate}
           {:name    (tr "workspace.assets.delete")
            :id      "zvena-style-delete"
            :handler on-delete}])]

    [:div {:class (stl/css :item)
           :ref item-ref
           :title (if (seq (:description style))
                    (dm/str (:name style) "\n" (:description style))
                    (:name style))
           :on-click on-click
           :on-double-click on-double-click
           :on-context-menu on-context-menu
           :data-testid (dm/str "zvena-asset-" (name kind) "-style")}
     [:span {:class (stl/css :item-icon)}
      [:> icon* {:icon-id (zsp/style-icon kind (:value style)) :size "s"}]]
     [:span {:class (stl/css :item-name)} (:name style)]
     (when is-local
       [:> cmm/assets-context-menu* {:on-close on-close-menu
                                     :state menu
                                     :options options}])]))

(mf/defc styles-section*
  "One kind of style of a file (`styles`, already filtered)."
  [{:keys [kind file-id styles is-local is-open]}]
  (let [read-only? (mf/use-ctx ctx/workspace-read-only?)

        on-create
        (mf/use-fn
         (mf/deps kind file-id)
         (fn [event]
           (dom/stop-propagation event)
           (let [node (dom/get-current-target event)
                 pos  (zsp/editor-position node)
                 ids  (into [] (dsh/get-selected-ids @st/state))]
             (st/emit! (zst/create-style kind (zsp/kind-title kind) ids
                                         (fn [style-id]
                                           (st/emit! (zst/open-style-editor kind style-id pos))))))))]

    [:> cmm/asset-section* {:file-id file-id
                            :title (zsp/kind-title kind)
                            :section (get section-keys kind)
                            :icon (if (= kind :effect) i/effects i/grid)
                            :assets-count (count styles)
                            :is-open is-open}
     (when is-local
       [:> cmm/asset-section-block* {:role :title-button}
        (when-not read-only?
          [:> icon-button* {:variant "ghost"
                            :aria-label (case kind
                                          :effect (tr "zvena.styles.create-effect")
                                          :grid   (tr "zvena.styles.create-grid"))
                            :on-click on-create
                            :icon i/add
                            :data-testid (dm/str "zvena-add-" (name kind) "-style")}])])
     [:> cmm/asset-section-block* {:role :content}
      [:div {:class (stl/css :list)}
       (for [style styles]
         [:> style-item* {:key (dm/str (:id style))
                          :kind kind
                          :style style
                          :file-id file-id
                          :is-local is-local}])]]]))
