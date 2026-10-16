;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-type-settings
  "zvena: Figma's \"Type settings\" panel of the Typography section: a
  popover next to the right panel with the Basics, Details and Variable
  tabs.

  - Basics: the rows given as children by the text menu (decoration,
    letter case, vertical trim, list style, paragraph spacing, truncation,
    resizing and direction).
  - Details: paragraph indent, hanging lists and the OpenType features
    (letter case, numbers, letterforms, stylistic sets, character
    variants). Features the font lacks are greyed out, like in Figma.
  - Variable: one slider per axis, only for variable fonts.

  The features and axes of a text run are stored as CSS
  font-feature-settings / font-variation-settings values, see
  app.common.types.text."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.math :as mth]
   [app.common.types.text :as txt]
   [app.main.features :as features]
   [app.main.store :as st]
   [app.main.ui.components.numeric-input :as deprecated-input]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.hooks :as hooks]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [app.util.zvena-font-info :as zfi]
   [cuerdas.core :as str]
   [goog.events :as events]
   [promesa.core :as p]
   [rumext.v2 :as mf]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Helpers
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def ^:private panel-width 256)

(def ^:private default-on-features
  "Features the browsers (and Figma) turn on by default."
  #{"liga" "calt"})

(defn- features-of
  [values]
  (let [value (:font-feature-settings values)]
    (if (string? value)
      (txt/font-features {:font-feature-settings value})
      {})))

(defn- variations-of
  [values]
  (let [value (:font-variation-settings values)]
    (if (string? value)
      (txt/font-variations {:font-variation-settings value})
      {})))

(defn- feature-on?
  [features tag]
  (let [value (get features tag)]
    (if (contains? default-on-features tag)
      (or (nil? value) (not (zero? value)))
      (and (some? value) (not (zero? value))))))

(defn- supported?
  "Unknown font info (not read yet or unreadable): everything is offered."
  [info tag]
  (or (nil? info) (contains? (:features info) tag)))

(defn- feature-change
  "The change of `tag` for a toggle turned `on?` (default-on features are
  stored only when turned off)."
  [tag on?]
  (if (contains? default-on-features tag)
    {tag (when-not on? 0)}
    {tag (when on? 1)}))

(defn- use-font-info
  [font-id variant-id]
  (let [info* (mf/use-state nil)]
    (mf/with-effect [font-id variant-id]
      (reset! info* nil)
      (let [mounted? (volatile! true)]
        (when (string? font-id)
          (p/then (zfi/font-info font-id (when (string? variant-id) variant-id))
                  (fn [info]
                    (when @mounted?
                      (reset! info* info)))))
        (fn [] (vreset! mounted? false))))
    (deref info*)))

(defn- attr->input-value
  [value]
  (if (or (nil? value) (= value :multiple)) "" value))

(defn- format-axis-value
  [value]
  (let [value (mth/precision value 2)]
    (if (== value (mth/floor value))
      (dm/str (long value))
      (dm/str value))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Building blocks
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(mf/defc setting-row*
  "A row of the panel: a label and its control (full width without label)."
  [{:keys [label class children]}]
  [:div {:class [class (stl/css :setting-row)]}
   (when (some? label)
     [:span {:class (stl/css :setting-label) :title label} label])
   [:div {:class (stl/css-case :setting-control true
                               :setting-control-full (nil? label))}
    children]])

(mf/defc segmented*
  "Figma segmented control. `options`: [{:value :label :title :disabled}],
  `allow-empty`: clicking the selected option clears it (on-change nil)."
  {::mf/private true}
  [{:keys [options selected on-change allow-empty aria-label]}]
  (let [on-click
        (mf/use-fn
         (mf/deps on-change selected allow-empty)
         (fn [event]
           (let [value (dom/get-data (dom/get-current-target event) "value")]
             (if (= value selected)
               (when allow-empty (on-change nil))
               (on-change value)))))]
    [:div {:class (stl/css :segmented)
           :role "radiogroup"
           :aria-label aria-label}
     (for [{:keys [value label title disabled]} options]
       [:button {:key value
                 :type "button"
                 :role "radio"
                 :aria-checked (= value selected)
                 :aria-label title
                 :title title
                 :disabled (boolean disabled)
                 :data-value value
                 :class (stl/css-case :segment true
                                      :segment-selected (= value selected))
                 :on-click on-click}
        label])]))

(mf/defc toggle-row*
  "A checkbox row turning a value on and off."
  {::mf/private true}
  [{:keys [label checked disabled on-toggle value]}]
  (let [id (mf/use-id)
        on-change
        (mf/use-fn
         (mf/deps on-toggle value checked)
         (fn [_] (on-toggle value (not checked))))]
    [:> checkbox* {:id id
                   :class (stl/css :toggle-row)
                   :label label
                   :checked (boolean checked)
                   :disabled (boolean disabled)
                   :on-change on-change}]))

(mf/defc section*
  {::mf/private true}
  [{:keys [title children]}]
  [:div {:class (stl/css :section)}
   [:div {:class (stl/css :section-title)} title]
   children])

(defn- trim-icon
  [cap?]
  (mf/html
   [:svg {:class (stl/css :trim-icon)
          :view-box "0 0 16 16"
          :width 16
          :height 16
          :fill "none"
          :stroke "currentColor"
          :stroke-width 1
          :aria-hidden true}
    [:path {:d (if cap? "M2 4.5h12M2 11.5h12" "M2 1.5h12M2 14.5h12")}]
    [:path {:d "M5.25 11.5 8 4.5l2.75 7M6.3 9h3.4"}]]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Basics rows (rendered by the text menu)
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(mf/defc letter-case-options*
  "Figma \"Letter case\": As typed, Uppercase, Lowercase, Title case and
  Small caps (the smcp feature, greyed out when the font lacks it)."
  [{:keys [values on-change on-blur]}]
  (let [features    (features-of values)
        info        (use-font-info (:font-id values) (:font-variant-id values))
        small-caps? (feature-on? features "smcp")
        transform   (:text-transform values)
        selected    (cond
                      small-caps? "small-caps"
                      (contains? #{"uppercase" "lowercase" "capitalize"} transform) transform
                      (= transform :multiple) nil
                      :else "none")

        options
        [{:value "none"       :label "–" :title (tr "zvena.text.case-as-typed")}
         {:value "uppercase"  :label "AG"     :title (tr "zvena.text.case-uppercase")}
         {:value "lowercase"  :label "ag"     :title (tr "zvena.text.case-lowercase")}
         {:value "capitalize" :label "Ag"     :title (tr "zvena.text.case-title")}
         {:value "small-caps" :label "Aɢ" :title (tr "zvena.text.case-small-caps")
          :disabled (and (not small-caps?) (not (supported? info "smcp")))}]

        handle-change
        (mf/use-fn
         (mf/deps values on-change on-blur)
         (fn [value]
           (let [unset (if (features/active-feature? @st/state "text-editor/v2") "none" "unset")
                 css   (:font-feature-settings values)
                 smcp? (contains? (features-of values) "smcp")
                 attrs (if (= value "small-caps")
                         {:text-transform unset
                          :font-feature-settings (txt/update-font-features css {"smcp" 1})}
                         (cond-> {:text-transform (if (= value "none") unset value)}
                           smcp?
                           (assoc :font-feature-settings (txt/update-font-features css {"smcp" nil}))))]
             (on-change attrs)
             (when (some? on-blur) (on-blur)))))]

    [:> segmented* {:options options
                    :selected selected
                    :aria-label (tr "zvena.text.letter-case")
                    :on-change handle-change}]))

(mf/defc vertical-trim-options*
  "Figma \"Vertical trim\": Standard or Cap height to baseline."
  [{:keys [values on-change on-blur]}]
  (let [trim     (:vertical-trim values)
        selected (cond
                   (= trim :multiple)     nil
                   (= trim "cap-height")  "cap-height"
                   :else                  "standard")
        options
        [{:value "standard"   :label (trim-icon false) :title (tr "zvena.text.vertical-trim-standard")}
         {:value "cap-height" :label (trim-icon true)  :title (tr "zvena.text.vertical-trim-cap-height")}]

        handle-change
        (mf/use-fn
         (mf/deps on-change on-blur)
         (fn [value]
           (on-change {:vertical-trim value})
           (when (some? on-blur) (on-blur))))]

    [:> segmented* {:options options
                    :selected selected
                    :aria-label (tr "zvena.text.vertical-trim")
                    :on-change handle-change}]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Details tab
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- pair-selection
  "Selected tag of an exclusive pair of features (nil = font default)."
  [features tags]
  (d/seek #(feature-on? features %) tags))

(defn- pair-changes
  "Turns `value` on and the other tags of the exclusive pair off."
  [tags value]
  (into {} (map (fn [tag] [tag (when (= tag value) 1)])) tags))

(mf/defc details-tab*
  {::mf/private true}
  [{:keys [values on-change on-blur info]}]
  (let [features   (features-of values)
        indent     (:paragraph-indent values)
        hanging?   (= "true" (:hanging-list values))

        change-features!
        (mf/use-fn
         (mf/deps values on-change on-blur)
         (fn [changes]
           (on-change {:font-feature-settings
                       (txt/update-font-features (:font-feature-settings values) changes)})
           (when (some? on-blur) (on-blur))))

        on-toggle-feature
        (mf/use-fn
         (mf/deps change-features!)
         (fn [tag on?]
           (change-features! (feature-change tag on?))))

        on-spacing-change
        (mf/use-fn
         (mf/deps change-features!)
         (fn [value] (change-features! (pair-changes ["pnum" "tnum"] value))))

        on-style-change
        (mf/use-fn
         (mf/deps change-features!)
         (fn [value] (change-features! (pair-changes ["lnum" "onum"] value))))

        on-position-change
        (mf/use-fn
         (mf/deps change-features!)
         (fn [value] (change-features! (pair-changes ["sups" "subs"] value))))

        on-indent-change
        (mf/use-fn
         (mf/deps on-change)
         (fn [value]
           (on-change {:paragraph-indent (if (and (d/num? value) (pos? value))
                                           (dm/str (mth/precision value 2))
                                           "0")})))

        on-toggle-hanging
        (mf/use-fn
         (mf/deps on-change on-blur)
         (fn [_ on?]
           (on-change {:hanging-list (if on? "true" "false")})
           (when (some? on-blur) (on-blur))))

        toggle
        (fn [tag label]
          (mf/html
           [:> toggle-row* {:key tag
                            :value tag
                            :label label
                            :checked (feature-on? features tag)
                            :disabled (and (not (contains? features tag))
                                           (not (supported? info tag)))
                            :on-toggle on-toggle-feature}]))

        pair-option
        (fn [tag label title]
          {:value tag
           :label label
           :title title
           :disabled (and (not (contains? features tag))
                          (not (supported? info tag)))})

        stylistic-sets
        (if (some? info)
          (->> (:features info) (filter #(re-matches #"ss\d\d" %)) (sort) (vec))
          ["ss01" "ss02" "ss03" "ss04" "ss05"])

        character-variants
        (->> (:features info) (filter #(re-matches #"cv\d\d" %)) (sort) (vec))]

    [:*
     [:> setting-row* {:label (tr "zvena.text.paragraph-indent")}
      [:div {:class (stl/css :input-wrapper)}
       [:> deprecated-input/numeric-input*
        {:min 0
         :max 1000
         :step 1
         :default 0
         :aria-label (tr "zvena.text.paragraph-indent")
         :value (attr->input-value indent)
         :placeholder (if (= :multiple indent) (tr "settings.multiple") "0")
         :is-nillable (= :multiple indent)
         :on-change on-indent-change
         :on-blur on-blur}]]]

     [:> toggle-row* {:value "hanging-list"
                      :label (tr "zvena.text.hanging-lists")
                      :checked hanging?
                      :on-toggle on-toggle-hanging}]

     [:> section* {:title (tr "zvena.text.letter-case")}
      (toggle "case" (tr "zvena.text.case-sensitive-forms"))
      (toggle "cpsp" (tr "zvena.text.capital-spacing"))]

     [:> section* {:title (tr "zvena.text.numbers")}
      [:> setting-row* {:label (tr "zvena.text.numbers-style")}
       [:> segmented* {:options [(pair-option "lnum" (tr "zvena.text.numbers-lining") (tr "zvena.text.numbers-lining"))
                                 (pair-option "onum" (tr "zvena.text.numbers-oldstyle") (tr "zvena.text.numbers-oldstyle"))]
                       :selected (pair-selection features ["lnum" "onum"])
                       :allow-empty true
                       :aria-label (tr "zvena.text.numbers-style")
                       :on-change on-style-change}]]
      [:> setting-row* {:label (tr "zvena.text.numbers-spacing")}
       [:> segmented* {:options [(pair-option "pnum" (tr "zvena.text.numbers-proportional") (tr "zvena.text.numbers-proportional"))
                                 (pair-option "tnum" (tr "zvena.text.numbers-tabular") (tr "zvena.text.numbers-tabular"))]
                       :selected (pair-selection features ["pnum" "tnum"])
                       :allow-empty true
                       :aria-label (tr "zvena.text.numbers-spacing")
                       :on-change on-spacing-change}]]
      [:> setting-row* {:label (tr "zvena.text.position")}
       [:> segmented* {:options [{:value "none" :label "–" :title (tr "zvena.text.position-none")}
                                 (pair-option "sups" "x²" (tr "zvena.text.position-superscript"))
                                 (pair-option "subs" "x₂" (tr "zvena.text.position-subscript"))]
                       :selected (or (pair-selection features ["sups" "subs"]) "none")
                       :aria-label (tr "zvena.text.position")
                       :on-change on-position-change}]]
      (toggle "frac" (tr "zvena.text.fractions"))
      (toggle "zero" (tr "zvena.text.slashed-zero"))]

     [:> section* {:title (tr "zvena.text.letterforms")}
      (toggle "liga" (tr "zvena.text.ligatures"))
      (toggle "dlig" (tr "zvena.text.rare-ligatures"))
      (toggle "calt" (tr "zvena.text.contextual-alternates"))
      (toggle "ordn" (tr "zvena.text.ordinals"))]

     (when (seq stylistic-sets)
       [:> section* {:title (tr "zvena.text.stylistic-sets")}
        (for [tag stylistic-sets]
          (toggle tag (str/upper tag)))])

     (when (seq character-variants)
       [:> section* {:title (tr "zvena.text.character-variants")}
        (for [tag character-variants]
          (toggle tag (str/upper tag)))])]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Variable tab
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- axis-label
  [{:keys [tag name]}]
  (case tag
    "wght" (tr "zvena.text.axis-weight")
    "wdth" (tr "zvena.text.axis-width")
    "slnt" (tr "zvena.text.axis-slant")
    "ital" (tr "zvena.text.axis-italic")
    "opsz" (tr "zvena.text.axis-optical-size")
    (or name tag)))

(defn- axis-step
  [{:keys [min max]}]
  (let [range (- max min)]
    (cond
      (<= range 2)  0.01
      (<= range 50) 0.1
      :else         1)))

(mf/defc axis-row*
  {::mf/private true}
  [{:keys [axis value on-commit]}]
  (let [{:keys [tag min max]} axis
        current*   (mf/use-state value)
        current    (deref current*)
        ;; the value being dragged, read when the drag ends
        latest-ref (mf/use-ref value)
        step       (axis-step axis)

        on-input
        (mf/use-fn
         (fn [event]
           (let [v (d/parse-double (dom/get-target-val event))]
             (when (some? v)
               (mf/set-ref-val! latest-ref v)
               (reset! current* v)))))

        commit
        (mf/use-fn
         (mf/deps tag value on-commit)
         (fn [_]
           (let [v (mf/ref-val latest-ref)]
             (when (and (some? v) (not= v value))
               (on-commit tag v)))))

        on-number-change
        (mf/use-fn
         (mf/deps tag on-commit)
         (fn [v]
           (when (d/num? v)
             (on-commit tag v))))]

    (mf/with-effect [value]
      (mf/set-ref-val! latest-ref value)
      (reset! current* value))

    [:div {:class (stl/css :axis-row)}
     [:span {:class (stl/css :axis-label) :title tag} (axis-label axis)]
     [:input {:class (stl/css :axis-slider)
              :type "range"
              :min min
              :max max
              :step step
              :value current
              :aria-label (axis-label axis)
              :on-change on-input
              :on-pointer-up commit
              :on-key-up commit}]
     [:div {:class (stl/css :input-wrapper :axis-input)}
      [:> deprecated-input/numeric-input*
       {:min min
        :max max
        :step step
        :aria-label (axis-label axis)
        :value (format-axis-value current)
        :on-change on-number-change}]]]))

(mf/defc variable-tab*
  {::mf/private true}
  [{:keys [values on-change info]}]
  (let [variations (variations-of values)
        axes       (:axes info)

        on-commit
        (mf/use-fn
         (mf/deps values on-change axes)
         (fn [tag value]
           (when-let [axis (d/seek #(= tag (:tag %)) axes)]
             (let [value (mth/clamp value (:min axis) (:max axis))
                   value (mth/precision value 2)]
               (on-change {:font-variation-settings
                           (txt/update-font-variations
                            (:font-variation-settings values)
                            {tag (when-not (mth/close? value (:default axis)) value)})})))))

        on-reset
        (mf/use-fn
         (mf/deps on-change)
         (fn [_]
           (on-change {:font-variation-settings "normal"})))]

    [:*
     (for [axis axes]
       [:> axis-row* {:key (:tag axis)
                      :axis axis
                      :value (get variations (:tag axis) (:default axis))
                      :on-commit on-commit}])
     [:button {:type "button"
               :class (stl/css :reset-button)
               :disabled (empty? variations)
               :on-click on-reset}
      (tr "zvena.text.axis-reset")]]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Panel
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- panel-position
  [^js anchor]
  (when (some? anchor)
    (let [rect   (dom/get-bounding-rect anchor)
          height (dom/get-window-height)
          left   (max 8 (- (:left rect) panel-width 24))
          top    (mth/clamp (- (:top rect) 8) 8 (max 8 (- height 360)))]
      {:left left
       :top top
       :max-height (- height top 8)})))

(mf/defc type-settings*
  "The popover. `anchor-ref`: the element it opens next to (the alignment
  row of the text menu); `children`: the Basics tab."
  [{:keys [values on-change on-blur on-close anchor-ref children]}]
  (let [info       (use-font-info (:font-id values) (:font-variant-id values))
        variable?  (boolean (seq (:axes info)))

        tab*       (mf/use-state "basics")
        tab        (deref tab*)
        tab        (if (and (= tab "variable") (not variable?)) "basics" tab)

        position*  (mf/use-state nil)
        position   (deref position*)

        container  (hooks/use-portal-container :popup)

        tabs
        (cond-> [{:id "basics"  :label (tr "zvena.text.tab-basics")}
                 {:id "details" :label (tr "zvena.text.tab-details")}]
          variable?
          (conj {:id "variable" :label (tr "zvena.text.tab-variable")}))

        on-tab-click
        (mf/use-fn
         (fn [event]
           (reset! tab* (dom/get-data (dom/get-current-target event) "id"))))

        on-key-down
        (mf/use-fn
         (mf/deps on-close)
         (fn [event]
           (when (kbd/esc? event)
             (dom/stop-propagation event)
             (dom/prevent-default event)
             (on-close))))

        on-key-up
        (mf/use-fn
         (fn [event]
           ;; the text editor leaves the edition on Esc key up
           (when (kbd/esc? event)
             (dom/stop-propagation event))))]

    (mf/with-layout-effect []
      (let [update! (fn [] (reset! position* (panel-position (mf/ref-val anchor-ref))))
            key     (events/listen js/window "resize" update!)]
        (update!)
        (fn [] (events/unlistenByKey key))))

    (mf/portal
     (mf/html
      [:div {:class (stl/css :type-settings)
             :role "dialog"
             :aria-label (tr "zvena.text.type-settings")
             :data-testid "zvena-type-settings"
             ;; a literal map: rumext only converts literal style maps
             :style {:left (:left position)
                     :top (:top position)
                     :max-height (:max-height position)
                     :visibility (if (some? position) "visible" "hidden")}
             :on-key-down on-key-down
             :on-key-up on-key-up}
       [:div {:class (stl/css :header)}
        [:div {:class (stl/css :tabs) :role "tablist"}
         (for [{:keys [id label]} tabs]
           [:button {:key id
                     :type "button"
                     :role "tab"
                     :aria-selected (= id tab)
                     :data-id id
                     :class (stl/css-case :tab true
                                          :tab-selected (= id tab))
                     :on-click on-tab-click}
            label])]
        [:> icon-button* {:variant "ghost"
                          :aria-label (tr "labels.close")
                          :on-click on-close
                          :icon i/close}]]

       [:div {:class (stl/css :body)}
        (case tab
          "details"
          [:> details-tab* {:values values
                            :on-change on-change
                            :on-blur on-blur
                            :info info}]

          "variable"
          [:> variable-tab* {:values values
                             :on-change on-change
                             :info info}]

          children)]])
     container)))
