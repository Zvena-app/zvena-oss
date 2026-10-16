;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.viewer.zvena.device
  "zvena: Figma's prototype device frames. The page's prototype settings
  (plugin data {:zvena {\"device\" .. \"device-color\" ..}}) put the
  presented frame inside a phone, tablet, laptop or browser frame."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [rumext.v2 :as mf]))

(def devices
  "Device id → kind. The kinds share the CSS of their family."
  {"iphone"    :phone
   "iphone-se" :phone-classic
   "android"   :android
   "ipad"      :tablet
   "macbook"   :laptop
   "browser"   :browser})

(def colors
  {"black"  "#1c1c1e"
   "silver" "#d9d9de"
   "gold"   "#e3d3b8"
   "blue"   "#36465c"})

(defn page-device
  "[device-id color] of a page, or nil."
  [page]
  (let [data   (dm/get-in page [:plugin-data :zvena])
        device (get data "device")]
    (when (contains? devices device)
      [device (get colors (get data "device-color") (get colors "black"))])))

(def ^:private base-width
  "Screen width the bezel proportions are drawn for, per kind."
  {:phone 393 :phone-classic 375 :android 412 :tablet 820 :laptop 1440 :browser 1440})

(mf/defc device-frame*
  "Wraps the presented frame (its children) in the device of `page`. The
  bezel is proportional to the presented width, as if the frame were the
  device's screen."
  [{:keys [page width children]}]
  (if-let [[device color] (page-device page)]
    (let [kind  (get devices device)
          scale (if (and (number? width) (pos? width))
                  (/ width (get base-width kind 393))
                  1)]
      [:div {:class (stl/css-case :device true
                                  :phone (= kind :phone)
                                  :phone-classic (= kind :phone-classic)
                                  :android (= kind :android)
                                  :tablet (= kind :tablet)
                                  :laptop (= kind :laptop)
                                  :browser (= kind :browser))
             :style {:--zv-device-color color
                     :--zv-device-scale scale}}
       (when (= kind :browser)
         [:div {:class (stl/css :browser-bar)}
          [:span] [:span] [:span]
          [:div {:class (stl/css :browser-url)}]])
       [:div {:class (stl/css :device-screen)}
        children]
       (case kind
         :phone         [:div {:class (stl/css :island)}]
         :android       [:div {:class (stl/css :camera)}]
         :phone-classic [:div {:class (stl/css :home-button)}]
         :laptop        [:div {:class (stl/css :laptop-base)}]
         nil)])
    children))
