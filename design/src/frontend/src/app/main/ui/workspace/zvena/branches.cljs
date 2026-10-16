;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.branches
  "zvena: Figma's branching. File menu entries (Create branch…, View
  branches, and on a branch Review and merge, Update from main, Archive
  branch), the branch row of the left header (branch badge, \"Main file
  has changes\") and the Create branch, Branches and Review and merge
  dialogs. See app.main.data.workspace.zvena-branches."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.time :as ct]
   [app.main.data.modal :as modal]
   [app.main.data.workspace.zvena-branches :as zbr :refer [t]]
   [app.main.refs :as refs]
   [app.main.render :as render]
   [app.main.store :as st]
   [app.main.ui.components.dropdown-menu :refer [dropdown-menu-item*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.util.dom :as dom]
   [app.util.i18n :as i18n]
   [app.util.keyboard :as kbd]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

;; Changed layers drawn as thumbnails (the rest show their type icon).
(def ^:private max-thumbnails 12)

;; --- Branch information

(defn- use-branch-info
  "The branch information of `file-id` (see zbr/fetch-info), loaded when
  the component mounts."
  [file-id]
  (let [info-ref (mf/with-memo [file-id]
                   (l/derived #(get-in % [:zvena-branches file-id]) st/state))
        entry    (mf/deref info-ref)]
    (mf/with-effect [file-id]
      (when (some? file-id)
        (st/emit! (zbr/fetch-info file-id))))
    (:data entry)))

(mf/defc branch-glyph*
  "The branch symbol (Figma shows it next to a branch name)."
  [{:keys [class]}]
  [:svg {:class class
         :view-box "0 0 16 16"
         :width 16
         :height 16
         :fill "none"
         :aria-hidden "true"}
   [:circle {:cx 5 :cy 3.5 :r 1.5 :stroke "currentColor" :stroke-width 1.2}]
   [:circle {:cx 5 :cy 12.5 :r 1.5 :stroke "currentColor" :stroke-width 1.2}]
   [:circle {:cx 11 :cy 5 :r 1.5 :stroke "currentColor" :stroke-width 1.2}]
   [:path {:d "M5 5v6M11 6.5c0 3-6 2.2-6 4.5"
           :stroke "currentColor"
           :stroke-width 1.2
           :stroke-linecap "round"}]])

;; --- File menu entries

(mf/defc branch-menu-items*
  "Entries of the workspace File menu. The menu's own classes come in as
  props (CSS modules are per file)."
  [{:keys [file on-close can-edit item-class name-class separator-class]}]
  (let [file-id    (:id file)
        info       (use-branch-info file-id)
        branch?    (true? (:is-branch info))
        branch     (:branch info)
        active?    (= "active" (:status branch))
        can-edit?  (and (true? can-edit) (not (false? (:can-edit info))))
        can-main?  (true? (:can-edit-main info))

        show-modal
        (mf/use-fn
         (mf/deps on-close)
         (fn [type props]
           (when (fn? on-close) (on-close))
           (st/emit! (modal/show type props))))

        on-create
        (mf/use-fn
         (mf/deps file-id file show-modal)
         #(show-modal :zvena-create-branch {:file-id file-id :file-name (:name file)}))

        on-view
        (mf/use-fn
         (mf/deps file-id show-modal)
         #(show-modal :zvena-branches {:file-id file-id}))

        on-review
        (mf/use-fn
         (mf/deps file-id branch show-modal)
         #(show-modal :zvena-review-merge {:file-id file-id
                                           :branch-id (:id branch)
                                           :mode :merge}))

        on-update
        (mf/use-fn
         (mf/deps file-id branch show-modal)
         #(show-modal :zvena-review-merge {:file-id file-id
                                           :branch-id (:id branch)
                                           :mode :update}))

        on-archive
        (mf/use-fn
         (mf/deps branch show-modal)
         #(show-modal :confirm {:title (t "zvena.branches.archive-branch")
                                :message (t "zvena.branches.archive-confirm")
                                :accept-label (t "zvena.branches.archive")
                                :accept-style :danger
                                :on-accept (fn [_] (st/emit! (zbr/archive-branch branch)))}))

        entries
        (if branch?
          (cond-> []
            (and active? can-main?)
            (conj ["file-menu-zvena-review-merge" on-review (t "zvena.branches.review-and-merge")])

            (and active? can-edit? (true? (:main-changed info)))
            (conj ["file-menu-zvena-update-from-main" on-update (t "zvena.branches.update-from-main")])

            :always
            (conj ["file-menu-zvena-view-branches" on-view (t "zvena.branches.view-branches")])

            (and active? (or can-edit? can-main?))
            (conj ["file-menu-zvena-archive-branch" on-archive (t "zvena.branches.archive-branch")]))
          (cond-> []
            can-edit?
            (conj ["file-menu-zvena-create-branch" on-create (t "zvena.branches.create-branch-ellipsis")])

            (some? info)
            (conj ["file-menu-zvena-view-branches" on-view (t "zvena.branches.view-branches")])))]

    (when (seq entries)
      [:*
       (for [[id handler label] entries]
         [:> dropdown-menu-item* {:key id
                                  :class item-class
                                  :on-click handler
                                  :on-key-down (fn [event]
                                                 (when (kbd/enter? event)
                                                   (handler)))
                                  :id id}
          [:span {:class name-class} label]])
       [:div {:class separator-class}]])))

;; --- Left header row (branch badge)

(mf/defc branch-header-row*
  "Under the file name of a branch: main / branch (Figma's branch badge,
  opens the branches) and, when main changed since the branch was
  created or updated, \"Main file has changes\" with Review and update."
  [{:keys [file]}]
  (let [file-id (:id file)
        info    (use-branch-info file-id)
        branch  (:branch info)]
    (when (and (true? (:is-branch info)) (some? branch))
      (let [status   (:status branch)
            active?  (= "active" status)
            changed? (and active?
                          (true? (:main-changed info))
                          (not (false? (:can-edit info))))
            on-badge (fn [_]
                       (st/emit! (modal/show :zvena-branches {:file-id file-id})))
            on-update (fn [_]
                        (st/emit! (modal/show :zvena-review-merge {:file-id file-id
                                                                   :branch-id (:id branch)
                                                                   :mode :update})))]
        [:div {:class (stl/css :header-row)
               :data-testid "zvena-branch-badge"}
         [:button {:class (stl/css :badge)
                   :type "button"
                   :title (t "zvena.branches.view-branches")
                   :on-click on-badge}
          [:> branch-glyph* {:class (stl/css :badge-glyph)}]
          [:span {:class (stl/css :badge-main)} (get-in info [:main :name])]
          [:span {:class (stl/css :badge-sep)} "/"]
          [:span {:class (stl/css :badge-name)} (:name branch)]]
         (when-not active?
           [:span {:class (stl/css :badge-status)}
            (if (= "merged" status)
              (t "zvena.branches.merged-banner")
              (t "zvena.branches.archived-banner"))])
         (when changed?
           [:div {:class (stl/css :main-changed)}
            [:span {:class (stl/css :main-changed-text)}
             (t "zvena.branches.main-has-changes")]
            [:button {:class (stl/css :link-button)
                      :type "button"
                      :on-click on-update}
             (t "zvena.branches.review-and-update")]])]))))

;; --- Dialog frame

(defn- close-modal!
  [& _]
  (st/emit! (modal/hide)))

(defn- on-overlay-click
  [event]
  (when (= (dom/get-target event) (dom/get-current-target event))
    (close-modal!)))

(mf/defc dialog-header*
  {::mf/private true}
  [{:keys [title subtitle]}]
  [:*
   [:div {:class (stl/css :modal-header)}
    [:> heading* {:level 2 :typography "headline-medium"} title]
    [:> icon-button* {:variant "ghost"
                      :aria-label (i18n/tr "labels.close")
                      :on-click close-modal!
                      :icon i/close
                      :class (stl/css :modal-close-btn)}]]
   (when (some? subtitle)
     [:div {:class (stl/css :subtitle)} subtitle])])

;; --- Create branch

(mf/defc create-branch-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-create-branch}
  [{:keys [file-id file-name]}]
  (let [value*  (mf/use-state "")
        value   (deref value*)
        busy*   (mf/use-state false)
        busy?   (deref busy*)
        valid?  (and (not busy?) (not (str/blank? value)))

        on-change
        (mf/use-fn
         (fn [event]
           (reset! value* (-> event dom/get-target dom/get-value))))

        on-submit
        (mf/use-fn
         (mf/deps file-id value valid?)
         (fn [event]
           (when (some? event)
             (dom/prevent-default event))
           (when valid?
             (reset! busy* true)
             (st/emit! (zbr/create-branch file-id value
                                          :on-error #(reset! busy* false))))))]

    [:div {:class (stl/css :modal-overlay)
           :on-click on-overlay-click
           :data-testid "zvena-create-branch"}
     [:form {:class (stl/css :modal-container :modal-small)
             :on-submit on-submit}
      [:> dialog-header* {:title (t "zvena.branches.create-branch")
                          :subtitle file-name}]
      [:p {:class (stl/css :hint)} (t "zvena.branches.create-hint")]
      [:label {:class (stl/css :field)}
       [:span (t "zvena.branches.branch-name")]
       [:input {:class (stl/css :input)
                :type "text"
                :value value
                :max-length 200
                :auto-focus true
                :placeholder (t "zvena.branches.branch-name-placeholder")
                :data-testid "zvena-branch-name"
                :on-change on-change}]]
      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "secondary"
                    :type "button"
                    :on-click close-modal!}
        (i18n/tr "labels.cancel")]
       [:> button* {:variant "primary"
                    :type "submit"
                    :disabled (not valid?)
                    :data-testid "zvena-create-branch-submit"}
        (if busy?
          (t "zvena.branches.creating")
          (t "zvena.branches.create"))]]]]))

;; --- Branches

(defn- row-line
  [{:keys [status created-by-name created-at merged-by-name merged-at]}]
  (if (= "merged" status)
    (t "zvena.branches.merged-by"
       (or merged-by-name (t "zvena.branches.someone"))
       (some-> (or merged-at created-at) ct/timeago))
    (t "zvena.branches.created-by"
       (or created-by-name (t "zvena.branches.someone"))
       (some-> created-at ct/timeago))))

(mf/defc branches-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-branches}
  [{:keys [file-id]}]
  (let [info     (use-branch-info file-id)
        tab*     (mf/use-state :active)
        tab      (deref tab*)
        busy*    (mf/use-state nil)
        busy     (deref busy*)
        main     (:main info)
        branches (:branches info)
        active   (filterv #(= "active" (:status %)) branches)
        archived (filterv #(not= "active" (:status %)) branches)
        rows     (if (= tab :active) active archived)
        manage?  (or (true? (:can-edit info)) (true? (:can-edit-main info)))

        on-active   (mf/use-fn #(reset! tab* :active))
        on-archived (mf/use-fn #(reset! tab* :archived))]

    [:div {:class (stl/css :modal-overlay)
           :on-click on-overlay-click
           :data-testid "zvena-branches"}
     [:div {:class (stl/css :modal-container)}
      [:> dialog-header* {:title (t "zvena.branches.branches")}]

      (when (some? main)
        [:div {:class (stl/css :main-row)}
         [:div {:class (stl/css :row-name)}
          [:span {:class (stl/css :row-title) :title (:name main)} (:name main)]
          [:span {:class (stl/css :row-sub)} (t "zvena.branches.main-file")]]
         (if (= (:id main) file-id)
           [:span {:class (stl/css :current-tag)} (t "zvena.branches.current")]
           [:> button* {:variant "secondary"
                        :on-click #(st/emit! (zbr/open-file (:id main)))}
            (t "zvena.branches.open")])])

      [:div {:class (stl/css :tabs) :role "tablist"}
       [:button {:type "button"
                 :role "tab"
                 :aria-selected (= tab :active)
                 :class (stl/css-case :tab true :tab-selected (= tab :active))
                 :on-click on-active}
        (t "zvena.branches.active")
        [:span {:class (stl/css :tab-count)} (count active)]]
       [:button {:type "button"
                 :role "tab"
                 :aria-selected (= tab :archived)
                 :class (stl/css-case :tab true :tab-selected (= tab :archived))
                 :on-click on-archived}
        (t "zvena.branches.archived")
        [:span {:class (stl/css :tab-count)} (count archived)]]]

      [:div {:class (stl/css :modal-body)}
       (cond
         (nil? info)
         [:div {:class (stl/css :empty)} (t "zvena.branches.loading")]

         (empty? rows)
         [:div {:class (stl/css :empty)}
          (if (= tab :active)
            (t "zvena.branches.no-branches")
            (t "zvena.branches.no-archived"))]

         :else
         [:ul {:class (stl/css :rows)}
          (for [{:keys [id status branch-file-id] :as row} rows]
            (let [current? (and (some? branch-file-id) (= branch-file-id file-id))
                  busy?    (= busy id)
                  done     #(reset! busy* nil)]
              [:li {:key (str id) :class (stl/css :list-row)}
               [:> branch-glyph* {:class (stl/css :list-glyph)}]
               [:div {:class (stl/css :row-name)}
                [:span {:class (stl/css :row-title) :title (:name row)} (:name row)]
                [:span {:class (stl/css :row-sub)} (row-line row)]]
               [:div {:class (stl/css :row-actions)}
                (cond
                  current?
                  [:span {:class (stl/css :current-tag)} (t "zvena.branches.current")]

                  (some? branch-file-id)
                  [:> button* {:variant "ghost"
                               :on-click #(st/emit! (zbr/open-file branch-file-id))}
                   (t "zvena.branches.open")])

                (when (and manage? (= "active" status))
                  [:> button* {:variant "ghost"
                               :disabled busy?
                               :on-click (fn []
                                           (reset! busy* id)
                                           (st/emit! (zbr/archive-branch row :on-done done)))}
                   (t "zvena.branches.archive")])

                (when (and manage? (= "archived" status))
                  [:> button* {:variant "ghost"
                               :disabled busy?
                               :on-click (fn []
                                           (reset! busy* id)
                                           (st/emit! (zbr/restore-branch row :on-done done)))}
                   (t "zvena.branches.restore")])

                (when (= "merged" status)
                  [:span {:class (stl/css :status :status-merged)}
                   (t "zvena.branches.merged")])]]))])]]]))

;; --- Review and merge / Update from main

(def ^:private ref:review
  (l/derived :zvena-branch-review st/state))

(defn- item-icon
  [{:keys [kind type]}]
  (case kind
    :page       i/document
    :page-props i/settings
    :component  i/component
    :color      i/swatches
    :typography i/text-typography
    :media      i/img
    :tokens     i/tokens
    :data       i/settings
    (case type
      :frame   i/board
      :group   i/group
      :text    i/text
      :image   i/img
      :path    i/path
      :rect    i/rectangle
      :circle  i/ellipse
      :bool    i/boolean-union
      :svg-raw i/svg
      i/board)))

(defn- item-title
  [{:keys [name kind]}]
  (if (str/blank? name)
    (or (zbr/kind-label kind) "")
    name))

(defn- item-sub
  [{:keys [kind page-name]}]
  (case kind
    :layer      page-name
    :page-props (t "zvena.branches.kind-page-props")
    (zbr/kind-label kind)))

(mf/defc item-preview*
  {::mf/private true}
  [{:keys [item objects]}]
  (let [kind (:kind item)]
    (cond
      (and (= kind :layer) (some? objects) (some? (get objects (:id item))))
      [:div {:class (stl/css :thumb)}
       [:& render/object-svg {:objects objects :object-id (:id item)}]]

      (and (= kind :color) (string? (:color item)))
      [:div {:class (stl/css :thumb :thumb-plain)}
       [:span {:class (stl/css :swatch)
               :style {:background-color (:color item)
                       :opacity (or (:opacity item) 1)}}]]

      (= kind :typography)
      [:div {:class (stl/css :thumb :thumb-text)
             :style {:font-family (:font-family item)
                     :font-style (:font-style item)}}
       "Ag"]

      :else
      [:div {:class (stl/css :thumb)}
       [:> icon* {:icon-id (item-icon item) :size "s"}]])))

(mf/defc status-badge*
  {::mf/private true}
  [{:keys [status]}]
  (when-let [label (zbr/status-label status)]
    [:span {:class (stl/css-case :status true
                                 :status-added (= status :added)
                                 :status-changed (= status :changed)
                                 :status-removed (= status :removed))}
     label]))

(mf/defc change-row*
  {::mf/private true}
  [{:keys [item status objects]}]
  [:li {:class (stl/css :row)}
   [:> item-preview* {:item item :objects objects}]
   [:div {:class (stl/css :row-name)}
    [:span {:class (stl/css :row-title) :title (:name item)} (item-title item)]
    [:span {:class (stl/css :row-sub)} (item-sub item)]]
   [:> status-badge* {:status status}]])

(mf/defc conflict-row*
  {::mf/private true}
  [{:keys [item choice on-choose objects]}]
  (let [item-key  (:key item)
        on-main   (mf/use-fn
                   (mf/deps item-key on-choose)
                   #(on-choose item-key :main))
        on-branch (mf/use-fn
                   (mf/deps item-key on-choose)
                   #(on-choose item-key :branch))
        side-line (fn [label-key status]
                    (t label-key (or (zbr/status-label status)
                                     (t "zvena.branches.status-changed"))))]
    [:li {:class (stl/css :conflict)
          :data-testid "zvena-branch-conflict"}
     [:div {:class (stl/css :row)}
      [:> item-preview* {:item item :objects objects}]
      [:div {:class (stl/css :row-name)}
       [:span {:class (stl/css :row-title) :title (:name item)} (item-title item)]
       [:span {:class (stl/css :row-sub)}
        (str (item-sub item)
             " · "
             (side-line "zvena.branches.in-main" (:main-status item))
             " · "
             (side-line "zvena.branches.in-branch" (:branch-status item)))]]]
     [:div {:class (stl/css :choice) :role "radiogroup"}
      [:button {:type "button"
                :role "radio"
                :aria-checked (= choice :main)
                :class (stl/css-case :choice-option true
                                     :choice-selected (= choice :main))
                :on-click on-main}
       (t "zvena.branches.main")]
      [:button {:type "button"
                :role "radio"
                :aria-checked (= choice :branch)
                :class (stl/css-case :choice-option true
                                     :choice-selected (= choice :branch))
                :on-click on-branch}
       (t "zvena.branches.branch")]]]))

(mf/defc review-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-review-merge}
  [{:keys [file-id branch-id mode]}]
  (let [update?    (= mode :update)
        review     (mf/deref ref:review)
        own?       (= branch-id (:branch-id review))
        status     (when own? (:status review))
        data       (when (= status :loaded) (:data review))
        conflicts  (:conflicts data)
        changes    (if update? (:main-changes data) (:changes data))
        total      (or (if update? (:main-changes-count data) (:changes-count data)) 0)
        hidden     (max 0 (- total (count changes)))
        main-count (or (:main-changes-count data) 0)

        ;; the branch is the open file: its layers draw the thumbnails of
        ;; the changes it brings (not of main's, in an update)
        local      (mf/with-memo [] (deref refs/workspace-data))
        objects-of (fn [item index]
                     (when (and (not update?)
                                (< index max-thumbnails)
                                (= :layer (:kind item))
                                (not= :removed (:branch-status item)))
                       (get-in local [:pages-index (:page-id item) :objects])))

        choices*   (mf/use-state {})
        choices    (deref choices*)
        busy*      (mf/use-state false)
        busy?      (deref busy*)

        resolved?  (every? #(contains? choices (:key %)) conflicts)
        can-submit? (and (some? data)
                         (not busy?)
                         resolved?
                         (or (pos? total) (seq conflicts)))

        on-choose
        (mf/use-fn
         (fn [item-key side]
           (swap! choices* assoc item-key side)))

        keep-all
        (mf/use-fn
         (mf/deps conflicts)
         (fn [side]
           (reset! choices* (into {} (map (fn [item] [(:key item) side])) conflicts))))

        on-retry
        (mf/use-fn
         (mf/deps branch-id)
         #(st/emit! (zbr/fetch-review branch-id)))

        on-submit
        (mf/use-fn
         (mf/deps branch-id file-id choices can-submit? update?)
         (fn []
           (when can-submit?
             (reset! busy* true)
             (if update?
               (st/emit! (zbr/update-from-main branch-id file-id choices
                                               :on-error #(reset! busy* false)))
               (st/emit! (zbr/merge-branch branch-id choices
                                           :on-error #(reset! busy* false)))))))]

    (mf/with-effect [branch-id]
      (st/emit! (zbr/fetch-review branch-id))
      (fn []
        (st/emit! (zbr/clear-review))))

    ;; a reloaded review keeps the choices of the conflicts still there
    (mf/with-effect [conflicts]
      (when (some? conflicts)
        (swap! choices* select-keys (map :key conflicts))))

    [:div {:class (stl/css :modal-overlay)
           :on-click on-overlay-click
           :data-testid "zvena-review-merge"}
     [:div {:class (stl/css :modal-container :modal-wide)}
      [:> dialog-header*
       {:title (if update?
                 (t "zvena.branches.update-from-main")
                 (t "zvena.branches.review-and-merge"))
        :subtitle (when (some? data)
                    (if update?
                      (:main-name data)
                      (t "zvena.branches.merge-into" (:name data) (:main-name data))))}]

      [:div {:class (stl/css :modal-body)}
       (case status
         :loaded
         [:*
          (when (and (not update?) (pos? main-count))
            [:p {:class (stl/css :hint)}
             (t "zvena.branches.main-changes-kept" (i18n/c main-count))])

          (when (seq conflicts)
            [:section {:class (stl/css :section)}
             [:div {:class (stl/css :section-title)}
              [:span (t "zvena.branches.resolve-conflicts")]
              [:span {:class (stl/css :section-count)} (count conflicts)]
              [:div {:class (stl/css :bulk)}
               [:button {:type "button"
                         :class (stl/css :link-button)
                         :on-click #(keep-all :main)}
                (t "zvena.branches.keep-all-main")]
               [:button {:type "button"
                         :class (stl/css :link-button)
                         :on-click #(keep-all :branch)}
                (t "zvena.branches.keep-all-branch")]]]
             [:p {:class (stl/css :section-hint)} (t "zvena.branches.conflicts-hint")]
             [:ul {:class (stl/css :rows)}
              (for [[index item] (map-indexed vector conflicts)]
                [:> conflict-row* {:key (:key item)
                                   :item item
                                   :choice (get choices (:key item))
                                   :on-choose on-choose
                                   :objects (objects-of item index)}])]])

          (if (pos? total)
            [:section {:class (stl/css :section)}
             [:div {:class (stl/css :section-title)}
              [:span (if update?
                       (t "zvena.branches.changes-from-main")
                       (t "zvena.branches.changes"))]
              [:span {:class (stl/css :section-count)} total]]
             [:ul {:class (stl/css :rows)}
              (for [[index item] (map-indexed vector changes)]
                [:> change-row* {:key (:key item)
                                 :item item
                                 :status (if update? (:main-status item) (:branch-status item))
                                 :objects (objects-of item index)}])
              (when (pos? hidden)
                [:li {:class (stl/css :row-more)}
                 (t "zvena.branches.and-more" hidden)])]]
            (when (empty? conflicts)
              [:div {:class (stl/css :empty)}
               (if update?
                 (t "zvena.branches.no-updates")
                 (t "zvena.branches.no-changes"))]))]

         :error
         [:div {:class (stl/css :empty)}
          [:span (if (= :branch-base-missing (:code review))
                   (t "zvena.branches.base-missing")
                   (t "zvena.branches.load-error"))]
          [:> button* {:variant "secondary" :on-click on-retry}
           (t "zvena.branches.retry")]]

         [:div {:class (stl/css :empty)}
          (t "zvena.branches.loading")])]

      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "secondary" :on-click close-modal!}
        (i18n/tr "labels.cancel")]
       [:> button* {:variant "primary"
                    :disabled (not can-submit?)
                    :on-click on-submit
                    :data-testid "zvena-review-merge-submit"}
        (cond
          (and busy? update?) (t "zvena.branches.updating")
          busy?               (t "zvena.branches.merging")
          update?             (t "zvena.branches.update")
          :else               (t "zvena.branches.merge-branch"))]]]]))
