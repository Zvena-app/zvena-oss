;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.branches
  "zvena: Figma's branching and merging.

  \"Create branch…\" copies a file (the main file) into a new file of the
  same project named \"<main> / <branch>\" and takes a snapshot of main:
  the merge base. Branch files are hidden from the project grid; they are
  reached through the main file (\"View branches\").

  \"Review and merge\" compares three versions of the file: the merge
  base, main now and the branch now. Items are pages, the layers placed
  directly on a page (with everything inside them), page settings,
  components, colors, typographies and the other file-level data (design
  tokens...). An item changed only on the branch is taken from the
  branch, one changed only on main stays as main has it, and one changed
  on both sides in different ways is a conflict: the person merging picks
  the version to keep. Main gets a version (\"Before merging <branch>\")
  first, so a merge can always be undone from the version history.

  Merged data is written the way a snapshot restore writes it (new
  revn and vern, `:file-restored` message): editors that have main open
  reload it, and a client with unsaved changes made before the merge
  gets a vern conflict and reloads too, as after a restore.

  Duplication keeps shape, page, component, color and typography ids;
  it only gives the branch its own file id and its own copies of the
  images (`media_map`). Branch data is translated back to main's ids
  before comparing, so unchanged layers compare equal.

  \"Update from main\" is the same 3-way merge written into the branch;
  the base then becomes main's current state."
  (:require
   [app.binfile.common :as bfc]
   [app.common.data :as d]
   [app.common.exceptions :as ex]
   [app.common.files.changes :as cfc]
   [app.common.files.helpers :as cfh]
   [app.common.files.migrations :as fmg]
   [app.common.files.repair :as cfr]
   [app.common.files.validate :as cfv]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.features.fdata :as fdata]
   [app.features.file-snapshots :as fsnap]
   [app.features.logical-deletion :as ldel]
   [app.loggers.audit :as-alias audit]
   [app.msgbus :as mbus]
   [app.redis :as rds]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.files :as files]
   [app.rpc.commands.management :as mgmt]
   [app.rpc.commands.teams :as teams]
   [app.rpc.doc :as-alias doc]
   [app.rpc.helpers :as rph]
   [app.storage :as sto]
   [app.util.services :as sv]
   [clojure.datafy :refer [datafy]]
   [cuerdas.core :as str]))

(def name-max-length 200)

;; Change lists longer than this are cut (the counts stay exact);
;; conflicts are never cut, every one of them needs a choice.
(def ^:private max-listed 1000)

;; The merge base must outlive the branch: it gets a deletion date this
;; far away, and the team's usual delay once the branch is merged or
;; archived.
(def ^:private base-retention {:days 36500})

;; File level data keys that are not compared as a whole: they are
;; compared item by item (pages, assets) or never merged.
(def ^:private handled-data-keys
  #{:id :version :libs :recent-colors
    :pages :pages-index :components :colors :typographies :media})

;; --- Rows

(def ^:private sql:branch-columns
  "SELECT fb.id,
          fb.main_file_id,
          fb.branch_file_id,
          fb.name,
          fb.status,
          fb.created_by,
          fb.created_at,
          fb.modified_at,
          fb.base_revn,
          fb.merged_at,
          fb.merged_by,
          fb.archived_at,
          fb.archived_by,
          pc.fullname AS created_by_name,
          pm.fullname AS merged_by_name,
          bf.name AS file_name,
          bf.revn AS file_revn,
          bf.modified_at AS file_modified_at,
          bf.deleted_at AS file_deleted_at
     FROM file_branch AS fb
     LEFT JOIN profile AS pc ON (pc.id = fb.created_by)
     LEFT JOIN profile AS pm ON (pm.id = fb.merged_by)
     LEFT JOIN file AS bf ON (bf.id = fb.branch_file_id)")

(def ^:private sql:get-branches
  (str sql:branch-columns
       " WHERE fb.main_file_id = ?
         ORDER BY fb.created_at DESC"))

(def ^:private sql:get-branch-by-file
  (str sql:branch-columns
       " WHERE fb.branch_file_id = ?"))

(def ^:private sql:get-row
  "SELECT * FROM file_branch WHERE id = ?")

(def ^:private sql:get-row-for-update
  "SELECT * FROM file_branch WHERE id = ? FOR UPDATE")

(def ^:private sql:get-file-summary
  "SELECT f.id, f.name, f.revn, f.project_id, f.modified_at
     FROM file AS f
    WHERE f.id = ?")

(def ^:private sql:snapshot-exists
  "SELECT c.id
     FROM file_change AS c
    WHERE c.id = ?
      AND c.file_id = ?
      AND (c.deleted_at IS NULL OR c.deleted_at > now())")

(defn- get-branches
  [conn main-id]
  (db/exec! conn [sql:get-branches main-id]))

(defn- get-branch-by-file
  "The public row of the branch whose file is `file-id`, or nil."
  [conn file-id]
  (db/exec-one! conn [sql:get-branch-by-file file-id]))

(defn- get-row!
  "The full row of branch `id`; raises not-found."
  [conn id & {:keys [for-update?]}]
  (let [row (db/exec-one! conn [(if for-update? sql:get-row-for-update sql:get-row) id])]
    (when-not row
      (ex/raise :type :not-found
                :code :object-not-found
                :hint "branch not found"))
    row))

(defn- decode-media-map
  [row]
  (or (some-> (:media-map row) db/decode-transit-pgobject) {}))

(defn- check-active!
  [row]
  (when (not= "active" (:status row))
    (ex/raise :type :validation
              :code :branch-not-active
              :hint "the branch is merged or archived"
              :status (:status row)))
  (when-not (uuid? (:branch-file-id row))
    (ex/raise :type :validation
              :code :branch-file-missing
              :hint "the file of the branch no longer exists")))

(defn- check-branch-edition!
  "Editors of the main file or of the branch file."
  [conn profile-id row]
  (when-not (or (files/has-edit-permissions? conn profile-id (:main-file-id row))
                (and (uuid? (:branch-file-id row))
                     (files/has-edit-permissions? conn profile-id (:branch-file-id row))))
    (ex/raise :type :not-found
              :code :object-not-found
              :hint "not found")))

(defn- base-label
  [branch-id]
  (str "zvena/branch-base/" branch-id))

(defn- branch-file-name
  [main-name branch-name]
  (let [value (str main-name " / " branch-name)]
    (if (> (count value) 250)
      (subs value 0 250)
      value)))

(defn- deletion-delay
  "The team's deletion delay (the default one when the profile only has
  file level access)."
  [conn profile-id file-id]
  (try
    (ldel/get-deletion-delay
     (teams/get-team conn :profile-id profile-id :file-id file-id))
    (catch clojure.lang.ExceptionInfo _
      (cf/get-deletion-delay))))

(defn- set-snapshot-deleted-at!
  "Moves the deletion date of a snapshot (file_change row and its data)."
  [conn file-id snapshot-id deleted-at]
  (when (and (uuid? file-id) (uuid? snapshot-id))
    (db/update! conn :file-change
                {:deleted-at deleted-at}
                {:id snapshot-id :file-id file-id}
                {::db/return-keys false})
    (db/update! conn :file-data
                {:deleted-at deleted-at}
                {:id snapshot-id :file-id file-id :type "snapshot"}
                {::db/return-keys false})))

(defn- create-base-snapshot!
  "A snapshot of `main` (decoded, realized) kept while the branch lives."
  [cfg main branch-id profile-id]
  (fsnap/create! cfg main
                 {:label (base-label branch-id)
                  :created-by "system"
                  :deleted-at (ct/in-future base-retention)
                  :profile-id profile-id}))

;; --- Ids: branch data in main's terms and back

(defn- relink-media-keys
  [media lookup-fn]
  (reduce-kv (fn [result k v]
               (let [id (lookup-fn k)]
                 (if (= id k)
                   result
                   (-> result
                       (dissoc k)
                       (assoc id (assoc v :id id))))))
             media
             media))

(defn- relink-color-images
  [colors lookup-fn]
  (reduce-kv (fn [result k v]
               (let [image-id (get-in v [:image :id])]
                 (if (uuid? image-id)
                   (assoc-in result [k :image :id] (lookup-fn image-id))
                   result)))
             colors
             colors))

(defn- relink-data
  "Applies `lookup` (a map old id -> new id) to the file and image
  references of file data, the same references duplication remaps."
  [data lookup]
  (if (empty? lookup)
    data
    (let [lookup-fn (fn [id] (get lookup id id))]
      (-> data
          (d/update-when :pages-index cfh/relink-refs lookup-fn)
          (d/update-when :components cfh/relink-refs lookup-fn)
          (d/update-when :media relink-media-keys lookup-fn)
          (d/update-when :colors relink-color-images lookup-fn)))))

(defn- invert-map
  [m]
  (into {} (map (fn [[k v]] [v k])) m))

;; --- Images

(def ^:private sql:live-media
  "SELECT fmo.id
     FROM file_media_object AS fmo
    WHERE fmo.id = ANY(?)
      AND fmo.file_id = ?
      AND fmo.deleted_at IS NULL")

(def ^:private sql:media-rows
  "SELECT * FROM file_media_object WHERE id = ANY(?)")

(defn- collect-media-ids
  [data]
  (into (set (cfh/collect-used-media data))
        (keep #(get-in % [:image :id]))
        (vals (:colors data))))

(defn- live-media-ids
  [conn file-id ids]
  (if (empty? ids)
    #{}
    (->> (db/exec! conn [sql:live-media (db/create-array conn "uuid" ids) file-id])
         (into #{} (map :id)))))

(defn- fix-media!
  "Every image the merged `data` uses must be a live image of `file-id`.
  An image missing there is first replaced by its counterpart in the
  other file (`alternatives`, old id -> id), then whatever is still
  missing is copied into `file-id` with a new id (as Penpot does for
  images pasted from another file). Returns [data copies], copies being
  maps {:from old-id :to new-id :file-id source-file-id}."
  [conn file-id data alternatives]
  (let [used    (collect-media-ids data)
        live    (live-media-ids conn file-id used)
        back    (into {}
                      (keep (fn [id]
                              (when-not (contains? live id)
                                (when-let [alt (get alternatives id)]
                                  [id alt]))))
                      used)
        data    (relink-data data back)
        used    (collect-media-ids data)
        live    (live-media-ids conn file-id used)
        missing (into [] (remove live) used)
        rows    (if (seq missing)
                  (db/exec! conn [sql:media-rows (db/create-array conn "uuid" missing)])
                  [])
        copies  (mapv (fn [row]
                        {:from (:id row)
                         :to (uuid/next)
                         :file-id (:file-id row)})
                      rows)
        lookup  (into {} (map (juxt :from :to)) copies)]

    (doseq [row rows]
      (db/insert! conn :file-media-object
                  (-> row
                      (assoc :id (get lookup (:id row)))
                      (assoc :file-id file-id)
                      (dissoc :created-at)
                      (dissoc :deleted-at))
                  {::db/return-keys false}))

    [(relink-data data lookup) copies]))

;; --- Loading

(defn- get-base-data
  "The data of main when the branch was created (or last updated from
  main), migrated in memory to the current file version."
  [cfg main-id snapshot-id]
  (let [snapshot (when (uuid? snapshot-id)
                   ;; raises not-found when the snapshot is gone
                   (try
                     (fsnap/get-snapshot cfg main-id snapshot-id)
                     (catch clojure.lang.ExceptionInfo _ nil)))]
    (when-not (map? (:data snapshot))
      (ex/raise :type :validation
                :code :branch-base-missing
                :hint "the version this branch was created from is no longer available"))
    (let [base (->> {:id main-id
                     :data (:data snapshot)
                     :version (:version snapshot)
                     :features (or (:features snapshot) #{})
                     :migrations (not-empty (into #{} (:migrations snapshot)))}
                    (fdata/realize cfg))]
      (if (fmg/need-migration? base)
        (try
          (let [libs (delay (bfc/get-resolved-file-libraries cfg base))]
            (:data (fmg/migrate-file base libs)))
          (catch Throwable cause
            (l/wrn :hint "branch base: in-memory migration failed, comparing as stored"
                   :file-id (str main-id)
                   :cause cause)
            (:data base)))
        (:data base)))))

(defn- load-state
  "Main, branch and merge base of a branch row. `:rdata` is the branch
  data in main's terms (main's file id and image ids)."
  [cfg row & {:keys [lock?]}]
  (let [main-id   (:main-file-id row)
        branch-id (:branch-file-id row)
        main      (bfc/get-file cfg main-id
                                :realize? true
                                :read-only? true
                                :lock-for-update? (true? lock?))
        branch    (bfc/get-file cfg branch-id
                                :realize? true
                                :read-only? true
                                :lock-for-update? (true? lock?))
        media-map (decode-media-map row)
        lookup    (assoc (invert-map media-map) branch-id main-id)]
    {:main main
     :branch branch
     :media-map media-map
     :bdata (get-base-data cfg main-id (:base-snapshot-id row))
     :mdata (:data main)
     :rdata (relink-data (:data branch) lookup)}))

;; --- 3-way comparison

(defn- nil-safe
  [f]
  (fn [a b]
    (cond
      (and (nil? a) (nil? b)) true
      (or (nil? a) (nil? b))  false
      :else                   (f a b))))

(def ^:private same-value?
  (nil-safe =))

(def ^:private same-asset?
  ;; the modification date alone is not a change
  (nil-safe (fn [a b]
              (= (dissoc a :modified-at)
                 (dissoc b :modified-at)))))

(def ^:private same-datafied?
  ;; tokens libraries are types without value equality
  (nil-safe (fn [a b]
              (= (datafy a) (datafy b)))))

(defn- classify
  [same? b m r]
  (let [main?   (not (same? b m))
        branch? (not (same? b r))]
    (cond
      (and (not main?) (not branch?)) :unchanged
      (not main?)                     :branch
      (not branch?)                   :main
      (same? m r)                     :same
      :else                           :conflict)))

(defn- change-status
  [same? b v]
  (cond
    (and (nil? b) (nil? v)) nil
    (nil? b)                :added
    (nil? v)                :removed
    (same? b v)             nil
    :else                   :changed))

(defn- make-item
  [info same? b m r]
  (-> info
      (assoc :class (classify same? b m r))
      (assoc :main-status (change-status same? b m))
      (assoc :branch-status (change-status same? b r))
      (assoc ::base b)
      (assoc ::main m)
      (assoc ::branch r)))

(defn- side-value
  [item side]
  (if (= side :main)
    (::main item)
    (::branch item)))

(defn- root-ids
  [page]
  (vec (get-in page [:objects uuid/zero :shapes])))

(defn- top-subtrees
  "{id subtree} of the layers placed directly on the page; a subtree is
  the layer and all its descendants (id -> shape)."
  [page]
  (let [objects (:objects page)]
    (into {}
          (keep (fn [id]
                  (when (contains? objects id)
                    [id (select-keys objects (cfh/get-children-ids-with-self objects id))])))
          (root-ids page))))

(defn- page-props
  "Everything of a page but its layers (and comment positions, which
  belong to each file's own comments)."
  [page]
  (when (some? page)
    (-> page
        (dissoc :objects)
        (dissoc :comment-thread-positions)
        (assoc ::root (some-> (get-in page [:objects uuid/zero])
                              (dissoc :shapes))))))

(defn- page-items
  [page-id bp mp rp]
  (let [page-name (some :name [rp mp bp])
        info      {:page-id page-id :page-name page-name}]
    (if (and (some? mp) (some? rp))
      (let [bs  (top-subtrees bp)
            ms  (top-subtrees mp)
            rs  (top-subtrees rp)
            ids (distinct (concat (root-ids mp) (root-ids rp) (root-ids bp)))]
        (into [(make-item (d/without-nils
                           (assoc info
                                  :key (str "page-props:" page-id)
                                  :kind :page-props
                                  :id page-id
                                  :name page-name
                                  :main-name (:name mp)
                                  :old-name (:name bp)))
                          same-value?
                          (page-props bp)
                          (page-props mp)
                          (page-props rp))]
              (keep (fn [id]
                      (let [b (get bs id)
                            m (get ms id)
                            r (get rs id)
                            shape (get (or r m b) id)]
                        (when (or (some? b) (some? m) (some? r))
                          (make-item (d/without-nils
                                      (assoc info
                                             :key (str "layer:" page-id ":" id)
                                             :kind :layer
                                             :id id
                                             :name (:name shape)
                                             :type (:type shape)))
                                     same-value? b m r)))))
              ids))
      [(make-item (d/without-nils
                   (assoc info
                          :key (str "page:" page-id)
                          :kind :page
                          :id page-id
                          :name page-name))
                  same-value? bp mp rp)])))

(defn- asset-name
  [{:keys [path] :as asset}]
  (let [asset-name (str (:name asset))
        path       (some-> path str str/trim)]
    (if (str/blank? path)
      asset-name
      (str path " / " asset-name))))

(defn- asset-items
  [kind bmap mmap rmap]
  (let [ids (distinct (concat (keys mmap) (keys rmap) (keys bmap)))]
    (into []
          (keep (fn [id]
                  (let [b (get bmap id)
                        m (get mmap id)
                        r (get rmap id)
                        v (or r m b)]
                    (when (some? v)
                      (make-item (d/without-nils
                                  {:key (str (name kind) ":" id)
                                   :kind kind
                                   :id id
                                   :name (asset-name v)
                                   :color (when (= kind :color) (:color v))
                                   :opacity (when (= kind :color) (:opacity v))
                                   :font-family (when (= kind :typography) (:font-family v))
                                   :font-weight (when (= kind :typography) (some-> (:font-weight v) str))
                                   :font-style (when (= kind :typography) (:font-style v))})
                                 same-asset? b m r)))))
          ids)))

(defn- data-key-name
  [k]
  (subs (str k) 1))

(defn- data-items
  "Other file level data (design tokens, plugin data, file options...),
  each key compared as a whole."
  [bdata mdata rdata]
  (let [ks (->> (concat (keys mdata) (keys rdata) (keys bdata))
                (filter keyword?)
                (remove handled-data-keys)
                (distinct))]
    (into []
          (keep (fn [k]
                  (let [b (get bdata k)
                        m (get mdata k)
                        r (get rdata k)]
                    (when (or (some? b) (some? m) (some? r))
                      (make-item {:key (str "data:" (data-key-name k))
                                  :kind (if (= k :tokens-lib) :tokens :data)
                                  :data-key k
                                  :name (data-key-name k)}
                                 same-datafied? b m r)))))
          ks)))

(defn- compute-items
  "Every item of the file classified as :unchanged, :branch (changed only
  on the branch), :main (changed only on main), :same (the same change
  on both sides) or :conflict."
  [bdata mdata rdata]
  (let [page-ids (distinct (concat (:pages mdata) (:pages rdata) (:pages bdata)
                                   (keys (:pages-index mdata))
                                   (keys (:pages-index rdata))
                                   (keys (:pages-index bdata))))]
    (-> []
        (into (mapcat (fn [page-id]
                        (let [bp (get-in bdata [:pages-index page-id])
                              mp (get-in mdata [:pages-index page-id])
                              rp (get-in rdata [:pages-index page-id])]
                          (when (or (some? bp) (some? mp) (some? rp))
                            (page-items page-id bp mp rp)))))
              page-ids)
        (into (asset-items :component (:components bdata) (:components mdata) (:components rdata)))
        (into (asset-items :color (:colors bdata) (:colors mdata) (:colors rdata)))
        (into (asset-items :typography (:typographies bdata) (:typographies mdata) (:typographies rdata)))
        (into (asset-items :media (:media bdata) (:media mdata) (:media rdata)))
        (into (data-items bdata mdata rdata)))))

;; --- Merging

(defn- same-relative-order?
  [a b]
  (let [in-a (set a)
        in-b (set b)]
    (= (filterv in-b a) (filterv in-a b))))

(defn- merge-order
  "The order of the merged ids (pages, or layers on a page): the
  target's order, or the other side's when only the other side reordered
  what it shares with the base. Ids only the second list has are placed
  right after their nearest preceding neighbour there."
  [base-ids target-ids other-ids keep?]
  (let [other-first? (and (not (same-relative-order? base-ids other-ids))
                          (same-relative-order? base-ids target-ids))
        primary      (if other-first? other-ids target-ids)
        secondary    (if other-first? target-ids other-ids)
        result       (into [] (comp (filter keep?) (distinct)) primary)]
    (loop [result result
           placed (set result)
           prev   nil
           ids    (seq secondary)]
      (if-let [id (first ids)]
        (cond
          (contains? placed id)
          (recur result placed id (rest ids))

          (not (keep? id))
          (recur result placed prev (rest ids))

          :else
          (let [index  (if (some? prev)
                         (inc (.indexOf ^java.util.List result prev))
                         0)
                result (-> (subvec result 0 index)
                           (conj id)
                           (into (subvec result index)))]
            (recur result (conj placed id) id (rest ids))))
        result))))

(defn- add-subtree
  "Adds `subtree` (layer `id` and its descendants) to `objects`. Layers
  that `objects` already has (kept elsewhere by the merge) are left out
  together with their descendants, so no layer ends up twice."
  [objects id subtree]
  (if (or (empty? subtree) (contains? objects id))
    objects
    (let [taken   (into #{} (filter #(contains? objects %)) (keys subtree))
          dropped (into taken (mapcat #(cfh/get-children-ids subtree %)) taken)
          subtree (if (seq dropped)
                    (-> (apply dissoc subtree dropped)
                        (update-vals (fn [shape]
                                       (if (some dropped (:shapes shape))
                                         (update shape :shapes
                                                 (fn [ids] (filterv #(not (contains? dropped %)) ids)))
                                         shape))))
                    subtree)]
      (into objects subtree))))

(defn- merge-page
  "The target page with the layers (and page settings) the merge takes
  from the other side swapped in."
  [bp tp op props-item layer-items take-other? target other]
  (let [swapped  (filterv take-other? layer-items)
        objects  (reduce (fn [objects item]
                           (reduce dissoc objects (keys (side-value item target))))
                         (:objects tp)
                         swapped)
        objects  (reduce (fn [objects item]
                           (add-subtree objects (:id item) (side-value item other)))
                         objects
                         swapped)
        props?   (and (some? props-item) (take-other? props-item))
        page     (if props? op tp)
        root     (or (get-in page [:objects uuid/zero])
                     (get-in tp [:objects uuid/zero]))
        keep?    (fn [id]
                   (let [shape (get objects id)]
                     (and (some? shape)
                          (not= id uuid/zero)
                          (= uuid/zero (:parent-id shape)))))
        order    (merge-order (root-ids bp) (root-ids tp) (root-ids op) keep?)
        in-order (set order)
        order    (into order
                       (comp (map :id) (filter keep?) (remove in-order) (distinct))
                       layer-items)
        objects  (if (some? root)
                   (assoc objects uuid/zero (assoc root :shapes order))
                   objects)
        threads  (:comment-thread-positions tp)]
    (cond-> (-> page
                (dissoc :comment-thread-positions)
                (assoc :objects objects))
      (some? threads)
      (assoc :comment-thread-positions threads))))

(defn- later-inst
  [a b]
  (cond
    (nil? a) b
    (nil? b) a
    :else    (try
               (if (neg? (compare a b)) b a)
               (catch Throwable _ a))))

(defn- merge-assets
  "Assets of the target with the ones the merge takes from the other side
  swapped in. An asset both sides have keeps the later modification date
  (library updates are detected by it)."
  [tmap items take-other? other]
  (reduce (fn [result item]
            (let [id     (:id item)
                  result (if (take-other? item)
                           (let [v (side-value item other)]
                             (if (some? v)
                               (assoc result id v)
                               (dissoc result id)))
                           result)
                  v      (get result id)
                  m      (::main item)
                  r      (::branch item)]
              (if (and (map? v) (some? m) (some? r))
                (let [modified (reduce later-inst nil [(:modified-at v) (:modified-at m) (:modified-at r)])]
                  (if (and (some? modified) (not= modified (:modified-at v)))
                    (assoc result id (assoc v :modified-at modified))
                    result))
                result)))
          (or tmap {})
          items))

(defn- assoc-coll
  [data k v]
  (if (or (contains? data k) (seq v))
    (assoc data k v)
    data))

(defn- merge-data
  "The merged file data, built on the data of `target` (:main or
  :branch): every item `choose` gives to the other side gets the other
  side's version."
  [bdata mdata rdata items choose target]
  (let [other       (if (= target :main) :branch :main)
        tdata       (if (= target :main) mdata rdata)
        odata       (if (= target :main) rdata mdata)
        take-other? (fn [item] (= other (choose item)))
        by-kind     (group-by :kind items)

        page-level  (get by-kind :page)
        props-items (d/index-by :page-id (get by-kind :page-props))
        layers      (group-by :page-id (get by-kind :layer))

        index       (reduce (fn [index item]
                              (if (take-other? item)
                                (let [page (side-value item other)]
                                  (if (some? page)
                                    (assoc index (:id item) page)
                                    (dissoc index (:id item))))
                                index))
                            (:pages-index tdata)
                            page-level)

        index       (reduce-kv (fn [index page-id props-item]
                                 (let [tp (get-in tdata [:pages-index page-id])
                                       op (get-in odata [:pages-index page-id])]
                                   (if (and (some? tp) (some? op))
                                     (assoc index page-id
                                            (merge-page (get-in bdata [:pages-index page-id])
                                                        tp op props-item
                                                        (get layers page-id)
                                                        take-other? target other))
                                     index)))
                               index
                               props-items)

        pages       (merge-order (:pages bdata) (:pages tdata) (:pages odata)
                                 #(contains? index %))
        in-pages    (set pages)
        pages       (into pages
                          (comp (map :id)
                                (filter #(contains? index %))
                                (remove in-pages)
                                (distinct))
                          page-level)

        data-items  (concat (get by-kind :tokens) (get by-kind :data))]

    (as-> tdata data
      (assoc data :pages pages)
      (assoc data :pages-index index)
      (assoc-coll data :components
                  (merge-assets (:components tdata) (get by-kind :component) take-other? other))
      (assoc-coll data :colors
                  (merge-assets (:colors tdata) (get by-kind :color) take-other? other))
      (assoc-coll data :typographies
                  (merge-assets (:typographies tdata) (get by-kind :typography) take-other? other))
      (assoc-coll data :media
                  (merge-assets (:media tdata) (get by-kind :media) take-other? other))
      (reduce (fn [data item]
                (if (take-other? item)
                  (let [v (side-value item other)
                        k (:data-key item)]
                    (if (some? v)
                      (assoc data k v)
                      (dissoc data k)))
                  data))
              data
              data-items))))

(defn- resolve-choices
  "{conflict-key :main|:branch} for every conflict; raises when one has
  no choice."
  [items resolutions keep-all]
  (let [given     (into {}
                        (keep (fn [{item-key :key side :keep}]
                                (when (contains? #{"main" "branch"} side)
                                  [item-key (keyword side)])))
                        resolutions)
        default   (when (contains? #{"main" "branch"} keep-all)
                    (keyword keep-all))
        conflicts (filter #(= :conflict (:class %)) items)
        choices   (into {}
                        (map (fn [item]
                               [(:key item) (or (get given (:key item)) default)]))
                        conflicts)
        missing   (into [] (comp (remove val) (map key)) choices)]
    (when (seq missing)
      (ex/raise :type :validation
                :code :unresolved-conflicts
                :hint "choose the version to keep for every conflict"
                :conflicts missing))
    choices))

(defn- choose-side
  "Which side's version of `item` the merged file gets."
  [item choices target]
  (case (:class item)
    :branch   :branch
    :main     :main
    :conflict (get choices (:key item) target)
    target))

;; --- Validation (best effort)

(defn- check-and-repair
  "Validates the merged `file`. When the merge introduced validation
  errors (more than `before` had), Penpot's repair is applied, a few
  rounds at most. Never fails: on any problem the file is returned as
  it is."
  [cfg file before]
  (try
    (if-not (contains? (:features file) "components/v2")
      file
      (let [libs   (bfc/get-resolved-file-libraries cfg file)
            errors (cfv/validate-file file libs)]
        (if (empty? errors)
          file
          (let [previous (try
                           (cfv/validate-file before (bfc/get-resolved-file-libraries cfg before))
                           (catch Throwable _ nil))]
            (if (<= (count errors) (count previous))
              file
              (loop [file      file
                     errors    errors
                     iteration 0]
                (if (or (empty? errors) (>= iteration 3))
                  (do
                    (when (seq errors)
                      (l/wrn :hint "branch merge: validation errors remain"
                             :file-id (str (:id file))
                             :errors (count errors)))
                    file)
                  (let [changes (cfr/repair-file file libs errors)
                        file    (update file :data cfc/process-changes changes)]
                    (recur file (cfv/validate-file file libs) (inc iteration))))))))))
    (catch Throwable cause
      (l/wrn :hint "branch merge: validation skipped"
             :file-id (str (:id file))
             :cause cause)
      file)))

;; --- Writing

(defn- invalidate-thumbnails!
  [{:keys [::db/conn] :as cfg} file-id]
  (let [storage (sto/resolve cfg {::db/reuse-conn true})
        sql-1   (str "update file_tagged_object_thumbnail "
                     "   set deleted_at = now() "
                     " where file_id=? returning media_id")
        sql-2   (str "update file_thumbnail "
                     "   set deleted_at = now() "
                     " where file_id=? returning media_id")
        rows    (concat (db/exec! conn [sql-1 file-id])
                        (db/exec! conn [sql-2 file-id]))]
    (doseq [media-id (into #{} (keep :media-id) rows)]
      (sto/touch-object! storage media-id))))

(defn- write-file-data!
  "Replaces the data of `file` (decoded and realized) the way a snapshot
  restore does: new revn and vern, thumbnails invalidated. Returns the
  written file (not encoded)."
  [{:keys [::db/conn] :as cfg} file data]
  (let [now  (ct/now)
        file (-> file
                 (assoc :data data)
                 (update :revn inc)
                 (assoc :vern (rand-int Integer/MAX_VALUE))
                 (assoc :has-media-trimmed false)
                 (assoc :modified-at now))]
    (bfc/update-file! cfg file)
    (db/update! conn :project
                {:modified-at now}
                {:id (:project-id file)}
                {::db/return-keys false})
    (invalidate-thumbnails! cfg (:id file))
    (when (contains? cf/flags :redis-cache)
      (try
        (rds/run! cfg (fn [{:keys [::rds/conn]}]
                        (rds/del conn (str files/file-summary-cache-key-prefix (:id file)))))
        (catch Throwable cause
          (l/wrn :hint "branch merge: unable to invalidate cache" :cause cause))))
    file))

(defn- notify-restored!
  "Editors of `file-id` reload it (the message a snapshot restore sends)."
  [cfg file-id vern]
  (when-let [msgbus (::mbus/msgbus cfg)]
    (mbus/pub! msgbus
               :topic file-id
               :message {:type :file-restored
                         :file-id file-id
                         :vern vern})))

;; --- Results

(defn- public-item
  [item]
  (dissoc item ::base ::main ::branch))

(defn- listed
  [items]
  (into [] (comp (take max-listed) (map public-item)) items))

(defn- diff-result
  [row main items]
  (let [of-class     (fn [class] (filterv #(= class (:class %)) items))
        changes      (of-class :branch)
        main-changes (of-class :main)
        conflicts    (of-class :conflict)]
    {:branch-id (:id row)
     :name (:name row)
     :main-file-id (:main-file-id row)
     :branch-file-id (:branch-file-id row)
     :main-name (:name main)
     :main-revn (:revn main)
     :base-revn (:base-revn row)
     :changes (listed changes)
     :changes-count (count changes)
     :main-changes (listed main-changes)
     :main-changes-count (count main-changes)
     :conflicts (mapv public-item conflicts)}))

;; --- COMMAND QUERY: zvena-get-branches

(def ^:private schema:get-branches
  [:map {:title "zvena-get-branches"}
   [:file-id ::sm/uuid]])

(sv/defmethod ::zvena-get-branches
  "Branch information of a file. For a main file: its branches (active,
  merged and archived, newest first). For a branch file: its own branch
  row, its main file, whether main changed since the branch was created
  or last updated, and the branches of that main file."
  {::doc/added "2.18"
   ::audit/skip true
   ::sm/params schema:get-branches
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id file-id]}]
  (files/check-read-permissions! cfg profile-id file-id)
  (let [own     (get-branch-by-file conn file-id)
        main-id (if (some? own) (:main-file-id own) file-id)
        _       (when (some? own)
                  (files/check-read-permissions! cfg profile-id main-id))
        main    (db/exec-one! conn [sql:get-file-summary main-id])]
    (d/without-nils
     {:file-id file-id
      :is-branch (some? own)
      :branch own
      :main (some-> main (select-keys [:id :name :revn :project-id :modified-at]))
      :main-changed (boolean (and (some? own)
                                  (= "active" (:status own))
                                  (some? main)
                                  (> (or (:revn main) 0) (or (:base-revn own) 0))))
      :can-edit (files/has-edit-permissions? conn profile-id file-id)
      :can-edit-main (files/has-edit-permissions? conn profile-id main-id)
      :branches (get-branches conn main-id)})))

;; --- COMMAND: zvena-create-branch

(def ^:private schema:create-branch
  [:map {:title "zvena-create-branch"}
   [:file-id ::sm/uuid]
   [:name [:string {:max name-max-length}]]])

(sv/defmethod ::zvena-create-branch
  "Creates a branch of a file: a copy in the same project named
  \"<main> / <branch>\" plus a snapshot of main as the merge base.
  Editors of the file only; a branch can not be branched."
  {::doc/added "2.18"
   ::sm/params schema:create-branch
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id file-id] :as params}]
  (let [branch-name (str/trim (str (:name params)))]
    (when (str/blank? branch-name)
      (ex/raise :type :validation
                :code :invalid-branch-name
                :hint "the branch name is empty"))

    (files/check-edition-permissions! conn profile-id file-id)

    (when (some? (get-branch-by-file conn file-id))
      (ex/raise :type :validation
                :code :branch-of-branch
                :hint "a branch can not be branched"))

    ;; the lock update-file takes: no change lands between the base
    ;; snapshot and the copy
    (db/xact-lock! conn file-id)
    (db/exec-one! conn ["SET CONSTRAINTS ALL DEFERRED"])

    (let [main      (bfc/get-file cfg file-id :realize? true)
          id        (uuid/next)
          base      (create-base-snapshot! cfg main id profile-id)
          new-id    (uuid/next)
          [file index]
          (binding [bfc/*state* (volatile! {:index {file-id new-id}})]
            (let [file (mgmt/duplicate-file (assoc cfg ::bfc/timestamp (ct/now))
                                            {:profile-id profile-id
                                             :file-id file-id
                                             :name (branch-file-name (:name main) branch-name)
                                             :reset-shared-flag true})]
              [file (:index @bfc/*state*)]))
          media-map (dissoc index file-id)
          now       (ct/now)]

      (db/insert! conn :file-branch
                  {:id id
                   :main-file-id file-id
                   :branch-file-id (:id file)
                   :name branch-name
                   :created-by profile-id
                   :created-at now
                   :modified-at now
                   :base-revn (or (:revn main) 0)
                   :base-snapshot-id (:id base)
                   :media-map (db/tjson media-map)
                   :status "active"}
                  {::db/return-keys false})

      {:id id
       :name branch-name
       :main-file-id file-id
       :branch-file-id (:id file)
       :project-id (:project-id file)
       :team-id (:team-id main)})))

;; --- COMMAND QUERY: zvena-get-branch-diff

(def ^:private schema:get-branch-diff
  [:map {:title "zvena-get-branch-diff"}
   [:branch-id ::sm/uuid]])

(sv/defmethod ::zvena-get-branch-diff
  "What merging the branch would do: the changes made on the branch
  (`changes`), the changes made on main since the branch was created or
  last updated (`main-changes`) and the items changed on both sides in
  different ways (`conflicts`). Pages, layers placed directly on a page,
  page settings, components, colors, typographies and other file data."
  {::doc/added "2.18"
   ::audit/skip true
   ::sm/params schema:get-branch-diff
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id branch-id]}]
  (let [row (get-row! conn branch-id)]
    (files/check-read-permissions! cfg profile-id (:main-file-id row))
    (check-active! row)
    (files/check-read-permissions! cfg profile-id (:branch-file-id row))
    (let [{:keys [main bdata mdata rdata]} (load-state cfg row)]
      (-> (diff-result row main (compute-items bdata mdata rdata))
          (assoc :status (:status row))))))

;; --- COMMAND: zvena-merge-branch

(def ^:private schema:resolutions
  [:vector {:max 20000}
   [:map
    [:key [:string {:max 300}]]
    [:keep [:enum "main" "branch"]]]])

(def ^:private schema:merge-branch
  [:map {:title "zvena-merge-branch"}
   [:branch-id ::sm/uuid]
   [:resolutions {:optional true} [:maybe schema:resolutions]]
   [:keep-all {:optional true} [:maybe [:enum "main" "branch"]]]])

(sv/defmethod ::zvena-merge-branch
  "Merges the branch into main. Conflicts take the version chosen in
  `resolutions` ({key, keep: main|branch}) or `keep-all`; a conflict
  without a choice fails with :unresolved-conflicts. Main gets a version
  \"Before merging <branch>\" first; the merged data replaces main's like
  a version restore (open editors reload). The branch is marked merged
  and its merge base released. Editors of main only."
  {::doc/added "2.18"
   ::sm/params schema:merge-branch
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id branch-id resolutions keep-all]}]
  (let [row (get-row! conn branch-id :for-update? true)]
    (files/check-edition-permissions! conn profile-id (:main-file-id row))
    (check-active! row)
    (files/check-read-permissions! cfg profile-id (:branch-file-id row))

    ;; main first, then the branch: the order update-file can not invert
    (db/xact-lock! conn (:main-file-id row))
    (db/xact-lock! conn (:branch-file-id row))

    (let [{:keys [main bdata mdata rdata media-map]} (load-state cfg row :lock? true)
          items     (compute-items bdata mdata rdata)
          choices   (resolve-choices items resolutions keep-all)
          merged    (merge-data bdata mdata rdata items
                                #(choose-side % choices :main)
                                :main)
          [merged _] (fix-media! conn (:id main) merged media-map)
          merged    (check-and-repair cfg (assoc main :data merged) main)
          delay*    (deletion-delay conn profile-id (:id main))
          snapshot  (fsnap/create! cfg main
                                   {:label (str "Before merging " (:name row))
                                    :created-by "user"
                                    :profile-id profile-id})
          file      (write-file-data! cfg main (:data merged))
          now       (ct/now)]

      (db/update! conn :file-branch
                  {:status "merged"
                   :merged-at now
                   :merged-by profile-id
                   :merge-snapshot-id (:id snapshot)
                   :modified-at now}
                  {:id branch-id}
                  {::db/return-keys false})

      (set-snapshot-deleted-at! conn (:id main) (:base-snapshot-id row) (ct/in-future delay*))

      (-> {:branch-id branch-id
           :main-file-id (:id main)
           :branch-file-id (:branch-file-id row)
           :snapshot-id (:id snapshot)
           :revn (:revn file)
           :merged-count (count (filter #(= :branch (:class %)) items))
           :conflicts-count (count choices)}
          (rph/with-defer #(notify-restored! cfg (:id main) (:vern file)))))))

;; --- COMMAND: zvena-update-branch-from-main

(def ^:private schema:update-branch-from-main
  [:map {:title "zvena-update-branch-from-main"}
   [:branch-id ::sm/uuid]
   [:resolutions {:optional true} [:maybe schema:resolutions]]
   [:keep-all {:optional true} [:maybe [:enum "main" "branch"]]]])

(sv/defmethod ::zvena-update-branch-from-main
  "Brings the changes made on main since the branch was created (or last
  updated) into the branch, with the same conflict choices as a merge.
  The branch gets an autosaved version first; main's current state
  becomes the new merge base. Editors of the branch only."
  {::doc/added "2.18"
   ::sm/params schema:update-branch-from-main
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id branch-id resolutions keep-all]}]
  (let [row (get-row! conn branch-id :for-update? true)]
    (check-active! row)
    (files/check-edition-permissions! conn profile-id (:branch-file-id row))
    (files/check-read-permissions! cfg profile-id (:main-file-id row))

    (db/xact-lock! conn (:main-file-id row))
    (db/xact-lock! conn (:branch-file-id row))

    (let [{:keys [main branch bdata mdata rdata media-map]} (load-state cfg row :lock? true)
          main-id     (:id main)
          branch-fid  (:id branch)
          items       (compute-items bdata mdata rdata)
          choices     (resolve-choices items resolutions keep-all)
          merged      (merge-data bdata mdata rdata items
                                  #(choose-side % choices :branch)
                                  :branch)
          ;; back to the branch's own file id and images
          merged      (relink-data merged (assoc media-map main-id branch-fid))
          [merged copies] (fix-media! conn branch-fid merged (invert-map media-map))
          media-map   (into media-map
                            (keep (fn [{:keys [from to file-id]}]
                                    (when (= file-id main-id)
                                      [from to])))
                            copies)
          merged      (check-and-repair cfg (assoc branch :data merged) branch)
          delay*      (deletion-delay conn profile-id main-id)
          _           (fsnap/create! cfg branch
                                     {:created-by "system"
                                      :deleted-at (ct/in-future delay*)
                                      :profile-id profile-id})
          file        (write-file-data! cfg branch (:data merged))
          base        (create-base-snapshot! cfg main branch-id profile-id)
          now         (ct/now)]

      (db/update! conn :file-branch
                  {:base-revn (or (:revn main) 0)
                   :base-snapshot-id (:id base)
                   :media-map (db/tjson media-map)
                   :modified-at now}
                  {:id branch-id}
                  {::db/return-keys false})

      (set-snapshot-deleted-at! conn main-id (:base-snapshot-id row) (ct/in-future delay*))

      (-> {:branch-id branch-id
           :main-file-id main-id
           :branch-file-id branch-fid
           :revn (:revn file)
           :updated-count (count (filter #(= :main (:class %)) items))
           :conflicts-count (count choices)}
          (rph/with-defer #(notify-restored! cfg branch-fid (:vern file)))))))

;; --- COMMAND: zvena-archive-branch

(def ^:private schema:archive-branch
  [:map {:title "zvena-archive-branch"}
   [:branch-id ::sm/uuid]])

(sv/defmethod ::zvena-archive-branch
  "Archives an active branch without merging it: it moves to the
  archived branches (its file is kept, still hidden) and its merge base
  is released. Editors of main or of the branch."
  {::doc/added "2.18"
   ::sm/params schema:archive-branch
   ::db/transaction true}
  [{:keys [::db/conn]} {:keys [::rpc/profile-id branch-id]}]
  (let [row (get-row! conn branch-id :for-update? true)]
    (check-branch-edition! conn profile-id row)
    (when (not= "active" (:status row))
      (ex/raise :type :validation
                :code :branch-not-active
                :hint "the branch is merged or archived"))
    (let [now    (ct/now)
          delay* (deletion-delay conn profile-id (:main-file-id row))]
      (db/update! conn :file-branch
                  {:status "archived"
                   :archived-at now
                   :archived-by profile-id
                   :modified-at now}
                  {:id branch-id}
                  {::db/return-keys false})
      (set-snapshot-deleted-at! conn (:main-file-id row) (:base-snapshot-id row) (ct/in-future delay*))
      {:branch-id branch-id
       :main-file-id (:main-file-id row)
       :branch-file-id (:branch-file-id row)
       :status "archived"})))

;; --- COMMAND: zvena-restore-branch

(def ^:private schema:restore-branch
  [:map {:title "zvena-restore-branch"}
   [:branch-id ::sm/uuid]])

(sv/defmethod ::zvena-restore-branch
  "Makes an archived branch active again, when its file and its merge
  base still exist. Editors of main or of the branch."
  {::doc/added "2.18"
   ::sm/params schema:restore-branch
   ::db/transaction true}
  [{:keys [::db/conn]} {:keys [::rpc/profile-id branch-id]}]
  (let [row (get-row! conn branch-id :for-update? true)]
    (check-branch-edition! conn profile-id row)
    (when (not= "archived" (:status row))
      (ex/raise :type :validation
                :code :branch-not-archived
                :hint "only archived branches can be restored"))
    (when-not (and (uuid? (:branch-file-id row))
                   (some? (db/exec-one! conn ["SELECT id FROM file WHERE id = ? AND deleted_at IS NULL"
                                              (:branch-file-id row)])))
      (ex/raise :type :validation
                :code :branch-file-missing
                :hint "the file of the branch no longer exists"))
    (when-not (and (uuid? (:base-snapshot-id row))
                   (some? (db/exec-one! conn [sql:snapshot-exists
                                              (:base-snapshot-id row)
                                              (:main-file-id row)])))
      (ex/raise :type :validation
                :code :branch-base-missing
                :hint "the version this branch was created from is no longer available"))
    (set-snapshot-deleted-at! conn (:main-file-id row) (:base-snapshot-id row)
                              (ct/in-future base-retention))
    (db/update! conn :file-branch
                {:status "active"
                 :archived-at nil
                 :archived-by nil
                 :modified-at (ct/now)}
                {:id branch-id}
                {::db/return-keys false})
    {:branch-id branch-id
     :main-file-id (:main-file-id row)
     :branch-file-id (:branch-file-id row)
     :status "active"}))
