;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.library-analytics
  "zvena: Figma's library analytics dialog: how the components and styles
  of a library are used (instances, inserts and detachments over the last
  30 days, the files that use it). See
  app.main.data.workspace.zvena-library-analytics."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.main.data.modal :as modal]
   [app.main.data.workspace.zvena-library-analytics :as zla]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:analytics
  (l/derived :zvena-library-analytics st/state))

;; --- Chart

(mf/defc timeline-chart*
  "Inserts (up) and detachments (down) per day."
  {::mf/private true}
  [{:keys [timeline]}]
  (let [days   (count timeline)
        top    (max 1 (reduce max 0 (map :inserts timeline)))
        bottom (max 1 (reduce max 0 (map :detaches timeline)))
        width  480
        height 96
        mid    (* height (/ top (+ top bottom)))
        bar-w  (/ width (max 1 days))]
    [:svg {:class (stl/css :chart)
           :view-box (dm/str "0 0 " width " " height)
           :preserve-aspect-ratio "none"
           :role "img"
           :aria-label (tr "zvena.analytics.chart")}
     [:line {:x1 0 :x2 width :y1 mid :y2 mid :class (stl/css :chart-axis)}]
     (for [[idx {:keys [day inserts detaches]}] (map-indexed vector timeline)]
       (let [x  (+ (* idx bar-w) 1)
             w  (max 1 (- bar-w 2))
             hi (* mid (/ inserts top))
             hd (* (- height mid) (/ detaches bottom))]
         [:g {:key day}
          [:title (dm/str day ": " (tr "zvena.analytics.inserts") " " inserts
                          ", " (tr "zvena.analytics.detachments") " " detaches)]
          (when (pos? inserts)
            [:rect {:x x :y (- mid hi) :width w :height hi
                    :class (stl/css :bar-insert)}])
          (when (pos? detaches)
            [:rect {:x x :y mid :width w :height hd
                    :class (stl/css :bar-detach)}])]))]))

;; --- Tables

(defn- sort-rows
  [rows sort-key]
  (let [k (or sort-key :instances)]
    (if (= k :name)
      (sort-by (comp str/lower :name) rows)
      (sort-by (juxt (comp - #(get % k 0)) (comp str/lower :name)) rows))))

(defn- filter-rows
  [rows term]
  (let [term (str/lower (str/trim (or term "")))]
    (if (str/empty? term)
      rows
      (filter #(str/includes? (str/lower (:name %)) term) rows))))

(mf/defc header-cell*
  {::mf/private true}
  [{:keys [label sort-id current on-sort numeric]}]
  (let [on-click (mf/use-fn
                  (mf/deps sort-id on-sort)
                  #(on-sort sort-id))]
    [:th {:class (stl/css-case :numeric numeric)
          :aria-sort (if (= sort-id current) "descending" "none")}
     [:button {:type "button"
               :class (stl/css-case :sort-button true
                                    :sorted (= sort-id current))
               :on-click on-click}
      label]]))

(mf/defc components-table*
  {::mf/private true}
  [{:keys [components term]}]
  (let [sort* (mf/use-state :instances)
        sort  (deref sort*)
        rows  (mf/with-memo [components term sort]
                (-> components (filter-rows term) (sort-rows sort)))
        on-sort (mf/use-fn #(reset! sort* %))]
    (if (empty? rows)
      [:div {:class (stl/css :empty)}
       (if (seq components)
         (tr "zvena.analytics.no-match")
         (tr "zvena.analytics.no-components"))]
      [:table {:class (stl/css :table) :data-testid "zvena-analytics-components"}
       [:thead
        [:tr
         [:> header-cell* {:label (tr "zvena.analytics.name") :sort-id :name
                           :current sort :on-sort on-sort}]
         [:> header-cell* {:label (tr "zvena.analytics.instances") :sort-id :instances
                           :current sort :on-sort on-sort :numeric true}]
         [:> header-cell* {:label (tr "zvena.analytics.inserts") :sort-id :inserts
                           :current sort :on-sort on-sort :numeric true}]
         [:> header-cell* {:label (tr "zvena.analytics.detachments") :sort-id :detaches
                           :current sort :on-sort on-sort :numeric true}]]]
       [:tbody
        (for [{:keys [id name instances files inserts detaches]} rows]
          [:tr {:key (dm/str id)}
           [:td {:class (stl/css :name-cell)}
            [:> i/icon* {:icon-id i/component :size "s" :class (stl/css :row-icon)}]
            [:span {:class (stl/css :row-name) :title name} name]]
           [:td {:class (stl/css :numeric)
                 :title (tr "zvena.analytics.in-files" files)}
            instances]
           [:td {:class (stl/css :numeric)} inserts]
           [:td {:class (stl/css :numeric)} detaches]])]])))

(mf/defc styles-table*
  {::mf/private true}
  [{:keys [colors typographies term]}]
  (let [sort* (mf/use-state :uses)
        sort  (deref sort*)
        rows  (mf/with-memo [colors typographies term sort]
                (-> (concat (map #(assoc % :kind :color) colors)
                            (map #(assoc % :kind :typography) typographies))
                    (filter-rows term)
                    (sort-rows sort)))
        on-sort (mf/use-fn #(reset! sort* %))]
    (if (empty? rows)
      [:div {:class (stl/css :empty)}
       (if (or (seq colors) (seq typographies))
         (tr "zvena.analytics.no-match")
         (tr "zvena.analytics.no-styles"))]
      [:table {:class (stl/css :table) :data-testid "zvena-analytics-styles"}
       [:thead
        [:tr
         [:> header-cell* {:label (tr "zvena.analytics.name") :sort-id :name
                           :current sort :on-sort on-sort}]
         [:> header-cell* {:label (tr "zvena.analytics.uses") :sort-id :uses
                           :current sort :on-sort on-sort :numeric true}]
         [:> header-cell* {:label (tr "zvena.analytics.files") :sort-id :files
                           :current sort :on-sort on-sort :numeric true}]]]
       [:tbody
        (for [{:keys [id name kind color uses files]} rows]
          [:tr {:key (dm/str id)}
           [:td {:class (stl/css :name-cell)}
            (if (= kind :color)
              [:span {:class (stl/css :swatch)
                      :style {:background-color (or color "transparent")}}]
              [:> i/icon* {:icon-id i/text-typography :size "s" :class (stl/css :row-icon)}])
            [:span {:class (stl/css :row-name) :title name} name]]
           [:td {:class (stl/css :numeric)} uses]
           [:td {:class (stl/css :numeric)} files]])]])))

(mf/defc files-list*
  {::mf/private true}
  [{:keys [files files-total]}]
  (let [hidden (max 0 (- files-total (count files)))]
    [:div {:class (stl/css :files)}
     [:div {:class (stl/css :section-title)} (tr "zvena.analytics.files-using")]
     [:ul {:class (stl/css :files-list)}
      (for [{:keys [id name instances library?]} files]
        [:li {:key (dm/str id) :class (stl/css :file-row)}
         [:span {:class (stl/css :row-name) :title name}
          name
          (when library?
            [:span {:class (stl/css :file-badge)} (tr "zvena.analytics.this-library")])]
         [:span {:class (stl/css :numeric)}
          (tr "zvena.analytics.n-instances" instances)]])
      (when (pos? hidden)
        [:li {:class (stl/css :file-row :muted)}
         (tr "zvena.analytics.other-files" hidden)])]]))

;; --- Dialog

(mf/defc library-analytics-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-library-analytics}
  [{:keys [library-id file-id origin]}]
  (let [entry   (get (mf/deref ref:analytics) library-id)
        status  (:status entry)
        data    (:data entry)
        tab*    (mf/use-state :components)
        tab     (deref tab*)
        term*   (mf/use-state "")
        term    (deref term*)

        components (:components data)
        totals  (mf/with-memo [components]
                  {:instances (reduce + 0 (map :instances components))
                   :inserts   (reduce + 0 (map :inserts components))
                   :detaches  (reduce + 0 (map :detaches components))})

        close
        (mf/use-fn
         (mf/deps file-id origin)
         (fn []
           (if (= origin "libraries")
             (st/emit! (modal/show :libraries-dialog {:file-id file-id}))
             (st/emit! (modal/hide)))))

        on-overlay-click
        (mf/use-fn
         (mf/deps close)
         (fn [event]
           (when (= (dom/get-target event) (dom/get-current-target event))
             (close))))

        retry
        (mf/use-fn
         (mf/deps library-id file-id)
         #(st/emit! (zla/fetch-analytics library-id file-id)))

        on-tab
        (mf/use-fn
         (fn [event]
           (reset! tab* (keyword (dom/get-data (dom/get-current-target event) "tab")))))

        on-term
        (mf/use-fn
         (fn [event]
           (reset! term* (-> event dom/get-target dom/get-value))))]

    (mf/with-effect [library-id file-id]
      (st/emit! (zla/fetch-analytics library-id file-id)))

    [:div {:class (stl/css :modal-overlay)
           :on-click on-overlay-click
           :data-testid "zvena-library-analytics"}
     [:div {:class (stl/css :modal-container)
            :role "dialog"
            :aria-label (tr "zvena.analytics.title")}
      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2 :typography "headline-medium"}
        (tr "zvena.analytics.title")]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "labels.close")
                         :on-click close
                         :icon i/close
                         :class (stl/css :modal-close-btn)}]]

      [:div {:class (stl/css :subtitle)}
       [:span {:class (stl/css :file-name)} (:name data)]
       (when (= status :loaded)
         [:span (tr "zvena.analytics.used-in" (:files-total data) (:period-days data))])]

      (case status
        :loaded
        [:div {:class (stl/css :modal-body)}
         [:div {:class (stl/css :stats)}
          [:div {:class (stl/css :stat)}
           [:span {:class (stl/css :stat-value)} (:instances totals)]
           [:span {:class (stl/css :stat-label)} (tr "zvena.analytics.instances")]]
          [:div {:class (stl/css :stat)}
           [:span {:class (stl/css :stat-value :insert)} (:inserts totals)]
           [:span {:class (stl/css :stat-label)} (tr "zvena.analytics.inserts")]]
          [:div {:class (stl/css :stat)}
           [:span {:class (stl/css :stat-value :detach)} (:detaches totals)]
           [:span {:class (stl/css :stat-label)} (tr "zvena.analytics.detachments")]]
          [:div {:class (stl/css :stat)}
           [:span {:class (stl/css :stat-value)} (:files-total data)]
           [:span {:class (stl/css :stat-label)} (tr "zvena.analytics.files")]]]

         [:> timeline-chart* {:timeline (:timeline data)}]

         [:div {:class (stl/css :toolbar)}
          [:div {:class (stl/css :tabs) :role "tablist"}
           [:button {:type "button" :role "tab"
                     :aria-selected (= tab :components)
                     :class (stl/css-case :tab true :tab-active (= tab :components))
                     :data-tab "components"
                     :on-click on-tab}
            (tr "zvena.analytics.components")]
           [:button {:type "button" :role "tab"
                     :aria-selected (= tab :styles)
                     :class (stl/css-case :tab true :tab-active (= tab :styles))
                     :data-tab "styles"
                     :on-click on-tab}
            (tr "zvena.analytics.styles")]
           [:button {:type "button" :role "tab"
                     :aria-selected (= tab :files)
                     :class (stl/css-case :tab true :tab-active (= tab :files))
                     :data-tab "files"
                     :on-click on-tab}
            (tr "zvena.analytics.files")]]
          (when (not= tab :files)
            [:input {:class (stl/css :search)
                     :type "search"
                     :value term
                     :placeholder (tr "zvena.analytics.search")
                     :aria-label (tr "zvena.analytics.search")
                     :on-change on-term}])]

         [:div {:class (stl/css :table-wrap)}
          (case tab
            :styles [:> styles-table* {:colors (:colors data)
                                       :typographies (:typographies data)
                                       :term term}]
            :files  [:> files-list* {:files (:files data)
                                     :files-total (:files-total data)}]
            [:> components-table* {:components components :term term}])]]

        :error
        [:div {:class (stl/css :empty)}
         [:span (tr "zvena.analytics.load-error")]
         [:> button* {:variant "secondary" :on-click retry}
          (tr "zvena.library.retry")]]

        [:div {:class (stl/css :empty)} (tr "zvena.analytics.loading")])]]))

(defn open-analytics
  "Opens the analytics of `library-id` from the file `file-id`."
  [library-id file-id origin]
  (modal/show :zvena-library-analytics
              (d/without-nils {:library-id library-id
                               :file-id file-id
                               :origin origin})))
