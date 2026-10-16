;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

 (ns app.common.types.text
   (:require
    [app.common.data :as d]
    [app.common.data.macros :as dm]
    [app.common.flags :as flags]
    [app.common.math :as mth]
    [app.common.types.color :as clr]
    [app.common.types.fills :as types.fills]
    [clojure.set :as set]
    [clojure.walk :as walk]
    [cuerdas.core :as str]))

;; -- Attrs

(def text-typography-attrs
  [:typography-ref-id
   :typography-ref-file])

(def text-fill-attrs
  [:fill-color
   :fill-opacity
   :fill-color-ref-id
   :fill-color-ref-file
   :fill-color-gradient])

(def text-font-attrs
  [:font-id
   :font-family
   :font-variant-id
   :font-size
   :font-weight
   :font-style])

(def text-align-attrs
  [:text-align])

(def text-direction-attrs
  [:text-direction])

(def text-spacing-attrs
  [:line-height
   :letter-spacing])

(def text-valign-attrs
  [:vertical-align])

(def text-decoration-attrs
  [:text-decoration])

(def text-transform-attrs
  [:text-transform])

(def text-fills
  [:fills])

;; zvena: Figma "Type details". All of these are optional: a missing attr
;; means Figma's default (no spacing, no indent, no list, no truncation), so
;; existing files render exactly as before.
;;
;; - :paragraph-spacing  px between paragraphs (string, e.g. "8")
;; - :paragraph-indent   px first-line indent (string, e.g. "16")
;; - :list-type          "none" | "unordered" (bullets) | "ordered" (1. 2. 3.)
;; - :text-truncation    "disabled" | "ending" (ellipsis at the last visible line)
;; - :max-lines          max visible lines when truncating (string, e.g. "3")
(def text-paragraph-spacing-attrs
  [:paragraph-spacing
   :paragraph-indent])

(def text-list-attrs
  [:list-type])

(def text-truncation-attrs
  [:text-truncation
   :max-lines])

;; zvena: Figma "Type settings" (Details / Variable tabs and vertical trim).
;; Optional too: a missing attr renders exactly as before.
;;
;; Text runs (spans), CSS values as they are written in a style:
;; - :font-feature-settings   OpenType features, e.g. "\"liga\" 0, \"tnum\" 1"
;;                            ("normal" = the font defaults)
;; - :font-variation-settings variable font axes, e.g. "\"wght\" 450"
;;                            ("normal" = the font defaults)
;; Whole text (root):
;; - :vertical-trim  "standard" | "cap-height" (Figma "Cap height to baseline")
;; - :hanging-list   "true" | "false" (list markers outside the text box)
(def text-opentype-attrs
  [:font-feature-settings
   :font-variation-settings])

(def text-trim-attrs
  [:vertical-trim
   :hanging-list])

(def shape-attrs
  [:grow-type])

(def root-attrs
  (d/concat-vec
   text-valign-attrs
   text-truncation-attrs ;; zvena
   text-trim-attrs))     ;; zvena

(def paragraph-attrs
  (d/concat-vec
   text-align-attrs
   text-direction-attrs
   text-paragraph-spacing-attrs ;; zvena
   text-list-attrs))            ;; zvena

(def text-node-attrs
  (d/concat-vec
   text-typography-attrs
   text-font-attrs
   text-spacing-attrs
   text-decoration-attrs
   text-transform-attrs
   text-fills
   text-opentype-attrs)) ;; zvena

(def text-span-attrs
  "Inline text span attrs. Line-height is paragraph-level in the DOM editor;
   it may still be stored redundantly on span nodes."
  (vec (remove #{:line-height} text-node-attrs)))

(defn text-node-attr?
  [attr]
  (d/index-of text-node-attrs attr))

(def text-all-attrs (d/concat-set shape-attrs root-attrs paragraph-attrs text-node-attrs))

(def text-style-attrs
  (d/concat-vec root-attrs paragraph-attrs text-node-attrs))

(def default-root-attrs
  {:vertical-align "top"})

(def default-text-fills
  [{:fill-color clr/black
    :fill-opacity 1}])

(def default-paragraph-attrs
  {:text-align "left"
   :text-direction "ltr"})

;; Figma's default text style — Inter Regular 12 (upstream Source Sans Pro 14).
(def default-text-attrs
  {:typography-ref-file nil
   :typography-ref-id nil
   :font-id "gfont-inter"
   :font-family "Inter"
   :font-variant-id "regular"
   :font-size "12"
   :font-weight "400"
   :font-style "normal"
   :line-height "1.2"
   :letter-spacing "0"
   :text-transform "none"
   :text-align "left"
   :text-decoration "none"
   :text-direction "ltr"})

(defn get-default-text-fills
  "Return calculated default text fills"
  []
  (if (contains? flags/*current* :frontend-binary-fills)
    (types.fills/from-plain default-text-fills)
    default-text-fills))

(defn get-default-text-attrs
  "Return calculated default text attrs.

  NOTE: is implemented as function because it needs resolve at runtime
  the activated flag for properly encode the fills"
  []
  (assoc default-text-attrs :fills (get-default-text-fills)))

(def typography-fields
  [:font-id
   :font-family
   :font-variant-id
   :font-size
   :font-weight
   :font-style
   :line-height
   :letter-spacing
   :text-transform])

(def default-typography
  (-> default-text-attrs
      (select-keys typography-fields)
      (assoc :name "Source Sans Pro Regular")))

(defn node-seq
  ([root] (node-seq identity root))
  ([match? root]
   (->> (tree-seq map? :children root)
        (filter match?)
        (seq))))

(defn is-text-node?
  [node]
  (and (nil? (:type node))
       (string? (:text node))))

(defn is-paragraph-set-node?
  [node]
  (= "paragraph-set" (:type node)))

(defn is-paragraph-node?
  [node]
  (= "paragraph" (:type node)))

(defn is-root-node?
  [node]
  (= "root" (:type node)))

(defn is-node?
  [node]
  (or ^boolean (is-text-node? node)
      ^boolean (is-paragraph-node? node)
      ^boolean (is-paragraph-set-node? node)
      ^boolean (is-root-node? node)))

(defn is-content-node?
  "Only matches content nodes, ignoring the paragraph-set nodes."
  [node]
  (or ^boolean (is-text-node? node)
      ^boolean (is-paragraph-node? node)
      ^boolean (is-root-node? node)))

(defn transform-nodes
  ([transform root]
   (transform-nodes identity transform root))
  ([pred transform root]
   (walk/postwalk
    (fn [item]
      (if (and (is-node? item) (pred item))
        (transform item)
        item))
    root)))

(defn update-text-content
  [shape pred-fn update-fn attrs]
  (let [update-attrs-fn #(update-fn % attrs)
        transform   #(transform-nodes pred-fn update-attrs-fn %)]
    (-> shape
        (update :content transform))))

(defn generate-shape-name
  [text]
  (subs text 0 (min 280 (count text))))

(defn- compare-text-attr
  "Compare two attribute values and return true if they are different.
   Take into account the following:
    - Only process keys that belong to text node attrs (ignore deprecated
      attributes or other things that may be attached).
    - Consider nil values, empty strings or empty lists all equal.
    - Normalize numeric values (legacy) into strings.
    - No value is equal than the default value.
    - Numeric attrs (e.g. line-height) compare with float tolerance so
      editor/WASM round-trips like \"1.3333333333333333\" vs \"1.33333\"
      do not count as a real style change (avoids detaching tokens)."
  [key value1 value2]
  (when (text-node-attr? key)
    (let [default-value (get default-text-attrs key)
          normalize-value (fn [value]
                            (as-> value $
                              (if (number? $) (str $) $)
                              (if (or (d/empty? $) (= $ default-value))
                                nil
                                $)))
          value1' (normalize-value value1)
          value2' (normalize-value value2)]
      (cond
        (= value1' value2')
        false

        :else
        (let [n1 (when (string? value1') (d/parse-double value1'))
              n2 (when (string? value2') (d/parse-double value2'))]
          (if (and (some? n1) (some? n2))
            (not (mth/close? n1 n2))
            true))))))

(defn- compare-text-content
  "Given two content text structures, conformed by maps and vectors,
   compare them, and returns a set with the differences info.
   If the structures are equal, it returns an empty set. If the structure
   has changed, it returns :text-content-structure. There are two
   callbacks to specify what to return when there is a text change with
   the same structure, and when attributes change."
  [a b {:keys [text-cb attribute-cb] :as callbacks}]
  (cond
    ;; If a and b are equal, there is no diff
    (= a b)
    #{}

    ;; If types are different, the structure is different
    (not= (type a) (type b))
    #{:text-content-structure}

    ;; If they are maps, check the keys
    (map? a)
    (let [keys (-> (set/union (set (keys a)) (set (keys b)))
                   (disj :key))] ;; We have to ignore :key because it is a draft artifact
      (reduce
       (fn [acc k]
         (let [v1 (get a k)
               v2 (get b k)]
           (cond
             ;; If the key is :children, keep digging
             (= k :children)
             (if (not= (count v1) (count v2))
               #{:text-content-structure}
               (into acc
                     (apply set/union
                            (map #(compare-text-content %1 %2 callbacks) v1 v2))))

             ;; If the key is :text, and they are different, it is a text differece
             (= k :text)
             (if (not= v1 v2)
               (text-cb acc)
               acc)

             :else
             ;; If the key is not :text, and they are different, it is an attribute difference.
             ;; Take into account that some processes remove empty attributes, so in some
             ;; cases we will compare [] with nil, and this is not a difference.
             (if (compare-text-attr k v1 v2)
               (attribute-cb acc k)
               acc))))
       #{}
       keys))

    :else
    #{:text-content-structure}))

(defn equal-attrs?
  "Given a text structure, and a map of attrs, check that all the internal attrs in
   paragraphs and sentences have the same attrs"
  ([item attrs]
   ;; Ignore the root attrs of the content. We only want to check paragraphs and sentences
   (equal-attrs? item attrs true))
  ([item attrs ignore?]
   (let [item-attrs (dissoc item :text :type :key :children)]
     (and
      (or ignore?
          (empty? item-attrs)
          (= attrs (dissoc item :text :type :key :children)))
      (every? #(equal-attrs? % attrs false) (:children item))))))

(defn get-first-paragraph-text-attrs
  "Given a content text structure, extract it's first paragraph
   text attrs"
  [content]
  (-> content
      (dm/get-in [:children 0 :children 0])
      (dissoc :text :type :key :children)))

(defn get-diff-type
  "Given two content text structures, conformed by maps and vectors,
   compare them, and returns a set with the type of differences.
   The possibilities are
     :text-content-text
     :text-content-attribute
     :text-content-structure"
  [a b]
  (compare-text-content a b
                        {:text-cb      (fn [acc] (conj acc :text-content-text))
                         :attribute-cb (fn [acc _] (conj acc :text-content-attribute))}))

(defn get-diff-attrs
  "Given two content text structures, conformed by maps and vectors,
   compare them, and returns a set with the attributes that have changed.
   This is independent of the text structure, so if the structure changes
   but the attributes are the same, it will return an empty set.

   Line-height on text nodes is ignored: it is a paragraph-level attribute
   and may be stored redundantly on spans (e.g. after token apply)."
  [a b]
  (let [strip-span-line-height
        #(transform-nodes is-text-node? (fn [node] (dissoc node :line-height)) %)
        a (strip-span-line-height a)
        b (strip-span-line-height b)
        diff-attrs (compare-text-content a b
                                         {:text-cb      identity
                                          :attribute-cb (fn [acc attr] (conj acc attr))})]
    (if-not (contains? diff-attrs :text-content-structure)
      diff-attrs
      (let [;; get attrs of the first paragraph of the first paragraph-set
            attrs (get-first-paragraph-text-attrs a)]
        (if (and (equal-attrs? a attrs)
                 (equal-attrs? b attrs))
          #{}
          (disj diff-attrs :text-content-structure))))))

;; TODO We know that there are cases that the blocks of texts are separated
;; differently: ["one" " " "two"], ["one " "two"], ["one" " two"]
;; so this won't work for 100% of the situations. But it's good enough for now,
;; we can iterate on the solution again in the future if needed.
(defn equal-structure?
  "Given two content text structures, check that the structures are equal.
   This means that all the :children keys at any level has the same number of
   entries"
  [a b]
  (cond
    (and (not= (type a) (type b))
         (not (and (map? a) (map? b)))) ;; Sometimes they are both maps but of different subtypes
    false

    (map? a)
    (let [children-a (:children a)
          children-b (:children b)]
      (if (not= (count children-a) (count children-b))
        false
        (every? true?
                (map equal-structure? children-a children-b))))

    :else
    true))

(defn copy-text-keys
  "Given two equal content text structures, deep copy all the keys :text
   from origin to destiny"
  [origin destiny]
  (cond
    (map? origin)
    (into {}
          (for [k (keys destiny) :when (not= k :key)] ;; We ignore :key because it is a draft artifact
            (cond
              (= :children k)
              [k (vec (map #(copy-text-keys %1 %2) (get origin k) (get destiny k)))]
              (= :text k)
              [k (:text origin)]
              :else
              [k (get destiny k)])))))

(defn copy-attrs-keys
  "Given a content text structure and a list of attrs, copy that
   attrs values on all the content tree"
  [content attrs]
  (into {}
        (for [[k v] content]
          (if (= :children k)
            [k (vec (map #(copy-attrs-keys %1 attrs) v))]
            [k (get attrs k v)]))))


(defn content-has-text?
  [content search]
  (let [search-lower (str/lower search)]
    (->> (node-seq is-text-node? content)
         (some #(str/includes? (str/lower (:text %)) search-lower))
         (boolean))))

(defn replace-all-case-insensitive
  [text search replacement]
  (let [text-lower   (str/lower text)
        search-lower (str/lower search)
        search-len   (count search)]
    (loop [result "" idx 0]
      (let [found (str/index-of text-lower search-lower idx)]
        (if (nil? found)
          (str result (subs text idx))
          (recur (str result (subs text idx found) replacement)
                 (+ found search-len)))))))

(defn replace-text-in-content
  [content search replacement]
  (transform-nodes
   is-text-node?
   (fn [node] (update node :text replace-all-case-insensitive search replacement))
   content))

(defn content->text
  "Given a root node of a text content extracts the texts with its associated styles"
  [content]
  (letfn [(add-node [acc node]
            (cond
              (is-paragraph-node? node)
              (conj acc [])

              (is-text-node? node)
              (let [i (dec (count acc))]
                (update acc i conj (:text node)))

              :else
              acc))]
    (->> (node-seq content)
         (reduce add-node [])
         (map #(str/join "" %))
         (str/join "\n"))))

(defn content->text+styles
  "Given a root node of a text content extracts the texts with its associated styles"
  [node]
  (letfn
   [(rec-style-text-map [acc node style]
      (let [node-style (merge style (select-keys node text-all-attrs))
            head (or (-> acc first) [{} ""])
            [head-style head-text] head

            new-acc
            (cond
              (not (is-text-node? node))
              (reduce #(rec-style-text-map %1 %2 node-style) acc (:children node))

              (not= head-style node-style)
              (cons [node-style (:text node "")] acc)

              :else
              (cons [node-style (dm/str head-text "" (:text node))] (rest acc)))

            ;; We add an end-of-line when finish a paragraph
            new-acc
            (if (= (:type node) "paragraph")
              (let [[hs ht] (first new-acc)]
                (cons [hs (dm/str ht "\n")] (rest new-acc)))
              new-acc)]
        new-acc))]

    (-> (rec-style-text-map [] node {})
        reverse)))

(defn change-text
  "Changes the content of the text shape to use the text as argument. Will use the styles of the
   first paragraph and text that is present in the shape (and override the rest)"
  [content text & {:as styles}]
  (let [root-styles (select-keys content root-attrs)

        paragraph-style
        (merge
         default-text-attrs
         styles
         (select-keys (->> content (node-seq is-paragraph-node?) first) text-all-attrs))

        text-style
        (merge
         default-text-attrs
         styles
         (select-keys (->> content (node-seq is-text-node?) first) text-all-attrs))

        paragraph-texts
        (str/split text "\n")

        paragraphs
        (->> paragraph-texts
             (mapv
              (fn [pt]
                (merge
                 paragraph-style
                 {:type "paragraph"
                  :children [(merge {:text pt} text-style)]}))))]


    (d/patch-object
     {:type "root"
      :children
      [{:type "paragraph-set"
        :children paragraphs}]}
     root-styles)))

;; -- zvena: Figma paragraph spacing / indent, lists and truncation

(defn- attr->number
  "Text attrs are stored as strings (\"8\"); accept numbers too."
  [value]
  (let [value (cond
                (number? value) value
                (string? value) (d/parse-double value)
                :else nil)]
    (when (mth/finite? value)
      value)))

(defn paragraph-spacing
  "Figma \"Paragraph spacing\": px added after the paragraph (between
  paragraphs, never after the last one). 0 when not set."
  [paragraph]
  (let [value (attr->number (:paragraph-spacing paragraph))]
    (if (and (some? value) (pos? value)) value 0)))

(defn paragraph-indent
  "Figma \"Paragraph indent\": px of first-line indent. 0 when not set.
  List paragraphs ignore it (they use a hanging indent instead)."
  [paragraph]
  (let [value (attr->number (:paragraph-indent paragraph))]
    (if (and (some? value) (pos? value)) value 0)))

(defn list-type
  "Returns \"unordered\" or \"ordered\" for list paragraphs, nil otherwise."
  [paragraph]
  (let [value (:list-type paragraph)]
    (when (or (= value "unordered") (= value "ordered"))
      value)))

(defn list-markers
  "Given the paragraphs of a text returns a vector with the list marker of
  every paragraph (nil when it is not a list item). Like Figma, consecutive
  numbered paragraphs count 1. 2. 3. ... and any other paragraph restarts
  the numbering."
  [paragraphs]
  (loop [paragraphs (seq paragraphs)
         counter    0
         result     (transient [])]
    (if-let [paragraph (first paragraphs)]
      (case (list-type paragraph)
        "ordered"
        (recur (rest paragraphs) (inc counter) (conj! result (str (inc counter) ".")))

        "unordered"
        (recur (rest paragraphs) 0 (conj! result "\u2022"))

        (recur (rest paragraphs) 0 (conj! result nil)))
      (persistent! result))))

(defn list-marker-attrs
  "The list marker is drawn with the style of the first character of the
  paragraph (or the paragraph style when it is empty)."
  [paragraph]
  (let [node (-> paragraph :children first)]
    (if (and (some? node) (not= "" (:text node)))
      node
      paragraph)))

(defn list-indent
  "Hanging indent (px) of a list paragraph: the marker sits in this gutter
  and every line of the text starts after it."
  [list-type font-size]
  (let [font-size (attr->number font-size)
        font-size (if (and (some? font-size) (pos? font-size))
                    font-size
                    (attr->number (:font-size default-text-attrs)))]
    (mth/ceil (* font-size (if (= list-type "ordered") 2.0 1.5)))))

(defn truncation
  "Figma \"Truncate text\": nil when the text is not truncated, otherwise a
  map with the optional `:max-lines` (positive integer)."
  [content]
  (when (= "ending" (:text-truncation content))
    (let [max-lines (attr->number (:max-lines content))]
      {:max-lines (when (and (some? max-lines) (>= max-lines 1))
                    (mth/floor max-lines))})))

(defn without-truncation
  "Content with the truncation removed (Figma shows the whole text while it
  is being edited)."
  [content]
  (cond-> content
    (map? content)
    (dissoc :text-truncation :max-lines)))

;; -- zvena: Figma "Type settings": OpenType features, variable axes,
;; vertical trim and hanging lists

(def ^:private css-tag-value-re
  #"^\s*[\"']([A-Za-z0-9_ ]{4})[\"']\s*(\S*)\s*$")

(defn- parse-css-tag-values
  "Parses a CSS font-feature-settings / font-variation-settings value into a
  map of 4-letter tag -> number. `default` is the value of a tag written
  without one (1 for features, none for axes)."
  [value default]
  (if (and (string? value) (not= value "") (not= value "normal"))
    (reduce
     (fn [result part]
       (if-let [[_ tag v] (re-find css-tag-value-re part)]
         (let [v (cond
                   (= v "")    default
                   (= v "on")  1
                   (= v "off") 0
                   :else       (d/parse-double v))]
           (if (mth/finite? v)
             (assoc result tag v)
             result))
         result))
     {}
     (str/split value ","))
    {}))

(defn- format-tag-value
  [v]
  (let [v (mth/precision v 2)]
    (if (== v (mth/floor v))
      (str (long v))
      (str v))))

(defn tag-values->css
  "A map of tag -> value as a CSS settings value, sorted so equal settings
  are equal strings. \"normal\" when empty."
  [values]
  (if (empty? values)
    "normal"
    (->> (sort-by key values)
         (map (fn [[tag v]] (str "\"" tag "\" " (format-tag-value v))))
         (str/join ", "))))

(defn font-features
  "OpenType features of a text run as a map of tag -> value (1 on, 0 off,
  n an alternate). Empty when the run uses the font defaults."
  [node]
  (parse-css-tag-values (:font-feature-settings node) 1))

(defn font-variations
  "Variable font axes of a text run as a map of tag -> value. Empty when the
  run uses the font defaults."
  [node]
  (parse-css-tag-values (:font-variation-settings node) nil))

(defn update-font-features
  "Applies `changes` (tag -> value, nil removes the tag) to the CSS
  font-feature-settings `value` (a string, nil or :multiple)."
  [value changes]
  (tag-values->css
   (reduce-kv (fn [result tag v]
                (if (nil? v) (dissoc result tag) (assoc result tag v)))
              (parse-css-tag-values value 1)
              changes)))

(defn update-font-variations
  "Like `update-font-features` for the CSS font-variation-settings."
  [value changes]
  (tag-values->css
   (reduce-kv (fn [result tag v]
                (if (nil? v) (dissoc result tag) (assoc result tag v)))
              (parse-css-tag-values value nil)
              changes)))

(defn css-font-feature-settings
  "The CSS font-feature-settings of a text run, nil for the font defaults."
  [node]
  (let [features (font-features node)]
    (when (seq features)
      (tag-values->css features))))

(defn css-font-variation-settings
  "The CSS font-variation-settings of a text run, nil for the font defaults."
  [node]
  (let [variations (font-variations node)]
    (when (seq variations)
      (tag-values->css variations))))

(defn vertical-trim?
  "Figma \"Vertical trim: Cap height to baseline\" (root attr)."
  [content]
  (= "cap-height" (:vertical-trim content)))

(defn hanging-list?
  "Figma \"Hanging lists\": list markers outside the text box (root attr)."
  [content]
  (= "true" (:hanging-list content)))
