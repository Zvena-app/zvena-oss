;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-component-props
  "zvena: Figma-like component properties — Boolean, Text and Instance
  swap — on top of Penpot components (variant properties stay as they are).

  Everything is stored as shape plugin-data under the `:zvena` namespace,
  which is persisted, versioned, undoable and needs no schema change:

  - Definitions live on the *owner* shape: the main instance root of a
    plain component, or the variant container of a variant set (so all the
    variants share them, as in Figma). Key \"props\", a JSON array of
    `{id, name, type, default}` with type \"boolean\", \"text\" or \"swap\"
    (the default of a swap property is `{componentId, fileId}`).
    A variant set without definitions of its own inherits the ones of its
    first variant that has some (a component turned into a variant set).

  - Bindings live on the bound layers inside the main, one key per kind,
    so a layer can drive several properties (e.g. visibility and text):
    \"prop-boolean\" (layer visibility), \"prop-text\" (text content) and
    \"prop-swap\" (the component a nested instance shows). The value is the
    property id. Only the own layers of a component can be bound: the
    insides of nested instances are skipped (their heads can be bound).

  - Values on a copy are not stored apart: they are read from the copy's own
    layers that correspond to the bound layers of the main (same `:shape-ref`,
    or the same swap slot for swapped nested instances) and written as plain
    edits: `:hidden`, text `:content` and a component swap. On a copy these
    are ordinary overrides — the `:visibility-group` / `:content-group`
    touched groups and the swap slot — so library syncs keep them, and
    Penpot's \"Reset overrides\" resets them.

  - Instance swap properties can list *preferred* components (Figma's
    preferred values): `preferred`, an array of `{componentId, fileId}`
    in the definition. The copies offer them first.

  - A nested instance of a main can be *exposed* (Figma's \"Expose
    properties from nested instances\"): key \"expose\" \"true\" on the
    nested instance head of the main. The copies of the main then show the
    properties of that nested instance (its own Boolean, Text and Instance
    swap properties, its variant properties and, recursively, its exposed
    nested instances) with their own, edited as overrides of the nested
    copy."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.json :as json]
   [app.common.types.component :as ctk]
   [app.common.types.components-list :as ctkl]
   [app.common.types.file :as ctf]
   [app.common.types.text :as txt]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.notifications :as ntf]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.data.workspace.undo :as dwu]
   [app.main.data.workspace.variants :as dwv]
   [app.main.data.workspace.wasm-text :as dwwt]
   [app.main.features :as features]
   [app.main.store :as st]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

;; --- Model

(def ^:private pd-ns
  "plugin-data namespace of all the zvena component property data."
  :zvena)

(def ^:private defs-key "props")

(def kinds
  "Property kinds, in the order the UI offers them."
  [:boolean :text :swap])

;; NOTE: app.main.data.workspace.libraries/component-swap keeps these keys
;; on the swapped shape; keep both lists in sync.
(def ^:private binding-keys
  {:boolean "prop-boolean"
   :text    "prop-text"
   :swap    "prop-swap"})

(def max-name-length 60)

;; zvena: Figma's "Expose properties from nested instances". NOTE: also
;; kept by app.main.data.workspace.libraries/component-swap.
(def ^:private expose-key "expose")

(def ^:private max-expose-depth
  "How deep exposed nested instances are followed (an exposed instance can
  expose its own nested instances)."
  4)

(defn- parse-kind
  [v]
  (let [k (cond
            (keyword? v) v
            (string? v)  (keyword v)
            :else        nil)]
    (when (contains? binding-keys k) k)))

(defn parse-swap-value
  "A `{:component-id :file-id}` map with uuids, from uuids or strings; or nil."
  [v]
  (when (map? v)
    (let [component-id (some-> (:component-id v) str uuid/parse*)
          file-id      (some-> (:file-id v) str uuid/parse*)]
      (when (and component-id file-id)
        {:component-id component-id :file-id file-id}))))

(defn- parse-preferred
  "The preferred values of an instance swap property, a vector of
  `{:component-id :file-id}` without repetitions."
  [v]
  (if (sequential? v)
    (into [] (comp (keep parse-swap-value) (distinct)) v)
    []))

(defn- normalize-def
  [{:keys [id name type default preferred]}]
  (when-let [kind (parse-kind type)]
    (when (and (string? id) (not (str/blank? id)) (string? name))
      (cond-> {:id      id
               :name    name
               :type    kind
               :default (case kind
                          :boolean (if (boolean? default) default true)
                          :text    (if (string? default) default "")
                          :swap    (parse-swap-value default))}
        (= kind :swap)
        (assoc :preferred (parse-preferred preferred))))))

(defn- has-defs?
  [shape]
  (string? (dm/get-in shape [:plugin-data pd-ns defs-key])))

(defn read-defs
  "The property definitions stored on `shape`, as a vector (maybe empty)."
  [shape]
  (let [raw (dm/get-in shape [:plugin-data pd-ns defs-key])]
    (or (when (string? raw)
          (try
            (let [data (json/decode raw)]
              (when (sequential? data)
                (into [] (keep normalize-def) data)))
            (catch :default _ nil)))
        [])))

(defn- encode-defs
  [defs]
  ;; Always an array, even empty: an emptied variant set must not fall back
  ;; to the definitions of its first variant.
  (json/encode (mapv (fn [prop]
                       (cond-> (select-keys prop [:id :name :type :default])
                         (seq (:preferred prop))
                         (assoc :preferred (:preferred prop))))
                     defs)))

(defn owner-defs
  "Definitions for the owner shape (see the ns doc for the variant set
  fallback)."
  [objects owner]
  (if (and (ctk/is-variant-container? owner)
           (not (has-defs? owner)))
    (or (some->> (:shapes owner)
                 (map (d/getf objects))
                 (d/seek has-defs?)
                 (read-defs))
        [])
    (read-defs owner)))

(defn find-prop
  [defs prop-id]
  (d/seek #(= prop-id (:id %)) defs))

(defn defs-owner-id
  "Id of the shape that holds the definitions of the main root `shape`
  (the variant container for a variant); a variant container is its own
  owner."
  [shape]
  (or (:variant-id shape) (:id shape)))

(defn get-binding
  "Id of the property of kind `kind` bound to the layer, or nil."
  [shape kind]
  (dm/get-in shape [:plugin-data pd-ns (get binding-keys kind)]))

(defn exposed?
  "Is the nested instance (of a main) exposed to the copies of the main?"
  [shape]
  (= "true" (dm/get-in shape [:plugin-data pd-ns expose-key])))

(defn eligible?
  "Can the layer be bound to a property of kind `kind`?"
  [kind shape]
  (case kind
    :boolean (some? shape)
    :text    (cfh/text-shape? shape)
    :swap    (ctk/instance-head? shape)
    false))

(defn own-layers
  "Layers of the component rooted at `root-id` (the root excluded), not
  descending into nested instances (their heads are included)."
  [objects root-id]
  (letfn [(walk [acc id]
            (if-let [shape (get objects id)]
              (let [acc (conj acc shape)]
                (if (ctk/instance-head? shape)
                  acc
                  (reduce walk acc (:shapes shape))))
              acc))]
    (reduce walk [] (dm/get-in objects [root-id :shapes]))))

(defn- owner-main-roots
  [objects owner]
  (if (ctk/is-variant-container? owner)
    (into [] (comp (keep (d/getf objects)) (filter ctk/main-instance?)) (:shapes owner))
    [owner]))

(defn owner-layers
  "Own layers of all the mains that share the definitions of `owner`."
  [objects owner]
  (into [] (mapcat #(own-layers objects (:id %))) (owner-main-roots objects owner)))

(defn bound-layers
  [layers {:keys [id type]}]
  (filterv #(= id (get-binding % type)) layers))

(defn find-main-root
  "The main instance root that contains the shape (or is it), or nil."
  [objects shape-id]
  (d/seek ctk/main-instance? (cfh/get-parents-with-self objects shape-id)))

(defn binding-context
  "For a layer of a main that can be bound to the main's properties, a map
  with the `:owner` shape and its `:defs`. Nil for the main root itself,
  for shapes outside mains and for shapes inside nested instances."
  [objects shape-id]
  (when-let [root (find-main-root objects shape-id)]
    (when (and (not= (:id root) shape-id)
               (not (->> (cfh/get-parents objects shape-id)
                         (take-while #(not= (:id root) (:id %)))
                         (some ctk/instance-head?))))
      (when-let [owner (get objects (defs-owner-id root))]
        {:owner owner
         :defs  (owner-defs objects owner)}))))

(defn layer-value
  "The value a property of kind `kind` shows on `layer`."
  [kind layer]
  (case kind
    :boolean (not (:hidden layer))
    :text    (when (cfh/text-shape? layer)
               (txt/content->text (:content layer)))
    :swap    (when (ctk/instance-head? layer)
               {:component-id (:component-id layer)
                :file-id      (:component-file layer)})
    nil))

(defn current-value
  "Value of the property as shown by its first bound layer, or its default."
  [{:keys [type default]} layers]
  (if-let [layer (d/seek #(eligible? type %) layers)]
    (layer-value type layer)
    default))

(defn- copy-layer-refs
  "Ids of the main shapes a layer of a copy stands for: its chain of
  references, from the nearest main to the remotest (a copy nested in a copy
  references the intermediate main first), plus, for a nested instance, its
  swap slot (the nested instance of the main it replaces when swapped)."
  [container files shape]
  (loop [current   shape
         container container
         file      nil
         ids       (if-let [slot (when (ctk/instance-head? shape)
                                   (ctf/find-swap-slot shape container nil files))]
                     #{slot}
                     #{})
         depth     0]
    (let [ref (when (and (some? (:shape-ref current)) (< depth 16))
                (ctf/find-ref-shape file container files current
                                    :include-deleted? true
                                    :with-context? true))]
      (if (nil? ref)
        ids
        (let [{ref-file :file ref-container :container} (meta ref)]
          (recur ref ref-container ref-file (conj ids (:id ref)) (inc depth)))))))

(defn copy-context
  "The definitions of the component of the copy head `shape`, each one with
  the copy layers it drives: `[{:prop .. :layers [..]} ..]`. `files` maps
  file ids to loaded files (the current one and its libraries); `objects`
  are the objects of the copy's page."
  [files objects shape]
  (let [fdata     (dm/get-in files [(:component-file shape) :data])
        component (when fdata (ctkl/get-component fdata (:component-id shape)))]
    (when (some? component)
      (let [mobjects (dm/get-in fdata [:pages-index (:main-instance-page component) :objects])
            owner    (get mobjects (or (:variant-id component) (:main-instance-id component)))
            defs     (when owner (owner-defs mobjects owner))]
        (when (seq defs)
          (let [main-layers (own-layers mobjects (:main-instance-id component))
                container   {:type :page :objects objects}
                copy-layers (mapv (fn [layer] [layer (copy-layer-refs container files layer)])
                                  (own-layers objects (:id shape)))]
            (mapv (fn [prop]
                    (let [ids (into #{} (map :id) (bound-layers main-layers prop))]
                      {:prop   prop
                       :layers (if (empty? ids)
                                 []
                                 (into []
                                       (comp (filter (fn [[_ refs]] (some ids refs)))
                                             (map first))
                                       copy-layers))}))
                  defs)))))))

(defn exposed-context
  "The exposed nested instances of the copy head `shape` (see the ns doc),
  in layer order, each one followed by its own exposed nested instances:
  `[{:shape nested-copy-head :entries (copy-context ..) :depth n} ..]`."
  ([files objects shape]
   (exposed-context files objects shape 0))
  ([files objects shape depth]
   (let [fdata     (dm/get-in files [(:component-file shape) :data])
         component (when fdata (ctkl/get-component fdata (:component-id shape)))]
     (when (and (some? component) (< depth max-expose-depth))
       (let [mobjects    (dm/get-in fdata [:pages-index (:main-instance-page component) :objects])
             exposed-ids (into #{}
                               (comp (filter ctk/instance-head?)
                                     (filter exposed?)
                                     (map :id))
                               (own-layers mobjects (:main-instance-id component)))]
         (when (seq exposed-ids)
           (let [container {:type :page :objects objects}]
             (into []
                   (comp (filter ctk/instance-head?)
                         (filter #(some exposed-ids (copy-layer-refs container files %)))
                         (mapcat (fn [nested]
                                   (into [{:shape   nested
                                           :depth   depth
                                           :entries (or (copy-context files objects nested) [])}]
                                         (exposed-context files objects nested (inc depth))))))
                   (own-layers objects (:id shape))))))))))

(defn- normalize-value
  [kind value]
  (case kind
    :boolean (boolean value)
    ;; An empty text would leave an empty text layer, Penpot removes those
    :text    (when (and (string? value) (not (str/blank? value))) value)
    :swap    (parse-swap-value value)
    nil))

(defn- default-for
  [kind]
  (case kind
    :boolean true
    :text    (tr "labels.text")
    nil))

(defn- unique-name
  [defs base numbered?]
  (let [used (into #{} (map :name) defs)
        base (str/trim (d/nilv base ""))
        base (if (str/blank? base) (tr "zvena.props.property") base)]
    (if (and (not numbered?) (not (contains? used base)))
      base
      (d/seek #(not (contains? used %))
              (map #(str base " " %) (range 1 10000))))))

;; --- Events helpers

(defn set-zvena-data
  "Writes zvena plugin-data entries `[[shape-id key value] ..]` on shapes of
  the current page, in a single commit (a nil value removes the key). Same
  change type the plugin API uses for setPluginData."
  [entries]
  (ptk/reify ::set-zvena-data
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id   (:current-file-id state)
            page-id   (:current-page-id state)
            file-data (dsh/lookup-file-data state file-id)
            changes   (reduce (fn [changes [id key value]]
                                (pcb/set-plugin-data changes :shape id page-id pd-ns key value))
                              (-> (pcb/empty-changes it)
                                  (pcb/with-file-data file-data)
                                  (assoc :file-id file-id))
                              entries)]
        (when (seq (:redo-changes changes))
          (rx/of (dch/commit-changes changes)))))))

(defn- lookup-owner
  "[objects owner defs] of the owner shape in the current page."
  [state owner-id]
  (let [objects (dsh/lookup-page-objects state)
        owner   (get objects owner-id)]
    [objects owner (if owner (owner-defs objects owner) [])]))

(defn- reselect-event
  "Restores the current selection (a swap selects the swapped shape)."
  [state]
  (let [selected (dsh/get-selected-ids state)]
    (if (seq selected)
      (dws/select-shapes (into (d/ordered-set) selected))
      (dws/deselect-all))))

(defn- swap-layer
  "Swaps the nested instance `layer-id` of the current page to the given
  component, reusing Penpot's swap (which keeps the shape id and records the
  swap slot, so a swap in a copy survives syncs)."
  [layer-id {:keys [component-id file-id]}]
  (ptk/reify ::swap-layer
    ptk/WatchEvent
    (watch [_ state _]
      (let [objects   (dsh/lookup-page-objects state)
            shape     (get objects layer-id)
            fdata     (dsh/lookup-file-data state file-id)
            component (when fdata (ctkl/get-component fdata component-id))]
        (when (and (ctk/instance-head? shape)
                   (some? component)
                   (not (and (= component-id (:component-id shape))
                             (= file-id (:component-file shape)))))
          (let [children (ctf/get-component-shapes fdata component)
                parents  (cfh/get-parents-with-self objects (:parent-id shape))]
            (if (cfh/components-nesting-loop? children parents)
              (rx/of (ntf/warn (tr "workspace.component.swap.loop-error")))
              (rx/of (dwl/component-swap shape file-id component-id false)))))))))

(defn- apply-value
  "Events that make `layers` (shapes of the current page) show `value` for a
  property of kind `kind`. Plain edits: on a copy they become overrides."
  [state kind layers value]
  (case kind
    :boolean
    (let [hidden (not value)
          ids    (into []
                       (comp (remove #(= hidden (boolean (:hidden %))))
                             (map :id))
                       layers)]
      (when (seq ids)
        [(dwsh/update-shape-flags ids {:hidden hidden})]))

    :text
    (let [ids (into []
                    (comp (filter cfh/text-shape?)
                          (remove #(= value (txt/content->text (:content %))))
                          (map :id))
                    layers)]
      (when (and (string? value) (seq ids))
        ;; Same path as the plugin API `characters` setter: keeps the style of
        ;; the first paragraph and text span.
        (into [(dwsh/update-shapes ids #(update % :content txt/change-text value))]
              (when (features/active-feature? state "render-wasm/v1")
                (map dwwt/resize-wasm-text-debounce ids)))))

    :swap
    (when (some? value)
      (into []
            (comp (filter ctk/instance-head?)
                  (map #(swap-layer (:id %) value)))
            layers))

    nil))

;; --- Events: definitions (on a main / variant set, current page)

(defn add-prop
  "Adds a property of kind `kind` to the owner. With `:layer-id`, the layer
  is bound to it and gives the default value (Figma's \"Create property\"
  from a layer). `:prop-id` lets the caller know the new id."
  ([owner-id kind]
   (add-prop owner-id kind nil))
  ([owner-id kind {:keys [layer-id prop-id]}]
   (ptk/reify ::add-prop
     ptk/WatchEvent
     (watch [_ state _]
       (let [[objects owner defs] (lookup-owner state owner-id)
             layer (when layer-id (get objects layer-id))
             layer (when (and layer (eligible? kind layer)) layer)]
         (when (and (some? owner) (contains? binding-keys kind))
           (let [base (cond
                        (nil? layer)      nil
                        (= kind :boolean) (tr "zvena.props.show-layer" (:name layer))
                        :else             (:name layer))
                 prop {:id      (or prop-id (str (uuid/next)))
                       :name    (unique-name defs base (nil? layer))
                       :type    kind
                       :default (if layer
                                  (layer-value kind layer)
                                  (default-for kind))}]
             (rx/of (set-zvena-data
                     (cond-> [[owner-id defs-key (encode-defs (conj defs prop))]]
                       (some? layer)
                       (conj [layer-id (get binding-keys kind) (:id prop)])))))))))))

(defn rename-prop
  [owner-id prop-id name]
  (ptk/reify ::rename-prop
    ptk/WatchEvent
    (watch [_ state _]
      (let [[_ owner defs] (lookup-owner state owner-id)
            name (str/trim (d/nilv name ""))
            prop (find-prop defs prop-id)]
        (when (and (some? owner)
                   (some? prop)
                   (not (str/blank? name))
                   (not= name (:name prop)))
          (if (some #(and (= name (:name %)) (not= prop-id (:id %))) defs)
            (rx/of (ntf/warn (tr "zvena.props.duplicated-name")))
            (let [defs (mapv #(cond-> % (= prop-id (:id %)) (assoc :name name)) defs)]
              (rx/of (set-zvena-data [[owner-id defs-key (encode-defs defs)]])))))))))

(defn delete-prop
  "Deletes the property and unbinds its layers. Values already set on copies
  stay as plain overrides."
  [owner-id prop-id]
  (ptk/reify ::delete-prop
    ptk/WatchEvent
    (watch [_ state _]
      (let [[objects owner defs] (lookup-owner state owner-id)
            prop (find-prop defs prop-id)]
        (when (and (some? owner) (some? prop))
          (let [bound (bound-layers (owner-layers objects owner) prop)]
            (rx/of (set-zvena-data
                    (into [[owner-id defs-key (encode-defs (filterv #(not= prop-id (:id %)) defs))]]
                          (map (fn [layer] [(:id layer) (get binding-keys (:type prop)) nil]))
                          bound)))))))))

(defn set-prop-default
  "Changes the default value of the property and applies it to its bound
  layers in the main(s), from where Penpot propagates it to the copies that
  do not override it."
  [owner-id prop-id value]
  (ptk/reify ::set-prop-default
    ptk/WatchEvent
    (watch [_ state _]
      (let [[objects owner defs] (lookup-owner state owner-id)
            prop (find-prop defs prop-id)
            kind (:type prop)
            value (normalize-value kind value)]
        (when (and (some? owner) (some? prop) (some? value))
          (let [new-defs (mapv #(cond-> % (= prop-id (:id %)) (assoc :default value)) defs)
                layers   (bound-layers (owner-layers objects owner) prop)
                undo-id  (js/Symbol)]
            (rx/from
             (-> [(dwu/start-undo-transaction undo-id)]
                 (cond-> (not= defs new-defs)
                   (conj (set-zvena-data [[owner-id defs-key (encode-defs new-defs)]])))
                 (into (apply-value state kind layers value))
                 (conj (dwu/commit-undo-transaction undo-id))
                 (cond-> (= kind :swap)
                   (conj (reselect-event state)))))))))))

(defn bind-layer
  "Binds the `kind` attribute of a layer of a main to the property `prop-id`
  of the owner, or unbinds it when `prop-id` is nil. Binding applies the
  property default to the layer, like Figma's \"Apply property\"; an
  instance swap property without default takes the layer's component."
  [owner-id layer-id kind prop-id]
  (ptk/reify ::bind-layer
    ptk/WatchEvent
    (watch [_ state _]
      (let [[objects owner defs] (lookup-owner state owner-id)
            layer (get objects layer-id)
            prop  (when (some? prop-id) (find-prop defs prop-id))]
        (when (and (some? owner)
                   (contains? binding-keys kind)
                   (eligible? kind layer))
          (cond
            (nil? prop-id)
            (when (some? (get-binding layer kind))
              (rx/of (set-zvena-data [[layer-id (get binding-keys kind) nil]])))

            (and (some? prop) (= kind (:type prop)))
            (let [take-default? (and (= kind :swap) (nil? (:default prop)))
                  new-defs      (when take-default?
                                  (mapv #(cond-> %
                                           (= prop-id (:id %))
                                           (assoc :default (layer-value :swap layer)))
                                        defs))
                  undo-id       (js/Symbol)]
              (rx/from
               (-> [(dwu/start-undo-transaction undo-id)
                    (set-zvena-data
                     (cond-> [[layer-id (get binding-keys kind) prop-id]]
                       take-default?
                       (conj [owner-id defs-key (encode-defs new-defs)])))]
                   ;; The swap reads the shape when it runs, after the binding
                   ;; above is committed, and component-swap keeps it.
                   (into (when-not take-default?
                           (apply-value state kind [layer] (:default prop))))
                   (conj (dwu/commit-undo-transaction undo-id))
                   (cond-> (and (= kind :swap) (not take-default?))
                     (conj (reselect-event state))))))

            :else
            nil))))))

(defn- update-prop-def
  "Event that replaces the definition `prop-id` of the owner by (f prop),
  when it is an instance swap property."
  [owner-id prop-id f]
  (ptk/reify ::update-prop-def
    ptk/WatchEvent
    (watch [_ state _]
      (let [[_ owner defs] (lookup-owner state owner-id)
            prop (find-prop defs prop-id)]
        (when (and (some? owner) (= :swap (:type prop)))
          (let [new-defs (mapv #(cond-> % (= prop-id (:id %)) (f)) defs)]
            (when (not= defs new-defs)
              (rx/of (set-zvena-data [[owner-id defs-key (encode-defs new-defs)]])))))))))

(defn add-preferred
  "Adds a component (`{:component-id :file-id}`) to the preferred values of
  an instance swap property."
  [owner-id prop-id value]
  (let [value (parse-swap-value value)]
    (update-prop-def owner-id prop-id
                     (fn [prop]
                       (cond-> prop
                         (and (some? value)
                              (not (some #(= value %) (:preferred prop))))
                         (update :preferred (fnil conj []) value))))))

(defn remove-preferred
  [owner-id prop-id value]
  (let [value (parse-swap-value value)]
    (update-prop-def owner-id prop-id
                     (fn [prop]
                       (update prop :preferred #(filterv (partial not= value) %))))))

(defn nested-instances
  "The nested instances (heads) among the own layers of the mains that
  share the definitions of `owner`."
  [objects owner]
  (filterv ctk/instance-head? (owner-layers objects owner)))

(defn set-exposed
  "Exposes (or not) the properties of the nested instance `layer-id` of the
  owner's main(s) to the copies."
  [owner-id layer-id exposed]
  (ptk/reify ::set-exposed
    ptk/WatchEvent
    (watch [_ state _]
      (let [[objects owner _] (lookup-owner state owner-id)
            layer (get objects layer-id)]
        (when (and (some? owner)
                   (ctk/instance-head? layer)
                   (not= (boolean exposed) (exposed? layer))
                   (some #(= layer-id (:id %)) (owner-layers objects owner)))
          (rx/of (set-zvena-data [[layer-id expose-key (when exposed "true")]])))))))

;; --- Events: values (on a copy, current page)

(defn set-copy-value
  "Sets the value of a property on the copy head `copy-id`: edits the copy
  layers bound to it, which become regular overrides of the copy.
  `select-id` is the shape selected afterwards (`copy-id` by default; the
  parent copy when it is an exposed nested instance)."
  ([copy-id prop-id value]
   (set-copy-value copy-id prop-id value nil))
  ([copy-id prop-id value select-id]
   (ptk/reify ::set-copy-value
     ptk/WatchEvent
     (watch [_ state _]
       (let [objects (dsh/lookup-page-objects state)
             shape   (get objects copy-id)
             entry   (when (ctk/instance-head? shape)
                       (d/seek #(= prop-id (dm/get-in % [:prop :id]))
                               (copy-context (dsh/lookup-libraries state) objects shape)))
             kind    (dm/get-in entry [:prop :type])
             value   (when entry (normalize-value kind value))
             events  (when (some? value)
                       (apply-value state kind (:layers entry) value))]
         (when (seq events)
           (let [undo-id (js/Symbol)]
             (rx/from
              (-> [(dwu/start-undo-transaction undo-id)]
                  (into events)
                  (conj (dwu/commit-undo-transaction undo-id))
                  (cond-> (= kind :swap)
                    (conj (dws/select-shapes (d/ordered-set (or select-id copy-id))))))))))))))

(defn switch-nested-variant
  "Switches the variant of the nested copy `nested-id` (an exposed nested
  instance), keeping the parent copy `copy-id` selected."
  [copy-id nested-id pos value]
  (ptk/reify ::switch-nested-variant
    ptk/WatchEvent
    (watch [_ state _]
      (let [nested (get (dsh/lookup-page-objects state) nested-id)]
        (when (ctk/instance-head? nested)
          (rx/of (dwv/variants-switch
                  (with-meta {:shapes [nested] :pos pos :val value}
                    {:on-error #(st/emit! (ntf/warn (tr "workspace.component.swap.loop-error")))}))
                 (dws/select-shapes (d/ordered-set copy-id))))))))
