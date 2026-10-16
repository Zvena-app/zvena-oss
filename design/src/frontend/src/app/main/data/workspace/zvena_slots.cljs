;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-slots
  "zvena: Figma-like slots in components (model and rules in
  app.common.types.zvena-slot).

  A board inside a main is marked as a slot from its design tab. The mark
  is part of the component (app.common.files.changes/components-changed),
  so, as for any edit of a main, the copies in this file are synced at once
  (the sync copies the mark to them) and the files that use the library
  are offered the update."
  (:require
   [app.common.types.component :as ctk]
   [app.common.types.zvena-slot :as zslot]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.zvena-component-props :as zcp]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def max-name-length 60)

(defn slot-main-root
  "For a board of a main that can be a slot (an own layer of the main,
  not its root, not a nested instance nor inside one): the main root.
  Nil otherwise."
  [objects shape-id]
  (let [shape (get objects shape-id)]
    (when (and (= :frame (:type shape))
               (not (ctk/instance-head? shape))
               (some? (zcp/binding-context objects shape-id)))
      (zcp/find-main-root objects shape-id))))

(defn- set-slot-data
  "Writes the slot plugin-data `[[key value] ..]` of the board `frame-id` of
  the current page, when it is a board of a main."
  [frame-id entries]
  (ptk/reify ::set-slot-data
    ptk/WatchEvent
    (watch [_ state _]
      (when (some? (slot-main-root (dsh/lookup-page-objects state) frame-id))
        (rx/of (zcp/set-zvena-data (mapv (fn [[key value]] [frame-id key value]) entries)))))))

(defn set-slot
  "Marks the board `frame-id` (inside a main of the current page) as a slot,
  or unmarks it (the name goes too)."
  [frame-id slot?]
  (ptk/reify ::set-slot
    ptk/WatchEvent
    (watch [_ state _]
      (let [frame (get (dsh/lookup-page-objects state) frame-id)]
        (when (and (some? frame) (not= (boolean slot?) (zslot/slot? frame)))
          (rx/of (set-slot-data frame-id
                                (if slot?
                                  [[zslot/slot-key "true"]]
                                  [[zslot/slot-key nil]
                                   [zslot/slot-name-key nil]]))))))))

(defn rename-slot
  "Names the slot `frame-id` (a blank name removes it: the layer name shows)."
  [frame-id name]
  (ptk/reify ::rename-slot
    ptk/WatchEvent
    (watch [_ state _]
      (let [frame (get (dsh/lookup-page-objects state) frame-id)
            name  (str/trim (or name ""))
            name  (when-not (str/blank? name)
                    (subs name 0 (min max-name-length (count name))))]
        (when (and (zslot/slot? frame)
                   (not= name (zslot/slot-name frame)))
          (rx/of (set-slot-data frame-id [[zslot/slot-name-key name]])))))))
