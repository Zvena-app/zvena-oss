;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL
;;
;; zvena Design: Figma-style "Recents" — the team's recently edited files in
;; one grid (the projects list moved to "All projects").

(ns app.main.ui.dashboard.recent
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.common :as dcm]
   [app.main.data.dashboard :as dd]
   [app.main.data.dashboard.shortcuts :as sc]
   [app.main.data.event :as ev]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.dashboard.grid :refer [grid*]]
   [app.main.ui.dashboard.layout-toggle :refer [layout-toggle*]]
   [app.main.ui.hooks :as hooks]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:recent-files
  (l/derived :recent-files st/state))

(mf/defc recent-section*
  [{:keys [team default-project layout on-layout-change]}]
  (let [team-id        (get team :id)
        recent-map     (mf/deref ref:recent-files)
        can-edit?      (-> team :permissions :can-edit)
        selected-files (mf/deref refs/selected-files)

        files
        (mf/with-memo [recent-map]
          (when (some? recent-map)
            (->> (vals recent-map)
                 (sort-by :modified-at #(compare %2 %1))
                 (vec))))

        [rowref limit] (hooks/use-dynamic-grid-item-width)

        on-file-created
        (mf/use-fn
         (fn [file-data]
           (let [file-id (:id file-data)
                 page-id (get-in file-data [:pages 0])]
             (st/emit! (dcm/go-to-workspace :file-id file-id :page-id page-id)))))

        create-file
        (mf/use-fn
         (mf/deps default-project on-file-created)
         (fn [origin]
           (let [mdata  {:on-success on-file-created}
                 params {:project-id (:id default-project)}]
             (st/emit! (-> (dd/create-file (with-meta params mdata))
                           (with-meta {::ev/origin origin}))))))

        on-new-file
        (mf/use-fn
         (mf/deps create-file)
         (fn [event]
           (dom/prevent-default event)
           (create-file "dashboard:recents-header")))]

    (mf/with-effect [team-id]
      (st/emit! (dd/fetch-recent-files team-id)
                (dd/clear-selected-files)))

    (mf/with-effect []
      (dom/set-html-title (tr "blueai.dashboard.recents")))

    (hooks/use-shortcuts ::dashboard sc/shortcuts-drafts-libraries :dashboard)

    [:*
     [:header {:class (stl/css :dashboard-header)
               :data-testid "dashboard-header"}
      [:div {:class (stl/css :dashboard-title)}
       [:h1 (tr "blueai.dashboard.recents")]]
      [:div {:class (stl/css :dashboard-header-actions)}
       [:> layout-toggle* {:layout layout
                           :on-change on-layout-change}]
       (when ^boolean can-edit?
         [:button {:class (stl/css :new-file-btn)
                   :data-testid "new-file"
                   :on-click on-new-file}
          (tr "dashboard.new-file")])]]

     [:section {:class (stl/css :dashboard-container)
                :ref rowref}
      [:> grid* {:project default-project
                 :files files
                 :selected-files selected-files
                 :can-edit can-edit?
                 :origin :files
                 :create-fn create-file
                 :limit limit
                 :layout layout}]]]))
