;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.bridge
  "zvena: Design as part of zvena's ecosystem.

  - A comment thread can become an issue in zvena's Projects
    (`create-issue-url`: zvena's form reads the thread as the person and
    links the issue to the frame the comment sits on).
  - Quick actions (Ctrl+/) also find zvena's documents, issues and projects
    (`use-search`).
  - A selected frame shows what is linked to it in zvena — issues made from
    it or for it, documents that embed it — and makes a new issue for it
    (`frame-related*`); with nothing selected, the same for the file (an
    issue the file was made from, documents that embed it).

  zvena answers these reads for Design's own origin, with the person's
  zvena session (its cookies; CORS for this one origin), naming the team
  instead of a workspace. Without a zvena session nothing is shown.

  All of it only with the `zvena-bridge` flag (PENPOT_FLAGS
  enable-zvena-bridge), switched on together with a zvena web that has the
  matching routes: without it, no request goes to zvena and nothing shows."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.timers :as ts]
   [app.zvena :as zvena]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

;; --- ON/OFF

(def enabled?
  "The bridge is switched on for this Design (and its zvena has the routes)."
  (contains? cf/flags :zvena-bridge))

;; --- ADDRESSES

(defn- query
  [params]
  (str (js/URLSearchParams. (clj->js (into {} (remove (comp nil? val)) params)))))

(defn- href
  "A zvena address from a path zvena gave (relative to its origin)."
  [path]
  (if (str/starts-with? (str path) "/")
    (str zvena/uri path)
    (str zvena/uri "/" path)))

(defn- open!
  [url]
  (dom/open-new-window url))

(defn design-ref
  "The ecosystem's name of a file, or of one frame of it."
  [file-id frame-id]
  (if (and (some? frame-id) (not= uuid/zero frame-id))
    (str "design:" file-id "/" frame-id)
    (str "design:" file-id)))

(defn create-issue-url
  "zvena's form making an issue from a comment thread."
  [team-id {:keys [id file-id frame-id]}]
  (str zvena/uri "/eco/from-design?"
       (query {:team (some-> team-id str)
               :thread (str id)
               :file (some-> file-id str)
               :frame (when (and (some? frame-id) (not= uuid/zero frame-id)) (str frame-id))})))

(defn new-issue-url
  "Projects' new issue form, the issue linked to this frame once made."
  [team-id file-id frame-id title]
  (str zvena/uri "/projects?"
       (query {:team (some-> team-id str)
               :create "issue"
               :for (design-ref file-id frame-id)
               :title (when-not (str/blank? title) (subs title 0 (min 300 (count title))))})))

;; --- READING FROM ZVENA

(defn- get-json
  "GET a zvena API route as the person: a promise of the decoded body, or nil
  (signed out, no access, zvena away)."
  [path params]
  (-> (js/fetch (str zvena/uri path "?" (query params))
                #js {:credentials "include"
                     :headers #js {:accept "application/json"}})
      (.then (fn [res] (when (.-ok res) (.json res))))
      (.then (fn [body] (some-> body (js->clj :keywordize-keys true))))
      (.catch (fn [_] nil))))

;; --- COMMENT THREAD MENU

(mf/defc create-issue-option*
  "The comment thread menu's \"Create issue in zvena\"."
  [{:keys [thread class on-done]}]
  (let [team (mf/deref refs/team)
        on-click
        (mf/use-fn
         (mf/deps team thread on-done)
         (fn [event]
           (dom/stop-propagation event)
           (when on-done (on-done event))
           (open! (create-issue-url (:id team) thread))))]
    (when enabled?
      [:li {:class class :on-click on-click}
       (tr "zvena.bridge.create-issue")])))

;; --- QUICK ACTIONS

(def ^:private kind-label
  {"issue" "zvena.bridge.kind.issue"
   "note" "zvena.bridge.kind.doc"
   "project" "zvena.bridge.kind.project"
   "design" "zvena.bridge.kind.design"})

(defn use-search
  "zvena's search for the quick actions panel: items {:id :label :hint :fn},
  found a moment after the query stops changing."
  [text]
  (let [team    (mf/deref refs/team)
        team-id (:id team)
        found*  (mf/use-state [])
        q       (str/trim (str text))]
    (mf/with-effect [team-id q]
      (if (or (not enabled?) (nil? team-id) (< (count q) 2))
        (do (reset! found* []) nil)
        (let [live? (volatile! true)
              timer (ts/schedule
                     250
                     (fn []
                       (-> (get-json "/api/eco/search" {:team (str team-id) :q q})
                           (.then (fn [body]
                                    (when @live?
                                      (reset! found*
                                              (->> (:hits body)
                                                   (take 8)
                                                   (mapv (fn [{:keys [key kind title sub url]}]
                                                           {:id (str "zvena:" key)
                                                            :label (str title)
                                                            :hint (str/join " · " (remove str/blank? [sub (some-> (get kind-label kind) tr)]))
                                                            :fn #(open! (href url))}))))))))))]
          (fn []
            (vreset! live? false)
            (ts/dispose! timer)))))
    (deref found*)))

;; --- A FRAME'S RELATED (the right panel)

(def ^:private ref:file-name
  (l/derived (fn [state] (get-in state [:files (:current-file-id state) :name])) st/state))

(mf/defc related-item*
  {::mf/private true}
  [{:keys [item]}]
  (let [{:keys [card]} item
        {:keys [kind title sub url status icon color]} card
        on-click (mf/use-fn (mf/deps url) #(open! (href url)))]
    [:li {:class (stl/css :item)
          :role "link"
          :tab-index 0
          :title (str title)
          :on-click on-click
          :on-key-down (fn [event] (when (= "Enter" (.-key event)) (on-click)))}
     (cond
       (= kind "issue")
       [:span {:class (stl/css-case :status true
                                    :done (= "completed" (:category status))
                                    :canceled (= "canceled" (:category status)))
               :style {:--status-color (or (:color status) "var(--color-foreground-secondary)")}}]

       (not (str/blank? icon))
       [:span {:class (stl/css :emoji)} icon]

       :else
       [:span {:class (stl/css :dot)
               :style {:--status-color (or color "var(--color-foreground-secondary)")}}])
     [:span {:class (stl/css :item-title)} (str title)]
     (when-not (str/blank? sub)
       [:span {:class (stl/css :item-sub)} sub])]))

(mf/defc frame-related*
  "What zvena links to the selected frame (or, `frame` nil, to the file),
  with a button making an issue for it."
  [{:keys [file-id frame]}]
  (let [team      (mf/deref refs/team)
        team-id   (:id team)
        file-name (mf/deref ref:file-name)
        frame-id  (:id frame)
        state*    (mf/use-state nil)
        state     (deref state*)
        tick*     (mf/use-state 0)

        ;; This frame's comment threads as Design knows them: a change reads zvena again.
        threads   (mf/deref refs/comment-threads)
        comments  (mf/with-memo [threads frame-id]
                    (->> (vals threads)
                         (filter #(or (nil? frame-id) (= frame-id (:frame-id %))))
                         (map (juxt :id :count-comments :modified-at :is-resolved))
                         (sort-by (comp str first))
                         (vec)))

        on-new
        (mf/use-fn
         (mf/deps team-id file-id frame-id frame file-name)
         (fn [event]
           (dom/stop-propagation event)
           (open! (new-issue-url team-id file-id frame-id (or (:name frame) file-name)))))]

    ;; Read again: coming back to this tab (after making an issue in zvena),
    ;; a moment after this frame's comments change (zvena indexes them), and
    ;; every half minute while the panel is open and visible.
    (mf/with-effect []
      (let [on-focus (fn [] (swap! tick* inc))
            every    (js/setInterval #(when (= "visible" (.-visibilityState js/document)) (swap! tick* inc)) 30000)]
        (.addEventListener js/window "focus" on-focus)
        (fn []
          (.removeEventListener js/window "focus" on-focus)
          (js/clearInterval every))))

    (mf/with-effect [comments]
      (let [timer (ts/schedule 2500 #(swap! tick* inc))]
        (fn [] (ts/dispose! timer))))

    (mf/with-effect [team-id file-id frame-id (deref tick*)]
      (let [live? (volatile! true)]
        (when (and enabled? team-id file-id)
          (-> (get-json "/api/eco/related" {:team (str team-id) :ref (design-ref file-id frame-id)})
              (.then (fn [body]
                       (when @live?
                         (reset! state* (when (map? body) {:key [file-id frame-id] :items (vec (:items body))})))))))
        (fn [] (vreset! live? false))))

    ;; Nothing while zvena is away or the person has no zvena session here.
    (when (and (some? state) (= (:key state) [file-id frame-id]))
      (let [items (->> (:items state)
                       (sort-by (fn [{:keys [card]}] (if (= "issue" (:kind card)) 0 1))))]
        [:div {:class (stl/css :element-set)}
         [:div {:class (stl/css :element-title)}
          [:> title-bar* {:collapsable false
                          :title (tr "zvena.bridge.related")}
           [:> icon-button* {:variant "ghost"
                             :aria-label (tr "zvena.bridge.new-issue")
                             :title (tr "zvena.bridge.new-issue")
                             :on-click on-new
                             :icon i/add}]]]
         (if (empty? items)
           [:div {:class (stl/css :empty)} (tr "zvena.bridge.related-empty")]
           [:ul {:class (stl/css :list)}
            (for [{:keys [card] :as item} (take 20 items)]
              [:> related-item* {:key (:key card) :item item}])])]))))
