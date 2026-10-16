;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.main-menu
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.types.shape.zvena :as ctsz]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.common :as dcm]
   [app.main.data.event :as ev]
   [app.main.data.exports.assets :as de]
   [app.main.data.exports.files :as fexp]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.data.plugins :as dp]
   [app.main.data.profile :as du]
   [app.main.data.shortcuts :as scd]
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.comments :as dwcm]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.mcp :as mcp]
   [app.main.data.workspace.shortcuts :as sc]
   [app.main.data.workspace.undo :as dwu]
   [app.main.data.workspace.versions :as dwv]
   [app.main.features :as features]
   [app.main.refs :as refs]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.main.ui.components.dropdown-menu :refer [dropdown-menu*
                                                 dropdown-menu-item*]]
   [app.main.ui.context :as ctx]
   [app.main.ui.dashboard.subscription :refer [get-subscription-type
                                               main-menu-power-up*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.hooks.resize :as r]
   [app.main.ui.icons :as deprecated-icon]
   ;; zvena: Figma's branching (File menu entries)
   [app.main.ui.workspace.zvena.branches :as zbranches]
   [app.plugins.register :as preg]
   [app.util.dom :as dom]
   [app.util.help :as help]
   [app.util.i18n :as i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [app.util.theme :as theme]
   [app.zvena :as zvena]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(mf/defc shortcuts*
  {::mf/private true}
  [{:keys [id]}]
  (let [custom-shortcuts (mf/deref refs/custom-shortcuts)
        customized?      (let [c (get-in custom-shortcuts [:workspace id])]
                           (and c (not= c "")))]
    [:span {:class (stl/css :shortcut)}
     (for [sc (scd/split-sc (sc/get-effective-tooltip id custom-shortcuts))]
       [:span {:class (stl/css-case :shortcut-key true
                                    :customized-key customized?)
               :key sc}
        sc])]))

(mf/defc help-info-menu*
  {::mf/private true
   ::mf/wrap [mf/memo]}
  [{:keys [layout on-close]}]
  (let [nav-to-helpc-center
        (mf/use-fn
         (fn []
           (st/emit! (ev/event {::ev/name "explore-help-center-click"
                                ::ev/origin "workspace:menu"}))
           (dom/open-new-window (help/url))))

        nav-to-terms
        (mf/use-fn
         (fn []
           (st/emit! (ev/event {::ev/name "explore-terms-service-click"
                                ::ev/origin "workspace:menu"}))
           (dom/open-new-window (zvena/source-url))))

        nav-to-feedback
        (mf/use-fn #(st/emit! (dcm/go-to-feedback)))

        ;; zvena: Figma's "Get desktop app": install zvena Design as an app
        ;; (the browser's install prompt when it offers one, else how to)
        installed?
        (and (exists? js/window.matchMedia)
             (.-matches (js/window.matchMedia "(display-mode: standalone)")))

        get-desktop-app
        (mf/use-fn
         (mf/deps on-close)
         (fn [_]
           (let [prompt (unchecked-get js/window "__zvInstallPrompt")]
             (when (fn? on-close) (on-close))
             (if (some? prompt)
               (do (.prompt ^js prompt)
                   (unchecked-set js/window "__zvInstallPrompt" nil))
               (st/emit! (ntf/info (tr "zvena.desktop.how-to-install")))))))

        plugins?
        (features/active-feature? @st/state "plugins/runtime")

        mcp-enabled?
        (contains? cf/flags :mcp)

        show-shortcuts
        (mf/use-fn
         (mf/deps layout)
         (fn []
           (when (contains? layout :collapse-left-sidebar)
             (st/emit! (dw/toggle-layout-flag :collapse-left-sidebar)))

           (st/emit!
            (-> (dw/toggle-layout-flag :shortcuts)
                (vary-meta assoc ::ev/origin "workspace:menu")))))]

    [:> dropdown-menu* {:show true
                        :on-close on-close
                        :class (stl/css-case :base-menu true
                                             :sub-menu true
                                             :pos-final-5 (not (or plugins? mcp-enabled?))
                                             :pos-final-6 (not= plugins? mcp-enabled?)
                                             :pos-final-7 (and plugins? mcp-enabled?))}
     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    nav-to-helpc-center
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (nav-to-helpc-center event)))
                              :id          "file-menu-help-center"}
      [:span {:class (stl/css :item-name)}
       (tr "labels.help-center")]]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    nav-to-terms
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (nav-to-terms event)))
                              :id          "file-menu-terms"}
      [:span {:class (stl/css :item-name)}
       (tr "blueai.menu.source-code")]]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    show-shortcuts
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (show-shortcuts event)))
                              :id          "file-menu-shortcuts"}
      [:span {:class (stl/css :item-name)}
       (tr "label.shortcuts")]
      [:> shortcuts* {:id :show-shortcuts}]]

     ;; zvena: Figma's "Get desktop app"
     (when-not installed?
       [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                :on-click    get-desktop-app
                                :on-key-down (fn [event]
                                               (when (kbd/enter? event)
                                                 (get-desktop-app event)))
                                :id          "file-menu-desktop-app"}
        [:span {:class (stl/css :item-name)}
         (tr "zvena.desktop.get-app")]])

     (when (contains? cf/flags :user-feedback)
       [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                :on-click    nav-to-feedback
                                :on-key-down (fn [event]
                                               (when (kbd/enter? event)
                                                 (nav-to-feedback event)))
                                :id          "file-menu-feedback"}
        [:span {:class (stl/css :feedback :item-name)}
         (tr "labels.give-feedback")]])]))

(mf/defc preferences-menu*
  {::mf/private true
   ::mf/wrap [mf/memo]}
  [{:keys [layout profile toggle-flag on-close toggle-theme toggle-render]}]
  (let [renderer (or (-> profile :props :renderer) :svg)

        ;; zvena: Figma's "Enhanced contrast"
        contrast* (mf/use-state theme/enhanced-contrast?)
        toggle-contrast
        (mf/use-fn
         (fn [_]
           (let [on? (not (deref contrast*))]
             (theme/set-enhanced-contrast! on?)
             (reset! contrast* on?))))

        show-nudge-options
        (mf/use-fn
         #(modal/show! {:type :nudge-option}))]

    [:> dropdown-menu* {:show true
                        :class (stl/css :base-menu :sub-menu :pos-4)
                        :on-close on-close}
     [:> dropdown-menu-item* {:on-click    toggle-flag
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "scale-text"
                              :id          "file-menu-scale-text"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :scale-text)
         (tr "workspace.header.menu.disable-scale-content")
         (tr "workspace.header.menu.enable-scale-content"))]
      [:> shortcuts* {:id :scale}]]

     [:> dropdown-menu-item* {:on-click    toggle-flag
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "snap-ruler-guides"
                              :id          "file-menu-snap-ruler-guides"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :snap-ruler-guides)
         (tr "workspace.header.menu.disable-snap-ruler-guides")
         (tr "workspace.header.menu.enable-snap-ruler-guides"))]
      [:> shortcuts* {:id :toggle-snap-ruler-guide}]]

     [:> dropdown-menu-item* {:on-click    toggle-flag
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "snap-guides"
                              :id          "file-menu-snap-guides"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :snap-guides)
         (tr "workspace.header.menu.disable-snap-guides")
         (tr "workspace.header.menu.enable-snap-guides"))]
      [:> shortcuts* {:id :toggle-snap-guides}]]

     [:> dropdown-menu-item* {:on-click    toggle-flag
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "dynamic-alignment"
                              :id          "file-menu-dynamic-alignment"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :dynamic-alignment)
         (tr "workspace.header.menu.disable-dynamic-alignment")
         (tr "workspace.header.menu.enable-dynamic-alignment"))]
      [:> shortcuts* {:id :toggle-alignment}]]

     [:> dropdown-menu-item* {:on-click    toggle-flag
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "snap-pixel-grid"
                              :id          "file-menu-pixel-grid"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :snap-pixel-grid)
         (tr "workspace.header.menu.disable-snap-pixel-grid")
         (tr "workspace.header.menu.enable-snap-pixel-grid"))]
      [:> shortcuts* {:id :snap-pixel-grid}]]

     [:> dropdown-menu-item* {:on-click    show-nudge-options
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (show-nudge-options event)))
                              :data-testid "snap-pixel-grid"
                              :id          "file-menu-nudge"}
      [:span {:class (stl/css :item-name)} (tr "modals.nudge-title")]]

     [:> dropdown-menu-item* {:on-click    toggle-contrast
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-contrast event)))
                              :data-testid "enhanced-contrast"
                              :id          "file-menu-enhanced-contrast"}
      [:span {:class (stl/css :item-name)}
       (if (deref contrast*)
         (tr "zvena.menu.contrast-off")
         (tr "zvena.menu.contrast-on"))]]

     [:> dropdown-menu-item* {:on-click    toggle-theme
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-theme event)))
                              :data-testid "toggle-theme"
                              :id          "file-menu-toggle-theme"}
      [:span {:class (stl/css :item-name)}
       (case (:theme profile)  ;; dark -> light -> system -> dark and so on
         "dark" (tr "workspace.header.menu.toggle-light-theme")
         "light" (tr "workspace.header.menu.toggle-system-theme")
         "system" (tr "workspace.header.menu.toggle-dark-theme")
         (tr "workspace.header.menu.toggle-light-theme"))]
      [:> shortcuts* {:id :toggle-theme}]]
     (when (contains? cf/flags :render-switch)
       [:> dropdown-menu-item* {:on-click    toggle-render
                                :class       (stl/css :base-menu-item :submenu-item)
                                :on-key-down (fn [event]
                                               (when (kbd/enter? event)
                                                 (toggle-render event)))}
        [:span {:class (stl/css :item-name)}
         (if (= renderer :wasm)
           (tr "workspace.header.menu.disable-webgl")
           (tr "workspace.header.menu.enable-webgl"))]])]))

(mf/defc view-menu*
  {::mf/private true
   ::mf/wrap [mf/memo]}
  [{:keys [layout toggle-flag on-close on-close-all]}]
  (let [read-only?   (mf/use-ctx ctx/workspace-read-only?)

        toggle-color-palette
        (mf/use-fn
         (fn []
           (r/set-resize-type! :bottom)
           (st/emit! (dw/remove-layout-flag :textpalette)
                     (-> (dw/toggle-layout-flag :colorpalette)
                         (vary-meta assoc ::ev/origin "workspace:menu")))))

        toggle-text-palette
        (mf/use-fn
         (fn []
           (r/set-resize-type! :bottom)
           (st/emit! (dw/remove-layout-flag :colorpalette)
                     (-> (dw/toggle-layout-flag :textpalette)
                         (vary-meta assoc ::ev/origin "workspace:menu")))))

        toggle-comments-visibility
        (mf/use-fn
         (mf/deps on-close-all)
         (fn [event]
           (dom/stop-propagation event)
           (st/emit! (dwcm/toggle-comments-visibility {:origin "workspace:menu"}))
           (on-close-all)))]

    [:> dropdown-menu* {:show true
                        :class (stl/css :base-menu :sub-menu :pos-3)
                        :on-close on-close}

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-flag
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "rulers"
                              :id          "file-menu-rulers"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :rulers)
         (tr "workspace.header.menu.hide-rules")
         (tr "workspace.header.menu.show-rules"))]
      [:> shortcuts* {:id :toggle-rulers}]]


     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-flag
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "display-guides"
                              :id          "file-menu-guides"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :display-guides)
         (tr "workspace.header.menu.hide-guides")
         (tr "workspace.header.menu.show-guides"))]
      [:> shortcuts* {:id :toggle-guides}]]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-flag
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "lock-guides"
                              :id          "file-menu-lock-guides"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :lock-guides)
         (tr "workspace.header.menu.unlock-guides")
         (tr "workspace.header.menu.lock-guides"))]]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-comments-visibility
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-comments-visibility event)))
                              :data-testid "display-comments"
                              :id          "file-menu-comments"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :display-comments)
         (tr "workspace.header.menu.hide-comments")
         (tr "workspace.header.menu.show-comments"))]
      [:> shortcuts* {:id :toggle-comments-visibility}]]

     (when-not ^boolean read-only?
       [:*
        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                 :on-click    toggle-color-palette
                                 :on-key-down (fn [event]
                                                (when (kbd/enter? event)
                                                  (toggle-color-palette event)))
                                 :id          "file-menu-color-palette"}
         [:span {:class (stl/css :item-name)}
          (if (contains? layout :colorpalette)
            (tr "workspace.header.menu.hide-palette")
            (tr "workspace.header.menu.show-palette"))]
         [:> shortcuts* {:id :toggle-colorpalette}]]

        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                 :on-click    toggle-text-palette
                                 :on-key-down (fn [event]
                                                (when (kbd/enter? event)
                                                  (toggle-text-palette event)))
                                 :id          "file-menu-text-palette"}
         [:span {:class (stl/css :item-name)}
          (if (contains? layout :textpalette)
            (tr "workspace.header.menu.hide-textpalette")
            (tr "workspace.header.menu.show-textpalette"))]
         [:> shortcuts* {:id :toggle-textpalette}]]])

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-flag
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "display-artboard-names"
                              :id          "file-menu-artboards"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :display-artboard-names)
         (tr "workspace.header.menu.hide-artboard-names")
         (tr "workspace.header.menu.show-artboard-names"))]]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-flag
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "show-pixel-grid"
                              :id          "file-menu-pixel-grid"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :show-pixel-grid)
         (tr "workspace.header.menu.hide-pixel-grid")
         (tr "workspace.header.menu.show-pixel-grid"))]
      [:> shortcuts* {:id :show-pixel-grid}]]

     ;; zvena: Figma's View > Multiplayer cursors
     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-flag
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "hide-cursors"
                              :id          "file-menu-hide-cursors"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :hide-cursors)
         (tr "zvena.menu.show-cursors")
         (tr "zvena.menu.hide-cursors"))]
      [:> shortcuts* {:id :toggle-cursors}]]

     ;; zvena: Figma's outline mode
     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-flag
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "outline-mode"
                              :id          "file-menu-outline-mode"}
      [:span {:class (stl/css :item-name)}
       (if (contains? layout :outline-mode)
         (tr "zvena.menu.outline-mode-off")
         (tr "zvena.menu.outline-mode-on"))]
      [:> shortcuts* {:id :toggle-outline-mode}]]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    toggle-flag
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (toggle-flag event)))
                              :data-testid "hide-ui"
                              :id          "file-menu-hide-ui"}
      [:span {:class (stl/css :item-name)}
       (tr "workspace.shape.menu.hide-ui")]
      [:> shortcuts* {:id :hide-ui}]]]))

(mf/defc edit-menu*
  {::mf/private true
   ::mf/wrap [mf/memo]}
  [{:keys [on-close]}]
  (let [perms    (mf/use-ctx ctx/permissions)
        can-edit (:can-edit perms)

        select-all
        (mf/use-fn
         #(st/emit! (dw/select-all)))

        select-matching
        (mf/use-fn
         #(st/emit! (dw/select-matching)))

        ;; zvena: Figma's "Select all with same …"
        select-same
        (mf/use-fn
         (fn [event]
           (let [mode (-> (dom/get-current-target event) (dom/get-data "mode") keyword)]
             (st/emit! (dw/select-same mode)))))

        find
        (mf/use-fn (fn [] (on-close) (st/emit! (dw/open-layers-search :find {:force? true}))))

        find-and-replace
        (mf/use-fn (fn [] (on-close) (st/emit! (dw/open-layers-search :find-and-replace {:force? true}))))

        undo
        (mf/use-fn
         #(st/emit! dwu/undo))

        redo
        (mf/use-fn
         #(st/emit! dwu/redo))]

    [:> dropdown-menu* {:show true
                        :class (stl/css :base-menu :sub-menu :pos-2)
                        :on-close on-close}

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    select-all
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (select-all event)))
                              :id          "file-menu-select-all"}
      [:span {:class (stl/css :item-name)}
       (tr "workspace.header.menu.select-all")]
      [:> shortcuts* {:id :select-all}]]

     ;; zvena: Figma's "Select matching layers"
     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    select-matching
                              :on-key-down (fn [event]
                                             (when (kbd/enter? event)
                                               (select-matching event)))
                              :id          "file-menu-select-matching"}
      [:span {:class (stl/css :item-name)}
       (tr "zvena.menu.select-matching")]
      [:> shortcuts* {:id :select-matching}]]

     ;; zvena: Figma's "Select all with same …"
     (for [mode [:properties :fill :stroke :effect :text :font :instance]]
       [:> dropdown-menu-item* {:key (name mode)
                                :class (stl/css :base-menu-item :submenu-item)
                                :data-mode (name mode)
                                :on-click select-same
                                :on-key-down (fn [event]
                                               (when (kbd/enter? event)
                                                 (select-same event)))
                                :id (str "file-menu-select-same-" (name mode))}
        [:span {:class (stl/css :item-name)}
         (tr (str "zvena.menu.select-same." (name mode)))]])

     [:div {:class (stl/css :separator)}]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click find
                              :on-key-down (fn [event] (when (kbd/enter? event) (find event)))
                              :id "file-menu-find"}
      [:span {:class (stl/css :item-name)} (tr "workspace.header.menu.find")]
      [:> shortcuts* {:id :find}]]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click find-and-replace
                              :on-key-down (fn [event] (when (kbd/enter? event) (find-and-replace event)))
                              :id "file-menu-find-and-replace"}
      [:span {:class (stl/css :item-name)} (tr "workspace.header.menu.find-and-replace")]
      [:> shortcuts* {:id :find-and-replace}]]

     (when can-edit
       [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                :on-click    undo
                                :on-key-down (fn [event]
                                               (when (kbd/enter? event)
                                                 (undo event)))
                                :id          "file-menu-undo"}
        [:span {:class (stl/css :item-name)}
         (tr "workspace.header.menu.undo")]
        [:> shortcuts* {:id :undo}]])

     (when can-edit
       [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                :on-click    redo
                                :on-key-down (fn [event]
                                               (when (kbd/enter? event)
                                                 (redo event)))
                                :id          "file-menu-redo"}
        [:span {:class (stl/css :item-name)}
         (tr "workspace.header.menu.redo")]
        [:> shortcuts* {:id :redo}]])]))

(mf/defc file-menu*
  {::mf/private true}
  [{:keys [on-close file class on-rename]}]
  (let [file-id      (:id file)
        shared?      (:is-shared file)

        objects      (mf/deref refs/workspace-page-objects)
        selected     (mf/deref refs/selected-shapes)
        ;; zvena: a section exports the frames inside it, not itself
        root-frames  (->> (cfh/get-immediate-children objects uuid/zero)
                          (filterv cfh/frame-shape?))
        all-frames   (ctsz/expand-sections objects root-frames)

        ;; If there are selected frames, use only those. Otherwise, use all frames
        selected-frames (->> root-frames
                             (filterv #(contains? selected (:id %)))
                             (ctsz/expand-sections objects))
        frames       (if (seq selected-frames) selected-frames all-frames)

        perms        (mf/use-ctx ctx/permissions)
        can-edit     (:can-edit perms)

        on-remove-shared
        (mf/use-fn
         (mf/deps file-id)
         (fn [event]
           (dom/prevent-default event)
           (dom/stop-propagation event)
           (modal/show! {:type :delete-shared-libraries
                         :origin :unpublish
                         :ids #{file-id}
                         :on-accept #(st/emit! (dwl/set-file-shared file-id false))
                         :count-libraries 1})))

        on-remove-shared-key-down
        (mf/use-fn
         (mf/deps on-remove-shared)
         (fn [event]
           (when (kbd/enter? event)
             (on-remove-shared event))))

        on-add-shared
        (mf/use-fn
         (mf/deps file-id)
         (fn [_event]
           (let [on-accept #(st/emit! (dwl/set-file-shared file-id true))]
             (st/emit! (dcm/show-shared-dialog file-id on-accept)))))

        on-add-shared-key-down
        (mf/use-fn
         (mf/deps on-add-shared)
         (fn [event]
           (when (kbd/enter? event)
             (on-add-shared event))))

        on-show-version-history
        (mf/use-fn
         (mf/deps file-id)
         (fn [_]
           (st/emit! (dw/toggle-layout-flag :document-history))))

        on-show-version-history-key-down
        (mf/use-fn
         (mf/deps on-show-version-history)
         (fn [event]
           (when (kbd/enter? event)
             (on-show-version-history event))))

        on-pin-version
        (mf/use-fn
         (fn [_]
           (st/emit! (dwv/create-version))))

        on-pin-version-key-down
        (mf/use-fn
         (mf/deps on-pin-version)
         (fn [event]
           (when (kbd/enter? event)
             (on-pin-version event))))

        on-export-shapes
        (mf/use-fn
         #(st/emit! (de/show-workspace-export-dialog {:origin "workspace:menu"})))

        ;; zvena: Figma's "Publish library…" (changes + release notes)
        on-publish-library
        (mf/use-fn
         (mf/deps file-id on-close)
         (fn []
           (on-close)
           (st/emit! (modal/show :zvena-publish-library {:file-id file-id}))))

        ;; zvena: Import from Figma
        on-figma-import
        (mf/use-fn
         (fn []
           (on-close)
           (st/emit! (modal/show :zvena-figma-import {}))))

        on-export-shapes-key-down
        (mf/use-fn
         (mf/deps on-export-shapes)
         (fn [event]
           (when (kbd/enter? event)
             (on-export-shapes event))))

        on-export-file
        (mf/use-fn
         (mf/deps file)
         (fn [_]
           (st/emit! (-> (fexp/open-export-dialog [file])
                         (with-meta {::ev/origin "workspace:menu"})))))

        on-export-file-key-down
        (mf/use-fn
         (mf/deps on-export-file)
         (fn [event]
           (when (kbd/enter? event)
             (on-export-file event))))

        on-export-frames
        (mf/use-fn
         (mf/deps frames)
         (fn [_]
           (st/emit! (de/show-workspace-export-frames-dialog frames))))

        on-export-frames-key-down
        (mf/use-fn
         (mf/deps on-export-frames)
         (fn [event]
           (when (kbd/enter? event)
             (on-export-frames event))))]

    [:> dropdown-menu* {:show true
                        :class (or class (stl/css :base-menu :sub-menu :pos-1))
                        :on-close on-close}

     ;; the file name menu (Figma) also renames the file.
     (when (and on-rename can-edit)
       [:*
        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                 :on-click    on-rename
                                 :on-key-down (fn [event]
                                                (when (kbd/enter? event)
                                                  (on-rename event)))
                                 :id          "file-menu-rename"}
         [:span {:class (stl/css :item-name)}
          (tr "labels.rename")]]
        [:div {:class (stl/css :separator)}]])

     ;; zvena: Figma's "Publish library…" for a shared library
     (when (and ^boolean shared? can-edit)
       [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                :on-click    on-publish-library
                                :on-key-down (fn [event]
                                               (when (kbd/enter? event)
                                                 (on-publish-library)))
                                :id          "file-menu-zvena-publish-library"}
        [:span {:class (stl/css :item-name)}
         (tr "zvena.library.publish-library-ellipsis")]])

     (if ^boolean shared?
       (when can-edit
         [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                  :on-click    on-remove-shared
                                  :on-key-down on-remove-shared-key-down
                                  :id          "file-menu-remove-shared"}
          [:span {:class (stl/css :item-name)}
           (tr "dashboard.unpublish-shared")]])

       (when can-edit
         [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                  :on-click    on-add-shared
                                  :on-key-down on-add-shared-key-down
                                  :id          "file-menu-add-shared"}
          [:span {:class (stl/css :item-name)}
           (tr "dashboard.add-shared")]]))

     (when can-edit
       [:*
        [:div {:class (stl/css :separator)}]

        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                 :on-click    on-pin-version
                                 :on-key-down on-pin-version-key-down
                                 :id          "file-menu-create-version"}
         [:span {:class (stl/css :item-name)}
          (tr "dashboard.create-version-menu")]]

        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                 :on-click    on-show-version-history
                                 :on-key-down on-show-version-history-key-down
                                 :id          "file-menu-show-version-history"}
         [:span {:class (stl/css :item-name)}
          (tr "dashboard.show-version-history")]
         [:> shortcuts* {:id :toggle-history}]]

        [:div {:class (stl/css :separator)}]])

     ;; zvena: Figma's branching: Create branch…, View branches and, on a
     ;; branch, Review and merge, Update from main, Archive branch
     [:> zbranches/branch-menu-items* {:file file
                                       :on-close on-close
                                       :can-edit can-edit
                                       :item-class (stl/css :base-menu-item :submenu-item)
                                       :name-class (stl/css :item-name)
                                       :separator-class (stl/css :separator)}]

     (when can-edit
       [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                :on-click    on-figma-import
                                :on-key-down (fn [event] (when (kbd/enter? event) (on-figma-import)))
                                :id          "file-menu-figma-import"}
        [:span {:class (stl/css :item-name)}
         (tr "zvena.figma.menu")]])

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    on-export-shapes
                              :on-key-down on-export-shapes-key-down
                              :id          "file-menu-export-shapes"}
      [:span {:class (stl/css :item-name)}
       (tr "dashboard.export-shapes")]
      [:> shortcuts* {:id :export-shapes}]]

     [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                              :on-click    on-export-file
                              :on-key-down on-export-file-key-down
                              :data-format "binfile-v3"
                              :id          "file-menu-binary-file"}
      [:span {:class (stl/css :item-name)}
       (tr "dashboard.download-binary-file")]]

     (when (seq frames)
       [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                                :on-click    on-export-frames
                                :on-key-down on-export-frames-key-down
                                :id          "file-menu-export-frames"}
        [:span {:class (stl/css :item-name)}
         (tr "dashboard.export-frames")]])]))

;; dropdown under the file name in the left header (Figma).
(mf/defc file-name-menu*
  [{:keys [file on-close on-rename]}]
  [:> file-menu* {:file file
                  :on-close on-close
                  :on-rename on-rename
                  :class (stl/css :base-menu :file-name-menu)}])

(mf/defc plugins-menu*
  {::mf/private true
   ::mf/wrap [mf/memo]}
  [{:keys [open-plugins on-close]}]
  (when (features/active-feature? @st/state "plugins/runtime")
    (let [plugins          (preg/plugins-list)
          user-can-edit?   (:can-edit (deref refs/permissions))
          permissions-peek (deref refs/plugins-permissions-peek)]
      [:> dropdown-menu* {:show true
                          :class (stl/css :base-menu :sub-menu :pos-5 :plugins)
                          :on-close on-close}
       [:> dropdown-menu-item* {:on-click    open-plugins
                                :class       (stl/css :base-menu-item :submenu-item)
                                :on-key-down (fn [event]
                                               (when (kbd/enter? event)
                                                 (open-plugins event)))
                                :data-testid "open-plugins"
                                :id          "file-menu-open-plugins"}
        [:span {:class (stl/css :item-name)}
         (tr "workspace.plugins.menu.plugins-manager")]
        [:> shortcuts* {:id :plugins}]]


       (when (d/not-empty? plugins)
         [:div {:class (stl/css :separator)}])

       (for [[idx {:keys [plugin-id name host permissions] :as manifest}] (d/enumerate plugins)]
         (let [permissions        (or (get permissions-peek plugin-id) permissions)
               is-edition-plugin? (or (contains? permissions "content:write")
                                      (contains? permissions "library:write"))
               can-open?          (or user-can-edit?
                                      (not is-edition-plugin?))
               on-click
               (mf/use-fn
                (mf/deps can-open? name host manifest user-can-edit?)
                (fn [event]
                  (if can-open?
                    (do
                      (st/emit! (ev/event {::ev/name "start-plugin"
                                           ::ev/origin "workspace:menu"
                                           :name name
                                           :host host}))
                      (dp/open-plugin! manifest user-can-edit?))
                    (dom/stop-propagation event))))
               on-key-down
               (mf/use-fn
                (mf/deps can-open? name host manifest user-can-edit?)
                (fn [event]
                  (when can-open?
                    (when (kbd/enter? event)
                      (st/emit! (ev/event {::ev/name "start-plugin"
                                           ::ev/origin "workspace:menu"
                                           :name name
                                           :host host}))
                      (dp/open-plugin! manifest user-can-edit?)))))]

           [:> dropdown-menu-item* {:key         (dm/str "plugins-menu-" idx)
                                    :on-click    on-click
                                    :class       (stl/css-case :base-menu-item true
                                                               :submenu-item true
                                                               :disabled (not can-open?))
                                    :on-key-down on-key-down}
            [:span {:class (stl/css :item-name)} name]
            (when-not can-open?
              [:span {:title (tr "workspace.plugins.error.need-editor")}
               [:> icon* {:icon-id i/help
                          :class (stl/css :item-icon)}]])]))])))

(mf/defc mcp-menu*
  {::mf/private true}
  [{:keys [on-close mcp]}]
  (let [plugins-enabled? (features/use-feature "plugins/runtime")
        has-valid-token? (get mcp :token-valid)
        enabled?         (get mcp :enabled)

        conn-status      (get mcp :connection-status)
        connected?       (= conn-status "connected")

        show-enabled?    (and enabled? has-valid-token?)

        on-nav-to-integrations
        (mf/use-fn
         (fn []
           (st/emit! (ev/event {::ev/name "manage-mpc-option"
                                ::ev/origin "workspace:menu"}))
           (dom/open-new-window "/#/settings/integrations")))

        on-nav-to-integrations-key-down
        (mf/use-fn
         (fn [event]
           (when (kbd/enter? event)
             (on-nav-to-integrations))))

        on-toggle-mcp-plugin
        (mf/use-fn
         (mf/deps connected?)
         (fn []
           (if connected?
             (st/emit! (mcp/user-disconnect-mcp)
                       (ev/event {::ev/name "disconnect-mcp-plugin"
                                  ::ev/origin "workspace:menu"}))
             (st/emit! (mcp/connect-mcp)
                       (ev/event {::ev/name "connect-mcp-plugin"
                                  ::ev/origin "workspace:menu"})))))

        on-toggle-mcp-plugin-key-down
        (mf/use-fn
         (fn [event]
           (when (kbd/enter? event)
             (on-toggle-mcp-plugin))))]

    [:> dropdown-menu* {:show true
                        :class (stl/css-case :base-menu true
                                             :sub-menu true
                                             :pos-5 (not plugins-enabled?)
                                             :pos-6 plugins-enabled?)
                        :on-close on-close}


     (when (and show-enabled? has-valid-token?)
       [:> dropdown-menu-item* {:id          "mcp-menu-toggle-mcp-plugin"
                                :class       (stl/css :base-menu-item :submenu-item)
                                :on-click    on-toggle-mcp-plugin
                                :on-key-down on-toggle-mcp-plugin-key-down}
        [:span {:class (stl/css :item-name)}
         (if connected?
           (tr "workspace.header.menu.mcp.plugin.status.disconnect")
           (tr "workspace.header.menu.mcp.plugin.status.connect"))]])

     [:> dropdown-menu-item* {:id          "mcp-menu-nav-to-integrations"
                              :class       (stl/css :base-menu-item :submenu-item)
                              :on-click    on-nav-to-integrations
                              :on-key-down on-nav-to-integrations-key-down}
      [:span {:class (stl/css :item-name)}
       (if show-enabled?
         (tr "workspace.header.menu.mcp.server.status.enabled")
         (tr "workspace.header.menu.mcp.server.status.disabled"))]]]))

(def ^:private command-menus
  "Figma's Object / Text / Arrange menus, built from workspace shortcut commands
  (label shortcuts.<id>, action = the shortcut's :fn)."
  {:object  [:group :artboard-selection :wrap-in-section :ungroup :-
             :flatten :mask :unmask :thumbnail-set :-
             :toggle-layout-flex :create-component-variant :detach-component :-
             :bring-front :bring-forward :bring-backward :bring-back :-
             :flip-horizontal :flip-vertical :-
             :bool-union :bool-difference :bool-intersection :bool-exclude :-
             :toggle-visibility :toggle-lock :-
             :remove-fill :remove-stroke]
   :text    [:bold :italic :underline :line-through :-
             :text-list-unordered :text-list-ordered :-
             :font-size-inc :font-size-dec]
   :arrange [:align-left :align-hcenter :align-right :-
             :align-top :align-vcenter :align-bottom :-
             :h-distribute :v-distribute :tidy-up]
   ;; zvena: Figma's Vector menu
   :vector  [:flatten :-
             :bool-union :bool-difference :bool-intersection :bool-exclude]})

(mf/defc command-menu*
  {::mf/private true}
  [{:keys [menu on-close-all]}]
  (let [selected (mf/deref refs/selected-shapes)
        none?    (empty? selected)
        run      (mf/use-fn
                  (mf/deps on-close-all)
                  (fn [event]
                    (dom/stop-propagation event)
                    (let [id (-> (dom/get-current-target event) (dom/get-data "command") keyword)]
                      (on-close-all)
                      (when-let [f (get-in sc/shortcuts [id :fn])]
                        (f)))))]
    [:> dropdown-menu* {:show true
                        :class (stl/css :base-menu :sub-menu)
                        :on-close on-close-all}
     (for [[idx id] (map-indexed vector (get command-menus menu))]
       (if (= id :-)
         [:div {:key (dm/str "sep-" idx) :class (stl/css :separator)}]
         [:> dropdown-menu-item* {:key (d/name id)
                                  :class (stl/css-case :base-menu-item true
                                                       :submenu-item true
                                                       :disabled none?)
                                  :data-command (d/name id)
                                  :on-click run
                                  :on-key-down (fn [event] (when (kbd/enter? event) (run event)))}
          [:span {:class (stl/css :item-name)} (tr (dm/str "shortcuts." (d/name id)))]
          [:> shortcuts* {:id id}]]))]))

(mf/defc menu*
  [{:keys [layout file]}]
  (let [profile            (mf/deref refs/profile)
        can-edit           (:can-edit (mf/use-ctx ctx/permissions))

        show-menu*         (mf/use-state false)
        show-menu?         (deref show-menu*)
        selected-sub-menu* (mf/use-state nil)
        selected-sub-menu  (deref selected-sub-menu*)
        ;; submenus open next to the hovered item, as in Figma.
        sub-top*           (mf/use-state 0)
        sub-top            (deref sub-top*)
        mcp                (mf/deref refs/mcp)

        toggle-menu
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (swap! show-menu* not)
           (when (not show-menu?)
             (reset! selected-sub-menu* nil))))

        close-menu
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! show-menu* false)))

        close-sub-menu
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! selected-sub-menu* nil)))

        close-all-menus
        (mf/use-fn
         (fn []
           (reset! show-menu* false)
           (reset! selected-sub-menu* nil)))

        on-menu-click
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (let [node (dom/get-current-target event)
                 menu (-> node
                          (dom/get-data "testid")
                          (keyword))]
             (reset! sub-top* (.-offsetTop node))
             (reset! selected-sub-menu* menu))))

        go-to-files
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! show-menu* false)
           (st/emit! :interrupt
                     (dw/set-options-mode :design)
                     (dcm/go-to-dashboard-recent))))

        open-quick-actions
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! show-menu* false)
           (reset! selected-sub-menu* nil)
           (st/emit! (dw/toggle-layout-flag :quick-actions :force? true))))

        toggle-flag
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (let [flag (-> (dom/get-current-target event)
                          (dom/get-data "testid")
                          (keyword))]
             (st/emit!
              (-> (dw/toggle-layout-flag flag)
                  (vary-meta assoc ::ev/origin "workspace:menu")))
             (reset! show-menu* false)
             (reset! selected-sub-menu* nil))))

        toggle-theme
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (st/emit! (du/toggle-theme))))

        toggle-render
        (mf/use-fn
         (mf/deps profile)
         (fn [event]
           (dom/stop-propagation event)
           (let [renderer (or (-> profile :props :renderer) :svg)
                 next-renderer (if (= renderer :wasm) :svg :wasm)
                 ev-name (if (= next-renderer :wasm)
                           "enable-webgl-rendering"
                           "disable-webgl-rendering")]
             (->> (rx/zip
                   (rp/cmd! :update-profile-props {:props {:renderer next-renderer}})
                   (rx/filter (ptk/type? ::ev/chunk-persisted) st/stream))
                  (rx/timeout 2000 (rx/of :timeout))
                  (rx/subs! (fn [_]
                              (dom/reload-current-window true))
                            (fn [_]
                              (st/emit! (ntf/error (tr "errors.generic"))))))
             (st/emit! (ev/event {::ev/name ev-name
                                  ::ev/origin "workspace:menu"})
                       (ptk/data-event ::ev/force-persist {})))))

        open-plugins-manager
        (mf/use-fn
         (fn [event]
           (dom/stop-propagation event)
           (reset! show-menu* false)
           (reset! selected-sub-menu* nil)
           (st/emit!
            (ev/event {::ev/name "open-plugins-manager"
                       ::ev/origin "workspace:menu"})
            (modal/show :plugin-management {}))))

        show-shortcuts
        (mf/use-fn
         (mf/deps layout)
         (fn [event]
           (dom/stop-propagation event)
           (reset! show-menu* false)
           (reset! selected-sub-menu* nil)
           (when (contains? layout :collapse-left-sidebar)
             (st/emit! (dw/toggle-layout-flag :collapse-left-sidebar)))
           (st/emit!
            (-> (dw/toggle-layout-flag :shortcuts)
                (vary-meta assoc ::ev/origin "workspace-menu")))))

        subscription           (:subscription (:props profile))
        subscription-type      (get-subscription-type subscription)]

    (mf/with-effect []
      (let [disposable (->> st/stream
                            (rx/filter #(= :interrupt %))
                            (rx/subs! close-all-menus))]
        (partial rx/dispose! disposable)))


    [:*
     ;; the logo opens the main menu, as in Figma.
     [:button {:class (stl/css :logo-menu-button)
               :aria-pressed show-menu?
               :aria-label (tr "shortcut-subsection.main-menu")
               :title (tr "shortcut-subsection.main-menu")
               :on-click toggle-menu}
      [:span {:class (stl/css :logo-menu-mark)} deprecated-icon/logo-icon]
      [:> icon* {:icon-id i/arrow-down
                 :size "s"
                 :class (stl/css :logo-menu-arrow)}]]

     [:> dropdown-menu* {:show show-menu?
                         :id "workspace:menu"
                         :on-close close-menu
                         :class (stl/css :base-menu :menu)}
      [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                               :on-click go-to-files
                               :on-key-down (fn [event]
                                              (when (kbd/enter? event)
                                                (go-to-files event)))
                               :on-pointer-enter close-sub-menu
                               :id "file-menu-back-to-files"}
       [:span {:class (stl/css :item-name)}
        (tr "blueai.menu.back-to-files")]]

      [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                               :on-click open-quick-actions
                               :on-key-down (fn [event]
                                              (when (kbd/enter? event)
                                                (open-quick-actions event)))
                               :on-pointer-enter close-sub-menu
                               :id "file-menu-quick-actions"}
       [:span {:class (stl/css :item-name)}
        (tr "blueai.quick-actions.menu")]
       [:> shortcuts* {:id :quick-actions}]]

      ;; zvena: the documents that show this design (a link back from the design).
      [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                               :on-click #(dom/open-new-window (zvena/linked-docs-url (:id file)))
                               :on-pointer-enter close-sub-menu
                               :id "file-menu-zvena-linked-docs"}
       [:span {:class (stl/css :item-name)}
        (tr "zvena.menu.linked-docs")]]

      [:div {:class (stl/css :separator)}]
      [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                               :on-click    on-menu-click
                               :on-key-down (fn [event]
                                              (when (kbd/enter? event)
                                                (on-menu-click event)))
                               :on-pointer-enter on-menu-click
                               :data-testid   "file"
                               :id          "file-menu-file"}
       [:span {:class (stl/css :item-name)}
        (tr "workspace.header.menu.option.file")]
       [:> icon* {:icon-id i/arrow-right
                  :class (stl/css :item-arrow)}]]

      [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                               :on-click    on-menu-click
                               :on-key-down (fn [event]
                                              (when (kbd/enter? event)
                                                (on-menu-click event)))
                               :on-pointer-enter on-menu-click
                               :data-testid "edit"
                               :id          "file-menu-edit"}
       [:span {:class (stl/css :item-name)}
        (tr "workspace.header.menu.option.edit")]
       [:> icon* {:icon-id i/arrow-right
                  :class (stl/css :item-arrow)}]]

      [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                               :on-click    on-menu-click
                               :on-key-down (fn [event]
                                              (when (kbd/enter? event)
                                                (on-menu-click event)))
                               :on-pointer-enter on-menu-click
                               :data-testid "view"
                               :id          "file-menu-view"}
       [:span {:class (stl/css :item-name)}
        (tr "workspace.header.menu.option.view")]
       [:> icon* {:icon-id i/arrow-right
                  :class (stl/css :item-arrow)}]]

      (when can-edit
        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                                 :on-click    on-menu-click
                                 :on-key-down (fn [event]
                                                (when (kbd/enter? event)
                                                  (on-menu-click event)))
                                 :on-pointer-enter on-menu-click
                                 :data-testid "object"
                                 :id          "file-menu-object"}
         [:span {:class (stl/css :item-name)}
          (tr "blueai.menu.object")]
         [:> icon* {:icon-id i/arrow-right
                    :class (stl/css :item-arrow)}]])

      (when can-edit
        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                                 :on-click    on-menu-click
                                 :on-key-down (fn [event]
                                                (when (kbd/enter? event)
                                                  (on-menu-click event)))
                                 :on-pointer-enter on-menu-click
                                 :data-testid "text"
                                 :id          "file-menu-text"}
         [:span {:class (stl/css :item-name)}
          (tr "blueai.menu.text")]
         [:> icon* {:icon-id i/arrow-right
                    :class (stl/css :item-arrow)}]])

      (when can-edit
        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                                 :on-click    on-menu-click
                                 :on-key-down (fn [event]
                                                (when (kbd/enter? event)
                                                  (on-menu-click event)))
                                 :on-pointer-enter on-menu-click
                                 :data-testid "arrange"
                                 :id          "file-menu-arrange"}
         [:span {:class (stl/css :item-name)}
          (tr "blueai.menu.arrange")]
         [:> icon* {:icon-id i/arrow-right
                    :class (stl/css :item-arrow)}]])

      ;; zvena: Figma's Vector menu
      (when can-edit
        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                                 :on-click    on-menu-click
                                 :on-key-down (fn [event]
                                                (when (kbd/enter? event)
                                                  (on-menu-click event)))
                                 :on-pointer-enter on-menu-click
                                 :data-testid "vector"
                                 :id          "file-menu-vector"}
         [:span {:class (stl/css :item-name)}
          (tr "zvena.menu.vector")]
         [:> icon* {:icon-id i/arrow-right
                    :class (stl/css :item-arrow)}]])

      [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                               :on-click    on-menu-click
                               :on-key-down (fn [event]
                                              (when (kbd/enter? event)
                                                (on-menu-click event)))
                               :on-pointer-enter on-menu-click
                               :data-testid "preferences"
                               :id          "file-menu-preferences"}
       [:span {:class (stl/css :item-name)}
        (tr "workspace.header.menu.option.preferences")]
       [:> icon* {:icon-id i/arrow-right
                  :class (stl/css :item-arrow)}]]

      (when (features/active-feature? @st/state "plugins/runtime")
        [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                                 :on-click    on-menu-click
                                 :on-key-down (fn [event]
                                                (when (kbd/enter? event)
                                                  (on-menu-click event)))
                                 :on-pointer-enter on-menu-click
                                 :data-testid "plugins"
                                 :id          "file-menu-plugins"}
         [:span {:class (stl/css :item-name)}
          (tr "workspace.plugins.menu.title")]
         [:> icon* {:icon-id i/arrow-right
                    :class (stl/css :item-arrow)}]])

      (when (contains? cf/flags :mcp)
        (let [enabled?         (get mcp :enabled)
              conn-status      (get mcp :connection-status)
              has-valid-token? (get mcp :token-valid)

              connected?       (= conn-status "connected")
              error?           (= conn-status "error")


              active?          (and enabled? connected?)
              failed?          (or (and enabled? error?)
                                   (not has-valid-token?))]

          [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                                   :on-click    on-menu-click
                                   :on-key-down (fn [event]
                                                  (when (kbd/enter? event)
                                                    (on-menu-click event)))
                                   :on-pointer-enter on-menu-click
                                   :data-testid "mcp"
                                   :id          "file-menu-mcp"}
           [:span {:class (stl/css :item-name)}
            (tr "workspace.header.menu.option.mcp")]
           [:span {:class (stl/css-case :item-indicator true
                                        :active active?
                                        :failed failed?)}]
           [:> icon* {:icon-id i/arrow-right
                      :class (stl/css :item-arrow)}]]))

      [:div {:class (stl/css :separator)}]

      [:> dropdown-menu-item* {:class (stl/css :base-menu-item :menu-item)
                               :on-click    on-menu-click
                               :on-key-down (fn [event]
                                              (when (kbd/enter? event)
                                                (on-menu-click event)))
                               :on-pointer-enter on-menu-click
                               :data-testid "help-info"
                               :id          "file-menu-help-info"}
       [:span {:class (stl/css :item-name)}
        (tr "workspace.header.menu.option.help-info")]
       [:> icon* {:icon-id i/arrow-right
                  :class (stl/css :item-arrow)}]]

      (when (or (and (contains? cf/flags :subscriptions)
                     (not= "enterprise" subscription-type))
                (contains? cf/flags :admin-console))
        [:> main-menu-power-up* {:close-sub-menu close-sub-menu}])]

     [:div {:class (stl/css :sub-menu-anchor)
            :style {:top (dm/str sub-top "px")}}
     (case selected-sub-menu
       :file
       [:> file-menu* {:file file
                       :on-close close-sub-menu}]

       :edit
       [:> edit-menu* {:on-close close-sub-menu}]

       :view
       [:> view-menu* {:layout layout
                       :toggle-flag toggle-flag
                       :on-close close-sub-menu
                       :on-close-all close-all-menus}]

       (:object :text :arrange :vector)
       [:> command-menu* {:menu selected-sub-menu
                          :on-close-all close-all-menus}]

       :preferences
       [:> preferences-menu* {:layout layout
                              :profile profile
                              :toggle-flag toggle-flag
                              :toggle-theme toggle-theme
                              :toggle-render toggle-render
                              :show-shortcuts show-shortcuts
                              :on-close close-sub-menu}]

       :plugins
       [:> plugins-menu* {:open-plugins open-plugins-manager
                          :on-close close-sub-menu}]

       :mcp
       [:> mcp-menu* {:on-close close-sub-menu :mcp mcp}]

       :help-info
       [:> help-info-menu* {:layout layout
                            :on-close close-sub-menu}]

       nil)]]))
