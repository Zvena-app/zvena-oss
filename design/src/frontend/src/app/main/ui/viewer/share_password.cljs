;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.viewer.share-password
  "zvena: Figma's password screen for a password protected share link.
  The backend checks the password and sets an HttpOnly unlock cookie;
  after that the viewer loads the file as usual."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.viewer :as dv]
   [app.main.repo :as rp]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def locked-ref
  "The share-id whose password the viewer is waiting for, or nil."
  (l/derived :zvena-share-locked st/state))

(defn- error-message
  [code]
  (case code
    :zvena-share-wrong-password    (tr "zvena.share.unlock.wrong-password")
    :zvena-share-too-many-attempts (tr "zvena.share.unlock.too-many-attempts")
    (tr "errors.generic")))

(mf/defc share-password*
  [{:keys [file-id page-id share-id]}]
  (let [password* (mf/use-state "")
        password  (deref password*)

        error*    (mf/use-state nil)
        error     (deref error*)

        pending*  (mf/use-state false)
        pending?  (deref pending*)

        on-change
        (mf/use-fn
         (fn [event]
           (reset! error* nil)
           (reset! password* (dom/get-target-val event))))

        on-submit
        (mf/use-fn
         (mf/deps file-id page-id share-id password pending?)
         (fn [event]
           (dom/prevent-default event)
           (when (and (not pending?)
                      (not (str/blank? password)))
             (reset! pending* true)
             (->> (rp/cmd! :zvena-unlock-share-link {:share-id share-id
                                                     :password password})
                  (rx/subs!
                   (fn [_]
                     (st/emit! (dv/zvena-share-unlocked {:file-id file-id
                                                         :page-id page-id
                                                         :share-id share-id})))
                   (fn [cause]
                     (reset! pending* false)
                     (let [code (:code (ex-data cause))]
                       (if (= code :zvena-share-link-expired)
                         (st/emit! (rt/assign-exception {:type :not-found
                                                         :code code}))
                         (reset! error* (error-message code))))))))))]

    [:div {:class (stl/css :password-page)}
     [:form {:class (stl/css :password-card)
             :on-submit on-submit}
      [:div {:class (stl/css :lock)}
       [:> icon* {:icon-id i/lock :size "l"}]]
      [:h1 {:class (stl/css :title)}
       (tr "zvena.share.unlock.title")]
      [:p {:class (stl/css :description)}
       (tr "zvena.share.unlock.description")]
      [:> input* {:type "password"
                  :class (stl/css :password-input)
                  :value password
                  :on-change on-change
                  :placeholder (tr "zvena.share.unlock.placeholder")
                  :aria-label (tr "zvena.share.unlock.placeholder")
                  :auto-focus true
                  :auto-complete "current-password"
                  :hint-message error
                  :hint-type (when (some? error) "error")}]
      [:> button* {:type "submit"
                   :variant "primary"
                   :class (stl/css :submit)
                   :disabled (or pending? (str/blank? password))}
       (tr "zvena.share.unlock.continue")]]]))
