;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.library-analytics
  "zvena: Figma's library analytics.

  For a library, how its components, colors and typographies are used:
  instances (counted now, in every file that uses the library and in the
  library itself), plus inserts and detachments over the last weeks.

  Instances are counted from the persisted files (read-only, never
  written from here). Inserts and detachments are events the editors
  report as they happen (`zvena-track-library-events`, table
  `library_event` of migration zvena-0005); a report is accepted only
  from someone who can edit the file it happened in, and only for that
  file's own components or those of its libraries.

  Names of the files that use the library are only shown when the
  person can read them; the others are counted."
  (:require
   [app.binfile.common :as bfc]
   [app.common.exceptions :as ex]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.common.types.text :as txt]
   [app.common.time :as ct]
   [app.common.types.components-list :as ctkl]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.db :as db]
   [app.features.fdata :as feat.fdata]
   [app.loggers.audit :as-alias audit]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.files :as files]
   [app.rpc.doc :as-alias doc]
   [app.util.pointer-map :as pmap]
   [app.util.services :as sv]
   [cuerdas.core :as str]))

;; Files scanned for instance counts, at most.
(def ^:private max-files 200)

;; Days of insert / detach history returned.
(def ^:private period-days 30)

(def ^:private max-events 200)

;; --- Usage of the library in one file

(defn- text-typography-refs
  "{typography-id uses} of the text nodes of `shape` that use a
  typography of `library-id`."
  [shape library-id]
  (if (and (= :text (:type shape)) (some? (:content shape)))
    (reduce (fn [acc node]
              (if (and (= library-id (:typography-ref-file node))
                       (uuid? (:typography-ref-id node)))
                (update acc (:typography-ref-id node) (fnil inc 0))
                acc))
            {}
            (txt/node-seq (:content shape)))
    {}))

(defn- shape-color-refs
  "The ids of the colors of `library-id` used by `shape`."
  [shape library-id]
  (into #{}
        (keep (fn [color]
                (when (and (= library-id (:ref-file color))
                           (uuid? (:ref-id color)))
                  (:ref-id color))))
        (cts/get-all-colors shape)))

(defn- empty-usage
  []
  {:instances {} :colors {} :typographies {}})

(defn- add-shape-usage
  [usage shape library-id]
  (let [usage (if (and (= library-id (:component-file shape))
                       (uuid? (:component-id shape))
                       ;; copies only: a main is the component itself
                       (not (true? (:main-instance shape))))
                (update-in usage [:instances (:component-id shape)] (fnil inc 0))
                usage)
        usage (reduce (fn [usage color-id]
                        (update-in usage [:colors color-id] (fnil inc 0)))
                      usage
                      (shape-color-refs shape library-id))]
    (reduce-kv (fn [usage typography-id n]
                 (update-in usage [:typographies typography-id] (fnil + 0) n))
               usage
               (text-typography-refs shape library-id))))

(defn- file-usage
  "How the file `file-id` uses `library-id`; nil when it can't be read."
  [cfg file-id library-id]
  (try
    (let [file (bfc/get-file cfg file-id :read-only? true)]
      (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
        (let [data (:data file)]
          (reduce (fn [usage page-id]
                    (let [objects (get-in data [:pages-index page-id :objects])]
                      (reduce (fn [usage shape]
                                (add-shape-usage usage shape library-id))
                              usage
                              (vals objects))))
                  (empty-usage)
                  (:pages data)))))
    (catch Throwable cause
      (l/wrn :hint "library analytics: file not readable"
             :file-id (str file-id)
             :reason (ex-message cause))
      nil)))

(defn- merge-usage
  [a b]
  {:instances    (merge-with + (:instances a) (:instances b))
   :colors       (merge-with + (:colors a) (:colors b))
   :typographies (merge-with + (:typographies a) (:typographies b))})

;; --- Library assets

(defn- full-name
  [{:keys [name path]}]
  (let [name (str name)
        path (some-> path str str/trim)]
    (if (str/blank? path)
      name
      (str path " / " name))))

(defn- library-assets
  [cfg file-id]
  (let [file (bfc/get-file cfg file-id :read-only? true)]
    (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
      (let [data (:data file)]
        {:file         (select-keys file [:id :name :is-shared :team-id :project-id])
         :components   (->> (ctkl/components-seq data)
                            (remove :deleted)
                            (mapv (fn [c]
                                    {:id (:id c)
                                     :name (full-name c)
                                     :main-instance-id (:main-instance-id c)
                                     :main-instance-page (:main-instance-page c)})))
         :colors       (mapv (fn [c] {:id (:id c) :name (full-name c) :color (:color c)})
                             (vals (:colors data)))
         :typographies (mapv (fn [t] {:id (:id t) :name (full-name t)})
                             (vals (:typographies data)))}))))

;; --- Files using the library

(def ^:private sql:using-files
  "SELECT f.id, f.name, f.project_id, p.team_id, f.modified_at
     FROM file_library_rel AS flr
     JOIN file AS f ON (f.id = flr.file_id)
     JOIN project AS p ON (p.id = f.project_id)
    WHERE flr.library_file_id = ?
      AND (f.deleted_at IS NULL OR f.deleted_at > now())
    ORDER BY f.modified_at DESC
    LIMIT ?")

(def ^:private sql:count-using-files
  "SELECT count(*) AS total
     FROM file_library_rel AS flr
     JOIN file AS f ON (f.id = flr.file_id)
    WHERE flr.library_file_id = ?
      AND (f.deleted_at IS NULL OR f.deleted_at > now())")

;; --- Events

(def ^:private sql:event-totals
  "SELECT component_id, kind, count(*) AS total
     FROM library_event
    WHERE library_file_id = ?
      AND created_at > now() - (? || ' days')::interval
    GROUP BY component_id, kind")

(def ^:private sql:event-timeline
  "SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          kind, count(*) AS total
     FROM library_event
    WHERE library_file_id = ?
      AND created_at > now() - (? || ' days')::interval
    GROUP BY 1, 2
    ORDER BY 1")

(defn- event-totals
  "{component-id {:inserts n :detaches n}}"
  [cfg library-id]
  (reduce (fn [acc {:keys [component-id kind total]}]
            (let [k (case kind "insert" :inserts "detach" :detaches nil)]
              (if (and k (uuid? component-id))
                (assoc-in acc [component-id k] (long total))
                acc)))
          {}
          (db/exec! cfg [sql:event-totals library-id (str period-days)])))

(defn- event-timeline
  [cfg library-id]
  (let [rows   (db/exec! cfg [sql:event-timeline library-id (str period-days)])
        by-day (reduce (fn [acc {:keys [day kind total]}]
                         (let [k (case kind "insert" :inserts "detach" :detaches nil)]
                           (cond-> acc
                             (some? k) (assoc-in [day k] (long total)))))
                       {}
                       rows)
        today  (java.time.LocalDate/now java.time.ZoneOffset/UTC)]
    (vec (for [i (range (dec period-days) -1 -1)
               :let [day (str (.minusDays today (long i)))]]
           {:day day
            :inserts (get-in by-day [day :inserts] 0)
            :detaches (get-in by-day [day :detaches] 0)}))))

(defn- check-analytics-read!
  "The library, or a file that uses it, can be read by the profile."
  [cfg profile-id file-id from-file-id]
  (when-not (or (files/has-read-permissions? cfg profile-id file-id)
                (and (some? from-file-id)
                     (files/has-read-permissions? cfg profile-id from-file-id)
                     (contains? (bfc/get-libraries cfg [from-file-id]) file-id)))
    (ex/raise :type :not-found
              :code :object-not-found
              :hint "not found")))

;; --- COMMAND QUERY: zvena-get-library-analytics

(def ^:private schema:get-library-analytics
  [:map {:title "zvena-get-library-analytics"}
   [:file-id ::sm/uuid]
   [:from-file-id {:optional true} [:maybe ::sm/uuid]]])

(sv/defmethod ::zvena-get-library-analytics
  "Usage of a library: instances of each component, uses of each color
  and typography, the files that use it, and inserts / detachments of
  its components over the last 30 days."
  {::doc/added "2.18"
   ::audit/skip true
   ::sm/params schema:get-library-analytics}
  [cfg {:keys [::rpc/profile-id file-id from-file-id]}]
  (check-analytics-read! cfg profile-id file-id from-file-id)
  (let [assets   (library-assets cfg file-id)
        total    (or (:total (db/exec-one! cfg [sql:count-using-files file-id])) 0)
        using    (db/exec! cfg [sql:using-files file-id max-files])
        ;; the library itself counts too (copies of its own components)
        scanned  (into [(:file assets)] using)
        per-file (into []
                       (keep (fn [{:keys [id] :as file}]
                               (when-let [usage (file-usage cfg id file-id)]
                                 (assoc file :usage usage))))
                       scanned)
        usage    (reduce merge-usage (empty-usage) (map :usage per-file))
        files-of (fn [kind id]
                   (count (filter #(pos? (get-in % [:usage kind id] 0)) per-file)))
        events   (event-totals cfg file-id)
        visible  (->> per-file
                      (filter #(or (= (:id %) file-id)
                                   (files/has-read-permissions? cfg profile-id (:id %))))
                      (mapv (fn [{:keys [id name project-id team-id usage]}]
                              {:id id
                               :name name
                               :project-id project-id
                               :team-id team-id
                               :library? (= id file-id)
                               :instances (reduce + 0 (vals (:instances usage)))})))]
    {:file-id      file-id
     :name         (get-in assets [:file :name])
     :period-days  period-days
     :files-total  (inc (long total))
     :files-scanned (count per-file)
     :files        visible
     :components   (mapv (fn [{:keys [id] :as c}]
                           (assoc c
                                  :instances (get-in usage [:instances id] 0)
                                  :files (files-of :instances id)
                                  :inserts (get-in events [id :inserts] 0)
                                  :detaches (get-in events [id :detaches] 0)))
                         (:components assets))
     :colors       (mapv (fn [{:keys [id] :as c}]
                           (assoc c
                                  :uses (get-in usage [:colors id] 0)
                                  :files (files-of :colors id)))
                         (:colors assets))
     :typographies (mapv (fn [{:keys [id] :as t}]
                           (assoc t
                                  :uses (get-in usage [:typographies id] 0)
                                  :files (files-of :typographies id)))
                         (:typographies assets))
     :timeline     (event-timeline cfg file-id)}))

;; --- COMMAND: zvena-track-library-events

(def ^:private schema:event
  [:map
   [:library-id ::sm/uuid]
   [:component-id ::sm/uuid]
   [:kind [:enum "insert" "detach"]]])

(def ^:private schema:track-library-events
  [:map {:title "zvena-track-library-events"}
   [:file-id ::sm/uuid]
   [:events [:vector {:max max-events} schema:event]]])

(sv/defmethod ::zvena-track-library-events
  "Records component inserts and detachments that happened in a file, for
  the analytics of the libraries they come from. Editors of the file only;
  events about libraries the file does not use are dropped."
  {::doc/added "2.18"
   ::audit/skip true
   ::sm/params schema:track-library-events
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id file-id events]}]
  (files/check-edition-permissions! conn profile-id file-id)
  (let [allowed (conj (bfc/get-libraries cfg [file-id]) file-id)
        now     (ct/now)
        rows    (->> events
                     (filter #(contains? allowed (:library-id %)))
                     (take max-events)
                     (mapv (fn [{:keys [library-id component-id kind]}]
                             [(uuid/next) library-id file-id component-id kind profile-id now])))]
    (when (seq rows)
      (db/insert-many! conn :library-event
                       [:id :library-file-id :file-id :component-id :kind :profile-id :created-at]
                       rows))
    {:recorded (count rows)}))
