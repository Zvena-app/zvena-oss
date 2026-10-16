;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-effects
  "zvena: Figma UI3's single Effects section (replaces Penpot's Shadow and
  Blur sections): \"+\" adds a drop shadow, the four dots apply an effect
  style, one row per effect (see zvena-effect-rows)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.types.shape.zvena-effects :as zfx]
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.zvena-styles :as zst]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.workspace.sidebar.options.menus.zvena-effect-rows :refer [effects-editor* add-drop-shadow]]
   [app.main.ui.workspace.zvena.style-picker :refer [style-button* applied-style-row*]]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(defn- effects-data-ref
  [ids]
  (l/derived (fn [objects]
               (into []
                     (keep (fn [id]
                             (when-let [shape (get objects id)]
                               {:effects (zfx/get-effects shape)
                                :ref (zfx/get-data shape zfx/effect-style-key)})))
                     ids))
             refs/workspace-page-objects
             =))

(mf/defc effects-menu*
  [{:keys [ids]}]
  (let [data-ref (mf/with-memo [ids] (effects-data-ref ids))
        data     (mf/deref data-ref)
        effects  (:effects (first data))

        mixed?   (and (> (count data) 1)
                      (not (every? #(zfx/same-effects? effects (:effects %)) (rest data))))
        refs     (into #{} (map :ref) data)
        ref-str  (when (= 1 (count refs)) (first refs))
        styled?  (some? (zfx/parse-style-ref ref-str))
        mixed?   (or mixed? (> (count refs) 1))

        has-content? (or styled? mixed? (and (some? effects) (not (zfx/empty-effects? effects))))

        open*    (mf/use-state true)
        open?    (deref open*)
        toggle   (mf/use-fn #(swap! open* not))

        on-change
        (mf/use-fn
         (mf/deps ids)
         (fn [f]
           (st/emit! (dw/trigger-bounding-box-cloaking ids)
                     (zst/update-shape-effects ids f))))

        on-add
        (mf/use-fn
         (mf/deps on-change mixed?)
         (fn [_]
           (if mixed?
             (on-change (fn [_] (add-drop-shadow (zfx/check-effects {}))))
             (on-change add-drop-shadow))))

        on-remove-all
        (mf/use-fn
         (mf/deps on-change)
         (fn [_]
           (on-change (fn [_] (zfx/check-effects {})))))]

    (when (seq data)
      [:section {:class (stl/css :effects-section)
                 :data-testid "shadow-section"
                 :aria-label (tr "zvena.effects.title")}
       [:div {:class (stl/css :effects-title)}
        [:> title-bar* {:collapsable  has-content?
                        :collapsed    (not open?)
                        :on-collapsed toggle
                        :title        (tr "zvena.effects.title")
                        :class        (stl/css-case :title-spacing (not has-content?))}
         [:> style-button* {:kind :effect :ids ids :selected-ref ref-str}]
         [:> icon-button* {:variant "ghost"
                           :aria-label (tr "zvena.effects.add")
                           :on-click on-add
                           :icon i/add
                           :data-testid "add-shadow"}]]]

       (when (and open? has-content?)
         [:div {:class (stl/css :effects-content)}
          (cond
            styled?
            [:> applied-style-row* {:kind :effect :ids ids :ref-str ref-str}]

            mixed?
            [:div {:class (stl/css :effects-mixed)}
             [:span {:class (stl/css :effects-mixed-label)} (tr "zvena.effects.mixed")]
             [:> icon-button* {:variant "ghost"
                               :aria-label (tr "zvena.effects.remove")
                               :on-click on-remove-all
                               :icon i/remove}]]

            :else
            [:> effects-editor* {:effects effects
                                 :on-change on-change
                                 :id-prefix "fx"}])])])))
