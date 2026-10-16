;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.rpc.commands.files-share
  "Share link related rpc mutation methods."
  (:require
   [app.binfile.common :as bfc]
   [app.common.exceptions :as ex]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.db :as db]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.files :as files]
   [app.rpc.doc :as-alias doc]
   [app.rpc.helpers :as rph]
   [app.util.services :as sv]
   [app.zvena.share-links :as zsl]))

;; --- MUTATION: Create Share Link

(declare create-share-link)

(def ^:private schema:create-share-link
  [:map {:title "create-share-link"}
   [:file-id ::sm/uuid]
   [:who-comment [:string {:max 250}]]
   [:who-inspect [:string {:max 250}]]
   [:pages [:set ::sm/uuid]]
   ;; zvena: Figma's link settings
   [:who-view {:optional true} zsl/schema:who-view]
   [:password {:optional true} [:maybe zsl/schema:password]]
   [:expires-at {:optional true} [:maybe ::ct/inst]]])

(sv/defmethod ::create-share-link
  "Creates a share-link object.

  Share links are resources that allows external users access to specific
  pages of a file with specific permissions (who-comment and who-inspect)."
  {::doc/added "1.18"
   ::doc/module :files
   ::sm/params schema:create-share-link
   ::db/transaction true
   ;; zvena: hashing a link password is as heavy as a login
   ::climit/id :auth/global}
  [{:keys [::db/conn]} {:keys [::rpc/profile-id file-id] :as params}]
  (files/check-edition-permissions! conn profile-id file-id)
  (create-share-link conn (assoc params :profile-id profile-id)))

(defn create-share-link
  [conn {:keys [profile-id file-id pages who-comment who-inspect
                ;; zvena: link settings
                who-view password expires-at]}]
  (zsl/check-expires-at! expires-at)
  (let [pages (db/create-array conn "uuid" pages)
        slink (db/insert! conn :share-link
                          {:id (uuid/random)
                           :file-id file-id
                           :who-comment who-comment
                           :who-inspect who-inspect
                           :pages pages
                           :owner-id profile-id
                           ;; zvena: link settings
                           :who-view (or who-view "all")
                           :password-hash (zsl/hash-password password)
                           :expires-at expires-at})]

    (-> slink
        (update :pages db/decode-pgarray #{})
        ;; zvena: never the password hash
        (zsl/clean-row))))

;; --- QUERY: Get Share Links

;; zvena: the editor's Share dialog lists, copies and revokes the existing
;; links of a file; upstream only loaded them with the viewer bundle, so the
;; editor always offered "Get link" and created a new link on every click.

(def ^:private schema:get-share-links
  [:map {:title "get-share-links"}
   [:file-id ::sm/uuid]])

(sv/defmethod ::get-share-links
  {::doc/added "2.18"
   ::doc/module :files
   ::sm/params schema:get-share-links}
  [cfg {:keys [::rpc/profile-id file-id]}]
  (db/run! cfg (fn [{:keys [::db/conn]}]
                 (files/check-edition-permissions! conn profile-id file-id)
                 (->> (db/query conn :share-link {:file-id file-id})
                      (mapv (fn [row]
                              (-> row
                                  (update :pages db/decode-pgarray #{})
                                  (dissoc :flags)
                                  ;; zvena: never the password hash
                                  (zsl/clean-row))))))))

;; --- MUTATION: Delete Share Link

(def ^:private schema:delete-share-link
  [:map {:title "delete-share-link"}
   [:id ::sm/uuid]])

(sv/defmethod ::delete-share-link
  {::doc/added "1.18"
   ::doc/module ::files
   ::sm/params schema:delete-share-link
   ::db/transaction true}
  [{:keys [::db/conn]} {:keys [::rpc/profile-id id] :as params}]
  (let [slink (db/get-by-id conn :share-link id)]
    (files/check-edition-permissions! conn profile-id (:file-id slink))

    ;; Verify caller owns this specific share-link, OR has admin access.
    ;; Note: :is-admin already includes :is-owner (see bfc/get-file-permissions),
    ;; so we only need to check :is-admin here.
    (let [perms (bfc/get-file-permissions conn profile-id (:file-id slink))]
      (when-not (or (= (:owner-id slink) profile-id)
                    (:is-admin perms))
        (ex/raise :type :authorization
                  :code :not-share-link-owner
                  :hint "You can only delete share-links you created")))

    (db/delete! conn :share-link {:id id})
    nil))

;; --- zvena: Link settings (password, expiry, who can open the link)

(defn- check-share-link-owner!
  "Same rule as deleting a link: edit rights on the file and either the
  link's creator or a team admin."
  [conn profile-id slink]
  (files/check-edition-permissions! conn profile-id (:file-id slink))
  (let [perms (bfc/get-file-permissions conn profile-id (:file-id slink))]
    (when-not (or (= (:owner-id slink) profile-id)
                  (:is-admin perms))
      (ex/raise :type :authorization
                :code :not-share-link-owner
                :hint "You can only change share-links you created"))))

(def ^:private schema:zvena-update-share-link
  [:map {:title "zvena-update-share-link"}
   [:id ::sm/uuid]
   [:who-view {:optional true} zsl/schema:who-view]
   ;; a string sets a new password, nil removes it, absent keeps it
   [:password {:optional true} [:maybe zsl/schema:password]]
   ;; an instant sets the expiry, nil means never, absent keeps it
   [:expires-at {:optional true} [:maybe ::ct/inst]]])

(sv/defmethod ::zvena-update-share-link
  "zvena: changes the settings of an existing share link (Figma's link
  settings): who can open it, its password and its expiry date."
  {::doc/added "2.18"
   ::doc/module :files
   ::sm/params schema:zvena-update-share-link
   ::db/transaction true
   ::climit/id :auth/global}
  [{:keys [::db/conn]} {:keys [::rpc/profile-id id who-view password expires-at] :as params}]
  (let [slink (db/get-by-id conn :share-link id)]
    (check-share-link-owner! conn profile-id slink)
    (when (contains? params :expires-at)
      (zsl/check-expires-at! expires-at))
    (let [changes (cond-> {}
                    (contains? params :who-view)
                    (assoc :who-view who-view)

                    (contains? params :password)
                    (assoc :password-hash (zsl/hash-password password))

                    (contains? params :expires-at)
                    (assoc :expires-at expires-at))
          slink   (if (seq changes)
                    (db/update! conn :share-link changes {:id id}
                                {::db/return-keys true})
                    slink)]
      (-> slink
          (update :pages db/decode-pgarray #{})
          (zsl/clean-row)))))

(def ^:private schema:zvena-unlock-share-link
  [:map {:title "zvena-unlock-share-link"}
   [:share-id ::sm/uuid]
   [:password [:string {:max 256}]]])

(sv/defmethod ::zvena-unlock-share-link
  "zvena: opens a password protected share link for this browser. On the
  right password it sets the HttpOnly `zv-share-<share-id>` cookie that
  every later share-id request (RPC, assets, exporter) is checked against.
  Wrong passwords are rate limited per IP and link."
  {::rpc/auth false
   ::doc/added "2.18"
   ::doc/module :files
   ::sm/params schema:zvena-unlock-share-link
   ::climit/id :auth/global}
  [cfg {:keys [::rpc/ip-addr share-id password]}]
  (let [slink (db/get* cfg :share-link {:id share-id})
        token (zsl/unlock! slink ip-addr password)]
    (cond-> {:unlocked true}
      (some? token)
      (rph/with-transform (zsl/assign-unlock-cookie share-id token)))))
