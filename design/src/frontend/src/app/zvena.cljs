;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena
  "zvena: links from Design (this Penpot fork) to the rest of zvena — Home,
  Documents, Team, help, legal pages, complaints and the source code page.
  zvena's address comes from `penpotZvenaURI` in config.js (set by the
  frontend image from PENPOT_ZVENA_URI); without it, it is the Design
  address without its leading \"design.\" (design.zvena.app → zvena.app)."
  (:require
   [app.config :as cf]
   [app.util.globals :refer [global]]
   [app.util.object :as obj]
   [cuerdas.core :as str]))

(def uri
  (let [explicit (obj/get global "penpotZvenaURI")]
    (str/rtrim
     (if (str/blank? explicit)
       (str/replace (str cf/public-uri) #"//design\." "//")
       explicit)
     "/")))

(def support-email "support@zvena.app")

(defn- with-team
  [path team-id]
  (if team-id
    (str uri path "?team=" (js/encodeURIComponent (str team-id)))
    (str uri path)))

(defn home-url [team-id] (with-team "/home" team-id))
(defn docs-url [team-id] (with-team "/docs" team-id))
(defn team-url [team-id] (with-team "/team" team-id))
(defn settings-url [] (str uri "/settings"))
(defn help-url [] (str uri "/help"))
(defn privacy-url [] (str uri "/legal/privacy"))
(defn terms-url [] (str uri "/legal/terms"))
(defn source-url [] (str uri "/source"))

(defn report-url
  "The complaint form, pre-filled with the address of what is being reported."
  [target]
  (str uri "/report?url=" (js/encodeURIComponent (str target))))

(defn linked-docs-url
  "zvena's page listing the documents that show this design file."
  [file-id]
  (str uri "/design-links?file=" (js/encodeURIComponent (str file-id))))
