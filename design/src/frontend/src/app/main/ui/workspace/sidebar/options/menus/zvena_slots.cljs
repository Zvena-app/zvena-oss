;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-slots
  "zvena: the Slot section of the design tab (Figma slots, see
  app.common.types.zvena-slot):

  - on a board inside a main: the \"Slot\" switch and the slot name;
  - on a slot of a copy: what it is, and how many layers were put in it."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.types.file :as ctf]
   [app.common.types.zvena-slot :as zslot]
   [app.main.data.workspace.zvena-slots :as zsl]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.controls.switch :refer [switch*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [rumext.v2 :as mf]))

(mf/defc slot-name-input*
  "The slot name, committed on blur or Enter (Esc reverts). The parent sets
  a `:key` with the name so an external change remounts it."
  {::mf/private true}
  [{:keys [frame-id value placeholder]}]
  (let [on-blur
        (mf/use-fn
         (mf/deps frame-id value)
         (fn [event]
           (let [new-value (dom/get-target-val event)]
             (when (not= (or value "") new-value)
               (st/emit! (zsl/rename-slot frame-id new-value))))))

        on-key-down
        (mf/use-fn
         (mf/deps value)
         (fn [event]
           (let [node (dom/get-target event)]
             (cond
               (kbd/enter? event)
               (do (dom/stop-propagation event)
                   (dom/blur! node))

               (kbd/esc? event)
               (do (dom/stop-propagation event)
                   (dom/set-value! node (or value ""))
                   (dom/blur! node))))))]

    [:> input* {:default-value (or value "")
                :placeholder placeholder
                :aria-label (tr "zvena.slot.name")
                :max-length zsl/max-name-length
                :on-blur on-blur
                :on-key-down on-key-down}]))

(defn- added-layers-count
  "How many children of the slot of a copy `slot` are not copies of the
  children of its main (the layers put in it)."
  [files objects slot]
  (let [ref-slot (ctf/find-ref-shape nil {:type :page :objects objects} files slot
                                     :include-deleted? true
                                     :with-context? true)]
    (if (some? ref-slot)
      (count (zslot/extra-children
              (keep (d/getf objects) (:shapes slot))
              (keep (d/getf (:objects (:container (meta ref-slot)))) (:shapes ref-slot))))
      0)))

(mf/defc slot-menu*
  "Slot section for a single selected board: a board of a main (switch and
  name) or a slot of a copy (information). Renders nothing otherwise."
  [{:keys [shape]}]
  (let [objects   (mf/deref refs/workspace-page-objects)
        files     (mf/deref refs/files)
        selected  (mf/deref refs/selected-shapes)
        shape-id  (:id shape)
        layer     (get objects shape-id)
        main-root (mf/with-memo [objects shape-id]
                    (zsl/slot-main-root objects shape-id))
        slot?     (zslot/slot? layer)
        in-copy?  (zslot/copy-slot? layer)
        added     (mf/with-memo [files objects layer in-copy?]
                    (if in-copy? (added-layers-count files objects layer) 0))

        on-toggle
        (mf/use-fn
         (mf/deps shape-id)
         (fn [checked]
           (st/emit! (zsl/set-slot shape-id checked))))]

    (when (and (some? layer)
               (= 1 (count selected))
               (or (some? main-root) in-copy?))
      [:div {:class (stl/css :slot)}
       [:div {:class (stl/css :slot-header)}
        [:span {:class (stl/css :slot-title)}
         [:> icon* {:icon-id i/slot
                    :size "s"
                    :class (stl/css :slot-icon)}]
         (tr "zvena.slot.title")]
        (when (some? main-root)
          [:> switch* {:default-checked slot?
                       :aria-label (tr "zvena.slot.toggle")
                       :on-change on-toggle}])]

       (cond
         (and (some? main-root) slot?)
         [:*
          [:div {:class (stl/css :slot-row)}
           [:div {:class (stl/css :slot-label)}
            (tr "zvena.slot.name")]
           [:div {:class (stl/css :slot-control)}
            [:> slot-name-input* {:key (dm/str shape-id "-" (zslot/slot-name layer))
                                  :frame-id shape-id
                                  :value (zslot/slot-name layer)
                                  :placeholder (:name layer)}]]]
          [:div {:class (stl/css :slot-hint)}
           (tr "zvena.slot.hint-main")]]

         (some? main-root)
         [:div {:class (stl/css :slot-hint)}
          (tr "zvena.slot.hint-off")]

         :else
         [:*
          [:div {:class (stl/css :slot-row)}
           [:div {:class (stl/css :slot-label)}
            (tr "zvena.slot.name")]
           [:div {:class (stl/css :slot-value)
                  :title (or (zslot/slot-name layer) (:name layer))}
            (or (zslot/slot-name layer) (:name layer))]]
          [:div {:class (stl/css :slot-hint)}
           (if (pos? added)
             (tr "zvena.slot.hint-copy-count" added)
             (tr "zvena.slot.hint-copy"))]])])))
