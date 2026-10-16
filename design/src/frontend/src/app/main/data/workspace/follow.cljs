;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.follow
  "zvena: Figma's follow mode. Clicking a collaborator's avatar makes this
  viewport show what they see — their page, zoom and center — until the
  user acts on the canvas (click, pan, zoom) or presses Escape."
  (:require
   [app.common.geom.rect :as grc]
   [app.main.data.common :as dcm]
   [app.main.data.workspace.viewport :as dwv]
   [app.main.data.workspace.viewport-wasm :as dwvw]
   [app.main.data.workspace.zoom :as dwz]
   [app.util.mouse :as mse]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(declare stop-following)

(defn following
  "The session id being followed, or nil."
  [state]
  (get-in state [:workspace-local :following]))

(defn- follow-local
  "Same zoom and same center as the leader's viewport."
  [local {:keys [vbox zoom]}]
  (if (and (some? vbox) (number? zoom) (pos? zoom))
    (-> local
        (dwz/impl-update-zoom nil zoom)
        (dwv/calculate-centered-viewbox (grc/rect->center vbox)))
    local))

(defn- sync-viewport
  [session-id]
  (ptk/reify ::sync-viewport
    ptk/UpdateEvent
    (update [_ state]
      (let [session (get-in state [:workspace-presence session-id])]
        (if (or (nil? session) (dwvw/render-context-lost? state))
          state
          (update state :workspace-local follow-local session))))

    ptk/WatchEvent
    (watch [_ state _]
      (let [session (get-in state [:workspace-presence session-id])
            page-id (:page-id session)]
        (cond
          ;; the leader left the file
          (nil? session)
          (rx/of (stop-following))

          (and (some? page-id) (not= page-id (:current-page-id state)))
          (rx/of (dcm/go-to-workspace :page-id page-id))

          :else
          (rx/empty))))

    ptk/EffectEvent
    (effect [_ state _]
      (dwvw/maybe-sync-workspace-local-viewport! state))))

(defn- own-canvas-action?
  "The user's own panning, zooming or click on the canvas."
  [event]
  (or (and (mse/mouse-event? event) (mse/mouse-down-event? event))
      (ptk/type? ::dwv/start-panning event)
      (ptk/type? ::dwz/set-zoom event)
      (ptk/type? ::dwz/increase-zoom event)
      (ptk/type? ::dwz/decrease-zoom event)
      (ptk/type? ::dwz/start-zooming event)
      (ptk/type? ::dwz/fit-to-shapes event)))

(defn start-following
  [session-id]
  (ptk/reify ::start-following
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:workspace-local :following] session-id))

    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (rx/filter (ptk/type? ::stop-following) stream)]
        (rx/merge
         (rx/of (sync-viewport session-id))
         ;; every pointer update of the leader carries their viewport
         (->> stream
              (rx/filter (ptk/type? :app.main.data.workspace.notifications/handle-pointer-update))
              (rx/map (fn [_] (sync-viewport session-id)))
              (rx/take-until stopper))
         (->> stream
              (rx/filter own-canvas-action?)
              (rx/take 1)
              (rx/map (fn [_] (stop-following)))
              (rx/take-until stopper)))))))

(defn stop-following
  []
  (ptk/reify ::stop-following
    ptk/UpdateEvent
    (update [_ state]
      (update state :workspace-local dissoc :following))))

(defn toggle-following
  [session-id]
  (ptk/reify ::toggle-following
    ptk/WatchEvent
    (watch [_ state _]
      (cond
        (= session-id (:session-id state)) (rx/empty)
        (= session-id (following state))   (rx/of (stop-following))
        :else                              (rx/of (stop-following)
                                                  (start-following session-id))))))
