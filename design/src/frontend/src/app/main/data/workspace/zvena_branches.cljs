;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-branches
  "zvena: Figma's branching and merging, the editor side. The backend
  (app.zvena.branches) copies a file into a branch, compares base, main
  and branch, and merges.

  Branch information of a file lives in the state under
  [:zvena-branches file-id] ({:status :data}); the review of a branch
  (changes and conflicts) under :zvena-branch-review. Pending edits are
  always saved before the server reads a file."
  (:require
   [app.common.data :as d]
   [app.main.data.helpers :as dsh]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.data.persistence :as dwp]
   [app.main.data.workspace :as-alias dw]
   [app.main.repo :as rp]
   [app.main.router :as rt]
   [app.util.i18n :as i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

;; --- Labels

;; English texts (Figma's wording) used while a key is still missing from
;; the translation catalogs. A vector is [singular plural].
(def ^:private english
  {"zvena.branches.create-branch-ellipsis" "Create branch…"
   "zvena.branches.create-branch" "Create branch"
   "zvena.branches.branch-name" "Branch name"
   "zvena.branches.branch-name-placeholder" "Name your branch"
   "zvena.branches.create-hint" "A branch is a copy of this file where you can explore changes and merge them back into the main file later."
   "zvena.branches.create" "Create"
   "zvena.branches.creating" "Creating…"
   "zvena.branches.created" "Branch created"
   "zvena.branches.create-error" "Couldn't create the branch"
   "zvena.branches.view-branches" "View branches"
   "zvena.branches.branches" "Branches"
   "zvena.branches.active" "Active"
   "zvena.branches.archived" "Archived"
   "zvena.branches.merged" "Merged"
   "zvena.branches.main-file" "Main file"
   "zvena.branches.main" "Main"
   "zvena.branches.branch" "Branch"
   "zvena.branches.open" "Open"
   "zvena.branches.current" "Current"
   "zvena.branches.archive" "Archive"
   "zvena.branches.archive-branch" "Archive branch"
   "zvena.branches.archive-confirm" "Archive this branch? It won't be merged. You can restore it later from the archived branches."
   "zvena.branches.archived-toast" "Branch archived"
   "zvena.branches.restore" "Restore"
   "zvena.branches.restored-toast" "Branch restored"
   "zvena.branches.action-error" "Something went wrong. Try again."
   "zvena.branches.no-branches" "No branches yet"
   "zvena.branches.no-archived" "No archived branches"
   "zvena.branches.created-by" "Created by %s · %s"
   "zvena.branches.merged-by" "Merged by %s · %s"
   "zvena.branches.someone" "Someone"
   "zvena.branches.review-and-merge" "Review and merge"
   "zvena.branches.update-from-main" "Update from main"
   "zvena.branches.main-has-changes" "Main file has changes"
   "zvena.branches.review-and-update" "Review and update"
   "zvena.branches.merge-into" "%s into %s"
   "zvena.branches.changes" "Changes"
   "zvena.branches.changes-from-main" "Changes from main"
   "zvena.branches.resolve-conflicts" "Resolve conflicts"
   "zvena.branches.conflicts-hint" "These were changed in the main file and in this branch. Choose which version to keep."
   "zvena.branches.keep-all-main" "Keep all from main"
   "zvena.branches.keep-all-branch" "Keep all from branch"
   "zvena.branches.main-changes-kept" ["The main file has %s change since this branch was created. It will be kept."
                                       "The main file has %s changes since this branch was created. They will be kept."]
   "zvena.branches.no-changes" "No changes to merge"
   "zvena.branches.no-updates" "Main has no new changes"
   "zvena.branches.loading" "Loading changes…"
   "zvena.branches.load-error" "Couldn't load the changes"
   "zvena.branches.retry" "Retry"
   "zvena.branches.merge-branch" "Merge branch"
   "zvena.branches.merging" "Merging…"
   "zvena.branches.merged-toast" "Branch merged"
   "zvena.branches.merge-error" "Couldn't merge the branch"
   "zvena.branches.update" "Update"
   "zvena.branches.updating" "Updating…"
   "zvena.branches.updated-toast" "Branch updated from main"
   "zvena.branches.update-error" "Couldn't update the branch"
   "zvena.branches.conflicts-changed" "The main file changed. Review the conflicts again."
   "zvena.branches.base-missing" "The version this branch was created from is no longer available."
   "zvena.branches.status-added" "Added"
   "zvena.branches.status-changed" "Edited"
   "zvena.branches.status-removed" "Removed"
   "zvena.branches.kind-page" "Page"
   "zvena.branches.kind-page-props" "Page settings"
   "zvena.branches.kind-component" "Component"
   "zvena.branches.kind-color" "Color style"
   "zvena.branches.kind-typography" "Text style"
   "zvena.branches.kind-media" "Image"
   "zvena.branches.kind-tokens" "Design tokens"
   "zvena.branches.kind-data" "File settings"
   "zvena.branches.in-main" "Main: %s"
   "zvena.branches.in-branch" "Branch: %s"
   "zvena.branches.and-more" "and %s more"
   "zvena.branches.count" ["%s branch" "%s branches"]
   "zvena.branches.archived-banner" "This branch is archived"
   "zvena.branches.merged-banner" "This branch was merged"})

(defn t
  "`tr`, with the English text when the key is not translated yet."
  [code & args]
  (let [value (apply tr code args)]
    (if (not= value code)
      value
      (let [text   (get english code code)
            plural (d/seek i18n/c? args)
            text   (if (vector? text)
                     (if (= 1 (some-> plural deref)) (first text) (second text))
                     text)]
        (if (seq args)
          (apply str/fmt text (map #(if (i18n/c? %) (deref %) %) args))
          text)))))

(defn status-label
  [status]
  (case status
    :added   (t "zvena.branches.status-added")
    :changed (t "zvena.branches.status-changed")
    :removed (t "zvena.branches.status-removed")
    nil))

(defn kind-label
  [kind]
  (case kind
    :page       (t "zvena.branches.kind-page")
    :page-props (t "zvena.branches.kind-page-props")
    :component  (t "zvena.branches.kind-component")
    :color      (t "zvena.branches.kind-color")
    :typography (t "zvena.branches.kind-typography")
    :media      (t "zvena.branches.kind-media")
    :tokens     (t "zvena.branches.kind-tokens")
    :data       (t "zvena.branches.kind-data")
    nil))

;; --- Helpers

(defn- saved
  "Emits once when pending changes are saved; errors when they can't be."
  []
  (->> (rx/concat
        (rx/ignore (dwp/wait-persisted-or-error 60000))
        (rx/of nil))
       (rx/take 1)))

(defn- error-code
  [cause]
  (:code (ex-data cause)))

(defn- nav-to-file
  [team-id file-id]
  (rt/nav :workspace {:team-id team-id :file-id file-id}))

;; --- Branch information

(defn- set-info
  [file-id f]
  (ptk/reify ::set-info
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:zvena-branches file-id] f))))

(defn fetch-info
  "Loads the branch information of `file-id` (is it a branch, its main
  file, the branches of main)."
  [file-id]
  (ptk/reify ::fetch-info
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:zvena-branches file-id]
                 (fn [current]
                   (assoc current :status (if (some? (:data current)) :loaded :loading)))))

    ptk/WatchEvent
    (watch [_ _ _]
      (->> (rp/cmd! :zvena-get-branches {:file-id file-id})
           (rx/map (fn [data]
                     (set-info file-id (constantly {:status :loaded :data data}))))
           (rx/catch (fn [_]
                       (rx/of (set-info file-id #(assoc % :status :error)))))))))

;; --- Create

(defn create-branch
  "Saves pending changes, creates the branch and opens it."
  [file-id branch-name & {:keys [on-error]}]
  (ptk/reify ::create-branch
    ptk/WatchEvent
    (watch [_ state _]
      (let [team-id (:current-team-id state)]
        (rx/concat
         (rx/of ::dwp/force-persist)
         (->> (saved)
              (rx/mapcat (fn [_]
                           (rp/cmd! :zvena-create-branch
                                    {:file-id file-id
                                     :name (str/trim (str branch-name))})))
              (rx/mapcat (fn [result]
                           (rx/of (modal/hide)
                                  (fetch-info file-id)
                                  (ntf/success (t "zvena.branches.created"))
                                  (nav-to-file (or (:team-id result) team-id)
                                               (:branch-file-id result)))))
              (rx/catch (fn [_]
                          (when (fn? on-error) (on-error))
                          (rx/of (ntf/error (t "zvena.branches.create-error")))))))))))

;; --- Review (changes and conflicts)

(defn- set-review
  [f]
  (ptk/reify ::set-review
    ptk/UpdateEvent
    (update [_ state]
      (update state :zvena-branch-review f))))

(defn fetch-review
  "Saves pending changes and loads what merging `branch-id` would do."
  [branch-id]
  (ptk/reify ::fetch-review
    ptk/UpdateEvent
    (update [_ state]
      (assoc state :zvena-branch-review {:branch-id branch-id :status :loading}))

    ptk/WatchEvent
    (watch [_ _ _]
      (rx/concat
       (rx/of ::dwp/force-persist)
       (->> (rx/concat
             (rx/ignore (dwp/wait-persisted 30000))
             (rx/of nil))
            (rx/take 1)
            (rx/mapcat (fn [_]
                         (rp/cmd! :zvena-get-branch-diff {:branch-id branch-id})))
            (rx/map (fn [data]
                      (set-review (fn [current]
                                    (if (= branch-id (:branch-id current))
                                      {:branch-id branch-id :status :loaded :data data}
                                      current)))))
            (rx/catch (fn [cause]
                        (rx/of (set-review (fn [current]
                                             (if (= branch-id (:branch-id current))
                                               (assoc current
                                                      :status :error
                                                      :code (error-code cause))
                                               current)))))))))))

(defn clear-review
  []
  (ptk/reify ::clear-review
    ptk/UpdateEvent
    (update [_ state]
      (dissoc state :zvena-branch-review))))

(defn- resolutions
  [choices]
  (into []
        (keep (fn [[k side]]
                (when (contains? #{:main :branch} side)
                  {:key k :keep (name side)})))
        choices))

(defn- conflicts-changed
  "The conflicts changed while reviewing: reload the review."
  [branch-id]
  (rx/of (ntf/warn (t "zvena.branches.conflicts-changed"))
         (fetch-review branch-id)))

;; --- Merge

(defn merge-branch
  "Saves pending changes and merges the branch into main with the chosen
  version of every conflict ({key :main|:branch}), then opens main."
  [branch-id choices & {:keys [on-error]}]
  (ptk/reify ::merge-branch
    ptk/WatchEvent
    (watch [_ state _]
      (let [team-id (:current-team-id state)]
        (rx/concat
         (rx/of ::dwp/force-persist)
         (->> (saved)
              (rx/mapcat (fn [_]
                           (rp/cmd! :zvena-merge-branch
                                    {:branch-id branch-id
                                     :resolutions (resolutions choices)})))
              (rx/mapcat (fn [result]
                           (rx/of (modal/hide)
                                  (clear-review)
                                  (ntf/success (t "zvena.branches.merged-toast"))
                                  (fetch-info (:main-file-id result))
                                  (nav-to-file team-id (:main-file-id result)))))
              (rx/catch (fn [cause]
                          (when (fn? on-error) (on-error))
                          (case (error-code cause)
                            :unresolved-conflicts
                            (conflicts-changed branch-id)

                            :branch-base-missing
                            (rx/of (ntf/error (t "zvena.branches.base-missing")))

                            (rx/of (ntf/error (t "zvena.branches.merge-error"))))))))))))

;; --- Update from main

(defn- reload-if-stale
  "Reloads `file-id` unless the :file-restored message did it already."
  [file-id vern]
  (ptk/reify ::reload-if-stale
    ptk/WatchEvent
    (watch [_ _ stream]
      (->> (rx/timer 1500)
           (rx/take-until (rx/filter (ptk/type? ::dw/reload-current-file) stream))
           (rx/mapcat (fn [_]
                        (rx/of (ptk/reify ::reload-check
                                 ptk/WatchEvent
                                 (watch [_ state _]
                                   (let [current (dsh/lookup-file state file-id)]
                                     (if (and (= file-id (:current-file-id state))
                                              (= vern (:vern current)))
                                       (rx/of (ptk/event ::dw/reload-current-file))
                                       (rx/empty))))))))))))

(defn update-from-main
  "Saves pending changes and brings main's changes into the branch with
  the chosen version of every conflict. The branch reloads."
  [branch-id file-id choices & {:keys [on-error]}]
  (ptk/reify ::update-from-main
    ptk/WatchEvent
    (watch [_ state _]
      (let [vern (:vern (dsh/lookup-file state file-id))]
        (rx/concat
         (rx/of ::dwp/force-persist)
         (->> (saved)
              (rx/mapcat (fn [_]
                           (rp/cmd! :zvena-update-branch-from-main
                                    {:branch-id branch-id
                                     :resolutions (resolutions choices)})))
              (rx/mapcat (fn [_]
                           (rx/of (modal/hide)
                                  (clear-review)
                                  (ntf/success (t "zvena.branches.updated-toast"))
                                  (fetch-info file-id)
                                  (reload-if-stale file-id vern))))
              (rx/catch (fn [cause]
                          (when (fn? on-error) (on-error))
                          (case (error-code cause)
                            :unresolved-conflicts
                            (conflicts-changed branch-id)

                            :branch-base-missing
                            (rx/of (ntf/error (t "zvena.branches.base-missing")))

                            (rx/of (ntf/error (t "zvena.branches.update-error"))))))))))))

;; --- Archive, restore, open

(defn archive-branch
  "Archives the branch. When it is the open file, main opens instead."
  [{:keys [id main-file-id branch-file-id]} & {:keys [on-done]}]
  (ptk/reify ::archive-branch
    ptk/WatchEvent
    (watch [_ state _]
      (let [team-id (:current-team-id state)
            current (:current-file-id state)]
        (->> (rp/cmd! :zvena-archive-branch {:branch-id id})
             (rx/mapcat (fn [_]
                          (when (fn? on-done) (on-done))
                          (rx/concat
                           (rx/of (ntf/success (t "zvena.branches.archived-toast"))
                                  (fetch-info main-file-id))
                           (if (and (some? branch-file-id) (= current branch-file-id))
                             (rx/of (modal/hide)
                                    (nav-to-file team-id main-file-id))
                             (rx/of (fetch-info current))))))
             (rx/catch (fn [_]
                         (when (fn? on-done) (on-done))
                         (rx/of (ntf/error (t "zvena.branches.action-error"))))))))))

(defn restore-branch
  [{:keys [id main-file-id]} & {:keys [on-done]}]
  (ptk/reify ::restore-branch
    ptk/WatchEvent
    (watch [_ state _]
      (let [current (:current-file-id state)]
        (->> (rp/cmd! :zvena-restore-branch {:branch-id id})
             (rx/mapcat (fn [_]
                          (when (fn? on-done) (on-done))
                          (rx/of (ntf/success (t "zvena.branches.restored-toast"))
                                 (fetch-info main-file-id)
                                 (fetch-info current))))
             (rx/catch (fn [cause]
                         (when (fn? on-done) (on-done))
                         (rx/of (ntf/error (if (= :branch-base-missing (error-code cause))
                                             (t "zvena.branches.base-missing")
                                             (t "zvena.branches.action-error")))))))))))

(defn open-file
  "Opens another file (main or a branch) in this tab."
  [file-id]
  (ptk/reify ::open-file
    ptk/WatchEvent
    (watch [_ state _]
      (rx/of (modal/hide)
             (nav-to-file (:current-team-id state) file-id)))))
