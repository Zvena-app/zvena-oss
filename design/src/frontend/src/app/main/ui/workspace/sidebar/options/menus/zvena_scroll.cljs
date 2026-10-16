;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-scroll
  "zvena: Figma's Scroll behavior section of the Prototype tab.

  - Position, for a layer directly inside a frame: Scroll with parent,
    Fixed (Penpot's own Fix when scrolling, `:fixed-scroll`, so the
    Design tab checkbox shows the same setting) or Sticky (zvena
    plugin-data).
  - Overflow, for a frame that clips its content and whose content goes
    past its edges (or that already has one): No scrolling, Horizontal,
    Vertical or Both directions (zvena plugin-data).

  The data is described in `app.common.types.shape.zvena`; the viewer
  side is `app.main.ui.viewer.zvena.scroll`."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.geom.shapes :as gsh]
   [app.common.types.shape.zvena :as ctsz]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.data.workspace.undo :as dwu]
   [app.main.data.workspace.zvena-devmode :as dwzd]
   [app.main.store :as st]
   [app.main.ui.components.select :refer [select]]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

;; --- Events

(defn set-position
  "zvena: Figma position of the layers `ids` while their parent scrolls:
  \"scroll\", \"fixed\" or \"sticky\" (one undo step)."
  [ids value]
  (ptk/reify ::set-position
    ptk/WatchEvent
    (watch [_ _ _]
      (let [undo-id (js/Symbol)
            fixed?  (= value "fixed")]
        (rx/of (dwu/start-undo-transaction undo-id)
               (dwsh/update-shapes ids
                                   (fn [shape]
                                     (cond
                                       fixed?
                                       (assoc shape :fixed-scroll true)

                                       (true? (:fixed-scroll shape))
                                       (assoc shape :fixed-scroll false)

                                       :else
                                       shape)))
               (dwzd/set-zvena-data ids {ctsz/position-key (when (= value "sticky") "sticky")})
               (dwu/commit-undo-transaction undo-id))))))

(defn set-overflow
  "zvena: Figma overflow direction of the frames `ids`: \"none\",
  \"horizontal\", \"vertical\" or \"both\"."
  [ids value]
  (dwzd/set-zvena-data ids {ctsz/overflow-key (when (contains? ctsz/overflows value) value)}))

;; --- Helpers

(defn- position-target?
  "A layer directly inside a frame (not a top-level frame of a section)."
  [objects shape]
  (let [parent-id (:parent-id shape)
        parent    (get objects parent-id)]
    (and (some? shape)
         (not (ctsz/section? shape))
         (some? parent-id)
         (not= uuid/zero parent-id)
         (= :frame (:type parent))
         (not (ctsz/section? parent)))))

(defn- frame-target?
  [shape]
  (and (some? shape)
       (= :frame (:type shape))
       (not (ctsz/section? shape))))

(defn- content-overflows?
  "True when the frame clips its content and its (not fixed, visible)
  children go past its right or bottom edge: Figma offers Overflow only
  then."
  [objects frame]
  (and (not (:show-content frame))
       (let [content (->> (:shapes frame)
                          (keep #(get objects %))
                          (remove :hidden)
                          (remove #(true? (:fixed-scroll %)))
                          (gsh/shapes->rect))
             selrect (:selrect frame)]
         (and (some? content)
              (some? selrect)
              (or (> (:x2 content) (+ (:x2 selrect) 0.5))
                  (> (:y2 content) (+ (:y2 selrect) 0.5)))))))

(defn- common-value
  "The value all the `values` share, or \"\" (Mixed)."
  [values]
  (let [values (set values)]
    (if (= 1 (count values)) (first values) "")))

;; --- Component

(mf/defc scroll-behavior*
  "zvena: Prototype tab, Scroll behavior (Position / Overflow) of the
  selected layers."
  [{:keys [shapes objects]}]
  (let [shapes          (into [] (filter some?) shapes)
        n               (count shapes)

        position-shapes (filterv #(position-target? objects %) shapes)
        show-position?  (and (pos? n) (= n (count position-shapes)))
        position-ids    (mapv :id position-shapes)
        position        (common-value (map #(name (ctsz/scroll-position %)) position-shapes))

        frame-shapes    (filterv frame-target? shapes)
        show-overflow?  (and (pos? n)
                             (= n (count frame-shapes))
                             (boolean
                              (some #(or (not= :none (ctsz/overflow %))
                                         (content-overflows? objects %))
                                    frame-shapes)))
        frame-ids       (mapv :id frame-shapes)
        overflow        (common-value (map #(name (ctsz/overflow %)) frame-shapes))

        position-options
        (mf/with-memo [position]
          (cond-> []
            (= position "")
            (conj {:value "" :label (tr "settings.multiple")})

            :always
            (conj {:value "scroll" :label (tr "zvena.scroll.scroll-with-parent")}
                  {:value "fixed" :label (tr "zvena.scroll.fixed")}
                  {:value "sticky" :label (tr "zvena.scroll.sticky")})))

        overflow-options
        (mf/with-memo [overflow]
          (cond-> []
            (= overflow "")
            (conj {:value "" :label (tr "settings.multiple")})

            :always
            (conj {:value "none" :label (tr "zvena.scroll.no-scrolling")}
                  {:value "horizontal" :label (tr "zvena.scroll.horizontal")}
                  {:value "vertical" :label (tr "zvena.scroll.vertical")}
                  {:value "both" :label (tr "zvena.scroll.both")})))

        on-position
        (mf/use-fn
         (mf/deps position-ids)
         (fn [value]
           (when (and (seq position-ids) (not (str/blank? value)))
             (st/emit! (set-position position-ids value)))))

        on-overflow
        (mf/use-fn
         (mf/deps frame-ids)
         (fn [value]
           (when (and (seq frame-ids) (not (str/blank? value)))
             (st/emit! (set-overflow frame-ids value)))))]

    (when (or show-position? show-overflow?)
      [:section {:class (stl/css :element-set)
                 :aria-label (tr "zvena.scroll.title")
                 :data-testid "zvena-scroll-behavior"}
       [:div {:class (stl/css :element-title)}
        [:> title-bar* {:collapsable false
                        :title (tr "zvena.scroll.title")
                        :class (stl/css :title-spacing)}]]
       [:div {:class (stl/css :element-content)}
        (when show-position?
          [:div {:class (stl/css :row)
                 :data-testid "zvena-scroll-position"}
           [:span {:class (stl/css :label)} (tr "zvena.scroll.position")]
           [:& select {:class (stl/css :select)
                       :default-value position
                       :options position-options
                       :on-change on-position}]])
        (when show-overflow?
          [:div {:class (stl/css :row)
                 :data-testid "zvena-scroll-overflow"}
           [:span {:class (stl/css :label)} (tr "zvena.scroll.overflow")]
           [:& select {:class (stl/css :select)
                       :default-value overflow
                       :options overflow-options
                       :on-change on-overflow}]])]])))
