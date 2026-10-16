;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.left-header
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.main.data.common :as dcm]
   [app.main.data.workspace :as dw]
   [app.main.refs :as refs]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.workspace.main-menu :as main-menu]
   ;; zvena: Figma's branching
   [app.main.ui.workspace.zvena.branches :as zbranches]
   [app.util.dom :as dom]
   [app.util.i18n :as i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

;; --- Header Component

(mf/defc left-header*
  [{:keys [file layout project class]}]
  (let [file-id     (:id file)
        file-name   (:name file)
        project-id  (:id project)
        shared?     (:is-shared file)
        persistence
        (mf/deref refs/persistence)

        ;; Nothing queued to save means the file is up to date.
        persistence-status
        (or (:status persistence) :saved)

        editing*    (mf/use-state false)
        editing?    (deref editing*)
        input-ref   (mf/use-ref nil)

        file-menu*  (mf/use-state false)
        file-menu?  (deref file-menu*)

        toggle-file-menu
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (swap! file-menu* not)))

        close-file-menu
        (mf/use-fn #(reset! file-menu* false))

        rename-from-menu
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! file-menu* false)
           (reset! editing* true)))

        toggle-sidebar
        (mf/use-fn
         #(st/emit! (dw/toggle-layout-flag :collapse-left-sidebar)))

        handle-blur
        (mf/use-fn
         (mf/deps file-id)
         (fn [_]
           (let [value (str/trim (-> input-ref mf/ref-val dom/get-value))]
             (when (not= value "")
               (st/emit! (dw/rename-file file-id value)))
             (reset! editing* false))))

        handle-name-keydown
        (mf/use-fn
         (mf/deps handle-blur)
         (fn [event]
           (when (kbd/enter? event)
             (handle-blur event))))

        start-editing-name
        (mf/use-fn
         (fn [event]
           (dom/prevent-default event)
           (reset! editing* true)))

        nav-to-project
        (mf/use-fn
         (mf/deps project-id)
         #(st/emit! :interrupt
                    (dcm/go-to-dashboard-files ::rt/new-window true :project-id project-id)))]

    (mf/with-effect [editing?]
      (when ^boolean editing?
        (dom/select-text! (mf/ref-val input-ref))))

    ;; Figma UI3 header — logo menu + panel toggle, file name with
    ;; its menu, then the project (drafts) line.
    [:header {:class (dm/str class " " (stl/css :workspace-header-left))}
     [:div {:class (stl/css :header-top)}
      [:div {:class (stl/css :menu-section)}
       [:> main-menu/menu* {:layout layout
                            :file file}]]
      [:> icon-button* {:variant "ghost"
                        :icon i/panel-left
                        :aria-label (tr "blueai.sidebar.minimize-ui")
                        :tooltip-placement "bottom"
                        :on-click toggle-sidebar}]]

     [:div {:class (stl/css :file-row)}
      (if ^boolean editing?
        [:input
         {:class (stl/css :file-name-input)
          :type "text"
          :ref input-ref
          :on-blur handle-blur
          :on-key-down handle-name-keydown
          :auto-focus true
          :default-value (:name file "")}]
        [:button
         {:class (stl/css-case :file-name true
                               :open file-menu?)
          :title file-name
          :on-click toggle-file-menu
          :on-double-click start-editing-name}
         [:span {:class (stl/css :file-name-label)} file-name]
         [:> icon* {:icon-id i/arrow-down
                    :size "s"
                    :class (stl/css :file-name-arrow)}]])
      (when ^boolean file-menu?
        [:> main-menu/file-name-menu* {:file file
                                       :on-close close-file-menu
                                       :on-rename rename-from-menu}])]

     [:div {:class (stl/css :project-row)}
      [:span
       {:class (stl/css :project-name)
        :on-click nav-to-project}
       ;; The default project is shown translated, as in the dashboard.
       (if (:is-default project) (tr "labels.drafts") (:name project))]
      (when ^boolean shared?
        [:span {:class (stl/css :shared-badge)
                :title (tr "dashboard.add-shared")}
         (tr "labels.shared-libraries")])
      ;; Persistence state widget
      [:span {:class (case persistence-status
                       :pending (stl/css :status-notification :pending-status)
                       :saving (stl/css :status-notification :saving-status)
                       :saved (stl/css :status-notification :saved-status)
                       :error (stl/css :status-notification :error-status)
                       (stl/css :status-notification))
              :title (case persistence-status
                       :pending (tr "workspace.header.saving")
                       :saving (tr "workspace.header.saving")
                       :saved (tr "workspace.header.saved")
                       :error (tr "workspace.header.save-error")
                       nil)}]]

     ;; zvena: Figma's branch badge (main / branch) and "Main file has changes"
     [:> zbranches/branch-header-row* {:file file}]]))
