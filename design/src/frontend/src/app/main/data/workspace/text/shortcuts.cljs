;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.data.workspace.text.shortcuts
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.types.text :as txt]
   [app.main.data.shortcuts :as ds]
   [app.main.data.workspace.texts :as dwt]
   [app.main.data.workspace.undo :as dwu]
   [app.main.data.workspace.zvena-fills :as zfills]
   [app.main.features :as features]
   [app.main.fonts :as fonts]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [cuerdas.core :as str]
   [okulary.core :as l]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Shortcuts
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

;; Shortcuts format https://github.com/ccampbell/mousetrap

(defn- is-bold? [variant-id]
  (some #(str/includes? variant-id %) ["bold" "black" "700"]))

(defn- is-italic? [variant-id]
  (some #(str/includes? variant-id %) ["italic" "cursive"]))

(defn- generate-variant-props
  [text-values variant-id]
  (let [first-intersection        (fn [list1 list2] (first (filter (set list1) list2)))
        current-variant           (:font-variant-id text-values)
        bold-options              (cond
                                    (str/includes? current-variant "black")
                                    ["black" "bold" "700"]
                                    (str/includes? current-variant "700")
                                    ["700" "black" "bold"]
                                    :else
                                    ["bold" "black" "700"])
        current-variant-no-italic (cond
                                    (str/includes? current-variant "italic")
                                    (subs current-variant 0 (- (count current-variant) 6))
                                    (str/includes? current-variant "cursive")
                                    (subs current-variant 0 (- (count current-variant) 7))
                                    :else nil)
        regular-options           [current-variant-no-italic "regular" "normal" "400"]
        italic-options            [(when (and (not (str/includes? current-variant "bold"))
                                              (not (str/includes? current-variant "black"))
                                              (not (str/includes? current-variant "700")))
                                     (str current-variant "italic"))
                                   "italic" "cursive"]
        bold-italic-options       (cond
                                    (str/includes? current-variant "black")
                                    ["blackitalic" "blackcursive" "bolditalic" "700italic" "boldcursive" "700cursive"]
                                    (str/includes? current-variant "700")
                                    ["700italic" "700cursive" "bolditalic"  "blackitalic" "boldcursive"  "blackcursive"]
                                    :else
                                    ["bolditalic" "700italic" "blackitalic" "boldcursive" "700cursive" "blackcursive"])
        font-id                   (:font-id text-values)
        fonts                     (deref fonts/fontsdb)
        font                      (get fonts font-id)
        variants                  (map :id (:variants font))
        choose-regular            (fn [] (first-intersection variants regular-options))
        choose-bold               (fn [] (first-intersection variants bold-options))
        choose-italic             (fn [] (first-intersection variants italic-options))
        choose-bold-italic        (fn [] (or (first-intersection variants bold-italic-options) (choose-bold)))
        choose-italic-bold        (fn [] (or (first-intersection variants bold-italic-options) (choose-italic)))

        new-variant               (let [bold?          (is-bold? current-variant)
                                        italic?        (is-italic? current-variant)
                                        add-bold?      (and (not bold?)
                                                            (or (= variant-id "add-bold")
                                                                (= variant-id "toggle-bold")))
                                        remove-bold?   (and bold?
                                                            (or (= variant-id "remove-bold")
                                                                (= variant-id "toggle-bold")))
                                        add-italic?      (and (not italic?)
                                                              (or (= variant-id "add-italic")
                                                                  (= variant-id "toggle-italic")))
                                        remove-italic?   (and italic?
                                                              (or (= variant-id "remove-italic")
                                                                  (= variant-id "toggle-italic")))]
                                    (cond
                                      (and add-bold? italic?) ;; it is italic, set it to bold+italic
                                      (choose-bold-italic)
                                      (and add-bold? (not italic?)) ;; it is regular, set it to bold
                                      (choose-bold)
                                      (and remove-bold? italic?) ;; it is bold+italic, set it to italic
                                      (choose-italic)
                                      (and remove-bold? (not italic?)) ;; it is bold set it to regular
                                      (choose-regular)
                                      (and add-italic? bold?) ;; it is bold, set it to italic+bold
                                      (choose-italic-bold)
                                      (and add-italic? (not bold?)) ;; it is regular, set it to italic
                                      (choose-italic)
                                      (and remove-italic? bold?) ;; it is bold+italic, set it to bold
                                      (choose-bold)
                                      (and remove-italic? (not bold?)) ;; it is italic, set it to regular
                                      (choose-regular)))

        new-variant               (when new-variant
                                    (->> (:variants font)
                                         (filter #(= (:id %) new-variant))
                                         first))]
    (when new-variant
      {:font-variant-id (:id new-variant)
       :font-weight (:weight new-variant)
       :font-style (:style new-variant)})))

(defn calculate-text-values
  [shape]
  (let [state-map    (cond
                       (features/active-feature? @st/state "text-editor-wasm/v1")
                       (deref refs/workspace-wasm-editor-styles)

                       (features/active-feature? @st/state "text-editor/v2")
                       (deref refs/workspace-v2-editor-state)

                       :else
                       (deref refs/workspace-editor-state))

        editor-styles (when (features/active-feature? @st/state "text-editor-wasm/v1")
                        (get state-map (:id shape)))

        editor-state  (when-not (features/active-feature? @st/state "text-editor/v2")
                        (get state-map (:id shape)))

        editor-instance (when (features/active-feature? @st/state "text-editor/v2")
                          (deref refs/workspace-editor))]
    (d/merge
     (dwt/current-root-values
      {:shape shape
       :attrs txt/root-attrs})
     (dwt/current-paragraph-values
      {:editor-styles editor-styles
       :editor-state editor-state
       :editor-instance editor-instance
       :shape shape
       :attrs txt/paragraph-attrs})
     (dwt/current-text-values
      {:editor-styles editor-styles
       :editor-state editor-state
       :editor-instance editor-instance
       :shape shape
       :attrs txt/text-node-attrs}))))

(defn- update-attrs [shape props]
  (let [text-values    (calculate-text-values shape)
        font-size      (d/parse-double (:font-size text-values))
        props (cond
                (:font-size-inc props)
                {:font-size (str (inc font-size))}
                (:font-size-dec props)
                {:font-size (str (dec font-size))}
                (= (:text-decoration props) "toggle-underline") ;;toggle
                (if (= (:text-decoration text-values) "underline")
                  {:text-decoration "none"}
                  {:text-decoration "underline"})
                (= (:text-decoration props) "toggle-line-through") ;;toggle
                (if (= (:text-decoration text-values) "line-through")
                  {:text-decoration "none"}
                  {:text-decoration "line-through"})
                (:font-variant-id props)
                (generate-variant-props text-values (:font-variant-id props))
                ;; zvena: Figma lists (Ctrl+Shift+8 / Ctrl+Shift+7)
                (= (:list-type props) "toggle-unordered")
                (if (= (:list-type text-values) "unordered") {:list-type "none"} {:list-type "unordered"})
                (= (:list-type props) "toggle-ordered")
                (if (= (:list-type text-values) "ordered") {:list-type "none"} {:list-type "ordered"})
                :else props)]

    (when (and shape props)
      (st/emit! (dwt/update-attrs (:id shape) props)))))

(defn blend-props
  [shapes props]
  (let [text-values (map calculate-text-values shapes)
        all-underline? (every? #(= (:text-decoration %) "underline") text-values)
        all-line-through? (every? #(= (:text-decoration %) "line-through") text-values)
        all-bold? (every? #(is-bold? (:font-variant-id %)) text-values)
        all-italic? (every? #(is-italic? (:font-variant-id %)) text-values)]
    (cond
      (= (:text-decoration props) "toggle-underline")
      (if all-underline?
        {:text-decoration "none"}
        {:text-decoration "underline"})
      (= (:text-decoration props) "toggle-line-through")
      (if all-line-through?
        {:text-decoration "none"}
        {:text-decoration "line-through"})
      (= (:font-variant-id props) "toggle-bold")
      (if all-bold?
        {:font-variant-id "remove-bold"}
        {:font-variant-id "add-bold"})
      (= (:font-variant-id props) "toggle-italic")
      (if all-italic?
        {:font-variant-id "remove-italic"}
        {:font-variant-id "add-italic"})
      ;; zvena: Figma lists
      (= (:list-type props) "toggle-unordered")
      (if (every? #(= (:list-type %) "unordered") text-values) {:list-type "none"} {:list-type "unordered"})
      (= (:list-type props) "toggle-ordered")
      (if (every? #(= (:list-type %) "ordered") text-values) {:list-type "none"} {:list-type "ordered"})
      :else
      props)))

(def ^:private selected-shapes-with-children
  "A derived state that resolves to a lazy sequence of all selected
  shapes and its children."
  (l/derived
   (fn [{:keys [objects selected]}]
     (let [xform (comp (remove nil?)
                       (mapcat #(cfh/get-children-ids objects %)))
           shapes (into selected xform selected)]
       (sequence (keep (d/getf objects)) shapes)))
   ;; WORKAROUND: we should not use it here, but util we restructure
   ;; this, the simplest way is just deref private var
   @#'refs/selected-shapes-data))

(defn- update-attrs-when-no-readonly [props]
  (let [undo-id     (js/Symbol)

        can-edit?   (:can-edit (deref refs/permissions))
        read-only?  (deref refs/workspace-read-only?)

        text-shapes (->> (deref selected-shapes-with-children)
                         (filter cfh/text-shape?)
                         (not-empty))

        props       (if (> (count text-shapes) 1)
                      (blend-props text-shapes props)
                      props)]

    (when (and can-edit?
               (not read-only?)
               (some? text-shapes))
      (st/emit! (dwu/start-undo-transaction undo-id))
      (run! #(update-attrs % props) text-shapes)
      (st/emit! (dwu/commit-undo-transaction undo-id)))))

(def shortcuts
  {;; zvena: Figma lists
   :text-list-unordered {:tooltip (ds/meta-shift "8")
                         :command (ds/c-mod "shift+8")
                         :subsections [:text-editor]
                         :section [:workspace]
                         :fn #(update-attrs-when-no-readonly {:list-type "toggle-unordered"})}

   :text-list-ordered   {:tooltip (ds/meta-shift "7")
                         :command (ds/c-mod "shift+7")
                         :subsections [:text-editor]
                         :section [:workspace]
                         :fn #(update-attrs-when-no-readonly {:list-type "toggle-ordered"})}

   :underline     {:tooltip (ds/meta "U")
                   :command (ds/c-mod "u")
                   :subsections [:text-editor]
                   :section [:workspace]
                   :fn #(update-attrs-when-no-readonly {:text-decoration "toggle-underline"})}

   ;; zvena: Figma's Ctrl+Shift+X (Alt+Shift+5 kept; the old tooltip
   ;; showed a Ctrl that was never bound)
   :line-through  {:tooltip (ds/meta-shift "X")
                   :command [(ds/c-mod "shift+x") "alt+shift+5"]
                   :subsections [:text-editor]
                   :section [:workspace]
                   ;; zvena: on other layers it is Figma's Swap fill and stroke
                   :fn #(if (some cfh/text-shape? (deref selected-shapes-with-children))
                          (update-attrs-when-no-readonly {:text-decoration "toggle-line-through"})
                          (when (and (:can-edit (deref refs/permissions))
                                     (not (deref refs/workspace-read-only?)))
                            (st/emit! (zfills/swap-fill-stroke))))}

   :font-size-inc {:tooltip (ds/meta-shift ">")
                   :command (ds/c-mod "shift+.")
                   :subsections [:text-editor]
                   :section [:workspace]
                   :fn #(update-attrs-when-no-readonly {:font-size-inc true})}

   :font-size-dec {:tooltip (ds/meta-shift "<")
                   :command (ds/c-mod "shift+,")
                   :subsections [:text-editor]
                   :section [:workspace]
                   :fn #(update-attrs-when-no-readonly {:font-size-dec true})}

   :bold     {:tooltip (ds/meta "B")
              :command (ds/c-mod "b")
              :subsections [:text-editor]
              :section [:workspace]
              :fn #(update-attrs-when-no-readonly {:font-variant-id "toggle-bold"})}

   :italic     {:tooltip (ds/meta "I")
                :command (ds/c-mod "i")
                :subsections [:text-editor]
                :section [:workspace]
                :fn #(update-attrs-when-no-readonly {:font-variant-id "toggle-italic"})}

   ;; zvena: Figma's text alignment keys. Not named :align-* — this map is
   ;; merged into the workspace one, where :align-* align layers.
   :text-align-left    {:tooltip (ds/meta-alt "L")
                        :command (ds/ca-mod "l")
                        :subsections [:text-editor]
                        :section [:workspace]
                        :fn #(update-attrs-when-no-readonly {:text-align "left"})}

   :text-align-center  {:tooltip (ds/meta-alt "T")
                        :command (ds/ca-mod "t")
                        :subsections [:text-editor]
                        :section [:workspace]
                        :fn #(update-attrs-when-no-readonly {:text-align "center"})}

   :text-align-right   {:tooltip (ds/meta-alt "R")
                        :command (ds/ca-mod "r")
                        :subsections [:text-editor]
                        :section [:workspace]
                        :fn #(update-attrs-when-no-readonly {:text-align "right"})}

   :text-align-justify {:tooltip (ds/meta-alt "J")
                        :command (ds/ca-mod "j")
                        :subsections [:text-editor]
                        :section [:workspace]
                        :fn #(update-attrs-when-no-readonly {:text-align "justify"})}})



