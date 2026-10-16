;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.batch-rename
  "zvena: Figma's \"Rename layers\" for several selected layers (Ctrl+R).
  `Rename to` takes $& (the current name) and $n / $nn / $nnn (a number,
  zero-padded to that many digits; $N… counts down); `Match` / `Replace
  with` substitute text in the current names first."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.main.data.modal :as modal]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [clojure.string :as cstr]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- pad [n width]
  (let [s (str n)]
    (if (< (count s) width)
      (str (apply str (repeat (- width (count s)) "0")) s)
      s)))

(defn new-name
  "The name of the `index`-th (0-based) of `total` layers."
  [old-name {:keys [pattern match replace start]} index total]
  (let [base (if (str/blank? match)
               old-name
               (cstr/replace old-name match (or replace "")))
        up   (+ start index)
        down (+ start (- total index 1))]
    (if (str/blank? pattern)
      base
      ;; clojure.string: a fn replacement gets [match group] and string
      ;; replacements are literal ($ in a name stays as is)
      (-> pattern
          (cstr/replace #"\$(n+|N+)"
                        (fn [[_ ns]]
                          (pad (if (= (first ns) \n) up down) (count ns))))
          (cstr/replace "$&" base)))))

(mf/defc batch-rename-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-batch-rename}
  [{:keys [ids]}]
  (let [objects  (mf/deref refs/workspace-page-objects)
        shapes   (mf/with-memo [ids objects]
                   (into [] (keep (d/getf objects)) ids))
        total    (count shapes)

        form*    (mf/use-state {:pattern "$&" :match "" :replace "" :start 1})
        form     (deref form*)

        on-field
        (mf/use-fn
         (fn [event]
           (let [target (dom/get-target event)
                 field  (keyword (dom/get-data target "field"))
                 value  (dom/get-value target)]
             (swap! form* assoc field
                    (if (= field :start)
                      (max 0 (d/parse-integer value 1))
                      value)))))

        close
        (mf/use-fn #(st/emit! (modal/hide)))

        apply-rename
        (mf/use-fn
         (mf/deps shapes form total)
         (fn [event]
           (dom/prevent-default event)
           (let [names (into {}
                             (map-indexed (fn [index shape]
                                            [(:id shape) (str/trim (new-name (:name shape) form index total))]))
                             shapes)]
             (st/emit! (modal/hide)
                       (dwsh/update-shapes (vec (keys names))
                                           (fn [shape]
                                             (let [n (get names (:id shape))]
                                               (if (str/blank? n) shape (assoc shape :name n)))))))))

        on-key-down
        (mf/use-fn
         (mf/deps apply-rename)
         (fn [event]
           (when (kbd/enter? event) (apply-rename event))
           (when (kbd/esc? event) (close))))]

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-container)
            :on-key-down on-key-down}
      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2 :typography "headline-medium"}
        (tr "zvena.rename.title" total)]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "labels.close")
                         :on-click close
                         :icon i/close
                         :class (stl/css :modal-close-btn)}]]

      [:div {:class (stl/css :fields)}
       [:label {:class (stl/css :field)}
        [:span (tr "zvena.rename.pattern")]
        [:input {:data-field "pattern" :auto-focus true :value (:pattern form) :on-change on-field}]]
       [:div {:class (stl/css :hint)} (tr "zvena.rename.hint")]
       [:div {:class (stl/css :row)}
        [:label {:class (stl/css :field)}
         [:span (tr "zvena.rename.match")]
         [:input {:data-field "match" :value (:match form) :on-change on-field}]]
        [:label {:class (stl/css :field)}
         [:span (tr "zvena.rename.replace")]
         [:input {:data-field "replace" :value (:replace form) :on-change on-field}]]
        [:label {:class (stl/css :field :field-small)}
         [:span (tr "zvena.rename.start")]
         [:input {:data-field "start" :type "number" :min 0 :value (:start form) :on-change on-field}]]]]

      [:ul {:class (stl/css :preview)}
       (for [[index shape] (map-indexed vector (take 6 shapes))]
         [:li {:key (str (:id shape))}
          [:span {:class (stl/css :old)} (:name shape)]
          [:span {:class (stl/css :arrow)} "→"]
          [:span {:class (stl/css :new)} (new-name (:name shape) form index total)]])
       (when (> total 6)
         [:li {:class (stl/css :more)} (str "… +" (- total 6))])]

      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "secondary" :on-click close} (tr "labels.cancel")]
       [:> button* {:variant "primary" :on-click apply-rename} (tr "zvena.rename.apply")]]]]))
