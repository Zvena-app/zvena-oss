;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-sections
  "zvena: Figma sections (Shift+S). A section is a frame marked in its
  plugin-data ({:zvena {\"section\" \"true\"}}): white, unclipped, hidden
  in the viewer (not a prototype screen), and the frames it holds stay
  top-level frames (titles, viewer screens, Dev Mode status)."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.files.shapes-helpers :as cfsh]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
   [app.common.types.shape :as cts]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.shape.zvena :as ctsz]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.selection :as dws]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def section-attrs
  "What a new section gets on top of a plain frame. Figma: a white,
  slightly rounded container that does not clip and is not a screen."
  {:name "Section"
   :show-content true
   :hide-in-viewer true
   :r1 2
   :r2 2
   :r3 2
   :r4 2
   :plugin-data {ctsz/plugin-ns {ctsz/section-key "true"}}})

;; zvena: Figma's slice — an invisible rect exported as what lies beneath
(def slice-attrs
  {:name "Slice"
   :fills []
   :strokes []
   :exports [{:type :png :scale 1 :suffix ""}]
   :plugin-data {ctsz/plugin-ns {ctsz/slice-key "true"}}})

;; Figma leaves this margin around the layers of "Wrap in new section"
(def ^:private wrap-padding 40)

(defn make-section
  "A new section shape for `attrs` (:x :y :width :height :parent-id
  :frame-id...)."
  [attrs]
  (cts/setup-shape (merge {:type :frame} section-attrs attrs)))

(defn contained-shape-ids
  "Ids of the children of `parent-id` that lie fully inside `rect` (the
  layers a new section adopts). Blocked layers stay out, as with boards."
  [objects parent-id rect exclude-id]
  (into []
        (comp (keep (d/getf objects))
              (remove #(= (:id %) exclude-id))
              (remove :blocked)
              (filter #(some? (:points %)))
              (filter #(grc/contains-rect? rect (grc/points->rect (:points %))))
              (map :id))
        (dm/get-in objects [parent-id :shapes])))

(defn- add-to-section-changes
  [changes section-id ids objects]
  (let [ids    (cfh/order-by-indexed-shapes objects ids)
        shapes (into [] (keep (d/getf objects)) ids)]
    (if (seq shapes)
      (-> changes
          (pcb/update-shapes ids ctl/remove-layout-item-data)
          ;; Unlike boards, nothing gets :hide-in-viewer here: a frame in a
          ;; section is still a prototype screen.
          (pcb/change-parent section-id shapes 0))
      changes)))

(defn move-into-section
  "Moves the layers `ids` into the section `section-id`."
  [section-id ids]
  (ptk/reify ::move-into-section
    ptk/WatchEvent
    (watch [it state _]
      (let [page-id (:current-page-id state)
            objects (dsh/lookup-page-objects state page-id)
            ids     (->> ids
                         (remove #(= % section-id))
                         (filter #(contains? objects %))
                         (remove #(dm/get-in objects [% :blocked])))]
        (if (and (seq ids) (ctsz/section? (get objects section-id)))
          (let [changes (-> (pcb/empty-changes it page-id)
                            (pcb/with-objects objects)
                            (add-to-section-changes section-id ids objects))]
            (rx/of (dch/commit-changes changes)))
          (rx/empty))))))

(defn wrap-selection-in-section
  "Figma's \"Wrap in new section\" (Ctrl+Alt+S): a section around the
  selected layers. They must share a parent that is the canvas or another
  section (sections never go inside frames)."
  []
  (ptk/reify ::wrap-selection-in-section
    ptk/WatchEvent
    (watch [it state _]
      (let [page-id    (:current-page-id state)
            objects    (dsh/lookup-page-objects state page-id)
            selected   (dsh/lookup-selected state {:omit-blocked? true})
            shapes     (into [] (keep (d/getf objects)) selected)
            parent-ids (into #{} (map :parent-id) shapes)
            parent-id  (first parent-ids)]
        (if (and (seq shapes)
                 (= 1 (count parent-ids))
                 (or (= uuid/zero parent-id)
                     (ctsz/section? (get objects parent-id))))
          (let [srect   (gsh/shapes->rect shapes)
                ;; top-most first: the section takes the place of the
                ;; bottom-most layer, so nothing else ends up behind it
                ids     (cfh/order-by-indexed-shapes objects selected)
                index   (cfh/get-position-on-parent objects (last ids))
                name    (cfh/generate-unique-name "Section" (cfh/get-used-names objects)
                                                  :immediate-suffix? true)
                section (-> (make-section {:x (- (:x srect) wrap-padding)
                                           :y (- (:y srect) wrap-padding)
                                           :width (+ (:width srect) (* 2 wrap-padding))
                                           :height (+ (:height srect) (* 2 wrap-padding))
                                           :parent-id parent-id
                                           :frame-id parent-id
                                           :name name})
                            (with-meta {:index index}))

                [section changes]
                (-> (pcb/empty-changes it page-id)
                    (pcb/with-objects objects)
                    (cfsh/prepare-add-shape section objects))

                changes (add-to-section-changes changes (:id section) ids objects)]
            (rx/of (dch/commit-changes changes)
                   (dws/select-shapes (d/ordered-set (:id section)))))
          (rx/empty))))))
