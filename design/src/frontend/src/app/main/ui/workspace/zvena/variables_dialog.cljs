;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.variables-dialog
  "zvena: Figma's Local variables dialog, a floating window over the
  canvas (which stays usable): collections on the left, the variables of
  the selected one in a table with a column per mode. Built on Penpot's
  design tokens, see app.main.data.workspace.tokens.zvena-variables for
  the mapping and the edits."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.math :as mth]
   [app.common.types.color :as cc]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.data.workspace.tokens.application :as dwta]
   [app.main.data.workspace.tokens.zvena-variables :as zvar]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.workspace.colorpicker :as cpk]
   [app.main.ui.workspace.colorpicker.ramp :refer [ramp-selector*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [beicon.v2.core :as rx]
   [clojure.string :as cstr]
   [cuerdas.core :as str]
   [goog.events :as events]
   [rumext.v2 :as mf]))

;; --- Helpers

(defn- px
  [n]
  (dm/str n "px"))

(defn- clamp-pos
  "Fixed position for a box of `w` x `h` at x, y, kept in the window."
  [x y w h]
  (let [vw (.-innerWidth js/window)
        vh (.-innerHeight js/window)]
    {:left (max 8 (min x (- vw w 8)))
     :top  (max 8 (min y (- vh h 8)))}))

(defn- type-icon
  [type]
  (case type
    :color           i/drop
    :boolean         i/switch
    :string          i/text
    :typography      i/text-typography
    :font-family     i/text-font-family
    :shadow          i/drop-shadow
    :text-case       i/text-mixed
    :text-decoration i/text-underlined
    (:number :dimensions :spacing :sizing :border-radius :opacity :rotation
     :font-size :stroke-width :letter-spacing :font-weight)
    i/number
    i/tokens))

(defn- type-label
  [type]
  (case type
    :color   (tr "zvena.variables.type.color")
    :number  (tr "zvena.variables.type.number")
    :string  (tr "zvena.variables.type.string")
    :boolean (tr "zvena.variables.type.boolean")
    (if (some? type) (dwta/token-type-title type) "")))

(defn- default-variable-name
  "Figma names a new variable after its type (Color, Color 2...)."
  [type]
  (case type
    :color   "Color"
    :number  "Number"
    :string  "String"
    :boolean "Boolean"
    "Variable"))

(defn- collection-label
  [coll]
  (cond
    (:implicit? coll)        (tr "zvena.variables.implicit-collection")
    (str/blank? (:name coll)) (tr "zvena.variables.ungrouped-collection")
    :else                    (:name coll)))

(defn- mode-label
  [mode]
  (if (= zvar/implicit-id (:id mode))
    (tr "zvena.variables.implicit-mode")
    (:name mode)))

(defn- implicit-names
  []
  {:collection (tr "zvena.variables.implicit-collection")
   :mode       (tr "zvena.variables.implicit-mode")})

(defn- slash-name
  "A token name the way Figma writes variable names: a/b/c."
  [name]
  (cstr/join "/" (zvar/name-path name)))

(defn- edit-text
  "The text a cell editor starts with."
  [type raw]
  (cond
    (nil? raw) ""
    (and (= type :color) (string? raw) (re-matches #"#[0-9a-fA-F]{6}" raw))
    (str/upper (subs raw 1))
    :else (str raw)))

(defn- color-literal
  "The literal stored for the color of a value (an alias detached)."
  [value]
  (when-let [{:keys [hash alpha]} (zvar/color-info value)]
    (zvar/color-value hash alpha)))

(defn- warn!
  [message]
  (st/emit! (ntf/show {:content message
                       :type :toast
                       :level :warning
                       :timeout 3000})))

(defn- table-rows
  "The rows of the table: the variables grouped by folder (in the order
  the folders first appear), each folder below `group` with a header."
  [variables group]
  (let [folder-of (fn [v] (zvar/variable-folder (:name v)))
        order     (into [] (comp (map folder-of) (distinct)) variables)
        by-folder (group-by folder-of variables)]
    (into []
          (mapcat (fn [folder]
                    (let [rows (map (fn [v] {:kind :variable :variable v})
                                    (get by-folder folder))]
                      (if (and (some? folder) (not= folder group))
                        (cons {:kind :folder :folder folder} rows)
                        rows))))
          order)))

(defn- relative-folder
  [folder group]
  (if (and (some? group) (str/starts-with? folder (str group ".")))
    (subs folder (inc (count group)))
    folder))

(defn- use-outside-pointer
  "Calls `on-outside` on a pointer down outside the node of `ref`."
  [ref on-outside]
  (mf/with-effect [on-outside]
    (let [handler (fn [event]
                    (let [node (mf/ref-val ref)]
                      (when (and (some? node)
                                 (not (.contains ^js node (dom/get-target event))))
                        (on-outside))))
          key     (events/listen js/document "pointerdown" handler true)]
      #(events/unlistenByKey key))))

;; --- Small components

(mf/defc inline-input*
  "A text field that commits on Enter or blur and cancels on Escape."
  {::mf/private true}
  [{:keys [value on-commit on-cancel class placeholder]}]
  (let [done* (mf/use-ref false)

        commit
        (mf/use-fn
         (mf/deps on-commit)
         (fn [event]
           (when-not (mf/ref-val done*)
             (mf/set-ref-val! done* true)
             (on-commit (dom/get-target-val event)))))

        on-key-down
        (mf/use-fn
         (mf/deps commit on-cancel)
         (fn [event]
           (dom/stop-propagation event)
           (cond
             (kbd/enter? event)
             (do (dom/prevent-default event)
                 (commit event))

             (kbd/esc? event)
             (do (dom/prevent-default event)
                 (mf/set-ref-val! done* true)
                 (on-cancel)))))

        on-focus
        (mf/use-fn
         (fn [event]
           (dom/select-text! (dom/get-target event))))]

    [:input {:class [(stl/css :inline-input) class]
             :type "text"
             :auto-focus true
             :spell-check false
             :default-value (or value "")
             :placeholder placeholder
             :on-focus on-focus
             :on-blur commit
             :on-click dom/stop-propagation
             :on-double-click dom/stop-propagation
             :on-key-down on-key-down}]))

(mf/defc swatch*
  {::mf/private true}
  [{:keys [css on-click]}]
  [:span {:class (stl/css-case :swatch true
                               :swatch-clickable (some? on-click))
          :on-click on-click}
   [:span {:class (stl/css :swatch-fill)
           :style {:background css}}]])

(mf/defc context-menu*
  "A context menu at x, y; `items` are {:id :label :on-click :disabled
  :danger} or {:id :separator true}."
  {::mf/private true}
  [{:keys [x y items on-close]}]
  (let [ref   (mf/use-ref nil)
        items (into [] (remove nil?) items)
        pos   (clamp-pos x y 220 (+ 8 (* 28 (count items))))]
    (use-outside-pointer ref on-close)
    [:ul {:ref ref
          :role "menu"
          :class (stl/css :menu)
          :style {:left (px (:left pos)) :top (px (:top pos))}}
     (for [{:keys [id label on-click disabled danger separator]} items]
       (if separator
         [:li {:key id :role "separator" :class (stl/css :menu-separator)}]
         [:li {:key id
               :role "menuitem"
               :aria-disabled (boolean disabled)
               :class (stl/css-case :menu-item true
                                    :menu-item-disabled disabled
                                    :menu-item-danger danger)
               :on-click (fn [event]
                           (dom/stop-propagation event)
                           (when-not disabled
                             (on-close)
                             (on-click)))}
          label]))]))

(mf/defc confirm-dialog*
  {::mf/private true}
  [{:keys [title message accept-label on-accept on-cancel]}]
  [:div {:class (stl/css :confirm-overlay)
         :on-click (fn [event]
                     (when (= (dom/get-target event) (dom/get-current-target event))
                       (on-cancel)))}
   [:div {:class (stl/css :confirm)
          :role "alertdialog"
          :aria-label title}
    [:div {:class (stl/css :confirm-title)} title]
    (when (some? message)
      [:p {:class (stl/css :confirm-message)} message])
    [:div {:class (stl/css :confirm-actions)}
     [:> button* {:variant "secondary" :on-click on-cancel}
      (tr "labels.cancel")]
     [:> button* {:variant "destructive"
                  :auto-focus true
                  :on-click on-accept
                  :data-testid "zvena-variables-confirm"}
      accept-label]]]])

;; --- Popovers

(defn- color-state
  [value]
  (let [info  (zvar/color-info value)
        hex   (or (:hash info) "#000000")
        alpha (or (:alpha info) 1)
        [h s v] (cc/hex->hsv hex)
        [r g b] (cc/hex->rgb hex)]
    {:hex hex :alpha alpha :h h :s s :v v :r r :g g :b b}))

(mf/defc color-popover*
  "Figma's color picker of a cell: the ramp plus hex and opacity. The
  value is written when the popover closes."
  {::mf/private true}
  [{:keys [rect value on-commit on-close]}]
  (let [ref      (mf/use-ref nil)
        initial  (mf/with-memo [] (color-state value))
        color*   (mf/use-state initial)
        color    (deref color*)
        latest   (mf/use-ref initial)
        pos      (clamp-pos (:left rect) (+ (:bottom rect) 4) 248 330)

        set-color!
        (mf/use-fn
         (fn [c]
           (mf/set-ref-val! latest c)
           (reset! color* c)))

        close
        (mf/use-fn
         (mf/deps on-commit on-close initial)
         (fn []
           (let [{:keys [hex alpha]} (mf/ref-val latest)]
             (when (or (not= hex (:hex initial)) (not= alpha (:alpha initial)))
               (on-commit (zvar/color-value hex alpha))))
           (on-close)))

        on-ramp
        (mf/use-fn
         (mf/deps set-color!)
         (fn [c]
           (let [{:keys [hex alpha]} c
                 [r g b] (cc/hex->rgb hex)]
             (set-color! (merge (mf/ref-val latest)
                                (select-keys c [:h :s :v])
                                {:hex hex :alpha (or alpha 1) :r r :g g :b b})))))

        on-hex
        (mf/use-fn
         (mf/deps set-color!)
         (fn [text]
           (when-let [value (zvar/parse-input-value :color text)]
             (let [next (color-state value)]
               (set-color! (assoc next :alpha (:alpha (mf/ref-val latest))))))))

        on-alpha
        (mf/use-fn
         (mf/deps set-color!)
         (fn [text]
           (let [n (js/parseFloat (str/replace (str text) "%" ""))]
             (when-not (js/isNaN n)
               (set-color! (assoc (mf/ref-val latest) :alpha (/ (mth/clamp n 0 100) 100)))))))

        noop (mf/use-fn (fn [] nil))

        on-key-down
        (mf/use-fn
         (mf/deps close)
         (fn [event]
           (dom/stop-propagation event)
           (when (kbd/esc? event)
             (close))))]

    (cpk/use-color-picker-css-variables! ref color)
    (use-outside-pointer ref close)

    [:div {:ref ref
           :class (stl/css :popover :color-popover)
           :style {:left (px (:left pos)) :top (px (:top pos))}
           :on-key-down on-key-down
           :data-testid "zvena-variables-color"}
     [:> ramp-selector* {:color color
                         :on-change on-ramp
                         :on-start-drag noop
                         :on-finish-drag noop}]
     [:div {:class (stl/css :color-fields)}
      [:> swatch* {:css (:css (zvar/color-info (zvar/color-value (:hex color) (:alpha color))))}]
      [:input {:key (dm/str "hex-" (:hex color))
               :class (stl/css :color-hex)
               :type "text"
               :spell-check false
               :default-value (str/upper (subs (:hex color) 1))
               :aria-label (tr "zvena.variables.hex")
               :on-blur (fn [event] (on-hex (dom/get-target-val event)))
               :on-key-down (fn [event]
                              (when (kbd/enter? event)
                                (on-hex (dom/get-target-val event))))}]
      [:input {:key (dm/str "alpha-" (:alpha color))
               :class (stl/css :color-alpha)
               :type "text"
               :default-value (dm/str (mth/round (* 100 (:alpha color))) "%")
               :aria-label (tr "zvena.variables.opacity")
               :on-blur (fn [event] (on-alpha (dom/get-target-val event)))
               :on-key-down (fn [event]
                              (when (kbd/enter? event)
                                (on-alpha (dom/get-target-val event))))}]]]))

(mf/defc alias-picker*
  "Picks the variable a cell becomes an alias of."
  {::mf/private true}
  [{:keys [rect candidates on-select on-close]}]
  (let [ref      (mf/use-ref nil)
        term*    (mf/use-state "")
        term     (str/lower (str/trim (deref term*)))
        shown    (mf/with-memo [candidates term]
                   (->> candidates
                        (filter #(or (str/blank? term)
                                     (str/includes? (str/lower (:name %)) term)))
                        (take 200)
                        (vec)))
        pos      (clamp-pos (:left rect) (+ (:bottom rect) 4) 260 320)

        on-change
        (mf/use-fn
         (fn [event]
           (reset! term* (dom/get-target-val event))))

        on-key-down
        (mf/use-fn
         (mf/deps shown on-select on-close)
         (fn [event]
           (dom/stop-propagation event)
           (cond
             (kbd/esc? event)   (on-close)
             (kbd/enter? event) (when-let [first-name (:name (first shown))]
                                  (on-select first-name)))))]

    (use-outside-pointer ref on-close)

    [:div {:ref ref
           :class (stl/css :popover :alias-popover)
           :style {:left (px (:left pos)) :top (px (:top pos))}
           :data-testid "zvena-variables-alias"}
     [:div {:class (stl/css :popover-search)}
      [:> i/icon* {:icon-id i/search :size "s" :class (stl/css :search-icon)}]
      [:input {:class (stl/css :popover-search-input)
               :type "text"
               :auto-focus true
               :placeholder (tr "labels.search")
               :on-change on-change
               :on-key-down on-key-down}]]
     (if (empty? shown)
       [:div {:class (stl/css :popover-empty)} (tr "zvena.variables.no-results")]
       [:ul {:class (stl/css :alias-list)}
        (for [{:keys [name type value]} shown]
          [:li {:key name
                :class (stl/css :alias-item)
                :title (slash-name name)
                :on-click (fn [event]
                            (dom/stop-propagation event)
                            (on-select name))}
           (if-let [info (when (= type :color) (zvar/color-info value))]
             [:> swatch* {:css (:css info)}]
             [:> i/icon* {:icon-id (type-icon type) :size "s" :class (stl/css :type-icon)}])
           [:span {:class (stl/css :alias-item-name)} (slash-name name)]])])]))

(mf/defc edit-variable*
  "Figma's Edit variable panel: name and description."
  {::mf/private true}
  [{:keys [rect variable coll-id names on-close]}]
  (let [ref       (mf/use-ref nil)
        vname     (:name variable)
        pos       (clamp-pos (:left rect) (+ (:bottom rect) 4) 280 200)

        on-name
        (mf/use-fn
         (mf/deps coll-id vname names)
         (fn [text]
           (let [new-name (zvar/normalize-variable-name text)]
             (cond
               (nil? new-name)
               (warn! (tr "zvena.variables.invalid-name"))

               (= new-name vname)
               nil

               (zvar/name-conflict? names new-name vname)
               (warn! (tr "zvena.variables.name-taken" (slash-name new-name)))

               :else
               (st/emit! (zvar/rename-variable coll-id vname new-name))))))

        on-description
        (mf/use-fn
         (mf/deps coll-id vname variable)
         (fn [event]
           (let [text (dom/get-target-val event)]
             (when (not= text (:description variable))
               (st/emit! (zvar/set-variable-description coll-id vname text))))))

        on-key-down
        (mf/use-fn
         (mf/deps on-close)
         (fn [event]
           (dom/stop-propagation event)
           (when (kbd/esc? event)
             (on-close))))]

    (use-outside-pointer ref on-close)

    [:div {:ref ref
           :class (stl/css :popover :edit-popover)
           :style {:left (px (:left pos)) :top (px (:top pos))}
           :on-key-down on-key-down
           :data-testid "zvena-variables-edit"}
     [:div {:class (stl/css :edit-header)}
      [:span {:class (stl/css :edit-title)} (tr "zvena.variables.edit-variable")]
      [:> icon-button* {:variant "ghost"
                        :icon i/close
                        :aria-label (tr "labels.close")
                        :on-click on-close}]]
     [:label {:class (stl/css :edit-field)}
      [:span {:class (stl/css :edit-label)} (tr "zvena.variables.name")]
      [:input {:class (stl/css :edit-input)
               :type "text"
               :spell-check false
               :default-value (slash-name vname)
               :on-blur (fn [event] (on-name (dom/get-target-val event)))
               :on-key-down (fn [event]
                              (when (kbd/enter? event)
                                (dom/blur! (dom/get-target event))))}]]
     [:label {:class (stl/css :edit-field)}
      [:span {:class (stl/css :edit-label)} (tr "zvena.variables.description")]
      [:textarea {:class (stl/css :edit-textarea)
                  :rows 3
                  :default-value (:description variable)
                  :on-blur on-description}]]]))

;; --- Table

(mf/defc value-cell*
  {::mf/private true}
  [{:keys [variable mode-id coll-id resolved tokens is-editing is-read-only
           on-edit on-stop on-color on-alias]}]
  (let [vname     (:name variable)
        vtype     (:type variable)
        token     (get-in variable [:values mode-id :token])
        raw       (:value token)
        alias     (zvar/alias-name raw)
        refs?     (zvar/references? raw)
        rvalue    (:resolved-value resolved)
        error?    (boolean (seq (:errors resolved)))
        textual?  (or (nil? raw) (string? raw) (number? raw))
        editable? (and (not is-read-only) (some? vtype) textual?)
        literal   (zvar/resolve-literal tokens raw)

        start-edit
        (mf/use-fn
         (mf/deps vname mode-id editable? on-edit)
         (fn [event]
           (dom/stop-propagation event)
           (when editable?
             (on-edit vname mode-id))))

        commit
        (mf/use-fn
         (mf/deps coll-id mode-id vname vtype raw on-stop)
         (fn [text]
           (on-stop)
           (let [value (zvar/parse-input-value vtype text)]
             (when (and (some? value) (not= value raw))
               (st/emit! (zvar/set-variable-value coll-id mode-id vname vtype value))))))

        open-color
        (mf/use-fn
         (mf/deps vname mode-id on-color is-read-only)
         (fn [event]
           (dom/stop-propagation event)
           (when-not is-read-only
             (on-color vname mode-id (dom/get-bounding-rect (dom/get-current-target event))))))

        open-alias
        (mf/use-fn
         (mf/deps vname mode-id on-alias is-read-only)
         (fn [event]
           (dom/stop-propagation event)
           (when-not is-read-only
             (on-alias vname mode-id (dom/get-bounding-rect (dom/get-current-target event))))))

        detach
        (mf/use-fn
         (mf/deps coll-id mode-id vname vtype rvalue literal)
         (fn [event]
           (dom/stop-propagation event)
           (let [value (cond
                         (= vtype :color) (color-literal (or rvalue literal))
                         (= vtype :boolean) (some-> (zvar/boolean-value (or literal rvalue)) str)
                         (some? literal) (str literal)
                         (some? rvalue) (str rvalue))]
             (when (some? value)
               (st/emit! (zvar/set-variable-value coll-id mode-id vname vtype value))))))

        toggle
        (mf/use-fn
         (mf/deps coll-id mode-id vname vtype literal is-read-only)
         (fn [event]
           (dom/stop-propagation event)
           (when-not is-read-only
             (st/emit! (zvar/set-variable-value coll-id mode-id vname vtype
                                                (if (true? (zvar/boolean-value literal)) "false" "true"))))))]

    [:div {:class (stl/css-case :cell true
                                :cell-editable editable?
                                :cell-error error?)
           :role "gridcell"
           :title (when error? (tr "zvena.variables.unresolved"))
           :on-click (when (and editable?
                                (not is-editing)
                                (or (not= vtype :boolean) (nil? token) (some? alias)))
                       start-edit)}
     (cond
       is-editing
       [:> inline-input* {:value (edit-text vtype raw)
                          :class (stl/css :cell-input)
                          :on-commit commit
                          :on-cancel on-stop}]

       (nil? token)
       [:span {:class (stl/css :cell-empty)} "—"]

       (some? alias)
       [:span {:class (stl/css :alias-pill)
               :title (slash-name alias)
               :on-click open-alias}
        (when (= vtype :color)
          [:> swatch* {:css (:css (zvar/color-info (or rvalue literal)))}])
        [:span {:class (stl/css :alias-name)} (slash-name alias)]
        (when-not is-read-only
          [:button {:class (stl/css :alias-detach)
                    :type "button"
                    :title (tr "zvena.variables.detach-alias")
                    :aria-label (tr "zvena.variables.detach-alias")
                    :on-click detach}
           [:> i/icon* {:icon-id i/detach :size "s"}]])]

       (= vtype :color)
       (let [info (zvar/color-info (if refs? rvalue raw))]
         [:span {:class (stl/css :cell-value)}
          [:> swatch* {:css (:css info) :on-click open-color}]
          [:span {:class (stl/css :cell-text)
                  :title (when refs? (str raw))}
           (if (some? info) (:hex info) (str raw))]
          (when (and (some? info) (< (:alpha info) 1))
            [:span {:class (stl/css :cell-alpha)}
             (dm/str (mth/round (* 100 (:alpha info))) "%")])])

       (= vtype :boolean)
       (let [on? (true? (zvar/boolean-value literal))]
         [:span {:class (stl/css :cell-value)}
          [:button {:class (stl/css-case :toggle true :toggle-on on?)
                    :type "button"
                    :role "switch"
                    :aria-checked on?
                    :aria-label vname
                    :disabled is-read-only
                    :on-click toggle}
           [:span {:class (stl/css :toggle-knob)}]]
          [:span {:class (stl/css :cell-text)} (if on? "true" "false")]])

       textual?
       [:span {:class (stl/css :cell-text)
               :title (when refs? (str raw))}
        (if (and refs? (some? rvalue))
          (dm/str rvalue (:unit resolved))
          (str raw))]

       :else
       [:span {:class (stl/css :cell-text :cell-muted)
               :title (zvar/value-summary raw)}
        (zvar/value-summary raw)])

     (when (and (not is-editing) (not is-read-only) (some? vtype))
       [:button {:class (stl/css :cell-alias-btn)
                 :type "button"
                 :title (tr "zvena.variables.create-alias")
                 :aria-label (tr "zvena.variables.create-alias")
                 :on-click open-alias}
        [:> i/icon* {:icon-id i/tokens :size "s"}]])]))

(mf/defc variable-row*
  {::mf/private true}
  [{:keys [variable coll-id modes resolved tokens-by-mode grid is-selected
           is-renaming editing is-read-only on-row-click on-rename on-rename-stop
           on-context-menu on-edit on-stop on-color on-alias]}]
  (let [vname  (:name variable)
        folder (zvar/variable-folder vname)

        on-click
        (mf/use-fn
         (mf/deps vname on-row-click)
         (fn [event]
           (on-row-click event vname)))

        on-double-click
        (mf/use-fn
         (mf/deps vname on-rename is-read-only)
         (fn [event]
           (dom/stop-propagation event)
           (when-not is-read-only
             (on-rename vname))))

        on-menu
        (mf/use-fn
         (mf/deps vname on-context-menu)
         (fn [event]
           (dom/prevent-default event)
           (dom/stop-propagation event)
           (on-context-menu event vname)))

        commit-name
        (mf/use-fn
         (mf/deps coll-id vname folder on-rename-stop)
         (fn [text]
           (on-rename-stop)
           (let [leaf     (zvar/normalize-variable-name text)
                 new-name (when (some? leaf)
                            (if (some? folder) (str folder "." leaf) leaf))]
             (cond
               (nil? new-name)    (warn! (tr "zvena.variables.invalid-name"))
               (= new-name vname) nil
               :else              (st/emit! (zvar/rename-variable coll-id vname new-name))))))]

    [:div {:class (stl/css-case :row true :row-selected is-selected)
           :role "row"
           :aria-selected is-selected
           :style {:grid-template-columns grid}
           :data-testid "zvena-variable-row"
           :on-click on-click
           :on-context-menu on-menu}
     [:div {:class (stl/css :cell :cell-name)
            :role "rowheader"
            :on-double-click on-double-click}
      [:> i/icon* {:icon-id (type-icon (:type variable)) :size "s" :class (stl/css :type-icon)}]
      (if is-renaming
        [:> inline-input* {:value (zvar/variable-leaf vname)
                           :class (stl/css :cell-input)
                           :on-commit commit-name
                           :on-cancel on-rename-stop}]
        [:span {:class (stl/css :var-name) :title (slash-name vname)}
         (zvar/variable-leaf vname)])]
     (for [mode modes]
       (let [mode-id (:id mode)]
         [:> value-cell* {:key (dm/str mode-id)
                          :variable variable
                          :mode-id mode-id
                          :coll-id coll-id
                          :resolved (get-in resolved [mode-id vname])
                          :tokens (get tokens-by-mode mode-id)
                          :is-editing (and (= vname (:name editing))
                                           (= mode-id (:mode-id editing)))
                          :is-read-only is-read-only
                          :on-edit on-edit
                          :on-stop on-stop
                          :on-color on-color
                          :on-alias on-alias}]))
     [:div {:class (stl/css :cell :cell-spacer)}]]))

;; --- Dialog

(def ^:private default-width 960)
(def ^:private default-height 600)

(defn- initial-geometry
  []
  (let [vw (.-innerWidth js/window)
        vh (.-innerHeight js/window)
        w  (min default-width (- vw 48))
        h  (min default-height (- vh 96))]
    {:x (max 8 (/ (- vw w) 2))
     :y (max 8 (/ (- vh h) 2))
     :w w
     :h h}))

(mf/defc variables-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-variables}
  [{:keys [collection-id]}]
  (let [tokens-lib   (mf/deref refs/tokens-lib)
        read-only?   (boolean (mf/use-ctx ctx/workspace-read-only?))
        window-ref   (mf/use-ref nil)

        geometry*    (mf/use-state initial-geometry)
        geometry     (deref geometry*)

        colls        (mf/with-memo [tokens-lib]
                       (zvar/collections tokens-lib))

        sel-id*      (mf/use-state collection-id)
        sel-id       (let [id (deref sel-id*)]
                       (if (some #(= id (:id %)) colls)
                         id
                         (:id (first colls))))
        coll         (d/seek #(= sel-id (:id %)) colls)
        coll-id      (:id coll)
        modes        (:modes coll)

        variables    (mf/with-memo [tokens-lib coll]
                       (if (some? coll)
                         (zvar/collection-variables tokens-lib coll)
                         []))
        var-names    (mf/with-memo [variables]
                       (mapv :name variables))
        folders      (mf/with-memo [variables]
                       (zvar/variable-folders variables))

        tokens-by-mode
        (mf/with-memo [tokens-lib coll]
          (if (some? coll)
            (into {}
                  (map (fn [mode] [(:id mode) (zvar/mode-tokens tokens-lib coll mode)]))
                  modes)
            {}))

        resolved*    (mf/use-state {})
        resolved     (deref resolved*)

        search*      (mf/use-state "")
        search       (deref search*)
        group*       (mf/use-state nil)
        group        (let [g (deref group*)]
                       (when (and (some? g) (some #(= g %) folders)) g))

        visible      (mf/with-memo [variables group search]
                       (let [term (str/lower (str/trim search))]
                         (filterv (fn [{:keys [name]}]
                                    (and (or (nil? group)
                                             (str/starts-with? name (str group ".")))
                                         (or (str/blank? term)
                                             (str/includes? (str/lower name) term))))
                                  variables)))
        visible-names (mf/with-memo [visible] (mapv :name visible))
        rows         (mf/with-memo [visible group]
                       (table-rows visible group))

        selected*    (mf/use-state #{})
        selected     (into #{} (filter (set var-names)) (deref selected*))
        anchor*      (mf/use-ref nil)

        ;; {:kind :variable :name} | {:kind :mode :name} | {:kind :collection :id}
        renaming*    (mf/use-state nil)
        renaming     (deref renaming*)
        creating*    (mf/use-state false)
        creating?    (deref creating*)
        editing*     (mf/use-state nil)
        editing      (deref editing*)
        menu*        (mf/use-state nil)
        menu         (deref menu*)
        confirm*     (mf/use-state nil)
        confirm      (deref confirm*)
        color-pop*   (mf/use-state nil)
        color-pop    (deref color-pop*)
        alias-pop*   (mf/use-state nil)
        alias-pop    (deref alias-pop*)
        edit-pop*    (mf/use-state nil)
        edit-pop     (deref edit-pop*)

        grid         (dm/str "minmax(220px, 1.2fr) repeat(" (max 1 (count modes))
                             ", minmax(180px, 1fr)) 40px")
        min-width    (+ 220 (* 180 (max 1 (count modes))) 40)

        close
        (mf/use-fn #(st/emit! (modal/hide)))

        ;; --- selection

        on-row-click
        (mf/use-fn
         (mf/deps visible-names)
         (fn [event vname]
           (cond
             (kbd/mod? event)
             (swap! selected* (fn [s] (if (contains? s vname) (disj s vname) (conj s vname))))

             (and (kbd/shift? event) (some? (mf/ref-val anchor*)))
             (let [a (d/index-of visible-names (mf/ref-val anchor*))
                   b (d/index-of visible-names vname)]
               (when (and (some? a) (some? b))
                 (reset! selected* (into #{} (subvec visible-names (min a b) (inc (max a b)))))))

             :else
             (do (mf/set-ref-val! anchor* vname)
                 (reset! selected* #{vname})))))

        ;; --- collections

        start-create-collection
        (mf/use-fn #(reset! creating* true))

        stop-create-collection
        (mf/use-fn #(reset! creating* false))

        create-collection
        (mf/use-fn
         (mf/deps colls)
         (fn [text]
           (reset! creating* false)
           (when-let [name (zvar/normalize-label text)]
             (let [name (zvar/unique-name name (keep :group colls) " ")]
               (st/emit! (zvar/create-collection name (tr "zvena.variables.mode-n" 1)))
               (reset! sel-id* name)
               (reset! group* nil)
               (reset! selected* #{})))))

        rename-collection
        (mf/use-fn
         (mf/deps colls)
         (fn [id text]
           (reset! renaming* nil)
           (when-let [name (zvar/normalize-label text)]
             (let [coll (d/seek #(= id (:id %)) colls)]
               (cond
                 (and (not (:implicit? coll)) (= name (:group coll)))
                 nil

                 (some #(= name (:group %)) colls)
                 (warn! (tr "zvena.variables.collection-exists" name))

                 :else
                 (do (st/emit! (zvar/rename-collection id name (tr "zvena.variables.implicit-mode")))
                     (reset! sel-id* name)))))))

        delete-collection
        (mf/use-fn
         (fn [coll]
           (reset! confirm*
                   {:title (tr "zvena.variables.delete-collection-title" (collection-label coll))
                    :message (tr "zvena.variables.delete-collection-message")
                    :accept-label (tr "labels.delete")
                    :on-accept (fn []
                                 (reset! confirm* nil)
                                 (st/emit! (zvar/delete-collection (:id coll)))
                                 (reset! sel-id* nil))})))

        on-collection-menu
        (mf/use-fn
         (mf/deps read-only? delete-collection)
         (fn [event coll]
           (dom/prevent-default event)
           (when-not read-only?
             (let [{:keys [x y]} (dom/get-client-position event)]
               (reset! sel-id* (:id coll))
               (reset! menu* {:x x :y y
                              :items [{:id "rename"
                                       :label (tr "zvena.variables.rename-collection")
                                       :on-click #(reset! renaming* {:kind :collection :id (:id coll)})}
                                      (when-not (:implicit? coll)
                                        {:id "delete"
                                         :label (tr "zvena.variables.delete-collection")
                                         :danger true
                                         :on-click #(delete-collection coll)})]})))))

        ;; --- modes

        add-mode
        (mf/use-fn
         (mf/deps coll modes)
         (fn [source-mode-id copy?]
           (when (some? coll)
             (let [taken  (map mode-label modes)
                   source (d/seek #(= source-mode-id (:id %)) modes)
                   name   (if (and copy? (some? source))
                            (zvar/unique-name (tr "zvena.variables.mode-copy" (mode-label source)) taken " ")
                            (zvar/next-numbered-name #(tr "zvena.variables.mode-n" %) taken (inc (count modes))))]
               (st/emit! (zvar/add-mode (:id coll) name source-mode-id (implicit-names)))
               (when (:implicit? coll)
                 (reset! sel-id* (zvar/normalize-label (tr "zvena.variables.implicit-collection"))))
               (reset! renaming* {:kind :mode :name name})))))

        on-add-mode
        (mf/use-fn
         (mf/deps add-mode)
         (fn [_] (add-mode nil false)))

        rename-mode
        (mf/use-fn
         (mf/deps coll modes)
         (fn [mode text]
           (reset! renaming* nil)
           (when-let [name (zvar/normalize-label text)]
             (cond
               (= name (mode-label mode))
               nil

               (and (not (:implicit? coll)) (some #(= name (:name %)) modes))
               (warn! (tr "zvena.variables.mode-exists" name))

               :else
               (do (st/emit! (zvar/rename-mode (:id coll) (:id mode) name (implicit-names)))
                   (when (:implicit? coll)
                     (reset! sel-id* (zvar/normalize-label (tr "zvena.variables.implicit-collection")))))))))

        delete-mode
        (mf/use-fn
         (mf/deps coll)
         (fn [mode]
           (reset! confirm*
                   {:title (tr "zvena.variables.delete-mode-title" (mode-label mode))
                    :message (tr "zvena.variables.delete-mode-message")
                    :accept-label (tr "labels.delete")
                    :on-accept (fn []
                                 (reset! confirm* nil)
                                 (st/emit! (zvar/delete-mode (:id coll) (:id mode))))})))

        on-mode-menu
        (mf/use-fn
         (mf/deps read-only? modes add-mode delete-mode coll)
         (fn [event mode]
           (dom/prevent-default event)
           (when-not read-only?
             (let [{:keys [x y]} (dom/get-client-position event)]
               (reset! menu* {:x x :y y
                              :items [{:id "rename"
                                       :label (tr "zvena.variables.rename-mode")
                                       :on-click #(reset! renaming* {:kind :mode :name (mode-label mode)})}
                                      {:id "duplicate"
                                       :label (tr "zvena.variables.duplicate-mode")
                                       :on-click #(add-mode (:id mode) true)}
                                      {:id "delete"
                                       :label (tr "zvena.variables.delete-mode")
                                       :danger true
                                       :disabled (or (:implicit? coll) (<= (count modes) 1))
                                       :on-click #(delete-mode mode)}]})))))

        ;; --- variables

        create-variable
        (mf/use-fn
         (mf/deps coll-id var-names group)
         (fn [type]
           (let [base   (default-variable-name type)
                 prefix (when (some? group) (str group "."))
                 vname  (zvar/next-numbered-name
                         (fn [n] (str prefix (if (= n 1) base (str base "-" n))))
                         (filter (fn [n] (zvar/name-conflict? var-names n nil))
                                 (map (fn [n] (str prefix (if (= n 1) base (str base "-" n))))
                                      (range 1 (+ 2 (count var-names)))))
                         1)]
             (st/emit! (zvar/create-variable coll-id vname type (get zvar/default-values type)))
             (reset! search* "")
             (reset! selected* #{vname})
             (mf/set-ref-val! anchor* vname)
             (reset! renaming* {:kind :variable :name vname}))))

        on-create-variable
        (mf/use-fn
         (mf/deps create-variable)
         (fn [event]
           (dom/stop-propagation event)
           (let [rect (dom/get-bounding-rect (dom/get-current-target event))]
             (reset! menu* {:x (:left rect)
                            :y (- (:top rect) (+ 8 (* 28 (count zvar/variable-types))))
                            :items (mapv (fn [type]
                                           {:id (name type)
                                            :label (type-label type)
                                            :on-click #(create-variable type)})
                                         zvar/variable-types)}))))

        delete-variables
        (mf/use-fn
         (mf/deps coll-id)
         (fn [names]
           (let [names (vec names)]
             (reset! confirm*
                     {:title (if (= 1 (count names))
                               (tr "zvena.variables.delete-variable-title" (slash-name (first names)))
                               (tr "zvena.variables.delete-variables-title" (count names)))
                      :accept-label (tr "labels.delete")
                      :on-accept (fn []
                                   (reset! confirm* nil)
                                   (reset! selected* #{})
                                   (st/emit! (zvar/delete-variables coll-id names)))}))))

        on-row-menu
        (mf/use-fn
         (mf/deps read-only? selected coll-id variables delete-variables)
         (fn [event vname]
           (when-not read-only?
             (let [{:keys [x y]} (dom/get-client-position event)
                   names (if (contains? selected vname) selected #{vname})
                   names (filterv (set names) (map :name variables))
                   rect  (dom/get-bounding-rect (dom/get-current-target event))]
               (when-not (contains? selected vname)
                 (mf/set-ref-val! anchor* vname)
                 (reset! selected* #{vname}))
               (reset! menu* {:x x :y y
                              :items [(when (= 1 (count names))
                                        {:id "edit"
                                         :label (tr "zvena.variables.edit-variable")
                                         :on-click #(reset! edit-pop* {:name vname :rect rect})})
                                      {:id "duplicate"
                                       :label (if (= 1 (count names))
                                                (tr "zvena.variables.duplicate-variable")
                                                (tr "zvena.variables.duplicate-variables" (count names)))
                                       :on-click #(st/emit! (zvar/duplicate-variables coll-id names))}
                                      {:id "delete"
                                       :label (if (= 1 (count names))
                                                (tr "zvena.variables.delete-variable")
                                                (tr "zvena.variables.delete-variables" (count names)))
                                       :danger true
                                       :on-click #(delete-variables names)}]})))))

        on-rename-variable
        (mf/use-fn #(reset! renaming* {:kind :variable :name %}))

        stop-renaming
        (mf/use-fn #(reset! renaming* nil))

        on-edit-cell
        (mf/use-fn (fn [vname mode-id] (reset! editing* {:name vname :mode-id mode-id})))

        on-stop-cell
        (mf/use-fn #(reset! editing* nil))

        on-color
        (mf/use-fn (fn [vname mode-id rect] (reset! color-pop* {:name vname :mode-id mode-id :rect rect})))

        on-alias
        (mf/use-fn (fn [vname mode-id rect] (reset! alias-pop* {:name vname :mode-id mode-id :rect rect})))

        close-menu      (mf/use-fn #(reset! menu* nil))
        close-color     (mf/use-fn #(reset! color-pop* nil))
        close-alias     (mf/use-fn #(reset! alias-pop* nil))
        close-edit      (mf/use-fn #(reset! edit-pop* nil))
        cancel-confirm  (mf/use-fn #(reset! confirm* nil))

        ;; --- window

        on-key-down
        (mf/use-fn
         (mf/deps menu confirm color-pop alias-pop edit-pop selected visible-names read-only?
                  delete-variables close)
         (fn [event]
           (let [target (dom/get-target event)
                 input? (contains? #{"INPUT" "TEXTAREA"} (.-tagName ^js target))
                 undo?  (and (kbd/mod? event)
                             (or (kbd/z? event) (= "y" (str/lower (str (.-key ^js event))))))]
             ;; the workspace shortcuts stay out of the dialog (undo / redo
             ;; outside a text field still reach the workspace)
             (when (or input? (not undo?))
               (dom/stop-propagation event))
             (when-not input?
               (cond
                 (kbd/esc? event)
                 (cond
                   (some? confirm)   (reset! confirm* nil)
                   (some? menu)      (reset! menu* nil)
                   (some? color-pop) (reset! color-pop* nil)
                   (some? alias-pop) (reset! alias-pop* nil)
                   (some? edit-pop)  (reset! edit-pop* nil)
                   (seq selected)    (reset! selected* #{})
                   :else             (close))

                 (and (or (kbd/delete? event) (kbd/backspace? event))
                      (seq selected)
                      (not read-only?)
                      (nil? confirm))
                 (do (dom/prevent-default event)
                     (delete-variables selected))

                 (and (kbd/mod? event) (= "a" (str/lower (str (.-key ^js event)))))
                 (do (dom/prevent-default event)
                     (reset! selected* (set visible-names)))

                 (and (kbd/enter? event) (= 1 (count selected)) (not read-only?) (nil? confirm))
                 (do (dom/prevent-default event)
                     (reset! renaming* {:kind :variable :name (first selected)})))))))

        on-header-pointer-down
        (mf/use-fn
         (fn [event]
           (let [target (dom/get-target event)]
             (when (and (= 0 (.-button ^js event))
                        (nil? (.closest ^js target "button, input")))
               (let [node    (mf/ref-val window-ref)
                     rect    (dom/get-bounding-rect node)
                     start-x (.-clientX ^js event)
                     start-y (.-clientY ^js event)
                     keys*   (atom nil)
                     move    (fn [e]
                               (swap! geometry* assoc
                                      :x (max 0 (+ (:left rect) (- (.-clientX ^js e) start-x)))
                                      :y (max 0 (+ (:top rect) (- (.-clientY ^js e) start-y)))))
                     up      (fn [_] (run! events/unlistenByKey @keys*))]
                 (dom/prevent-default event)
                 (reset! keys* [(events/listen js/document "pointermove" move)
                                (events/listen js/document "pointerup" up)]))))))

        on-search
        (mf/use-fn #(reset! search* (dom/get-target-val %)))

        color-variable (when (some? color-pop) (d/seek #(= (:name color-pop) (:name %)) variables))
        alias-variable (when (some? alias-pop) (d/seek #(= (:name alias-pop) (:name %)) variables))
        edit-variable  (when (some? edit-pop) (d/seek #(= (:name edit-pop) (:name %)) variables))]

    ;; the canvas stays usable while the window is open (as in Figma)
    (mf/with-effect []
      (modal/allow-click-outside!)
      (when-let [node (mf/ref-val window-ref)]
        (dom/focus! node))
      nil)

    (mf/with-effect [tokens-by-mode]
      (let [sub (rx/subs! #(reset! resolved* %)
                          (fn [_] nil)
                          (zvar/resolve-modes tokens-by-mode))]
        #(rx/dispose! sub)))

    ;; another collection: start from All variables, nothing selected
    (mf/with-effect [coll-id]
      (reset! group* nil)
      (reset! selected* #{})
      (reset! editing* nil))

    [:div {:ref window-ref
           :class (stl/css :window)
           :role "dialog"
           :aria-label (tr "zvena.variables.title")
           :tab-index -1
           :style {:left (px (:x geometry))
                   :top (px (:y geometry))
                   :width (px (:w geometry))
                   :height (px (:h geometry))}
           :on-key-down on-key-down
           :data-testid "zvena-variables-dialog"}

     [:div {:class (stl/css :header)
            :on-pointer-down on-header-pointer-down}
      [:span {:class (stl/css :title)} (tr "zvena.variables.title")]
      [:div {:class (stl/css :search)}
       [:> i/icon* {:icon-id i/search :size "s" :class (stl/css :search-icon)}]
       [:input {:class (stl/css :search-input)
                :type "text"
                :value search
                :placeholder (tr "labels.search")
                :aria-label (tr "labels.search")
                :on-change on-search
                :on-key-down (fn [event]
                               (when (kbd/esc? event)
                                 (dom/stop-propagation event)
                                 (reset! search* "")))}]]
      [:> icon-button* {:variant "ghost"
                        :icon i/close
                        :aria-label (tr "labels.close")
                        :on-click close}]]

     [:div {:class (stl/css :body)}
      ;; --- sidebar: collections, then the folders of the selected one
      [:aside {:class (stl/css :sidebar)}
       [:div {:class (stl/css :sidebar-title)} (tr "zvena.variables.collections")]
       [:ul {:class (stl/css :collections)}
        (for [c colls]
          (let [id (:id c)]
            [:li {:key (dm/str id)
                  :class (stl/css-case :side-item true
                                       :side-item-selected (= id sel-id))
                  :on-click #(reset! sel-id* id)
                  :on-double-click #(when-not read-only?
                                      (reset! renaming* {:kind :collection :id id}))
                  :on-context-menu #(on-collection-menu % c)
                  :data-testid "zvena-variables-collection"}
             (if (and (= :collection (:kind renaming)) (= id (:id renaming)))
               [:> inline-input* {:value (collection-label c)
                                  :class (stl/css :side-input)
                                  :on-commit #(rename-collection id %)
                                  :on-cancel stop-renaming}]
               [:span {:class (stl/css :side-label) :title (collection-label c)}
                (collection-label c)])]))
        (when creating?
          [:li {:class (stl/css :side-item)}
           [:> inline-input* {:value (zvar/unique-name (tr "zvena.variables.collection") (keep :group colls) " ")
                              :class (stl/css :side-input)
                              :on-commit create-collection
                              :on-cancel stop-create-collection}]])]
       (when-not read-only?
         [:button {:class (stl/css :side-create)
                   :type "button"
                   :on-click start-create-collection
                   :data-testid "zvena-variables-create-collection"}
          [:> i/icon* {:icon-id i/add :size "s"}]
          [:span (tr "zvena.variables.create-collection")]])

       [:div {:class (stl/css :sidebar-divider)}]

       [:ul {:class (stl/css :groups)}
        [:li {:class (stl/css-case :side-item true
                                   :side-item-selected (nil? group))
              :on-click #(reset! group* nil)}
         [:span {:class (stl/css :side-label)} (tr "zvena.variables.all-variables")]
         [:span {:class (stl/css :side-count)} (count variables)]]
        (for [folder folders]
          (let [depth (dec (count (zvar/name-path folder)))
                n     (count (filter #(str/starts-with? % (str folder ".")) var-names))]
            [:li {:key folder
                  :class (stl/css-case :side-item true
                                       :side-item-selected (= folder group))
                  :style {:padding-inline-start (px (+ 8 (* 12 depth)))}
                  :title (zvar/folder-label folder)
                  :on-click #(reset! group* folder)}
             [:> i/icon* {:icon-id i/folder :size "s" :class (stl/css :type-icon)}]
             [:span {:class (stl/css :side-label)} (zvar/variable-leaf folder)]
             [:span {:class (stl/css :side-count)} n]]))]]

      ;; --- table
      [:div {:class (stl/css :main)}
       [:div {:class (stl/css :table-scroll)}
        [:div {:class (stl/css :table)
               :role "grid"
               :style {:min-width (px min-width)}}
         [:div {:class (stl/css :row :row-head)
                :role "row"
                :style {:grid-template-columns grid}}
          [:div {:class (stl/css :cell :cell-head :cell-name)
                 :role "columnheader"}
           (tr "zvena.variables.name")]
          (for [mode modes]
            (let [label (mode-label mode)]
              [:div {:key (dm/str (:id mode))
                     :class (stl/css :cell :cell-head)
                     :role "columnheader"
                     :on-double-click #(when-not read-only?
                                         (reset! renaming* {:kind :mode :name label}))
                     :on-context-menu #(on-mode-menu % mode)
                     :data-testid "zvena-variables-mode"}
               (if (and (= :mode (:kind renaming)) (= label (:name renaming)))
                 [:> inline-input* {:value label
                                    :class (stl/css :cell-input)
                                    :on-commit #(rename-mode mode %)
                                    :on-cancel stop-renaming}]
                 [:span {:class (stl/css :mode-name) :title label} label])]))
          [:div {:class (stl/css :cell :cell-head :cell-spacer)}
           (when (and (some? coll) (not read-only?))
             [:> icon-button* {:variant "ghost"
                               :icon i/add
                               :aria-label (tr "zvena.variables.add-mode")
                               :on-click on-add-mode
                               :data-testid "zvena-variables-add-mode"}])]]

         (if (empty? rows)
           [:div {:class (stl/css :empty)}
            (if (str/blank? search)
              (tr "zvena.variables.empty")
              (tr "zvena.variables.no-results"))]
           (for [row rows]
             (if (= :folder (:kind row))
               [:div {:key (dm/str "folder-" (:folder row))
                      :class (stl/css :folder-row)
                      :role "row"}
                (zvar/folder-label (relative-folder (:folder row) group))]
               (let [v     (:variable row)
                     vname (:name v)]
                 [:> variable-row* {:key vname
                                    :variable v
                                    :coll-id coll-id
                                    :modes modes
                                    :resolved resolved
                                    :tokens-by-mode tokens-by-mode
                                    :grid grid
                                    :is-selected (contains? selected vname)
                                    :is-renaming (and (= :variable (:kind renaming))
                                                      (= vname (:name renaming)))
                                    :editing editing
                                    :is-read-only read-only?
                                    :on-row-click on-row-click
                                    :on-rename on-rename-variable
                                    :on-rename-stop stop-renaming
                                    :on-context-menu on-row-menu
                                    :on-edit on-edit-cell
                                    :on-stop on-stop-cell
                                    :on-color on-color
                                    :on-alias on-alias}]))))]]

       (when (and (some? coll) (not read-only?))
         [:div {:class (stl/css :footer)}
          [:button {:class (stl/css :create-variable)
                    :type "button"
                    :on-click on-create-variable
                    :data-testid "zvena-variables-create-variable"}
           [:> i/icon* {:icon-id i/add :size "s"}]
           [:span (tr "zvena.variables.create-variable")]]])]]

     ;; --- overlays
     (when (some? menu)
       [:> context-menu* {:x (:x menu)
                  :y (:y menu)
                  :items (:items menu)
                  :on-close close-menu}])

     (when (and (some? color-pop) (some? color-variable))
       (let [mode-id (:mode-id color-pop)
             vname   (:name color-pop)
             vtype   (:type color-variable)
             raw     (get-in color-variable [:values mode-id :token :value])
             value   (or (get-in resolved [mode-id vname :resolved-value])
                         (zvar/resolve-literal (get tokens-by-mode mode-id) raw))]
         [:> color-popover* {:key (dm/str vname "-" mode-id)
                             :rect (:rect color-pop)
                             :value value
                             :on-commit #(st/emit! (zvar/set-variable-value coll-id mode-id vname vtype %))
                             :on-close close-color}]))

     (when (and (some? alias-pop) (some? alias-variable))
       (let [mode-id (:mode-id alias-pop)
             vname   (:name alias-pop)
             vtype   (:type alias-variable)]
         [:> alias-picker* {:key (dm/str vname "-" mode-id)
                            :rect (:rect alias-pop)
                            :candidates (zvar/alias-candidates tokens-lib vname vtype)
                            :on-select (fn [target]
                                         (reset! alias-pop* nil)
                                         (st/emit! (zvar/set-variable-value coll-id mode-id vname vtype
                                                                            (str "{" target "}"))))
                            :on-close close-alias}]))

     (when (and (some? edit-pop) (some? edit-variable))
       [:> edit-variable* {:key (:name edit-pop)
                           :rect (:rect edit-pop)
                           :variable edit-variable
                           :coll-id coll-id
                           :names var-names
                           :on-close close-edit}])

     (when (some? confirm)
       [:> confirm-dialog* {:title (:title confirm)
                     :message (:message confirm)
                     :accept-label (:accept-label confirm)
                     :on-accept (:on-accept confirm)
                     :on-cancel cancel-confirm}])]))
