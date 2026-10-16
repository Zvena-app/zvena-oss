;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.devmode-panel
  "zvena: what Figma's Dev Mode shows at the top of the inspect panel for
  the selected layer: the Ready for dev status of a top-level frame and
  the layer's annotation (text and pinned properties). Editors change
  both here; in the viewer's inspect tab they are read-only."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.types.shape.zvena :as ctsz]
   [app.main.data.workspace.zvena-devmode :as zdev]
   [app.main.store :as st]
   [app.main.ui.components.copy-button :refer [copy-button*]]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.workspace.sidebar.options.menus.zvena-dev-status :refer [dev-status-buttons*]]
   [app.main.ui.workspace.zvena.annotation-props :as zap]
   ;; zvena: Dev Mode compare changes
   [app.main.ui.workspace.zvena.compare-changes :as zcc]
   [app.main.ui.workspace.zvena.dev-status-badge :as zbadge :refer [dev-status-badge*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private annotation-edit-ref
  (l/derived zdev/annotation-editing st/state))

(defn- show-status?
  [shape objects can-edit?]
  (and (ctsz/top-level-frame? objects shape)
       (or can-edit? (some? (ctsz/dev-status shape)))))

(defn- show-annotation?
  [shape can-edit?]
  (or can-edit? (ctsz/annotated? shape)))

(defn panel-visible?
  "Whether `devmode-panel*` renders anything for this selection; the
  inspect sidebar uses it to give the panel its own grid row."
  [shapes objects from can-edit?]
  (let [can-edit? (and (= from :workspace) (boolean can-edit?))]
    (and (= 1 (count shapes))
         (let [shape (first shapes)]
           (or (show-status? shape objects can-edit?)
               (show-annotation? shape can-edit?))))))

(mf/defc annotation-editor*
  {::mf/private true}
  [{:keys [shape]}]
  (let [id        (:id shape)
        text*     (mf/use-state #(or (ctsz/annotation shape) ""))
        text      (deref text*)
        props*    (mf/use-state #(set (ctsz/annotation-props shape)))
        props     (deref props*)

        available
        (mf/with-memo [shape props]
          ;; keep a pinned prop listed even if the layer lost it
          (into (zap/applicable-props shape)
                (remove (set (zap/applicable-props shape)))
                (filter props zap/all-props)))

        on-change
        (mf/use-fn
         (fn [event]
           (reset! text* (dom/get-target-val event))))

        on-toggle-prop
        (mf/use-fn
         (fn [event]
           (let [prop (dom/get-data (dom/get-current-target event) "prop")]
             (swap! props* #(if (contains? % prop) (disj % prop) (conj % prop))))))

        on-save
        (mf/use-fn
         (mf/deps id text props)
         (fn []
           (st/emit! (zdev/set-annotation id text (filter props zap/all-props))
                     (zdev/stop-annotation))))

        on-cancel
        (mf/use-fn
         #(st/emit! (zdev/stop-annotation)))

        on-delete
        (mf/use-fn
         (mf/deps id)
         #(st/emit! (zdev/set-annotation id nil nil)
                    (zdev/stop-annotation)))

        on-key-down
        (mf/use-fn
         (mf/deps on-save on-cancel)
         (fn [event]
           (cond
             (kbd/esc? event)
             (do (dom/stop-propagation event)
                 (on-cancel))

             (and (kbd/enter? event) (kbd/mod? event))
             (do (dom/prevent-default event)
                 (on-save)))))]

    [:div {:class (stl/css :annotation-editor)}
     [:textarea {:class (stl/css :annotation-textarea)
                 :auto-focus true
                 :rows 4
                 :value text
                 :placeholder (tr "zvena.devmode.annotation.placeholder")
                 :aria-label (tr "zvena.devmode.annotation")
                 :on-change on-change
                 :on-key-down on-key-down}]

     (when (seq available)
       [:*
        [:div {:class (stl/css :props-title)}
         [:> icon* {:icon-id i/pin :size "s"}]
         [:span (tr "zvena.devmode.annotation.pin")]]
        [:div {:class (stl/css :props-list)}
         (for [prop available]
           (let [active? (contains? props prop)]
             [:button {:key prop
                       :class (stl/css-case :prop-chip true
                                            :active active?)
                       :aria-pressed active?
                       :data-prop prop
                       :on-click on-toggle-prop}
              (zap/prop-label prop)]))]])

     [:div {:class (stl/css :editor-actions)}
      (when (ctsz/annotated? shape)
        [:> button* {:variant "ghost"
                     :class (stl/css :delete-button)
                     :on-click on-delete}
         (tr "labels.delete")])
      [:> button* {:variant "secondary"
                   :on-click on-cancel}
       (tr "labels.cancel")]
      [:> button* {:variant "primary"
                   :on-click on-save}
       (tr "labels.save")]]]))

(mf/defc annotation-view*
  "The annotation as Figma shows it: the note, then the pinned properties
  with their current values."
  [{:keys [shape]}]
  (let [text  (ctsz/annotation shape)
        props (ctsz/annotation-props shape)]
    [:div {:class (stl/css :annotation-view)}
     (when (some? text)
       [:div {:class (stl/css :annotation-text)} text])
     (when (seq props)
       [:dl {:class (stl/css :annotation-props)}
        (for [prop props]
          [:div {:key prop :class (stl/css :prop-row)}
           [:dt {:class (stl/css :prop-name)} (zap/prop-label prop)]
           [:dd {:class (stl/css :prop-value)}
            (or (zap/prop-value shape prop) "—")]])])]))

(mf/defc annotation-block*
  {::mf/private true}
  [{:keys [shape can-edit]}]
  (let [id         (:id shape)
        editing-id (mf/deref annotation-edit-ref)
        editing?   (and can-edit (= editing-id id))
        annotated? (ctsz/annotated? shape)
        text       (ctsz/annotation shape)

        on-start
        (mf/use-fn
         (mf/deps id)
         #(st/emit! (zdev/start-annotation id)))]

    [:div {:class (stl/css :block)}
     [:> title-bar* {:collapsable false
                     :title (tr "zvena.devmode.annotation")}
      (cond
        (and can-edit (not editing?))
        [:> icon-button* {:variant "ghost"
                          :aria-label (if annotated?
                                        (tr "zvena.devmode.annotation.edit")
                                        (tr "zvena.devmode.annotation.add"))
                          :on-click on-start
                          :icon (if annotated? i/curve i/add)}]

        (and (not editing?) (some? text))
        [:> copy-button* {:data text
                          :class (stl/css :copy-button)}])]

     (cond
       editing?
       [:> annotation-editor* {:key (str id) :shape shape}]

       annotated?
       (if can-edit
         [:div {:class (stl/css :annotation-clickable)
                :role "button"
                :tab-index 0
                :title (tr "zvena.devmode.annotation.edit")
                :on-click on-start}
          [:> annotation-view* {:shape shape}]]
         [:> annotation-view* {:shape shape}])

       can-edit
       [:button {:class (stl/css :add-annotation)
                 :on-click on-start}
        [:> icon* {:icon-id i/add :size "s"}]
        [:span (tr "zvena.devmode.annotation.add")]])]))

(mf/defc devmode-panel*
  "`from` is :workspace or :viewer; `can-edit` the editor permission."
  [{:keys [shapes objects from can-edit]}]
  (let [can-edit? (and (= from :workspace) (boolean can-edit))
        shape     (when (= 1 (count shapes)) (first shapes))]
    (when (some? shape)
      [:div {:class (stl/css :devmode-panel)}
       (when (show-status? shape objects can-edit?)
         [:div {:class (stl/css :block)}
          [:> title-bar* {:collapsable false
                          :title (tr "zvena.devmode.status.title")}]
          (if can-edit?
            [:> dev-status-buttons* {:shape shape}]
            [:div {:class (stl/css :status-row)}
             [:> dev-status-badge* {:status (ctsz/dev-status shape)}]
             [:span {:class (stl/css :status-meta)}
              (zbadge/status-meta shape)]])
          ;; zvena: Figma's "Compare changes" with a saved version
          (when (= from :workspace)
            [:> button* {:variant "secondary"
                         :class (stl/css :compare-btn)
                         :data-testid "zvena-compare-changes-open"
                         :on-click (fn [_]
                                     (let [state @st/state]
                                       (st/emit! (zcc/open-compare (:current-file-id state)
                                                                   (:current-page-id state)
                                                                   (:id shape)))))}
             (tr "zvena.compare.open")])])

       (when (show-annotation? shape can-edit?)
         [:> annotation-block* {:shape shape
                                :can-edit can-edit?}])])))
