;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.viewer.share-link
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.logging :as log]
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.common :as dc]
   [app.main.data.event :as ev]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.refs :as refs]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.components.select :refer [select]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.controls.switch :refer [switch*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.main.ui.icons :as deprecated-icon]
   [app.util.clipboard :as clipboard]
   [app.util.dom :as dom]
   [app.util.i18n :as i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(log/set-level! :warn)

(defn- prepare-params
  [{:keys [pages who-comment who-inspect]}]
  {:pages pages
   :who-comment who-comment
   :who-inspect who-inspect})

;; --- zvena: link settings (Figma: who can view, password, expiry)

(def ^:private zv-day-ms (* 24 60 60 1000))

(def ^:private zv-password-min-length 4)

(def ^:private zv-default-draft
  "Settings of a link that is not created yet."
  {:who-view "all"
   :password-on false
   :password ""
   :expires "never"
   :custom ""})

(defn- zv-expires-at
  "The instant a value of the Expires select stands for; nil = never."
  [preset custom]
  (case preset
    "1d"     (js/Date. (+ (js/Date.now) zv-day-ms))
    "7d"     (js/Date. (+ (js/Date.now) (* 7 zv-day-ms)))
    "30d"    (js/Date. (+ (js/Date.now) (* 30 zv-day-ms)))
    "custom" (let [date (when-not (str/blank? custom)
                          (js/Date. custom))]
               (when (and (some? date)
                          (not (js/isNaN (.getTime date)))
                          (> (.getTime date) (js/Date.now)))
                 date))
    nil))

(defn- zv-valid-password?
  [password]
  (and (string? password)
       (>= (count password) zv-password-min-length)))

(defn- zv-format-date
  [date]
  (dm/str (ct/format-inst date "PP") ", " (ct/format-inst date "p")))

(defn- zv-expired?
  [{:keys [expires-at]}]
  (and (some? expires-at)
       (<= (.getTime expires-at) (js/Date.now))))

(defn- zv-draft-valid?
  [{:keys [who-view password-on password expires custom]}]
  (or (= who-view "team")
      (and (or (not password-on) (zv-valid-password? password))
           (or (not= expires "custom") (some? (zv-expires-at expires custom))))))

(defn- zv-draft->params
  "Create-link params for the settings of a new link."
  [{:keys [who-view password-on password expires custom]}]
  (let [expires-at (zv-expires-at expires custom)]
    (cond-> {:who-view who-view}
      (and (= who-view "all") password-on (zv-valid-password? password))
      (assoc :password password)

      (and (= who-view "all") (some? expires-at))
      (assoc :expires-at expires-at))))

(defn- zv-expires-options
  [slink]
  (let [expires-at (:expires-at slink)]
    (cond-> []
      (some? expires-at)
      (conj {:value "current"
             :label (if (zv-expired? slink)
                      (tr "zvena.share.expired-on" (zv-format-date expires-at))
                      (tr "zvena.share.expires-on" (zv-format-date expires-at)))})

      :always
      (into [{:value "never" :label (tr "zvena.share.expires.never")}
             {:value "1d" :label (tr "zvena.share.expires.1d")}
             {:value "7d" :label (tr "zvena.share.expires.7d")}
             {:value "30d" :label (tr "zvena.share.expires.30d")}
             {:value "custom" :label (tr "zvena.share.expires.custom")}]))))

(mf/defc zv-link-status*
  "Lock / expiry / access state shown under an existing link."
  {::mf/private true}
  [{:keys [slink]}]
  (let [expires-at (:expires-at slink)
        expired?   (zv-expired? slink)
        team?      (= "team" (:who-view slink))]
    (when (or team? (:has-password slink) (some? expires-at))
      [:div {:class (stl/css :zv-link-status)}
       (if team?
         [:span {:class (stl/css :zv-status-item)}
          [:> icon* {:icon-id i/lock :size "s"}]
          (tr "zvena.share.status.team-only")]
         [:*
          (when (:has-password slink)
            [:span {:class (stl/css :zv-status-item)}
             [:> icon* {:icon-id i/lock :size "s"}]
             (tr "zvena.share.status.password")])
          (when (some? expires-at)
            [:span {:class (stl/css-case :zv-status-item true
                                         :zv-status-expired expired?)}
             [:> icon* {:icon-id i/clock :size "s"}]
             (if expired?
               (tr "zvena.share.expired-on" (zv-format-date expires-at))
               (tr "zvena.share.expires-on" (zv-format-date expires-at)))])])])))

(mf/defc zv-link-settings*
  "Who can view, Password and Expires. For an existing link every change
  is saved at once (passwords and custom dates with Save); for a new link
  the values go into `draft` and are sent with Get link."
  {::mf/private true}
  [{:keys [slink draft on-draft-change]}]
  (let [existing?    (some? slink)
        link-id      (:id slink)
        has-password (boolean (:has-password slink))
        expires-at   (:expires-at slink)

        ;; edit state of an existing link
        pwd-open*    (mf/use-state false)
        pwd-open?    (deref pwd-open*)
        pwd-value*   (mf/use-state "")
        pwd-value    (deref pwd-value*)
        exp-choice*  (mf/use-state nil)
        exp-choice   (deref exp-choice*)
        custom*      (mf/use-state "")
        custom       (deref custom*)

        who-view     (if existing?
                       (d/nilv (:who-view slink) "all")
                       (:who-view draft))
        password-on? (if existing?
                       (or has-password pwd-open?)
                       (boolean (:password-on draft)))
        password     (if existing? pwd-value (:password draft))
        expires      (cond
                       (not existing?)    (:expires draft)
                       (some? exp-choice) exp-choice
                       (some? expires-at) "current"
                       :else              "never")
        custom-value (if existing? custom (:custom draft))

        pwd-error    (when (and (not (str/empty? password))
                                (not (zv-valid-password? password)))
                       (tr "zvena.share.password.too-short" zv-password-min-length))
        custom-date  (zv-expires-at "custom" custom-value)
        date-error   (when (and (= expires "custom")
                                (not (str/blank? custom-value))
                                (nil? custom-date))
                       (tr "zvena.share.expires.in-past"))

        update-link
        (mf/use-fn
         (mf/deps link-id)
         (fn [params]
           (st/emit! (dc/zvena-update-share-link (assoc params :id link-id)))))

        on-who-view-change
        (mf/use-fn
         (mf/deps existing? update-link on-draft-change)
         (fn [value]
           (if existing?
             (update-link {:who-view value})
             (on-draft-change :who-view value))))

        on-password-toggle
        (mf/use-fn
         (mf/deps existing? has-password update-link on-draft-change)
         (fn [checked?]
           (if existing?
             (do
               (reset! pwd-open* checked?)
               (reset! pwd-value* "")
               (when (and (not checked?) has-password)
                 (update-link {:password nil})))
             (on-draft-change :password-on checked?))))

        on-password-change
        (mf/use-fn
         (mf/deps existing? on-draft-change)
         (fn [event]
           (let [value (dom/get-target-val event)]
             (if existing?
               (reset! pwd-value* value)
               (on-draft-change :password value)))))

        on-password-save
        (mf/use-fn
         (mf/deps pwd-value update-link)
         (fn [_]
           (when (zv-valid-password? pwd-value)
             (update-link {:password pwd-value})
             (reset! pwd-open* false)
             (reset! pwd-value* ""))))

        on-password-key-down
        (mf/use-fn
         (mf/deps existing? on-password-save)
         (fn [event]
           (when (and existing? (= "Enter" (.-key event)))
             (dom/prevent-default event)
             (on-password-save event))))

        on-password-edit
        (mf/use-fn
         (fn [_]
           (reset! pwd-open* true)))

        on-expires-change
        (mf/use-fn
         (mf/deps existing? update-link on-draft-change)
         (fn [value]
           (if existing?
             (case value
               "current" (reset! exp-choice* nil)
               "custom"  (reset! exp-choice* "custom")
               (do
                 (reset! exp-choice* nil)
                 (update-link {:expires-at (zv-expires-at value nil)})))
             (on-draft-change :expires value))))

        on-custom-change
        (mf/use-fn
         (mf/deps existing? on-draft-change)
         (fn [event]
           (let [value (dom/get-target-val event)]
             (if existing?
               (reset! custom* value)
               (on-draft-change :custom value)))))

        on-custom-save
        (mf/use-fn
         (mf/deps custom update-link)
         (fn [_]
           (when-let [date (zv-expires-at "custom" custom)]
             (update-link {:expires-at date})
             (reset! exp-choice* nil)
             (reset! custom* ""))))]

    [:div {:class (stl/css :zv-settings)}
     [:div {:class (stl/css :zv-settings-title)}
      (tr "zvena.share.settings")]

     [:div {:class (stl/css :zv-row)}
      [:div {:class (stl/css :subtitle)}
       (tr "zvena.share.who-view")]
      [:div {:class (stl/css :items)}
       [:& select
        {:class (stl/css :zv-select)
         :default-value who-view
         :options [{:value "all" :label (tr "zvena.share.who-view.anyone")}
                   {:value "team" :label (tr "zvena.share.who-view.team")}]
         :on-change on-who-view-change}]]]

     (if (= who-view "team")
       [:div {:class (stl/css :zv-hint)}
        (tr "zvena.share.who-view.team-hint")]

       [:*
        [:div {:class (stl/css :zv-row)}
         [:div {:class (stl/css :subtitle)}
          (tr "zvena.share.password")]
         [:div {:class (stl/css :items :zv-switch-cell)}
          [:> switch* {:default-checked password-on?
                       :aria-label (tr "zvena.share.password")
                       :on-change on-password-toggle}]]]

        (when password-on?
          (if (and existing? has-password (not pwd-open?))
            [:div {:class (stl/css :zv-row :zv-indented)}
             [:span {:class (stl/css :zv-status-item)}
              [:> icon* {:icon-id i/lock :size "s"}]
              (tr "zvena.share.password.set")]
             [:> button* {:type "button"
                          :variant "ghost"
                          :on-click on-password-edit}
              (tr "zvena.share.password.change")]]

            [:div {:class (stl/css :zv-row :zv-indented)}
             [:> input* {:type "password"
                         :class (stl/css :zv-input)
                         :value (d/nilv password "")
                         :placeholder (tr "zvena.share.password.placeholder")
                         :aria-label (tr "zvena.share.password.placeholder")
                         :auto-complete "new-password"
                         :auto-focus existing?
                         :on-change on-password-change
                         :on-key-down on-password-key-down
                         :hint-message pwd-error
                         :hint-type (when (some? pwd-error) "error")}]
             (when existing?
               [:> button* {:type "button"
                            :variant "secondary"
                            :disabled (not (zv-valid-password? pwd-value))
                            :on-click on-password-save}
                (tr "labels.save")])]))

        [:div {:class (stl/css :zv-row)}
         [:div {:class (stl/css :subtitle)}
          (tr "zvena.share.expires")]
         [:div {:class (stl/css :items)}
          [:& select
           {:key (dm/str "expires-" (some-> expires-at .getTime))
            :class (stl/css :zv-select)
            :default-value expires
            :options (zv-expires-options slink)
            :on-change on-expires-change}]]]

        (when (= expires "custom")
          [:div {:class (stl/css :zv-row :zv-indented)}
           [:div {:class (stl/css :zv-date-wrapper)}
            [:input {:type "datetime-local"
                     :class (stl/css :zv-date-input)
                     :aria-label (tr "zvena.share.expires.custom")
                     :value (d/nilv custom-value "")
                     :min (ct/format-inst (js/Date.) "yyyy-MM-dd'T'HH:mm")
                     :on-change on-custom-change}]
            (when (some? date-error)
              [:span {:class (stl/css :zv-error)} date-error])]
           (when existing?
             [:> button* {:type "button"
                          :variant "secondary"
                          :disabled (nil? custom-date)
                          :on-click on-custom-save}
              (tr "labels.save")])])])]))

(mf/defc share-link-dialog
  {::mf/register modal/components
   ::mf/register-as :share-link
   ::mf/wrap-props false}
  [{:keys [file page]}]
  (let [current-page    page
        current-page-id (:id page)
        slinks          (mf/deref refs/share-links)
        router          (mf/deref refs/router)
        route           (mf/deref refs/route)
        zoom-type       (mf/deref refs/viewer-zoom-type)
        page-ids        (dm/get-in file [:data :pages])

        perms-visible*  (mf/use-state false)
        perms-visible?  (deref perms-visible*)

        confirm*        (mf/use-state false)
        confirm?        (deref confirm*)

        options*        (mf/use-state
                         {:pages-mode "current"
                          :all-pages false
                          :pages #{(:id page)}
                          :who-comment "team"
                          :who-inspect "team"})
        options         (deref options*)

        ;; zvena: settings of a link that is not created yet
        zv-draft*       (mf/use-state zv-default-draft)
        zv-draft        (deref zv-draft*)

        ;; zvena: the link matching the options (its id, password, expiry)
        current-slink
        (mf/with-memo [slinks options]
          (let [{:keys [pages who-comment who-inspect]} (prepare-params options)]
            (d/seek #(and (= (:who-inspect %) who-inspect)
                          (= (:who-comment %) who-comment)
                          (= (:pages %) pages))
                    slinks)))

        current-link
        (mf/with-memo [slinks options page-ids]
          (let [{:keys [pages who-comment who-inspect] :as params} (prepare-params options)
                slink  (d/seek #(and (= (:who-inspect %) who-inspect)
                                     (= (:who-comment %) who-comment)
                                     (= (:pages %) pages))
                               slinks)]
            (when slink
              (let [page-id (d/seek #(contains? (:pages slink) %) page-ids)
                    params  (-> (:query-params route)
                                (assoc :share-id (:id slink))
                                (assoc :page-id page-id)
                                (assoc :index "0"))
                    params  (if (nil? zoom-type)
                              (dissoc params :zoom)
                              (assoc params :zoom zoom-type))

                    href    (rt/resolve router :viewer params)]
                (dm/str (assoc cf/public-uri :fragment href))))))

        on-close
        (fn [event]
          (dom/prevent-default event)
          (st/emit! (modal/hide))
          (modal/disallow-click-outside!))

        on-toggle-all
        (fn [_event]
          (reset! confirm* false)
          (swap! options*
                 (fn [state]
                   (if (true? (:all-pages state))
                     (-> state
                         (assoc :all-pages false)
                         (assoc :pages #{(:id page)}))
                     (-> state
                         (assoc :all-pages true)
                         (assoc :pages (into #{} (get-in file [:data :pages]))))))))

        on-mark-checked-page
        (fn [event]
          (let [target         (dom/get-target event)
                checked?       (dom/checked? target)
                page-id        (uuid/parse (dom/get-data target "page-id"))
                dif-pages?     (not= page-id (first (:pages options)))
                no-one-page    (< 1 (count (:pages options)))
                should-change? (or ^boolean no-one-page
                                   ^boolean dif-pages?)]
            (when ^boolean should-change?
              (reset! confirm* false)
              (swap! options*
                     (fn [{:keys [pages] :as state}]
                       (let [pages (if checked?
                                     (conj pages page-id)
                                     (disj pages page-id))]
                         (-> state
                             (assoc :pages pages)
                             (assoc :all-pages (= (count pages) (count page-ids))))))))))

        on-zv-draft-change
        (mf/use-fn
         (fn [k v]
           (swap! zv-draft* assoc k v)))

        create-link
        (fn [_]
          (let [params (prepare-params options)
                params (assoc params :file-id (:id file))
                ;; zvena: who can view, password and expiry of the new link
                params (merge params (zv-draft->params zv-draft))]
            (st/emit! (dc/create-share-link params)
                      (ev/event {::ev/name "create-share-link"
                                 ::ev/origin "viewer"
                                 :can-comment (:who-comment params)
                                 :can-inspect-code (:who-inspect params)}))))

        copy-link
        (fn [_]
          (clipboard/to-clipboard current-link)
          (st/emit! (ntf/show {:level :info
                               :type :toast
                               :content (tr "common.share-link.link-copied-success")
                               :timeout 1000})
                    (ev/event {::ev/name "copy-share-link"
                               ::ev/origin "viewer"})))

        try-delete-link
        (fn [_]
          (reset! confirm* true))

        delete-link
        (fn [_]
          ;; zvena: delete the link shown in the dialog; upstream matched
          ;; on the removed :flags column and always took the first link
          (let [slink current-slink]
            (reset! confirm* false)
            (when (some? slink)
              (st/emit! (dc/delete-share-link slink)))))

        toggle-perms-visibility
        (fn [_]
          (swap! perms-visible* not))

        on-inspect-change
        (fn [value]
          (reset! confirm* false)
          (swap! options* assoc :who-inspect value))

        on-comment-change
        (fn [value]
          (reset! confirm* false)
          (swap! options* assoc :who-comment value))]

    [:div {:class (stl/css :share-modal)}
     [:div  {:class (stl/css :share-link-dialog)}
      [:div {:class (stl/css :share-link-header)}
       [:h2 {:class (stl/css :share-link-title)}
        (tr "common.share-link.title")]
       [:button {:class (stl/css :modal-close-button)
                 :on-click on-close
                 :title (tr "labels.close")}
        deprecated-icon/close]]
      [:div {:class (stl/css :modal-content)}
       [:div {:class (stl/css :share-link-section)}
        (when (and (not confirm?) (some? current-link))
          [:div {:class (stl/css :custon-input-wrapper)}
           [:input {:class (stl/css :input-text)
                    :type "text"
                    :value (or current-link "")
                    :placeholder (tr "common.share-link.placeholder")
                    :read-only true}]

           [:button {:class (stl/css :copy-button)
                     :title (tr "viewer.header.share.copy-link")
                     :on-click copy-link}
            (tr "viewer.header.share.copy-link")]])

        ;; zvena: lock / expiry state of the link
        (when (and (not confirm?) (some? current-slink))
          [:> zv-link-status* {:slink current-slink}])

        [:div {:class (stl/css :hint-wrapper)}
         (when (not ^boolean confirm?)
           [:div {:class (stl/css :hint)} (tr "common.share-link.permissions-hint")])
         (cond
           (true? confirm?)
           [:div {:class (stl/css :confirm-dialog)}
            [:div {:class (stl/css :description)}
             (tr "common.share-link.confirm-deletion-link-description")]
            [:div {:class (stl/css :actions)}
             [:input  {:type "button"
                       :class (stl/css :button-cancel)
                       :on-click #(reset! confirm* false)
                       :value (tr "labels.cancel")}]
             [:input {:type "button"
                      :class (stl/css :button-danger)
                      :on-click delete-link
                      :value (tr "common.share-link.destroy-link")}]]]

           (some? current-link)
           [:input
            {:type "button"
             :class (stl/css :button-danger)
             :on-click try-delete-link
             :value (tr "common.share-link.destroy-link")}]

           :else
           [:input
            {:type "button"
             :class (stl/css :button-active)
             :on-click create-link
             ;; zvena: a too short password or a past date can't be sent
             :disabled (not (zv-draft-valid? zv-draft))
             :value (tr "common.share-link.get-link")}])]]


       (when (not ^boolean confirm?)
         [:div {:class (stl/css :permissions-section)}
          [:button {:class (stl/css :manage-permissions)
                    :on-click toggle-perms-visibility}
           [:span {:class (stl/css-case :icon true
                                        :rotated perms-visible?)}
            deprecated-icon/arrow]
           (tr "common.share-link.manage-ops")]

          (when ^boolean perms-visible?
            [:*
             (let [all-selected? (:all-pages options)
                   pages         (->> (get-in file [:data :pages])
                                      (map #(get-in file [:data :pages-index %])))
                   selected      (:pages options)]
               [:div {:class (stl/css :view-mode)}
                [:div {:class (stl/css :subtitle)}
                 (tr "common.share-link.permissions-pages")]
                [:div {:class (stl/css :items)}
                 (if (= 1 (count pages))
                   [:div {:class (stl/css :checkbox-wrapper)}

                    [:label {:for (str "page-" current-page-id)
                             :class (stl/css-case :global/checked true)}

                     [:span  {:class (stl/css :checked)}
                      deprecated-icon/status-tick]

                     (:name current-page)]

                    [:input {:type "checkbox"
                             :id (dm/str "page-" current-page-id)
                             :data-page-id (dm/str current-page-id)
                             :on-change on-mark-checked-page
                             :checked true}]
                    [:span  (str  " " (tr "common.share-link.current-tag"))]]

                   [:*
                    [:div {:class (stl/css :select-all-row)}
                     [:div {:class (stl/css :checkbox-wrapper)}
                      [:label {:for "view-all"
                               :class (stl/css :select-all-label)}
                       [:span {:class (stl/css-case :global/checked all-selected?)}
                        (when all-selected?
                          deprecated-icon/status-tick)]
                       (tr "common.share-link.view-all")
                       [:input {:type "checkbox"
                                :id "view-all"
                                :checked all-selected?
                                :name "pages-mode"
                                :on-change on-toggle-all}]]]

                     [:span {:class (stl/css :count-pages)}
                      (tr "common.share-link.page-shared" (i18n/c (count selected)))]]

                    [:ul {:class (stl/css :pages-selection)}
                     (for [{:keys [id name]} pages]
                       [:li {:class (stl/css :checkbox-wrapper)
                             :key (dm/str id)}
                        [:label {:for (dm/str "page-" id)}
                         [:span {:class (stl/css-case :global/checked (contains? selected id))}
                          (when (contains? selected id)
                            deprecated-icon/status-tick)]
                         name
                         (when (= current-page-id id)
                           [:div {:class (stl/css :current-tag)} (dm/str  " " (tr "common.share-link.current-tag"))])
                         [:input {:type "checkbox"
                                  :id (dm/str "page-" id)
                                  :data-page-id (dm/str id)
                                  :on-change on-mark-checked-page
                                  :checked (contains? selected id)}]]])]])]])

             [:div {:class (stl/css :access-mode)}
              [:div {:class (stl/css :subtitle)}
               (tr "common.share-link.permissions-can-comment")]
              [:div {:class (stl/css :items)}
               [:& select
                {:class (stl/css :who-comment-select)
                 :default-value (dm/str (:who-comment options))
                 :options [{:value "team" :label (tr "common.share-link.team-members")}
                           {:value "all" :label (tr "common.share-link.all-users")}]
                 :on-change on-comment-change}]]]
             [:div {:class (stl/css :inspect-mode)}
              [:div {:class (stl/css :subtitle)}
               (tr "common.share-link.permissions-can-inspect")]
              [:div {:class (stl/css :items)}
               [:& select
                {:class (stl/css :who-inspect-select)
                 :default-value (dm/str (:who-inspect options))
                 :options [{:value "team" :label (tr "common.share-link.team-members")}
                           {:value "all" :label (tr "common.share-link.all-users")}]
                 :on-change on-inspect-change}]]]

             ;; zvena: Figma's link settings
             [:> zv-link-settings* {:slink current-slink
                                    :draft zv-draft
                                    :on-draft-change on-zv-draft-change}]])])]]]))



