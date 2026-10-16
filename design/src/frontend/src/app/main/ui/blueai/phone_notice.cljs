;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.blueai.phone-notice
  "On a phone the editor does not fit (Penpot has no mobile layout), so the
  workspace first offers the viewer, where prototypes and comments work, and
  lets the person continue anyway."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.common :as dcm]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(def ^:private dismissed-key "blueai-phone-notice-dismissed")

(defn- phone?
  "A touch screen whose short side is phone-sized. Board's page has no
  viewport meta, so a phone lays it out ~980px wide: the window width
  says nothing, the screen size does (tablets start at ~744)."
  []
  (or (and (some? js/window.matchMedia)
           (.-matches (js/window.matchMedia "(pointer: coarse)"))
           (< (min (.-width js/screen) (.-height js/screen)) 600))
      ;; zvena: any window too narrow for the panels and a canvas (a
      ;; phone-sized browser window, a page with a viewport meta)
      (< (.-innerWidth js/window) 640)))

(defn- dismissed?
  []
  (try (= "1" (.getItem js/sessionStorage dismissed-key))
       (catch :default _ false)))

(mf/defc phone-notice*
  [{:keys [file-id page-id]}]
  (let [visible* (mf/use-state #(and (phone?) (not (dismissed?))))
        on-view  (mf/use-fn
                  (mf/deps file-id page-id)
                  (fn []
                    ;; same tab: on a phone a new window only hides this one
                    (st/emit! (dcm/go-to-viewer (cond-> {:file-id file-id
                                                         :section "interactions"
                                                         ::rt/new-window false}
                                                  page-id (assoc :page-id page-id))))))
        on-edit  (mf/use-fn
                  (fn []
                    (try (.setItem js/sessionStorage dismissed-key "1") (catch :default _ nil))
                    (reset! visible* false)))]
    (when @visible*
      [:div {:class (stl/css :overlay) :role "dialog" :aria-labelledby "blueai-phone-title"}
       ;; Sized in vw: the page is laid out ~980px wide on a phone (no viewport meta).
       [:div {:class (stl/css :card)}
        [:h2 {:id "blueai-phone-title" :class (stl/css :title)} (tr "blueai.phone.title")]
        [:p {:class (stl/css :text)} (tr "blueai.phone.text")]
        [:div {:class (stl/css :actions)}
         [:button {:type "button" :class (stl/css :primary) :on-click on-view} (tr "blueai.phone.view")]
         [:button {:type "button" :class (stl/css :secondary) :on-click on-edit} (tr "blueai.phone.edit")]]]])))
