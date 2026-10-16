;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.library-publish
  "zvena: Figma's library publishing with release notes.

  The owner of a shared library presses \"Publish…\", sees what changed
  since the last publish (components, colors, typographies, effect styles
  and layout grid styles added,
  changed or removed), writes a description and publishes. Every publish
  is a row in `library_publish` (migration zvena-0003). Files that use
  the library read those rows as release notes in their \"Library
  updates\" review.

  Changes are computed here, from the persisted file, never from what a
  client says: the current assets (id, full name and `modified-at` of
  every component, color and typography) are compared with the snapshot
  stored by the previous publish. Both sides come from the server, so the
  comparison does not depend on client clocks.

  Publishing is informational. Penpot's library sync (live
  `library-change` notifications, `file_library_sync.synced_at`, the
  \"Update\" button) is untouched: a publish neither blocks nor triggers
  an update in the files that use the library."
  (:require
   [app.binfile.common :as bfc]
   [app.common.data :as d]
   [app.common.exceptions :as ex]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.types.components-list :as ctkl]
   [app.common.types.shape.zvena-effects :as zfx]
   [app.common.uuid :as uuid]
   [app.db :as db]
   [app.features.fdata :as feat.fdata]
   [app.loggers.audit :as-alias audit]
   [app.msgbus :as mbus]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.files :as files]
   [app.rpc.doc :as-alias doc]
   [app.rpc.helpers :as rph]
   [app.util.pointer-map :as pmap]
   [app.util.services :as sv]
   [cuerdas.core :as str]))

(def description-max-length 5000)

;; At most this many names per list (added, changed, removed) are kept in
;; a summary; the counts are always exact.
(def ^:private max-items 100)

(def ^:private kinds
  [:components :colors :typographies :effect-styles :grid-styles])

;; --- Current assets of a file

(defn- full-name
  [{:keys [name path]}]
  (let [name (str name)
        path (some-> path str str/trim)]
    (if (str/blank? path)
      name
      (str path " / " name))))

(defn- mark
  "The modification mark of an asset: `modified-at` as epoch millis."
  [v]
  (cond
    (nil? v)    nil
    (inst? v)   (inst-ms v)
    (number? v) (long v)
    :else       (str v)))

(defn- color-extra
  [{:keys [color opacity gradient image]}]
  (d/without-nils
   {:color    (when (string? color) color)
    :opacity  (when (number? opacity) opacity)
    :gradient (when (some? gradient) true)
    :image    (when (some? image) true)}))

(defn- typography-extra
  [{:keys [font-family font-weight font-style]}]
  (d/without-nils
   {:font-family (some-> font-family str)
    :font-weight (some-> font-weight str)
    :font-style  (some-> font-style str)}))

(defn- index-assets
  [assets extra-fn]
  (into {}
        (keep (fn [asset]
                (when-let [id (:id asset)]
                  [id (merge (d/without-nils
                              {:name (full-name asset)
                               :mod  (mark (:modified-at asset))})
                             (extra-fn asset))])))
        assets))

(defn- style-assets
  "{id item} of the effect / grid styles of a file data (they live in its
  zvena plugin-data, see app.common.types.shape.zvena-effects); the mark
  of a style is the hash of its stored value, which changes on any edit."
  [data kind]
  (into {}
        (map (fn [style]
               (let [raw (get-in data [:plugin-data zfx/plugin-ns (zfx/style-key kind (:id style))])]
                 [(:id style) {:name (str (:name style))
                               :mod  (hash (str raw))}])))
        (zfx/get-styles data kind)))

(defn- get-current-assets
  "The file row (without data) plus `:assets`, every asset of its local
  library: {:components {id item} :colors {id item} :typographies {id item}}."
  [cfg file-id]
  ;; read-only: an old file is migrated in memory, never written from here
  (let [file (bfc/get-file cfg file-id :read-only? true)]
    (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
      (let [data   (:data file)
            ;; everything is realized inside the binding (pointer maps)
            assets {:components   (index-assets (ctkl/components-seq data) (constantly nil))
                    :colors       (index-assets (vals (:colors data)) color-extra)
                    :typographies (index-assets (vals (:typographies data)) typography-extra)
                    ;; zvena: effect / layout grid styles
                    :effect-styles (style-assets data :effect)
                    :grid-styles   (style-assets data :grid)}]
        (-> file
            (select-keys [:id :name :revn :is-shared :team-id])
            (assoc :assets assets))))))

(defn- assets->snapshot
  [assets]
  (into {}
        (map (fn [kind]
               [kind (update-vals (get assets kind) #(select-keys % [:name :mod]))]))
        kinds))

;; --- Changes

(defn- section
  [items]
  {:count (count items)
   :items (->> items
               (sort-by (comp str/lower :name))
               (take max-items)
               (mapv #(dissoc % :mod)))})

(defn- diff-kind
  [prev curr]
  (let [added   (for [[id item] curr
                      :when (not (contains? prev id))]
                  (assoc item :id id))
        changed (for [[id item] curr
                      :let [old (get prev id)]
                      :when (and (some? old)
                                 (or (not= (:name old) (:name item))
                                     (not= (:mod old) (:mod item))))]
                  (cond-> (assoc item :id id)
                    (not= (:name old) (:name item))
                    (assoc :old-name (:name old))))
        removed (for [[id old] prev
                      :when (not (contains? curr id))]
                  (assoc old :id id))]
    {:added   (section added)
     :changed (section changed)
     :removed (section removed)}))

(defn- count-changes
  [changes]
  (reduce + 0 (for [kind kinds
                    what [:added :changed :removed]]
                (get-in changes [kind what :count] 0))))

(defn- compute-changes
  "Changes from `snapshot` (nil: never published) to `assets`."
  [snapshot assets]
  (let [changes (into {}
                      (map (fn [kind]
                             [kind (diff-kind (get snapshot kind {}) (get assets kind {}))]))
                      kinds)]
    (assoc changes
           :initial (nil? snapshot)
           :total (count-changes changes))))

;; --- Publish rows

(def ^:private sql:publish-columns
  "SELECT lp.id,
          lp.file_id,
          lp.profile_id,
          lp.created_at,
          lp.revn,
          lp.description,
          lp.summary,
          pf.fullname AS profile_name
     FROM library_publish AS lp
     LEFT JOIN profile AS pf ON (pf.id = lp.profile_id)")

(def ^:private sql:get-publish
  (str sql:publish-columns " WHERE lp.id = ?"))

(def ^:private sql:get-publishes
  (str sql:publish-columns
       " WHERE lp.file_id = ?
         ORDER BY lp.created_at DESC
         LIMIT ?"))

(def ^:private sql:get-publishes-since
  (str sql:publish-columns
       " WHERE lp.file_id = ?
           AND lp.created_at > ?::timestamptz
         ORDER BY lp.created_at DESC
         LIMIT ?"))

(def ^:private sql:last-snapshot
  "SELECT snapshot
     FROM library_publish
    WHERE file_id = ?
      AND snapshot IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1")

(def ^:private sql:drop-old-snapshots
  "UPDATE library_publish
      SET snapshot = NULL
    WHERE file_id = ?
      AND id <> ?
      AND snapshot IS NOT NULL")

(defn- decode-row
  [row]
  (when row
    (d/update-when row :summary db/decode-transit-pgobject)))

(defn- get-publish
  [cfg id]
  (decode-row (db/exec-one! cfg [sql:get-publish id])))

(defn get-publishes
  "Publishes of a library, newest first; with `since`, only the newer ones."
  [cfg file-id & {:keys [since limit] :or {limit 10}}]
  (->> (if (some? since)
         (db/exec! cfg [sql:get-publishes-since file-id since limit])
         (db/exec! cfg [sql:get-publishes file-id limit]))
       (mapv decode-row)))

(defn- get-last-snapshot
  [cfg file-id]
  (some-> (db/exec-one! cfg [sql:last-snapshot file-id])
          :snapshot
          (db/decode-transit-pgobject)))

(defn- check-publishes-read!
  "The library itself, or a file that uses it (directly or through another
  library), can be read by the profile."
  [cfg profile-id file-id from-file-id]
  (when-not (or (files/has-read-permissions? cfg profile-id file-id)
                (and (some? from-file-id)
                     (files/has-read-permissions? cfg profile-id from-file-id)
                     (contains? (bfc/get-libraries cfg [from-file-id]) file-id)))
    (ex/raise :type :not-found
              :code :object-not-found
              :hint "not found")))

(defn- notify-subscribers!
  "Tells the open workspaces of the team (the files using the library
  check whether it is theirs) that release notes are available."
  [cfg team-id message]
  (when-let [msgbus (::mbus/msgbus cfg)]
    (when (uuid? team-id)
      (mbus/pub! msgbus :topic team-id :message message))))

;; --- COMMAND QUERY: zvena-get-library-changes

(def ^:private schema:get-library-changes
  [:map {:title "zvena-get-library-changes"}
   [:file-id ::sm/uuid]])

(sv/defmethod ::zvena-get-library-changes
  "What would be published now: the changes of the file's components,
  colors and typographies since its last publish, plus that publish."
  {::doc/added "2.18"
   ::audit/skip true
   ::sm/params schema:get-library-changes
   ::db/transaction true}
  [cfg {:keys [::rpc/profile-id file-id]}]
  (files/check-read-permissions! cfg profile-id file-id)
  (let [{:keys [revn is-shared assets]} (get-current-assets cfg file-id)
        snapshot (get-last-snapshot cfg file-id)
        previous (first (get-publishes cfg file-id :limit 1))]
    {:file-id      file-id
     :revn         revn
     :is-shared    (boolean is-shared)
     :last-publish previous
     :changes      (compute-changes snapshot assets)}))

;; --- COMMAND: zvena-publish-library

(def ^:private schema:publish-library
  [:map {:title "zvena-publish-library"}
   [:file-id ::sm/uuid]
   [:description {:optional true} [:maybe [:string {:max description-max-length}]]]])

(sv/defmethod ::zvena-publish-library
  "Publishes the library: stores who, when, the description and what
  changed since the previous publish, and tells the team's open
  workspaces. Owners, admins and editors of the file only."
  {::doc/added "2.18"
   ::sm/params schema:publish-library
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id ::rpc/session-id file-id description]}]
  (files/check-edition-permissions! conn profile-id file-id)
  ;; the same lock update-file takes: the file is read after any update
  ;; in flight has been stored, and two publishes never interleave
  (db/xact-lock! conn file-id)
  (let [{:keys [revn team-id assets]} (get-current-assets cfg file-id)
        snapshot (get-last-snapshot cfg file-id)
        changes  (compute-changes snapshot assets)
        id       (uuid/next)]
    (db/insert! conn :library-publish
                {:id id
                 :file-id file-id
                 :profile-id profile-id
                 :created-at (ct/now)
                 :revn (or revn 0)
                 :description (str/trim (or description ""))
                 :summary (db/tjson changes)
                 :snapshot (db/tjson (assets->snapshot assets))}
                {::db/return-keys false})
    (db/exec-one! conn [sql:drop-old-snapshots file-id id])
    (let [publish (get-publish conn id)]
      ;; after commit, so the notes are readable when workspaces ask
      (rph/with-defer publish
        #(notify-subscribers! cfg team-id
                              {:type :zvena-library-published
                               :file-id file-id
                               :publish-id id
                               :profile-id profile-id
                               :session-id session-id})))))

;; --- COMMAND QUERY: zvena-get-library-publishes

(def ^:private schema:get-library-publishes
  [:map {:title "zvena-get-library-publishes"}
   [:file-id ::sm/uuid]
   [:from-file-id {:optional true} [:maybe ::sm/uuid]]
   [:since {:optional true} [:maybe ::ct/inst]]
   [:limit {:optional true} [:maybe [::sm/int {:min 1 :max 100}]]]])

(sv/defmethod ::zvena-get-library-publishes
  "Release notes of a library, newest first. `since` keeps only the
  publishes after that moment (a file's last sync with the library).
  Readable by anyone who can read the library, or a file that uses it
  (`from-file-id`)."
  {::doc/added "2.18"
   ::audit/skip true
   ::sm/params schema:get-library-publishes}
  [cfg {:keys [::rpc/profile-id file-id from-file-id since limit]}]
  (check-publishes-read! cfg profile-id file-id from-file-id)
  (get-publishes cfg file-id
                 :since since
                 :limit (or limit 10)))
