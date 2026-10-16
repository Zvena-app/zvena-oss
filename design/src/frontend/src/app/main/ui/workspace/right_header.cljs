;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.right-header
  (:require-macros [app.main.style :as stl])
  (:require
   [app.config :as cf]
   [app.main.data.common :as dcm]
   [app.main.data.modal :as modal]
   [app.main.data.shortcuts :as scd]
   [app.main.data.team :as dtm]
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.shortcuts :as sc]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.dropdown :refer [dropdown]]
   [app.main.ui.dashboard.team]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.exports.assets :refer [progress-widget]]
   [app.main.ui.formats :as fmt]
   [app.main.ui.viewer.share-link]
   [app.main.ui.workspace.presence :refer [active-sessions*]]
   [app.util.dom :as dom]
   [app.util.i18n :as i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ref:persistence-status
  (l/derived :status refs/persistence))

;; --- Zoom Widget

(mf/defc zoom-widget-workspace
  {::mf/wrap [mf/memo]
   ::mf/wrap-props false}
  [{:keys [zoom on-increase on-decrease on-zoom-reset on-zoom-fit on-zoom-selected]}]
  (let [open*            (mf/use-state false)
        open?            (deref open*)
        custom-shortcuts (mf/deref refs/custom-shortcuts)
        get-tt           #(sc/get-effective-tooltip % custom-shortcuts)

        open-dropdown
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! open* true)))

        close-dropdown
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! open* false)))

        on-increase
        (mf/use-fn
         (mf/deps on-increase)
         (fn [event]
           (dom/stop-propagation event)
           (on-increase)))

        on-decrease
        (mf/use-fn
         (mf/deps on-decrease)
         (fn [event]
           (dom/stop-propagation event)
           (on-decrease)))

        zoom (fmt/format-percent zoom {:precision 0})]

    ;; Figma-style zoom menu — a plain list with shortcuts.
    [:*
     [:div {:on-click open-dropdown
            :class (stl/css-case :zoom-widget true
                                 :selected open?)
            :title (tr "workspace.header.zoom")}
      [:span {:class (stl/css :label)} zoom]
      [:> icon* {:icon-id i/arrow-down
                 :size "s"
                 :class (stl/css :zoom-arrow)}]]
     [:& dropdown {:show open? :on-close close-dropdown}
      [:ul {:class (stl/css :dropdown)}
       (for [[id label on-click] [[:increase-zoom (tr "shortcuts.increase-zoom") on-increase]
                                  [:decrease-zoom (tr "shortcuts.decrease-zoom") on-decrease]
                                  [:separator]
                                  [:fit-all (tr "workspace.header.zoom-fit-all") on-zoom-fit]
                                  [:zoom-selected (tr "workspace.header.zoom-selected") on-zoom-selected]
                                  [:reset-zoom (tr "blueai.zoom.100") on-zoom-reset]]]
         (if (= id :separator)
           [:li {:key "sep" :class (stl/css :zoom-separator)}]
           [:li {:key (name id)
                 :class (stl/css :zoom-option)
                 :on-click on-click}
            label
            [:span {:class (stl/css :shortcuts)}
             (for [sc (scd/split-sc (get-tt id))]
               [:span {:class (stl/css :shortcut-key)
                       :key (str (name id) "-" sc)} sc])]]))]]]))

;; --- Zoom control (sits at the end of the Design/Prototype tabs row, as in Figma)

(mf/defc zoom-control*
  []
  (let [zoom             (mf/deref refs/selected-zoom)
        on-increase      (mf/use-fn #(st/emit! (dw/increase-zoom nil)))
        on-decrease      (mf/use-fn #(st/emit! (dw/decrease-zoom nil)))
        on-zoom-reset    (mf/use-fn #(st/emit! dw/reset-zoom))
        on-zoom-fit      (mf/use-fn #(st/emit! dw/zoom-to-fit-all))
        on-zoom-selected (mf/use-fn #(st/emit! dw/zoom-to-selected-shape))]
    [:div {:class (stl/css :zoom-section)}
     [:& zoom-widget-workspace
      {:zoom zoom
       :on-increase on-increase
       :on-decrease on-decrease
       :on-zoom-reset on-zoom-reset
       :on-zoom-fit on-zoom-fit
       :on-zoom-selected on-zoom-selected}]]))

;; --- Header Component

;; Figma UI3 header — collaborators on the left; present and Share on
;; the right. Comments moved to the toolbar, version history to the file menu,
;; zoom to the tabs row.
(mf/defc right-header*
  [{:keys [file-id page-id]}]
  (let [custom-shortcuts  (mf/deref refs/custom-shortcuts)
        get-tt            #(sc/get-effective-tooltip % custom-shortcuts)

        team              (mf/deref refs/team)
        permissions       (get team :permissions)
        file              (mf/deref refs/file)
        page              (mf/deref refs/workspace-page)

        can-edit?         (:can-edit permissions)

        ;; zvena: teams and invitations are managed in the zvena web app (Design's
        ;; invite calls are refused), so Share is the prototype link there.
        can-invite?
        (and (not (:is-default team))
             (not (contains? cf/flags :zvena))
             (or (:is-admin permissions)
                 (:is-owner permissions)))

        nav-to-viewer
        (mf/use-fn
         (mf/deps file-id page-id)
         (fn []
           (let [params {:page-id page-id
                         :file-id file-id
                         :section "interactions"}]
             (st/emit! (dcm/go-to-viewer params)))))

        open-share-dialog
        (mf/use-fn
         (mf/deps team can-invite? file page)
         (fn []
           (if can-invite?
             (st/emit! (dtm/check-and-invite-members {:team-id (:id team)
                                                      :origin :workspace}))
             (st/emit! (dcm/fetch-share-links (:id file))
                       (modal/show :share-link {:page page :file file})))))]

    [:div {:class (stl/css :workspace-header-right)}
     [:div {:class (stl/css :users-section)}
      [:> active-sessions*]]

     [:& progress-widget]

     [:div {:class (stl/css :header-actions)}
      [:> icon-button* {:variant "ghost"
                        :icon i/play
                        :class (stl/css :present-button)
                        :aria-label (tr "workspace.header.viewer" (get-tt :open-viewer))
                        :on-click nav-to-viewer}]
      ;; zvena: only editors can create share links (a viewer's attempt
      ;; is refused by the backend).
      (when can-edit?
        [:button {:class (stl/css :share-button)
                  :on-click open-share-dialog}
         (tr "workspace.header.share")])]]))
