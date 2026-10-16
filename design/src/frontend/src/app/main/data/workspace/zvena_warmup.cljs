;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.zvena-warmup
  "zvena: the shape and change validators are built on their first use,
  which took about a second on the first shape drawn in a file. They are
  built here instead, one per idle moment after the workspace opens."
  (:require
   [app.common.files.changes :as cpc]
   [app.common.logging :as log]
   [app.common.types.shape :as cts]))

(defn- when-idle
  [f]
  (if (exists? js/requestIdleCallback)
    (js/requestIdleCallback f #js {:timeout 4000})
    (js/setTimeout f 1500)))

(def ^:private steps
  [#(cts/check-shape (cts/setup-shape {:type :rect :x 0 :y 0 :width 1 :height 1}))
   #(cpc/check-changes [])])

(defn warm-validators!
  []
  (letfn [(run [[step & more]]
            (when step
              (when-idle
               (fn []
                 (try
                   (step)
                   (catch :default cause
                     (log/warn :hint "zvena: validator warm-up" :cause cause)))
                 (run more)))))]
    (run steps)))
