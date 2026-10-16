;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.common.types.shape.interactions
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes.bounds :as gsb]
   [app.common.schema :as sm]
   [app.common.schema.generators :as sg]))

;; WARNING: options are not deleted when changing event or action
;; type, so it can be restored if the user changes it back later.
;;
;; But that means that an interaction may have for example a delay or
;; destination, even if its type does not require it (but a previous
;; type did).
;;
;; So make sure to use has-delay/has-destination... functions, or
;; similar, before reading them.

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; SCHEMA
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def event-types
  #{:click
    :mouse-press
    :mouse-over
    :mouse-enter
    :mouse-leave
    :after-delay
    ;; zvena: Figma "Key/Gamepad" trigger; the key is stored in `:key`,
    ;; `:key-code` and `:key-modifiers`.
    :key-press
    ;; zvena: Figma "On drag" trigger (pointer down + move).
    :drag})

(def action-types
  #{:navigate
    :open-overlay
    :toggle-overlay
    :close-overlay
    :prev-screen
    :open-url
    ;; zvena: Figma "Scroll to"; `:destination` is a layer inside the
    ;; current board and `:scroll-offset` an optional offset.
    :scroll-to
    ;; zvena: Figma "Change to" (interactive components); the instance
    ;; that contains the layer shows the variant `:variant-target` (a
    ;; component id of the same variant set).
    :change-to
    ;; zvena: Figma "Swap overlay"; the open overlay is replaced by
    ;; `:destination` (same options as an open overlay).
    :swap-overlay
    ;; zvena: Figma "Set variable": the variable `:variable` (a token
    ;; name) takes the value of the expression `:value-expr`.
    :set-variable
    ;; zvena: Figma "Conditional": the actions `:then-actions` run when
    ;; the expression `:condition` holds, else `:else-actions` (see
    ;; app.common.types.shape.zvena-vars).
    :conditional})

;; zvena: modifiers that can be combined with a Key/Gamepad trigger.
(def key-modifier-types
  #{:shift :ctrl :alt :meta})

(def overlay-positioning-types
  #{:manual
    :center
    :top-left
    :top-right
    :top-center
    :bottom-left
    :bottom-right
    :bottom-center})

(def easing-types
  #{:linear
    :ease
    :ease-in
    :ease-out
    :ease-in-out
    ;; zvena: Figma easing curves. `:custom-bezier` reads its four
    ;; control values from the animation `:easing-bezier` vector; the
    ;; springs are physical presets (Gentle, Quick, Bouncy, Slow).
    :ease-in-back
    :ease-out-back
    :ease-in-out-back
    :custom-bezier
    :spring-gentle
    :spring-quick
    :spring-bouncy
    :spring-slow})

;; zvena: easings whose duration is given by the spring physics (Figma
;; hides the duration for them).
(def spring-easing-types
  #{:spring-gentle :spring-quick :spring-bouncy :spring-slow})

(def default-easing-bezier
  [0.42 0 0.58 1])

(def schema:easing-bezier
  [:vector {:min 4 :max 4} ::sm/safe-number])

(def direction-types
  #{:right
    :left
    :up
    :down})

(def way-types
  #{:in :out})

(def animation-types
  ;; zvena: `:smart-animate` (Figma "Smart animate")
  #{:dissolve :slide :push :smart-animate})

(def schema:dissolve-animation
  [:map {:title "AnimationDisolve"}
   [:animation-type [:= :dissolve]]
   [:duration ::sm/safe-int]
   [:easing [::sm/one-of easing-types]]
   [:easing-bezier {:optional true} schema:easing-bezier]
   [:way {:optional true} [::sm/one-of way-types]]
   [:offset-effect {:optional true} :boolean]
   [:direction {:optional true} [::sm/one-of direction-types]]])

(def schema:slide-animation
  [:map {:title "AnimationSlide"}
   [:animation-type [:= :slide]]
   [:duration ::sm/safe-int]
   [:easing [::sm/one-of easing-types]]
   [:easing-bezier {:optional true} schema:easing-bezier]
   [:way [::sm/one-of way-types]]
   [:direction [::sm/one-of direction-types]]
   [:offset-effect :boolean]])

(def schema:push-animation
  [:map {:title "PushAnimation"}
   [:animation-type [:= :push]]
   [:duration ::sm/safe-int]
   [:easing [::sm/one-of easing-types]]
   [:easing-bezier {:optional true} schema:easing-bezier]
   [:direction [::sm/one-of direction-types]]])

;; zvena: Figma "Smart animate": layers with the same name path in the
;; origin and destination boards are interpolated, the rest dissolve.
(def schema:smart-animate-animation
  [:map {:title "AnimationSmartAnimate"}
   [:animation-type [:= :smart-animate]]
   [:duration ::sm/safe-int]
   [:easing [::sm/one-of easing-types]]
   [:easing-bezier {:optional true} schema:easing-bezier]])

(def schema:animation
  [:multi {:dispatch :animation-type
           :title "Animation"
           :gen/gen (sg/one-of (sg/generator schema:dissolve-animation)
                               (sg/generator schema:slide-animation)
                               (sg/generator schema:push-animation)
                               (sg/generator schema:smart-animate-animation))
           :decode/json #(update % :animation-type keyword)}
   [:dissolve schema:dissolve-animation]
   [:slide schema:slide-animation]
   [:push schema:push-animation]
   [:smart-animate schema:smart-animate-animation]])

(sm/register! ::animation schema:animation)

(def check-animation!
  (sm/check-fn schema:animation))

(def schema:generic-interaction-attrs
  [:map {:title "GenericInteractionAttrs"}
   [:action-type {:optional true} [::sm/one-of action-types]]
   [:event-type {:optional true} [::sm/one-of event-types]]
   [:destination {:optional true} [:maybe ::sm/uuid]]
   [:preserve-scroll {:optional true} :boolean]
   [:animation {:optional true} schema:animation]
   [:overlay-position {:optional true} ::gpt/point]
   [:overlay-pos-type {:optional true} [::sm/one-of overlay-positioning-types]]
   [:close-click-outside {:optional true} :boolean]
   [:background-overlay {:optional true} :boolean]
   [:position-relative-to {:optional true} [:maybe ::sm/uuid]]
   [:url {:optional true} :string]
   ;; zvena: Key/Gamepad trigger data (`KeyboardEvent.key` normalized,
   ;; `KeyboardEvent.code` and the modifiers held).
   [:key {:optional true} [:maybe :string]]
   [:key-code {:optional true} [:maybe :string]]
   [:key-modifiers {:optional true} [:vector [::sm/one-of key-modifier-types]]]
   ;; zvena: Scroll to offset (Figma "Offset X/Y")
   [:scroll-offset {:optional true} ::gpt/point]
   ;; zvena: Change to target (the component id of a variant)
   [:variant-target {:optional true} [:maybe ::sm/uuid]]
   ;; zvena: Set variable / Conditional (Figma variables in prototypes);
   ;; the actions of a Conditional (interactions themselves) are
   ;; validated by its own schema only: a second recursive reference here
   ;; made the shape validator several times slower to build
   [:variable {:optional true} [:maybe :string]]
   [:value-expr {:optional true} [:maybe :string]]
   [:condition {:optional true} [:maybe :string]]])

(def schema:navigate-interaction
  [:map {:title "NavigateInteraction"}
   [:action-type [:= :navigate]]
   [:event-type [::sm/one-of event-types]]
   [:destination {:optional true} [:maybe ::sm/uuid]]
   [:preserve-scroll {:optional true} :boolean]
   [:animation {:optional true} schema:animation]])

(def schema:open-overlay-interaction
  [:map {:title "OpenOverlayInteraction"}
   [:action-type [:= :open-overlay]]
   [:event-type [::sm/one-of event-types]]
   [:overlay-position {:optional true} ::gpt/point]
   [:overlay-pos-type {:optional true} [::sm/one-of overlay-positioning-types]]
   [:destination {:optional true} [:maybe ::sm/uuid]]
   [:close-click-outside {:optional true} :boolean]
   [:background-overlay {:optional true} :boolean]
   [:animation {:optional true} schema:animation]
   [:position-relative-to {:optional true} [:maybe ::sm/uuid]]])

(def schema:toggle-overlay-interaction
  [:map {:title "ToggleOverlayInteraction"}
   [:action-type [:= :toggle-overlay]]
   [:event-type [::sm/one-of event-types]]
   [:overlay-position {:optional true} ::gpt/point]
   [:overlay-pos-type {:optional true} [::sm/one-of overlay-positioning-types]]
   [:destination {:optional true} [:maybe ::sm/uuid]]
   [:close-click-outside {:optional true} :boolean]
   [:background-overlay {:optional true} :boolean]
   [:animation {:optional true} schema:animation]
   [:position-relative-to {:optional true} [:maybe ::sm/uuid]]])

(def schema:close-overlay-interaction
  [:map {:title "CloseOverlayInteraction"}
   [:action-type [:= :close-overlay]]
   [:event-type [::sm/one-of event-types]]
   [:destination {:optional true} [:maybe ::sm/uuid]]
   [:animation {:optional true} schema:animation]
   [:position-relative-to {:optional true} [:maybe ::sm/uuid]]])

(def schema:prev-scren-interaction
  [:map {:title "PrevScreenInteraction"}
   [:action-type [:= :prev-screen]]
   [:event-type [::sm/one-of event-types]]])

(def schema:open-url-interaction
  [:map {:title "OpenUrlInteraction"}
   [:action-type [:= :open-url]]
   [:event-type [::sm/one-of event-types]]
   [:url :string]])

;; zvena: Figma "Scroll to"
(def schema:scroll-to-interaction
  [:map {:title "ScrollToInteraction"}
   [:action-type [:= :scroll-to]]
   [:event-type [::sm/one-of event-types]]
   [:destination {:optional true} [:maybe ::sm/uuid]]
   [:scroll-offset {:optional true} ::gpt/point]
   [:animation {:optional true} schema:animation]])

;; zvena: Figma "Change to" (interactive components)
(def schema:change-to-interaction
  [:map {:title "ChangeToInteraction"}
   [:action-type [:= :change-to]]
   [:event-type [::sm/one-of event-types]]
   [:variant-target {:optional true} [:maybe ::sm/uuid]]
   [:animation {:optional true} schema:animation]])

;; zvena: Figma "Swap overlay"
(def schema:swap-overlay-interaction
  [:map {:title "SwapOverlayInteraction"}
   [:action-type [:= :swap-overlay]]
   [:event-type [::sm/one-of event-types]]
   [:overlay-position {:optional true} ::gpt/point]
   [:overlay-pos-type {:optional true} [::sm/one-of overlay-positioning-types]]
   [:destination {:optional true} [:maybe ::sm/uuid]]
   [:close-click-outside {:optional true} :boolean]
   [:background-overlay {:optional true} :boolean]
   [:animation {:optional true} schema:animation]
   [:position-relative-to {:optional true} [:maybe ::sm/uuid]]])

;; zvena: Figma "Set variable"
(def schema:set-variable-interaction
  [:map {:title "SetVariableInteraction"}
   [:action-type [:= :set-variable]]
   [:event-type [::sm/one-of event-types]]
   [:variable {:optional true} [:maybe :string]]
   [:value-expr {:optional true} [:maybe :string]]])

;; zvena: Figma "Conditional"; the branches hold interactions (with the
;; trigger of the conditional), validated through the registered
;; `::interaction` schema (see below). It has no generator: the
;; recursive reference is resolved once the registry has it.
(def schema:conditional-interaction
  [:map {:title "ConditionalInteraction"}
   [:action-type [:= :conditional]]
   [:event-type [::sm/one-of event-types]]
   [:condition {:optional true} [:maybe :string]]
   [:then-actions {:optional true} [:vector [:ref ::interaction]]]
   [:else-actions {:optional true} [:maybe [:vector [:ref ::interaction]]]]])

(def schema:interaction
  [:schema {:title "Interaction"
            :gen/gen (sg/one-of (sg/generator schema:navigate-interaction)
                                (sg/generator schema:open-overlay-interaction)
                                (sg/generator schema:close-overlay-interaction)
                                (sg/generator schema:toggle-overlay-interaction)
                                (sg/generator schema:prev-scren-interaction)
                                (sg/generator schema:open-url-interaction)
                                (sg/generator schema:scroll-to-interaction)
                                (sg/generator schema:change-to-interaction)
                                (sg/generator schema:swap-overlay-interaction)
                                ;; zvena
                                (sg/generator schema:set-variable-interaction))}
   [:and
    schema:generic-interaction-attrs
    [:multi {:dispatch :action-type :title "InteractionAttrs"}
     [:navigate schema:navigate-interaction]
     [:open-overlay schema:open-overlay-interaction]
     [:toggle-overlay schema:toggle-overlay-interaction]
     [:close-overlay schema:close-overlay-interaction]
     [:prev-screen schema:prev-scren-interaction]
     [:open-url schema:open-url-interaction]
     [:scroll-to schema:scroll-to-interaction]
     [:change-to schema:change-to-interaction]
     [:swap-overlay schema:swap-overlay-interaction]
     ;; zvena: Figma variables in prototypes
     [:set-variable schema:set-variable-interaction]
     [:conditional schema:conditional-interaction]]]])

;; zvena: the actions of a Conditional refer to this schema; it must be
;; registered before any schema that contains it is compiled
(sm/register! ::interaction schema:interaction)

(def check-interaction
  (sm/check-fn schema:interaction))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; HELPERS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def default-interaction
  {:event-type :click
   :action-type :navigate
   :destination nil
   :position-relative-to nil
   :preserve-scroll false})

(def default-delay 600)

;; -- Helpers for interaction

(declare calc-overlay-pos-initial)
(declare allowed-animation?)

(defn set-event-type
  [interaction event-type shape]
  (assert (check-interaction interaction))
  (assert (contains? event-types event-type)
          "should be a valid event type")

  (assert (or (not= event-type :after-delay)
              (cfh/frame-shape? shape))
          "the `:after-delay` event type incompatible with not frame shapes")

  (if (= (:event-type interaction) event-type)
    interaction
    (case event-type

      :after-delay
      (assoc interaction
             :event-type event-type
             :delay (get interaction :delay default-delay))

      (assoc interaction
             :event-type event-type))))

;; zvena: Key/Gamepad trigger

(defn has-key?
  [interaction]
  (= (:event-type interaction) :key-press))

(defn set-key
  "Store the key (and modifiers) that fires a Key/Gamepad trigger.
  `key` is the normalized `KeyboardEvent.key`, `code` the
  `KeyboardEvent.code` (layout independent) and `modifiers` a
  collection of `key-modifier-types`."
  [interaction key code modifiers]
  (assert (check-interaction interaction))
  (assert (has-key? interaction)
          "expected compatible interaction event type")
  (assert (or (nil? key) (string? key)) "expected a string for `key`")
  (let [modifiers (->> modifiers
                       (filter key-modifier-types)
                       (distinct)
                       (sort-by name)
                       (vec))]
    (-> interaction
        (assoc :key key)
        (assoc :key-modifiers modifiers)
        (cond-> (string? code)
          (assoc :key-code code))
        (cond-> (not (string? code))
          (dissoc :key-code)))))

(defn key-matches?
  "Check if a key event (a map with `:key`, `:code` and `:modifiers`)
  fires the Key/Gamepad interaction. The physical key code matches
  regardless of the keyboard layout; the key value matches too, so a
  key recorded on another layout still works."
  [interaction {:keys [key code modifiers]}]
  (and (has-key? interaction)
       (some? (:key interaction))
       (= (set (:key-modifiers interaction))
          (set modifiers))
       (or (and (some? (:key-code interaction))
                (= (:key-code interaction) code))
           (= (:key interaction) key))))

(defn same-trigger?
  "zvena: Figma groups several actions under one trigger; two
  interactions share the trigger when the event (and its options:
  delay, key) are the same."
  [a b]
  (and (some? a)
       (some? b)
       (= (:event-type a) (:event-type b))
       (case (:event-type a)
         :after-delay (= (:delay a) (:delay b))
         :key-press   (and (= (:key a) (:key b))
                           (= (set (:key-modifiers a)) (set (:key-modifiers b))))
         true)))

(defn set-action-type
  [interaction action-type]
  (assert (check-interaction interaction))
  (assert (contains? action-types action-type)
          "Should be a valid event type")

  (let [;; zvena: the destination of a Scroll to is a layer, not a board,
        ;; so it is not carried over to/from other action types.
        scroll-switch? (and (not= (:action-type interaction) action-type)
                            (or (= action-type :scroll-to)
                                (= (:action-type interaction) :scroll-to)
                                ;; zvena: a Change to has no destination
                                ;; (it would be dropped as dangling)
                                (= action-type :change-to)
                                ;; zvena: neither has a Set variable or a
                                ;; Conditional (its actions have their own)
                                (= action-type :set-variable)
                                (= action-type :conditional)))
        interaction    (cond-> interaction
                         scroll-switch? (assoc :destination nil))

        new-interaction
        (if (= (:action-type interaction) action-type)
          interaction
          (case action-type
            :navigate
            (assoc interaction
                   :action-type action-type
                   :destination (get interaction :destination)
                   :preserve-scroll (get interaction :preserve-scroll false))

            :scroll-to
            (assoc interaction
                   :action-type action-type
                   :destination (get interaction :destination))

            ;; zvena: Change to (interactive components)
            :change-to
            (assoc interaction
                   :action-type action-type
                   :variant-target (get interaction :variant-target))

            ;; zvena: Swap overlay takes the open overlay options
            (:open-overlay :toggle-overlay :swap-overlay)
            (let [overlay-pos-type (get interaction :overlay-pos-type :center)
                  overlay-position (get interaction :overlay-position (gpt/point 0 0))]
              (assoc interaction
                     :action-type action-type
                     :overlay-pos-type overlay-pos-type
                     :overlay-position overlay-position))

            :close-overlay
            (assoc interaction
                   :action-type action-type
                   :destination (get interaction :destination))

            :prev-screen
            (assoc interaction
                   :action-type action-type)

            :open-url
            (assoc interaction
                   :action-type action-type
                   :url (get interaction :url ""))

            ;; zvena: Figma variables in prototypes
            :set-variable
            (assoc interaction
                   :action-type action-type)

            :conditional
            (assoc interaction
                   :action-type action-type
                   :then-actions (or (get interaction :then-actions) []))))]

    (cond-> new-interaction
      (not (allowed-animation? action-type
                               (-> new-interaction :animation :animation-type)))
      (dissoc :animation-type :animation))))

;; FIXME: should be renamed to has-delay?

(defn has-delay
  [interaction]
  (= (:event-type interaction) :after-delay))

(defn set-delay
  [interaction delay]
  (assert (check-interaction interaction))
  (assert (sm/check-safe-int delay))
  (assert (has-delay interaction)
          "expected compatible interaction event type")

  (assoc interaction :delay delay))

;; FIXME: rename to proper name, very confusing one because it does
;; not checks if interaction has distination, it checks if it can have
;; one.

(defn has-destination
  [interaction]
  ;; zvena: + Swap overlay
  (#{:navigate :open-overlay :toggle-overlay :close-overlay :scroll-to :swap-overlay}
   (:action-type interaction)))

(defn destination?
  [interaction]
  (and (has-destination interaction)
       (some? (:destination interaction))))

(defn set-destination
  [interaction destination]
  (assert (check-interaction interaction))
  (assert (has-destination interaction)
          "expected compatible interaction event type")

  (cond-> interaction
    :always
    (assoc :destination destination)

    (or (= (:action-type interaction) :open-overlay)
        (= (:action-type interaction) :toggle-overlay)
        ;; zvena
        (= (:action-type interaction) :swap-overlay))
    (assoc :overlay-pos-type :center
           :overlay-position (gpt/point 0 0))))

(defn has-preserve-scroll
  [interaction]
  (= (:action-type interaction) :navigate))

(defn set-preserve-scroll
  [interaction preserve-scroll]

  (assert (check-interaction interaction))
  (assert (boolean? preserve-scroll)
          "expected boolean for `preserve-scroll`")
  (assert (has-preserve-scroll interaction)
          "expected compatible interaction map with preserve-scroll")

  (assoc interaction :preserve-scroll preserve-scroll))

(defn has-scroll-offset?
  [interaction]
  (= (:action-type interaction) :scroll-to))

(defn set-scroll-offset
  [interaction offset]
  (assert (check-interaction interaction))
  (assert (gpt/point? offset)
          "expected valid point for `scroll-offset`")
  (assert (has-scroll-offset? interaction)
          "expected compatible interaction map")
  (assoc interaction :scroll-offset offset))

;; zvena: Change to (interactive components)

(defn has-variant-target?
  [interaction]
  (= (:action-type interaction) :change-to))

(defn set-variant-target
  "Set the variant (component id) a Change to switches the instance to."
  [interaction component-id]
  (assert (check-interaction interaction))
  (assert (or (nil? component-id) (uuid? component-id))
          "expected valid uuid for `variant-target`")
  (assert (has-variant-target? interaction)
          "expected compatible interaction map")
  (assoc interaction :variant-target component-id))

(defn has-url
  [interaction]
  (= (:action-type interaction) :open-url))

(defn set-url
  [interaction url]

  (assert (check-interaction interaction))
  (assert (string? url)
          "expected a string for `url`")
  (assert (has-url interaction)
          "expected compatible interaction map with url param")

  (assoc interaction :url url))

(defn has-overlay-opts
  [interaction]
  ;; zvena: + Swap overlay
  (#{:open-overlay :toggle-overlay :swap-overlay} (:action-type interaction)))

(defn set-overlay-pos-type
  [interaction overlay-pos-type shape objects]

  (assert (check-interaction interaction))

  (assert (contains? overlay-positioning-types overlay-pos-type)
          "expected valid overlay positioning type")
  (assert (has-overlay-opts interaction)
          "expected compatible interaction map")

  (assoc interaction
         :overlay-pos-type overlay-pos-type
         :overlay-position (calc-overlay-pos-initial (:destination interaction)
                                                     shape
                                                     objects
                                                     overlay-pos-type)))
(defn toggle-overlay-pos-type
  [interaction overlay-pos-type shape objects]

  (assert (check-interaction interaction))
  (assert (contains? overlay-positioning-types overlay-pos-type)
          "expected valid overlay positioning type")
  (assert (has-overlay-opts interaction)
          "expected compatible interaction map")

  (let [new-pos-type (if (= (:overlay-pos-type interaction) overlay-pos-type)
                       :manual
                       overlay-pos-type)]
    (assoc interaction
           :overlay-pos-type new-pos-type
           :overlay-position (calc-overlay-pos-initial (:destination interaction)
                                                       shape
                                                       objects
                                                       new-pos-type))))
(defn set-overlay-position
  [interaction overlay-position]

  (assert (check-interaction interaction))
  (assert (gpt/point? overlay-position)
          "expected valid overlay position")
  (assert (has-overlay-opts interaction)
          "expected compatible interaction map")


  (assoc interaction
         :overlay-pos-type :manual
         :overlay-position overlay-position))

(defn set-close-click-outside
  [interaction close-click-outside]

  (assert (check-interaction interaction))
  (assert (boolean? close-click-outside)
          "expected boolean value for `close-click-outside`")
  (assert (has-overlay-opts interaction)
          "expected compatible interaction map")

  (assoc interaction :close-click-outside close-click-outside))

(defn set-background-overlay
  [interaction background-overlay]

  (assert (check-interaction interaction))
  (assert (boolean? background-overlay)
          "expected boolean value for `background-overlay`")
  (assert (has-overlay-opts interaction)
          "expected compatible interaction map")

  (assoc interaction :background-overlay background-overlay))

(defn set-position-relative-to
  [interaction position-relative-to]

  (assert (check-interaction interaction))
  (assert (or (nil? position-relative-to)
              (uuid? position-relative-to))
          "expected valid uuid for `position-relative-to`")
  (assert (has-overlay-opts interaction)
          "expected compatible interaction map")

  (assoc interaction :position-relative-to position-relative-to))

(defn- calc-overlay-pos-initial
  [destination shape objects overlay-pos-type]
  (if (and (= overlay-pos-type :manual) (some? destination))
    (let [dest-frame   (get objects destination)
          overlay-size (:selrect dest-frame)
          orig-frame   (if (= (:type shape) :frame)
                         shape
                         (get objects (:frame-id shape)))
          frame-size   (:selrect orig-frame)]
      (gpt/point (/ (- (:width frame-size) (:width overlay-size)) 2)
                 (/ (- (:height frame-size) (:height overlay-size)) 2)))
    (gpt/point 0 0)))

(defn calc-overlay-position
  [interaction         ; interaction data
   shape               ; Shape with the interaction
   objects             ; the objects tree
   relative-to-shape   ; the interaction position is realtive to this shape
   base-frame          ; the base frame of the current interaction
   dest-frame          ; the frame to display with this interaction
   frame-offset]       ; if this interaction starts in a frame opened
                       ; on another interaction, this is the position
                       ; of that frame
  (assert (check-interaction interaction))
  (assert (has-overlay-opts interaction)
          "expected compatible interaction map")

  (let [;; When the interactive item is inside a nested frame we need to add to the offset the position
        ;; of the parent-frame otherwise the position won't match
        shape-frame (cfh/get-frame objects shape)

        frame-offset (if (or (not= :manual (:overlay-pos-type interaction))
                             (nil? shape-frame)
                             (cfh/is-direct-child-of-root? shape-frame)
                             (cfh/root? shape-frame))
                       frame-offset
                       (gpt/add frame-offset (gpt/point shape-frame)))]

    (if (nil? dest-frame)
      [(gpt/point 0 0) [:top :left]]
      (let [overlay-size           (gsb/get-object-bounds objects dest-frame)
            base-frame-size        (:selrect base-frame)
            relative-to-shape-size (:selrect relative-to-shape)
            relative-to-adjusted-to-base-frame {:x (- (:x relative-to-shape-size) (:x base-frame-size))
                                                :y (- (:y relative-to-shape-size) (:y base-frame-size))}
            relative-to-is-auto?   (and (nil? (:position-relative-to interaction)) (not= :manual (:overlay-pos-type interaction)))
            base-position          (if relative-to-is-auto?
                                     {:x 0 :y 0}
                                     {:x (+ (:x frame-offset)
                                            (:x relative-to-adjusted-to-base-frame))
                                      :y (+ (:y frame-offset)
                                            (:y relative-to-adjusted-to-base-frame))})
            overlay-position       (:overlay-position interaction)
            overlay-position       (if (= (:type relative-to-shape) :frame)
                                     overlay-position
                                     {:x (- (:x overlay-position) (:x relative-to-adjusted-to-base-frame))
                                      :y (- (:y overlay-position) (:y relative-to-adjusted-to-base-frame))})]

        (case (:overlay-pos-type interaction)
          :center
          [(gpt/point (+ (:x base-position) (/ (- (:width relative-to-shape-size) (:width overlay-size)) 2))
                      (+ (:y base-position) (/ (- (:height relative-to-shape-size) (:height overlay-size)) 2)))
           [:center :center]]

          :top-left
          [(gpt/point (:x base-position) (:y base-position))
           [:top :left]]

          :top-right
          [(gpt/point (+ (:x base-position) (- (:width relative-to-shape-size) (:width overlay-size)))
                      (:y base-position))
           [:top :right]]

          :top-center
          [(gpt/point (+ (:x base-position) (/ (- (:width relative-to-shape-size) (:width overlay-size)) 2))
                      (:y base-position))
           [:top :center]]

          :bottom-left
          [(gpt/point (:x base-position)
                      (+ (:y base-position) (- (:height relative-to-shape-size) (:height overlay-size))))
           [:bottom :left]]

          :bottom-right
          [(gpt/point (+ (:x base-position) (- (:width relative-to-shape-size) (:width overlay-size)))
                      (+ (:y base-position) (- (:height relative-to-shape-size) (:height overlay-size))))
           [:bottom :right]]

          :bottom-center
          [(gpt/point (+ (:x base-position) (/ (- (:width relative-to-shape-size) (:width overlay-size)) 2))
                      (+ (:y base-position) (- (:height relative-to-shape-size) (:height overlay-size))))
           [:bottom :center]]

          :manual
          [(gpt/point (+ (:x base-position) (:x overlay-position))
                      (+ (:y base-position) (:y overlay-position)))
           [:top :left]])))))

(defn has-animation?
  [interaction]
  ;; zvena: + Change to, Swap overlay
  (#{:navigate :open-overlay :close-overlay :toggle-overlay :scroll-to :change-to :swap-overlay}
   (:action-type interaction)))

(defn allow-push?
  [action-type]
  ; Push animation is not allowed for overlay actions
  (= :navigate action-type))

(defn allow-smart-animate?
  [action-type]
  ;; zvena: Smart animate is available for navigation, for Change to
  ;; (interactive components) and, as the animated scroll, for Scroll to.
  (contains? #{:navigate :scroll-to :change-to} action-type))

(defn allowed-animation?
  [action-type animation-type]
  ; Some specific combinations are forbidden, but may occur if the action type
  ; is changed from a type that allows the animation to another one that doesn't.
  ; Currently the only case is an overlay action with push animation.
  (cond
    (nil? animation-type)
    true

    ;; zvena: a Scroll to is either instant or animated (smart animate)
    (= action-type :scroll-to)
    (= animation-type :smart-animate)

    ;; zvena: a Change to is instant, dissolve or smart animate
    (= action-type :change-to)
    (contains? #{:dissolve :smart-animate} animation-type)

    (= animation-type :smart-animate)
    (allow-smart-animate? action-type)

    :else
    (or (not= animation-type :push)
        (allow-push? action-type))))

(defn set-animation-type
  [interaction animation-type]

  (assert (check-interaction interaction))
  (assert (or (nil? animation-type)
              (contains? animation-types animation-type))
          "expected valid value for `animation-type`")
  (assert (has-animation? interaction)
          "expected interaction map compatible with animation")
  (assert (allowed-animation? (:action-type interaction) animation-type)
          "expected allowed animation type")

  (if (= (-> interaction :animation :animation-type) animation-type)
    interaction
    (if (nil? animation-type)
      (dissoc interaction :animation)
      (cond-> interaction
        :always
        (update :animation assoc :animation-type animation-type)

        (= animation-type :dissolve)
        (update :animation assoc
                :duration (get-in interaction [:animation :duration] 300)
                :easing (get-in interaction [:animation :easing] :linear))

        (= animation-type :slide)
        (update :animation assoc
                :duration (get-in interaction [:animation :duration] 300)
                :easing (get-in interaction [:animation :easing] :linear)
                :way (get-in interaction [:animation :way] :in)
                :direction (get-in interaction [:animation :direction] :right)
                :offset-effect (get-in interaction [:animation :offset-effect] false))

        (= animation-type :push)
        (update :animation assoc
                :duration (get-in interaction [:animation :duration] 300)
                :easing (get-in interaction [:animation :easing] :linear)
                :direction (get-in interaction [:animation :direction] :right))

        ;; zvena: Figma defaults Smart animate to Ease out, 300ms
        (= animation-type :smart-animate)
        (update :animation assoc
                :duration (get-in interaction [:animation :duration] 300)
                :easing (get-in interaction [:animation :easing] :ease-out))))))

(defn has-duration?
  [interaction]
  (#{:dissolve :slide :push :smart-animate} (-> interaction :animation :animation-type)))

(defn set-duration
  [interaction duration]

  (assert (check-interaction interaction))
  (assert (sm/check-safe-int duration))
  (assert (has-duration? interaction)
          "expected compatible interaction map")

  (update interaction :animation assoc :duration duration))

(defn has-easing?
  [interaction]
  (#{:dissolve :slide :push :smart-animate} (-> interaction :animation :animation-type)))

(defn set-easing
  [interaction easing]

  (assert (check-interaction interaction))
  (assert (contains? easing-types easing)
          "expected valid easing")
  (assert (has-easing? interaction)
          "expected compatible interaction map")

  (cond-> (update interaction :animation assoc :easing easing)
    ;; zvena: a custom bezier always carries its four control values
    (and (= easing :custom-bezier)
         (nil? (get-in interaction [:animation :easing-bezier])))
    (update :animation assoc :easing-bezier default-easing-bezier)))

(defn has-easing-bezier?
  [interaction]
  (and (has-easing? interaction)
       (= (-> interaction :animation :easing) :custom-bezier)))

(defn spring-easing?
  [interaction]
  (contains? spring-easing-types (-> interaction :animation :easing)))

(defn set-easing-bezier
  [interaction bezier]
  (assert (check-interaction interaction))
  (assert (and (vector? bezier)
               (= 4 (count bezier))
               (every? number? bezier))
          "expected a vector of four numbers")
  (assert (has-easing? interaction)
          "expected compatible interaction map")
  (update interaction :animation assoc
          :easing :custom-bezier
          :easing-bezier bezier))

(defn has-way?
  [interaction]
  ; Way is ignored in slide animations of overlay actions
  (and (= (:action-type interaction) :navigate)
       (= (-> interaction :animation :animation-type) :slide)))

(defn set-way
  [interaction way]

  (assert (check-interaction interaction))
  (assert (contains? way-types way)
          "expected valid way")
  (assert (has-way? interaction)
          "expected compatible interaction map")

  (update interaction :animation assoc :way way))

(defn has-direction?
  [interaction]
  (#{:slide :push} (-> interaction :animation :animation-type)))

(defn set-direction
  [interaction direction]

  (assert (check-interaction interaction))
  (assert (contains? direction-types direction)
          "expected valid direction")

  (assert (has-direction? interaction)
          "expected compatible interaction map")

  (update interaction :animation assoc :direction direction))

(defn invert-direction
  [animation]
  (assert (or (nil? animation)
              (check-animation! animation))
          "expected valid animation map")

  (case (:direction animation)
    :right
    (assoc animation :direction :left)
    :left
    (assoc animation :direction :right)
    :up
    (assoc animation :direction :down)
    :down
    (assoc animation :direction :up)

    animation))

(defn has-offset-effect?
  [interaction]
  ;; Offset-effect is ignored in slide animations of overlay actions
  (and (= (:action-type interaction) :navigate)
       (= (-> interaction :animation :animation-type) :slide)))

(defn set-offset-effect
  [interaction offset-effect]

  (assert (check-interaction interaction))
  (assert (boolean? offset-effect)
          "expected valid boolean for `offset-effect`")
  (assert (has-offset-effect? interaction)
          "expected compatible interaction map")

  (update interaction :animation assoc :offset-effect offset-effect))

(defn dest-to?
  "Check if the interaction has the given frame as destination."
  [interaction frame-id]
  (and (has-destination interaction)
       (= (:destination interaction) frame-id)))

(defn navs-to?
  "Check if the interaction is a navigation to the given frame."
  [interaction frame-id]
  (and (= (:action-type interaction) :navigate)
       (= (:destination interaction) frame-id)))

;; -- Helpers for interactions

(defn add-interaction
  [interactions interaction]
  (conj (or interactions []) interaction))

(defn insert-interaction
  "zvena: interactions with `interaction` inserted at `index` (appended
  when `index` is out of range); used to add one more action to an
  existing trigger, right after its last action."
  [interactions index interaction]
  (let [interactions (vec (or interactions []))]
    (if (and (int? index) (<= 0 index (count interactions)))
      (into (conj (subvec interactions 0 index) interaction)
            (subvec interactions index))
      (conj interactions interaction))))

(defn remove-interaction
  "Interactions without the one at `index`; unchanged when `index` addresses none."
  [interactions index]
  (let [interactions (or interactions [])]
    (if (and (int? index) (< -1 index (count interactions)))
      (into (subvec interactions 0 index)
            (subvec interactions (inc index)))
      interactions)))

(defn update-interaction
  "Interactions with `update-fn` applied at `index`; unchanged when `index`
  addresses none."
  [interactions index update-fn]
  (if (and (int? index) (< -1 index (count interactions)))
    (update interactions index update-fn)
    interactions))

;; zvena: Figma variables in prototypes (Set variable / Conditional)

(defn has-variable?
  [interaction]
  (= (:action-type interaction) :set-variable))

(defn set-variable
  "Set the variable (a token name) a Set variable changes."
  [interaction variable]
  (assert (or (nil? variable) (string? variable))
          "expected a string for `variable`")
  (assert (has-variable? interaction)
          "expected compatible interaction map")
  (assoc interaction :variable variable))

(defn set-value-expr
  "Set the value (an expression, see app.common.types.shape.zvena-vars)
  a Set variable gives to its variable."
  [interaction expr]
  (assert (or (nil? expr) (string? expr))
          "expected a string for `value-expr`")
  (assert (has-variable? interaction)
          "expected compatible interaction map")
  (assoc interaction :value-expr expr))

(defn conditional?
  [interaction]
  (= (:action-type interaction) :conditional))

(defn set-condition
  "Set the condition (an expression) of a Conditional."
  [interaction expr]
  (assert (or (nil? expr) (string? expr))
          "expected a string for `condition`")
  (assert (conditional? interaction)
          "expected compatible interaction map")
  (assoc interaction :condition expr))

(def branch-keys
  "The action lists of a Conditional: `:then-actions` (if) and
  `:else-actions` (else; nil when the conditional has no else)."
  #{:then-actions :else-actions})

(defn branch-action
  "A new action (Navigate to, no destination) for a branch of the
  Conditional `parent`. It keeps the trigger of the conditional, so it
  validates as an interaction (the viewer ignores it)."
  [parent shape-id]
  (-> default-interaction
      (assoc :event-type (get parent :event-type :click))
      (assoc :position-relative-to shape-id)))

(defn add-branch-action
  [interaction branch action]
  (assert (contains? branch-keys branch) "expected a valid branch")
  (update interaction branch (fnil conj []) action))

(defn update-branch-action
  "`interaction` with `update-fn` applied to the action at `index` of
  its `branch`."
  [interaction branch index update-fn]
  (assert (contains? branch-keys branch) "expected a valid branch")
  (if (vector? (get interaction branch))
    (update interaction branch update-interaction index update-fn)
    interaction))

(defn remove-branch-action
  [interaction branch index]
  (assert (contains? branch-keys branch) "expected a valid branch")
  (if (vector? (get interaction branch))
    (update interaction branch remove-interaction index)
    interaction))

(defn add-else
  [interaction]
  (update interaction :else-actions #(or % [])))

(defn remove-else
  [interaction]
  (dissoc interaction :else-actions))

(declare remap-interactions)

(defn- remap-branches
  "zvena: remaps the actions of a Conditional, as the interactions."
  [interaction ids-map objects]
  (cond-> interaction
    (vector? (:then-actions interaction))
    (update :then-actions remap-interactions ids-map objects)

    (vector? (:else-actions interaction))
    (update :else-actions remap-interactions ids-map objects)))

(defn remap-interactions
  "Update all interactions whose destination points to a shape in the
  map to the new id. And remove the ones whose destination does not exist
  in the map nor in the objects tree."
  [interactions ids-map objects]
  (when (some? interactions)
    (let [xform (comp (filter (fn [interaction]
                                (let [destination (:destination interaction)]
                                  (or (nil? destination)
                                      (contains? ids-map destination)
                                      (contains? objects destination)))))
                      (map (fn [interaction]
                             (-> (d/update-when interaction :destination #(get ids-map % %))
                                 ;; zvena: + the actions of a Conditional
                                 (remap-branches ids-map objects)))))]
      (into [] xform interactions))))

(defn remove-interactions
  "Remove all interactions that the fn returns true."
  [f interactions]
  (-> (d/removev f interactions)
      not-empty))

(defn actionable?
  "Check if there is any interaction that is clickable by the user"
  [interactions]
  ;; zvena: drag hotspots are pointer targets too
  (some #(contains? #{:click :drag} (:event-type %)) interactions))

(defn flow-origin?
  "Check if there is any interaction that is the start or the continuation of a flow"
  [interactions]
  ;; zvena: + Swap overlay
  (some #(and (#{:navigate :open-overlay :toggle-overlay :close-overlay :swap-overlay} (:action-type %))
              (some? (:destination %)))
        interactions))

(defn flow-to?
  "Check if there is any interaction that flows into the given frame"
  [interactions frame-id]
  ;; zvena: + Swap overlay
  (some #(and (#{:navigate :open-overlay :toggle-overlay :close-overlay :swap-overlay} (:action-type %))
              (= (:destination %) frame-id))
        interactions))
