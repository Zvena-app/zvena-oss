;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-variable-mode
  "zvena: Figma's \"Apply variable mode\" for the selected frame,
  section, board or group, in the Design right panel. One select per
  theme group (Figma: collection) with \"Auto\" (the mode inherited
  from the parents or the file, shown in brackets) and the group's
  themes (Figma: modes). Only shown when the file has themes. See
  app.main.data.workspace.tokens.zvena-modes for how it resolves."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.common.types.component :as ctk]
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.tokens.zvena-modes :as zvm]
   [app.main.data.workspace.tokens.zvena-variable-mode :as zvmode]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.controls.select :refer [select*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(def ^:private auto-id "auto")

(defn- inherited-theme-name
  "Name of the active theme of `group` in `tokens-lib` (the hidden
  \"manual sets\" theme does not count)."
  [tokens-lib group]
  (when (some? tokens-lib)
    (some (fn [theme]
            (when (and (= group (:group theme))
                       (not (ctob/hidden-theme? theme)))
              (:name theme)))
          (ctob/get-active-themes tokens-lib))))

(mf/defc variable-mode-row*
  {::mf/private true}
  [{:keys [ids group themes selected inherited]}]
  (let [label
        (if (= group "")
          (tr "zvena.tokens.variable-mode.ungrouped")
          group)

        options
        (mf/with-memo [themes inherited]
          (into [{:id auto-id
                  :label (if (some? inherited)
                           (tr "zvena.tokens.variable-mode.auto-named" inherited)
                           (tr "zvena.tokens.variable-mode.auto"))}]
                (map (fn [theme]
                       {:id (dm/str (:id theme))
                        :label (:name theme)}))
                themes))

        selected-id
        (if (some? selected) (dm/str selected) auto-id)

        on-change
        (mf/use-fn
         (mf/deps ids group)
         (fn [id]
           (st/emit! (zvmode/set-variable-mode ids group
                                               (when (not= id auto-id)
                                                 (uuid/parse* id))))))]

    [:div {:class (stl/css :mode-row)}
     [:span {:class (stl/css :mode-group)
             :title label}
      label]
     [:div {:class (stl/css :mode-control)}
      [:> select* {:options options
                   :default-selected selected-id
                   :aria-label label
                   :on-change on-change}]]]))

(mf/defc variable-mode-menu*
  "`shape` is the selected frame / section / board / group."
  [{:keys [shape]}]
  (let [tokens-lib (mf/deref refs/tokens-lib)
        theme-tree (mf/deref refs/workspace-token-theme-tree-no-hidden)
        objects    (mf/deref refs/workspace-page-objects)

        shape-id   (:id shape)
        parent-id  (:parent-id shape)
        ids        (mf/with-memo [shape-id] [shape-id])

        open*      (mf/use-state false)
        open?      (deref open*)

        ;; [[group [theme ..]] ..] in the library order
        groups
        (mf/with-memo [theme-tree]
          (into []
                (keep (fn [[group themes]]
                        (let [themes (vec (vals themes))]
                          (when (seq themes)
                            [group themes]))))
                theme-tree))

        own-ids
        (zvm/shape-theme-ids shape)

        applied?
        (boolean
         (and (some? tokens-lib)
              (some (fn [id] (some? (ctob/get-theme tokens-lib id))) own-ids)))

        ;; what "Auto" means here: the parents' overrides over the file's
        ;; choice (a main component ignores the overrides around it)
        main?
        (ctk/main-instance? shape)

        parent-lib
        (mf/with-memo [tokens-lib objects parent-id main?]
          (if main?
            tokens-lib
            (zvm/layer-tokens-lib tokens-lib objects parent-id)))

        on-button
        (mf/use-fn
         (mf/deps ids applied?)
         (fn [_]
           (if applied?
             (do (reset! open* false)
                 (st/emit! (zvmode/clear-variable-modes ids)))
             (swap! open* not))))

        show-rows?
        (or applied? open?)]

    ;; another layer selected: start folded again
    (mf/with-effect [shape-id]
      (reset! open* false))

    (when (and (some? shape) (some? tokens-lib) (seq groups))
      [:section {:class (stl/css :element-set)
                 :aria-label (tr "zvena.tokens.variable-mode.title")}
       [:div {:class (stl/css :element-title)}
        [:> title-bar* {:collapsable false
                        :title (tr "zvena.tokens.variable-mode.title")
                        :btn-icon (if show-rows? i/remove i/add)
                        :btn-title (cond
                                     applied? (tr "zvena.tokens.variable-mode.reset")
                                     open?    (tr "zvena.tokens.variable-mode.close")
                                     :else    (tr "zvena.tokens.variable-mode.apply"))
                        :on-btn-click on-button}]]
       (when show-rows?
         [:div {:class (stl/css :mode-rows)}
          (for [[group themes] groups]
            [:> variable-mode-row* {:key (dm/str "group-" group)
                                    :ids ids
                                    :group group
                                    :themes themes
                                    :selected (zvm/theme-group-theme-id tokens-lib own-ids group)
                                    :inherited (inherited-theme-name parent-lib group)}])])])))
