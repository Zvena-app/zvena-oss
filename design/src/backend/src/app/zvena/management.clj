;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.management
  "zvena: the internal API the zvena web app uses to keep Design in step with its
  accounts, workspaces and roles, and to read what Documents shows from
  Design (file lists, frame previews, usage, exports).

  Mounted under /management/zvena/ next to Penpot's own management API: the
  same shared key (PENPOT_MANAGEMENT_API_KEY, header x-shared-key), never
  exposed by the frontend's nginx. JSON in and out (camelCase keys).

  A person is known here by a technical login (u-<id>@users.zvena.invalid) that
  zvena gives them; Design never sees their real e-mail."
  (:require
   [app.binfile.common :as bfc]
   [app.binfile.v3 :as bf.v3]
   [app.common.data :as d]
   [app.common.exceptions :as ex]
   [app.common.features :as cfeat]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.types.team :as types.team]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.msgbus :as mbus]
   [app.rpc.commands.auth :as auth]
   [app.rpc.commands.files-create :as files-create]
   [app.rpc.commands.profile :as profile]
   [app.rpc.commands.teams :as teams]
   [app.rpc.permissions :as perms]
   [app.storage :as sto]
   [app.storage.tmp :as tmp]
   [app.worker :as wrk]
   [app.zvena.bridge :as zbridge]
   [app.zvena.limits :as zlimits]
   [app.zvena.teams :as zteams]
   [cuerdas.core :as str]
   [yetti.response :as yres]))

;; --- HELPERS

(defn- coercer
  [schema]
  (let [decode-fn (sm/decoder schema sm/json-transformer)
        check-fn  (sm/check-fn schema :type :validation :hint "invalid zvena management params")]
    (fn [data]
      (-> data decode-fn check-fn))))

(defn- ok
  [body]
  {::yres/status 200
   ::yres/body body})

(def ^:private schema:email [:string {:min 3 :max 320}])

(defn- clean-email
  [email]
  (-> email str/trim str/lower))

(defn- profile-by-email
  [conn email]
  (let [p (profile/get-profile-by-email conn (clean-email email))]
    (when (and p (nil? (:deleted-at p)))
      p)))

(defn- require-profile
  [conn email]
  (or (profile-by-email conn email)
      (ex/raise :type :not-found
                :code :profile-not-found
                :hint "no Design profile for this login")))

(defn- ensure-profile*
  "The profile of a zvena login, created (with its personal team) when
  missing; the display name follows zvena's."
  [{:keys [::db/conn] :as cfg} email fullname]
  (let [email    (clean-email email)
        fullname (some-> fullname str/trim (subs 0 (min 250 (count (str/trim fullname)))))]
    (if-let [p (profile-by-email conn email)]
      (do
        (when (and (not (str/blank? fullname)) (not= fullname (:fullname p)))
          (db/update! conn :profile {:fullname fullname} {:id (:id p)} {::db/return-keys false}))
        p)
      (let [p (auth/create-profile cfg {:email email
                                        :fullname (if (str/blank? fullname) "zvena" fullname)
                                        :backend "oidc"
                                        :is-active true
                                        :props {}})]
        (l/inf :hint "zvena: profile created" :profile-id (str (:id p)))
        (auth/create-profile-rels cfg p)))))

;; --- ENSURE-PROFILE

(def ^:private coerce-ensure-profile
  (coercer [:map [:email schema:email] [:fullname {:optional true} [:maybe :string]]]))

(defn- ensure-profile
  [cfg request]
  (let [{:keys [email fullname]} (-> request :params coerce-ensure-profile)
        p (ensure-profile* cfg email fullname)]
    (ok {:profile-id (:id p)
         :default-team-id (:default-team-id p)})))

;; --- SYNC-TEAM

(def ^:private schema:member
  [:map
   [:email schema:email]
   [:fullname {:optional true} [:maybe :string]]
   [:role [:enum "owner" "editor" "commenter" "viewer"]]])

(def ^:private coerce-sync-team
  (coercer [:map
            [:team-id {:optional true} [:maybe ::sm/uuid]]
            [:name [:string {:min 1 :max 250}]]
            [:members [:vector {:min 1} schema:member]]]))

(defn- penpot-role
  [role]
  (case role
    "owner" :owner
    "editor" :editor
    :viewer))

(def ^:private sql:delete-team-file-rels
  "DELETE FROM file_profile_rel AS fpr
    USING file AS f
    INNER JOIN project AS p ON (p.id = f.project_id)
    WHERE fpr.file_id = f.id AND p.team_id = ? AND fpr.profile_id = ?")

(def ^:private sql:delete-team-project-rels
  "DELETE FROM project_profile_rel AS ppr
    USING project AS p
    WHERE ppr.project_id = p.id AND p.team_id = ? AND ppr.profile_id = ?")

(defn- remove-member!
  [conn team-id profile-id]
  (db/exec! conn [sql:delete-team-file-rels team-id profile-id])
  (db/exec! conn [sql:delete-team-project-rels team-id profile-id])
  (db/delete! conn :team-project-profile-rel {:profile-id profile-id :team-id team-id})
  (db/delete! conn :team-profile-rel {:profile-id profile-id :team-id team-id})
  (zteams/ensure-schema! conn)
  (db/delete! conn :zvena-member-flags {:profile-id profile-id :team-id team-id}))

(defn- sync-team
  "Makes the team exist with exactly these members and roles (idempotent).
  The personal (default) team keeps its name; a new team is created when
  zvena has none yet (or the old one was deleted)."
  [{:keys [::db/conn ::mbus/msgbus] :as cfg} request]
  (let [{:keys [team-id name members]} (-> request :params coerce-sync-team)
        members  (mapv (fn [{:keys [email fullname role]}]
                         (let [p (ensure-profile* cfg email fullname)]
                           {:profile-id (:id p) :role role}))
                       members)
        owner    (or (d/seek #(= "owner" (:role %)) members)
                     (ex/raise :type :validation :code :owner-required))
        team     (when team-id
                   (db/get* conn :team {:id team-id :deleted-at nil}))
        team     (or team
                     (teams/create-team cfg {:profile-id (:profile-id owner)
                                             :name name
                                             :features (cfeat/get-enabled-features cf/flags)
                                             :is-default false}))
        team-id  (:id team)
        desired  (into {} (map (juxt :profile-id :role)) members)
        current  (into {}
                       (map (juxt :profile-id identity))
                       (db/query conn :team-profile-rel {:team-id team-id}))]

    (when (and (not (:is-default team)) (not= name (:name team)))
      (db/update! conn :team {:name name} {:id team-id} {::db/return-keys false}))

    (doseq [[pid row] current
            :when (not (contains? desired pid))]
      (remove-member! conn team-id pid)
      (mbus/pub! msgbus
                 :topic pid
                 :message {:type :team-membership-change
                           :change :removed
                           :team-id team-id
                           :team-name (:name team)})
      (l/dbg :hint "zvena: member removed" :team-id (str team-id) :was-owner (:is-owner row)))

    (doseq [[pid role] desired]
      (let [prole (penpot-role role)
            flags (get types.team/permissions-for-role prole)
            cur   (get current pid)]
        (if cur
          (when (not= flags (select-keys cur [:can-edit :is-admin :is-owner]))
            (db/update! conn :team-profile-rel flags {:team-id team-id :profile-id pid} {::db/return-keys false})
            (mbus/pub! msgbus
                       :topic pid
                       :message {:type :team-role-change
                                 :topic pid
                                 :team-id team-id
                                 :role prole}))
          (db/insert! conn :team-profile-rel
                      (merge {:id (uuid/next) :team-id team-id :profile-id pid} flags)
                      {::db/return-keys false}))
        (zteams/set-can-comment! conn team-id pid (not= role "viewer"))))

    (ok {:team-id team-id})))

;; --- DELETE-TEAM

(def ^:private coerce-team-id
  (coercer [:map [:team-id ::sm/uuid]]))

(defn- delete-team
  [{:keys [::db/conn]} request]
  (let [{:keys [team-id]} (-> request :params coerce-team-id)
        team (db/get* conn :team {:id team-id :deleted-at nil})]
    (if (or (nil? team) (:is-default team))
      (ok {:deleted false})
      (let [deleted-at (ct/in-future (cf/get-deletion-delay))]
        (db/update! conn :team {:deleted-at deleted-at} {:id team-id} {::db/return-keys false})
        (wrk/submit! {::db/conn conn
                      ::wrk/task :delete-object
                      ::wrk/params {:object :team :deleted-at deleted-at :id team-id}})
        (ok {:deleted true})))))

;; --- DELETE-PROFILE

(def ^:private coerce-email
  (coercer [:map [:email schema:email]]))

(def ^:private sql:owned-shared-teams
  "SELECT tpr.team_id AS id
     FROM team_profile_rel AS tpr
     JOIN team AS t ON (t.id = tpr.team_id)
    WHERE tpr.profile_id = ? AND tpr.is_owner IS TRUE AND t.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM team_profile_rel AS o
                   WHERE o.team_id = tpr.team_id AND o.profile_id <> tpr.profile_id)")

(def ^:private sql:team-successor
  "SELECT profile_id FROM team_profile_rel
    WHERE team_id = ? AND profile_id <> ?
    ORDER BY is_admin DESC, can_edit DESC, created_at ASC
    LIMIT 1")

(defn- delete-profile
  "Deletes the Design profile of a deleted zvena account. zvena hands its
  shared workspaces over first (sync-team); any team still shared goes to
  the next admin, else editor, else the oldest member. The rest follows
  Penpot's own profile deletion. Idempotent."
  [{:keys [::db/conn]} request]
  (let [{:keys [email]} (-> request :params coerce-email)]
    (if-let [{profile-id :id} (profile-by-email conn email)]
      (let [now (ct/now)]
        (doseq [{team-id :id} (db/exec! conn [sql:owned-shared-teams profile-id])]
          (when-let [{successor :profile-id} (db/exec-one! conn [sql:team-successor team-id profile-id])]
            (db/update! conn :team-profile-rel
                        (get types.team/permissions-for-role :owner)
                        {:team-id team-id :profile-id successor}
                        {::db/return-keys false})
            (remove-member! conn team-id profile-id)))
        (db/update! conn :profile {:deleted-at now} {:id profile-id} {::db/return-keys false})
        (wrk/submit! {::db/conn conn
                      ::wrk/task :delete-object
                      ::wrk/params {:object :profile :deleted-at now :id profile-id}})
        (db/exec-one! conn ["DELETE FROM http_session_v2 WHERE profile_id = ?" profile-id])
        (l/inf :hint "zvena: profile deleted with its account" :profile-id (str profile-id))
        (ok {:deleted true}))
      (ok {:deleted false}))))

;; --- USAGE

(defn- usage
  [cfg request]
  (let [{:keys [email]} (-> request :params coerce-email)]
    (ok {:bytes (if-let [p (profile-by-email cfg email)]
                  (zlimits/design-bytes cfg (:id p))
                  0)})))

;; --- FILES (the "Insert a design" picker and Home)

(def ^:private coerce-files
  (coercer [:map [:email schema:email] [:team-id ::sm/uuid]]))

(def ^:private sql:team-files
  "SELECT f.id, f.name, p.name AS project, f.modified_at
     FROM file AS f
     JOIN project AS p ON (p.id = f.project_id)
    WHERE p.team_id = ? AND f.deleted_at IS NULL AND p.deleted_at IS NULL
      -- zvena: branch files are reached through their main file
      AND NOT EXISTS (SELECT 1 FROM file_branch AS zb
                       WHERE zb.branch_file_id = f.id)
    ORDER BY f.modified_at DESC
    LIMIT 200")

(defn- team-files
  [cfg request]
  (let [{:keys [email team-id]} (-> request :params coerce-files)
        p (require-profile cfg email)]
    (when-not (teams/get-permissions cfg (:id p) team-id)
      (ex/raise :type :not-found :code :object-not-found))
    (ok {:files (->> (db/exec! cfg [sql:team-files team-id])
                     (mapv (fn [{:keys [id name project modified-at]}]
                             {:id id :name name :project project :modified-at modified-at})))})))

;; --- FRAMES of a file

(def ^:private coerce-file
  (coercer [:map [:email schema:email] [:file-id ::sm/uuid]]))

(defn- check-read!
  [cfg profile-id file-id]
  (let [p (perms/get-file-read-permissions cfg profile-id file-id)]
    (when-not (:can-read p)
      (ex/raise :type :not-found :code :object-not-found))
    p))

(def ^:private sql:file-info
  "SELECT f.name, f.revn, p.team_id
     FROM file AS f JOIN project AS p ON (p.id = f.project_id)
    WHERE f.id = ? AND f.deleted_at IS NULL")

(defn- frames
  [cfg request]
  (let [{:keys [email file-id]} (-> request :params coerce-file)
        p    (require-profile cfg email)
        _    (check-read! cfg (:id p) file-id)
        info (or (db/exec-one! cfg [sql:file-info file-id])
                 (ex/raise :type :not-found :code :object-not-found))
        file (bfc/get-file cfg file-id)
        data (:data file)]
    (ok {:name (:name info)
         :team-id (:team-id info)
         :revn (:revn info)
         :frames (vec
                  (for [page-id (:pages data)
                        :let [page (get-in data [:pages-index page-id])]
                        shape (vals (:objects page))
                        :when (and (= :frame (:type shape))
                                   (= uuid/zero (:parent-id shape))
                                   (not= uuid/zero (:id shape)))]
                    {:id (:id shape)
                     :name (:name shape)
                     :page-id page-id
                     :page-name (:name page)
                     :width (:width shape)
                     :height (:height shape)}))})))

;; --- FRAME PREVIEW (Documents' live design block)

(def ^:private coerce-frame
  (coercer [:map [:email schema:email] [:file-id ::sm/uuid] [:frame-id ::sm/uuid]]))

(def ^:private sql:frame-thumbnail
  "SELECT t.media_id, t.object_id
     FROM file_tagged_object_thumbnail AS t
    WHERE t.file_id = ? AND t.object_id LIKE ? AND t.deleted_at IS NULL
    ORDER BY t.created_at DESC
    LIMIT 1")

(defn- frame-thumbnail
  [cfg file-id frame-id]
  (db/exec-one! cfg [sql:frame-thumbnail file-id (str "%/" frame-id "/frame")]))

(defn- frame-preview
  [cfg request]
  (let [{:keys [email file-id frame-id]} (-> request :params coerce-frame)
        p     (require-profile cfg email)
        _     (check-read! cfg (:id p) file-id)
        info  (or (db/exec-one! cfg [sql:file-info file-id])
                  (ex/raise :type :not-found :code :object-not-found))
        thumb (frame-thumbnail cfg file-id frame-id)
        page  (some-> (:object-id thumb) (str/split "/") second)]
    (ok {:name (:name info)
         :revn (:revn info)
         :team-id (:team-id info)
         :page-id page
         :media-id (:media-id thumb)})))

(defn- frame-image
  "The frame thumbnail's bytes (zvena serves them to the document's readers)."
  [{:keys [::sto/storage] :as cfg} request]
  (let [{:keys [email file-id frame-id]} (-> request :params coerce-frame)
        p     (require-profile cfg email)
        _     (check-read! cfg (:id p) file-id)
        thumb (frame-thumbnail cfg file-id frame-id)
        obj   (some->> (:media-id thumb) (sto/get-object storage))
        bytes (some->> obj (sto/get-object-bytes storage))]
    (if bytes
      {::yres/status 200
       ::yres/headers {"content-type" (or (-> obj meta :content-type) "image/png")
                       "cache-control" "no-store"}
       ::yres/body bytes}
      {::yres/status 404})))

;; --- CREATE-FILE

(def ^:private coerce-create-file
  (coercer [:map [:email schema:email] [:team-id ::sm/uuid] [:name [:string {:min 1 :max 250}]]]))

(defn- create-file
  [{:keys [::db/conn] :as cfg} request]
  (let [{:keys [email team-id name]} (-> request :params coerce-create-file)
        p     (require-profile conn email)
        tperm (teams/get-permissions conn (:id p) team-id)]
    (when-not (:can-edit tperm)
      (ex/raise :type :not-found :code :object-not-found))
    (let [project (or (db/get* conn :project {:team-id team-id :is-default true :deleted-at nil})
                      (ex/raise :type :not-found :code :object-not-found))
          team    (db/get conn :team {:id team-id})
          file    (files-create/create-file cfg {:name name
                                                 :project-id (:id project)
                                                 :profile-id (:id p)
                                                 :features (cfeat/get-team-enabled-features cf/flags (teams/decode-row team))})]
      (ok {:file-id (:id file) :project-id (:id project)}))))

;; --- IMPORT-TEMPLATE (zvena's design templates, .penpot files)

(def ^:private coerce-import
  (coercer [:map
            [:email schema:email]
            [:team-id ::sm/uuid]
            [:name [:string {:min 1 :max 250}]]
            [:data [:string {:min 16 :max 40000000}]]]))

(defn- import-template
  "Imports a .penpot file (base64 in `data`) into the team's default
  project as a new file named `name`."
  [{:keys [::db/pool] :as cfg} request]
  (let [{:keys [email team-id name data]} (-> request :params coerce-import)
        p     (require-profile pool email)
        tperm (teams/get-permissions pool (:id p) team-id)]
    (when-not (:can-edit tperm)
      (ex/raise :type :not-found :code :object-not-found))
    (let [project (or (db/get* pool :project {:team-id team-id :is-default true :deleted-at nil})
                      (ex/raise :type :not-found :code :object-not-found))
          team    (db/get pool :team {:id team-id})
          bytes   (.decode (java.util.Base64/getDecoder) ^String data)
          _       (zlimits/check-team-storage! pool team-id (alength ^bytes bytes))
          path    (tmp/tempfile :prefix "zvena.template." :suffix ".penpot")]
      (try
        (java.nio.file.Files/write ^java.nio.file.Path path ^bytes bytes ^"[Ljava.nio.file.OpenOption;" (make-array java.nio.file.OpenOption 0))
        (bf.v3/import-files! (-> cfg
                                 (assoc ::bfc/features (cfeat/get-team-enabled-features cf/flags (teams/decode-row team)))
                                 (assoc ::bfc/project-id (:id project))
                                 (assoc ::bfc/profile-id (:id p))
                                 (assoc ::bfc/name name)
                                 (assoc ::bfc/input path)))
        (let [file (db/exec-one! pool ["SELECT id FROM file WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1" (:id project)])]
          ;; The v3 importer keeps the name stored in the .penpot file; the
          ;; caller's (localized) name wins.
          (when (and (:id file) (string? name) (not= "" (.trim ^String name)))
            (db/update! pool :file {:name (.trim ^String name)} {:id (:id file)}))
          (ok {:file-id (:id file) :project-id (:id project)}))
        (finally
          (java.nio.file.Files/deleteIfExists ^java.nio.file.Path path))))))

;; --- EXPORT (the person's data export)

(def ^:private sql:export-list
  "SELECT f.id, f.name, p.name AS project, t.name AS team, f.modified_at
     FROM file AS f
     JOIN project AS p ON (p.id = f.project_id)
     JOIN team AS t ON (t.id = p.team_id)
     JOIN team_profile_rel AS r ON (r.team_id = t.id AND r.profile_id = ?)
    WHERE f.deleted_at IS NULL AND p.deleted_at IS NULL AND t.deleted_at IS NULL
      AND (r.is_owner OR r.can_edit)
    ORDER BY t.name, f.name")

(defn- export-list
  [cfg request]
  (let [{:keys [email]} (-> request :params coerce-email)
        p (profile-by-email cfg email)]
    (ok {:files (if p
                  (->> (db/exec! cfg [sql:export-list (:id p)])
                       (mapv (fn [{:keys [id name project team modified-at]}]
                               {:id id :name name :project project :team team :modified-at modified-at})))
                  [])})))

(defn- export-file
  [cfg request]
  (let [{:keys [email file-id]} (-> request :params coerce-file)
        p (require-profile cfg email)]
    (check-read! cfg (:id p) file-id)
    {::yres/status 200
     ::yres/headers {"content-type" "application/zip"}
     ::yres/body (yres/stream-body
                  (fn [_ output]
                    (try
                      (bf.v3/export-files! (-> cfg
                                               (assoc ::bfc/ids #{file-id})
                                               (assoc ::bfc/include-libraries false)
                                               (assoc ::bfc/embed-assets true))
                                           output)
                      (finally
                        (.close ^java.io.OutputStream output)))))}))

;; --- UNPUBLISH (moderation after a complaint)

(def ^:private coerce-share
  (coercer [:map [:share-id ::sm/uuid]]))

(defn- unpublish
  [{:keys [::db/conn]} request]
  (let [{:keys [share-id]} (-> request :params coerce-share)
        n (db/get-update-count (db/delete! conn :share-link {:id share-id}))]
    (l/inf :hint "zvena: share link removed after a complaint" :share-id (str share-id))
    (ok {:removed (pos? n)})))

;; --- ROUTES

(defn routes
  "Mounted by app.http.management (shared-key auth, default system)."
  []
  ["/zvena"
   ["/ensure-profile" {:handler ensure-profile :allowed-methods #{:post} :transaction true}]
   ["/sync-team" {:handler sync-team :allowed-methods #{:post} :transaction true}]
   ["/delete-team" {:handler delete-team :allowed-methods #{:post} :transaction true}]
   ["/delete-profile" {:handler delete-profile :allowed-methods #{:post} :transaction true}]
   ["/usage" {:handler usage :allowed-methods #{:post}}]
   ["/files" {:handler team-files :allowed-methods #{:post}}]
   ["/frames" {:handler frames :allowed-methods #{:post}}]
   ["/frame-preview" {:handler frame-preview :allowed-methods #{:post}}]
   ["/frame-image" {:handler frame-image :allowed-methods #{:post}}]
   ["/create-file" {:handler create-file :allowed-methods #{:post} :transaction true}]
   ["/import-template" {:handler import-template :allowed-methods #{:post}}]
   ["/comment-thread" {:handler zbridge/comment-thread :allowed-methods #{:post}}]
   ["/file-comments" {:handler zbridge/file-comments :allowed-methods #{:post}}]
   ["/resolve-comment-thread" {:handler zbridge/resolve-comment-thread :allowed-methods #{:post}}]
   ["/export-list" {:handler export-list :allowed-methods #{:post}}]
   ["/export-file" {:handler export-file :allowed-methods #{:post}}]
   ["/unpublish" {:handler unpublish :allowed-methods #{:post} :transaction true}]])
