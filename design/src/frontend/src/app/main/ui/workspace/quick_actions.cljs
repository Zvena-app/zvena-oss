;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.quick-actions
  "Figma's Quick actions (Ctrl+/): search every workspace command by name and run it."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.types.components-list :as ctkl]
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.shortcuts :as sc]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.util.dom :as dom]
   [app.util.i18n :as i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [app.util.timers :as ts]
   [app.zvena.bridge :as zbridge]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(def ^:private hidden
  "Commands that make no sense from a list: modifiers, nudges, clipboard (needs a real key event)."
  #{:escape :quick-actions :copy :cut :paste :paste-replace :start-editing :show-measure
    :zoom-lense-increase :zoom-lense-decrease :select-prev :select-next})

(defn- hidden?
  [id]
  (let [n (d/name id)]
    (or (contains? hidden id)
        (str/starts-with? n "move-")
        (str/starts-with? n "opacity-")
        (str/starts-with? n "debug"))))

(defn- commands
  []
  (->> sc/shortcuts
       (keep (fn [[id {:keys [fn]}]]
               (when (and (some? fn) (not (hidden? id)))
                 (let [code  (dm/str "shortcuts." (d/name id))
                       label (tr code)]
                   (when (not= label code)
                     {:id id :label label :fn fn})))))
       (sort-by (comp str/lower :label))
       (vec)))

(defn- insert-component
  "zvena: a copy of the component in the middle of the visible canvas"
  [file-id component-id]
  (ptk/reify ::insert-component
    ptk/WatchEvent
    (watch [_ state _]
      (let [vbox   (get-in state [:workspace-local :vbox])
            center (if vbox (grc/rect->center vbox) (gpt/point 0 0))]
        (rx/of (dwl/instantiate-component file-id component-id center))))))

(defn- component-items
  "zvena: like Figma's Quick actions, the components of this file and its
  libraries can be found and placed from the same search."
  [files file-id can-edit?]
  (if-not can-edit?
    []
    (->> (refs/select-libraries files file-id)
         (mapcat (fn [[lib-id lib]]
                   (for [component (ctkl/components-seq (:data lib))]
                     {:id (keyword (dm/str "component-" (:id component)))
                      :label (:name component)
                      :hint (if (= lib-id file-id)
                              (tr "zvena.quick-actions.component")
                              (:name lib))
                      :fn #(st/emit! (insert-component lib-id (:id component)))})))
         (sort-by (comp str/lower :label))
         (vec))))

(defn- matches
  "Every word of the query must appear in the label; labels starting with the query go first."
  [items query]
  (let [q     (str/lower (str/trim query))
        words (str/split q #"\s+")]
    (if (str/empty? q)
      items
      (->> items
           (filter (fn [{:keys [label]}]
                     (let [l (str/lower label)]
                       (every? #(str/includes? l %) words))))
           (sort-by (fn [{:keys [label]}]
                      (if (str/starts-with? (str/lower label) q) 0 1)))))))

(mf/defc quick-actions*
  []
  (let [custom    (mf/deref refs/custom-shortcuts)
        locale    (mf/deref i18n/locale)
        all       (mf/with-memo [locale] (commands))
        query*    (mf/use-state "")
        query     (deref query*)
        current*  (mf/use-state 0)
        current   (deref current*)
        ;; zvena: its documents, issues and projects follow the commands
        found     (zbridge/use-search query)
        files     (mf/deref refs/files)
        file-id   (:id (mf/deref refs/file))
        can-edit? (:can-edit (mf/deref refs/permissions))
        comps     (mf/with-memo [files file-id can-edit?] (component-items files file-id can-edit?))
        ;; components only show up once something is typed
        items     (mf/with-memo [all comps query found]
                    (-> (vec (matches all query))
                        (into (when-not (str/blank? query) (take 30 (matches comps query))))
                        (into found)))
        list-ref  (mf/use-ref nil)

        close
        (mf/use-fn #(st/emit! (dw/remove-layout-flag :quick-actions)))

        run
        (mf/use-fn
         (mf/deps close)
         (fn [{:keys [fn]}]
           (close)
           ;; let the panel unmount and focus return to the canvas first
           (ts/schedule 0 fn)))

        on-change
        (mf/use-fn
         (fn [event]
           (reset! query* (dom/get-value (dom/get-target event)))
           (reset! current* 0)))

        on-key-down
        (mf/use-fn
         (mf/deps items current run close)
         (fn [event]
           (dom/stop-propagation event)
           (cond
             (kbd/esc? event)
             (do (dom/prevent-default event) (close))

             (kbd/down-arrow? event)
             (do (dom/prevent-default event)
                 (swap! current* #(min (dec (count items)) (inc %))))

             (kbd/up-arrow? event)
             (do (dom/prevent-default event)
                 (swap! current* #(max 0 (dec %))))

             (kbd/enter? event)
             (when-let [item (get items current)]
               (dom/prevent-default event)
               (run item)))))

        on-item-click
        (mf/use-fn
         (mf/deps items run)
         (fn [event]
           (let [idx (-> (dom/get-current-target event) (dom/get-data "index") d/parse-integer)]
             (some-> (get items idx) run))))

        on-item-hover
        (mf/use-fn
         (fn [event]
           (reset! current* (-> (dom/get-current-target event) (dom/get-data "index") d/parse-integer))))]

    ;; keep the highlighted row in view
    (mf/with-effect [current]
      (when-let [node (some-> (mf/ref-val list-ref) (dom/query (dm/str "[data-index=\"" current "\"]")))]
        (dom/scroll-into-view-if-needed! node)))

    [:div {:class (stl/css :quick-actions-overlay)
           :on-pointer-down close}
     [:div {:class (stl/css :quick-actions)
            :role "dialog"
            :aria-label (tr "blueai.quick-actions.title")
            :on-pointer-down dom/stop-propagation}
      [:div {:class (stl/css :search)}
       [:> icon* {:icon-id i/search :size "s" :class (stl/css :search-icon)}]
       [:input {:class (stl/css :search-input)
                :auto-focus true
                :value query
                :placeholder (tr "blueai.quick-actions.placeholder")
                :aria-label (tr "blueai.quick-actions.placeholder")
                :on-change on-change
                :on-key-down on-key-down}]]
      (if (empty? items)
        [:div {:class (stl/css :empty)} (tr "blueai.quick-actions.empty")]
        [:ul {:class (stl/css :list) :role "listbox" :ref list-ref}
         (for [[idx {:keys [id label hint]}] (map-indexed vector items)]
           [:li {:key (d/name id)
                 :class (stl/css-case :item true :current (= idx current))
                 :role "option"
                 :aria-selected (= idx current)
                 :data-index idx
                 :on-click on-item-click
                 :on-pointer-move on-item-hover}
            [:span {:class (stl/css :item-label)} label]
            [:span {:class (stl/css :item-shortcut)}
             (or hint (sc/get-effective-tooltip id custom))]])])]]))
