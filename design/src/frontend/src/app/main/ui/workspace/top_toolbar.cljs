;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.top-toolbar
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.geom.point :as gpt]
   [app.config :as cf]
   [app.main.data.event :as ev]
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.common :as dwc]
   [app.main.data.workspace.drawing.common :as dwdc]
   [app.main.data.workspace.mcp :as mcp]
   [app.main.data.workspace.media :as dwm]
   [app.main.data.workspace.shortcuts :as sc]
   [app.main.features :as features]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.dropdown-menu :refer [dropdown-menu* dropdown-menu-item*]]
   [app.main.ui.components.file-uploader :as file-uploader]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private toolbar-hidden-ref
  (l/derived (fn [state]
               (let [visibility      (get state :hide-toolbar)
                     path-edit-state (get state :edit-path)
                     selected        (get state :selected)
                     edition         (get state :edition)

                     is-single       (= (count selected) 1)
                     is-path-editing (and is-single (some? (get path-edit-state edition)))]

                 (if is-path-editing true visibility)))
             refs/workspace-local))

;; Figma UI3 toolbar groups — a tool button plus a chevron that
;; opens a dark menu (icon, name, shortcut). The button keeps the last tool
;; picked in its group.
(def grouped-tools
  {;; zvena: Move / Hand, as in Figma (V / H)
   :pointer {:default-tool :move
             :tools [[:move i/move]
                     [:hand i/hand]
                     [:scale i/scale]]}
   ;; zvena: Frame / Section (F / Shift+S)
   :frame {:default-tool :frame
           :tools [[:frame i/board]
                   [:section i/section]
                   [:slice i/slice]]}
   :shapes {:default-tool :rect
            :tools [[:rect i/rectangle]
                    [:line i/easing-linear]
                    [:arrow i/stroke-arrow]
                    [:circle i/ellipse]
                    [:polygon i/polygon]
                    [:star i/star]
                    [:image i/img]]}
   :free-draw {:default-tool :path
               :tools [[:path i/pentool]
                       [:curve i/curve]]}})

(defn- tool-shortcut
  [tool]
  (case tool
    :move    (sc/get-tooltip :move)
    :hand    (sc/get-tooltip :hand-tool)
    :scale   (sc/get-tooltip :scale)
    :frame   (sc/get-tooltip :draw-frame)
    :section (sc/get-tooltip :draw-section)
    :slice   (sc/get-tooltip :draw-slice)
    :rect    (sc/get-tooltip :draw-rect)
    :circle  (sc/get-tooltip :draw-ellipse)
    :polygon nil
    :star    nil
    :line    (sc/get-tooltip :draw-line)
    :arrow   (sc/get-tooltip :draw-arrow)
    :text    (sc/get-tooltip :draw-text)
    :path    (sc/get-tooltip :draw-path)
    :image   (sc/get-tooltip :insert-image)
    :curve   (sc/get-tooltip :draw-curve)
    :comments (sc/get-tooltip :add-comment)
    :plugins (sc/get-tooltip :plugins)
    nil))

(defn- tool-label
  [tool]
  (case tool
    :move    (tr "workspace.toolbar.move"    (tool-shortcut :move))
    :hand    (tr "workspace.toolbar.hand"    (tool-shortcut :hand))
    :scale   (tr "zvena.toolbar.scale"       (tool-shortcut :scale))
    :frame   (tr "workspace.toolbar.frame"   (tool-shortcut :frame))
    :section (tr "zvena.section.tool"        (tool-shortcut :section))
    :slice   (tr "zvena.slice.tool"          (tool-shortcut :slice))
    :rect    (tr "workspace.toolbar.rect"    (tool-shortcut :rect))
    :circle  (tr "workspace.toolbar.ellipse" (tool-shortcut :circle))
    :polygon (tr "workspace.toolbar.polygon")
    :star    (tr "workspace.toolbar.star")
    :line    (tr "workspace.toolbar.line"    (tool-shortcut :line))
    :arrow   (tr "workspace.toolbar.arrow"   (tool-shortcut :arrow))
    :text    (tr "workspace.toolbar.text"    (tool-shortcut :text))
    :path    (tr "workspace.toolbar.path"    (tool-shortcut :path))
    :image   (tr "workspace.toolbar.image"   (tool-shortcut :image))
    :curve   (tr "workspace.toolbar.curve"   (tool-shortcut :curve))
    :comments (tr "workspace.toolbar.comments" (tool-shortcut :comments))
    :plugins (tr "workspace.toolbar.plugins" (tool-shortcut :plugins))
    :debug   "Debugging tool"
    (name tool)))

(defn- tool-name
  "The label without the \" (shortcut)\" suffix, for menus."
  [tool]
  (-> (tool-label tool)
      (str/replace #"\s*\([^()]*\)\s*$" "")))

(defn- group-has-tool?
  [group tool]
  (some #(= tool (first %)) (:tools group)))

(defn- tool-icon
  [group tool]
  (some (fn [[id icon]] (when (= id tool) icon)) (:tools group)))

(mf/defc group-tool*
  {::mf/private true
   ::mf/wrap [mf/memo]}
  [{:keys [group drawtool on-select on-image selected]}]
  (let [current*  (mf/use-state (if (group-has-tool? group drawtool)
                                  drawtool
                                  (:default-tool group)))
        current   (deref current*)

        open*     (mf/use-state false)
        open?     (deref open*)

        ;; The pointer group (Move / Hand) passes its own state: Move is
        ;; "no drawing tool", so it can't be derived from drawtool.
        selected? (if (some? selected)
                    (boolean selected)
                    (boolean (group-has-tool? group drawtool)))

        pick
        (mf/use-fn
         (mf/deps on-select on-image)
         (fn [tool]
           (if (= tool :image)
             (on-image)
             (on-select tool))))

        on-main-click
        (mf/use-fn
         (mf/deps current pick)
         (fn [_] (pick current)))

        toggle-menu
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (swap! open* not)))

        close-menu
        (mf/use-fn #(reset! open* false))

        on-item-click
        (mf/use-fn
         (mf/deps pick)
         (fn [event]
           (let [tool (-> (dom/get-current-target event)
                          (dom/get-data "tool")
                          (keyword))]
             (reset! open* false)
             (when (not= tool :image)
               (reset! current* tool))
             (pick tool))))]

    (mf/with-effect [drawtool]
      (when (and (group-has-tool? group drawtool) (not= drawtool :image))
        (reset! current* drawtool))
      (when (and (nil? drawtool) (group-has-tool? group :move))
        (reset! current* :move)))

    (mf/with-effect []
      (let [subs (->> st/stream
                      (rx/filter #(= % :interrupt))
                      (rx/subs! #(reset! open* false)))]
        #(rx/dispose! subs)))

    [:li {:class (stl/css :toolbar-group)}
     [:> icon-button* {:variant "ghost"
                       :tooltip-placement "top"
                       :aria-label (tool-label current)
                       :aria-pressed selected?
                       :icon (tool-icon group current)
                       :on-click on-main-click
                       :data-tool (name current)}]
     [:button {:class (stl/css-case :toolbar-chevron true
                                    :open open?)
               :aria-haspopup true
               :aria-expanded open?
               :aria-label (str (tr "labels.options") ": " (tool-name current))
               :on-click toggle-menu}
      [:> icon* {:icon-id i/arrow-down :size "s"}]]

     ;; zvena: an id makes opening one group's menu close the other's
     [:> dropdown-menu* {:show open?
                         :id (str "toolbar-group-" (name (:default-tool group)))
                         :on-close close-menu
                         :class (stl/css :toolbar-menu)}
      (for [[id icon] (:tools group)]
        [:> dropdown-menu-item* {:key (name id)
                                 :class (stl/css :toolbar-menu-item)
                                 :data-tool (name id)
                                 :on-click on-item-click}
         [:span {:class (stl/css :toolbar-menu-check)}
          (when (or (= id drawtool)
                    (and (= id :move) (nil? drawtool) selected?))
            [:> icon* {:icon-id i/tick :size "s"}])]
         [:> icon* {:icon-id icon :size "s" :class (stl/css :toolbar-menu-icon)}]
         [:span {:class (stl/css :toolbar-menu-label)} (tool-name id)]
         [:span {:class (stl/css :toolbar-menu-shortcut)} (tool-shortcut id)]])]]))

(mf/defc image-uploader*
  "Hidden file input for the Image tool (opened from the shapes menu or
  the shortcut)."
  {::mf/private true}
  [{:keys [input-ref]}]
  (let [file-id  (mf/use-ctx ctx/current-file-id)

        on-selected
        (mf/use-fn
         (mf/deps file-id)
         (fn [blobs]
           ;; We don't want to add a ref because that redraws the component
           ;; for everychange. Better direct access on the callback.
           (let [vbox   (deref refs/vbox)
                 x      (+ (:x vbox) (/ (:width vbox) 2))
                 y      (+ (:y vbox) (/ (:height vbox) 2))
                 params {:file-id file-id
                         :blobs (seq blobs)
                         :position (gpt/point x y)}]
             (st/emit! (dwm/upload-media-workspace params)))))]

    [:& file-uploader/file-uploader {:input-id "image-upload"
                                     :accept dwm/accept-image-types
                                     :multi true
                                     :ref input-ref
                                     :on-selected on-selected}]))

(mf/defc mcp-tool*
  {::mf/private true
   ::mf/wrap [mf/memo]}
  [{:keys [is-mcp-connected]}]
  (let [menu-open*   (mf/use-state false)
        menu-open?   (deref menu-open*)

        on-toggle-menu
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (swap! menu-open* not)))

        on-close-menu
        (mf/use-fn
         #(reset! menu-open* false))

        on-connect
        (mf/use-fn
         #(st/emit! (mcp/connect-mcp)
                    (ev/event {::ev/name "connect-mcp-plugin"
                               ::ev/origin "workspace:toolbar"})))]

    [:*
     [:> button* {:variant "ghost"
                  :on-click on-toggle-menu
                  :aria-pressed menu-open?
                  :data-tool "mcp"
                  :data-testid "mcp-btn"}
      [:div {:class (stl/css-case :toolbar-mcp-button true
                                  :selected menu-open?)}
       [:span {:class (stl/css-case :toolbar-mcp-button-dot true
                                    :connected is-mcp-connected)}]
       [:span {:class (stl/css-case :toolbar-mcp-button-label true
                                    :connected is-mcp-connected)}
        (tr "workspace.toolbar.mcp")]]]

     [:div {:class (stl/css :toolbar-mcp-menu)}
      [:> dropdown-menu* {:show menu-open?
                          :on-close on-close-menu
                          :class (stl/css :toolbar-mcp-dropdown)}
       (if is-mcp-connected
         [:li {:class (stl/css :toolbar-mcp-dropdown-info)
               :role "presentation"}
          (tr "workspace.toolbar.mcp-connected")]
         [:> dropdown-menu-item* {:class (stl/css :toolbar-mcp-dropdown-item)
                                  :on-click on-connect}
          (tr "workspace.toolbar.mcp-connect-here")])]]]))

(mf/defc top-toolbar*
  {::mf/wrap [mf/memo]}
  [{:keys [layout palette-size]}]
  (let [selected-drawing-tool (mf/deref refs/selected-drawing-tool)
        selected-edition      (mf/deref refs/selected-edition)
        rulers-enabled        (mf/deref refs/rulers?)
        toolbar-hidden        (mf/deref toolbar-hidden-ref)
        options-mode          (mf/deref refs/options-mode-global)
        mcp                   (mf/deref refs/mcp)
        upload-ref            (mf/use-ref nil)

        plugins-enabled? (features/active-feature? @st/state "plugins/runtime")
        read-only?       (mf/use-ctx ctx/workspace-read-only?)
        can-edit?        (:can-edit (mf/deref refs/permissions))

        ;; zvena: the unread-comments dot the upstream header had, now on the
        ;; toolbar's comments button (as in Figma).
        file-id          (mf/use-ctx ctx/current-file-id)
        threads-map      (mf/deref refs/threads)
        has-unread-comments?
        (mf/with-memo [threads-map file-id]
          (->> (vals threads-map)
               (some #(and (= (:file-id %) file-id)
                           (pos? (:count-unread-comments %))))
               (boolean)))
        dev-mode?        (= options-mode :inspect)

        mcp-conn-status  (get mcp :connection-status)
        mcp-valid-token? (get mcp :token-valid)
        mcp-enabled?     (get mcp :enabled)

        mcp-connected?   (= "connected" mcp-conn-status)
        mcp-show?        (and (contains? cf/flags :mcp)
                              mcp-enabled?
                              mcp-valid-token?)

        on-toggle-debug-panel
        (mf/use-fn
         (mf/deps layout)
         (fn []
           (let [is-sidebar-closed (contains? layout :collapse-left-sidebar)]
             (when is-sidebar-closed
               (st/emit! (dw/toggle-layout-flag :collapse-left-sidebar)))
             (st/emit! (dw/remove-layout-flag :shortcuts)
                       (-> (dw/toggle-layout-flag :debug-panel)
                           (vary-meta assoc ::ev/origin "workspace-left-toolbar"))))))

        on-interrupt
        (mf/use-fn
         (fn []
           (st/emit! :interrupt
                     (dw/clear-edition-mode)
                     (dwdc/clear-drawing))))

        select-tool
        (mf/use-fn
         (fn [tool]
           (st/emit! :interrupt
                     (dw/clear-edition-mode)
                     (dw/select-for-drawing tool))))

        ;; zvena: Move / Hand / Scale (K), as Figma's first toolbar group
        select-pointer-tool
        (mf/use-fn
         (mf/deps on-interrupt select-tool)
         (fn [tool]
           (case tool
             :move  (do (on-interrupt)
                        (st/emit! (dw/remove-layout-flag :scale-text)))
             :scale (do (on-interrupt)
                        (st/emit! (dw/toggle-layout-flag :scale-text :force? true)))
             (select-tool tool))))

        open-actions
        (mf/use-fn
         #(st/emit! (dw/toggle-layout-flag :quick-actions :force? true)))

        on-select-tool
        (mf/use-fn
         (mf/deps select-tool)
         (fn [event]
           (select-tool (-> (dom/get-current-target event)
                            (dom/get-data "tool")
                            (keyword)))))

        on-image
        (mf/use-fn
         (fn []
           (st/emit! :interrupt (dw/clear-edition-mode))
           (dom/click (mf/ref-val upload-ref))))

        on-toggle-comments
        (mf/use-fn
         (mf/deps selected-drawing-tool)
         (fn []
           (if (= selected-drawing-tool :comments)
             (st/emit! (dwdc/clear-drawing))
             (st/emit! :interrupt
                       (dw/clear-edition-mode)
                       (-> (dw/remove-layout-flag :document-history)
                           (vary-meta assoc ::ev/origin "workspace-toolbar"))
                       (dw/select-for-drawing :comments)))))

        on-design-mode
        (mf/use-fn
         (fn []
           (st/emit! (dw/set-options-mode :design)
                     :interrupt
                     (dwc/set-workspace-read-only false))))

        on-dev-mode
        (mf/use-fn
         (fn []
           (st/emit! (dw/set-options-mode :inspect)
                     :interrupt
                     (dwc/set-workspace-read-only true))))

        on-toggle-toolbar
        (mf/use-fn
         (fn [event]
           (dom/blur! (dom/get-target event))
           (st/emit! (dwc/toggle-toolbar-visibility))))]

    ;; Figma UI3 toolbar. In Dev Mode only the mode switch remains.
    [:div {:role "toolbar"
           :aria-label (tr "workspace.toolbar.label")
           :tab-index "0"
           :class (stl/css-case :toolbar true
                                :no-rulers (not rulers-enabled)
                                :hidden toolbar-hidden)
           :style (when palette-size
                    #js {"--blueai-toolbar-bottom" (str (+ palette-size 16) "px")})}
     [:ul {:class (stl/css :toolbar-options)
           :data-testid "toolbar-options"}
      (when-not (or ^boolean read-only? dev-mode?)
        [:*
         [:> group-tool* {:key :pointer
                          :group (get grouped-tools :pointer)
                          :drawtool (cond
                                      (= selected-drawing-tool :hand) :hand
                                      (and (nil? selected-drawing-tool)
                                           (contains? layout :scale-text)) :scale
                                      :else selected-drawing-tool)
                          :selected (or (= selected-drawing-tool :hand)
                                        (and (nil? selected-drawing-tool)
                                             (not selected-edition)))
                          :on-select select-pointer-tool
                          :on-image on-image}]

         [:> group-tool* {:key :frame
                          :group (get grouped-tools :frame)
                          :drawtool selected-drawing-tool
                          :on-select select-tool
                          :on-image on-image}]

         [:> group-tool* {:key :shapes
                          :group (get grouped-tools :shapes)
                          :drawtool selected-drawing-tool
                          :on-select select-tool
                          :on-image on-image}]

         [:> group-tool* {:key :free-draw
                          :group (get grouped-tools :free-draw)
                          :drawtool selected-drawing-tool
                          :on-select select-tool
                          :on-image on-image}]

         [:li {:class (stl/css :toolbar-option)}
          [:> icon-button* {:variant "ghost"
                            :tooltip-placement "top"
                            :aria-pressed (= selected-drawing-tool :text)
                            :aria-label (tool-label :text)
                            :icon i/text
                            :on-click on-select-tool
                            :data-tool "text"}]]])

      [:li {:class (stl/css :toolbar-option)}
       [:> icon-button* {:variant "ghost"
                         :tooltip-placement "top"
                         :aria-pressed (= selected-drawing-tool :comments)
                         :aria-label (tool-label :comments)
                         :icon i/comments
                         :on-click on-toggle-comments
                         :data-tool "comments"}]
       (when ^boolean has-unread-comments?
         [:span {:class (stl/css :unread)}])]

      (when *assert*
        [:li {:class (stl/css :toolbar-option)}
         [:> icon-button* {:variant "ghost"
                           :tooltip-placement "top"
                           :aria-pressed (contains? layout :debug-panel)
                           :aria-label (tool-label :debug)
                           :icon i/bug
                           :on-click on-toggle-debug-panel}]])

      (when mcp-show?
        [:li {:class (stl/css :toolbar-option)}
         [:> mcp-tool* {:is-mcp-connected mcp-connected?}]])

      ;; zvena: Figma UI3's "Actions" button (quick actions, Ctrl+K)
      (when-not ^boolean read-only?
        [:li {:class (stl/css :toolbar-option)}
         [:> icon-button* {:variant "ghost"
                           :tooltip-placement "top"
                           :aria-label (str (tr "zvena.toolbar.actions") " (" (sc/get-tooltip :quick-actions) ")")
                           :icon i/search
                           :on-click open-actions}]])

      ;; Mode switch, as in Figma: Design | Dev Mode (Shift+D). zvena: not
      ;; for viewers, who can't leave the read-only mode anyway.
      (when can-edit?
        [:div {:class (stl/css :toolbar-separator)}])

      (when can-edit?
        [:li {:class (stl/css :toolbar-modes)}
         [:> icon-button* {:variant "ghost"
                           :class (stl/css :mode-btn)
                           :tooltip-placement "top"
                           :aria-pressed (not dev-mode?)
                           :aria-label (tr "blueai.toolbar.design-mode")
                           :icon i/move
                           :on-click on-design-mode}]
         [:> icon-button* {:variant "ghost"
                           :class (stl/css :mode-btn :mode-btn-dev)
                           :tooltip-placement "top"
                           :aria-pressed dev-mode?
                           :aria-label (str (tr "blueai.toolbar.dev-mode") " (" (sc/get-tooltip :toggle-dev-mode) ")")
                           :icon i/code
                           :on-click on-dev-mode}]])]

     ;; zvena: the hidden file input exists only while the file can be
     ;; edited, so the image shortcut can't add images in Dev Mode.
     (when-not (or ^boolean read-only? dev-mode?)
       [:> image-uploader* {:input-ref upload-ref}])

     [:button {:title (tr "workspace.toolbar.toggle-toolbar")
               :aria-label (tr "workspace.toolbar.toggle-toolbar")
               :class (stl/css :toolbar-handler)
               :on-click on-toggle-toolbar}
      [:div {:class (stl/css :toolbar-handler-indicator)}]]]))
