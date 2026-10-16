;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.style-picker
  "zvena: Figma's style button (four dots) of the Effects and Layout grid
  sections: the list of the effect / grid styles of the file and its
  libraries, with \"+\" to create a style from the selection; and the row
  that replaces the values when a style is applied (name, edit, detach)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.common.types.shape.zvena-effects :as zfx]
   [app.main.data.workspace.zvena-styles :as zst]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.dropdown :refer [dropdown]]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private picker-width 240)

(defn kind-title
  [kind]
  (case kind
    :effect (tr "zvena.styles.effect-styles")
    :grid   (tr "zvena.styles.grid-styles")))

(defn style-icon
  "Icon of a style: the type of its first effect / grid."
  [kind value]
  (case kind
    :effect (cond
              (seq (:shadow value))
              (if (= :inner-shadow (:style (first (:shadow value))))
                i/inner-shadow
                i/drop-shadow)
              (or (some? (:blur value)) (some? (:background-blur value)))
              i/filter
              :else
              i/effects)
    :grid   (case (:type (first value))
              :column i/grid-columns
              :row    i/grid-rows
              i/grid-square)))

(defn editor-position
  "Where the floating style editor opens, left of `node`."
  [node]
  (let [{:keys [left top]} (dom/get-bounding-rect node)
        {:keys [height]}   (dom/get-window-size)]
    {:x (max 8 (- left 280))
     :y (max 8 (min top (- height 480)))}))

(mf/defc styles-icon*
  "Figma's four dots \"Apply styles\" glyph."
  {::mf/private true}
  []
  [:svg {:class (stl/css :styles-glyph)
         :view-box "0 0 16 16"
         :width 16
         :height 16
         :aria-hidden true}
   [:circle {:cx 5 :cy 5 :r 1.4}]
   [:circle {:cx 11 :cy 5 :r 1.4}]
   [:circle {:cx 5 :cy 11 :r 1.4}]
   [:circle {:cx 11 :cy 11 :r 1.4}]])

(mf/defc create-style-form*
  {::mf/private true}
  [{:keys [kind on-submit on-cancel]}]
  (let [input-ref (mf/use-ref nil)

        submit
        (mf/use-fn
         (mf/deps on-submit)
         (fn []
           (when-let [input (mf/ref-val input-ref)]
             (on-submit (dom/get-value input)))))

        on-key-down
        (mf/use-fn
         (mf/deps submit on-cancel)
         (fn [event]
           (cond
             (kbd/enter? event) (do (dom/prevent-default event) (submit))
             (kbd/esc? event)   (do (dom/stop-propagation event) (on-cancel)))))]

    (mf/with-effect []
      (when-let [input (mf/ref-val input-ref)]
        (dom/focus! input)))

    [:div {:class (stl/css :create-form)}
     [:div {:class (stl/css :create-title)}
      (case kind
        :effect (tr "zvena.styles.create-effect")
        :grid   (tr "zvena.styles.create-grid"))]
     [:input {:ref input-ref
              :class (stl/css :create-input)
              :type "text"
              :placeholder (tr "zvena.styles.name")
              :aria-label (tr "zvena.styles.name")
              :on-key-down on-key-down}]
     [:button {:class (stl/css :create-button)
               :on-click submit}
      (tr "zvena.styles.create")]]))

(mf/defc style-item*
  {::mf/private true}
  [{:keys [kind style file-id selected on-apply]}]
  (let [on-click
        (mf/use-fn
         (mf/deps on-apply file-id style)
         (fn [_]
           (on-apply file-id (:id style))))]
    [:button {:class (stl/css-case :style-item true
                                   :selected selected)
              :title (:name style)
              :on-click on-click}
     [:span {:class (stl/css :style-item-icon)}
      [:> icon* {:icon-id (style-icon kind (:value style)) :size "s"}]]
     [:span {:class (stl/css :style-item-name)} (:name style)]]))

(mf/defc style-picker*
  "The list of styles of `kind`; applies the one clicked to `ids`."
  [{:keys [kind ids position selected-ref on-close]}]
  (let [files     (mf/deref refs/files)
        file-id   (mf/use-ctx ctx/current-file-id)
        read-only (mf/use-ctx ctx/workspace-read-only?)
        container (mf/use-ref nil)

        {:keys [local libraries]}
        (mf/with-memo [files file-id kind]
          (zst/style-libraries files file-id kind))

        creating* (mf/use-state false)
        creating? (deref creating*)

        on-apply
        (mf/use-fn
         (mf/deps kind ids on-close)
         (fn [style-file-id style-id]
           (st/emit! (zst/apply-style kind ids style-file-id style-id))
           (on-close)))

        on-create
        (mf/use-fn
         (mf/deps kind ids on-close)
         (fn [name]
           (st/emit! (zst/create-style kind name ids))
           (on-close)))

        toggle-create
        (mf/use-fn #(swap! creating* not))

        cancel-create
        (mf/use-fn #(reset! creating* false))]

    [:& dropdown {:show true :on-close on-close :container container}
     [:div {:class (stl/css :picker)
            :ref container
            :style {:left (:x position)
                    :top (:y position)
                    :max-height (:max-height position)}
            :data-testid (dm/str "zvena-" (name kind) "-style-picker")}
      [:div {:class (stl/css :picker-header)}
       [:span {:class (stl/css :picker-title)} (kind-title kind)]
       (when-not read-only
         [:> icon-button* {:variant "ghost"
                           :icon i/add
                           :aria-label (tr "zvena.styles.create")
                           :on-click toggle-create}])]

      (when creating?
        [:> create-style-form* {:kind kind
                                :on-submit on-create
                                :on-cancel cancel-create}])

      [:div {:class (stl/css :picker-list)}
       (when (seq local)
         [:div {:class (stl/css :picker-group)}
          [:div {:class (stl/css :picker-group-title)} (tr "zvena.styles.local")]
          (for [style local]
            [:> style-item* {:key (dm/str (:id style))
                             :kind kind
                             :style style
                             :file-id file-id
                             :selected (= selected-ref (zfx/style-ref file-id (:id style)))
                             :on-apply on-apply}])])

       (for [[file styles] libraries]
         [:div {:class (stl/css :picker-group)
                :key (dm/str (:id file))}
          [:div {:class (stl/css :picker-group-title)} (:name file)]
          (for [style styles]
            [:> style-item* {:key (dm/str (:id style))
                             :kind kind
                             :style style
                             :file-id (:id file)
                             :selected (= selected-ref (zfx/style-ref (:id file) (:id style)))
                             :on-apply on-apply}])])

       (when (and (empty? local) (empty? libraries) (not creating?))
         [:div {:class (stl/css :picker-empty)} (tr "zvena.styles.no-styles")])]]]))

(defn- picker-position
  [node]
  (let [{:keys [right bottom]} (dom/get-bounding-rect node)
        {:keys [height]}       (dom/get-window-size)
        top                    (+ bottom 4)]
    {:x (max 8 (- right picker-width))
     :y top
     :max-height (max 160 (- height top 8))}))

(mf/defc style-button*
  "The four dots button of a section header: opens the style picker."
  [{:keys [kind ids selected-ref]}]
  (let [position* (mf/use-state nil)
        position  (deref position*)

        on-click
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (let [node (dom/get-current-target event)]
             (swap! position* #(when (nil? %) (picker-position node))))))

        on-close
        (mf/use-fn #(reset! position* nil))]

    [:*
     [:button {:class (stl/css-case :styles-button true
                                    :selected (some? position))
               :title (tr "zvena.styles.apply")
               :aria-label (tr "zvena.styles.apply")
               :data-testid (dm/str "zvena-" (name kind) "-styles-button")
               :on-click on-click}
      [:> styles-icon*]]
     (when (some? position)
       [:> style-picker* {:kind kind
                          :ids ids
                          :position position
                          :selected-ref selected-ref
                          :on-close on-close}])]))

(defn- style-ref-lens
  [kind ref-str]
  (let [parsed (zfx/parse-style-ref ref-str)]
    (l/derived (fn [state]
                 (when (some? parsed)
                   (let [[file-id style-id] parsed]
                     (zfx/get-style (dm/get-in state [:files file-id :data]) kind style-id))))
               st/state)))

(mf/defc applied-style-row*
  "Figma's row of an applied style: its name (opens the picker to swap
  it), edit (local styles) and detach."
  [{:keys [kind ids ref-str]}]
  (let [file-id    (mf/use-ctx ctx/current-file-id)
        read-only  (mf/use-ctx ctx/workspace-read-only?)
        [style-file-id style-id] (zfx/parse-style-ref ref-str)
        style-ref  (mf/with-memo [kind ref-str] (style-ref-lens kind ref-str))
        style      (mf/deref style-ref)
        local?     (= style-file-id file-id)

        position*  (mf/use-state nil)
        position   (deref position*)

        on-open-picker
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (let [node (dom/get-current-target event)]
             (swap! position* #(when (nil? %) (picker-position node))))))

        on-close-picker
        (mf/use-fn #(reset! position* nil))

        on-detach
        (mf/use-fn
         (mf/deps kind ids)
         (fn [_]
           (st/emit! (zst/detach-style kind ids))))

        on-edit
        (mf/use-fn
         (mf/deps kind style-id)
         (fn [event]
           (dom/stop-propagation event)
           (st/emit! (zst/open-style-editor kind style-id
                                            (editor-position (dom/get-current-target event))))))]

    [:div {:class (stl/css :applied-style)
           :data-testid (dm/str "zvena-applied-" (name kind) "-style")}
     [:button {:class (stl/css :applied-style-main)
               :title (or (:name style) (tr "zvena.styles.missing"))
               :disabled read-only
               :on-click on-open-picker}
      [:span {:class (stl/css :style-item-icon)}
       [:> icon* {:icon-id (if (some? style) (style-icon kind (:value style)) (if (= kind :grid) i/grid i/effects))
                  :size "s"}]]
      [:span {:class (stl/css-case :style-item-name true
                                   :missing (nil? style))}
       (if (some? style)
         (:name style)
         (tr "zvena.styles.missing"))]]
     (when (and local? (some? style) (not read-only))
       [:> icon-button* {:variant "ghost"
                         :icon i/settings
                         :aria-label (tr "zvena.styles.edit-style")
                         :data-testid "zvena-edit-style"
                         :on-click on-edit}])
     (when-not read-only
       [:> icon-button* {:variant "ghost"
                         :icon i/detach
                         :aria-label (tr "zvena.styles.detach")
                         :on-click on-detach}])
     (when (some? position)
       [:> style-picker* {:kind kind
                          :ids ids
                          :position position
                          :selected-ref ref-str
                          :on-close on-close-picker}])]))

(defn blank-name?
  [s]
  (str/blank? s))
