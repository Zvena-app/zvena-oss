;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.presence
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.config :as cfg]
   [app.main.data.workspace.follow :as dwf]
   [app.main.data.workspace.notifications :as dwn]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.timers :as tm]
   [rumext.v2 :as mf]))

(mf/defc session-widget*
  {::mf/props :obj
   ::mf/memo true}
  [{:keys [color profile index session-id followed own spotlight]}]
  (let [profile       (assoc profile :color color)
        full-name     (:fullname profile)

        ;; zvena: click an avatar to follow that person (Figma's follow
        ;; mode); click your own to spotlight yourself
        on-click
        (mf/use-fn
         (mf/deps session-id own)
         (fn [event]
           (when session-id
             (dom/stop-propagation event)
             (st/emit! (if own
                         (dwn/toggle-spotlight)
                         (dwf/toggle-following session-id))))))]
    [:li {:class (stl/css-case :session-icon true
                               :session-followed followed)
          :style {:z-index (dm/str (+ 2 (* -1 index)))
                  :background-color color
                  :--zv-follow-color color}
          :title (if own
                   (str full-name " — " (tr (if spotlight "zvena.spotlight.stop" "zvena.spotlight.start")))
                   (str full-name " — " (tr (if followed "zvena.follow.stop" "zvena.follow.start"))))
          :on-click on-click}
     [:img {:alt full-name
            :style {:background-color color}
            :src (cfg/resolve-profile-photo-url profile)}]]))

;; zvena: Figma's cursor chat. "/" opens a bubble at the pointer; what is
;; typed shows next to this person's cursor for everyone in the file.
(mf/defc cursor-chat*
  {::mf/memo true}
  []
  (let [text     (mf/deref refs/own-cursor-chat)
        pos*     (mf/use-ref nil)
        at*      (mf/use-state nil)
        at       (deref at*)
        timer*   (mf/use-ref nil)

        close
        (mf/use-fn #(st/emit! (dwn/set-cursor-chat nil)))

        schedule-close
        (mf/use-fn
         (mf/deps close)
         (fn []
           (some-> (mf/ref-val timer*) js/clearTimeout)
           (mf/set-ref-val! timer* (js/setTimeout close 8000))))

        on-change
        (mf/use-fn
         (mf/deps schedule-close)
         (fn [event]
           (schedule-close)
           (st/emit! (dwn/set-cursor-chat (dom/get-target-val event)))))

        on-key-down
        (mf/use-fn
         (mf/deps close)
         (fn [event]
           (dom/stop-propagation event)
           (when (= "Escape" (.-key event))
             (close))))]

    ;; where the pointer is, so the bubble opens next to it
    (mf/with-effect []
      (let [on-move (fn [^js e] (mf/set-ref-val! pos* [(.-clientX e) (.-clientY e)]))]
        (.addEventListener js/document "pointermove" on-move #js {:passive true})
        #(.removeEventListener js/document "pointermove" on-move)))

    (mf/with-effect [text]
      (cond
        (and (some? text) (nil? at))
        (do (reset! at* (or (mf/ref-val pos*) [(/ (.-innerWidth js/window) 2) (/ (.-innerHeight js/window) 2)]))
            (schedule-close))

        (and (nil? text) (some? at))
        (do (reset! at* nil)
            (some-> (mf/ref-val timer*) js/clearTimeout))))

    (when (and (some? text) (some? at))
      [:div {:class (stl/css :cursor-chat)
             :style {:left (+ 14 (first at)) :top (+ 14 (second at))}}
       [:input {:auto-focus true
                :value text
                :max-length 120
                :placeholder (tr "zvena.chat.placeholder")
                :on-change on-change
                :on-blur close
                :on-key-down on-key-down}]])))

(mf/defc active-sessions*
  {::mf/memo true}
  []
  (let [profiles     (mf/deref refs/profiles)
        presence     (mf/deref refs/workspace-presence)
        own-session  (mf/deref refs/session-id)
        following    (mf/deref refs/following-session)
        spotlight    (mf/deref refs/own-spotlight)
        leader       (get presence following)
        stop-follow  (mf/use-fn #(st/emit! (dwf/stop-following)))
        stop-spot    (mf/use-fn #(st/emit! (dwn/toggle-spotlight)))

        sessions     (vals presence)
        num-sessions (count sessions)
        max-avatar-count 3
        avatar-count (if (= num-sessions max-avatar-count) max-avatar-count (- max-avatar-count 1))

        open*        (mf/use-state false)
        open?        (and ^boolean (deref open*) (> num-sessions max-avatar-count))
        on-open
        (mf/use-fn
         (fn []
           (reset! open* true)
           (tm/schedule-on-idle
            #(dom/focus! (dom/get-element "users-close")))))

        on-close
        (mf/use-fn #(reset! open* false))]

    [:*
     (when ^boolean open?
       [:button {:id "users-close"
                 :class (stl/css :active-users-opened)
                 :on-click on-close
                 :on-blur on-close}
        [:ul {:class (stl/css :active-users-list) :data-testid "active-users-list"}
         (for [session sessions]
           [:> session-widget*
            {:color (:color session)
             :index 0
             :session-id (:id session)
             :followed (= following (:id session))
             :own (= own-session (:id session))
             :spotlight spotlight
             :profile (get profiles (:profile-id session))
             :key (dm/str (:id session))}])]])

     [:button {:class (stl/css-case :active-users true)
               :on-click on-open}
      [:ul {:class (stl/css :active-users-list) :data-testid "active-users-list"}
       (when (> num-sessions max-avatar-count)
         [:li {:class (stl/css :users-num)} (dm/str "+" (+ 1 (- num-sessions max-avatar-count)))])

       (for [[index session] (d/enumerate (take avatar-count sessions))]
         [:> session-widget*
          {:color (:color session)
           :index index
           :session-id (:id session)
           :followed (= following (:id session))
           :own (= own-session (:id session))
           :spotlight spotlight
           :profile (get profiles (:profile-id session))
           :key (dm/str (:id session))}])]]

     ;; zvena: this person is spotlighting
     (when ^boolean spotlight
       [:div {:class (stl/css :follow-banner)
              :style {:--zv-follow-color (:color (get presence own-session) "var(--color-accent-primary)")}}
        [:span (tr "zvena.spotlight.banner")]
        [:button {:class (stl/css :follow-stop)
                  :on-click stop-spot}
         (tr "zvena.spotlight.stop")]])

     [:> cursor-chat*]

     ;; zvena: who is being followed, with a way out
     (when (some? leader)
       [:div {:class (stl/css :follow-banner)
              :style {:--zv-follow-color (:color leader)}}
        [:span (tr "zvena.follow.banner" (or (:fullname (get profiles (:profile-id leader))) ""))]
        [:button {:class (stl/css :follow-stop)
                  :on-click stop-follow}
         (tr "zvena.follow.stop")]])]))
