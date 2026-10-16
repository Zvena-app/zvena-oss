;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-devmode
  "zvena: Figma Dev Mode data — the \"Ready for dev\" status of top-level
  frames and annotations on any layer. Both live in the shapes'
  plugin-data (:zvena namespace, see app.common.types.shape.zvena) and
  are written with the same change the plugin API's setPluginData uses,
  so they are undoable, synced and saved like any other edit. Dev Mode
  keeps the workspace UI read-only, but commits still go through for
  editors (see app.main.data.changes/commit-changes)."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.time :as ct]
   [app.common.types.shape.zvena :as ctsz]
   [app.main.data.changes :as dch]
   [app.main.data.common :as dcm]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.common :as dwc]
   [app.main.data.workspace.layout :as dwly]
   [app.main.data.workspace.pages :as-alias dwpg]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zoom :as dwz]
   [beicon.v2.core :as rx]
   [clojure.string :as str]
   [potok.v2.core :as ptk]))

(defn set-zvena-data
  "Writes `kvs` (string key -> string value; nil removes the key) into
  the zvena plugin-data of the shapes `ids` of the current page, as a
  single undo step."
  [ids kvs]
  (ptk/reify ::set-zvena-data
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id (:current-file-id state)
            page-id (:current-page-id state)
            fdata   (dsh/lookup-file-data state file-id)
            objects (dsh/lookup-page-objects state file-id page-id)
            entries (for [id ids
                          :when (contains? objects id)
                          [k v] kvs
                          :when (not= v (ctsz/get-data (get objects id) k))]
                      [id k v])]
        (if (and (some? fdata) (seq entries))
          (let [changes (reduce (fn [changes [id k v]]
                                  (pcb/set-plugin-data changes :shape id page-id ctsz/plugin-ns k v))
                                (-> (pcb/empty-changes it)
                                    (pcb/with-file-data fdata)
                                    (assoc :file-id file-id))
                                entries)]
            (rx/of (dch/commit-changes changes)))
          (rx/empty))))))

;; --- Ready for dev

(defn set-dev-status
  "Marks the frames `ids` \"ready\" (Ready for dev) or \"completed\", or
  clears the mark with nil. Records who and when, as Figma shows them."
  [ids status]
  (assert (or (nil? status) (contains? ctsz/dev-statuses status))
          "expected a valid dev status")
  (ptk/reify ::set-dev-status
    ptk/WatchEvent
    (watch [_ state _]
      (let [profile (dsh/lookup-profile state)
            by      (when (some? status)
                      (or (not-empty (:fullname profile))
                          (:email profile)))
            at      (when (some? status)
                      (ct/format-inst (ct/now) :iso))]
        (rx/of (set-zvena-data ids {ctsz/dev-status-key status
                                    ctsz/dev-status-by-key by
                                    ctsz/dev-status-at-key at}))))))

(defn toggle-ready-for-dev
  "Context menu / shortcut action: marks the selected top-level frames
  Ready for dev, or clears them when all of them already are."
  []
  (ptk/reify ::toggle-ready-for-dev
    ptk/WatchEvent
    (watch [_ state _]
      (let [objects (dsh/lookup-page-objects state)
            frames  (->> (dsh/lookup-selected state)
                         (keep (d/getf objects))
                         (filter #(ctsz/top-level-frame? objects %)))
            ids     (mapv :id frames)]
        (when (seq ids)
          (rx/of (set-dev-status ids (if (every? #(= "ready" (ctsz/dev-status %)) frames)
                                       nil
                                       "ready"))))))))

;; --- Annotations

(defn set-annotation
  "Saves the annotation `text` and the pinned properties `props` (a coll
  of strings) of the layer `id`; blank text and no props remove it."
  [id text props]
  (let [text  (when (string? text)
                (let [text (str/trim text)]
                  (when-not (str/blank? text) text)))
        props (when (seq props)
                (str/join "," (distinct props)))]
    (set-zvena-data [id] {ctsz/annotation-key text
                          ctsz/annotation-props-key props})))

(defn annotation-editing
  "Id of the layer whose annotation is open for editing, if any."
  [state]
  (get state ::annotation-edit))

(defn stop-annotation
  []
  (ptk/reify ::stop-annotation
    ptk/UpdateEvent
    (update [_ state]
      (dissoc state ::annotation-edit))))

(defn start-annotation
  "Figma's \"Add annotation\": opens the annotation editor of the layer
  `id` (or of the single selected layer), switching to Dev Mode."
  ([]
   (ptk/reify ::start-annotation-selected
     ptk/WatchEvent
     (watch [_ state _]
       (let [selected (dsh/lookup-selected state)]
         (when (= 1 (count selected))
           (rx/of (start-annotation (first selected))))))))
  ([id]
   (ptk/reify ::start-annotation
     ptk/WatchEvent
     (watch [_ state _]
       (let [dev-mode? (= :inspect (dm/get-in state [:workspace-global :options-mode]))
             can-edit? (dm/get-in state [:permissions :can-edit])]
         (when can-edit?
           (rx/concat
            (when-not dev-mode?
              (rx/of (dwly/set-options-mode :inspect)
                     :interrupt
                     (dwc/set-workspace-read-only true)))
            (rx/of (dws/select-shapes (d/ordered-set id))
                   #(assoc % ::annotation-edit id)))))))))

;; --- Navigation

(defn go-to-shape
  "Selects the layer `id` of the page `page-id` and zooms to it, opening
  that page first when it is not the current one (Ready for dev list)."
  [page-id id]
  (ptk/reify ::go-to-shape
    ptk/WatchEvent
    (watch [_ state stream]
      (let [select-and-zoom
            (rx/of (dws/select-shapes (d/ordered-set id))
                   dwz/zoom-to-selected-shape)]
        (if (= page-id (:current-page-id state))
          select-and-zoom
          (rx/merge
           (->> stream
                (rx/filter (ptk/type? ::dwpg/initialize-page))
                (rx/take 1)
                (rx/observe-on :async)
                (rx/mapcat (fn [_] select-and-zoom)))
           (rx/of (dcm/go-to-workspace :page-id page-id))))))))
