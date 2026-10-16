;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.data.workspace.tokens.propagation
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.logging :as l]
   [app.common.time :as ct]
   [app.common.types.token :as ctt]
   [app.common.types.tokens-lib :as ctob]
   [app.config :as cf]
   [app.main.data.helpers :as dsh]
   [app.main.data.style-dictionary :as sd]
   [app.main.data.tokenscript :as ts]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.data.workspace.thumbnails :as dwt]
   [app.main.data.workspace.tokens.application :as dwta]
   [app.main.data.workspace.tokens.zvena-modes :as zvm] ;; zvena: variable modes per layer
   [app.main.data.workspace.undo :as dwu]
   [beicon.v2.core :as rx]
   [clojure.data :as data]
   [clojure.set :as set]
   [potok.v2.core :as ptk]))

;; Change this to :info :debug or :trace to debug this module, or :warn to reset to default
(l/set-level! :warn)

;; Helpers ---------------------------------------------------------------------

;; TODO: see if this can be replaced by more standard functions
(defn deep-merge
  "Like d/deep-merge but unions set values."
  ([a b]
   (cond
     (map? a) (merge-with deep-merge a b)
     (set? a) (set/union a b)
     :else b))
  ([a b & rest]
   (reduce deep-merge a (cons b rest))))

(defn- flatten-set-keyed-map
  "Flattens a map where the keys are sets of keywords."
  [m into-m]
  (reduce
   (fn [acc [ks action]]
     (into acc (map (fn [k] [k action]) ks)))
   into-m m))

;; Constants -------------------------------------------------------------------

(def ^:private filter-existing-values? false)

(def ^:private attributes->shape-update dwta/attributes->shape-update)

(def ^:private attribute-actions-map
  (flatten-set-keyed-map attributes->shape-update {}))

;; Data flows ------------------------------------------------------------------

(defn- invert-collect-key-vals
  [xs resolved-tokens shape]
  (-> (reduce
       (fn [acc [k v]]
         (let [resolved-token (get resolved-tokens v)
               resolved-value (get resolved-token :resolved-value)
               skip? (or
                      (not (get resolved-tokens v))
                      (and filter-existing-values? (= (get shape k) resolved-value)))]
           (if skip?
             acc
             (update acc resolved-value (fnil conj #{}) k))))
       {} xs)))

(defn- split-attribute-groups [attrs-values-map]
  (reduce
   (fn [acc [attrs v]]
     (cond
       (some attrs #{:width :height}) (let [[_ a b] (data/diff #{:width :height} attrs)]
                                        (cond-> (assoc acc b v)
                                          ;; Exact match in attrs
                                          a (assoc a v)))
       (some attrs ctt/spacing-keys) (let [[_ rst gap] (data/diff #{:row-gap :column-gap} attrs)
                                           [_ position padding] (data/diff #{:p1 :p2 :p3 :p4} rst)]
                                       (cond-> acc
                                         (seq gap) (assoc gap v)
                                         (seq position) (assoc position v)
                                         (seq padding) (assoc padding v)))
       attrs (assoc acc attrs v)))
   {} attrs-values-map))

(defn- shape-ids-by-values
  [attrs-values-map object-id]
  (->> (map (fn [[value attrs]] [attrs {value #{object-id}}]) attrs-values-map)
       (into {})))

(defn- collect-shapes-update-info
  ;; zvena: `items` ([id shape] pairs, all of `objects` by default) are the
  ;; shapes to collect; `objects` stays the whole page (root frame lookup).
  ([resolved-tokens objects]
   (collect-shapes-update-info resolved-tokens objects (seq objects)))
  ([resolved-tokens objects items]
  (loop [items (seq items)
         frame-ids #{}
         text-ids []
         tokens {}]
    (if-let [[shape-id {:keys [applied-tokens] :as shape}] (first items)]
      (let [applied-tokens
            (-> (invert-collect-key-vals applied-tokens resolved-tokens shape)
                (shape-ids-by-values shape-id)
                (split-attribute-groups))

            parent-frame-id
            (cfh/get-shape-id-root-frame objects shape-id)]

        (recur (rest items)
               (if parent-frame-id
                 (conj frame-ids parent-frame-id)
                 frame-ids)
               (if (cfh/text-shape? shape)
                 (conj text-ids shape-id)
                 text-ids)
               (deep-merge tokens applied-tokens)))

      [tokens frame-ids text-ids]))))

;; zvena: variable modes per layer ---------------------------------------------

(defn- zvena-collect-shapes-update-info
  "zvena: like collect-shapes-update-info, but every shape listed in
  `mode-index` ({shape-id mode-key}, see app.main.data.workspace.tokens.zvena-modes)
  is resolved with the tokens of its mode (`mode-tokens`, {mode-key resolved-tokens}).
  With an empty index it is exactly collect-shapes-update-info."
  [resolved-tokens objects items mode-index mode-tokens]
  (if (empty? mode-index)
    (collect-shapes-update-info resolved-tokens objects items)
    (reduce (fn [[tokens frame-ids text-ids] [mode-key mode-items]]
              (let [resolved (or (when (some? mode-key)
                                   (get mode-tokens mode-key))
                                 resolved-tokens)
                    [tokens' frame-ids' text-ids']
                    (collect-shapes-update-info resolved objects mode-items)]
                [(deep-merge tokens tokens')
                 (into frame-ids frame-ids')
                 (into text-ids text-ids')]))
            [{} #{} []]
            (group-by (fn [[id _]] (get mode-index id)) items))))

(defn- actionize-shapes-update-info [page-id shapes-update-info]
  (mapcat (fn [[attrs update-infos]]
            (let [action (some attribute-actions-map attrs)]
              (assert (fn? action) "missing action function on attributes->shape-update")
              (map
               (fn [[v shape-ids]]
                 (action v shape-ids attrs page-id))
               update-infos)))
          shapes-update-info))

(defn propagate-tokens
  "Propagate tokens values to all shapes where they are applied"
  ;; zvena: `opts` (all optional) for the variable modes per layer:
  ;;   :mode-indexes {page-id {shape-id mode-key}}, :mode-tokens {mode-key resolved-tokens},
  ;;   :scope {:page-id :ids} to only propagate those layers and their children.
  ([state resolved-tokens]
   (propagate-tokens state resolved-tokens nil))
  ([state resolved-tokens {:keys [mode-indexes mode-tokens scope]}]
  (let [file-id         (get state :current-file-id)
        current-page-id (get state :current-page-id)
        fdata           (dsh/lookup-file-data state file-id)
        tpoint          (ct/tpoint-ms)]

    (l/inf :status "START" :hint "propagate-tokens")
    (->> (rx/concat
          (rx/of current-page-id)
          (->> (rx/from (:pages fdata))
               (rx/filter (fn [id] (not= id current-page-id)))))
         ;; zvena: a scoped propagation only touches its page
         (rx/filter (fn [page-id] (or (nil? scope) (= page-id (:page-id scope)))))
         (rx/mapcat
          (fn [page-id]
            (let [page
                  (dsh/get-page fdata page-id)

                  ;; zvena: each shape in its variable mode; only the scope's layers when scoped
                  objects
                  (:objects page)

                  items
                  (if (some? scope)
                    (keep (fn [id] (when-let [shape (get objects id)] [id shape]))
                          (zvm/subtree-ids objects (:ids scope)))
                    (seq objects))

                  [attrs frame-ids text-ids]
                  (zvena-collect-shapes-update-info resolved-tokens objects items
                                                    (get mode-indexes page-id) mode-tokens)

                  actions
                  (actionize-shapes-update-info page-id attrs)

                  ;; Composed updates return observables and need to be executed differently
                  {:keys [observable normal]} (group-by #(if (rx/observable? %) :observable :normal) actions)]

              (l/inf :status "PROGRESS"
                     :hint "propagate-tokens"
                     :page-id (str page-id)
                     :elapsed (tpoint)
                     ::l/sync? true)

              (rx/merge
               (when (seq observable) (apply rx/merge observable))
               (when (seq normal) (rx/concat-all (rx/of normal)))

               (->> (rx/from frame-ids)
                    (rx/mapcat (fn [frame-id]
                                 (rx/of (dwt/clear-thumbnail file-id page-id frame-id "frame")
                                        (dwt/clear-thumbnail file-id page-id frame-id "component")))))
               (when (not= page-id current-page-id)   ;; Texts in the current page have already their position-data regenerated
                 (rx/of (dwsh/update-shapes text-ids  ;; after change. But those on other pages need to be specifically reset.
                                            (fn [shape]
                                              (dissoc shape :position-data))
                                            {:page-id page-id
                                             :ignore-touched true})))))))
         (rx/finalize
          (fn [_]
            (let [elapsed (tpoint)]
              (l/inf :status "END" :hint "propagate-tokens" :elapsed elapsed))))))))

(defn- zvena-propagate
  "zvena: the body of propagate-workspace-tokens (moved here unchanged), plus
  every shape resolved in its variable mode (overrides per layer, see
  app.main.data.workspace.tokens.zvena-modes). `scope` is nil for the whole
  file or {:page-id :ids} for some layers and their children. `on-start`
  events are emitted right after the undo transaction opens."
  [state scope on-start]
  (let [fdata      (dsh/lookup-file-data state)
        tokens-lib (get fdata :tokens-lib)]
    (when-let [tokens-tree (some-> tokens-lib
                                   (ctob/get-tokens-in-active-sets))]
      (let [mode-indexes (zvm/file-mode-indexes tokens-lib fdata scope)
            mode-keys    (into #{} (mapcat vals) (vals mode-indexes))]
        (->> (if (contains? cf/flags :tokenscript)
               (rx/of (-> (ts/resolve-tokens tokens-tree)
                          (d/update-vals #(update % :resolved-value ts/tokenscript-symbols->penpot-unit))))
               (sd/resolve-tokens tokens-tree))
             ;; zvena: plus the tokens of every mode in use (none when nothing is overridden)
             (rx/mapcat
              (fn [sd-tokens]
                (->> (zvm/resolve-modes tokens-lib mode-keys)
                     (rx/map (fn [mode-tokens] [sd-tokens mode-tokens])))))
             (rx/mapcat
              (fn [[sd-tokens mode-tokens]]
                (let [undo-id (js/Symbol)]
                  (rx/concat
                   (rx/of (dwu/start-undo-transaction undo-id :timeout false))
                   ;; zvena
                   (when (seq on-start)
                     (rx/from on-start))

                   ;; FIXME: now the tokens propagations is done by accumulating the update-shapes
                   ;; into a single commit-changes. This is not really the best way, the token application
                   ;; should be done with a changes_builder and sending only one `commit-changes` instead
                   ;; of creating lots of `update-shapes`.
                   (rx/of (dwsh/update-shapes-buffer-start))
                   (->> (propagate-tokens state sd-tokens {:mode-indexes mode-indexes
                                                           :mode-tokens mode-tokens
                                                           :scope scope})
                        (rx/catch #(rx/concat
                                    (rx/of (dwsh/update-shapes-buffer-stop))
                                    (rx/throw %))))
                   (rx/of (dwsh/update-shapes-buffer-stop))
                   (rx/of (dwu/commit-undo-transaction undo-id)))))))))))

(defn propagate-workspace-tokens
  []
  (ptk/reify ::propagate-workspace-tokens
    ptk/WatchEvent
    (watch [_ state _]
      ;; zvena: body moved to zvena-propagate (variable modes per layer)
      (zvena-propagate state nil nil))))

(defn- join-previous-undo-group
  "zvena: gives the open undo transaction, while still empty, the undo
  group of the last undo entry, so that both are undone and redone in a
  single step."
  []
  (ptk/reify ::join-previous-undo-group
    ptk/UpdateEvent
    (update [_ state]
      (let [undo  (get state :workspace-undo)
            tx    (get undo :transaction)
            items (get undo :items)
            index (or (get undo :index) (dec (count items)))
            group (when (>= index 0)
                    (get-in items [index :undo-group]))]
        (if (and (some? tx)
                 (empty? (:undo-changes tx))
                 (nil? (:undo-group tx))
                 (some? group))
          (assoc-in state [:workspace-undo :transaction :undo-group] group)
          state)))))

(defn propagate-layers-tokens
  "zvena: re-propagates the tokens of the layers `ids` of the page
  `page-id` and of everything inside them, each shape in its variable
  mode (used when the variable mode of those layers changes). Its undo
  transaction opens synchronously, so the changes land in the undo entry
  of a caller's transaction even though the resolution is asynchronous.
  With `:join-undo?` (layers that just moved into another mode) it joins
  the undo step of the move when that one is already closed."
  ([page-id ids]
   (propagate-layers-tokens page-id ids nil))
  ([page-id ids {:keys [join-undo?]}]
  (ptk/reify ::propagate-layers-tokens
    ptk/WatchEvent
    (watch [_ state _]
      (let [undo-id (js/Symbol)]
        (rx/concat
         (rx/of (dwu/start-undo-transaction undo-id :timeout false))
         (->> (or (zvena-propagate state
                                   {:page-id page-id :ids ids}
                                   (when join-undo? [(join-previous-undo-group)]))
                  (rx/empty))
              (rx/catch #(rx/concat
                          (rx/of (dwu/commit-undo-transaction undo-id))
                          (rx/throw %))))
         (rx/of (dwu/commit-undo-transaction undo-id))))))))
