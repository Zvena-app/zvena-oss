;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.library-publish
  "zvena: Figma's \"Publish library\" dialog (what changed since the last
  publish, a description, Publish) and the release notes the files that
  use a library see in Libraries → Updates. See
  app.main.data.workspace.zvena-library-publish."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.common.time :as ct]
   [app.common.types.components-list :as ctkl]
   [app.common.types.file :as ctf]
   [app.common.types.shape.zvena-effects :as zfx]
   [app.main.data.modal :as modal]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.zvena-library-publish :as zlp]
   [app.main.refs :as refs]
   [app.main.render :refer [component-svg]]
   [app.main.store :as st]
   [app.main.ui.components.color-bullet :as cb]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.workspace.zvena.style-picker :as zsp]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:publish-state
  (l/derived :zvena-library-publish st/state))

;; Rows listed per asset kind before "and N more", and how many of those
;; rows draw a component thumbnail (the rest show the component icon).
(def ^:private max-rows 40)
(def ^:private max-thumbnails 12)

(defn- format-date
  [v]
  (when (some? v)
    (ct/format-inst v :localized-date-time)))

;; --- Change rows

(mf/defc component-thumb*
  {::mf/private true}
  [{:keys [id data]}]
  (let [component (when (some? data) (ctkl/get-component data id))
        component (when (some? component) (ctf/load-component-objects data component))
        root      (when (some? component) (ctf/get-component-root data component))]
    (if (some? root)
      [:& component-svg {:root-shape root
                         :objects (:objects component)
                         :class (stl/css :thumb-svg)}]
      [:> i/icon* {:icon-id i/component :size "m" :class (stl/css :thumb-icon)}])))

(mf/defc row-preview*
  {::mf/private true}
  [{:keys [kind item data thumbnail]}]
  (let [id (:id item)]
    (case kind
      :components
      [:div {:class (stl/css :thumb)}
       (if (and thumbnail (not= :removed (:status item)))
         [:> component-thumb* {:id id :data data}]
         [:> i/icon* {:icon-id i/component :size "m" :class (stl/css :thumb-icon)}])]

      :colors
      (let [color (or (when (some? data) (get-in data [:colors id]))
                      (when (:color item)
                        {:id id :color (:color item) :opacity (or (:opacity item) 1)}))]
        [:div {:class (stl/css :thumb :thumb-color)}
         (if (some? color)
           [:> cb/color-bullet* {:color {:id id
                                         :color (:color color)
                                         :opacity (:opacity color)
                                         :gradient (:gradient color)
                                         :image (:image color)}}]
           [:span {:class (stl/css :swatch-empty)}])])

      :typographies
      (let [typo (or (when (some? data) (get-in data [:typographies id])) item)]
        [:div {:class (stl/css :thumb :thumb-text)
               :style {:font-family (:font-family typo)
                       :font-weight (:font-weight typo)
                       :font-style (:font-style typo)}}
         "Ag"])

      ;; zvena: effect / layout grid styles
      (:effect-styles :grid-styles)
      (let [skind (if (= kind :effect-styles) :effect :grid)
            style (when (some? data) (zfx/get-style data skind id))]
        [:div {:class (stl/css :thumb)}
         [:> i/icon* {:icon-id (if (some? style)
                                 (zsp/style-icon skind (:value style))
                                 (if (= skind :effect) i/effects i/grid))
                      :size "m"
                      :class (stl/css :thumb-icon)}]])

      nil)))

(defn- kind-rows
  "The rows of one asset kind: added, then changed, then removed."
  [changes kind]
  (into []
        (mapcat (fn [status]
                  (map #(assoc % :status status)
                       (get-in changes [kind status :items]))))
        zlp/statuses))

(defn- kind-count
  [changes kind]
  (reduce + 0 (map #(get-in changes [kind % :count] 0) zlp/statuses)))

(mf/defc changes-list*
  {::mf/private true}
  [{:keys [changes data]}]
  [:div {:class (stl/css :changes)}
   (for [kind zlp/kinds
         :let [total (kind-count changes kind)]
         :when (pos? total)]
     (let [rows   (kind-rows changes kind)
           shown  (take max-rows rows)
           hidden (- total (count shown))]
       [:section {:key (name kind) :class (stl/css :kind)}
        [:div {:class (stl/css :kind-title)}
         [:span (zlp/kind-label kind)]
         [:span {:class (stl/css :kind-count)} total]]
        [:ul {:class (stl/css :rows)}
         (for [[index item] (map-indexed vector shown)]
           [:li {:key (str (name (:status item)) "-" (:id item))
                 :class (stl/css :row)}
            [:> row-preview* {:kind kind
                              :item item
                              :data data
                              :thumbnail (< index max-thumbnails)}]
            [:div {:class (stl/css :row-name)}
             [:span {:class (stl/css :row-title) :title (:name item)} (:name item)]
             (when (and (:old-name item) (not= (:old-name item) (:name item)))
               [:span {:class (stl/css :row-sub)
                       :title (:old-name item)}
                (tr "zvena.library.renamed-from" (:old-name item))])]
            [:span {:class (stl/css-case :badge true
                                         :badge-added (= :added (:status item))
                                         :badge-changed (= :changed (:status item))
                                         :badge-removed (= :removed (:status item)))}
             (zlp/status-label (:status item))]])
         (when (pos? hidden)
           [:li {:class (stl/css :row-more)}
            (tr "zvena.library.and-more" hidden)])]]))])

;; --- Publish dialog (the library file)

(mf/defc publish-library-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-publish-library}
  [{:keys [file-id origin]}]
  (let [files        (mf/deref refs/files)
        file         (get files file-id)
        shared?      (true? (:is-shared file))
        ;; a snapshot of the local data when the dialog opens (thumbnails)
        data         (mf/with-memo [] (deref refs/workspace-data))
        pstate       (get (mf/deref ref:publish-state) file-id)
        status       (:status pstate)
        result       (:data pstate)
        publishing?  (true? (:publishing pstate))
        changes      (:changes result)
        total        (zlp/total-changes changes)
        first-time?  (or (not shared?) (true? (:initial changes)))
        last-publish (:last-publish result)

        description* (mf/use-state "")
        description  (deref description*)

        can-publish? (and (= status :loaded)
                          (not publishing?)
                          (or (not shared?) (pos? total)))

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

        on-description
        (mf/use-fn
         (fn [event]
           (reset! description* (-> event dom/get-target dom/get-value))))

        retry
        (mf/use-fn
         (mf/deps file-id)
         #(st/emit! (zlp/fetch-changes file-id)))

        do-publish
        (mf/use-fn
         (mf/deps file-id shared? description can-publish?)
         (fn []
           (when can-publish?
             (if shared?
               (st/emit! (zlp/publish file-id description))
               ;; first publish: the file becomes a shared library, as
               ;; Penpot's own "Publish" does, and the publish is recorded
               (st/emit! (dwl/set-file-shared file-id true)
                         (zlp/publish file-id description))))))

        on-key-down
        (mf/use-fn
         (mf/deps do-publish)
         (fn [event]
           (when (and (kbd/enter? event) (kbd/mod? event))
             (dom/prevent-default event)
             (do-publish))))]

    (mf/with-effect [file-id]
      (st/emit! (zlp/fetch-changes file-id)))

    [:div {:class (stl/css :modal-overlay)
           :on-click on-overlay-click
           :data-testid "zvena-publish-library"}
     [:div {:class (stl/css :modal-container)}
      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2 :typography "headline-medium"}
        (tr "zvena.library.publish-title")]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "labels.close")
                         :on-click close
                         :icon i/close
                         :class (stl/css :modal-close-btn)}]]

      [:div {:class (stl/css :subtitle)}
       [:span {:class (stl/css :file-name)} (:name file)]
       [:span {:class (stl/css :last-publish)}
        (cond
          (some? last-publish)
          (tr "zvena.library.last-published"
              (ct/timeago (:created-at last-publish))
              (or (:profile-name last-publish) (tr "zvena.library.someone")))

          (= status :loaded)
          (tr "zvena.library.never-published"))]]

      [:div {:class (stl/css :modal-body)}
       (case status
         :loaded
         [:*
          (when first-time?
            [:p {:class (stl/css :hint)}
             (if shared?
               (tr "zvena.library.first-publish-hint")
               (tr "zvena.library.make-library-hint"))])

          (if (pos? total)
            [:> changes-list* {:changes changes :data data}]
            [:div {:class (stl/css :empty)}
             (if shared?
               (tr "zvena.library.no-changes")
               (tr "zvena.library.empty-library"))])]

         :error
         [:div {:class (stl/css :empty)}
          [:span (tr "zvena.library.load-error")]
          [:> button* {:variant "secondary" :on-click retry}
           (tr "zvena.library.retry")]]

         [:div {:class (stl/css :empty)}
          (tr "zvena.library.loading-changes")])]

      [:label {:class (stl/css :field)}
       [:span (tr "zvena.library.description")]
       [:textarea {:class (stl/css :description)
                   :value description
                   :max-length 5000
                   :rows 3
                   :auto-focus true
                   :placeholder (tr "zvena.library.description-placeholder")
                   :on-change on-description
                   :on-key-down on-key-down}]]

      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "secondary" :on-click close}
        (tr "labels.cancel")]
       [:> button* {:variant "primary"
                    :disabled (not can-publish?)
                    :on-click do-publish
                    :data-testid "zvena-publish-library-submit"}
        (if publishing?
          (tr "zvena.library.publishing")
          (tr "zvena.library.publish"))]]]]))

;; --- Release notes (a file that uses the library)

(mf/defc publish-notes*
  "The publishes of `library-id` since `since` (the file's last sync with
  it): author, date, description and what changed."
  [{:keys [library-id file-id since]}]
  (let [notes*   (mf/use-state nil)
        notes    (deref notes*)
        since-ms (cond
                   (number? since) since
                   (inst? since)   (inst-ms since)
                   :else           nil)]

    (mf/with-effect [library-id file-id since-ms]
      (let [sub (->> (zlp/fetch-publishes library-id file-id since-ms 5)
                     (rx/subs! #(reset! notes* %)
                               (fn [_] (reset! notes* []))))]
        #(rx/dispose! sub)))

    (when (seq notes)
      [:ul {:class (stl/css :notes)
            :data-testid "zvena-library-notes"}
       (for [{:keys [id profile-name created-at description summary]} notes]
         (let [parts (zlp/summary-parts summary)]
           [:li {:key (dm/str id) :class (stl/css :note)}
            [:div {:class (stl/css :note-header)}
             [:span {:class (stl/css :note-author)}
              (or profile-name (tr "zvena.library.someone"))]
             [:span {:class (stl/css :note-date)
                     :title (format-date created-at)}
              (ct/timeago created-at)]]
            (if (str/blank? description)
              [:p {:class (stl/css :note-description :note-empty)}
               (tr "zvena.library.no-description")]
              [:p {:class (stl/css :note-description)} description])
            (when (seq parts)
              [:div {:class (stl/css :note-summary)}
               (str/join " · " parts)])]))])))
