;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.figma
  "zvena: import from Figma. A narrow server-side proxy to Figma's REST
  API, so the browser keeps talking only to Design: it can read one file's
  document tree (with vector geometry) and the download URLs of that file's
  image fills. The person's personal access token is sent along with each
  call and is never stored or logged. The images themselves are fetched
  with the regular create-file-media-object-from-url command."
  (:require
   [app.common.exceptions :as ex]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.rpc :as-alias rpc]
   [app.rpc.doc :as-alias doc]
   [app.util.services :as sv])
  (:import
   java.net.URI
   java.net.http.HttpClient
   java.net.http.HttpClient$Redirect
   java.net.http.HttpRequest
   java.net.http.HttpResponse$BodyHandlers
   java.time.Duration))

(def ^:private client
  (delay (-> (HttpClient/newBuilder)
             (.connectTimeout (Duration/ofSeconds 10))
             (.followRedirects HttpClient$Redirect/NORMAL)
             (.build))))

(def ^:private api-base "https://api.figma.com")

(defn- figma-get
  "GET a Figma REST API path; the response body as a string."
  [token path]
  (let [req    (-> (HttpRequest/newBuilder (URI. (str api-base path)))
                   (.timeout (Duration/ofSeconds 180))
                   (.header "X-Figma-Token" token)
                   (.header "Accept" "application/json")
                   (.GET)
                   (.build))
        resp   (try
                 (.send ^HttpClient @client req (HttpResponse$BodyHandlers/ofString))
                 (catch Throwable cause
                   (l/wrn :hint "figma api unreachable" :reason (ex-message cause))
                   (ex/raise :type :validation
                             :code :zvena-figma-unreachable
                             :hint "Figma API is unreachable")))
        status (.statusCode resp)]
    (case (int status)
      200 (.body resp)
      (401 403) (ex/raise :type :validation
                          :code :zvena-figma-auth
                          :hint "Figma rejected the token or the file is not shared with it")
      404 (ex/raise :type :validation
                    :code :zvena-figma-not-found
                    :hint "Figma file not found")
      429 (ex/raise :type :validation
                    :code :zvena-figma-rate-limit
                    :hint "Figma API rate limit, try again in a minute")
      (ex/raise :type :validation
                :code :zvena-figma-error
                :hint (str "Figma API answered " status)))))

(def ^:private file-key-re #"[A-Za-z0-9]{10,64}")
(def ^:private node-id-re #"[0-9A-Za-z:;_-]{1,64}")

(def ^:private schema:figma-file
  [:map {:title "zvena-figma-file"}
   [:token [:string {:min 10 :max 300}]]
   [:file-key [:string {:min 10 :max 64}]]
   [:node-id {:optional true} [:maybe [:string {:max 64}]]]])

(sv/defmethod ::zvena-figma-file
  "The document tree (with vector paths) and the image fill URLs of one
  Figma file. With `node-id`, only that node's subtree."
  {::doc/added "2.18"
   ::sm/params schema:figma-file}
  [_cfg {:keys [::rpc/profile-id token file-key node-id]}]
  (when-not (re-matches file-key-re file-key)
    (ex/raise :type :validation :code :zvena-figma-bad-key :hint "invalid Figma file key"))
  (when (and (some? node-id) (not (re-matches node-id-re node-id)))
    (ex/raise :type :validation :code :zvena-figma-bad-key :hint "invalid Figma node id"))
  (l/inf :hint "figma import" :profile-id (str profile-id) :file-key file-key)
  (let [doc-path (if node-id
                   (str "/v1/files/" file-key "/nodes?geometry=paths&ids="
                        (java.net.URLEncoder/encode ^String node-id "UTF-8"))
                   (str "/v1/files/" file-key "?geometry=paths"))]
    {:document (figma-get token doc-path)
     :images   (figma-get token (str "/v1/files/" file-key "/images"))}))
