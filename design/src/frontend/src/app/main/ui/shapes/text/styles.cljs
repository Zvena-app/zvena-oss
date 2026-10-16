;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.shapes.text.styles
  (:require
   [app.common.data :as d]
   [app.common.transit :as transit]
   [app.common.types.color :as cc]
   [app.common.types.text :as txt]
   [app.main.fonts :as fonts]
   [app.main.ui.formats :as fmt]
   [app.util.color :as uc]
   [app.util.object :as obj]
   [cuerdas.core :as str]))

(defn generate-root-styles
  ([props node]
   (generate-root-styles props node false))
  ([{:keys [width height]} node code?]
   (let [valign (:vertical-align node "top")
         base   #js {:height (when-not code? (fmt/format-pixels height))
                     :width  (when-not code? (fmt/format-pixels width))
                     :display "flex"
                     :whiteSpace "break-spaces"}]
     (cond-> base
       (= valign "top")     (obj/set! "alignItems" "flex-start")
       (= valign "center")  (obj/set! "alignItems" "center")
       (= valign "bottom")  (obj/set! "alignItems" "flex-end")))))

(defn generate-paragraph-set-styles
  [{:keys [grow-type content] :as shape}]
  ;; This element will control the auto-width/auto-height size for the
  ;; shape. The properties try to adjust to the shape and "overflow" if
  ;; the shape is not big enough.
  ;; We `inherit` the property `justify-content` so it's set by the root where
  ;; the property it's known.
  ;; `inline-flex` is similar to flex but `overflows` outside the bounds of the
  ;; parent
  (let [auto-width?  (= grow-type :auto-width)
        ;; zvena: Figma "Truncate text". The paragraph set never grows past
        ;; the box (fixed size) nor past "Max lines": its bottom is the cut
        ;; line used to drop the hidden lines and place the ellipsis (see
        ;; app.util.text-svg-position), and its size is what auto-height
        ;; texts resize to.
        truncation   (txt/truncation content)
        max-lines    (:max-lines truncation)
        base         #js {:display "inline-flex"
                          :flexDirection "column"
                          :justifyContent "inherit"
                          :minWidth (when-not auto-width? "100%")
                          :marginRight "1px"
                          :verticalAlign "top"}]
    (cond-> base
      (some? truncation)
      (obj/set! "overflow" "hidden")

      ;; fixed size (the html root has the shape height)
      (and (some? truncation) (not (contains? #{:auto-height :auto-width} grow-type)))
      (obj/set! "maxHeight" "100%")

      ;; an auto-width text keeps shrink-wrapping its lines
      (some? max-lines)
      (-> (obj/set! "display" (if auto-width? "-webkit-inline-box" "-webkit-box"))
          (obj/set! "WebkitBoxOrient" "vertical")
          (obj/set! "WebkitLineClamp" (str max-lines))))))

;; zvena: Figma "Vertical trim" and "Hanging lists"
(declare generate-text-styles)

(def ^:private text-box-trim?
  "zvena: CSS text-box-trim support (Chrome 133+, Safari 18.2+). Elsewhere a
  vertically trimmed text renders like Figma's Standard."
  (and (exists? js/CSS)
       (fn? (.-supports js/CSS))
       (boolean (js/CSS.supports "text-box-trim" "trim-both"))))

(defn- set-paragraph-font!
  "zvena: the paragraph is the root inline box of its lines and CSS trims
  them with its font metrics, so it gets the font of its first run (its
  font size is 0 otherwise, which would trim down to the baseline)."
  [styles shape data]
  (let [run (generate-text-styles shape (txt/list-marker-attrs data))]
    (doseq [prop ["fontFamily" "fontWeight" "fontStyle" "fontSize"]]
      (let [value (obj/get run prop)]
        (when (some? value)
          (obj/set! styles prop value))))
    styles))

(defn generate-paragraph-styles
  "Paragraph styles. `opts`:
   - `:first?`  the paragraph is the first one (zvena: vertical trim)
   - `:last?`   the paragraph is the last one (no paragraph spacing after it)
   - `:marker`  list marker rendered inline (html/svg layouts): the list
                indent is then a hanging indent that the marker fills. The
                draft editor does not render it, so there the text is just
                padded."
  ([shape data]
   (generate-paragraph-styles shape data nil))
  ([shape data {:keys [first? last? marker]}]
   (let [line-height (:line-height data)
         line-height
         (if (and (some? line-height) (not= "" line-height))
           line-height
           (:line-height txt/default-typography))

         text-align  (:text-align data "start")
         base        #js {;; Fix a problem when exporting HTML
                          :fontSize 0
                          :lineHeight line-height
                          :margin 0}

         ;; zvena: Figma paragraph spacing, paragraph indent and lists
         spacing     (txt/paragraph-spacing data)
         list-type   (txt/list-type data)
         indent      (when (some? list-type)
                       (txt/list-indent list-type (:font-size (txt/list-marker-attrs data))))
         text-indent (when (nil? list-type)
                       (txt/paragraph-indent data))

         ;; zvena: Figma "Hanging lists" (the marker hangs outside the box)
         ;; and "Vertical trim: Cap height to baseline" (the first line is
         ;; trimmed to the cap height, the last one to the baseline)
         content     (:content shape)
         hanging?    (and (some? list-type) (txt/hanging-list? content))
         trim        (when (and text-box-trim?
                                (or first? last?)
                                (txt/vertical-trim? content))
                       (cond
                         (and first? last?) "trim-both"
                         first?             "trim-start"
                         :else              "trim-end"))]

     (cond-> base
       (some? line-height)       (obj/set! "lineHeight" line-height)
       (some? text-align)        (obj/set! "textAlign" text-align)

       (and (pos? spacing) (not last?))
       (obj/set! "marginBottom" (str spacing "px"))

       ;; zvena: an auto-width text never wraps, also between a list
       ;; marker and its text (truncation clips its box)
       (= :auto-width (:grow-type shape))
       (obj/set! "whiteSpace" "nowrap")

       (and (some? indent) (not hanging?)) ;; zvena: hanging lists
       (obj/set! "paddingInlineStart" (str indent "px"))

       (and (some? indent) (some? marker))
       (obj/set! "textIndent" (str (- indent) "px"))

       (and (some? text-indent) (pos? text-indent))
       (obj/set! "textIndent" (str text-indent "px"))

       ;; zvena: vertical trim
       (some? trim)
       (-> (obj/set! "textBoxTrim" trim)
           (obj/set! "textBoxEdge" "cap alphabetic")
           (set-paragraph-font! shape data))))))

(declare generate-text-styles)

(defn generate-list-marker-styles
  "zvena: the list marker is an inline-block as wide as the hanging indent,
  so the text after it starts where the following lines start."
  [shape paragraph]
  (let [attrs     (txt/list-marker-attrs paragraph)
        list-type (txt/list-type paragraph)
        indent    (txt/list-indent list-type (:font-size attrs))]
    (-> (generate-text-styles shape attrs)
        (obj/set! "display" "inline-block")
        (obj/set! "width" (str indent "px"))
        (obj/set! "textIndent" "0")
        (obj/set! "whiteSpace" "pre")
        (obj/set! "textDecoration" "none"))))

(defn generate-text-styles
  ([shape data]
   (generate-text-styles shape data nil))

  ([{:keys [grow-type] :as shape} data {:keys [show-text?] :or {show-text? true}}]
   (let [letter-spacing  (:letter-spacing data 0)
         text-decoration (:text-decoration data)
         text-transform  (:text-transform data)

         ;; zvena: Figma OpenType features and variable font axes
         font-features   (txt/css-font-feature-settings data)
         font-variations (txt/css-font-variation-settings data)

         font-id         (or (:font-id data)
                             (:font-id txt/default-typography))

         font-variant-id (:font-variant-id data)

         font-size       (:font-size data)

         fill-color      (or (-> data :fills first :fill-color) (:fill-color data))
         fill-opacity    (or (-> data :fills first :fill-opacity) (:fill-opacity data))
         fill-gradient   (or (-> data :fills first :fill-color-gradient) (:fill-color-gradient data))

         [r g b a]       (cc/hex->rgba fill-color fill-opacity)
         text-color      (when (and (some? fill-color) (some? fill-opacity))
                           (str/format "rgba(%s, %s, %s, %s)" r g b a))

         gradient?       (some? fill-gradient)

         text-color      (if gradient?
                           (uc/color->background {:gradient fill-gradient})
                           text-color)

         fontsdb         (deref fonts/fontsdb)

         base            #js {:textDecoration text-decoration
                              :textTransform text-transform
                              :fontSize font-size
                              :color (if (and show-text? (not gradient?)) text-color "transparent")
                              :background (when (and show-text? gradient?) text-color)
                              :caretColor (if (and (not gradient?) text-color) text-color "black")
                              :overflowWrap "initial"
                              :lineBreak "auto"
                              :whiteSpace "break-spaces"
                              :textRendering "geometricPrecision"}
         base            (cond-> base
                           (= (:line-height data) "0")
                           (-> (obj/set! "display" "inline-block")
                               (obj/set! "verticalAlign" "top")))
         fills
         (cond
           ;; DEPRECATED: still here for backward compatibility with
           ;; old penpot files that still has a single color.
           (or (some? (:fill-color data))
               (some? (:fill-opacity data))
               (some? (:fill-color-gradient data)))
           [(d/without-nils (select-keys data [:fill-color :fill-opacity :fill-color-gradient
                                               :fill-color-ref-id :fill-color-ref-file]))]

           (nil? (:fills data))
           [{:fill-color "#000000" :fill-opacity 1}]

           :else
           (:fills data))

         font (some->> font-id (get fontsdb))

         [font-family font-style font-weight]
         (when (some? font)
           (let [font-variant (d/seek #(= font-variant-id (:id %)) (:variants font))]
             [(str/quote (or (:family font) (:font-family data)))
              (or (:style font-variant) (:font-style data))
              (or (:weight font-variant) (:font-weight data))]))

         base (obj/set! base "--font-id" font-id)]

     (cond-> base
       (some? fills)
       (obj/set! "--fills" (transit/encode-str fills))

       (and (string? letter-spacing) (pos? (alength letter-spacing)))
       (obj/set! "letterSpacing" (str letter-spacing "px"))

       (and (string? font-size) (pos? (alength font-size)))
       (obj/set! "fontSize" (str font-size "px"))

       (some? font)
       (-> (obj/set! "fontFamily" font-family)
           (obj/set! "fontStyle" font-style)
           (obj/set! "fontWeight" font-weight))

       ;; zvena
       (some? font-features)
       (obj/set! "fontFeatureSettings" font-features)

       (some? font-variations)
       (obj/set! "fontVariationSettings" font-variations)

       (= grow-type :auto-width)
       (obj/set! "whiteSpace" "pre")))))
