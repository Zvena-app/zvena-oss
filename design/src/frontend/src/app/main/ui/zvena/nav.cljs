;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.zvena.nav
  "zvena's sections at the top of Design's file browser: Home, Documents and
  Team of the open workspace (= this Penpot team), in the zvena web app."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.util.i18n :refer [tr]]
   [app.zvena :as zvena]
   [rumext.v2 :as mf]))

(mf/defc zvena-nav*
  [{:keys [team-id]}]
  [:ul {:class (stl/css :nav)
        :aria-label "zvena"}
   [:li
    [:a {:class (stl/css :link) :href (zvena/home-url team-id)}
     [:> icon* {:icon-id i/view-as-icons :class (stl/css :icon)}]
     [:span (tr "zvena.nav.home")]]]
   [:li
    [:a {:class (stl/css :link) :href (zvena/docs-url team-id)}
     [:> icon* {:icon-id i/text-paragraph :class (stl/css :icon)}]
     [:span (tr "zvena.nav.docs")]]]
   [:li
    [:a {:class (stl/css :link) :href (zvena/team-url team-id)}
     [:> icon* {:icon-id i/user :class (stl/css :icon)}]
     [:span (tr "zvena.nav.team")]]]])
