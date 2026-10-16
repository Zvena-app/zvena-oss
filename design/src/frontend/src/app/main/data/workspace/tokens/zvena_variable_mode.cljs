;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.tokens.zvena-variable-mode
  "zvena: Figma's \"Apply variable mode\" on a frame, section, board or
  group. Writes the override (see app.main.data.workspace.tokens.zvena-modes)
  into the layers' plugin-data with the same change the plugin API's
  setPluginData uses, then re-propagates the tokens inside those layers.
  Both land in a single undo entry.

  Also watches the edits that bring layers into another mode (moved into
  or out of an overridden layer, pasted / duplicated / instantiated inside
  one) and re-propagates them, as Figma does. Same for the component
  copies inside an overridden layer that a component sync just rewrote
  with the values of their main."
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.types.shape.zvena :as ctsz]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.tokens.propagation :as dwtp]
   [app.main.data.workspace.tokens.zvena-modes :as zvm]
   [app.main.data.workspace.undo :as dwu]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(defn- update-variable-modes
  "Rewrites the override of the layers `ids` of the current page with
  `(f tokens-lib theme-ids)` and re-propagates their tokens."
  [ids f]
  (ptk/reify ::update-variable-modes
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id    (:current-file-id state)
            page-id    (:current-page-id state)
            fdata      (dsh/lookup-file-data state file-id)
            tokens-lib (get fdata :tokens-lib)
            objects    (dsh/lookup-page-objects state file-id page-id)
            entries    (when (some? tokens-lib)
                         (into []
                               (keep (fn [id]
                                       (when-let [shape (get objects id)]
                                         (let [old (or (zvm/shape-theme-ids shape) [])
                                               new (vec (f tokens-lib old))]
                                           (when (not= old new)
                                             [id (zvm/format-theme-ids new)])))))
                               ids))]
        (if (and (some? fdata) (seq entries))
          (let [undo-id (js/Symbol)
                changes (reduce (fn [changes [id value]]
                                  (pcb/set-plugin-data changes :shape id page-id
                                                       ctsz/plugin-ns zvm/themes-key value))
                                (-> (pcb/empty-changes it)
                                    (pcb/with-file-data fdata)
                                    (assoc :file-id file-id))
                                entries)]
            (rx/of (dwu/start-undo-transaction undo-id :timeout false)
                   (dch/commit-changes changes)
                   (dwtp/propagate-layers-tokens page-id (mapv first entries))
                   (dwu/commit-undo-transaction undo-id)))
          (rx/empty))))))

(defn set-variable-mode
  "Makes the layers `ids` use the theme `theme-id` for the theme group
  `group` (\"\" for the ungrouped themes); nil goes back to Auto (the
  mode inherited from the parents or the file)."
  [ids group theme-id]
  (update-variable-modes ids (fn [tokens-lib theme-ids]
                               (zvm/replace-group-theme tokens-lib theme-ids group theme-id))))

(defn clear-variable-modes
  "Removes every variable mode override of the layers `ids`."
  [ids]
  (update-variable-modes ids (constantly [])))

;; --- Layers moved into another mode

(def ^:private sync-origin
  "Origin of the commits of a component sync (main -> copies)."
  :app.main.data.workspace.libraries/sync-file)

(defn- layers-in-new-mode
  "{page-id #{layer-id}} of the layers moved or added by `commit` (already
  applied to `state`) whose variable mode changed; for a component sync,
  the rewritten layers that lie in an overridden layer."
  [state {:keys [redo-changes undo-changes origin]}]
  (let [fdata      (dsh/lookup-file-data state)
        tokens-lib (get fdata :tokens-lib)]
    (if (nil? tokens-lib)
      {}
      (let [old-parents
            (into {}
                  (comp (filter #(= :mov-objects (:type %)))
                        (mapcat (fn [{:keys [parent-id shapes]}]
                                  (map (fn [id] [id parent-id]) shapes))))
                  undo-changes)

            added
            (into #{}
                  (comp (filter #(= :add-obj (:type %)))
                        (map :id))
                  redo-changes)

            ;; layers the commit deleted (e.g. the group of an ungroup):
            ;; still needed to know the mode the moved layers came from
            removed
            (into {}
                  (comp (filter #(= :add-obj (:type %)))
                        (map (juxt :id :obj)))
                  undo-changes)

            mode-key
            (fn [theme-ids]
              (zvm/mode-key tokens-lib theme-ids))

            add
            (fn [acc page-id id]
              (update acc page-id (fnil conj #{}) id))]

        (reduce
         (fn [acc {:keys [type page-id] :as change}]
           (let [objects     (dm/get-in fdata [:pages-index page-id :objects])
                 old-objects (if (and (some? objects) (seq removed))
                               (reduce-kv assoc objects removed)
                               objects)]
             (case type
               :mov-objects
               (reduce (fn [acc id]
                         (let [shape      (get objects id)
                               old-parent (get old-parents id)]
                           (if (and (some? shape)
                                    (some? old-parent)
                                    (not= (mode-key (zvm/layer-theme-ids objects id))
                                          (mode-key (into (zvm/layer-theme-ids old-objects old-parent)
                                                          (zvm/shape-theme-ids shape)))))
                             (add acc page-id id)
                             acc)))
                       acc
                       (:shapes change))

               :add-obj
               (let [id    (:id change)
                     shape (get objects id)]
                 (if (and (some? shape)
                          (not (contains? added (:parent-id shape)))
                          (some? (mode-key (zvm/layer-theme-ids objects id))))
                   (add acc page-id id)
                   acc))

               :mod-obj
               (let [id    (:id change)
                     shape (get objects id)]
                 (if (and (= origin sync-origin)
                          (some? shape)
                          (seq (:applied-tokens shape))
                          (some? (mode-key (zvm/layer-theme-ids objects id))))
                   (add acc page-id id)
                   acc))

               acc)))
         {}
         redo-changes)))))

(defn- propagate-layers-in-new-mode
  [commit]
  (ptk/reify ::propagate-layers-in-new-mode
    ptk/WatchEvent
    (watch [_ state _]
      (->> (layers-in-new-mode state commit)
           (into [] (map (fn [[page-id ids]]
                           (dwtp/propagate-layers-tokens page-id (vec ids) {:join-undo? true}))))
           (rx/from)))))

(defn watch-layers-in-new-mode
  "Started with the workspace (app.main.ui.workspace): the user edits that
  bring layers into another variable mode re-propagate their tokens, in
  the same undo step. Undo / redo and remote changes are left alone (they
  carry the propagated values already)."
  []
  (ptk/reify ::watch-layers-in-new-mode
    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (rx/merge
                     (rx/filter (ptk/type? :app.main.data.workspace/finalize-workspace) stream)
                     (rx/filter (ptk/type? ::watch-layers-in-new-mode) stream))]
        (->> stream
             (rx/filter dch/commit?)
             (rx/map deref)
             (rx/filter (fn [{:keys [source save-undo? undo-changes redo-changes origin]}]
                          (and (= :local source)
                               (or (= origin sync-origin)
                                   (and save-undo?
                                        (seq undo-changes)
                                        (some #(contains? #{:mov-objects :add-obj} (:type %))
                                              redo-changes))))))
             (rx/map propagate-layers-in-new-mode)
             (rx/take-until stopper))))))
