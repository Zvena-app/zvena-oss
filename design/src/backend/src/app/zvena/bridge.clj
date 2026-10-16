;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.bridge
  "zvena: comments on designs, as the rest of zvena sees them.

  Two directions:

  - zvena reads (management API, mounted by app.zvena.management):
      comment-thread {email, threadId} → one thread as that person sees it:
                     its file, page and frame, whether it is resolved (the
                     issue made from it follows), and what was said (a
                     comment turned into an issue quotes it);
      file-comments  {email, fileId}   → every thread of a file, so links
                     written in comments (\"see /projects/issue/ZVN-12\") link
                     the frame they sit on;
      resolve-comment-thread {email, threadId, resolved}
                     → resolves (or reopens) a thread for that person, when
                     the issue made from it is closed (or reopened) in zvena.
    The person is the technical login zvena gave them; Design checks that
    they may read the file.

  - Design tells (`notify!`, called by every comment mutation in
    app.rpc.commands.comments): POST {PENPOT_ZVENA_INTERNAL_URI}/api/internal/design-events
    with x-zvena-key: which file of which team had a comment change, and
    who did it; for new comments and threads also the thread, the comment
    and the logins the comment @mentions (other than its author), so zvena
    can put the mention in their Inbox. Ids only, never what was said. Batched a moment after the
    first change, sent from a background thread: a slow or absent zvena
    never slows down or fails a comment. Only with the `zvena-bridge` flag
    (PENPOT_FLAGS enable-zvena-bridge), switched on together with a zvena web
    that has the matching routes."
  (:require
   [app.binfile.common :as bfc]
   [app.common.exceptions :as ex]
   [app.common.json :as json]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.rpc.commands.profile :as profile]
   [app.rpc.permissions :as perms]
   [app.zvena.teams :as zteams]
   [cuerdas.core :as str]
   [yetti.response :as yres])
  (:import
   java.net.URI
   java.net.http.HttpClient
   java.net.http.HttpClient$Version
   java.net.http.HttpRequest
   java.net.http.HttpRequest$BodyPublishers
   java.net.http.HttpResponse$BodyHandlers
   java.time.Duration
   java.util.concurrent.Executors
   java.util.concurrent.ScheduledExecutorService
   java.util.concurrent.ThreadFactory
   java.util.concurrent.TimeUnit))

;; --- HELPERS (as in app.zvena.management)

(defn- coercer
  [schema]
  (let [decode-fn (sm/decoder schema sm/json-transformer)
        check-fn  (sm/check-fn schema :type :validation :hint "invalid zvena bridge params")]
    (fn [data]
      (-> data decode-fn check-fn))))

(defn- ok
  [body]
  {::yres/status 200
   ::yres/body body})

(def ^:private schema:email [:string {:min 3 :max 320}])

(defn- require-profile
  [conn email]
  (let [p (profile/get-profile-by-email conn (-> email str/trim str/lower))]
    (if (and p (nil? (:deleted-at p)))
      p
      (ex/raise :type :not-found
                :code :profile-not-found
                :hint "no Design profile for this login"))))

(defn- not-found!
  []
  (ex/raise :type :not-found :code :object-not-found))

(defn- check-read!
  [cfg profile-id file-id]
  (when-not (:can-read (perms/get-file-read-permissions cfg profile-id file-id))
    (not-found!)))

(def ^:private r-mention
  "A mention as comments store it: @[Name](profile-id)."
  #"@\[([^\]]*)\]\([^\)]*\)")

(def ^:private r-image
  "An image attached to a comment, as the comment text stores it: [[img:<file-media-id>]]."
  #"\[\[img:[0-9a-fA-F-]{36}\]\]")

(defn- plain
  "What a comment says, mentions written as @Name and attached images as
  [image] (their files need a Design session: no link that would not open)."
  [content]
  (-> (str content)
      (str/replace r-mention "@$1")
      (str/replace r-image "[image]")))

(defn- frame-of
  "A thread's frame, or nil when it sits on the page itself."
  [frame-id]
  (when (and (some? frame-id) (not= uuid/zero frame-id))
    frame-id))

;; --- COMMENT-THREAD (a comment becomes an issue)

(def ^:private coerce-thread
  (coercer [:map [:email schema:email] [:thread-id ::sm/uuid]]))

(def ^:private sql:thread
  "SELECT t.id, t.file_id, t.page_id, t.frame_id, t.is_resolved, f.name AS file_name, p.team_id
     FROM comment_thread AS t
     JOIN file AS f ON (f.id = t.file_id AND f.deleted_at IS NULL)
     JOIN project AS p ON (p.id = f.project_id AND p.deleted_at IS NULL)
    WHERE t.id = ?")

(def ^:private sql:thread-comments
  "SELECT c.id, c.content, c.created_at, pr.email AS author
     FROM comment AS c
     LEFT JOIN profile AS pr ON (pr.id = c.owner_id)
    WHERE c.thread_id = ?
    ORDER BY c.created_at ASC
    LIMIT 200")

(defn- frame-name
  "The frame's name in the file, or nil (the file is read whole: this runs
  once, when a person turns a comment into an issue)."
  [cfg file-id page-id frame-id]
  (try
    (let [data (:data (bfc/get-file cfg file-id))]
      (get-in data [:pages-index page-id :objects frame-id :name]))
    (catch Throwable cause
      (l/wrn :hint "zvena bridge: frame name unavailable" :cause cause)
      nil)))

(defn comment-thread
  [cfg request]
  (let [{:keys [email thread-id]} (-> request :params coerce-thread)
        p      (require-profile cfg email)
        thread (or (db/exec-one! cfg [sql:thread thread-id]) (not-found!))
        _      (check-read! cfg (:id p) (:file-id thread))
        frame  (frame-of (:frame-id thread))]
    (ok {:id (:id thread)
         :file-id (:file-id thread)
         :page-id (:page-id thread)
         :frame-id frame
         :team-id (:team-id thread)
         :is-resolved (boolean (:is-resolved thread))
         :file-name (:file-name thread)
         :frame-name (when frame (frame-name cfg (:file-id thread) (:page-id thread) frame))
         :comments (mapv (fn [{:keys [id content created-at author]}]
                           {:id id
                            :content (plain content)
                            :author author
                            :created-at created-at})
                         (db/exec! cfg [sql:thread-comments thread-id]))})))

;; --- FILE-COMMENTS (links written in comments)

(def ^:private coerce-file
  (coercer [:map [:email schema:email] [:file-id ::sm/uuid]]))

(def ^:private sql:file-team
  "SELECT p.team_id
     FROM file AS f JOIN project AS p ON (p.id = f.project_id)
    WHERE f.id = ? AND f.deleted_at IS NULL AND p.deleted_at IS NULL")

(def ^:private sql:file-comments
  "SELECT t.id AS thread_id, t.page_id, t.frame_id, c.id, c.content
     FROM comment_thread AS t
     JOIN comment AS c ON (c.thread_id = t.id)
    WHERE t.file_id = ?
    ORDER BY t.created_at ASC, c.created_at ASC
    LIMIT 5000")

(defn file-comments
  [cfg request]
  (let [{:keys [email file-id]} (-> request :params coerce-file)
        p    (require-profile cfg email)
        _    (check-read! cfg (:id p) file-id)
        team (or (db/exec-one! cfg [sql:file-team file-id]) (not-found!))
        rows (db/exec! cfg [sql:file-comments file-id])]
    (ok {:team-id (:team-id team)
         :threads (->> rows
                       (partition-by :thread-id)
                       (mapv (fn [[first-row :as comments]]
                               {:id (:thread-id first-row)
                                :page-id (:page-id first-row)
                                :frame-id (frame-of (:frame-id first-row))
                                :comments (mapv (fn [{:keys [id content]}]
                                                  {:id id :content (plain content)})
                                                comments)})))})))

;; --- RESOLVE-COMMENT-THREAD (the issue made from a thread was closed)

(def ^:private coerce-resolve
  (coercer [:map
            [:email schema:email]
            [:thread-id ::sm/uuid]
            [:resolved {:optional true} :boolean]]))

(defn resolve-comment-thread
  [cfg request]
  (let [{:keys [email thread-id resolved]} (-> request :params coerce-resolve)
        resolved (if (nil? resolved) true resolved)
        p        (require-profile cfg email)
        thread   (or (db/exec-one! cfg [sql:thread thread-id]) (not-found!))
        file-id  (:file-id thread)]
    (check-read! cfg (:id p) file-id)
    (zteams/check-can-comment! cfg (:id p) file-id)
    (db/update! cfg :comment-thread
                {:is-resolved resolved}
                {:id thread-id}
                {::db/return-keys false})
    (ok {:id thread-id :is-resolved resolved})))

;; --- NOTIFY (Design → zvena)

(defn- env
  [k]
  (let [v (System/getenv k)]
    (when-not (str/blank? v) v)))

(def ^:private client
  ;; HTTP/1.1: by default the JDK client offers an h2c upgrade on plain
  ;; http://, and zvena's Node server drops such a POST without answering.
  (delay (-> (HttpClient/newBuilder)
             (.version HttpClient$Version/HTTP_1_1)
             (.connectTimeout (Duration/ofSeconds 3))
             (.build))))

(defonce ^:private ^ScheduledExecutorService executor
  (Executors/newSingleThreadScheduledExecutor
   (reify ThreadFactory
     (newThread [_ runnable]
       (doto (Thread. ^Runnable runnable "zvena-bridge")
         (.setDaemon true))))))

(defonce ^:private queue (atom []))
(defonce ^:private last-warning (atom 0))

(def ^:private batch-delay-ms 250)
(def ^:private max-queued 1000)

(def ^:private sql:event-teams
  "SELECT f.id AS file_id, p.team_id
     FROM file AS f JOIN project AS p ON (p.id = f.project_id)
    WHERE f.id = ANY(?)")

(def ^:private sql:event-logins
  "SELECT id, email FROM profile WHERE id = ANY(?)")

(defn- resolve-events
  "The events as zvena takes them: each file's team, each person's login."
  [{:keys [::db/conn]} pending]
  (let [files  (into #{} (map :file-id) pending)
        people (-> #{}
                   (into (keep :profile-id) pending)
                   (into (mapcat :mentions) pending))
        teams  (->> (db/exec! conn [sql:event-teams (db/create-array conn "uuid" files)])
                    (into {} (map (juxt :file-id :team-id))))
        logins (->> (db/exec! conn [sql:event-logins (db/create-array conn "uuid" people)])
                    (into {} (map (juxt :id :email))))]
    (into []
          (keep (fn [{:keys [file-id profile-id name thread-id comment-id mentions]}]
                  (when-let [team (get teams file-id)]
                    (let [mentioned (into [] (comp (remove #(= % profile-id))
                                                   (keep #(get logins %))
                                                   (distinct))
                                          mentions)]
                      (cond-> {"team" (str team) "file" (str file-id) "name" name}
                        (get logins profile-id) (assoc "login" (get logins profile-id))
                        (some? thread-id)       (assoc "thread" (str thread-id))
                        (some? comment-id)      (assoc "comment" (str comment-id))
                        (seq mentioned)         (assoc "mentions" mentioned))))))
          pending)))

(defn- warn!
  "One warning a minute at most: an absent zvena would otherwise fill the log.
  (`:cause` is for exceptions in app.common.logging; a message goes in `:reason`.)"
  [hint reason]
  (let [now (System/currentTimeMillis)
        was @last-warning]
    (when (and (> (- now was) 60000) (compare-and-set! last-warning was now))
      (l/wrn :hint hint :reason (str reason)))))

(defn- send!
  [base key events]
  (let [req  (-> (HttpRequest/newBuilder (URI. (str (str/rtrim base "/") "/api/internal/design-events")))
                 (.timeout (Duration/ofSeconds 4))
                 (.header "content-type" "application/json")
                 (.header "x-zvena-key" key)
                 (.POST (HttpRequest$BodyPublishers/ofString (json/encode {"events" events})))
                 (.build))
        resp (.send ^HttpClient @client req (HttpResponse$BodyHandlers/discarding))]
    (when-not (= 200 (.statusCode resp))
      (warn! "zvena bridge: design events refused" (str "status " (.statusCode resp))))))

(defn- flush!
  [pool]
  (let [[pending _] (swap-vals! queue (constantly []))
        base (env "PENPOT_ZVENA_INTERNAL_URI")
        key  (env "PENPOT_ZVENA_INTERNAL_KEY")]
    (when (and (seq pending) base key)
      (try
        (let [events (db/run! {::db/pool pool} resolve-events (vec (distinct pending)))]
          (doseq [batch (partition-all 100 events)]
            (send! base key (vec batch))))
        (catch Throwable cause
          (warn! "zvena bridge: design events not delivered" (ex-message cause)))))))

(defn notify!
  "Tells zvena, a moment later and from another thread, that a comment of
  `file-id` changed (`event`: the mutation's name, e.g. :create-comment;
  `extra`: {:thread-id :comment-id :mentions #{profile-id}}). Never throws."
  ([cfg profile-id file-id event]
   (notify! cfg profile-id file-id event nil))
  ([cfg profile-id file-id event extra]
  (try
    (when (and (contains? cf/flags :zvena-bridge)
               (some? file-id)
               (env "PENPOT_ZVENA_INTERNAL_URI")
               (env "PENPOT_ZVENA_INTERNAL_KEY"))
      (when-let [pool (::db/pool cfg)]
        (let [[before _] (swap-vals! queue (fn [q]
                                             (if (< (count q) max-queued)
                                               (conj q (cond-> {:file-id file-id
                                                                :profile-id profile-id
                                                                :name (name event)}
                                                         (uuid? (:thread-id extra))
                                                         (assoc :thread-id (:thread-id extra))
                                                         (uuid? (:comment-id extra))
                                                         (assoc :comment-id (:comment-id extra))
                                                         (seq (:mentions extra))
                                                         (assoc :mentions (into [] (filter uuid?) (:mentions extra)))))
                                               q)))]
          (when (empty? before)
            (.schedule executor
                       ^Runnable (fn [] (flush! pool))
                       (long batch-delay-ms)
                       TimeUnit/MILLISECONDS)))))
    (catch Throwable cause
      (warn! "zvena bridge: design event dropped" (ex-message cause))))
  nil))
