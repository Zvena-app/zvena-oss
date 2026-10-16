;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.help-button
  "Figma's round \"?\" in the bottom-right corner of the canvas: help and resources."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.shortcuts :as sc]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.dropdown-menu :refer [dropdown-menu* dropdown-menu-item*]]
   [app.util.dom :as dom]
   [app.util.help :as help]
   [app.util.i18n :refer [tr]]
   [app.zvena :as zvena]
   [rumext.v2 :as mf]))

(mf/defc help-button*
  {::mf/memo true}
  []
  (let [open*  (mf/use-state false)
        open?  (deref open*)
        layout (mf/deref refs/workspace-layout)

        toggle (mf/use-fn
                (fn [event]
                  ;; The menu closes on outside clicks; keep this one from reaching it.
                  (dom/stop-propagation event)
                  (swap! open* not)))
        close  (mf/use-fn #(reset! open* false))

        show-shortcuts
        (mf/use-fn
         (mf/deps layout)
         (fn []
           (reset! open* false)
           (when (contains? layout :collapse-left-sidebar)
             (st/emit! (dw/toggle-layout-flag :collapse-left-sidebar)))
           (when-not (contains? layout :shortcuts)
             (st/emit! (dw/toggle-layout-flag :shortcuts)))))

        open-url
        (mf/use-fn
         (fn [event]
           (reset! open* false)
           (dom/open-new-window (dom/get-data (dom/get-current-target event) "url"))))]

    [:div {:class (stl/css :help)}
     [:button {:class (stl/css-case :help-button true :open open?)
               :aria-haspopup true
               :aria-expanded open?
               :aria-label (tr "blueai.help.title")
               :title (tr "blueai.help.title")
               :on-click toggle}
      "?"]
     [:> dropdown-menu* {:show open?
                         :on-close close
                         :class (stl/css :help-menu)}
      [:> dropdown-menu-item* {:class (stl/css :help-menu-item)
                               :data-url (help/url)
                               :on-click open-url}
       [:span (tr "labels.help-center")]]
      [:> dropdown-menu-item* {:class (stl/css :help-menu-item)
                               :on-click show-shortcuts}
       [:span (tr "label.shortcuts")]
       [:span {:class (stl/css :help-menu-shortcut)} (sc/get-tooltip :show-shortcuts)]]
      (when zvena/support-email
        [:> dropdown-menu-item* {:class (stl/css :help-menu-item)
                                 :data-url (str "mailto:" zvena/support-email)
                                 :on-click open-url}
         [:span (tr "blueai.help.ask")]])
      [:li {:class (stl/css :help-menu-separator) :role "separator"}]
      [:> dropdown-menu-item* {:class (stl/css :help-menu-item)
                               :data-url (zvena/source-url)
                               :on-click open-url}
       [:span (tr "blueai.menu.source-code")]]]]))
