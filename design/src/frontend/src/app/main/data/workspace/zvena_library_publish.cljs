;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-library-publish
  "zvena: Figma's library publishing with release notes.

  The library owner opens \"Publish library\": pending edits are saved
  first, then the backend (app.zvena.library-publish) says what changed
  since the last publish. Publishing stores a description and that
  summary. Files that use the library read those publishes as release
  notes in the \"updates available\" prompt and the Updates review.

  Informational only: Penpot's sync (library-change notifications,
  synced-at, the Update button) works exactly as before.

  This ns must not require app.main.data.workspace.libraries (that one
  requires this one)."
  (:require
   [app.common.data :as d]
   [app.common.time :as ct]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.data.persistence :as dwp]
   [app.main.repo :as rp]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def kinds
  [:components :colors :typographies :effect-styles :grid-styles])

(def statuses
  [:added :changed :removed])

;; --- Labels

(defn kind-label
  [kind]
  (case kind
    :components   (tr "zvena.library.components")
    :colors       (tr "zvena.library.colors")
    :typographies (tr "zvena.library.typographies")
    :effect-styles (tr "zvena.styles.effect-styles")
    :grid-styles  (tr "zvena.styles.grid-styles")
    (str kind)))

(defn status-label
  [status]
  (case status
    :added   (tr "zvena.library.status-added")
    :changed (tr "zvena.library.status-changed")
    :removed (tr "zvena.library.status-removed")
    (str status)))

(defn- count-label
  [status n]
  (case status
    :added   (tr "zvena.library.count-added" n)
    :changed (tr "zvena.library.count-changed" n)
    :removed (tr "zvena.library.count-removed" n)
    (str n)))

(defn summary-parts
  "One line per asset kind that changed, e.g. \"Components: 2 new, 1 changed\"."
  [summary]
  (into []
        (keep (fn [kind]
                (let [parts (into []
                                  (keep (fn [status]
                                          (let [n (get-in summary [kind status :count] 0)]
                                            (when (pos? n)
                                              (count-label status n)))))
                                  statuses)]
                  (when (seq parts)
                    (str (kind-label kind) ": " (str/join ", " parts))))))
        kinds))

(defn total-changes
  [summary]
  (or (:total summary)
      (reduce + 0 (for [kind kinds
                        status statuses]
                    (get-in summary [kind status :count] 0)))))

(defn- ellipsize
  [s n]
  (let [s (str/trim (str s))]
    (if (> (count s) n)
      (str (str/trim (subs s 0 (dec n))) "…")
      s)))

(defn note-prompt
  "The text of the \"updates available\" prompt for a release note, or nil."
  [{:keys [library-name profile-name description] :as note}]
  (when (some? note)
    (let [library-name (or library-name "")]
      (if (str/blank? description)
        (tr "zvena.library.updates-published"
            library-name
            (or profile-name (tr "zvena.library.someone")))
        (tr "zvena.library.updates-published-note"
            library-name
            (ellipsize (str/replace description #"\s+" " ") 120))))))

;; --- Release notes (files that use a library)

(defn- ms
  [v]
  (cond
    (nil? v)    nil
    (number? v) v
    (inst? v)   (inst-ms v)
    :else       nil))

(defn later
  "The later of two moments (dates or epoch millis, either may be nil) as a date."
  [a b]
  (let [a (ms a)
        b (ms b)
        m (if (and a b) (max a b) (or a b))]
    (some-> m js/Math.round ct/inst)))

(defn fetch-publishes
  "Observable with the publishes of `library-id` newer than `since`
  (a date, epoch millis or nil), newest first. `file-id` is the file
  that uses it."
  [library-id file-id since limit]
  (rp/cmd! :zvena-get-library-publishes
           (d/without-nils
            {:file-id library-id
             :from-file-id file-id
             :since (later since nil)
             :limit limit})))

;; The "updates available" prompt is recomputed on every library-change
;; message (each save of the library), so its notes are cached for a
;; while; a publish message drops the cache of that library.
(defonce ^:private notes-cache (atom {}))

(def ^:private notes-cache-ttl-ms 60000)

(defn forget-publishes!
  [library-id]
  (swap! notes-cache
         (fn [cache]
           (into {} (remove (fn [[[id] _]] (= id library-id))) cache))))

(defn- cached-publishes
  [library-id file-id since limit]
  (let [key [library-id (ms since) limit]
        now (js/Date.now)
        hit (get @notes-cache key)]
    (if (and (some? hit) (< (- now (:at hit)) notes-cache-ttl-ms))
      (rx/of (:value hit))
      (->> (fetch-publishes library-id file-id since limit)
           (rx/tap (fn [value]
                     (swap! notes-cache assoc key {:at now :value value})))))))

(defn latest-note
  "Observable that emits once: the newest publish (with `:library-name`)
  among `libraries` since each one was last synced (or the updates were
  dismissed), or nil. Never fails; gives up after a few seconds."
  [file-id libraries ignore-until]
  (->> (rx/from (vec libraries))
       (rx/merge-map
        (fn [library]
          (->> (cached-publishes (:id library) file-id
                                 (later (:synced-at library) ignore-until)
                                 1)
               (rx/map (fn [publishes]
                         (some-> (first publishes)
                                 (assoc :library-name (:name library)))))
               (rx/catch (fn [_] (rx/of nil))))))
       (rx/reduce (fn [best note]
                    (if (and (some? note)
                             (or (nil? best)
                                 (> (or (ms (:created-at note)) 0)
                                    (or (ms (:created-at best)) 0))))
                      note
                      best))
                  nil)
       (rx/timeout 4000 (rx/of nil))
       (rx/catch (fn [_] (rx/of nil)))))

;; --- Publishing (the library itself)

(defn- set-publish-state
  [file-id f]
  (ptk/reify ::set-publish-state
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:zvena-library-publish file-id] f))))

(defn- saved
  "Emits once the pending changes are saved (or saving gave up), so the
  server reads what the editor shows."
  []
  (rx/concat
   (rx/ignore (dwp/wait-persisted 20000))
   (rx/of nil)))

(defn fetch-changes
  "Saves pending changes and asks the server what would be published."
  [file-id]
  (ptk/reify ::fetch-changes
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:zvena-library-publish file-id]
                 (fn [current]
                   (-> current
                       (assoc :status :loading)
                       (dissoc :error)))))

    ptk/WatchEvent
    (watch [_ _ _]
      (rx/concat
       (rx/of ::dwp/force-persist)
       (->> (saved)
            (rx/take 1)
            (rx/mapcat (fn [_]
                         (rp/cmd! :zvena-get-library-changes {:file-id file-id})))
            (rx/map (fn [result]
                      (set-publish-state file-id
                                         (fn [current]
                                           (-> current
                                               (assoc :status :loaded :data result)
                                               (dissoc :error))))))
            (rx/catch (fn [cause]
                        (rx/of (set-publish-state file-id
                                                  (fn [current]
                                                    (assoc current
                                                           :status :error
                                                           :error (or (ex-message cause) "error"))))))))))))

(defn publish
  "Saves pending changes and publishes the library with `description`."
  [file-id description]
  (ptk/reify ::publish
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:zvena-library-publish file-id :publishing] true))

    ptk/WatchEvent
    (watch [_ _ _]
      (rx/concat
       (rx/of ::dwp/force-persist)
       (->> (saved)
            (rx/take 1)
            (rx/mapcat (fn [_]
                         (rp/cmd! :zvena-publish-library
                                  {:file-id file-id
                                   :description (str/trim (or description ""))})))
            (rx/mapcat (fn [_]
                         (rx/of (set-publish-state file-id (constantly nil))
                                (modal/hide)
                                (ntf/success (tr "zvena.library.published")))))
            (rx/catch (fn [_]
                        (rx/of (set-publish-state file-id #(assoc % :publishing false))
                               (ntf/error (tr "zvena.library.publish-error"))))))))))
