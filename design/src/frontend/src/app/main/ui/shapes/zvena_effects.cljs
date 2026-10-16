;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.shapes.zvena-effects
  "zvena: the Figma effects that Penpot's SVG renderer lacked (workspace,
  viewer and the exporter's render page all use it).

  - Noise and Texture are extra steps of the shape's own SVG filter
    (app.main.ui.shapes.filters): feTurbulence grain composited inside
    the shape, and an feTurbulence + feDisplacementMap pass over the
    shape's graphic.
  - Background blur: browsers have no BackgroundImage for SVG filters and
    CSS backdrop-filter only works in Chromium (foreignObject, which also
    breaks the exporter's SVG output). So the layer draws a blurred copy
    of what lies behind it, clipped to its geometry: `<use>` clones of the
    sibling layers below it and of the fills of its parent boards, up to
    the top-level board. Frames and groups tell their children what is
    behind them through `behind-ctx`. Works in Chrome, Firefox and
    Safari and in the exported SVG / PNG / PDF."
  (:require
   [app.common.data.macros :as dm]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
   [app.common.types.path :as path]
   [app.config :as cf]
   [app.main.ui.shapes.attrs :as attrs]
   [app.util.object :as obj]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

;; --- Noise

(defn- noise-frequency
  "feTurbulence base frequency for a Figma noise size. Never an integer:
  Perlin noise is flat on its lattice points."
  [size]
  (/ 0.365 (max 0.01 size)))

(defn- texture-frequency
  [size]
  (/ 0.97 (max 0.01 size)))

(defn- density-table
  [density]
  (let [n 32]
    (str/join " " (for [i (range n)]
                    (if (>= (/ (+ i 0.5) n) (- 1 density)) 1 0)))))

(mf/defc noise-filter*
  "Filter primitives of Figma's Noise effect: grain drawn over `filter-in`,
  inside the shape. Ends with `filter-id` as result."
  [{:keys [filter-id filter-in params]}]
  (let [{:keys [noise-type size density color color2 opacity]} params
        freq  (noise-frequency size)
        res   (fn [s] (dm/str filter-id "-" s))]
    [:*
     [:feTurbulence {:type "fractalNoise"
                     :baseFrequency freq
                     :numOctaves 3
                     :seed 7
                     :result (res "n")}]
     ;; the red channel, contrast stretched, as alpha
     [:feColorMatrix {:in (res "n")
                      :type "matrix"
                      :values "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  4 0 0 0 -1.5"
                      :result (res "a")}]
     ;; keep `density` of the pixels
     [:feComponentTransfer {:in (res "a") :result (res "m")}
      [:feFuncA {:type "discrete" :tableValues (density-table density)}]]

     (case noise-type
       :duo
       [:*
        [:feColorMatrix {:in (res "n")
                         :type "matrix"
                         :values "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 4 0 0 -1.5"
                         :result (res "s0")}]
        [:feComponentTransfer {:in (res "s0") :result (res "s")}
         [:feFuncA {:type "discrete" :tableValues "0 1"}]]
        [:feComposite {:in (res "m") :in2 (res "s") :operator "in" :result (res "ma")}]
        [:feComposite {:in (res "m") :in2 (res "s") :operator "out" :result (res "mb")}]
        [:feFlood {:flood-color (:color color) :flood-opacity (:opacity color) :result (res "ca")}]
        [:feComposite {:in (res "ca") :in2 (res "ma") :operator "in" :result (res "ga")}]
        [:feFlood {:flood-color (:color color2) :flood-opacity (:opacity color2) :result (res "cb")}]
        [:feComposite {:in (res "cb") :in2 (res "mb") :operator "in" :result (res "gb")}]
        [:feMerge {:result (res "g")}
         [:feMergeNode {:in (res "ga")}]
         [:feMergeNode {:in (res "gb")}]]]

       :multi
       [:*
        [:feTurbulence {:type "fractalNoise"
                        :baseFrequency freq
                        :numOctaves 3
                        :seed 13
                        :result (res "n2")}]
        [:feColorMatrix {:in (res "n2")
                         :type "matrix"
                         :values "4 0 0 0 -1.5  0 4 0 0 -1.5  0 0 4 0 -1.5  0 0 0 0 1"
                         :result (res "rgb")}]
        [:feComposite {:in (res "rgb") :in2 (res "m") :operator "in" :result (res "g0")}]
        [:feComponentTransfer {:in (res "g0") :result (res "g")}
         [:feFuncA {:type "linear" :slope opacity}]]]

       ;; :mono
       [:*
        [:feFlood {:flood-color (:color color) :flood-opacity (:opacity color) :result (res "c")}]
        [:feComposite {:in (res "c") :in2 (res "m") :operator "in" :result (res "g")}]])

     [:feComposite {:in (res "g") :in2 "SourceAlpha" :operator "in" :result (res "gs")}]
     [:feMerge {:result filter-id}
      [:feMergeNode {:in filter-in}]
      [:feMergeNode {:in (res "gs")}]]]))

;; --- Texture

(mf/defc texture-blend*
  "Replaces the plain blend of the shape over its drop shadows: the
  shape's graphic, roughened by Figma's Texture effect, over `filter-in`."
  [{:keys [filter-id filter-in texture]}]
  (let [{:keys [size radius clip]} texture
        res (fn [s] (dm/str filter-id "-zt-" s))]
    [:*
     [:feTurbulence {:type "fractalNoise"
                     :baseFrequency (texture-frequency size)
                     :numOctaves 2
                     :seed 5
                     :result (res "n")}]
     [:feDisplacementMap {:in "SourceGraphic"
                          :in2 (res "n")
                          :scale (* 2 radius)
                          :xChannelSelector "R"
                          :yChannelSelector "G"
                          :result (res "d")}]
     (when clip
       [:feComposite {:in (res "d") :in2 "SourceAlpha" :operator "in" :result (res "c")}])
     [:feBlend {:mode "normal"
                :in (if clip (res "c") (res "d"))
                :in2 filter-in
                :result filter-id}]]))

;; --- Background blur

(def behind-ctx
  "What a frame / group draws behind its children: {:behind [element-id]
  :order [child-id]} (bottom to top)."
  (mf/create-context nil))

(defn behind-of
  "Ids of the elements drawn behind the layer `id` (a child of the
  container that provides `value`), bottom to top."
  [value id]
  (if (nil? value)
    []
    (let [order (:order value)]
      (if (some #(= % id) order)
        (into (:behind value)
              (comp (take-while #(not= % id))
                    (map #(dm/str "shape-" %)))
              order)
        (:behind value)))))

(defn container-value
  "The `behind-ctx` value a frame (`fills?`) or group `id` gives to its
  children `child-ids`, from the value it gets from its own parent."
  [parent-value id fills? child-ids]
  {:behind (cond-> (behind-of parent-value id)
             fills? (conj (dm/str "fills-" id)))
   :order  child-ids})

(def ^:private bg-blur-types
  #{:rect :frame :circle :path :bool :image :text :group})

(defn background-blur?
  "True when the SVG renderer has to draw a background blur for `shape`."
  [shape]
  (let [blur (:background-blur shape)]
    (and (some? blur)
         (not (:hidden blur))
         (number? (:value blur))
         (pos? (:value blur))
         (contains? bg-blur-types (dm/get-prop shape :type)))))

(defn- content->string
  [content]
  (try
    (cond
      (nil? content) ""
      (path/content? content) (.toString content)
      :else (.toString (path/content content)))
    (catch :default _ "")))

(mf/defc geometry*
  "The outline of the layer, for the clip of its background blur."
  {::mf/private true}
  [{:keys [shape]}]
  (let [type (dm/get-prop shape :type)]
    (case type
      (:rect :frame :image)
      (let [props (-> #js {}
                      (attrs/add-border-props! shape)
                      (obj/merge! #js {:x (dm/get-prop shape :x)
                                       :y (dm/get-prop shape :y)
                                       :width (dm/get-prop shape :width)
                                       :height (dm/get-prop shape :height)
                                       :transform (gsh/transform-str shape)}))]
        (if (some? (.-d props))
          [:> :path props]
          [:> :rect props]))

      :circle
      (let [x (dm/get-prop shape :x)
            y (dm/get-prop shape :y)
            w (dm/get-prop shape :width)
            h (dm/get-prop shape :height)]
        [:ellipse {:cx (+ x (/ w 2))
                   :cy (+ y (/ h 2))
                   :rx (/ w 2)
                   :ry (/ h 2)
                   :transform (gsh/transform-str shape)}])

      (:path :bool)
      [:path {:d (content->string (:content shape))}]

      ;; zvena: the glyphs, laid out as the SVG text renderer does
      :text
      (let [transform (gsh/transform-str shape)
            safari?   (cf/check-browser? :safari)]
        [:*
         (for [[index data] (map-indexed vector (:position-data shape))]
           (let [rtl? (= "rtl" (:direction data))]
             [:text {:key (dm/str "bbtext-" index)
                     :x (if rtl? (+ (:x data) (:width data)) (:x data))
                     :y (if safari? (- (:y data) (:height data)) (:y data))
                     :dy (when safari? "0.2em")
                     :dominant-baseline (if safari? "hanging" "ideographic")
                     :text-length (:width data)
                     :length-adjust "spacingAndGlyphs"
                     :transform transform
                     :style {:font-family (:font-family data)
                             :font-size (:font-size data)
                             :font-weight (:font-weight data)
                             :font-style (:font-style data)
                             :letter-spacing (:letter-spacing data)
                             :text-transform (:text-transform data)
                             :font-feature-settings (:font-feature-settings data)
                             :font-variation-settings (:font-variation-settings data)
                             :direction (:direction data)
                             :white-space "pre"}}
              (:text data)]))])

      nil)))

(mf/defc background-blur*
  "Figma's background blur: a blurred copy of what lies behind the layer,
  clipped to the layer. Rendered inside the layer, before its content."
  [{:keys [shape render-id]}]
  (let [value     (mf/use-ctx behind-ctx)
        shape-id  (dm/get-prop shape :id)
        hrefs     (behind-of value shape-id)
        radius    (dm/get-in shape [:background-blur :value])
        sigma     (/ radius 2)
        margin    (+ 2 (* 3 sigma))
        bounds    (grc/points->rect (dm/get-prop shape :points))
        clip-id   (dm/str "zvena-bbclip-" render-id)
        filter-id (dm/str "zvena-bb-" render-id)
        group?    (= :group (dm/get-prop shape :type))]
    (when (and (seq hrefs) (some? bounds))
      [:g {:class "zvena-background-blur"
           :pointer-events "none"}
       [:defs
        (if group?
          ;; a group is clipped to its layers: their alpha (a clip path
          ;; can't hold groups)
          [:mask {:id clip-id
                  :mask-units "userSpaceOnUse"
                  :x (- (:x bounds) margin)
                  :y (- (:y bounds) margin)
                  :width (+ (:width bounds) (* 2 margin))
                  :height (+ (:height bounds) (* 2 margin))
                  :style {:mask-type "alpha"}}
           (for [child-id (:shapes shape)]
             [:use {:key (dm/str child-id) :href (dm/str "#shape-" child-id)}])]
          [:clipPath {:id clip-id}
           [:> geometry* {:shape shape}]])
        [:filter {:id filter-id
                  :x (- (:x bounds) margin)
                  :y (- (:y bounds) margin)
                  :width (+ (:width bounds) (* 2 margin))
                  :height (+ (:height bounds) (* 2 margin))
                  :filterUnits "userSpaceOnUse"
                  :color-interpolation-filters "sRGB"}
         [:feGaussianBlur {:stdDeviation sigma}]]]
       [:g {:mask (when group? (dm/fmt "url(#%)" clip-id))
            :clip-path (when-not group? (dm/fmt "url(#%)" clip-id))}
        [:g {:filter (dm/fmt "url(#%)" filter-id)}
         (for [href hrefs]
           [:use {:key href :href (dm/str "#" href)}])]]])))
