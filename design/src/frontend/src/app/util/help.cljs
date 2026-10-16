;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.util.help
  "Links to zvena's help page."
  (:require
   [app.zvena :as zvena]))

(defn url
  "zvena's help page, optionally at `anchor` (`slug` is kept for the callers
  written for the zvena Design help center; zvena has one help page)."
  ([] (url nil nil))
  ([slug] (url slug nil))
  ([_slug anchor]
   (str (zvena/help-url) (when anchor (str "#" anchor)))))
