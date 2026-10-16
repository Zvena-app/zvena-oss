;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.common.types.zvena-slot
  "zvena: Figma-like slots in components.

  A board inside a main component can be marked as a *slot*: on the copies,
  people can add, remove and reorder any layers inside it, and the library
  sync keeps them. The mark is shape plugin-data under the `:zvena`
  namespace, so it needs no schema change and old files are untouched:

  - \"slot\"      \"true\" on the board
  - \"slot-name\" optional name of the slot (the layer name otherwise)

  The copies of a main carry the mark too: an instance clones the plugin
  data of its main, and the library sync copies the mark from the main to
  the copies made before (app.common.logic.libraries). So the rules about
  the structure of copies only need the shapes of the page:

  - The children of a slot of a copy are free: they can be added, deleted
    and moved like layers outside components
    (app.common.types.container, app.common.files.changes).
  - Changing the children of a slot of a copy marks the slot with the
    touched group `:shapes-group`, which the component sync already
    honours: it neither adds, removes nor reorders the children of a
    touched shape. The children that come from the main keep syncing their
    attributes, and so does the slot board itself. \"Reset overrides\"
    clears it and restores the slot of the main.
  - The sync never removes the layers put in a slot (the children that are
    not copies of children of the main), even when the slot is not marked
    as touched yet."
  (:require
   [app.common.data.macros :as dm]
   [app.common.types.component :as ctk]
   [app.common.uuid :as uuid]))

(def plugin-ns :zvena)

(def slot-key "slot")
(def slot-name-key "slot-name")

(def marker-keys
  "plugin-data keys that the copies take from their main."
  [slot-key slot-name-key])

(def structure-group
  "The touched group of a shape whose list of children is its own."
  :shapes-group)

(defn slot?
  "Is the shape a board marked as a slot (in a main or in a copy)?"
  [shape]
  (and (some? shape)
       (= :frame (:type shape))
       (= "true" (dm/get-in shape [:plugin-data plugin-ns slot-key]))))

(defn slot-name
  "The name of the slot, or nil."
  [shape]
  (let [name (dm/get-in shape [:plugin-data plugin-ns slot-name-key])]
    (when (and (string? name) (not= "" name))
      name)))

(defn copy-slot?
  "Is the shape a slot of a copy (its list of children is free)?"
  [shape]
  (and (slot? shape)
       (ctk/in-component-copy? shape)))

(defn structure-free?
  "Can the children of `parent` change? True outside copies and for the
  slots of copies."
  [parent]
  (or (not (ctk/in-component-copy? parent))
      (copy-slot? parent)))

(defn in-slot-content?
  "Is the shape inside the content of a slot of a copy, at any depth?"
  [objects shape]
  (loop [id    (:parent-id shape)
         depth 0]
    (let [parent (get objects id)]
      (cond
        (or (nil? parent) (> depth 1000)) false
        (copy-slot? parent)               true
        (= id uuid/zero)                  false
        :else                             (recur (:parent-id parent) (inc depth))))))

(defn structure-touched?
  [shape]
  (some? (ctk/touched-group? shape structure-group)))

(defn touch-structure
  "Marks the list of children of the shape as its own."
  [shape]
  (update shape :touched ctk/set-touched-group structure-group))

(defn extra-children
  "The children of a slot of a copy (`children-inst`, shapes) that are not
  copies of the children of its main (`children-main`, shapes): the layers
  people put in it. Swapped children are copies (they have a swap slot)."
  [children-inst children-main]
  (let [main-ids (into #{} (map :id) children-main)]
    (filterv #(and (not (contains? main-ids (:shape-ref %)))
                   (nil? (ctk/get-swap-slot %)))
             children-inst)))
