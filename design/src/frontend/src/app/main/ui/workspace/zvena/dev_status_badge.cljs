;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.dev-status-badge
  "zvena: Figma's Dev Mode status badge (Ready for dev / Completed), shown
  next to the frame title on the canvas, in the layers panel and in the
  Dev Mode panels."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.time :as ct]
   [app.common.types.shape.zvena :as ctsz]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn status-label
  [status]
  (case status
    "ready"     (tr "zvena.devmode.status.ready")
    "completed" (tr "zvena.devmode.status.completed")
    nil))

(defn status-meta
  "Who marked the frame and when (\"Ann · 2 hours ago\"), nil if unknown."
  [shape]
  (let [by  (ctsz/get-data shape ctsz/dev-status-by-key)
        at  (ctsz/get-data shape ctsz/dev-status-at-key)
        ago (when (string? at)
              (try
                (ct/timeago (ct/inst at))
                (catch :default _ nil)))]
    (cond
      (and (string? by) (string? ago)) (str by " · " ago)
      (string? by)                     by
      (string? ago)                    ago
      :else                            nil)))

(mf/defc dev-status-badge*
  "`compact` shows the icon only (layers panel, canvas in Design mode)."
  [{:keys [status compact]}]
  (when (some? status)
    (let [label (status-label status)]
      [:span {:class (stl/css-case :badge true
                                   :compact compact
                                   :ready (= status "ready")
                                   :completed (= status "completed"))
              :title label
              :aria-label label
              :data-testid "zvena-dev-status"}
       [:> icon* {:icon-id (if (= status "completed") i/tick i/code)
                  :size "s"}]
       (when-not compact
         [:span {:class (stl/css :badge-label)} label])])))
