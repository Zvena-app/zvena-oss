;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.style-editor
  "zvena: Figma's floating \"Edit style\" panel of an effect style or a
  layout grid style of the file: name, description and the values. Every
  edit is one undo step and reaches every layer of the file that uses the
  style (the files that use the library get it on their Update)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.common.types.grid :as ctg]
   [app.common.types.shape.zvena-effects :as zfx]
   [app.main.data.workspace.zvena-styles :as zst]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.workspace.sidebar.options.menus.frame-grid :refer [grid-options* lens:default-grids]]
   [app.main.ui.workspace.sidebar.options.menus.zvena-effect-rows :refer [effects-editor* add-drop-shadow]]
   [app.main.ui.workspace.zvena.style-picker :as zsp]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:editor
  (l/derived :zvena-style-editor st/state))

(def ^:private panel-width 264)

(mf/defc grid-values*
  {::mf/private true}
  [{:keys [style-id grids read-only]}]
  (let [default-grids (mf/deref lens:default-grids)
        defaults      (mf/with-memo [default-grids]
                        (merge ctg/default-grid-params default-grids))

        on-change-grid
        (mf/use-fn
         (mf/deps style-id)
         (fn [index grid]
           (st/emit! (zst/update-style-value :grid style-id #(assoc (vec %) index grid)))))

        on-remove-grid
        (mf/use-fn
         (mf/deps style-id)
         (fn [index]
           (st/emit! (zst/update-style-value :grid style-id
                                             (fn [grids]
                                               (let [grids (vec grids)]
                                                 (into (subvec grids 0 index)
                                                       (subvec grids (inc index)))))))))]
    [:div {:class (stl/css-case :values true :read-only read-only)}
     (for [[index grid] (map-indexed vector grids)]
       [:> grid-options* {:key (dm/str style-id "-" index)
                          :shape-id style-id
                          :grid grid
                          :index index
                          :frame-width 100
                          :frame-height 100
                          :default-grid-params defaults
                          :on-change-grid on-change-grid
                          :on-remove-grid on-remove-grid}])]))

(mf/defc style-editor*
  {::mf/private true}
  [{:keys [kind style-id x y]}]
  (let [data      (mf/deref refs/workspace-data)
        read-only (mf/use-ctx ctx/workspace-read-only?)
        style     (mf/with-memo [data kind style-id]
                    (zfx/get-style data kind style-id))
        panel-ref (mf/use-ref nil)

        on-close
        (mf/use-fn #(st/emit! (zst/close-style-editor)))

        on-name-commit
        (mf/use-fn
         (mf/deps kind style-id style)
         (fn [event]
           (let [value (str/trim (dom/get-target-val event))]
             (when (and (not (str/blank? value)) (not= value (:name style)))
               (st/emit! (zst/rename-style kind style-id value))))))

        on-description-commit
        (mf/use-fn
         (mf/deps kind style-id style)
         (fn [event]
           (let [value (dom/get-target-val event)]
             (when (not= value (str (:description style)))
               (st/emit! (zst/set-style-description kind style-id value))))))

        on-input-key-down
        (mf/use-fn
         (fn [event]
           (when (kbd/enter? event)
             (dom/blur! (dom/get-target event)))))

        on-key-down
        (mf/use-fn
         (mf/deps on-close)
         (fn [event]
           (when (kbd/esc? event)
             (dom/stop-propagation event)
             (on-close))))

        on-change-effects
        (mf/use-fn
         (mf/deps style-id)
         (fn [f]
           (st/emit! (zst/update-style-value :effect style-id f))))

        on-add
        (mf/use-fn
         (mf/deps kind style-id)
         (fn [_]
           (case kind
             :effect (st/emit! (zst/update-style-value :effect style-id add-drop-shadow))
             :grid   (st/emit! (zst/update-style-value :grid style-id
                                                       #(conj (vec %) (zst/default-grid)))))))

        {:keys [height]} (dom/get-window-size)
        top  (max 8 (min y (- height 420)))
        left (max 8 x)]

    ;; a deleted style (or an undone creation) closes its editor
    (mf/with-effect [style]
      (when (nil? style)
        (st/emit! (zst/close-style-editor))))

    (when (some? style)
      [:div {:class (stl/css :panel)
             :ref panel-ref
             :style {:left left :top top :width panel-width}
             :on-key-down on-key-down
             :role "dialog"
             :aria-label (tr "zvena.styles.edit-style")
             :data-testid "zvena-style-editor"}
       [:div {:class (stl/css :header)}
        [:span {:class (stl/css :header-icon)}
         [:> icon* {:icon-id (zsp/style-icon kind (:value style)) :size "s"}]]
        [:span {:class (stl/css :header-title)} (tr "zvena.styles.edit-style")]
        [:> icon-button* {:variant "ghost"
                          :icon i/close
                          :aria-label (tr "labels.close")
                          :on-click on-close}]]

       [:div {:class (stl/css :fields)}
        [:input {:key (dm/str "name-" style-id "-" (:name style))
                 :class (stl/css :name-input)
                 :type "text"
                 :default-value (:name style)
                 :read-only read-only
                 :aria-label (tr "zvena.styles.name")
                 :placeholder (tr "zvena.styles.name")
                 :on-blur on-name-commit
                 :on-key-down on-input-key-down
                 :data-testid "zvena-style-name"}]
        [:textarea {:key (dm/str "desc-" style-id)
                    :class (stl/css :description-input)
                    :default-value (str (:description style))
                    :read-only read-only
                    :rows 2
                    :aria-label (tr "zvena.styles.description")
                    :placeholder (tr "zvena.styles.description")
                    :on-blur on-description-commit}]]

       [:div {:class (stl/css :section-title)}
        [:span (case kind
                 :effect (tr "zvena.effects.title")
                 :grid   (tr "workspace.options.guides.title"))]
        (when-not read-only
          [:> icon-button* {:variant "ghost"
                            :icon i/add
                            :aria-label (case kind
                                          :effect (tr "zvena.effects.add")
                                          :grid   (tr "workspace.options.guides.add-guide"))
                            :on-click on-add
                            :data-testid "zvena-style-editor-add"}])]

       [:div {:class (stl/css :body)}
        (case kind
          :effect
          [:div {:class (stl/css-case :values true :read-only read-only)}
           [:> effects-editor* {:effects (:value style)
                                :on-change on-change-effects
                                :id-prefix (dm/str "style-" style-id)}]]
          :grid
          [:> grid-values* {:style-id style-id
                            :grids (:value style)
                            :read-only read-only}])]])))

(mf/defc style-editor-host*
  "Rendered once by the workspace: the open style editor, if any."
  []
  (let [editor (mf/deref ref:editor)]
    (when (some? editor)
      [:> style-editor* {:key (dm/str (:style-id editor))
                         :kind (:kind editor)
                         :style-id (:style-id editor)
                         :x (:x editor)
                         :y (:y editor)}])))
