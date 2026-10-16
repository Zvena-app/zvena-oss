;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.viewer.zvena.proto
  "zvena: runtime helpers for the Figma prototyping features of the
  viewer: Key/Gamepad trigger, On drag trigger and Scroll to action."
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.types.shape.interactions :as ctsi]
   [app.config :as cf]
   [app.main.store :as st]
   [app.main.ui.viewer.zvena.easing :as ez]
   [app.util.dom :as dom]
   [app.util.timers :as tm]
   [cuerdas.core :as str]))

;; --- Keys

(def ^:private modifier-keys
  #{"Shift" "Control" "Alt" "Meta" "AltGraph" "CapsLock" "OS" "Hyper" "Super" "Fn"})

(defn- normalize-key
  [key]
  (cond
    (or (nil? key) (= key "")) nil
    (= key " ") "Space"
    (= 1 (count key)) (str/lower key)
    :else key))

(defn modifier-key-event?
  "True when the event is the press of a modifier alone (Shift, Ctrl...)."
  [^js event]
  (contains? modifier-keys (.-key event)))

(defn event->key-data
  "Key data of a native/synthetic keyboard event, in the shape used by
  `ctsi/key-matches?` and `ctsi/set-key`."
  [^js event]
  {:key (normalize-key (.-key event))
   :code (let [code (.-code event)] (when-not (str/blank? code) code))
   :modifiers (cond-> []
                (.-altKey event)   (conj :alt)
                (.-ctrlKey event)  (conj :ctrl)
                (.-metaKey event)  (conj :meta)
                (.-shiftKey event) (conj :shift))})

(def ^:private key-names
  {"ArrowLeft"  "←"
   "ArrowRight" "→"
   "ArrowUp"    "↑"
   "ArrowDown"  "↓"
   "Space"      "Space"
   "Escape"     "Esc"
   "Enter"      "Enter"
   "Backspace"  "⌫"
   "Delete"     "Del"
   "Tab"        "Tab"})

(defn key-label
  "Human label of the key of a Key/Gamepad interaction, e.g. \"Ctrl + →\"."
  [{:keys [key key-modifiers]}]
  (when (some? key)
    (let [mac?  (cf/check-platform? :macos)
          mods  (set key-modifiers)
          names (cond-> []
                  (contains? mods :ctrl)  (conj (if mac? "⌃" "Ctrl"))
                  (contains? mods :alt)   (conj (if mac? "⌥" "Alt"))
                  (contains? mods :shift) (conj (if mac? "⇧" "Shift"))
                  (contains? mods :meta)  (conj (if mac? "⌘" "Meta")))
          kname (or (get key-names key)
                    (if (= 1 (count key)) (str/upper key) key))]
      (str/join " + " (conj names kname)))))

(defn- editable-target?
  [^js target]
  (when (some? target)
    (let [tag (some-> (.-tagName target) str/upper)]
      (or (= tag "INPUT")
          (= tag "TEXTAREA")
          (= tag "SELECT")
          (true? (.-isContentEditable target))))))

(defn listen-keys!
  "zvena: Figma Key/Gamepad trigger. While a shape with key interactions
  is rendered in the viewer, a key press (with the same modifiers) runs
  its interactions, in order. The listener is on window in the capture
  phase so a matching key wins over the viewer shortcuts (arrows, space,
  enter...). Returns the function that removes the listeners, or nil."
  [shape activate-fn]
  (let [interactions (->> (:interactions shape)
                          (filterv ctsi/has-key?))]
    (when (seq interactions)
      (let [consumed? (volatile! false)

            on-key-down
            (fn [^js event]
              (vreset! consumed? false)
              (when-not (or (.-repeat event)
                            (.-isComposing event)
                            (editable-target? (.-target event))
                            (modifier-key-event? event))
                (let [data    (event->key-data event)
                      matches (filterv #(ctsi/key-matches? % data) interactions)]
                  (when (seq matches)
                    (vreset! consumed? true)
                    (.preventDefault event)
                    (.stopPropagation event)
                    (doseq [interaction matches]
                      (activate-fn interaction))))))

            ;; the shortcuts library also listens to keypress for
            ;; character keys, so it is stopped too
            on-key-press
            (fn [^js event]
              (when @consumed?
                (.stopPropagation event)))

            on-key-up
            (fn [^js event]
              (when @consumed?
                (vreset! consumed? false)
                (.stopPropagation event)))]

        (.addEventListener js/window "keydown" on-key-down true)
        (.addEventListener js/window "keypress" on-key-press true)
        (.addEventListener js/window "keyup" on-key-up true)
        (fn []
          (.removeEventListener js/window "keydown" on-key-down true)
          (.removeEventListener js/window "keypress" on-key-press true)
          (.removeEventListener js/window "keyup" on-key-up true))))))

;; --- On drag

;; zvena: pixels the pointer has to move before a press becomes a drag
(def ^:private drag-threshold 6)

(defn track-drag!
  "zvena: Figma \"On drag\". After a pointer down on a shape with drag
  interactions, run `on-drag` once the pointer moves beyond a small
  threshold; if it is released before, run `on-click` instead (so a
  layer can have both a click and a drag trigger, as in Figma)."
  [^js event on-drag on-click]
  (let [start-x (.-clientX event)
        start-y (.-clientY event)
        state   (volatile! :pending)
        cleanup (volatile! nil)

        finish!
        (fn [result]
          (when (= @state :pending)
            (vreset! state result)
            (when-let [f @cleanup] (f))
            true))

        on-move
        (fn [^js e]
          (let [dx (- (.-clientX e) start-x)
                dy (- (.-clientY e) start-y)]
            (when (and (= @state :pending)
                       (> (+ (* dx dx) (* dy dy)) (* drag-threshold drag-threshold)))
              (when (finish! :dragged)
                (on-drag)))))

        on-up
        (fn [_]
          (when (finish! :clicked)
            (when (fn? on-click)
              (on-click))))

        on-cancel
        (fn [_]
          (finish! :cancelled))]

    (.addEventListener js/window "pointermove" on-move)
    (.addEventListener js/window "pointerup" on-up)
    (.addEventListener js/window "pointercancel" on-cancel)
    (vreset! cleanup
             (fn []
               (.removeEventListener js/window "pointermove" on-move)
               (.removeEventListener js/window "pointerup" on-up)
               (.removeEventListener js/window "pointercancel" on-cancel)))
    nil))

;; --- Scroll to

(defonce ^:private scroll-anim (volatile! nil))

(defn- cancel-scroll-animation!
  []
  (when-let [id @scroll-anim]
    (tm/cancel-af! id)
    (vreset! scroll-anim nil)))

(defn- animate-scroll!
  [^js node from-x from-y to-x to-y duration easing-f]
  (cancel-scroll-animation!)
  (let [start (volatile! nil)
        step  (fn step [ts]
                (when (nil? @start) (vreset! start ts))
                (let [p (if (pos? duration)
                          (min 1 (/ (- ts @start) duration))
                          1)
                      v (easing-f p)]
                  (set! (.-scrollLeft node) (+ from-x (* (- to-x from-x) v)))
                  (set! (.-scrollTop node) (+ from-y (* (- to-y from-y) v)))
                  (if (< p 1)
                    (vreset! scroll-anim (tm/raf step))
                    (vreset! scroll-anim nil))))]
    (vreset! scroll-anim (tm/raf step))))

(defn- frame-container
  "DOM node rendering the board `frame-id` in the viewer: the current
  screen or an open overlay."
  [frame-id]
  (or (dom/query (dm/str "[data-zvena-frame-id=\"" frame-id "\"]"))
      (dom/get-element (dm/str "overlay-" frame-id))))

(defn scroll-to!
  "zvena: Figma \"Scroll to\". Scrolls the viewer so the destination layer
  is at the top-left of the visible area (plus the optional offset),
  animated with the interaction easing/duration when it has an
  animation. `objects` are the viewer objects, already in the board
  viewbox space."
  [interaction objects]
  (let [dest-id (:destination interaction)
        dest    (get objects dest-id)
        frame   (when dest (cfh/get-root-frame objects dest-id))
        section (dom/get-element "viewer-section")
        node    (when frame (frame-container (:id frame)))]
    (when (and (some? dest) (some? section) (some? node))
      (let [zoom      (or (dm/get-in @st/state [:viewer-local :zoom]) 1)
            selrect   (:selrect dest)
            offset    (:scroll-offset interaction)
            off-x     (or (:x offset) 0)
            off-y     (or (:y offset) 0)

            crect     (.getBoundingClientRect ^js node)
            srect     (.getBoundingClientRect ^js section)

            ;; screen position of the layer top-left corner
            target-x  (+ (.-left crect) (* (- (:x selrect) off-x) zoom))
            target-y  (+ (.-top crect) (* (- (:y selrect) off-y) zoom))

            max-x     (max 0 (- (.-scrollWidth section) (.-clientWidth section)))
            max-y     (max 0 (- (.-scrollHeight section) (.-clientHeight section)))

            from-x    (.-scrollLeft section)
            from-y    (.-scrollTop section)
            to-x      (-> (+ from-x (- target-x (.-left srect))) (max 0) (min max-x))
            to-y      (-> (+ from-y (- target-y (.-top srect))) (max 0) (min max-y))

            animation (:animation interaction)]

        (if (and (some? animation)
                 (pos? (or (:duration animation) 0)))
          (animate-scroll! section from-x from-y to-x to-y
                           (:duration animation)
                           (ez/easing-fn animation))
          (do
            (cancel-scroll-animation!)
            (set! (.-scrollLeft section) to-x)
            (set! (.-scrollTop section) to-y)))))))
