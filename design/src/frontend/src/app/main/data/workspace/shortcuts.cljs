;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.data.workspace.shortcuts
  (:require
   [app.config :as cf]
   [app.main.data.common :as dcm]
   [app.main.data.event :as ev]
   [app.main.data.exports.assets :as de]
   [app.main.data.modal :as modal]
   [app.main.data.preview :as dp]
   [app.main.data.profile :as du]
   [app.main.data.shortcuts :as ds]
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.colors :as mdc]
   [app.main.data.workspace.common :as dwc]
   [app.main.data.workspace.comments :as dwcm]
   [app.main.data.workspace.drawing :as dwd]
   [app.main.data.workspace.drawing.common :as dwdc]
   [app.main.data.workspace.layers :as dwly]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.notifications :as dwn]
   [app.main.data.workspace.selection :as dwsel]
   [app.main.data.workspace.shape-layout :as dwsl]
   [app.main.data.workspace.shapes :as dws]
   [app.main.data.workspace.text.shortcuts :as dwtxts]
   [app.main.data.workspace.texts :as dwtxt]
   [app.main.data.workspace.transforms :as dwt]
   [app.main.data.workspace.undo :as dwu]
   [app.main.data.workspace.variants :as dwv]
   [app.main.data.workspace.zvena-fills :as zfills]
   [app.main.data.workspace.zvena-sections :as zsec]
   [app.main.features :as features]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.hooks.resize :as r]
   [app.util.dom :as dom]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Shortcuts
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- toggle-layout-flag
  [flag]
  (-> (dw/toggle-layout-flag flag)
      (vary-meta assoc ::ev/origin "workspace-shortcuts")))

(defn on-display-guides-keydown
  [^js event]
  (let [mod?   (if (cf/check-platform? :macos)
                 (.-metaKey event)
                 (.-ctrlKey event))
        shift? (.-shiftKey event)
        code   (.-code event)]
    ;; zvena: Ctrl+Shift+\ is dynamic alignment (:toggle-alignment) now,
    ;; so only Ctrl+' toggles the grids here.
    (when (and mod? (not shift?) (= "Quote" code))
      (.preventDefault event)
      (st/emit! (toggle-layout-flag :display-guides)))))

(defn- emit-when-no-readonly
  [& events]
  (let [can-edit?  (:can-edit (deref refs/permissions))
        read-only? (deref refs/workspace-read-only?)]
    (when (and can-edit? (not read-only?))
      (run! st/emit! events))))

;; zvena: Figma uses different modifiers on macOS for a few commands
;; (e.g. mask is Ctrl+Alt+M on Windows, Cmd+Ctrl+M on macOS).
(def ^:private mac? (cf/check-platform? :macos))
(defn- pcmd [mac other] (if mac? mac other))

;; Shortcuts format https://github.com/ccampbell/mousetrap

(def base-shortcuts
  {;; EDIT
   :undo                 {:tooltip (ds/meta "Z")
                          :command (ds/c-mod "z")
                          :section [:workspace]
                          :subsections [:edit]
                          :fn #(emit-when-no-readonly dwu/undo)}

   ;; zvena: as in Figma, Ctrl+Y is outline mode; redo is Ctrl+Shift+Z
   :redo                 {:tooltip (ds/meta-shift "Z")
                          :command (ds/c-mod "shift+z")
                          :section [:workspace]
                          :subsections [:edit]
                          :fn #(emit-when-no-readonly dwu/redo)}

   :clear-undo           {:tooltip (ds/alt "Q")
                          :command "alt+q"
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly dwu/reinitialize-undo)}

   :copy                 {:tooltip (ds/meta "C")
                          :command (ds/c-mod "c")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(st/emit! (dw/copy-selected))}

   :copy-link            {:tooltip (ds/shift (ds/alt "C"))
                          :command "shift+alt+c"
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(st/emit! (dw/copy-link-to-clipboard))}

   :cut                  {:tooltip (ds/meta "X")
                          :command (ds/c-mod "x")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly
                                (dw/copy-selected)
                                (dw/delete-selected))}

   :paste                {:tooltip (ds/meta "V")
                          :disabled true
                          :command (ds/c-mod "v")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn (constantly nil)}

   ;; zvena: Figma's "Paste to replace" is Ctrl+Shift+R
   :paste-replace        {:tooltip (ds/meta-shift "R")
                          :command (ds/c-mod "shift+r")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/paste-from-clipboard {:replace? true}))}

   ;; zvena: Figma's "Paste over selection"
   :paste-over           {:tooltip (ds/meta-shift "V")
                          :command (ds/c-mod "shift+v")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/paste-from-clipboard))}

   ;; zvena: Figma's "Copy as PNG"
   :copy-as-image        {:tooltip (ds/meta-shift "C")
                          :command (ds/c-mod "shift+c")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(st/emit! (dw/copy-as-image))}

   :copy-props           {:tooltip (ds/meta (ds/alt "C"))
                          :command (ds/c-mod "alt+c")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(st/emit! (dw/copy-selected-props))}

   :paste-props          {:tooltip (ds/meta (ds/alt "V"))
                          :command (ds/c-mod "alt+v")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(st/emit! (dw/paste-selected-props))}

   :delete               {:tooltip (ds/supr)
                          :command ["del" "backspace"]
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/delete-selected))}

   :duplicate            {:tooltip (ds/meta "D")
                          :command (ds/c-mod "d")
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwv/duplicate-or-add-variant))}

   :start-editing        {:tooltip (ds/enter)
                          :command "enter"
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/start-editing-selected))}

   :show-measure        {:tooltip (ds/alt "")
                         :command ["alt" "."]
                         :type ["keydown" "keyup"]
                         :subsections [:tools]
                         :section [:workspace]
                         :fn #(emit-when-no-readonly
                               (let [type (.-type %)]
                                 (dw/toggle-distances-display (if (= type "keydown") true false))))}

   :escape               {:tooltip (ds/esc)
                          :command "escape"
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(st/emit! :interrupt (dwdc/clear-drawing) (dw/deselect-all true))}

   :find             {:tooltip (ds/meta "F") :command (ds/c-mod "f") :subsections [:edit]
                      :section [:workspace]
                      :fn #(st/emit! (dw/open-layers-search :find))}
   :find-and-replace {:tooltip (ds/meta "H") :command (ds/c-mod "h") :subsections [:edit]
                      :section [:workspace]
                      :fn #(st/emit! (dw/open-layers-search :find-and-replace))}

   ;; MODIFY LAYERS

   ;; Figma's Ctrl+R
   :rename               {:tooltip (ds/meta "R")
                          :command [(ds/c-mod "r") "alt+n"]
                          :subsections [:edit]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/start-rename-selected))}

   :group                {:tooltip (ds/meta "G")
                          :command (ds/c-mod "g")
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/group-selected))}

   ;; zvena: Figma's Ctrl+Shift+G (Shift+G kept for old habits)
   :ungroup              {:tooltip (ds/meta-shift "G")
                          :command [(ds/c-mod "shift+g") "shift+g"]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/ungroup-selected))}

   ;; zvena: Figma's Ctrl+Alt+M / Cmd+Ctrl+M (Ctrl+M kept)
   :mask                 {:tooltip (ds/command->tooltip (pcmd "command+ctrl+m" "ctrl+alt+m"))
                          :command [(pcmd "command+ctrl+m" "ctrl+alt+m") (ds/c-mod "m")]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/mask-group))}

   :unmask               {:tooltip (ds/meta-shift "M")
                          :command (ds/c-mod "shift+m")
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/unmask-group))}

   ;; Figma's Ctrl+Alt+K
   :create-component-variant {:tooltip (ds/meta (ds/alt "K"))
                              :command (ds/c-mod "alt+k")
                              :subsections [:modify-layers]
                              :section [:workspace]
                              :fn #(emit-when-no-readonly (dwv/add-component-or-variant))}

   ;; zvena: Figma's Ctrl+Alt+B (Ctrl+Shift+K places an image, as in Figma)
   :detach-component     {:tooltip (ds/meta-alt "B")
                          :command (ds/ca-mod "b")
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly dwl/detach-selected-components)}

   :flip-vertical        {:tooltip (ds/shift "V")
                          :command "shift+v"
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/flip-vertical-selected))}

   :flip-horizontal      {:tooltip (ds/shift "H")
                          :command "shift+h"
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/flip-horizontal-selected))}
   ;; zvena: Figma's Ctrl+] / Ctrl+[ (arrows kept)
   :bring-forward        {:tooltip (ds/meta "]")
                          :command [(ds/c-mod "]") (ds/c-mod "up")]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/vertical-order-selected :up))}

   :bring-backward       {:tooltip (ds/meta "[")
                          :command [(ds/c-mod "[") (ds/c-mod "down")]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/vertical-order-selected :down))}

   :bring-front          {:tooltip (ds/command->tooltip (pcmd "command+alt+]" "ctrl+shift+]"))
                          :command [(pcmd "command+alt+]" "ctrl+shift+]") (ds/c-mod "shift+up")]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/vertical-order-selected :top))}

   :bring-back           {:tooltip (ds/command->tooltip (pcmd "command+alt+[" "ctrl+shift+["))
                          :command [(pcmd "command+alt+[" "ctrl+shift+[") (ds/c-mod "shift+down")]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/vertical-order-selected :bottom))}

   :move-fast-up         {:tooltip (ds/shift ds/up-arrow)
                          :command ["shift+up" "shift+alt+up"]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwt/move-selected :up true))}

   :move-fast-down       {:tooltip (ds/shift ds/down-arrow)
                          :command ["shift+down" "shift+alt+down"]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwt/move-selected :down true))}

   :move-fast-right      {:tooltip (ds/shift ds/right-arrow)
                          :command ["shift+right" "shift+alt+right"]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwt/move-selected :right true))}

   :move-fast-left       {:tooltip (ds/shift ds/left-arrow)
                          :command ["shift+left" "shift+alt+left"]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwt/move-selected :left true))}

   :move-unit-up         {:tooltip ds/up-arrow
                          :command ["up" "alt+up"]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwt/move-selected :up false))}

   :move-unit-down       {:tooltip ds/down-arrow
                          :command ["down" "alt+down"]
                          :section [:workspace]
                          :subsections [:modify-layers]
                          :fn #(emit-when-no-readonly (dwt/move-selected :down false))}

   ;; upstream had left/right swapped (the "left" entry moved right)
   :move-unit-left       {:tooltip ds/left-arrow
                          :command ["left" "alt+left"]
                          :subsections [:modify-layers]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwt/move-selected :left false))}

   :move-unit-right      {:tooltip ds/right-arrow
                          :command ["right" "alt+right"]
                          :section [:workspace]
                          :subsections [:modify-layers]
                          :fn #(emit-when-no-readonly (dwt/move-selected :right false))}

   :artboard-selection   {:tooltip (ds/meta (ds/alt "G"))
                          :command (ds/c-mod "alt+g")
                          :section [:workspace]
                          :subsections [:modify-layers]
                          :fn #(emit-when-no-readonly (dws/create-artboard-from-selection))}

   :toggle-layout-flex   {:tooltip (ds/shift "A")
                          :command "shift+a"
                          :section [:workspace]
                          :subsections [:modify-layers]
                          :fn #(emit-when-no-readonly
                                (with-meta (dwsl/toggle-layout :flex)
                                  {::ev/origin "workspace:shortcuts"}))}

   :toggle-layout-grid   {:tooltip (ds/meta-shift "A")
                          :command (ds/c-mod "shift+a")
                          :section [:workspace]
                          :subsections [:modify-layers]
                          :fn #(emit-when-no-readonly
                                (with-meta (dwsl/toggle-layout :grid)
                                  {::ev/origin "workspace:shortcuts"}))}
   ;; TOOLS

   ;; zvena Design: Figma keys too (F/A frame, O ellipse, Shift+P pencil,
   ;; Shift+F focus mode since F now draws frames).
   :draw-frame           {:tooltip "F"
                          :command ["f" "a" "b"]
                          :section [:workspace :basics]
                          :subsections [:tools :basics]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :frame))}

   ;; zvena: Figma's Section tool and "Wrap in new section"
   :draw-section         {:tooltip (ds/shift "S")
                          :command "shift+s"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :section))}

   ;; zvena: Figma's Slice tool
   :draw-slice           {:tooltip "S"
                          :command "s"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :slice))}

   :wrap-in-section      {:tooltip (ds/meta-alt "S")
                          :command (ds/c-mod "alt+s")
                          :section [:workspace]
                          :subsections [:modify-layers]
                          :fn #(emit-when-no-readonly (zsec/wrap-selection-in-section))}

   :move                 {:tooltip "V"
                          :command "v"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly :interrupt)}

   ;; zvena: Figma's Hand tool (drag pans the canvas, like Space+drag)
   :hand-tool            {:tooltip "H"
                          :command "h"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(st/emit! :interrupt (dwd/select-for-drawing :hand))}

   :draw-rect            {:tooltip "R"
                          :command "r"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :rect))}

   :draw-ellipse         {:tooltip "O"
                          :command ["o" "e"]
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :circle))}

   :draw-text            {:tooltip "T"
                          :command "t"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly dwtxt/start-edit-if-selected
                                                      (dwd/select-for-drawing :text))}

   :draw-path            {:tooltip "P"
                          :command "p"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :path))}

   :draw-line            {:tooltip "L"
                          :command "l"
                          :subsections [:tools]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :line))}

   :draw-arrow           {:tooltip (ds/shift "L")
                          :command "shift+l"
                          :subsections [:tools]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :arrow))}

   :draw-curve           {:tooltip (ds/shift "P")
                          :command "shift+p"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dwd/select-for-drawing :curve))}

   :add-comment          {:tooltip "C"
                          :command "c"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(st/emit! (dwd/select-for-drawing :comments))}

   ;; zvena: Figma's Shift+C (Ctrl+Shift+C copies as PNG)
   :toggle-comments-visibility
   {:tooltip (ds/shift "C")
    :command "shift+c"
    :section [:workspace]
    :subsections [:main-menu]
    :fn #(st/emit! (dwcm/toggle-comments-visibility {:origin "workspace-shortcuts"}))}

   ;; zvena: Figma's Ctrl+Shift+K (Shift+K kept)
   :insert-image         {:tooltip (ds/meta-shift "K")
                          :command [(ds/c-mod "shift+k") "shift+k"]
                          :section [:workspace]
                          :subsections [:tools]
                          ;; zvena: never in Dev Mode or for viewers
                          :fn #(let [can-edit?  (:can-edit (deref refs/permissions))
                                     read-only? (deref refs/workspace-read-only?)]
                                 (when (and can-edit? (not read-only?))
                                   (some-> (dom/get-element "image-upload") dom/click)))}

   :toggle-visibility    {:tooltip (ds/meta-shift "H")
                          :command (ds/c-mod "shift+h")
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dw/toggle-visibility-selected))}

   :toggle-lock          {:tooltip (ds/meta-shift "L")
                          :command (ds/c-mod "shift+l")
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dw/toggle-lock-selected))}

   ;; Shift+L is the Arrow tool (both were bound to it upstream)
   :toggle-lock-size     {:tooltip (ds/alt-shift "L")
                          :command "shift+alt+l"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (dw/toggle-proportion-lock))}

   :scale                {:tooltip "K"
                          :command "k"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (toggle-layout-flag :scale-text))}

   :open-color-picker    {:tooltip "I"
                          :command "i"
                          :section [:workspace]
                          :subsections [:tools]
                          :fn #(emit-when-no-readonly (mdc/picker-for-selected-shape))}

   :toggle-focus-mode    {:command "shift+f"
                          :tooltip (ds/shift "F")
                          :section [:workspace :basics]
                          :subsections [:basics :tools]
                          :fn #(st/emit! (dw/toggle-focus-mode))}

   ;; ITEM ALIGNMENT

   :align-left           {:tooltip (ds/alt "A")
                          :command "alt+a"
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/align-objects :hleft))}

   :align-right          {:tooltip (ds/alt "D")
                          :command "alt+d"
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/align-objects :hright))}

   :align-top            {:tooltip (ds/alt "W")
                          :command "alt+w"
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/align-objects :vtop))}

   :align-hcenter        {:tooltip (ds/alt "H")
                          :command "alt+h"
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/align-objects :hcenter))}

   :align-vcenter        {:tooltip (ds/alt "V")
                          :command "alt+v"
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/align-objects :vcenter))}

   :align-bottom         {:tooltip (ds/alt "S")
                          :command "alt+s"
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/align-objects :vbottom))}

   ;; zvena: Figma's Alt+Shift+H/V (Ctrl+Alt+H/V on macOS)
   :h-distribute         {:tooltip (ds/command->tooltip (pcmd "ctrl+alt+h" "alt+shift+h"))
                          :command [(pcmd "ctrl+alt+h" "alt+shift+h") (ds/c-mod "shift+alt+h")]
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/distribute-objects :horizontal))}

   ;; zvena: Figma's Tidy up (⌃⌥T on macOS, Ctrl+Alt+T elsewhere)
   :tidy-up              {:tooltip (ds/command->tooltip "ctrl+alt+t")
                          :command "ctrl+alt+t"
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/tidy-up))}

   :v-distribute         {:tooltip (ds/command->tooltip (pcmd "ctrl+alt+v" "alt+shift+v"))
                          :command [(pcmd "ctrl+alt+v" "alt+shift+v") (ds/c-mod "shift+alt+v")]
                          :section [:workspace]
                          :subsections [:alignment]
                          :fn #(emit-when-no-readonly (dw/distribute-objects :vertical))}

   ;; MAIN MENU

   ;; Figma's Shift+R
   :toggle-rulers        {:tooltip (ds/shift "R")
                          :command "shift+r"
                          :section [:workspace]
                          :subsections [:main-menu]
                          :fn #(st/emit! (toggle-layout-flag :rulers))}

   ;; zvena: Figma's "Select matching layers" (Ctrl+Alt+A / Cmd+Alt+A)
   :select-matching      {:tooltip (ds/meta-alt "A")
                          :command (ds/ca-mod "a")
                          :section [:workspace]
                          :subsections [:main-menu]
                          :fn #(st/emit! (dw/select-matching))}

   ;; zvena: Figma's Remove fill / Remove stroke
   :remove-fill          {:tooltip (ds/alt "/")
                          :command "alt+/"
                          :section [:workspace]
                          :subsections [:modify-layers]
                          :fn #(emit-when-no-readonly (zfills/remove-fill))}

   :remove-stroke        {:tooltip (ds/alt-shift "/")
                          :command "shift+alt+/"
                          :section [:workspace]
                          :subsections [:modify-layers]
                          :fn #(emit-when-no-readonly (zfills/remove-stroke))}

   ;; zvena: Figma's Zoom to next / previous frame
   :zoom-next-frame      {:tooltip "N"
                          :command "n"
                          :section [:workspace]
                          :subsections [:navigation-workspace]
                          :fn #(st/emit! (dwsel/zoom-to-adjacent-frame 1))}

   :zoom-prev-frame      {:tooltip (ds/shift "N")
                          :command "shift+n"
                          :section [:workspace]
                          :subsections [:navigation-workspace]
                          :fn #(st/emit! (dwsel/zoom-to-adjacent-frame -1))}

   :select-all           {:tooltip (ds/meta "A")
                          :command (ds/c-mod "a")
                          :section [:workspace]
                          :subsections [:main-menu]
                          :fn #(st/emit! (dw/select-all))}

   ;; zvena: Figma's layout grids key first (Ctrl+' kept)
   :toggle-guides        {:tooltip (ds/command->tooltip (pcmd "ctrl+g" "ctrl+shift+4"))
                          ;;https://github.com/ccampbell/mousetrap/issues/85
                          :command [(pcmd "ctrl+g" "ctrl+shift+4") (ds/c-mod "'") (ds/c-mod "219")]
                          :show-command (pcmd "ctrl+g" "ctrl+shift+4")
                          :subsections [:main-menu]
                          :section [:workspace]
                          :fn #(st/emit! (toggle-layout-flag :display-guides))}

   ;; Ctrl+\ hides the interface (both were bound to it upstream)
   :toggle-alignment     {:tooltip (ds/meta-shift "\\")
                          :command (ds/c-mod "shift+\\")
                          :subsections [:main-menu]
                          :section [:workspace]
                          :fn #(st/emit! (toggle-layout-flag :dynamic-alignment))}

   :thumbnail-set        {:tooltip (ds/shift "T")
                          :command "shift+t"
                          :subsections [:main-menu]
                          :section [:workspace]
                          :fn #(st/emit! (dw/toggle-file-thumbnail-selected))}

   ;; zvena: Figma's outline mode (shapes as thin lines; standard renderer)
   ;; zvena: Figma's View > Multiplayer cursors
   :toggle-cursors       {:tooltip (ds/meta-alt "\\")
                          :command (ds/c-mod "alt+\\")
                          :subsections [:main-menu]
                          :section [:workspace]
                          :fn #(st/emit! (toggle-layout-flag :hide-cursors))}

   :toggle-outline-mode  {:tooltip (ds/meta "Y")
                          :command (ds/c-mod "y")
                          :subsections [:main-menu]
                          :section [:workspace]
                          :fn #(st/emit! (toggle-layout-flag :outline-mode))}

   :show-pixel-grid      {:tooltip (ds/shift ",")
                          :command "shift+,"
                          :subsections [:main-menu]
                          :section [:workspace]
                          :fn #(st/emit! (toggle-layout-flag :show-pixel-grid))}

   :snap-pixel-grid      {:command ","
                          :tooltip ","
                          :subsections [:main-menu]
                          :section [:workspace]
                          :fn #(st/emit! (toggle-layout-flag :snap-pixel-grid))}

   :export-shapes        {:tooltip (ds/meta-shift "E")
                          :command (ds/c-mod "shift+e")
                          :subsections [:basics :main-menu]
                          :section [:workspace :basics]
                          :fn #(st/emit!
                                (de/show-workspace-export-dialog {:origin "workspace:shortcuts"}))}

   ;; zvena: Ctrl+Shift+G ungroups, as in Figma
   :toggle-snap-ruler-guide {:tooltip (ds/meta-shift (ds/alt "G"))
                             :command (ds/c-mod "shift+alt+g")
                             :subsections [:main-menu]
                             :section [:workspace]
                             :fn #(st/emit! (toggle-layout-flag :snap-ruler-guides))}

   :toggle-snap-guides      {:tooltip (ds/meta-shift "'")
                             ;;https://github.com/ccampbell/mousetrap/issues/85
                             :command [(ds/c-mod "shift+'") (ds/c-mod "shift+219")]
                             :show-command (ds/c-mod "shift+'")
                             :subsections [:main-menu]
                             :section [:workspace]
                             :fn #(st/emit! (toggle-layout-flag :snap-guides))}

   ;; zvena: Figma's Ctrl+Shift+? (? kept)
   :show-shortcuts       {:tooltip (ds/command->tooltip "ctrl+shift+/")
                          :command ["ctrl+shift+/" "?"]
                          :subsections [:main-menu]
                          :section [:workspace]
                          :fn #(st/emit! (toggle-layout-flag :shortcuts))}

   ;; PANELS

   ;; zvena: Figma's Alt+1 / Alt+2 (Alt+L / Alt+I kept)
   :toggle-layers        {:tooltip (ds/alt "1")
                          :command [(ds/a-mod "1") (ds/a-mod "l")]
                          :subsections [:panels]
                          :section [:workspace]
                          :fn #(st/emit! (dcm/go-to-workspace :layout :layers))}

   :toggle-assets        {:tooltip (ds/alt "2")
                          :command [(ds/a-mod "2") (ds/a-mod "i")]
                          :subsections [:panels]
                          :section [:workspace]
                          :fn #(st/emit! (dcm/go-to-workspace :layout :assets))}

   :toggle-history       {:tooltip (ds/meta-alt "H")
                          :command (ds/ca-mod "h")
                          :subsections [:panels]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly
                                (dw/toggle-layout-flag :document-history))}

   :toggle-colorpalette  {:tooltip (ds/alt "P")
                          :command (ds/a-mod "p")
                          :subsections [:panels]
                          :section [:workspace]
                          :fn #(do (r/set-resize-type! :bottom)
                                   (emit-when-no-readonly (dw/remove-layout-flag :hide-palettes)
                                                          (dw/remove-layout-flag :textpalette)
                                                          (toggle-layout-flag :colorpalette)))}

   :toggle-textpalette   {:tooltip (ds/alt "T")
                          :command (ds/a-mod "t")
                          :subsections [:panels]
                          :section [:workspace]
                          :fn #(do (r/set-resize-type! :bottom)
                                   (emit-when-no-readonly (dw/remove-layout-flag :hide-palettes)
                                                          (dw/remove-layout-flag :colorpalette)
                                                          (toggle-layout-flag :textpalette)))}

   ;; Figma's Ctrl+\ (a plain \ selects the parent layer, as in Figma)
   :hide-ui              {:tooltip (ds/meta "\\")
                          :command (ds/c-mod "\\")
                          :subsections [:panels :basics]
                          :section [:workspace :basics]
                          :fn #(st/emit! (toggle-layout-flag :hide-ui))}

   ;; ZOOM-WORKSPACE

   :increase-zoom        {:tooltip "+"
                          :command ["+" "="]
                          :subsections [:zoom-workspace]
                          :section [:workspace]
                          :fn #(st/emit! (dw/increase-zoom))}

   :decrease-zoom        {:tooltip "-"
                          :command ["-" "_"]
                          :subsections [:zoom-workspace]
                          :section [:workspace]
                          :fn #(st/emit! (dw/decrease-zoom))}

   :reset-zoom           {:tooltip (ds/shift "0")
                          :command ["shift+0" "shift+num0" (ds/c-mod "0")]
                          :subsections [:zoom-workspace]
                          :section [:workspace]
                          :fn #(st/emit! dw/reset-zoom)}

   :fit-all              {:tooltip (ds/shift "1")
                          :command ["shift+1" "shift+num1"]
                          :subsections [:zoom-workspace]
                          :section [:workspace]
                          :fn #(st/emit! dw/zoom-to-fit-all)}

   :zoom-selected        {:tooltip (ds/shift "2")
                          :command ["shift+2" "shift+num2" "@" "\""]
                          :subsections [:zoom-workspace]
                          :section [:workspace]
                          :fn #(st/emit! dw/zoom-to-selected-shape)}

   :zoom-lense-increase  {:tooltip "Z"
                          :command "z"
                          :subsections [:zoom-workspace]
                          :section [:workspace]
                          :fn identity}

   :zoom-lense-decrease  {:tooltip (ds/alt "Z")
                          :command "alt+z"
                          :subsections [:zoom-workspace]
                          :section [:workspace]
                          :fn identity}

   ;; NAVIGATION


   :open-viewer          {:tooltip "G V"
                          :command "g v"
                          :subsections [:navigation-workspace]
                          :section [:workspace]
                          :fn #(st/emit! (dcm/go-to-viewer))}

   :open-inspect         {:tooltip "G I"
                          :command "g i"
                          :subsections [:navigation-workspace]
                          :section [:workspace]
                          :fn #(st/emit! (dcm/go-to-viewer :section :inspect))}

   :open-comments        {:tooltip "G C"
                          :command "g c"
                          :subsections [:navigation-workspace]
                          :section [:workspace]
                          :fn #(st/emit! (dcm/go-to-viewer :section :comments))}

   :open-dashboard       {:tooltip "G D"
                          :command "g d"
                          :subsections [:navigation-workspace]
                          :section [:workspace]
                          :fn #(st/emit! (dcm/go-to-dashboard-recent))}

   :select-prev          {:tooltip (ds/shift "tab")
                          :command "shift+tab"
                          :subsections [:navigation-workspace]
                          :section [:workspace]
                          :fn #(st/emit! (dw/select-prev-shape))}

   :select-next          {:tooltip ds/tab
                          :command "tab"
                          :subsections [:navigation-workspace]
                          :section [:workspace]
                          :fn #(st/emit! (dw/select-next-shape))}

   :select-parent-layer  {:tooltip (ds/shift (ds/enter))
                          :command ["shift+enter" "\\"]
                          :subsections [:navigation-workspace]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/select-parent-layer))}
   ;; SHAPE
   ;; zvena: Figma's Alt+Shift+U/S/I/X for booleans (Ctrl+Alt+... kept)


   :bool-union           {:tooltip (ds/alt-shift "U")
                          :command ["shift+alt+u" (ds/c-mod "alt+u")]
                          :subsections [:shape]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/create-bool :union))}

   :bool-difference      {:tooltip (ds/alt-shift "S")
                          :command ["shift+alt+s" (ds/c-mod "alt+d")]
                          :subsections [:shape]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/create-bool :difference))}

   :bool-intersection    {:tooltip (ds/alt-shift "I")
                          :command ["shift+alt+i" (ds/c-mod "alt+i")]
                          :subsections [:shape]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/create-bool :intersection))}

   :bool-exclude         {:tooltip (ds/alt-shift "X")
                          :command ["shift+alt+x" (ds/c-mod "alt+e")]
                          :subsections [:shape]
                          :section [:workspace]
                          :fn #(emit-when-no-readonly (dw/create-bool :exclude))}

   ;; zvena: Figma's Ctrl+E (frames and paths are skipped, as in the
   ;; context menu)
   :flatten              {:tooltip (ds/meta "E")
                          :command (ds/c-mod "e")
                          :subsections [:shape]
                          :section [:workspace]
                          :fn #(let [objects (deref refs/workspace-page-objects)
                                     ids     (->> (deref refs/selected-shapes)
                                                  (remove (fn [id]
                                                            (let [shape (get objects id)]
                                                              (or (nil? shape)
                                                                  (= :frame (:type shape))
                                                                  (= :path (:type shape))))))
                                                  (not-empty))]
                                 (when ids
                                   (emit-when-no-readonly (dw/convert-selected-to-path ids))))}

   ;; THEME
   :toggle-theme         {:tooltip (ds/alt "M")
                          :command (ds/a-mod "m")
                          :subsections [:generic :basics]
                          :section [:workspace :basics]
                          :fn #(st/emit! (with-meta (du/toggle-theme)
                                           {::ev/origin "workspace:shortcut"}))}


   ;; BLUEAI: Figma's Quick actions
   :quick-actions         {:tooltip (ds/meta "/")
                           :command [(ds/c-mod "/") (ds/c-mod "k")]
                           :subsections [:generic :basics]
                           :section [:workspace :basics]
                           :fn #(st/emit! (toggle-layout-flag :quick-actions))}

   ;; zvena: Figma's cursor chat
   :cursor-chat           {:tooltip "/"
                           :command "/"
                           :subsections [:generic :basics]
                           :section [:workspace :basics]
                           :fn #(st/emit! (dwn/open-cursor-chat))}

   ;; BLUEAI: Figma's Dev Mode toggle
   :toggle-dev-mode       {:tooltip (ds/shift "D")
                           :command "shift+d"
                           :subsections [:generic :basics]
                           :section [:workspace :basics]
                           ;; zvena: editors only — a viewer must never
                           ;; switch the workspace out of read-only.
                           :fn #(when (:can-edit (deref refs/permissions))
                                  (let [dev? (= :inspect (get-in @st/state [:workspace-global :options-mode]))]
                                    (st/emit! (dw/set-options-mode (if dev? :design :inspect))
                                              :interrupt
                                              (dwc/set-workspace-read-only (not dev?)))))}

   ;; PLUGINS
   :plugins               {:tooltip (ds/meta (ds/alt "P"))
                           :command (ds/c-mod "alt+p")
                           :subsections [:generic :basics]
                           :section [:workspace :basics]
                           :fn #(when (features/active-feature? @st/state "plugins/runtime")
                                  (st/emit!
                                   (ev/event {::ev/name "open-plugins-manager" ::ev/origin "workspace:shortcuts"})
                                   (modal/show :plugin-management {})))}})

(def debug-shortcuts
  ;; PREVIEW
  {:preview-frame        {:tooltip (ds/meta (ds/alt (ds/enter)))
                          :command (ds/c-mod "alt+enter")
                          :fn #(emit-when-no-readonly (dp/open-preview-selected))}})

(def opacity-shortcuts
  (into {} (->>
            (range 10)
            (map (fn [n] [(keyword (str "opacity-" n))
                          {:tooltip (str n)
                           :command [(str n) (str "num" n)]
                           :section [:workspace]
                           :subsections [:modify-layers]
                           :fn #(emit-when-no-readonly (dwly/pressed-opacity n))}])))))

(def shortcuts
  (cond-> (merge base-shortcuts opacity-shortcuts dwtxts/shortcuts)
    *assert*
    (merge debug-shortcuts)))

(defn get-tooltip
  "Returns the tooltip string for a shortcut, using any custom binding
  from the user's profile props if one exists, falling back to the
  default :tooltip field."
  [shortcut]
  (assert (contains? shortcuts shortcut) (str shortcut))
  (let [custom-shortcuts (deref refs/custom-shortcuts)
        custom-command   (get-in custom-shortcuts [:workspace shortcut])]
    (if (and custom-command (not= custom-command ""))
      (ds/command->tooltip custom-command)
      (get-in shortcuts [shortcut :tooltip]))))

(defn get-effective-tooltip
  "Returns the tooltip string for a shortcut given an already-resolved
  custom-shortcuts map. Use this when you already have the custom
  shortcuts derefed for the current render cycle."
  [shortcut custom-shortcuts]
  (let [custom-command (get-in custom-shortcuts [:workspace shortcut])]
    (if (and custom-command (not= custom-command ""))
      (ds/command->tooltip custom-command)
      (get-in shortcuts [shortcut :tooltip]))))
