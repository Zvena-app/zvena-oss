;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.common.types.shape.zvena-vars
  "zvena: Figma variables in prototypes.

  The variables are the file tokens of type boolean, string, number and
  color (Penpot tokens play the part of Figma variables). This namespace
  holds the pure parts, shared by the editor and the viewer:

  - The layer bindings, kept in the shape plugin-data under `:zvena`
    (see app.common.types.shape.zvena), holding the token name:
      \"var-visible\"  layer visibility <- boolean variable
      \"var-text\"     text content <- string or number variable
    (a color variable drives the fills / strokes through the regular
    color tokens applied to the shape).

  - A small expression language for the Set variable and Conditional
    actions:
      literals    12  3.5  \"text\"  'text'  true  false  #FF0000
      variables   {token.name}
      math        + - * / %   (+ concatenates when a side is a string)
      compare     == != < > <= >=   (= is accepted for ==)
      logic       and or not   (&& || ! are accepted too)
      grouping    ( )

  - The resolution of the token values (references and math) into the
    initial values of the variables.

  Every function is pure; `lookup` is any function (or map) from a
  variable name to its value (nil when unknown)."
  (:require
   [app.common.types.shape.zvena :as ctsz]
   [clojure.string :as str]))

;; --- Variables and bindings

(def variable-types
  "Token types that work as prototype variables."
  #{:boolean :string :number :color})

(def visible-key "var-visible")
(def text-key "var-text")

(def binding-keys
  "zvena plugin-data key of each kind of layer binding."
  {:visible visible-key
   :text    text-key})

(def binding-types
  "Variable types that can be bound to each kind of layer binding."
  {:visible #{:boolean}
   :text    #{:string :number}})

(defn get-binding
  "The variable (token name) bound to the `kind` (:visible, :text) of
  `shape`, nil when none."
  [shape kind]
  (when-let [key (get binding-keys kind)]
    (let [value (ctsz/get-data shape key)]
      (when (and (string? value) (not (str/blank? value)))
        value))))

;; --- Errors

(defn- fail!
  [msg]
  (throw (ex-info msg {:type ::invalid-expression})))

;; --- Values

(defn- parse-num
  [s]
  #?(:clj (Double/parseDouble s)
     :cljs (js/parseFloat s)))

(defn- finite?
  [n]
  (and (number? n)
       #?(:clj (let [d (double n)]
                 (not (or (Double/isNaN d) (Double/isInfinite d))))
          :cljs (js/isFinite n))))

(def ^:private numeric-re
  #"\s*-?(\d+\.?\d*|\.\d+)(px)?\s*")

(defn numeric-string?
  "True for strings that hold a plain number (\"12\", \"-1.5\", \"16px\")."
  [s]
  (and (string? s)
       (some? (re-matches numeric-re s))))

(defn- ->number
  [v]
  (cond
    (number? v)          v
    (numeric-string? v)  (parse-num (str/replace (str/trim v) #"px$" ""))
    :else                (fail! "not a number")))

(defn format-number
  "Number as shown in a text: integers without decimals, others with up
  to four decimals."
  [n]
  (if (finite? n)
    (let [r (/ (double (Math/round (* (double n) 10000.0))) 10000.0)]
      (if (and (== r (Math/floor r))
               (< (Math/abs r) 1e15))
        (str (long r))
        (str r)))
    (str n)))

(defn format-value
  "The text of a variable value."
  [v]
  (cond
    (nil? v)     ""
    (boolean? v) (if v "true" "false")
    (number? v)  (format-number v)
    :else        (str v)))

(defn truthy?
  "The boolean meaning of a value: numbers are true unless 0, strings
  unless empty, \"false\" or \"0\"."
  [v]
  (cond
    (boolean? v) v
    (number? v)  (and (finite? v) (not (zero? v)))
    (string? v)  (let [s (str/lower-case (str/trim v))]
                   (not (or (= s "") (= s "false") (= s "0"))))
    :else        false))

(defn- color-literal?
  [s]
  (and (string? s)
       (some? (re-matches #"#[0-9A-Fa-f]{3,8}" s))))

(defn values-equal?
  [a b]
  (cond
    (and (number? a) (number? b))          (== a b)
    (and (number? a) (numeric-string? b))  (== a (->number b))
    (and (numeric-string? a) (number? b))  (== (->number a) b)
    (and (boolean? a) (string? b))         (= (format-value a) (str/lower-case (str/trim b)))
    (and (string? a) (boolean? b))         (= (str/lower-case (str/trim a)) (format-value b))
    (and (color-literal? a) (color-literal? b))
    (= (str/lower-case a) (str/lower-case b))
    :else                                  (= a b)))

(defn- compare-values
  [a b]
  (cond
    (and (or (number? a) (numeric-string? a))
         (or (number? b) (numeric-string? b)))
    (compare (double (->number a)) (double (->number b)))

    (and (string? a) (string? b))
    (compare a b)

    :else
    (fail! "values can not be compared")))

(defn coerce
  "`value` as the value of a variable of `type`, nil when it can not be."
  [value type]
  (case type
    :boolean (cond
               (boolean? value) value
               (string? value)  (case (str/lower-case (str/trim value))
                                  "true"  true
                                  "false" false
                                  nil)
               :else nil)
    :number  (cond
               (finite? value)          value
               (numeric-string? value)  (->number value)
               :else nil)
    :string  (when (some? value)
               (format-value value))
    :color   (when (string? value)
               (let [v (str/trim value)]
                 (when-not (= v "") v)))
    nil))

;; --- Tokenizer

(defn- char-at
  [s i]
  (when (< i (count s))
    (subs s i (inc i))))

(defn- matches?
  [re c]
  (and (some? c) (some? (re-matches re c))))

(defn- digit? [c] (matches? #"[0-9]" c))
(defn- space? [c] (matches? #"\s" c))
(defn- word-start? [c] (matches? #"[A-Za-z_]" c))
(defn- word-char? [c] (matches? #"[A-Za-z0-9_]" c))
(defn- hex-char? [c] (matches? #"[0-9A-Fa-f]" c))

(def ^:private two-char-ops #{"==" "!=" "<=" ">=" "&&" "||"})
(def ^:private one-char-ops #{"+" "-" "*" "/" "%" "<" ">" "!" "(" ")" "="})

(defn- read-number
  "[token end] of the number starting at `i`."
  [s i]
  (let [end (loop [j i dot? false]
              (let [c (char-at s j)]
                (cond
                  (digit? c) (recur (inc j) dot?)
                  (and (= c ".") (not dot?) (digit? (char-at s (inc j)))) (recur (inc j) true)
                  :else j)))]
    (when (word-start? (char-at s end))
      (fail! "invalid number"))
    [[:num (parse-num (subs s i end))] end]))

(defn- read-string-literal
  "[token end] of the string quoted by the character at `i`."
  [s i]
  (let [delim (char-at s i)]
    (loop [j   (inc i)
           acc []]
      (let [c (char-at s j)]
        (cond
          (nil? c)
          (fail! "unterminated string")

          (= c delim)
          [[:str (apply str acc)] (inc j)]

          (= c "\\")
          (let [escaped (char-at s (inc j))]
            (when (nil? escaped)
              (fail! "unterminated string"))
            (recur (+ j 2) (conj acc (case escaped "n" "\n" "t" "\t" escaped))))

          :else
          (recur (inc j) (conj acc c)))))))

(defn- read-variable
  "[token end] of the {variable} starting at `i`."
  [s i]
  (let [end (str/index-of s "}" i)]
    (when (nil? end)
      (fail! "unterminated variable"))
    (let [name (str/trim (subs s (inc i) end))]
      (when (or (= "" name) (str/includes? name "{"))
        (fail! "invalid variable"))
      [[:var name] (inc end)])))

(defn- read-color
  "[token end] of the #hex color starting at `i`."
  [s i]
  (let [end (loop [j (inc i)]
              (if (hex-char? (char-at s j)) (recur (inc j)) j))]
    (when (or (not (contains? #{3 4 6 8} (- end i 1)))
              (word-char? (char-at s end)))
      (fail! "invalid color"))
    [[:color (subs s i end)] end]))

(defn- read-word
  [s i]
  (let [end (loop [j i]
              (if (word-char? (char-at s j)) (recur (inc j)) j))]
    [[:word (str/lower-case (subs s i end))] end]))

(defn tokenize
  "Tokens of the expression `s`: [:num n] [:str s] [:color s] [:var name]
  [:word w] [:op o]. Throws when `s` has invalid characters."
  [s]
  (let [n (count s)]
    (loop [i   0
           out []]
      (if (>= i n)
        out
        (let [c (char-at s i)]
          (cond
            (space? c)
            (recur (inc i) out)

            (or (digit? c)
                (and (= c ".") (digit? (char-at s (inc i)))))
            (let [[token end] (read-number s i)]
              (recur end (conj out token)))

            (or (= c "\"") (= c "'"))
            (let [[token end] (read-string-literal s i)]
              (recur end (conj out token)))

            (= c "{")
            (let [[token end] (read-variable s i)]
              (recur end (conj out token)))

            (= c "#")
            (let [[token end] (read-color s i)]
              (recur end (conj out token)))

            (word-start? c)
            (let [[token end] (read-word s i)]
              (recur end (conj out token)))

            :else
            (let [c2 (when (< (inc i) n) (subs s i (+ i 2)))]
              (cond
                (contains? two-char-ops c2) (recur (+ i 2) (conj out [:op c2]))
                (contains? one-char-ops c)  (recur (inc i) (conj out [:op c]))
                :else                       (fail! "unexpected character")))))))))

;; --- Parser

(defn- op?
  [token op]
  (and (= :op (first token)) (= op (second token))))

(defn- word?
  [token word]
  (and (= :word (first token)) (= word (second token))))

(def ^:private compare-ops
  {"==" :eq "=" :eq "!=" :neq "<" :lt ">" :gt "<=" :lte ">=" :gte})

(defn parse
  "AST of the expression `s`. Nodes: [:lit v] [:var name] [:not a]
  [:neg a] and [op a b] with op one of :add :sub :mul :div :mod (+ - *
  / %), :eq :neq :lt :gt :lte :gte (== != < > <= >=), :and :or. Throws
  ex-info when `s` is not a valid expression."
  [s]
  (let [tokens (tokenize s)
        pos    (volatile! 0)]
    (letfn [(peek-token []
              (get tokens @pos))

            (next-token! []
              (let [token (get tokens @pos)]
                (vswap! pos inc)
                token))

            (parse-or []
              (loop [left (parse-and)]
                (let [token (peek-token)]
                  (if (or (word? token "or") (op? token "||"))
                    (do (next-token!)
                        (recur [:or left (parse-and)]))
                    left))))

            (parse-and []
              (loop [left (parse-not)]
                (let [token (peek-token)]
                  (if (or (word? token "and") (op? token "&&"))
                    (do (next-token!)
                        (recur [:and left (parse-not)]))
                    left))))

            ;; `not a == b` is `not (a == b)`
            (parse-not []
              (let [token (peek-token)]
                (if (or (word? token "not") (op? token "!"))
                  (do (next-token!)
                      [:not (parse-not)])
                  (parse-compare))))

            (parse-compare []
              (let [left  (parse-add)
                    token (peek-token)
                    op    (when (= :op (first token))
                            (get compare-ops (second token)))]
                (if (some? op)
                  (do (next-token!)
                      [op left (parse-add)])
                  left)))

            (parse-add []
              (loop [left (parse-mul)]
                (let [token (peek-token)]
                  (cond
                    (op? token "+") (do (next-token!) (recur [:add left (parse-mul)]))
                    (op? token "-") (do (next-token!) (recur [:sub left (parse-mul)]))
                    :else left))))

            (parse-mul []
              (loop [left (parse-unary)]
                (let [token (peek-token)]
                  (cond
                    (op? token "*") (do (next-token!) (recur [:mul left (parse-unary)]))
                    (op? token "/") (do (next-token!) (recur [:div left (parse-unary)]))
                    (op? token "%") (do (next-token!) (recur [:mod left (parse-unary)]))
                    :else left))))

            (parse-unary []
              (let [token (peek-token)]
                (cond
                  (op? token "-")
                  (do (next-token!) [:neg (parse-unary)])

                  (op? token "+")
                  (do (next-token!) (parse-unary))

                  (or (word? token "not") (op? token "!"))
                  (do (next-token!) [:not (parse-unary)])

                  :else
                  (parse-primary))))

            (parse-primary []
              (let [[kind value] (next-token!)]
                (case kind
                  :num   [:lit value]
                  :str   [:lit value]
                  :color [:lit value]
                  :var   [:var value]
                  :word  (case value
                           "true"  [:lit true]
                           "false" [:lit false]
                           (fail! (str "unknown word " value)))
                  :op    (if (= value "(")
                           (let [inner (parse-or)]
                             (if (op? (next-token!) ")")
                               inner
                               (fail! "missing )")))
                           (fail! (str "unexpected " value)))
                  (fail! "unexpected end"))))]

      (let [ast (parse-or)]
        (when (< @pos (count tokens))
          (fail! "unexpected token"))
        ast))))

(defn parse*
  "The AST of `s`, nil when it is not a valid expression."
  [s]
  (when (string? s)
    (try
      (parse s)
      (catch #?(:clj Exception :cljs :default) _
        nil))))

;; --- Evaluation

(defn evaluate
  "The value of `ast` (see `parse`) with the variables of `lookup`.
  Throws ex-info when it can not be computed (unknown variable, a
  division by zero, a number expected...)."
  [ast lookup]
  (let [[kind a b] ast]
    (case kind
      :lit a
      :var (let [v (lookup a)]
             (if (nil? v)
               (fail! (str "unknown variable " a))
               v))
      :not (not (truthy? (evaluate a lookup)))
      :neg (- (->number (evaluate a lookup)))
      :and (and (truthy? (evaluate a lookup))
                (truthy? (evaluate b lookup)))
      :or  (or (truthy? (evaluate a lookup))
               (truthy? (evaluate b lookup)))

      :add (let [x (evaluate a lookup)
                 y (evaluate b lookup)]
             (cond
               (and (number? x) (number? y)) (+ x y)
               (or (string? x) (string? y))  (str (format-value x) (format-value y))
               :else                         (+ (->number x) (->number y))))
      :sub (- (->number (evaluate a lookup)) (->number (evaluate b lookup)))
      :mul (* (->number (evaluate a lookup)) (->number (evaluate b lookup)))
      :div (let [x (->number (evaluate a lookup))
                 y (->number (evaluate b lookup))]
             (if (zero? y)
               (fail! "division by zero")
               (/ (double x) y)))
      :mod (let [x (->number (evaluate a lookup))
                 y (->number (evaluate b lookup))]
             (if (zero? y)
               (fail! "division by zero")
               (rem (double x) y)))

      :eq  (values-equal? (evaluate a lookup) (evaluate b lookup))
      :neq (not (values-equal? (evaluate a lookup) (evaluate b lookup)))
      :lt  (neg? (compare-values (evaluate a lookup) (evaluate b lookup)))
      :gt  (pos? (compare-values (evaluate a lookup) (evaluate b lookup)))
      :lte (not (pos? (compare-values (evaluate a lookup) (evaluate b lookup))))
      :gte (not (neg? (compare-values (evaluate a lookup) (evaluate b lookup))))

      (fail! "invalid expression"))))

(defn eval-ast
  "The value of `ast`, ::error when it can not be computed."
  [ast lookup]
  (try
    (evaluate ast lookup)
    (catch #?(:clj Exception :cljs :default) _
      ::error)))

(defn references
  "Names of the {variables} used in the expression `s`."
  [s]
  (if (string? s)
    (into #{}
          (map (comp str/trim second))
          (re-seq #"\{([^{}]+)\}" s))
    #{}))

(defn interpolate
  "`s` with its {name} references replaced by the value of the variable
  (unknown ones are kept as they are)."
  [s lookup]
  (str/replace s #"\{([^{}]+)\}"
               (fn [[match name]]
                 (let [v (lookup (str/trim name))]
                   (if (nil? v)
                     match
                     (format-value v))))))

(defn eval-for-type
  "The value the expression `expr` gives to a variable of `type`
  (:boolean, :number, :string or :color), nil when it can not be
  computed. For strings and colors a text that is not an expression is
  taken as it is, with its {name} references replaced (Hello {name})
  and a single literal keeps its spelling (\"3.10\")."
  [expr type lookup]
  (when (string? expr)
    (let [text      (str/trim expr)
          ast       (parse* text)
          textual?  (contains? #{:string :color} type)]
      (cond
        (and (some? ast)
             textual?
             (= :lit (first ast))
             (not (string? (second ast))))
        (coerce text type)

        (some? ast)
        (let [v (eval-ast ast lookup)]
          (when-not (= v ::error)
            (coerce v type)))

        textual?
        (coerce (interpolate expr lookup) type)

        :else
        nil))))

(defn eval-condition
  "True when the condition `expr` holds; false when it is empty, not
  valid or can not be computed."
  [expr lookup]
  (let [ast (parse* expr)]
    (if (nil? ast)
      false
      (let [v (eval-ast ast lookup)]
        (and (not= v ::error)
             (truthy? v))))))

(defn expression-error
  "Why `expr` can not give a value of `type` (nil type: a condition) with
  the variables of `lookup`: :unknown-variable, :invalid or nil when it
  is fine. Blank expressions are fine."
  [expr type lookup]
  (when (and (string? expr) (not (str/blank? expr)))
    (cond
      (some #(nil? (lookup %)) (references expr))
      :unknown-variable

      (nil? type)
      (let [ast (parse* expr)]
        (when (or (nil? ast) (= ::error (eval-ast ast lookup)))
          :invalid))

      (nil? (eval-for-type expr type lookup))
      :invalid

      :else
      nil)))

;; --- Token values

(defn- token-value
  "The value of `token` ({:type :value}), its references read with
  `lookup`."
  [token lookup]
  (let [raw  (:value token)
        type (:type token)]
    (cond
      (or (boolean? raw) (number? raw)) raw
      (not (string? raw))               nil
      (= type :string)                  (interpolate raw lookup)
      (= type :color)                   (coerce (interpolate raw lookup) :color)
      (= type :boolean)                 (eval-for-type raw :boolean lookup)
      (= type :number)                  (eval-for-type raw :number lookup)
      ;; other tokens referenced by a variable (dimensions, spacing...)
      :else                             (let [v (eval-for-type raw :number lookup)]
                                          (if (some? v) v (interpolate raw lookup))))))

(defn resolve-token-values
  "{name value} of the variables (boolean, string, number and color
  tokens) of `tokens` ({name token}), with their references to other
  tokens and their math resolved. Tokens that can not be resolved are
  left out."
  [tokens]
  (let [cache (volatile! {})]
    (letfn [(lookup [name]
              (let [cached (get @cache name ::none)]
                (if (not= cached ::none)
                  cached
                  (let [token (get tokens name)]
                    ;; a reference cycle resolves to nil
                    (vswap! cache assoc name nil)
                    (let [value (when (some? token)
                                  (try
                                    (token-value token lookup)
                                    (catch #?(:clj Exception :cljs :default) _
                                      nil)))]
                      (vswap! cache assoc name value)
                      value)))))]
      (reduce (fn [acc [name token]]
                (if (contains? variable-types (:type token))
                  (let [value (coerce (lookup name) (:type token))]
                    (cond-> acc
                      (some? value) (assoc name value)))
                  acc))
              {}
              tokens))))
