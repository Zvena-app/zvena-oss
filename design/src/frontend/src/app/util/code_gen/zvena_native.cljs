;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.util.code-gen.zvena-native
  "zvena: Dev Mode code for iOS (SwiftUI) and Android (Jetpack Compose),
  as Figma's Dev Mode offers next to CSS. The code is a starting point:
  layout from auto layout (stacks / rows and columns), absolute children
  as offsets, fills, strokes, corner radii, shadows, opacity, rotation and
  text styles. Vectors and images are referenced as assets."
  (:require
   [app.common.data :as d]
   [app.common.math :as mth]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.text :as txt]
   [cuerdas.core :as str]))

;; --- helpers

(defn- num
  "A number without useless decimals."
  [v]
  (let [v (mth/precision (or v 0) 2)]
    (if (== v (mth/round v)) (str (int (mth/round v))) (str v))))

(defn- ind [n] (str/repeat "    " n))

(defn- hex->rgb
  [hex]
  (let [hex (str/replace (or hex "#000000") "#" "")
        hex (if (= 3 (count hex)) (apply str (mapcat #(vector % %) hex)) hex)
        p   #(js/parseInt (subs hex % (+ % 2)) 16)]
    [(p 0) (p 2) (p 4)]))

(defn- visible [coll] (remove :hidden coll))

(defn- text-content
  [shape]
  (some-> (:content shape) txt/content->text))

(defn- first-text-style
  [shape]
  (->> (some-> (:content shape) txt/node-seq)
       (filter txt/is-text-node?)
       (first)))

(defn- first-paragraph
  [shape]
  (->> (some-> (:content shape) txt/node-seq)
       (filter txt/is-paragraph-node?)
       (first)))

(defn- children
  [objects shape]
  (let [kids (->> (:shapes shape) (keep #(get objects %)) (remove :hidden))]
    ;; auto layout order is the reverse of the drawing order
    (if (ctl/any-layout? shape) (reverse kids) kids)))

(defn- rel-pos
  [objects shape]
  (let [parent (get objects (:parent-id shape))
        sr     (:selrect shape)
        psr    (:selrect parent)]
    (if (and parent (not= (:id parent) (:id shape)) psr (not= :group (:type parent)))
      [(- (:x sr) (:x psr)) (- (:y sr) (:y psr))]
      [(:x sr) (:y sr)])))

(defn- radii [shape] (mapv #(or (get shape %) 0) [:r1 :r2 :r3 :r4]))

(defn- vector-like? [shape] (contains? #{:path :bool :svg-raw} (:type shape)))

(defn- asset-name
  [shape]
  (-> (or (:name shape) "asset") (str/slug) (str/replace "-" "_")))

(defn- flex-dir [shape] (:layout-flex-dir shape :row))
(defn- row? [shape] (contains? #{:row :row-reverse} (flex-dir shape)))

(defn- gap
  [shape]
  (let [{:keys [row-gap column-gap]} (:layout-gap shape)]
    (if (row? shape) (or column-gap 0) (or row-gap 0))))

(defn- padding [shape] (let [{:keys [p1 p2 p3 p4]} (:layout-padding shape)] [(or p1 0) (or p2 0) (or p3 0) (or p4 0)]))

;; --- SwiftUI

(defn- swift-color
  [hex opacity]
  (let [[r g b] (hex->rgb hex)]
    (str "Color(red: " (num (/ r 255)) ", green: " (num (/ g 255)) ", blue: " (num (/ b 255))
         (when (and (some? opacity) (< opacity 1)) (str ", opacity: " (num opacity))) ")")))

(defn- swift-gradient
  [{:keys [type start-x start-y end-x end-y stops]} w h]
  (let [stops (str "Gradient(stops: ["
                   (str/join ", " (for [{:keys [color opacity offset]} stops]
                                    (str ".init(color: " (swift-color color opacity) ", location: " (num offset) ")")))
                   "])")]
    (case type
      :radial (str "RadialGradient(gradient: " stops ", center: UnitPoint(x: " (num start-x) ", y: " (num start-y)
                   "), startRadius: 0, endRadius: " (num (/ (max w h) 2)) ")")
      :angular (str "AngularGradient(gradient: " stops ", center: UnitPoint(x: " (num start-x) ", y: " (num start-y) "))")
      (str "LinearGradient(gradient: " stops ", startPoint: UnitPoint(x: " (num start-x) ", y: " (num start-y)
           "), endPoint: UnitPoint(x: " (num end-x) ", y: " (num end-y) "))"))))

(defn- swift-fill
  [fill w h]
  (cond
    (:fill-color-gradient fill) (swift-gradient (:fill-color-gradient fill) w h)
    (:fill-color fill)          (swift-color (:fill-color fill) (:fill-opacity fill))
    :else nil))

(defn- swift-shape
  [shape]
  (let [[r1 r2 r3 r4] (radii shape)]
    (cond
      (= :circle (:type shape)) "Ellipse()"
      (= r1 r2 r3 r4 0) "Rectangle()"
      (= r1 r2 r3 r4) (str "RoundedRectangle(cornerRadius: " (num r1) ", style: .continuous)")
      :else (str "UnevenRoundedRectangle(topLeadingRadius: " (num r1) ", bottomLeadingRadius: " (num r4)
                 ", bottomTrailingRadius: " (num r3) ", topTrailingRadius: " (num r2) ", style: .continuous)"))))

(defn- swift-text-modifiers
  [shape level]
  (let [style  (first-text-style shape)
        para   (first-paragraph shape)
        size   (d/parse-double (:font-size style) 14)
        weight (d/parse-integer (:font-weight style) 400)
        fill   (first (:fills style))
        line-h (d/parse-double (:line-height style) 1.2)
        ls     (d/parse-double (:letter-spacing style) 0)
        align  (:text-align para)
        weights {100 ".ultraLight" 200 ".thin" 300 ".light" 400 ".regular" 500 ".medium"
                 600 ".semibold" 700 ".bold" 800 ".heavy" 900 ".black"}]
    (cond-> [(str ".font(.custom(\"" (or (:font-family style) "Inter") "\", size: " (num size) ").weight("
                  (get weights (* 100 (mth/round (/ weight 100))) ".regular") "))")]
      (= "italic" (:font-style style)) (conj ".italic()")
      (:fill-color fill) (conj (str ".foregroundStyle(" (swift-color (:fill-color fill) (:fill-opacity fill)) ")"))
      (> line-h 1.0) (conj (str ".lineSpacing(" (num (* size (- line-h 1))) ")"))
      (not (zero? ls)) (conj (str ".kerning(" (num ls) ")"))
      (= "center" align) (conj ".multilineTextAlignment(.center)")
      (= "right" align) (conj ".multilineTextAlignment(.trailing)")
      (= "underline" (:text-decoration style)) (conj ".underline()")
      (= "line-through" (:text-decoration style)) (conj ".strikethrough()")
      :always (->> (map #(str (ind level) %))))))

(defn- swift-common-modifiers
  [objects shape level parent-layout?]
  (let [{:keys [width height]} (:selrect shape)
        fills   (visible (:fills shape))
        strokes (visible (:strokes shape))
        shadows (visible (:shadow shape))
        blur    (:blur shape)
        shape-s (swift-shape shape)
        text?   (= :text (:type shape))
        [x y]   (rel-pos objects shape)
        h-fill? (= :fill (:layout-item-h-sizing shape))
        v-fill? (= :fill (:layout-item-v-sizing shape))
        auto-w? (and text? (contains? #{:auto-width} (:grow-type shape)))
        auto-h? (and text? (contains? #{:auto-width :auto-height} (:grow-type shape)))]
    (->> (cond-> []
           (ctl/any-layout? shape)
           (conj (let [[p1 p2 p3 p4] (padding shape)]
                   (str ".padding(EdgeInsets(top: " (num p1) ", leading: " (num p4) ", bottom: " (num p3) ", trailing: " (num p2) "))")))

           (not (and auto-w? auto-h?))
           (conj (str ".frame("
                      (str/join ", " (remove nil? [(cond h-fill? "maxWidth: .infinity" auto-w? nil :else (str "width: " (num width)))
                                                   (cond v-fill? "maxHeight: .infinity" auto-h? nil :else (str "height: " (num height)))]))
                      (when (and (not h-fill?) (not v-fill?) (ctl/any-layout? shape)) ", alignment: .topLeading")
                      ")"))

           (and (not text?) (not (vector-like? shape)) (seq fills))
           (into (for [fill (reverse fills)
                       :let [f (swift-fill fill width height)]
                       :when f]
                   (str ".background(" f ", in: " shape-s ")")))

           (and (not text?) (some :fill-image fills))
           (conj (str ".background(Image(\"" (asset-name shape) "\").resizable().scaledToFill())"))

           (and (not text?) (not= shape-s "Rectangle()") (not (vector-like? shape)))
           (conj (str ".clipShape(" shape-s ")"))

           (and (seq strokes) (not text?))
           (into (for [{:keys [stroke-color stroke-opacity stroke-width stroke-alignment]} strokes
                       :when stroke-color]
                   (str ".overlay(" shape-s "." (if (= :inner stroke-alignment) "strokeBorder" "stroke")
                        "(" (swift-color stroke-color stroke-opacity) ", lineWidth: " (num stroke-width) "))")))

           (seq shadows)
           (into (for [{:keys [style offset-x offset-y blur color]} shadows
                       :when (= style :drop-shadow)]
                   (str ".shadow(color: " (swift-color (:color color) (:opacity color)) ", radius: " (num (/ blur 2))
                        ", x: " (num offset-x) ", y: " (num offset-y) ")")))

           (and blur (not (:hidden blur)) (pos? (:value blur 0)))
           (conj (str ".blur(radius: " (num (/ (:value blur) 2)) ")"))

           (and (:opacity shape) (< (:opacity shape) 1))
           (conj (str ".opacity(" (num (:opacity shape)) ")"))

           (and (:rotation shape) (not (zero? (:rotation shape))))
           (conj (str ".rotationEffect(.degrees(" (num (:rotation shape)) "))"))

           (and (not parent-layout?) (or (not (zero? x)) (not (zero? y))))
           (conj (str ".offset(x: " (num x) ", y: " (num y) ")")))
         (map #(str (ind level) %)))))

(declare swift-node)

(defn- swift-stack
  [shape]
  (let [align (:layout-align-items shape :start)]
    (cond
      (not (ctl/flex-layout? shape)) "ZStack(alignment: .topLeading)"
      (row? shape)
      (str "HStack(alignment: " (case align :center ".center" :end ".bottom" ".top") ", spacing: " (num (gap shape)) ")")
      :else
      (str "VStack(alignment: " (case align :center ".center" :end ".trailing" ".leading") ", spacing: " (num (gap shape)) ")"))))

(defn- swift-node
  [objects shape level parent-layout?]
  (let [head (ind level)
        comment (str head "// " (:name shape))]
    (case (:type shape)
      :text
      (str/join "\n" (concat [comment
                              (str head "Text(" (js/JSON.stringify (or (text-content shape) "")) ")")]
                             (swift-text-modifiers shape (inc level))
                             (swift-common-modifiers objects shape (inc level) parent-layout?)))

      (:path :bool :svg-raw)
      (str/join "\n" (concat [comment
                              (str head "Image(\"" (asset-name shape) "\") // export this layer as a PDF/SVG asset")
                              (str (ind (inc level)) ".resizable()")]
                             (swift-common-modifiers objects shape (inc level) parent-layout?)))

      (:frame :group)
      (let [kids    (children objects shape)
            layout? (ctl/flex-layout? shape)
            inner   (->> kids (map #(swift-node objects % (inc level) layout?)))
            inner   (if (and layout? (= :space-between (:layout-justify-content shape)) (> (count kids) 1))
                      (interpose (str (ind (inc level)) "Spacer()") inner)
                      inner)]
        (str/join "\n" (concat [comment
                                (str head (swift-stack shape) " {")]
                               inner
                               [(str head "}")]
                               (swift-common-modifiers objects shape (inc level) parent-layout?))))

      ;; rect, circle, image
      (str/join "\n" (concat [comment
                              (str head (swift-shape shape))
                              (str (ind (inc level)) ".fill(Color.clear)")]
                             (swift-common-modifiers objects shape (inc level) parent-layout?))))))

(defn generate-swiftui
  [objects shapes]
  (str "import SwiftUI\n\n"
       (str/join "\n\n" (for [shape shapes]
                          (let [view (-> (str/camel (or (:name shape) "Layer")) (str/capital) (str/replace #"[^A-Za-z0-9_]" ""))
                                view (if (re-find #"^[A-Za-z]" view) view (str "Layer" view))]
                            (str "struct " view "View: View {\n"
                                 "    var body: some View {\n"
                                 (swift-node objects (get objects (:id shape) shape) 2 false) "\n"
                                 "    }\n"
                                 "}"))))))

;; --- Jetpack Compose

(defn- kt-color
  [hex opacity]
  (let [[r g b] (hex->rgb hex)
        a (mth/round (* 255 (or opacity 1)))
        h #(str/pad (str/upper (.toString % 16)) {:length 2 :padding "0"})]
    (str "Color(0x" (h a) (h r) (h g) (h b) ")")))

(defn- kt-shape
  [shape]
  (let [[r1 r2 r3 r4] (radii shape)]
    (cond
      (= :circle (:type shape)) "GenericShape { size, _ -> addOval(Rect(Offset.Zero, size)) }"
      (= r1 r2 r3 r4 0) "RectangleShape"
      (= r1 r2 r3 r4) (str "RoundedCornerShape(" (num r1) ".dp)")
      :else (str "RoundedCornerShape(topStart = " (num r1) ".dp, topEnd = " (num r2) ".dp, bottomEnd = " (num r3)
                 ".dp, bottomStart = " (num r4) ".dp)"))))

(defn- kt-brush
  [{:keys [type start-x start-y end-x end-y stops]} w h]
  (let [cs (str/join ", " (for [{:keys [color opacity offset]} stops]
                            (str (num offset) "f to " (kt-color color opacity))))]
    (case type
      :radial (str "Brush.radialGradient(" cs ", center = Offset(" (num (* w start-x)) "f, " (num (* h start-y))
                   "f), radius = " (num (/ (max w h) 2)) "f)")
      :angular (str "Brush.sweepGradient(" cs ", center = Offset(" (num (* w start-x)) "f, " (num (* h start-y)) "f))")
      (str "Brush.linearGradient(" cs ", start = Offset(" (num (* w start-x)) "f, " (num (* h start-y))
           "f), end = Offset(" (num (* w end-x)) "f, " (num (* h end-y)) "f))"))))

(defn- kt-modifier
  [objects shape level parent-layout?]
  (let [{:keys [width height]} (:selrect shape)
        fills   (visible (:fills shape))
        strokes (visible (:strokes shape))
        shadows (visible (:shadow shape))
        text?   (= :text (:type shape))
        sh      (kt-shape shape)
        [x y]   (rel-pos objects shape)
        h-fill? (= :fill (:layout-item-h-sizing shape))
        v-fill? (= :fill (:layout-item-v-sizing shape))
        auto-w? (and text? (= :auto-width (:grow-type shape)))
        auto-h? (and text? (contains? #{:auto-width :auto-height} (:grow-type shape)))
        parts
        (cond-> []
          (and (not parent-layout?) (or (not (zero? x)) (not (zero? y))))
          (conj (str ".offset(x = " (num x) ".dp, y = " (num y) ".dp)"))

          (and (:rotation shape) (not (zero? (:rotation shape))))
          (conj (str ".rotate(" (num (:rotation shape)) "f)"))

          h-fill? (conj ".fillMaxWidth()")
          v-fill? (conj ".fillMaxHeight()")
          (and (not h-fill?) (not auto-w?)) (conj (str ".width(" (num width) ".dp)"))
          (and (not v-fill?) (not auto-h?)) (conj (str ".height(" (num height) ".dp)"))

          (some #(= :drop-shadow (:style %)) shadows)
          (conj (let [{:keys [blur]} (first (filter #(= :drop-shadow (:style %)) shadows))]
                  (str ".shadow(" (num (/ blur 2)) ".dp, " sh ")")))

          (and (not text?) (not= sh "RectangleShape")) (conj (str ".clip(" sh ")"))

          (and (not text?) (not (vector-like? shape)))
          (into (for [fill (reverse fills)
                      :let [b (cond
                                (:fill-color-gradient fill) (str ".background(" (kt-brush (:fill-color-gradient fill) width height) ")")
                                (:fill-color fill) (str ".background(" (kt-color (:fill-color fill) (:fill-opacity fill)) ")")
                                (:fill-image fill) (str ".paint(painterResource(R.drawable." (asset-name shape) "), contentScale = ContentScale.Crop)"))]
                      :when b]
                  b))

          (and (seq strokes) (not text?))
          (into (for [{:keys [stroke-color stroke-opacity stroke-width]} strokes :when stroke-color]
                  (str ".border(" (num stroke-width) ".dp, " (kt-color stroke-color stroke-opacity) ", " sh ")")))

          (and (:opacity shape) (< (:opacity shape) 1))
          (conj (str ".alpha(" (num (:opacity shape)) "f)"))

          (ctl/any-layout? shape)
          (conj (let [[p1 p2 p3 p4] (padding shape)]
                  (str ".padding(start = " (num p4) ".dp, top = " (num p1) ".dp, end = " (num p2) ".dp, bottom = " (num p3) ".dp)"))))]
    (str (ind level) "modifier = Modifier"
         (str/join "" (map #(str "\n" (ind (inc level)) %) parts)))))

(declare kt-node)

(defn- kt-container
  [shape]
  (let [align   (:layout-align-items shape :start)
        justify (:layout-justify-content shape :start)
        g       (num (gap shape))]
    (cond
      (not (ctl/flex-layout? shape)) ["Box" nil]
      (row? shape)
      ["Row" [(str "horizontalArrangement = " (case justify
                                                :center "Arrangement.spacedBy(" g ".dp, Alignment.CenterHorizontally)"
                                                :end (str "Arrangement.spacedBy(" g ".dp, Alignment.End)")
                                                :space-between "Arrangement.SpaceBetween"
                                                :space-around "Arrangement.SpaceAround"
                                                :space-evenly "Arrangement.SpaceEvenly"
                                                (str "Arrangement.spacedBy(" g ".dp)")))
              (str "verticalAlignment = " (case align :center "Alignment.CenterVertically" :end "Alignment.Bottom" "Alignment.Top"))]]
      :else
      ["Column" [(str "verticalArrangement = " (case justify
                                                 :center (str "Arrangement.spacedBy(" g ".dp, Alignment.CenterVertically)")
                                                 :end (str "Arrangement.spacedBy(" g ".dp, Alignment.Bottom)")
                                                 :space-between "Arrangement.SpaceBetween"
                                                 :space-around "Arrangement.SpaceAround"
                                                 :space-evenly "Arrangement.SpaceEvenly"
                                                 (str "Arrangement.spacedBy(" g ".dp)")))
                 (str "horizontalAlignment = " (case align :center "Alignment.CenterHorizontally" :end "Alignment.End" "Alignment.Start"))]])))

(defn- kt-text-args
  [shape level]
  (let [style  (first-text-style shape)
        para   (first-paragraph shape)
        size   (d/parse-double (:font-size style) 14)
        weight (d/parse-integer (:font-weight style) 400)
        fill   (first (:fills style))
        line-h (d/parse-double (:line-height style) 1.2)
        ls     (d/parse-double (:letter-spacing style) 0)
        align  (:text-align para)]
    (->> (cond-> [(str "fontFamily = FontFamily.Default // " (or (:font-family style) "Inter"))
                  (str "fontSize = " (num size) ".sp")
                  (str "fontWeight = FontWeight(" weight ")")
                  (str "lineHeight = " (num (* size line-h)) ".sp")]
           (= "italic" (:font-style style)) (conj "fontStyle = FontStyle.Italic")
           (:fill-color fill) (conj (str "color = " (kt-color (:fill-color fill) (:fill-opacity fill))))
           (not (zero? ls)) (conj (str "letterSpacing = " (num ls) ".sp"))
           (= "center" align) (conj "textAlign = TextAlign.Center")
           (= "right" align) (conj "textAlign = TextAlign.End")
           (= "underline" (:text-decoration style)) (conj "textDecoration = TextDecoration.Underline")
           (= "line-through" (:text-decoration style)) (conj "textDecoration = TextDecoration.LineThrough"))
         (map #(str (ind level) % ",")))))

(defn- kt-node
  [objects shape level parent-layout?]
  (let [head (ind level)
        comment (str head "// " (:name shape))]
    (case (:type shape)
      :text
      (str/join "\n" (concat [comment
                              (str head "Text(")
                              (str (ind (inc level)) "text = " (js/JSON.stringify (or (text-content shape) "")) ",")]
                             (kt-text-args shape (inc level))
                             [(kt-modifier objects shape (inc level) parent-layout?)
                              (str head ")")]))

      (:path :bool :svg-raw)
      (str/join "\n" [comment
                      (str head "Image(")
                      (str (ind (inc level)) "painter = painterResource(R.drawable." (asset-name shape) "), // export as a vector drawable")
                      (str (ind (inc level)) "contentDescription = " (js/JSON.stringify (or (:name shape) "")) ",")
                      (kt-modifier objects shape (inc level) parent-layout?)
                      (str head ")")])

      (:frame :group)
      (let [kids    (children objects shape)
            layout? (ctl/flex-layout? shape)
            [container args] (kt-container shape)]
        (str/join "\n" (concat [comment
                                (str head container "(")
                                (str (kt-modifier objects shape (inc level) parent-layout?) (when (seq args) ","))]
                               (map-indexed (fn [i a] (str (ind (inc level)) a (when (< i (dec (count args))) ","))) args)
                               [(str head ") {")]
                               (map #(kt-node objects % (inc level) layout?) kids)
                               [(str head "}")])))

      (str/join "\n" [comment
                      (str head "Box(")
                      (kt-modifier objects shape (inc level) parent-layout?)
                      (str head ")")]))))

(defn generate-compose
  [objects shapes]
  (str "@Composable\n"
       (str/join "\n\n@Composable\n"
                 (for [shape shapes]
                   (let [fname (-> (str/camel (or (:name shape) "Layer")) (str/capital) (str/replace #"[^A-Za-z0-9_]" ""))
                         fname (if (re-find #"^[A-Za-z]" fname) fname (str "Layer" fname))]
                     (str "fun " fname "() {\n"
                          (kt-node objects (get objects (:id shape) shape) 1 false) "\n"
                          "}"))))))

(defn generate
  [objects type shapes]
  (case type
    "swiftui" (generate-swiftui objects shapes)
    "compose" (generate-compose objects shapes)
    ""))
