;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-dev-status
  "zvena: Figma's \"Mark as ready for dev\" for the selected top-level frame
  or section, in the Design mode right panel. The status then shows next
  to the frame title, in the layers and in Dev Mode (Shift+D)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.types.shape.zvena :as ctsz]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.zvena-devmode :as zdev]
   [app.main.store :as st]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.workspace.zvena.dev-status-badge :as zbadge :refer [dev-status-badge*]]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(mf/defc dev-status-buttons*
  "Mark as ready / completed / clear. Shared with the Dev Mode panel."
  [{:keys [shape]}]
  (let [id     (:id shape)
        status (ctsz/dev-status shape)

        on-ready
        (mf/use-fn
         (mf/deps id)
         #(st/emit! (zdev/set-dev-status [id] "ready")))

        on-completed
        (mf/use-fn
         (mf/deps id)
         #(st/emit! (zdev/set-dev-status [id] "completed")))

        on-clear
        (mf/use-fn
         (mf/deps id)
         #(st/emit! (zdev/set-dev-status [id] nil)))]

    [:div {:class (stl/css :dev-status)}
     (when (some? status)
       [:div {:class (stl/css :status-row)}
        [:> dev-status-badge* {:status status}]
        [:span {:class (stl/css :status-meta)
                :title (zbadge/status-meta shape)}
         (zbadge/status-meta shape)]
        [:> icon-button* {:variant "ghost"
                          :aria-label (tr "zvena.devmode.status.clear")
                          :on-click on-clear
                          :icon i/remove}]])

     (if (= status "ready")
       [:button {:class (stl/css :status-button)
                 :on-click on-completed}
        [:> icon* {:icon-id i/tick :size "s"}]
        [:span (tr "zvena.devmode.mark-completed")]]
       [:button {:class (stl/css-case :status-button true
                                      :primary (nil? status))
                 :on-click on-ready}
        [:> icon* {:icon-id i/code :size "s"}]
        [:span (tr "zvena.devmode.mark-ready")]])]))

(mf/defc dev-status-menu*
  "Only for top-level frames: on the canvas or directly in a section.
  `parent` is the parent shape of `shape`."
  [{:keys [shape parent]}]
  (let [top-level? (or (nil? parent)
                       (= uuid/zero (:id parent))
                       (ctsz/section? parent))]
    (when (and (some? shape) top-level?)
      [:section {:class (stl/css :element-set)
                 :aria-label (tr "zvena.devmode.title")}
       [:div {:class (stl/css :element-title)}
        [:> title-bar* {:collapsable false
                        :title (tr "zvena.devmode.title")}]]
       [:> dev-status-buttons* {:shape shape}]])))
