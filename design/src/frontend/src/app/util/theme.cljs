;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.util.theme
  (:require
   [app.common.data :as d]
   [app.util.globals :as globals]
   [beicon.v2.core :as rx]
   [rumext.v2 :as mf]))

(defonce ^:private color-scheme-media-query
  (.matchMedia globals/window "(prefers-color-scheme: dark)"))

(defonce ^:private color-scheme-listeners*
  (atom #{}))

(def ^:const default "dark")

(defn get-system-theme
  []
  (if ^boolean (.-matches color-scheme-media-query)
    "dark"
    "light"))

(defn- notify-color-scheme-listeners!
  []
  (doseq [f @color-scheme-listeners*]
    (f)))

(defn add-color-scheme-listener!
  "Registers `f` to run after each `body` color-scheme update in
   `use-initialize` (profile theme or OS preference). Returns a dispose fn."
  [f]
  (swap! color-scheme-listeners* conj f)
  (fn [] (swap! color-scheme-listeners* disj f)))

(defn- set-color-scheme
  [^string color]

  (let [node  (.querySelector js/document "body")
        class (if (= color "dark") "default" "light")]
    (.removeAttribute node "class")
    (.add ^js (.-classList ^js node) class)))

(defn resolve-theme
  "Resolves the profile's theme setting to the effective UI theme ('dark' or
  'light'): 'system' follows the given system theme, 'default' and an unset
  theme mean dark, and any other value is taken as-is. Single source of truth
  for the app's own theme and the theme reported to plugins."
  [profile-theme system-theme]
  (cond
    (= profile-theme "system") system-theme
    (= profile-theme "default") "dark"
    ;; zvena Design: like Figma, an unset theme follows the system.
    :else (d/nilv profile-theme system-theme)))

;; zvena: Figma's Preferences > "Enhanced contrast": stronger secondary text,
;; icons and borders, kept per browser.
(def ^:private contrast-key "zvena-enhanced-contrast")

(defn enhanced-contrast?
  []
  (try (= "true" (.getItem js/localStorage contrast-key)) (catch :default _ false)))

(defn set-enhanced-contrast!
  [on?]
  (try (.setItem js/localStorage contrast-key (str (boolean on?))) (catch :default _ nil))
  (some-> js/document .-documentElement .-classList (.toggle "zv-contrast" (boolean on?))))

(defn use-initialize
  [{profile-theme :theme}]
  (let [system-theme* (mf/use-state get-system-theme)
        system-theme  (deref system-theme*)]

    (mf/with-effect []
      (let [s (->> (rx/from-event color-scheme-media-query "change")
                   (rx/map #(if (.-matches %) "dark" "light"))
                   (rx/subs! #(reset! system-theme* %)))]
        (fn []
          (rx/dispose! s))))

    (mf/with-effect []
      (set-enhanced-contrast! (enhanced-contrast?)))

    (mf/with-effect [system-theme profile-theme]
      (set-color-scheme (resolve-theme profile-theme system-theme))
      (notify-color-scheme-listeners!))))

(defn- dark-body?
  []
  (boolean (some-> (.querySelector js/document "body") (.-classList) (.contains "default"))))

(defn use-dark?
  "true while the dark theme is applied; re-renders on theme changes
  (used for the theme-aware default canvas color, as in Figma)."
  []
  (let [dark* (mf/use-state dark-body?)]
    (mf/with-effect []
      (add-color-scheme-listener! #(reset! dark* (dark-body?))))
    (deref dark*)))
