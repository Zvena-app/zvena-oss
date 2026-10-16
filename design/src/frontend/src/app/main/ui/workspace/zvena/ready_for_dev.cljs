;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.ready-for-dev
  "zvena: Figma Dev Mode's \"Ready for dev\" view at the top of the left
  panel — the frames of every page of the file marked Ready for dev (or
  Completed). A click opens the frame's page, selects it and zooms to it."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.common.types.shape.zvena :as ctsz]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.zvena-devmode :as zdev]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.workspace.zvena.dev-status-badge :as zbadge :refer [dev-status-badge*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn- collect-marked
  "The top-level frames with a Dev Mode status, page by page."
  [fdata]
  (into []
        (mapcat (fn [page-id]
                  (let [page    (dm/get-in fdata [:pages-index page-id])
                        objects (:objects page)]
                    (when (some? objects)
                      (->> (vals objects)
                           (filter #(and (some? (ctsz/dev-status %))
                                         (ctsz/top-level-frame? objects %)))
                           (sort-by :name)
                           (map (fn [shape]
                                  {:id        (:id shape)
                                   :name      (:name shape)
                                   :section?  (ctsz/section? shape)
                                   :status    (ctsz/dev-status shape)
                                   :meta      (zbadge/status-meta shape)
                                   :page-id   page-id
                                   :page-name (:name page)})))))))
        (:pages fdata)))

(mf/defc ready-for-dev-list*
  {::mf/private true}
  []
  (let [fdata        (mf/deref refs/workspace-data)
        page-id      (mf/deref refs/current-page-id)
        selected     (mf/deref refs/selected-shapes)
        items        (mf/with-memo [fdata] (collect-marked fdata))

        collapsed*   (mf/use-state false)
        collapsed?   (deref collapsed*)
        filter*      (mf/use-state "ready")
        filter-by    (deref filter*)

        ready-count  (count (filter #(= "ready" (:status %)) items))
        done-count   (- (count items) ready-count)
        visible      (filterv #(= filter-by (:status %)) items)

        on-toggle
        (mf/use-fn #(swap! collapsed* not))

        on-filter
        (mf/use-fn
         (fn [event]
           (reset! filter* (dom/get-data (dom/get-current-target event) "status"))))

        on-item-click
        (mf/use-fn
         (fn [event]
           (let [node    (dom/get-current-target event)
                 id      (uuid/uuid (dom/get-data node "id"))
                 page-id (uuid/uuid (dom/get-data node "page-id"))]
             (st/emit! (zdev/go-to-shape page-id id)))))]

    [:section {:class (stl/css :ready-for-dev)
               :aria-label (tr "zvena.devmode.ready.title")}
     [:button {:class (stl/css :header)
               :aria-expanded (not collapsed?)
               :on-click on-toggle}
      [:> icon* {:icon-id (if collapsed? i/arrow-right i/arrow-down) :size "s"}]
      [:span {:class (stl/css :header-title)} (tr "zvena.devmode.ready.title")]
      [:span {:class (stl/css :header-count)} ready-count]]

     (when-not collapsed?
       [:*
        [:div {:class (stl/css :filters) :role "tablist"}
         [:button {:class (stl/css-case :filter true :active (= filter-by "ready"))
                   :role "tab"
                   :aria-selected (= filter-by "ready")
                   :data-status "ready"
                   :on-click on-filter}
          (str (tr "zvena.devmode.status.ready") " · " ready-count)]
         [:button {:class (stl/css-case :filter true :active (= filter-by "completed"))
                   :role "tab"
                   :aria-selected (= filter-by "completed")
                   :data-status "completed"
                   :on-click on-filter}
          (str (tr "zvena.devmode.status.completed") " · " done-count)]]

        (if (empty? visible)
          [:div {:class (stl/css :empty)}
           (if (= filter-by "ready")
             (tr "zvena.devmode.ready.empty")
             (tr "zvena.devmode.ready.empty-completed"))]
          [:ul {:class (stl/css :list)}
           (for [{:keys [id name status meta section?] item-page-id :page-id page-name :page-name} visible]
             [:li {:key (dm/str item-page-id "-" id)}
              [:button {:class (stl/css-case :item true
                                             :selected (and (= item-page-id page-id)
                                                            (contains? selected id)))
                        :title (if meta (dm/str name " — " meta) name)
                        :data-id (dm/str id)
                        :data-page-id (dm/str item-page-id)
                        :on-click on-item-click}
               [:> icon* {:icon-id (if section? i/section i/board) :size "s"}]
               [:span {:class (stl/css :item-name)} name]
               (when (not= item-page-id page-id)
                 [:span {:class (stl/css :item-page)} page-name])
               [:> dev-status-badge* {:status status :compact true}]]])])])]))

(mf/defc ready-for-dev*
  "Renders only in Dev Mode (Shift+D)."
  []
  (let [options-mode (mf/deref refs/options-mode-global)]
    (when (= :inspect options-mode)
      [:> ready-for-dev-list*])))
