;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-prototype-settings
  "zvena: Figma's Prototype settings (nothing selected, Prototype tab):
  the device the prototype is presented in and its color."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.main.data.plugins :as dp]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.select :refer [select]]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(mf/defc prototype-settings*
  []
  (let [file-id (:id (mf/deref refs/file))
        page    (mf/deref refs/workspace-page)
        page-id (:id page)
        data    (dm/get-in page [:plugin-data :zvena])
        device  (get data "device" "none")
        color   (get data "device-color" "black")

        save!   (fn [key value]
                  (when (and file-id page-id)
                    (st/emit! (dp/set-plugin-data file-id :page page-id :zvena key value))))

        on-device (mf/use-fn (mf/deps file-id page-id)
                             (fn [value] (save! "device" (when (not= value "none") value))))
        on-color  (mf/use-fn (mf/deps file-id page-id)
                             (fn [value] (save! "device-color" value)))]

    [:section {:class (stl/css :element-set)
               :aria-label (tr "zvena.proto.settings")}
     [:div {:class (stl/css :element-title)}
      [:> title-bar* {:collapsable false
                      :title (tr "zvena.proto.settings")
                      :class (stl/css :title-spacing)}]]
     [:div {:class (stl/css :element-content)}
      [:div {:class (stl/css :row)}
       [:span {:class (stl/css :label)} (tr "zvena.proto.device")]
       [:& select {:class (stl/css :select)
                   :default-value device
                   :options [{:value "none" :label (tr "zvena.proto.device-none")}
                             {:value "iphone" :label "iPhone 16"}
                             {:value "iphone-se" :label "iPhone SE"}
                             {:value "android" :label "Android (Google Pixel)"}
                             {:value "ipad" :label "iPad"}
                             {:value "macbook" :label "MacBook"}
                             {:value "browser" :label (tr "zvena.proto.device-browser")}]
                   :on-change on-device}]]
      (when (contains? #{"iphone" "iphone-se" "android" "ipad" "macbook"} device)
        [:div {:class (stl/css :row)}
         [:span {:class (stl/css :label)} (tr "zvena.proto.device-color")]
         [:& select {:class (stl/css :select)
                     :default-value color
                     :options [{:value "black" :label (tr "zvena.proto.color-black")}
                               {:value "silver" :label (tr "zvena.proto.color-silver")}
                               {:value "gold" :label (tr "zvena.proto.color-gold")}
                               {:value "blue" :label (tr "zvena.proto.color-blue")}]
                     :on-change on-color}]])]]))
