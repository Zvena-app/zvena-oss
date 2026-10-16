;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.limits
  "zvena: the storage quota and upload compression in Design.

  One quota per account covers documents, their files and designs (the zvena web app
  decides it, default 2 GB). A team's uploads count against the team owner
  (zvena's workspace owner pays for its workspace). Design asks zvena for the
  quota and the documents' share (GET /api/internal/usage, cached a minute)
  and adds what the owner's teams store here. The check fails closed: when
  zvena can't answer (down, timeout, an error status or a broken body) the
  last answer it gave is used, however old, and without one the default
  quota (PENPOT_ZVENA_STORAGE_QUOTA_BYTES, 2 GB) is compared with Design's
  own bytes, so an outage never lifts the limit.

  Raster photos larger than PENPOT_ZVENA_IMAGE_MAX_SIDE (default 4096 px) are
  scaled down on upload, and every re-encoded photo loses its metadata
  (EXIF: camera, time, GPS position)."
  (:require
   [app.common.exceptions :as ex]
   [app.common.json :as json]
   [app.common.logging :as l]
   [app.db :as db]
   [app.media :as media]
   [app.zvena.teams :as zteams]
   [cuerdas.core :as str])
  (:import
   java.net.URI
   java.net.URLEncoder
   java.net.http.HttpClient
   java.net.http.HttpClient$Version
   java.net.http.HttpRequest
   java.net.http.HttpResponse$BodyHandlers
   java.nio.charset.StandardCharsets
   java.time.Duration))

(defn- env
  [k default]
  (let [v (System/getenv k)]
    (if (str/blank? v) default v)))

;; --- Usage

(def ^:private sql:owner-of-file
  "SELECT p.id, p.email
     FROM file AS f
     JOIN project AS pr ON (pr.id = f.project_id)
     JOIN team_profile_rel AS r ON (r.team_id = pr.team_id AND r.is_owner IS TRUE)
     JOIN profile AS p ON (p.id = r.profile_id)
    WHERE f.id = ?")

(def ^:private sql:design-bytes
  "Bytes stored for the teams a profile owns: media, fonts and file data."
  "WITH teams AS (
     SELECT r.team_id FROM team_profile_rel AS r
       JOIN team AS t ON (t.id = r.team_id AND t.deleted_at IS NULL)
      WHERE r.profile_id = ? AND r.is_owner IS TRUE),
   files AS (
     SELECT f.id FROM file AS f
       JOIN project AS pr ON (pr.id = f.project_id)
      WHERE pr.team_id IN (SELECT team_id FROM teams) AND f.deleted_at IS NULL),
   objects AS (
     SELECT media_id AS id FROM file_media_object WHERE file_id IN (SELECT id FROM files) AND deleted_at IS NULL
     UNION SELECT thumbnail_id FROM file_media_object WHERE file_id IN (SELECT id FROM files) AND deleted_at IS NULL
     UNION SELECT otf_file_id FROM team_font_variant WHERE team_id IN (SELECT team_id FROM teams) AND deleted_at IS NULL
     UNION SELECT ttf_file_id FROM team_font_variant WHERE team_id IN (SELECT team_id FROM teams) AND deleted_at IS NULL
     UNION SELECT woff1_file_id FROM team_font_variant WHERE team_id IN (SELECT team_id FROM teams) AND deleted_at IS NULL
     UNION SELECT woff2_file_id FROM team_font_variant WHERE team_id IN (SELECT team_id FROM teams) AND deleted_at IS NULL)
   SELECT
     (SELECT COALESCE(SUM(so.size), 0) FROM storage_object AS so
       WHERE so.id IN (SELECT id FROM objects WHERE id IS NOT NULL) AND so.deleted_at IS NULL)
   + (SELECT COALESCE(SUM(octet_length(f.data)), 0) FROM file AS f WHERE f.id IN (SELECT id FROM files))
   + (SELECT COALESCE(SUM(octet_length(fd.data)), 0) FROM file_data AS fd WHERE fd.file_id IN (SELECT id FROM files) AND fd.deleted_at IS NULL)
     AS bytes")

(defn design-bytes
  [cfg profile-id]
  (or (some-> (db/exec-one! cfg [sql:design-bytes profile-id]) :bytes long) 0))

(def ^:private client
  ;; HTTP/1.1: the JDK client otherwise offers an h2c upgrade on plain
  ;; http://, which zvena's Node server drops without a response.
  (delay (-> (HttpClient/newBuilder)
             (.version HttpClient$Version/HTTP_1_1)
             (.connectTimeout (Duration/ofSeconds 3))
             (.build))))

(def ^:private cache (atom {}))

(def ^:private default-quota
  (delay (or (some-> (env "PENPOT_ZVENA_STORAGE_QUOTA_BYTES" nil) parse-long)
             (* 2 1024 1024 1024))))

(defn- fetch-usage
  "{:quota bytes :docs bytes} from the zvena web app; throws on any failure."
  [base key email]
  (let [uri  (str (str/rtrim base "/") "/api/internal/usage?login="
                  (URLEncoder/encode (str email) StandardCharsets/UTF_8))
        req  (-> (HttpRequest/newBuilder (URI. uri))
                 (.timeout (Duration/ofSeconds 4))
                 (.header "x-zvena-key" key)
                 (.GET)
                 (.build))
        resp (.send ^HttpClient @client req (HttpResponse$BodyHandlers/ofString))
        code (.statusCode resp)]
    (when-not (= 200 code)
      (throw (ex-info (str "status " code) {:status code})))
    (let [body  (json/decode (.body resp) :key-fn keyword)
          quota (:quota body)
          docs  (:docs body)]
      (when-not (and (number? quota) (number? docs))
        (throw (ex-info "unexpected body" {})))
      {:quota (long quota) :docs (long docs)})))

(defn- zvena-usage
  "{:quota bytes :docs bytes} for a Design login: the zvena web app's answer (cached
  a minute), else its last answer, else the default quota with no
  documents (fail closed)."
  [email]
  (let [base (env "PENPOT_ZVENA_INTERNAL_URI" nil)
        key  (env "PENPOT_ZVENA_INTERNAL_KEY" nil)
        now  (System/currentTimeMillis)
        hit  (get @cache email)]
    (if (and hit (< (- now (:at hit)) 60000))
      (:value hit)
      (try
        (when (or (nil? base) (nil? key))
          (throw (ex-info "PENPOT_ZVENA_INTERNAL_URI/KEY not set" {})))
        (let [value (fetch-usage base key email)]
          (swap! cache assoc email {:at now :value value})
          value)
        (catch Throwable cause
          (l/wrn :hint "zvena usage unavailable, quota kept" :reason (ex-message cause))
          ;; asked again in 15 s, not on every upload of an outage
          (let [value (or (:value hit) {:quota @default-quota :docs 0})]
            (swap! cache assoc email {:at (- now 45000) :value value})
            value))))))

(def ^:private sql:owner-of-team
  "SELECT p.id, p.email
     FROM team_profile_rel AS r
     JOIN profile AS p ON (p.id = r.profile_id)
    WHERE r.team_id = ? AND r.is_owner IS TRUE")

(defn- check-owner-storage!
  [cfg owner incoming]
  (when (zteams/enabled?)
    (when-let [{:keys [id email]} owner]
      (when-let [{:keys [quota docs]} (zvena-usage email)]
        (when (pos? quota)
          (let [used (+ docs (design-bytes cfg id))]
            (when (> (+ used (long (or incoming 0))) quota)
              (ex/raise :type :restriction
                        :code :zvena-storage-full
                        :hint "storage quota reached"
                        :quota quota
                        :used used))))))))

(defn check-file-storage!
  "Refuses an upload of `incoming` bytes into a file when the owner of its
  team would go over the quota."
  [cfg file-id incoming]
  (when (zteams/enabled?)
    (check-owner-storage! cfg (db/exec-one! cfg [sql:owner-of-file file-id]) incoming)))

(defn check-team-storage!
  "The same check for uploads that belong to a team (fonts, imported files)."
  [cfg team-id incoming]
  (when (zteams/enabled?)
    (check-owner-storage! cfg (db/exec-one! cfg [sql:owner-of-team team-id]) incoming)))

;; --- Upload compression

(def ^:private max-side
  (delay (or (some-> (env "PENPOT_ZVENA_IMAGE_MAX_SIDE" nil) parse-long) 4096)))

(def ^:private formats
  {"image/jpeg" :jpeg "image/png" :png "image/webp" :webp})

(defn downscale
  "A photo bigger than the maximum side, scaled down (and stripped of its
  metadata); anything else unchanged. Returns image info like media :info."
  [cfg {:keys [mtype width height] :as info}]
  (let [fmt (get formats mtype)
        mx  @max-side]
    (if (and (zteams/enabled?) fmt (number? width) (number? height)
             (or (> width mx) (> height mx)))
      (try
        (let [out   (media/run cfg {:cmd :generic-thumbnail
                                    :input info
                                    :format fmt
                                    :quality 90
                                    :width mx
                                    :height mx})
              info' (media/run cfg {:cmd :info
                                    :input {:path (:data out) :mtype (:mtype out)}})]
          (l/dbg :hint "zvena: photo scaled down" :from [width height] :to [(:width info') (:height info')])
          (merge info info' {:path (:data out) :mtype (:mtype out) :size (:size out)}))
        (catch Throwable cause
          (l/wrn :hint "zvena: photo kept as uploaded" :reason (ex-message cause))
          info))
      info)))
