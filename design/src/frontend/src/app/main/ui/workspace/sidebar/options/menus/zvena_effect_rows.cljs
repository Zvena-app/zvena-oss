;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.sidebar.options.menus.zvena-effect-rows
  "zvena: the list of Figma effects (one row per effect: settings button,
  type select, eye, remove; settings below the row). Edits an effects
  value (app.common.types.shape.zvena-effects/get-effects) through
  `on-change`, which gets a function effects -> effects: the Effects
  section applies it to the selected layers, the style editor to a
  style."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.common.types.shape.zvena-effects :as zfx]
   [app.main.data.workspace.undo :as dwu]
   [app.main.data.workspace.zvena-styles :as zst]
   [app.main.store :as st]
   [app.main.ui.components.numeric-input :as deprecated-input]
   [app.main.ui.components.select :refer [select]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.controls.radio-buttons :refer [radio-buttons*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.workspace.sidebar.options.rows.color-row :refer [color-row*]]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(def types
  [:drop-shadow :inner-shadow :layer-blur :background-blur :noise :texture])

(defn type-label
  [type]
  (case type
    :drop-shadow     (tr "zvena.effects.drop-shadow")
    :inner-shadow    (tr "zvena.effects.inner-shadow")
    :layer-blur      (tr "zvena.effects.layer-blur")
    :background-blur (tr "zvena.effects.background-blur")
    :noise           (tr "zvena.effects.noise")
    :texture         (tr "zvena.effects.texture")
    (str type)))

(defn type-icon
  [type]
  (case type
    :drop-shadow  i/drop-shadow
    :inner-shadow i/inner-shadow
    (:layer-blur :background-blur) i/filter
    i/effects))

;; --- Pure operations on an effects value

(defn effect-rows
  "One row per effect, in the panel order: shadows, layer blur,
  background blur, noise, texture."
  [effects]
  (-> []
      (into (map-indexed (fn [index shadow]
                           {:kind :shadow
                            :index index
                            :type (:style shadow)
                            :value shadow
                            :key (dm/str "shadow-" index "-" (:id shadow))}))
            (:shadow effects))
      (cond->
       (some? (:blur effects))
        (conj {:kind :layer-blur :type :layer-blur :value (:blur effects) :key "layer-blur"})

        (some? (:background-blur effects))
        (conj {:kind :background-blur :type :background-blur :value (:background-blur effects) :key "background-blur"})

        (some? (:noise effects))
        (conj {:kind :noise :type :noise :value (:noise effects) :key "noise"})

        (some? (:texture effects))
        (conj {:kind :texture :type :texture :value (:texture effects) :key "texture"}))))

(defn- kind-key
  [kind]
  (case kind
    :layer-blur      :blur
    :background-blur :background-blur
    :noise           :noise
    :texture         :texture
    nil))

(defn- update-row
  [effects {:keys [kind index]} f]
  (if (= kind :shadow)
    (if (< index (count (:shadow effects)))
      (update-in effects [:shadow index] f)
      effects)
    (let [k (kind-key kind)]
      (if (some? (get effects k))
        (update effects k f)
        effects))))

(defn- remove-row
  [effects {:keys [kind index]}]
  (if (= kind :shadow)
    (update effects :shadow
            (fn [shadows]
              (into [] (keep-indexed (fn [i shadow] (when (not= i index) shadow))) shadows)))
    (assoc effects (kind-key kind) nil)))

(defn- new-effect
  "A new effect of `type` (a blur keeps the amount of the effect it
  replaces)."
  [type old]
  (case type
    (:drop-shadow :inner-shadow)
    (zst/default-shadow type)

    (:layer-blur :background-blur)
    ;; only blurs have a :value
    (cond-> (zst/default-blur type)
      (number? (:value old))
      (assoc :value (:value old)))

    :noise   zfx/default-noise
    :texture zfx/default-texture))

(defn- change-type
  [effects row type]
  (cond
    (= type (:type row))
    effects

    (and (= :shadow (:kind row))
         (contains? #{:drop-shadow :inner-shadow} type))
    (update-row effects row #(assoc % :style type))

    :else
    (let [effects (remove-row effects row)
          effect  (new-effect type (:value row))]
      (case type
        (:drop-shadow :inner-shadow) (update effects :shadow #(into [effect] %))
        :layer-blur                  (assoc effects :blur effect)
        :background-blur             (assoc effects :background-blur effect)
        :noise                       (assoc effects :noise effect)
        :texture                     (assoc effects :texture effect)))))

(defn taken-types
  "The effect types a layer can only have once and already has."
  [effects]
  (cond-> #{}
    (some? (:blur effects))            (conj :layer-blur)
    (some? (:background-blur effects)) (conj :background-blur)
    (some? (:noise effects))           (conj :noise)
    (some? (:texture effects))         (conj :texture)))

(defn add-drop-shadow
  "Figma's \"+\": a new drop shadow on top."
  [effects]
  (update effects :shadow #(into [(zst/default-shadow)] %)))

;; --- Fields

(mf/defc num-field*
  {::mf/private true}
  [{:keys [label title value on-change min max class]}]
  (let [on-change
        (mf/use-fn
         (mf/deps on-change)
         (fn [value]
           (when (and (number? value) (not (js/isNaN value)))
             (on-change value))))]
    [:div {:class [class (stl/css :num-field)]
           :title (or title label)}
     [:span {:class (stl/css :num-label)} label]
     [:> deprecated-input/numeric-input* {:no-validate true
                                          :placeholder "--"
                                          :min min
                                          :max max
                                          :value value
                                          :on-change on-change}]]))

(defn- percent
  [v]
  (when (number? v)
    (/ (js/Math.round (* v 1000)) 10)))

(mf/defc effect-color*
  {::mf/private true}
  [{:keys [color on-change on-detach]}]
  (let [on-open  (mf/use-fn #(st/emit! (dwu/start-undo-transaction :color-row)))
        on-close (mf/use-fn #(st/emit! (dwu/commit-undo-transaction :color-row)))]
    [:> color-row* {:class (stl/css :effect-color)
                    :color color
                    :title (tr "zvena.effects.color")
                    :disable-gradient true
                    :disable-image true
                    :origin :shadow
                    :on-change on-change
                    :on-detach on-detach
                    :on-open on-open
                    :on-close on-close}]))

;; --- Settings of each kind of effect

(mf/defc shadow-settings*
  {::mf/private true}
  [{:keys [value type row-key on-update]}]
  (let [setters
        (mf/with-memo [on-update]
          (into {}
                (map (fn [attr]
                       [attr (fn [v]
                               (on-update #(assoc % attr (if (= attr :blur) (max 0 v) v))))]))
                [:offset-x :offset-y :blur :spread]))

        on-color
        (mf/use-fn
         (mf/deps on-update)
         (fn [color]
           (on-update #(assoc % :color (-> color
                                           (select-keys [:color :opacity :id :file-id :ref-id :ref-file])
                                           (update :opacity (fn [o] (if (number? o) o 1))))))))

        on-detach
        (mf/use-fn
         (mf/deps on-update)
         (fn []
           (on-update #(update % :color dissoc :id :file-id :ref-id :ref-file))))

        show-behind? (zfx/shadow-show-behind? value)

        on-show-behind
        (mf/use-fn
         (mf/deps on-update show-behind?)
         (fn [_]
           (on-update #(assoc % :show-behind (not show-behind?)))))]

    [:div {:class (stl/css :settings)}
     [:div {:class (stl/css :settings-row)}
      [:> num-field* {:label "X"
                      :title (tr "workspace.options.shadow-options.offsetx")
                      :value (:offset-x value)
                      :on-change (:offset-x setters)}]
      [:> num-field* {:label "Y"
                      :title (tr "workspace.options.shadow-options.offsety")
                      :value (:offset-y value)
                      :on-change (:offset-y setters)}]]
     [:div {:class (stl/css :settings-row)}
      [:> num-field* {:label (tr "zvena.effects.blur")
                      :min 0
                      :value (:blur value)
                      :on-change (:blur setters)}]
      [:> num-field* {:label (tr "zvena.effects.spread")
                      :value (:spread value)
                      :on-change (:spread setters)}]]
     [:div {:class (stl/css :settings-row)}
      [:> effect-color* {:color (:color value)
                         :on-change on-color
                         :on-detach on-detach}]]
     (when (= type :drop-shadow)
       [:div {:class (stl/css :settings-row)}
        [:> checkbox* {:id (dm/str "zvena-show-behind-" row-key)
                       :label (tr "zvena.effects.show-behind")
                       :checked show-behind?
                       :on-change on-show-behind}]])]))

(mf/defc blur-settings*
  {::mf/private true}
  [{:keys [value on-update]}]
  (let [on-change
        (mf/use-fn
         (mf/deps on-update)
         (fn [v]
           (on-update #(assoc % :value (max 0 v)))))]
    [:div {:class (stl/css :settings)}
     [:div {:class (stl/css :settings-row)}
      [:> num-field* {:label (tr "zvena.effects.blur")
                      :min 0
                      :value (:value value)
                      :on-change on-change}]]]))

(mf/defc noise-settings*
  {::mf/private true}
  [{:keys [value row-key on-update]}]
  (let [noise-type (:noise-type value)

        options
        (mf/with-memo [row-key]
          [{:id (dm/str "zvena-noise-mono-" row-key) :label (tr "zvena.effects.noise-mono") :value "mono"}
           {:id (dm/str "zvena-noise-duo-" row-key) :label (tr "zvena.effects.noise-duo") :value "duo"}
           {:id (dm/str "zvena-noise-multi-" row-key) :label (tr "zvena.effects.noise-multi") :value "multi"}])

        on-type
        (mf/use-fn
         (mf/deps on-update)
         (fn [v _]
           (when (some? v)
             (on-update #(assoc % :noise-type (keyword v))))))

        on-size
        (mf/use-fn
         (mf/deps on-update)
         (fn [v] (on-update #(assoc % :size (max 0.01 v)))))

        on-density
        (mf/use-fn
         (mf/deps on-update)
         (fn [v] (on-update #(assoc % :density (/ (max 0 (min 100 v)) 100)))))

        on-opacity
        (mf/use-fn
         (mf/deps on-update)
         (fn [v] (on-update #(assoc % :opacity (/ (max 0 (min 100 v)) 100)))))

        on-color
        (mf/use-fn
         (mf/deps on-update)
         (fn [color]
           (on-update #(assoc % :color (select-keys color [:color :opacity])))))

        on-color2
        (mf/use-fn
         (mf/deps on-update)
         (fn [color]
           (on-update #(assoc % :color2 (select-keys color [:color :opacity])))))

        on-detach (mf/use-fn (fn [] nil))]

    [:div {:class (stl/css :settings)}
     [:div {:class (stl/css :settings-row)}
      [:> radio-buttons* {:class (stl/css :noise-types)
                          :name (dm/str "zvena-noise-type-" row-key)
                          :selected (name (or noise-type :mono))
                          :extended true
                          :options options
                          :on-change on-type}]]
     [:div {:class (stl/css :settings-row)}
      [:> num-field* {:label (tr "zvena.effects.noise-size")
                      :class (stl/css :wide-field)
                      :min 0.01
                      :value (:size value)
                      :on-change on-size}]]
     [:div {:class (stl/css :settings-row)}
      [:> num-field* {:label (tr "zvena.effects.density")
                      :class (stl/css :wide-field)
                      :min 0
                      :max 100
                      :value (percent (:density value))
                      :on-change on-density}]]
     (case noise-type
       :multi
       [:div {:class (stl/css :settings-row)}
        [:> num-field* {:label (tr "zvena.effects.opacity")
                        :class (stl/css :wide-field)
                        :min 0
                        :max 100
                        :value (percent (:opacity value))
                        :on-change on-opacity}]]

       :duo
       [:*
        [:div {:class (stl/css :settings-row)}
         [:> effect-color* {:color (:color value) :on-change on-color :on-detach on-detach}]]
        [:div {:class (stl/css :settings-row)}
         [:> effect-color* {:color (:color2 value) :on-change on-color2 :on-detach on-detach}]]]

       [:div {:class (stl/css :settings-row)}
        [:> effect-color* {:color (:color value) :on-change on-color :on-detach on-detach}]])]))

(mf/defc texture-settings*
  {::mf/private true}
  [{:keys [value row-key on-update]}]
  (let [on-size
        (mf/use-fn
         (mf/deps on-update)
         (fn [v] (on-update #(assoc % :size (max 0.01 v)))))

        on-radius
        (mf/use-fn
         (mf/deps on-update)
         (fn [v] (on-update #(assoc % :radius (max 0 v)))))

        clip? (:clip value)

        on-clip
        (mf/use-fn
         (mf/deps on-update clip?)
         (fn [_] (on-update #(assoc % :clip (not clip?)))))]

    [:div {:class (stl/css :settings)}
     [:div {:class (stl/css :settings-row)}
      [:> num-field* {:label (tr "zvena.effects.size")
                      :min 0.01
                      :value (:size value)
                      :on-change on-size}]
      [:> num-field* {:label (tr "zvena.effects.radius")
                      :min 0
                      :value (:radius value)
                      :on-change on-radius}]]
     [:div {:class (stl/css :settings-row)}
      [:> checkbox* {:id (dm/str "zvena-texture-clip-" row-key)
                     :label (tr "zvena.effects.clip-to-shape")
                     :checked (boolean clip?)
                     :on-change on-clip}]]]))

;; --- Rows

(mf/defc effect-row*
  {::mf/private true}
  [{:keys [row taken is-open on-toggle-open on-change id-prefix]}]
  (let [{:keys [type value key kind]} row
        hidden?  (true? (:hidden value))
        row-key  (dm/str id-prefix "-" key)

        on-update
        (mf/use-fn
         (mf/deps row on-change)
         (fn [f]
           (on-change #(update-row % row f))))

        on-type
        (mf/use-fn
         (mf/deps row on-change taken)
         (fn [new-type]
           (let [new-type (keyword new-type)]
             (when-not (and (contains? taken new-type)
                            (not= new-type type))
               (on-change #(change-type % row new-type))))))

        on-remove
        (mf/use-fn
         (mf/deps row on-change)
         (fn [_]
           (on-change #(remove-row % row))))

        on-toggle-visibility
        (mf/use-fn
         (mf/deps on-update)
         (fn [_]
           (on-update #(update % :hidden not))))

        on-open
        (mf/use-fn
         (mf/deps key on-toggle-open)
         (fn [_]
           (on-toggle-open key)))

        options
        (mf/with-memo [taken type]
          (mapv (fn [t]
                  {:value t
                   :label (type-label t)
                   :disabled (and (contains? taken t) (not= t type))})
                types))]

    [:div {:class (stl/css :effect-row)
           :data-testid "zvena-effect-row"}
     [:div {:class (stl/css :effect-basic)}
      [:div {:class (stl/css :effect-basic-info)}
       [:> icon-button* {:variant "secondary"
                         :icon (type-icon type)
                         :class (stl/css-case :effect-settings-button true
                                              :selected is-open)
                         :aria-label (tr "zvena.effects.settings")
                         :disabled hidden?
                         :on-click on-open}]
       [:& select {:class (stl/css :effect-type-select)
                   :default-value type
                   :options options
                   :disabled hidden?
                   :on-change on-type}]]

      [:div {:class (stl/css :effect-basic-actions)}
       [:> icon-button* {:variant "ghost"
                         :aria-label (if hidden?
                                       (tr "zvena.effects.show")
                                       (tr "zvena.effects.hide"))
                         :on-click on-toggle-visibility
                         :icon (if hidden? i/hide i/shown)}]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "zvena.effects.remove")
                         :on-click on-remove
                         :icon i/remove}]]]

     (when (and is-open (not hidden?))
       (case kind
         :shadow
         [:> shadow-settings* {:value value :type type :row-key row-key :on-update on-update}]

         (:layer-blur :background-blur)
         [:> blur-settings* {:value value :on-update on-update}]

         :noise
         [:> noise-settings* {:value value :row-key row-key :on-update on-update}]

         :texture
         [:> texture-settings* {:value value :row-key row-key :on-update on-update}]

         nil))]))

(mf/defc effects-editor*
  "The rows of `effects`; `on-change` gets a function effects -> effects."
  [{:keys [effects on-change id-prefix]}]
  (let [rows    (mf/with-memo [effects] (effect-rows effects))
        taken   (mf/with-memo [effects] (taken-types effects))
        open*   (mf/use-state #{})
        open    (deref open*)

        on-toggle-open
        (mf/use-fn
         (fn [key]
           (swap! open* #(if (contains? % key) (disj % key) (conj % key)))))]

    [:div {:class (stl/css :effect-rows)}
     (for [row rows]
       [:> effect-row* {:key (:key row)
                        :row row
                        :taken taken
                        :id-prefix (or id-prefix "fx")
                        :is-open (contains? open (:key row))
                        :on-toggle-open on-toggle-open
                        :on-change on-change}])]))
