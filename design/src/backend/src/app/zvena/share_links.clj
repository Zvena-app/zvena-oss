;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.share-links
  "zvena: Figma's link settings for share links — a password, an expiry
  date and who may open the link (anyone with it, or only the team).

  Every share-id request (viewer bundle, pages, fragments, comments,
  fonts, assets, exporter renders) resolves its permissions through
  `app.binfile.common/get-file-permissions`, which asks `usable` here:
  an expired link, a team-only link or a password protected link that
  this browser has not unlocked grants nothing, exactly like a link that
  does not exist.

  Unlocking: `zvena-unlock-share-link` checks the password (argon2id, the
  same hashing as profile passwords) and sets an HttpOnly cookie
  `zv-share-<share-id>` holding `<expiry-ms>.<hmac>`. The HMAC key is the
  server secret plus the link's password hash, so the cookie can't be
  forged, works for every request the browser makes (RPC, <img> assets,
  the exporter forwards it) and stops working as soon as the owner
  changes or removes the password. The RPC dispatcher and the assets
  handler bind `*request*` so the permission check can read it."
  (:require
   [app.auth :as auth]
   [app.common.exceptions :as ex]
   [app.common.time :as ct]
   [app.config :as cf]
   [app.db :as db]
   [app.util.cache :as cache]
   [buddy.core.codecs :as bc]
   [cuerdas.core :as str]
   [yetti.request :as yreq]
   [yetti.response :as-alias yres])
  (:import
   java.security.MessageDigest
   javax.crypto.Mac
   javax.crypto.spec.SecretKeySpec))

(set! *warn-on-reflection* true)

(def ^:dynamic *request*
  "The HTTP request being served. Bound by the RPC dispatcher and the
  assets handler; its unlock cookies open password protected links."
  nil)

(def password-min-length 4)
(def password-max-length 128)

(def schema:password
  [:string {:min password-min-length :max password-max-length}])

(def schema:who-view
  [:enum "all" "team"])

;; An unlocked link stays open in that browser for a week.
(def ^:private unlock-max-age-ms
  (* 7 24 60 60 1000))

;; --- Unlock tokens

(defn cookie-name
  [share-id]
  (str "zv-share-" share-id))

(defn- sign
  ^String
  [share-id password-hash exp-ms]
  (let [key (str (cf/get :secret-key) "|" password-hash)
        mac (Mac/getInstance "HmacSHA256")]
    (.init mac (SecretKeySpec. (.getBytes ^String key "UTF-8") "HmacSHA256"))
    (-> (.doFinal mac (.getBytes (str "zv-share|" share-id "|" exp-ms) "UTF-8"))
        (bc/bytes->hex))))

(defn- make-token
  [share-id password-hash]
  (let [exp (+ (inst-ms (ct/now)) unlock-max-age-ms)]
    (str exp "." (sign share-id password-hash exp))))

(defn- valid-token?
  [share-id password-hash token]
  (boolean
   (when (string? token)
     (when-let [[_ exp sig] (re-matches #"(\d{1,15})\.([0-9a-f]{64})" token)]
       (let [exp (Long/parseLong exp)]
         (and (> exp (inst-ms (ct/now)))
              (MessageDigest/isEqual (.getBytes (sign share-id password-hash exp) "UTF-8")
                                     (.getBytes ^String sig "UTF-8"))))))))

(defn- request-token
  [share-id]
  (when-let [request *request*]
    (some-> (yreq/get-cookie request (cookie-name share-id)) :value)))

(defn assign-unlock-cookie
  "Response transform (see `app.rpc.helpers/with-transform`) that stores
  the unlock token in the browser."
  [share-id token]
  (fn [_request response]
    (let [secure? (contains? cf/flags :secure-session-cookies)
          cors?   (contains? cf/flags :cors)]
      (update response ::yres/cookies assoc (cookie-name share-id)
              {:path "/"
               :http-only true
               :value token
               :expires (ct/inst (+ (inst-ms (ct/now)) unlock-max-age-ms))
               :same-site (if cors? :none :lax)
               :secure secure?}))))

;; --- Link state

(defn expired?
  [{:keys [expires-at]}]
  (and (some? expires-at)
       (not (ct/is-after? expires-at (ct/now)))))

(defn team-only?
  [{:keys [who-view]}]
  (= "team" who-view))

(defn unlocked?
  "True when the link has no password or the current request carries a
  valid unlock cookie for it."
  [{:keys [id password-hash]}]
  (or (nil? password-hash)
      (valid-token? id password-hash (request-token id))))

(defn usable
  "The link when it grants access to people outside the team, else nil."
  [link]
  (when (and (some? link)
             (not (expired? link))
             (not (team-only? link))
             (unlocked? link))
    link))

(defn clean-row
  "A share link row as clients see it: the password hash never leaves the
  server, only whether there is one."
  [row]
  (when row
    (-> row
        (assoc :has-password (some? (:password-hash row)))
        (dissoc :password-hash :flags))))

(defn hash-password
  [password]
  (some-> password auth/derive-password))

(defn check-expires-at!
  "A new expiry date must lie in the future."
  [expires-at]
  (when (and (some? expires-at)
             (not (ct/is-after? expires-at (ct/now))))
    (ex/raise :type :validation
              :code :zvena-share-expiry-in-past
              :hint "the expiry date of a share link must be in the future")))

(defn raise-locked!
  "Called when a share link granted no permissions to the viewer bundle:
  tells the viewer why, so it can ask for the password or say that the
  link expired. Team-only and missing links stay a plain not-found (the
  frontend then offers to log in / request access)."
  [cfg file-id share-id]
  (when-let [link (db/get* cfg :share-link {:id share-id :file-id file-id})]
    (cond
      (expired? link)
      (ex/raise :type :not-found
                :code :zvena-share-link-expired
                :hint "the share link has expired")

      (team-only? link)
      nil

      (not (unlocked? link))
      (ex/raise :type :not-found
                :code :zvena-share-password-required
                :hint "the share link is password protected"))))

;; --- Wrong password attempts

;; In-memory, per backend instance: at most 10 wrong passwords per IP and
;; link and 100 per link in a 15 minute window (counted from the first
;; failure). The password check itself is argon2id, so guessing is slow
;; even below the limits.

(def ^:private max-failures-per-ip 10)
(def ^:private max-failures-per-link 100)

(defonce ^:private failures
  (cache/create :expire "15m" :max-size 100000))

(defn- failure-count
  [k]
  (if-let [counter (cache/get failures k)]
    (deref counter)
    0))

(defn- note-failure!
  [k]
  (swap! (cache/get failures k (fn [_] (atom 0))) inc))

(defn- client-id
  "Best guess of the visitor's address. Behind zvena's proxies the
  backend's `ip-addr` (X-Real-IP) is the proxy itself, so prefer
  Cloudflare's header, then the first X-Forwarded-For entry. A spoofed
  header only escapes the per-IP limit, never the per-link one."
  [ip-addr]
  (let [request *request*
        header  (fn [k]
                  (some-> request
                          (yreq/get-header k)
                          (str/split #"\s*,\s*")
                          (first)
                          (str/trim)
                          (not-empty)))]
    (or (header "cf-connecting-ip")
        (header "x-forwarded-for")
        (str ip-addr))))

(defn unlock!
  "Checks `password` against the link. Returns the unlock token, or nil
  when the link has no password. Raises not-found for missing/expired
  links, :zvena-share-too-many-attempts when rate limited and
  :zvena-share-wrong-password otherwise."
  [link ip-addr password]
  (let [share-id (:id link)
        ip-key   [:ip (client-id ip-addr) share-id]
        link-key [:link share-id]]
    (cond
      (nil? link)
      (ex/raise :type :not-found
                :code :object-not-found
                :hint "share link not found")

      (expired? link)
      (ex/raise :type :not-found
                :code :zvena-share-link-expired
                :hint "the share link has expired")

      (nil? (:password-hash link))
      nil

      (or (>= (failure-count ip-key) max-failures-per-ip)
          (>= (failure-count link-key) max-failures-per-link))
      (ex/raise :type :restriction
                :code :zvena-share-too-many-attempts
                :hint "too many wrong passwords, try again later")

      (:valid (auth/verify-password password (:password-hash link)))
      (make-token share-id (:password-hash link))

      :else
      (do
        (note-failure! ip-key)
        (note-failure! link-key)
        (ex/raise :type :validation
                  :code :zvena-share-wrong-password
                  :hint "wrong password")))))
