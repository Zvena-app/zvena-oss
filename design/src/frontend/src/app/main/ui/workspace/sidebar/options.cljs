;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.sidebar.options
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.shapes :as gsh]
   [app.common.types.shape.layout :as ctl]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace :as udw]
   [app.main.data.workspace.common :as dwc]
   [app.main.features :as features]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.context :as ctx]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.layout.tab-switcher :refer [tab-switcher*]]
   [app.main.ui.workspace.right-header :refer [zoom-control*]]
   [app.main.ui.inspect.right-sidebar :as hrs]
   [app.main.ui.workspace.sidebar.debug-shape-info :refer [debug-shape-info*]]
   [app.main.ui.workspace.sidebar.options.drawing :as drawing]
   [app.main.ui.workspace.sidebar.options.menus.align :refer [align-options*]]
   [app.main.ui.workspace.sidebar.options.menus.bool :refer [bool-options*]]
   [app.main.ui.workspace.sidebar.options.menus.component :refer [component-menu*]]
   [app.main.ui.workspace.sidebar.options.menus.grid-cell :as grid-cell]
   [app.main.ui.workspace.sidebar.options.menus.interactions :refer [interactions-menu*]]
   [app.main.ui.workspace.sidebar.options.menus.layout-container :as layout-container]
   [app.main.ui.workspace.sidebar.options.menus.zvena-component-props :refer [layer-binding*]]
   [app.main.ui.workspace.sidebar.options.menus.zvena-prototype-settings :refer [prototype-settings*]]
   [app.main.ui.workspace.sidebar.options.menus.zvena-scroll :refer [scroll-behavior*]] ;; zvena: scroll behavior
   [app.main.ui.workspace.sidebar.options.page :as page]
   [app.main.ui.workspace.sidebar.options.shapes.bool :as bool]
   [app.main.ui.workspace.sidebar.options.shapes.circle :as circle]
   [app.main.ui.workspace.sidebar.options.shapes.frame :as frame]
   [app.main.ui.workspace.sidebar.options.shapes.group :as group]
   [app.main.ui.workspace.sidebar.options.shapes.multiple :as multiple]
   [app.main.ui.workspace.sidebar.options.shapes.path :as path]
   [app.main.ui.workspace.sidebar.options.shapes.rect :as rect]
   [app.main.ui.workspace.sidebar.options.shapes.svg-raw :as svg-raw]
   [app.main.ui.workspace.sidebar.options.shapes.text :as text]
   [app.util.debug :as dbg]
   [app.util.i18n :as i18n :refer [tr]]
   [app.zvena.bridge :as zbridge]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

;; --- Options

(mf/defc single-shape-options*
  {::mf/private true}
  [{:keys [shape page-id file-id libraries] :rest props}]
  (let [shape-type (dm/get-prop shape :type)
        shape-id   (dm/get-prop shape :id)

        wasm-modifiers (mf/deref refs/workspace-wasm-modifiers)
        modifiers  (mf/deref refs/workspace-modifiers)

        shape
        (if (features/active-feature? @st/state "render-wasm/v1")
          (let [wasm-modifiers (into {} wasm-modifiers)]
            (gsh/apply-transform shape (get wasm-modifiers shape-id)))
          (gsh/transform-shape shape (dm/get-in modifiers [shape-id :modifiers])))

        props      (mf/spread-props props {:shape shape :file-id file-id :page-id page-id :libraries libraries})]

    [:*
     (case shape-type
       :frame   [:> frame/options* props]
       :group   [:> group/options* props]
       :text    [:> text/options* {:shape shape :file-id file-id :page-id page-id :libraries libraries}]
       :rect    [:> rect/options* {:shape shape :file-id file-id :page-id page-id}]
       :circle  [:> circle/options* {:shape shape :file-id file-id :page-id page-id}]
       :path    [:> path/options* {:shape shape :file-id file-id :page-id page-id}]
       :svg-raw [:> svg-raw/options* {:shape shape :file-id file-id :page-id page-id}]
       :bool    [:> bool/options* {:shape shape :file-id file-id :page-id page-id}]
       nil)
     ;; zvena: Figma's "Apply component property" for any layer in a main
     (when-not (= shape-type :frame)
       [:> layer-binding* {:shape shape}])]))

(mf/defc shape-options*
  {::mf/wrap [#(mf/throttle % 200)]
   ::mf/private true}
  [{:keys [shapes shapes-with-children selected page-id file-id libraries]}]
  (if (= 1 (count selected))
    [:> single-shape-options*
     {:page-id page-id
      :file-id file-id
      :libraries libraries
      :shape (first shapes)
      :shapes-with-children shapes-with-children}]
    [:> multiple/options*
     {:shapes-with-children shapes-with-children
      :shapes shapes
      :page-id page-id
      :file-id file-id
      :libraries libraries}]))

(mf/defc specialized-panel*
  {::mf/private true}
  [{:keys [panel]}]
  (when (= (:type panel) :component-swap)
    [:> component-menu* {:shapes (:shapes panel) :is-swap-opened true}]))

(defn- get-shapes-with-children
  "Returns the shapes of `selected` together with all their descendants."
  [objects selected]
  (loop [queue   (into #queue [] selected)
         visited selected]
    (if-let [id (peek queue)]
      (let [shape    (get objects id)
            children (:shapes shape)]
        (if (seq children)
          (let [new-children (remove visited children)]
            (recur (into (pop queue) new-children)
                   (into visited new-children)))
          (recur (pop queue) visited)))
      (sequence (keep (d/getf objects)) visited))))

(mf/defc design-menu*
  {::mf/private true}
  [{:keys [selected objects page-id file-id shapes]}]
  (let [sp-panel (mf/deref refs/specialized-panel)
        drawing  (mf/deref refs/workspace-drawing)
        edition  (mf/deref refs/selected-edition)

        files
        (mf/deref refs/files)

        libraries
        (mf/with-memo [files file-id]
          (refs/select-libraries files file-id))

        edit-grid?
        (mf/with-memo [objects edition]
          (ctl/grid-layout? objects edition))

        grid-edition
        (mf/deref refs/workspace-grid-edition)

        selected-cells
        (->> (dm/get-in grid-edition [edition :selected])
             (map #(dm/get-in objects [edition :layout-grid-cells %])))

        ;; Deferred, so the subtree walk runs in a background render
        deferred-selected
        (mf/use-deferred selected)

        deferred-objects
        (mf/use-deferred objects)

        shapes-with-children
        (mf/with-memo [deferred-selected deferred-objects]
          (get-shapes-with-children deferred-objects deferred-selected))

        total-selected
        (count selected)]

    [:div {:class (stl/css :element-options :design-options)}
     ;; Figma's "Position" section starts with the align row; the
     ;; X/Y/rotation rows follow from the shape's measures menu.
     (when (and (pos? total-selected)
                (not edit-grid?)
                (nil? sp-panel)
                (empty? drawing))
       [:div {:class (stl/css :position-head)}
        [:> title-bar* {:collapsable false
                        :title (tr "blueai.section.position")}]
        [:> align-options* {:shapes shapes
                            :objects objects}]
        ;; zvena: a single group or boolean keeps its boolean row (convert
        ;; the group, change the operation, flatten), as upstream did.
        (when (or (> total-selected 1)
                  (some #(contains? #{:group :bool} (:type %)) shapes))
          [:> bool-options* {:total-selected total-selected
                             :shapes shapes
                             :shapes-with-children shapes-with-children}])])

     (cond
       (and edit-grid? (d/not-empty? selected-cells))
       [:> grid-cell/options*
        {:shape-id (-> (get objects edition)
                       :id)
         :cells selected-cells}]

       edit-grid?
       [:& layout-container/grid-layout-edition
        {:ids [edition]
         :values (get objects edition)}]

       (some? sp-panel)
       [:> specialized-panel* {:panel sp-panel}]

       (d/not-empty? drawing)
       [:> drawing/drawing-options*
        {:drawing-state drawing}]

       (zero? total-selected)
       [:> page/options*]

       :else
       [:> shape-options*
        {:shapes shapes
         :shapes-with-children shapes-with-children
         :page-id page-id
         :file-id file-id
         :selected selected
         :libraries libraries}])

     ;; zvena: what is linked to this frame (issues, documents), or to
     ;; the file when nothing is selected
     (when (and zbridge/enabled?
                (not edit-grid?)
                (nil? sp-panel)
                (empty? drawing)
                (or (zero? total-selected)
                    (and (= 1 total-selected)
                         (cfh/frame-shape? (first shapes)))))
       [:> zbridge/frame-related* {:file-id file-id
                                   :frame (when (= 1 total-selected) (first shapes))}])]))

(mf/defc inspect-tab*
  {::mf/private true}
  [{:keys [objects shapes] :as props}]
  (let [frame
        (cfh/get-frame objects (first shapes))

        props
        (mf/spread-props props
                         {:frame frame
                          :from :workspace})]

    [:> hrs/right-sidebar* props]))

;; as in Figma, Design/Prototype are the tabs and Dev Mode is a
;; toggle in the toolbar; in Dev Mode the panel shows the Inspect tab only.
(defn- generate-options-tabs
  [mode]
  (if (= mode :inspect)
    [{:label (tr "blueai.tab.inspect")
      :id "inspect"}]
    (cond-> [{:label (tr "workspace.options.design")
              :id "design"}
             {:label (tr "workspace.options.prototype")
              :id "prototype"}]
      (dbg/enabled? :shape-panel)
      (conj {:label "Debug"
             :id "debug"}))))

(defn- on-option-tab-change
  [mode]
  (let [mode (keyword mode)]
    (st/emit! (udw/set-options-mode mode))
    (if (= mode :inspect)
      (st/emit! :interrupt (dwc/set-workspace-read-only true))
      (st/emit! :interrupt (dwc/set-workspace-read-only false)))))

(mf/defc options-content*
  {::mf/private true}
  [{:keys [objects selected page-id file-id on-change-section on-expand]}]
  (let [permissions
        (mf/use-ctx ctx/permissions)
        render-context-lost? (mf/deref refs/render-context-lost?)

        options-mode
        (mf/deref refs/options-mode-global)

        ;; dbg/state is an okulary atom; deref'ing it makes this component
        ;; re-render when debug options change (e.g. :shape-panel toggle)
        ;; so the tabs list is regenerated reactively without a page reload.
        dbg-state
        (mf/deref dbg/state)

        shapes
        (mf/with-memo [selected objects]
          (sequence (keep (d/getf objects)) selected))

        options-tabs
        (generate-options-tabs options-mode)

        zoom-button
        (mf/with-memo []
          (mf/html [:> zoom-control* {}]))]

    (mf/use-effect
     (mf/deps dbg-state)
     (fn []
       (if (contains? dbg-state :shape-panel)
         ;; shape-panel was just enabled: select the debug tab
         (on-option-tab-change "debug")
         ;; shape-panel was just disabled: if debug tab is active, go back to design
         (when (= options-mode :debug)
           (on-option-tab-change "design")))))

    [:div {:class (stl/css :tool-window)}
     (if (and (:can-edit permissions) (not render-context-lost?))
       [:> tab-switcher* {:tabs options-tabs
                          :on-change on-option-tab-change
                          :selected (name options-mode)
                          :action-button-position "end"
                          :action-button zoom-button
                          :class (stl/css :options-tab-switcher)}
        (case options-mode
          :prototype
          [:div {:class (stl/css :element-options :interaction-options)}
           ;; zvena: Figma's prototype settings when nothing is selected
           (when (empty? shapes)
             [:> prototype-settings*])
           [:> interactions-menu* {:shape (first shapes)}]
           ;; zvena: Figma "Scroll behavior" (Position / Overflow)
           [:> scroll-behavior* {:shapes shapes :objects objects}]]

          :inspect
          [:div {:class (stl/css :element-options :inspect-options)}
           [:> inspect-tab* {:page-id page-id
                             :file-id file-id
                             :objects objects
                             :selected selected
                             :shapes shapes
                             :on-change-section on-change-section
                             :on-expand on-expand}]]

          :design
          [:> design-menu* {:selected selected
                            :objects objects
                            :page-id page-id
                            :file-id file-id
                            :shapes shapes}]

          :debug
          [:> debug-shape-info*])]

       [:div {:class (stl/css :element-options :inspect-options :read-only)}
        ;; zvena: viewers keep the zoom menu (fit all, zoom to selection,
        ;; 100%) that sits in the tabs row for editors.
        [:div {:class (stl/css :read-only-zoom)}
         [:> zoom-control* {}]]
        [:> inspect-tab* {:page-id page-id
                          :file-id file-id
                          :objects objects
                          :selected selected
                          :shapes shapes
                          :on-change-section on-change-section
                          :on-expand on-expand}]])]))

(defn- make-page-objects-ref
  [file-id page-id]
  (l/derived #(dsh/lookup-page-objects % file-id page-id) st/state))

(mf/defc options-toolbox*
  {::mf/memo true}
  [{:keys [page-id file-id section selected on-change-section on-expand]}]
  (let [objects-ref
        (mf/with-memo [page-id file-id]
          (make-page-objects-ref file-id page-id))

        objects
        (mf/deref objects-ref)]

    [:> options-content* {:objects objects
                          :selected selected
                          :file-id file-id
                          :page-id page-id
                          :section section
                          :on-change-section on-change-section
                          :on-expand on-expand}]))
