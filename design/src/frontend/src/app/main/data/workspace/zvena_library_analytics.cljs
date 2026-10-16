;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-library-analytics
  "zvena: Figma's library analytics.

  While a file is open, the inserts of library components (from the
  Assets panel, Quick actions, drag and drop) and the detachments of
  their copies are reported to the backend in small batches, so the
  library's analytics can show them over time. They are read from the
  local commits of those two actions only: undo, redo and changes from
  other people are not counted.

  `fetch-analytics` loads the analytics of a library for the dialog."
  (:require
   [app.common.data :as d]
   [app.main.data.changes :as dch]
   [app.main.repo :as rp]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def ^:private insert-origins
  #{:app.main.data.workspace.libraries/instantiate-component})

(def ^:private detach-origins
  #{:app.main.data.workspace.libraries/detach-component
    :app.main.data.workspace.libraries/detach-selected-components})

(defn- set-ops
  "{attr value} of the :set operations of a :mod-obj change."
  [change]
  (reduce (fn [acc {:keys [type attr val]}]
            (cond-> acc
              (= type :set) (assoc attr val)))
          {}
          (:operations change)))

(defn- insert-events
  [{:keys [redo-changes]}]
  (keep (fn [{:keys [type obj]}]
          (when (and (= type :add-obj)
                     (true? (:component-root obj))
                     (uuid? (:component-file obj))
                     (uuid? (:component-id obj)))
            {:library-id (:component-file obj)
             :component-id (:component-id obj)
             :kind "insert"}))
        redo-changes))

(defn- detach-events
  "The undo changes of a detachment put the component back on the copy's
  root: that is where the library and component come from."
  [{:keys [undo-changes]}]
  (keep (fn [change]
          (when (= :mod-obj (:type change))
            (let [ops (set-ops change)]
              (when (and (true? (get ops :component-root))
                         (uuid? (get ops :component-file))
                         (uuid? (get ops :component-id)))
                {:library-id (get ops :component-file)
                 :component-id (get ops :component-id)
                 :kind "detach"}))))
        undo-changes))

(defn- commit->events
  [file-id commit]
  (when (and (= :local (:source commit))
             (= file-id (:file-id commit)))
    (let [origin (:origin commit)]
      (cond
        (contains? insert-origins origin) (insert-events commit)
        (contains? detach-origins origin) (detach-events commit)
        :else nil))))

(defn initialize
  "Reports the inserts and detachments made in the file `file-id` until
  the workspace closes."
  [file-id]
  (ptk/reify ::initialize
    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (rx/filter (ptk/type? :app.main.data.workspace/finalize-workspace) stream)
            events  (->> stream
                         (rx/filter dch/commit?)
                         (rx/map deref)
                         (rx/mapcat #(rx/from (vec (commit->events file-id %))))
                         (rx/take-until stopper)
                         (rx/share))]
        (->> events
             (rx/buffer-until (rx/debounce 3000 events))
             (rx/filter seq)
             (rx/mapcat
              (fn [batch]
                (->> (rp/cmd! :zvena-track-library-events
                              {:file-id file-id
                               :events (vec (take 200 batch))})
                     (rx/catch (fn [_] (rx/empty)))
                     (rx/ignore)))))))))

;; --- Analytics of a library

(defn fetch-analytics
  "Loads the analytics of the library `library-id` into
  [:zvena-library-analytics library-id]; `from-file-id` is the open file
  when it uses that library."
  [library-id from-file-id]
  (ptk/reify ::fetch-analytics
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:zvena-library-analytics library-id]
                 (fn [prev] (assoc prev :status :loading))))

    ptk/WatchEvent
    (watch [_ _ _]
      (->> (rp/cmd! :zvena-get-library-analytics
                    (d/without-nils {:file-id library-id
                                     :from-file-id (when (not= from-file-id library-id)
                                                     from-file-id)}))
           (rx/map (fn [data]
                     (fn [state]
                       (assoc-in state [:zvena-library-analytics library-id]
                                 {:status :loaded :data data}))))
           (rx/catch (fn [_]
                       (rx/of (fn [state]
                                (assoc-in state [:zvena-library-analytics library-id :status]
                                          :error)))))))))
