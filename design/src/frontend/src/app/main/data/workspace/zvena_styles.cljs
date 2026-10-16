;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-styles
  "zvena: Figma's Effects section and its effect styles / layout grid
  styles (see app.common.types.shape.zvena-effects for the data).

  - Effects of the layers: shadows and blurs in Penpot's attributes, noise
    and texture in the layers' zvena plugin-data; one commit (one undo
    step) per edit. A direct edit detaches the applied effect style.
  - Styles live in the file's zvena plugin-data and are written with the
    same change the plugin API's setPluginData uses, so they are undoable,
    saved, sent to the other sessions and read by the files that use the
    library like any library data.
  - A layer with a style keeps a copy of its values (so the renderers,
    the exporter and old clients see plain layers) plus the reference.
    Editing a local style updates every layer of the file that uses it;
    the layers that use a style of a library take its new values on the
    library \"Update\" (app.main.data.workspace.libraries/sync-file)."
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.logic.shapes :as cls]
   [app.common.types.color :as clr]
   [app.common.types.grid :as ctg]
   [app.common.types.shape.zvena-effects :as zfx]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def kinds [:effect :grid])

;; --- Defaults (Figma's)

(defn default-shadow
  ([] (default-shadow :drop-shadow))
  ([style]
   (cond-> {:id (uuid/next)
            :style style
            :color {:color clr/black :opacity 0.25}
            :offset-x 0
            :offset-y 4
            :blur 4
            :spread 0
            :hidden false}
     (= style :drop-shadow)
     (assoc :show-behind false))))

(defn default-blur
  [type]
  {:id (uuid/next)
   :type type
   :value 4
   :hidden false})

(defn default-grid
  []
  {:type :column
   :display true
   :params (:column ctg/default-grid-params)})

(defn- default-value
  [kind]
  (case kind
    :effect (zfx/check-effects {:shadow [(default-shadow)]})
    :grid   [(default-grid)]))

;; --- Changes helpers

(defn- plugin-change
  "Raw set-plugin-data change (and its undo) of `key` of the `shape` of
  `page-id` in the plugin-data namespace `ns`."
  [changes page-id shape ns key value]
  (let [old (dm/get-in shape [:plugin-data ns key])]
    (if (= old value)
      changes
      (let [base {:type :set-plugin-data
                  :object-type :shape
                  :object-id (:id shape)
                  :page-id page-id
                  :namespace ns
                  :key key}]
        (-> changes
            (update :redo-changes conj (assoc base :value value))
            (update :undo-changes conj (assoc base :value old)))))))

(defn- zvena-data-changes
  "Writes the zvena plugin-data entries `kvs` {key value-or-nil} of
  `shape`; a value the plugins wrote in the shared namespace is cleared
  so the new one wins."
  [changes page-id shape kvs]
  (reduce-kv
   (fn [changes key value]
     (if (= value (zfx/get-data shape key))
       changes
       (-> changes
           (plugin-change page-id shape zfx/plugin-ns key value)
           (cond-> (some? (dm/get-in shape [:plugin-data zfx/shared-ns key]))
             (plugin-change page-id shape zfx/shared-ns key nil)))))
   changes
   kvs))

(defn- value-attrs
  [kind]
  (case kind
    :effect zfx/effect-attrs
    :grid   [:grids]))

(defn- set-value
  [kind shape value]
  (case kind
    :effect (zfx/set-attr-effects shape value)
    :grid   (if (cfh/frame-shape? shape)
              (if (and (empty? value) (nil? (:grids shape)))
                shape
                (assoc shape :grids (into [] value)))
              shape)))

(defn- value-kvs
  [kind value]
  (case kind
    :effect (zfx/plugin-effects value)
    :grid   {}))

(defn- targets
  "The layers of `ids` a style of `kind` can go to."
  [kind objects ids]
  (into []
        (comp (keep #(get objects %))
              (filter #(or (= kind :effect) (cfh/frame-shape? %)))
              (map :id))
        ids))

(defn- apply-values-changes
  "Gives each layer `id` of the page the value `(get values id)` of
  `kind`. `ref`: the style reference to write (nil detaches) or ::keep."
  [changes page-id objects kind values {:keys [ref ignore-touched]}]
  (let [ids     (into [] (filter #(contains? objects %)) (keys values))
        attrs   (-> (pcb/empty-changes nil page-id)
                    (cls/generate-update-shapes ids
                                                (fn [shape]
                                                  (set-value kind shape (get values (:id shape))))
                                                objects
                                                {:attrs (value-attrs kind)
                                                 :ignore-touched (boolean ignore-touched)}))
        changes (pcb/concat-changes changes attrs)]
    (reduce (fn [changes id]
              (let [shape (get objects id)
                    kvs   (cond-> (value-kvs kind (get values id))
                            (not= ref ::keep)
                            (assoc (zfx/style-ref-key kind) ref))]
                (zvena-data-changes changes page-id shape kvs)))
            changes
            ids)))

(defn- file-style-change
  "Writes (or removes, `style` nil) the style `style-id` of `kind` in the
  current file."
  [changes data kind style-id style]
  (let [key  (zfx/style-key kind style-id)
        old  (dm/get-in data [:plugin-data zfx/plugin-ns key])
        new  (when (some? style)
               (zfx/encode-style kind style))
        base {:type :set-plugin-data
              :object-type :file
              :namespace zfx/plugin-ns
              :key key}]
    (if (= old new)
      changes
      (-> changes
          (update :redo-changes conj (assoc base :value new))
          (update :undo-changes conj (assoc base :value old))))))

(defn- styled-shapes
  "{page-id [shape]} of the layers of `data` that use the style `ref`."
  [data kind ref]
  (let [key (zfx/style-ref-key kind)]
    (reduce (fn [result page]
              (let [shapes (into []
                                 (filter #(= ref (zfx/get-data % key)))
                                 (vals (:objects page)))]
                (cond-> result
                  (seq shapes) (assoc (:id page) shapes))))
            {}
            (vals (:pages-index data)))))

(defn- propagate-changes
  "Every layer of `data` that uses the style `ref` takes `value`."
  [changes data kind ref value]
  (reduce-kv (fn [changes page-id shapes]
               (let [objects (dm/get-in data [:pages-index page-id :objects])
                     values  (into {} (map (fn [shape] [(:id shape) value])) shapes)]
                 (apply-values-changes changes page-id objects kind values
                                       {:ref ::keep :ignore-touched true})))
             changes
             (styled-shapes data kind ref)))

(defn- detach-all-changes
  "Every layer of `data` that uses the style `ref` keeps its values and
  loses the reference."
  [changes data kind ref]
  (let [key (zfx/style-ref-key kind)]
    (reduce-kv (fn [changes page-id shapes]
                 (reduce (fn [changes shape]
                           (zvena-data-changes changes page-id shape {key nil}))
                         changes
                         shapes))
               changes
               (styled-shapes data kind ref))))

(defn- commit
  [changes]
  (if (seq (:redo-changes changes))
    (rx/of (dch/commit-changes changes))
    (rx/empty)))

;; --- Lookups

(defn lookup-style
  [state kind file-id style-id]
  (zfx/get-style (dsh/lookup-file-data state file-id) kind style-id))

(defn style-libraries
  "[[file style]] of the styles of `kind` of the current file and its
  libraries: {:local [style] :libraries [[file [style]]]}."
  [files file-id kind]
  {:local (zfx/get-styles (dm/get-in files [file-id :data]) kind)
   :libraries (->> (vals files)
                   (filter #(and (= file-id (:library-of %))
                                 (not= file-id (:id %))
                                 (some? (:data %))))
                   (keep (fn [file]
                           (let [styles (zfx/get-styles (:data file) kind)]
                             (when (seq styles)
                               [file styles]))))
                   (sort-by (comp str/lower str :name first))
                   (into []))})

;; --- Effects of the layers

(defn update-shape-effects
  "Gives each layer of `ids` (current page) the effects `(f effects)`.
  Detaches their effect style (Figma: editing effects detaches it)."
  [ids f]
  (ptk/reify ::update-shape-effects
    ptk/WatchEvent
    (watch [it state _]
      (let [page-id (:current-page-id state)
            objects (dsh/lookup-page-objects state page-id)
            values  (into {}
                          (keep (fn [id]
                                  (when-let [shape (get objects id)]
                                    [id (zfx/check-effects (f (zfx/get-effects shape)))])))
                          ids)]
        (-> (pcb/empty-changes it page-id)
            (apply-values-changes page-id objects :effect values {:ref nil})
            (commit))))))

;; --- Styles on layers

(defn apply-style
  "Applies the style `style-id` of the file (or library) `file-id` to the
  layers `ids` of the current page."
  [kind ids file-id style-id]
  (ptk/reify ::apply-style
    ptk/WatchEvent
    (watch [it state _]
      (let [page-id (:current-page-id state)
            objects (dsh/lookup-page-objects state page-id)
            style   (lookup-style state kind file-id style-id)
            ids     (targets kind objects ids)]
        (if (and (some? style) (seq ids))
          (-> (pcb/empty-changes it page-id)
              (apply-values-changes page-id objects kind
                                    (zipmap ids (repeat (:value style)))
                                    {:ref (zfx/style-ref file-id style-id)})
              (commit))
          (rx/empty))))))

(defn apply-style-to-selection
  [kind file-id style-id]
  (ptk/reify ::apply-style-to-selection
    ptk/WatchEvent
    (watch [_ state _]
      (let [ids (dsh/get-selected-ids state)]
        (if (seq ids)
          (rx/of (apply-style kind ids file-id style-id))
          (rx/empty))))))

(defn detach-style
  "The layers `ids` keep their values and lose their style of `kind`."
  [kind ids]
  (ptk/reify ::detach-style
    ptk/WatchEvent
    (watch [it state _]
      (let [page-id (:current-page-id state)
            objects (dsh/lookup-page-objects state page-id)
            key     (zfx/style-ref-key kind)]
        (-> (reduce (fn [changes id]
                      (if-let [shape (get objects id)]
                        (zvena-data-changes changes page-id shape {key nil})
                        changes))
                    (pcb/empty-changes it page-id)
                    ids)
            (commit))))))

;; --- Local styles

(defn create-style
  "Creates a local style of `kind` named `name` with the values of the
  first layer of `ids` (Figma's defaults with no layer) and applies it to
  the layers `ids`."
  ([kind name ids]
   (create-style kind name ids nil))
  ([kind name ids on-created]
   (ptk/reify ::create-style
     ptk/WatchEvent
     (watch [it state _]
       (let [file-id (:current-file-id state)
             page-id (:current-page-id state)
             data    (dsh/lookup-file-data state file-id)
             objects (dsh/lookup-page-objects state page-id)
             ids     (targets kind objects ids)
             source  (some #(get objects %) ids)
             value   (if (some? source)
                       (zfx/shape-style-value source kind)
                       (default-value kind))
             name    (let [name (str/trim (str name))]
                       (if (str/blank? name)
                         (case kind :effect "Effect" :grid "Grid")
                         name))
             style   {:id (uuid/next) :name name :description "" :value value}]
         (when (fn? on-created)
           (on-created (:id style)))
         (-> (pcb/empty-changes it page-id)
             (file-style-change data kind (:id style) style)
             (apply-values-changes page-id objects kind
                                   (zipmap ids (repeat value))
                                   {:ref (zfx/style-ref file-id (:id style))})
             (commit)))))))

(defn- update-local-style
  [kind style-id f propagate?]
  (ptk/reify ::update-local-style
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id (:current-file-id state)
            data    (dsh/lookup-file-data state file-id)
            style   (zfx/get-style data kind style-id)]
        (if (some? style)
          (let [style' (-> (f style)
                           (update :value #(zfx/check-style-value kind %)))
                ref    (zfx/style-ref file-id style-id)]
            (-> (pcb/empty-changes it)
                (file-style-change data kind style-id style')
                (cond-> (and propagate?
                             (not (zfx/same-style-value? kind (:value style) (:value style'))))
                  (propagate-changes data kind ref (:value style')))
                (commit)))
          (rx/empty))))))

(defn rename-style
  [kind style-id name]
  (let [name (str/trim (str name))]
    (update-local-style kind style-id
                        #(if (str/blank? name) % (assoc % :name name))
                        false)))

(defn set-style-description
  [kind style-id description]
  (update-local-style kind style-id #(assoc % :description (str description)) false))

(defn update-style-value
  "Gives the local style the value `(f value)` and every layer of the file
  that uses it the new value."
  [kind style-id f]
  (update-local-style kind style-id #(update % :value f) true))

(defn delete-style
  "Deletes a local style; its layers keep their values (Figma)."
  [kind style-id]
  (ptk/reify ::delete-style
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id (:current-file-id state)
            data    (dsh/lookup-file-data state file-id)]
        (-> (pcb/empty-changes it)
            (file-style-change data kind style-id nil)
            (detach-all-changes data kind (zfx/style-ref file-id style-id))
            (commit))))))

(defn duplicate-style
  [kind style-id]
  (ptk/reify ::duplicate-style
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id (:current-file-id state)
            data    (dsh/lookup-file-data state file-id)
            style   (zfx/get-style data kind style-id)]
        (if (some? style)
          (let [id (uuid/next)]
            (-> (pcb/empty-changes it)
                (file-style-change data kind id (assoc style :id id :name (str (:name style) " copy")))
                (commit)))
          (rx/empty))))))

;; --- Libraries

(defn- outdated-shape?
  [shape kind library-id ldata]
  (let [[file-id style-id] (zfx/shape-style-ref shape kind)]
    (when (= file-id library-id)
      (let [style (zfx/get-style ldata kind style-id)]
        (and (some? style)
             (not (zfx/same-style-value? kind (:value style) (zfx/shape-style-value shape kind))))))))

(defn library-styles-outdated?
  "True when layers of `file-data` use styles of `library` (a file of
  the state, with :data) whose values changed since the last sync."
  [file-data library ignore-until]
  (let [ldata      (:data library)
        library-id (:id library)]
    (boolean
     (and (some? ldata)
          (some? library-id)
          (not= library-id (:id file-data))
          (let [sync-date (max (:synced-at library) (or ignore-until 0))]
            (> (:modified-at library) sync-date))
          (or (seq (zfx/get-styles ldata :effect))
              (seq (zfx/get-styles ldata :grid)))
          (some (fn [page]
                  (some (fn [shape]
                          (and (some? (:plugin-data shape))
                               (some #(outdated-shape? shape % library-id ldata) kinds)))
                        (vals (:objects page))))
                (vals (:pages-index file-data)))))))

(defn outdated-styles
  "The styles of `library` (a file of the state, with :data) that layers
  of `file-data` use with other values than the library has now."
  [file-data library]
  (let [ldata      (:data library)
        library-id (:id library)]
    (when (and (some? ldata)
               (some? library-id)
               (not= library-id (:id file-data))
               (or (seq (zfx/get-styles ldata :effect))
                   (seq (zfx/get-styles ldata :grid))))
      (->> (for [page  (vals (:pages-index file-data))
                 shape (vals (:objects page))
                 :when (some? (:plugin-data shape))
                 kind  kinds
                 :when (outdated-shape? shape kind library-id ldata)]
             [kind (second (zfx/shape-style-ref shape kind))])
           (distinct)
           (keep (fn [[kind style-id]] (zfx/get-style ldata kind style-id)))
           (sort-by (comp str/lower :name))
           (into [])))))

(defn sync-library-styles
  "The layers of the file `file-id` that use styles of `library-id` take
  their current values (part of the library Update)."
  [file-id library-id]
  (ptk/reify ::sync-library-styles
    ptk/WatchEvent
    (watch [it state _]
      (let [data  (dsh/lookup-file-data state file-id)
            ldata (dsh/lookup-file-data state library-id)]
        (if (or (= file-id library-id)
                (not= file-id (:current-file-id state))
                (nil? data)
                (nil? ldata))
          (rx/empty)
          (->> kinds
               (reduce
                (fn [changes kind]
                  (reduce
                   (fn [changes page]
                     (let [page-id (:id page)
                           objects (:objects page)
                           values  (into {}
                                         (keep (fn [shape]
                                                 (when (and (some? (:plugin-data shape))
                                                            (outdated-shape? shape kind library-id ldata))
                                                   (let [[_ style-id] (zfx/shape-style-ref shape kind)]
                                                     [(:id shape) (:value (zfx/get-style ldata kind style-id))]))))
                                         (vals objects))]
                       (if (seq values)
                         (apply-values-changes changes page-id objects kind values
                                               {:ref ::keep :ignore-touched true})
                         changes)))
                   changes
                   (vals (:pages-index data))))
                (pcb/empty-changes it))
               (commit)))))))

;; --- Style editor (a floating panel, see app.main.ui.workspace.zvena.style-editor)

(defn open-style-editor
  "Opens the editor of the local style `style-id` of `kind` at `position`
  ({:x :y}, viewport coordinates)."
  [kind style-id position]
  (ptk/reify ::open-style-editor
    ptk/UpdateEvent
    (update [_ state]
      (assoc state :zvena-style-editor {:kind kind
                                        :style-id style-id
                                        :x (:x position)
                                        :y (:y position)}))))

(defn close-style-editor
  []
  (ptk/reify ::close-style-editor
    ptk/UpdateEvent
    (update [_ state]
      (dissoc state :zvena-style-editor))))

(defn style-name
  "Name of the style a layer refers to, from the files of the state."
  [files [file-id style-id] kind]
  (:name (zfx/get-style (dm/get-in files [file-id :data]) kind style-id)))

(defn same-ref
  "The reference of `kind` all the `shapes` share, or :multiple / nil."
  [shapes kind]
  (let [refs (into #{} (map #(zfx/shape-style-ref % kind)) shapes)]
    (cond
      (= 1 (count refs)) (first refs)
      (empty? refs)      nil
      :else              :multiple)))
