;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.data.workspace.tokens.zvena-variables
  "zvena: Figma's variables (the Local variables dialog) on top of
  Penpot's design tokens. The tokens data model is not changed, this
  namespace only maps it:

  - a collection is a theme group; its modes are the group's themes. The
    themes without a group form a collection too (group \"\").
  - an implicit collection (id `implicit-id`, one mode) holds the tokens
    of the sets no theme uses: the whole library when the file has no
    themes. Its mode reads the active ones of those sets (all of them
    when none is active).
  - a variable is a token name; its value in a mode is the token the
    mode's enabled sets give it (the last set holding it wins, as in
    Penpot's resolution).

  Editing a value writes the token in the set that gives it in that
  mode. When that set is shared with another mode of the collection (or
  no set of the mode has the token) the value goes to a set only this
  mode uses, created as \"<Collection>/<Mode>\" when there is none. The
  sets this dialog creates follow that naming convention, which is what
  marks them as dedicated: deleting a mode or a collection deletes its
  dedicated sets, never a set another theme also uses.

  The model is pure: the plan-* functions return ops (see `apply-ops`),
  the events turn them into one commit (undoable) and re-propagate the
  tokens when values in effect may have changed."
  (:require
   [app.common.data :as d]
   [app.common.files.changes :as cfc]
   [app.common.files.changes-builder :as pcb]
   [app.common.types.token :as cto]
   [app.common.types.tokens-lib :as ctob]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.tinycolor :as tinycolor]
   [app.main.data.workspace.tokens.propagation :as dwtp]
   [app.main.data.workspace.tokens.remapping :as dwtr]
   [app.main.data.workspace.tokens.zvena-modes :as zvm]
   [beicon.v2.core :as rx]
   [clojure.datafy :refer [datafy]]
   [clojure.string :as cstr]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

;; --- Constants

(def implicit-id
  "Id of the implicit collection and of its only mode."
  :implicit)

(def default-implicit-collection-name "Tokens")
(def default-implicit-mode-name "Default")

(def default-set-name
  "The set created for the first token of a file without sets (the name
  Penpot itself gives it)."
  "Global")

(def variable-types
  "The types the Create variable menu offers (Figma's)."
  [:color :number :string :boolean])

(def default-values
  {:color   "#FFFFFF"
   :number  "0"
   :string  ""
   :boolean "false"})

(def ^:private numeric-types
  #{:number :dimensions :spacing :sizing :border-radius :opacity :rotation
    :font-size :stroke-width :letter-spacing :font-weight})

(def ^:private max-alias-depth 16)

;; --- Small helpers

(defn- lib*
  [lib]
  (ctob/ensure-tokens-lib lib))

(defn- set-names
  "The names of all the sets of `lib`, in the library order (the later
  ones win when several active sets hold a token)."
  [lib]
  (vec (ctob/get-set-names lib)))

(defn- set-tokens
  "The tokens (name -> token) of the set `set-name`."
  [lib set-name]
  (or (some-> (ctob/get-set-by-name lib set-name) (ctob/get-tokens-))
      {}))

(defn- user-themes
  "The themes of the user (not the hidden one), in the library order."
  [lib]
  (into [] (remove ctob/hidden-theme?) (ctob/get-themes lib)))

(defn- index-in
  [coll v]
  (or (d/index-of coll v) -1))

(defn unique-name
  "`base` or, when taken, `base<sep>2`, `base<sep>3`..."
  [base taken sep]
  (let [taken (set taken)]
    (if-not (contains? taken base)
      base
      (loop [n 2]
        (let [candidate (str base sep n)]
          (if (contains? taken candidate)
            (recur (inc n))
            candidate))))))

(defn next-numbered-name
  "The first `(fmt n)` not in `taken`, n counting from `start`."
  [fmt taken start]
  (let [taken (set taken)]
    (loop [n start]
      (let [candidate (fmt n)]
        (if (contains? taken candidate)
          (recur (inc n))
          candidate)))))

;; --- Names

(defn name-path
  "The segments of a variable (token) name."
  [name]
  (if (str/blank? name)
    []
    (cstr/split name #"\.")))

(defn variable-folder
  "The folder of a variable name (all but the last segment, dot
  separated); nil at the top level."
  [name]
  (let [path (name-path name)]
    (when (> (count path) 1)
      (cstr/join "." (butlast path)))))

(defn variable-leaf
  "The last segment of a variable name."
  [name]
  (or (last (name-path name)) ""))

(defn folder-label
  "A folder path as Figma shows it: `a / b`."
  [folder]
  (cstr/join " / " (name-path folder)))

(defn normalize-variable-name
  "A token name from what the user typed: Figma's `/` folders become
  dots, spaces become `-` and the characters a token name can not have
  are dropped. nil when nothing valid is left."
  [s]
  (let [s (-> (str s)
              (str/trim)
              (cstr/replace #"\s*[/.]\s*" ".")
              (cstr/replace #"\s+" "-")
              (cstr/replace #"[^a-zA-Z0-9$_.\-]" "")
              (cstr/replace #"\.{2,}" ".")
              (cstr/replace #"^[.$]+" "")
              (cstr/replace #"\.+$" ""))]
    (when (and (not (str/blank? s))
               (re-matches cto/token-name-validation-regex s))
      s)))

(defn normalize-label
  "A collection or mode name from what the user typed (a `/` would be
  read as a path separator, it becomes `-`); nil when blank."
  [s]
  (let [s (-> (str s) (cstr/replace "/" "-") (str/trim))]
    (when-not (str/blank? s)
      s)))

(defn name-conflict?
  "Whether the variable name `new-name` clashes with `names` (the same
  name, or one being the folder of the other); `old-name` is ignored."
  [names new-name old-name]
  (boolean
   (some (fn [n]
           (and (not= n old-name)
                (or (= n new-name)
                    (str/starts-with? n (str new-name "."))
                    (str/starts-with? new-name (str n ".")))))
         names)))

;; --- Values

(defn alias-name
  "The variable a value refers to when the value is an alias (exactly
  one reference, `{name}`)."
  [value]
  (when (string? value)
    (when-let [[_ ref] (re-matches #"^\s*\{([^{}]+)\}\s*$" value)]
      (str/trim ref))))

(defn references?
  "Whether a value refers to other variables (alias or expression)."
  [value]
  (boolean (seq (cto/find-token-value-references value))))

(defn resolve-literal
  "The value `value` stands for, following its alias chain in `tokens`
  (name -> token). nil when an alias is broken or the chain too long."
  [tokens value]
  (loop [value value
         n     0]
    (if-let [ref (alias-name value)]
      (when (< n max-alias-depth)
        (when-let [token (get tokens ref)]
          (recur (:value token) (inc n))))
      value)))

(defn boolean-value
  "true / false for a boolean variable value; nil when it is neither."
  [value]
  (cond
    (boolean? value) value
    (string? value)  (case (str/lower (str/trim value))
                       "true"  true
                       "false" false
                       nil)
    :else nil))

(defn color-info
  "{:hex \"FF0000\" :alpha 0.5 :css \"rgba(...)\"} of a color value; nil
  when it is not a color."
  [value]
  (when (string? value)
    (when-let [tc (tinycolor/valid-color value)]
      (let [hex (.toHexString ^js tc)]
        {:hex   (str/upper (subs hex 1))
         :hash  hex
         :alpha (.getAlpha ^js tc)
         :css   (.toRgbString ^js tc)}))))

(defn color-value
  "The value stored for a color picked as `hex` (#rrggbb) and `alpha`."
  [hex alpha]
  (let [alpha (if (number? alpha) alpha 1)]
    (if (>= alpha 1)
      (str/lower hex)
      (let [tc (tinycolor/valid-color hex)]
        (if (some? tc)
          (do (tinycolor/set-alpha tc alpha)
              (.toHex8String ^js tc))
          (str/lower hex))))))

(defn- color-input
  [s]
  (let [s (if (re-matches #"[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3}" s)
            (str "#" s)
            s)]
    (when-let [tc (tinycolor/valid-color s)]
      (if (str/starts-with? s "#")
        (if (< (.getAlpha ^js tc) 1)
          (.toHex8String ^js tc)
          (.toHexString ^js tc))
        s))))

(defn parse-input-value
  "The value stored for what the user typed in a cell of a `type`
  variable; nil when it is not valid (the edit is dropped)."
  [type input]
  (let [raw (str input)
        s   (str/trim raw)]
    (cond
      (= type :string)   raw
      (str/blank? s)     nil
      (alias-name s)     s
      (= type :color)    (color-input s)
      (= type :boolean)  (case (boolean-value s)
                           true  "true"
                           false "false"
                           nil)
      (contains? numeric-types type)
      (when (or (references? s)
                (re-matches #"-?(\d+\.?\d*|\.\d+)([a-zA-Z%]*)" s))
        s)
      :else              s)))

(defn alias-compatible?
  "Whether a variable of `type` can be an alias of one of `other-type`."
  [type other-type]
  (or (= type other-type)
      (and (contains? numeric-types type)
           (contains? numeric-types other-type)
           (or (= type :number) (= other-type :number)))))

(defn value-summary
  "A short text for a value that is not a plain string (typography,
  shadow, font families)."
  [value]
  (cond
    (string? value)     value
    (number? value)     (str value)
    (boolean? value)    (str value)
    (map? value)        (->> value
                             (keep (fn [[k v]]
                                     (when (or (string? v) (number? v))
                                       (str (name k) ": " v))))
                             (take 4)
                             (cstr/join ", "))
    (sequential? value) (if (every? string? value)
                          (cstr/join ", " value)
                          (str (count value) " × " (value-summary (first value))))
    :else               ""))

;; --- Collections and modes

(defn- theme-set-names
  "The sets enabled in `theme`, in the library order."
  [all-names theme]
  (let [enabled (:sets theme)]
    (filterv #(contains? enabled %) all-names)))

(defn- free-set-names
  "The sets no theme of the user enables."
  [all-names themes]
  (let [used (into #{} (mapcat :sets) themes)]
    (filterv #(not (contains? used %)) all-names)))

(defn- implicit-set-names
  [lib all-names themes]
  (let [free   (free-set-names all-names themes)
        active (ctob/get-active-themes-set-names lib)
        on     (filterv #(contains? active %) free)]
    (if (seq on) on free)))

(defn collections
  "The collections of `lib`: the implicit one first (when shown), then
  one per theme group in the library order. Each one is
  {:id :name :group :implicit? :modes [{:id :name :theme :set-names}]}.
  The implicit collection and mode have a nil name (the UI names them)."
  [lib]
  (let [lib       (lib* lib)
        all-names (set-names lib)
        themes    (user-themes lib)
        groups    (into [] (distinct) (map :group themes))
        real      (mapv (fn [group]
                          {:id        group
                           :name      group
                           :group     group
                           :implicit? false
                           :modes     (into []
                                            (comp (filter #(= group (:group %)))
                                                  (map (fn [theme]
                                                         {:id        (:id theme)
                                                          :name      (:name theme)
                                                          :theme     theme
                                                          :set-names (theme-set-names all-names theme)})))
                                            themes)})
                        groups)
        implicit? (or (empty? themes)
                      (some #(seq (set-tokens lib %))
                            (free-set-names all-names themes)))]
    (cond-> []
      implicit?
      (conj {:id        implicit-id
             :name      nil
             :group     nil
             :implicit? true
             :modes     [{:id        implicit-id
                          :name      nil
                          :theme     nil
                          :set-names (implicit-set-names lib all-names themes)}]})
      :always
      (into real))))

(defn find-collection
  [lib coll-id]
  (d/seek #(= coll-id (:id %)) (collections lib)))

(defn find-mode
  [coll mode-id]
  (d/seek #(= mode-id (:id %)) (:modes coll)))

(defn- mode-providers
  "{token-name {:token :set-name}} of the sets `set-names`, the last set
  holding a name winning."
  [lib set-names]
  (reduce (fn [acc set-name]
            (reduce (fn [acc [tname token]]
                      (assoc acc tname {:token token :set-name set-name}))
                    acc
                    (seq (set-tokens lib set-name))))
          {}
          set-names))

(defn- collection-set-names
  "All the sets of the modes of `coll`, in the library order."
  [lib coll]
  (let [used (into #{} (mapcat :set-names) (:modes coll))]
    (filterv #(contains? used %) (set-names lib))))

(defn collection-variables
  "The variables of `coll`, in the order they first appear:
  [{:name :type :description :values {mode-id {:token :set-name}}}]."
  [lib coll]
  (let [lib       (lib* lib)
        modes     (:modes coll)
        providers (into {}
                        (map (fn [mode]
                               [(:id mode) (mode-providers lib (:set-names mode))]))
                        modes)
        names     (into []
                        (comp (mapcat #(keys (set-tokens lib %)))
                              (distinct))
                        (collection-set-names lib coll))]
    (mapv (fn [tname]
            (let [values (into {}
                               (keep (fn [mode]
                                       (when-let [p (get-in providers [(:id mode) tname])]
                                         [(:id mode) p])))
                               modes)
                  token  (some (fn [mode] (get-in values [(:id mode) :token])) modes)]
              {:name        tname
               :type        (:type token)
               :description (or (:description token) "")
               :values      values}))
          names)))

(defn variable-folders
  "The folders of `variables` (every level), in the order they first
  appear."
  [variables]
  (into []
        (comp (mapcat (fn [{:keys [name]}]
                        (let [path (name-path name)]
                          (map (fn [n] (cstr/join "." (take n path)))
                               (range 1 (count path))))))
              (distinct))
        variables))

(defn mode-tokens
  "The tokens in effect in `mode` of `coll` (name -> token): the tokens
  Penpot resolves when that mode is the active one of its collection
  (the other collections keep theirs), with the collection's own values
  on top. Used to resolve the values the dialog shows."
  [lib coll mode]
  (let [lib  (lib* lib)
        base (if (:implicit? coll)
               (ctob/get-tokens-in-active-sets lib)
               (ctob/get-tokens-in-active-sets (zvm/apply-theme-ids lib [(:id mode)])))
        own  (into {}
                   (map (fn [[k v]] [k (:token v)]))
                   (mode-providers lib (:set-names mode)))]
    (merge base own)))

(defn resolve-modes
  "Observable of {mode-id resolved-tokens} for `tokens-by-mode`
  ({mode-id tokens})."
  [tokens-by-mode]
  (if (empty? tokens-by-mode)
    (rx/of {})
    (->> (rx/from (vec tokens-by-mode))
         (rx/mapcat (fn [[mode-id tokens]]
                      (->> (if (seq tokens)
                             (zvm/resolve-tokens tokens)
                             (rx/of {}))
                           (rx/map (fn [resolved] [mode-id resolved]))
                           (rx/catch (fn [_] (rx/of [mode-id {}]))))))
         (rx/reduce conj {}))))

(defn alias-candidates
  "The tokens of `lib` a variable of `type` named `var-name` can be an
  alias of: [{:name :type :value}] sorted by name."
  [lib var-name type]
  (->> (vals (ctob/get-all-tokens-map (lib* lib)))
       (filter #(and (not= var-name (:name %))
                     (alias-compatible? type (:type %))))
       (sort-by :name)
       (vec)))

;; --- Ops
;;
;; An op is one of
;;   [:token set-id token-id token]  (token nil deletes it)
;;   [:set set-id token-set]         (nil deletes it)
;;   [:theme theme-id theme]         (nil deletes it)
;;   [:active theme-paths]
;; They map 1:1 to the changes the tokens library already has, so they
;; are applied (and undone) exactly like the Tokens panel edits.

(defn- op->change
  [[kind a b c]]
  (case kind
    :token  {:type :set-token :set-id a :token-id b :attrs (some-> c datafy)}
    :set    {:type :set-token-set :id a :attrs (some-> b datafy)}
    :theme  {:type :set-token-theme :id a :attrs (some-> b datafy)}
    :active {:type :set-active-token-themes :theme-paths (set a)}))

(defn apply-ops
  "`lib` after the ops (the same code applies the committed changes)."
  [lib ops]
  (if (empty? ops)
    lib
    (:tokens-lib (cfc/process-changes {:tokens-lib lib} (mapv op->change ops) false))))

(defn ops->changes
  "Appends the ops to `changes` (made `with-library-data`)."
  [changes ops]
  (reduce (fn [changes [kind a b c]]
            (case kind
              :token  (pcb/set-token changes a b c)
              :set    (pcb/set-token-set changes a b)
              :theme  (pcb/set-token-theme changes a b)
              :active (pcb/set-active-token-themes changes (set a))))
          changes
          ops))

(defn- run-steps
  "Runs `steps` (fns lib -> ops) in order, each one on the library the
  previous ones left. Returns all the ops, nil if a step returns nil."
  [lib steps]
  (loop [lib   lib
         steps (seq steps)
         acc   []]
    (if-let [step (first steps)]
      (let [ops (step lib)]
        (when (some? ops)
          (recur (apply-ops lib ops) (rest steps) (into acc ops))))
      acc)))

;; --- Where values are written

(defn dedicated-set-name
  "The name of the set this dialog creates for `mode-name` of the
  collection `group`."
  [group mode-name]
  (ctob/normalize-set-name
   (if (str/blank? group)
     mode-name
     (str group "/" mode-name))))

(defn- exclusive-set-names
  "The sets of `mode` that no other mode of `coll` uses."
  [coll mode]
  (let [others (into #{}
                     (comp (remove #(= (:id %) (:id mode)))
                           (mapcat :set-names))
                     (:modes coll))]
    (filterv #(not (contains? others %)) (:set-names mode))))

(defn- dedicated-set
  "The dedicated set of `theme` (see the ns doc): named
  <group>/<name>, enabled in the theme and in no other theme of `lib`
  but those in `ignored-ids`."
  [lib theme ignored-ids]
  (let [set-name (dedicated-set-name (:group theme) (:name theme))
        tset     (ctob/get-set-by-name lib set-name)
        ignored  (conj (set ignored-ids) (:id theme))]
    (when (and (some? tset)
               (contains? (:sets theme) set-name)
               (not-any? (fn [other]
                           (and (not (contains? ignored (:id other)))
                                (contains? (:sets other) set-name)))
                         (ctob/get-themes lib)))
      tset)))

(defn- write-target
  "Where the value of `var-name` in `mode` goes: [:set set-name provider]
  for an existing set, [:new set-name provider] for a set to create and
  enable in the mode. `provider` is {:token :set-name} of the set that
  gives the value now, if any."
  [lib coll mode var-name]
  (let [provider  (get (mode-providers lib (:set-names mode)) var-name)
        p-set     (:set-name provider)
        order     (:set-names mode)
        exclusive (if (:implicit? coll)
                    (:set-names mode)
                    (exclusive-set-names coll mode))
        new-name  (fn []
                    (if (:implicit? coll)
                      (unique-name default-set-name (set-names lib) " ")
                      (unique-name (dedicated-set-name (:group coll) (:name mode))
                                   (set-names lib) " ")))]
    (cond
      (and (some? p-set) (some #(= p-set %) exclusive))
      [:set p-set provider]

      (some? p-set)
      (if-let [after (d/seek #(> (index-in order %) (index-in order p-set)) exclusive)]
        [:set after provider]
        [:new (new-name) provider])

      (seq exclusive)
      [:set (first exclusive) nil]

      :else
      [:new (new-name) nil])))

(defn- put-token-ops
  "Writes `var-name` (`type`, `value`, plus `attrs`) in the existing set
  `set-name`, keeping the token's id and description when it is there."
  [lib set-name var-name type value attrs]
  (let [tset (ctob/get-set-by-name lib set-name)
        prev (some-> tset (ctob/get-token-by-name- var-name))]
    (when (and (some? tset) (or (some? prev) (some? type)))
      (let [token (if (some? prev)
                    (ctob/make-token (merge (datafy prev) {:value value} attrs))
                    (ctob/make-token (merge {:name var-name :type type :value value} attrs)))]
        [[:token (ctob/get-id tset) (:id token) token]]))))

(defn- activate-paths
  "The active theme paths once `theme-id` is activated (as the theme
  selector does). The hidden theme (sets enabled by hand) stays active
  when it has sets, so the tokens already applied keep resolving."
  [lib theme-id]
  (let [hidden       (ctob/get-hidden-theme lib)
        keep-hidden? (and (some? hidden)
                          (seq (:sets hidden))
                          (ctob/theme-active? lib ctob/hidden-theme-id))
        paths        (-> lib
                         (ctob/activate-theme theme-id)
                         (ctob/get-active-theme-paths))]
    (if (or keep-hidden? (= paths #{ctob/hidden-theme-path}))
      paths
      (disj paths ctob/hidden-theme-path))))

(defn- enable-set-ops
  "Enables `set-name` in `mode` (the hidden theme, active when no theme
  of the user is, for the implicit collection)."
  [lib coll mode set-name]
  (if (:implicit? coll)
    (let [hidden (or (ctob/get-hidden-theme lib) (ctob/make-hidden-theme))
          active (set (ctob/get-active-theme-paths lib))
          user?  (some #(not= % ctob/hidden-theme-path) active)]
      (cond-> [[:theme (:id hidden) (ctob/enable-set hidden set-name)]]
        (not user?)
        (conj [:active (conj active ctob/hidden-theme-path)])))
    (when-let [theme (ctob/get-theme lib (:id mode))]
      [[:theme (:id theme) (ctob/enable-set theme set-name)]])))

(defn- create-set-op
  [set-name tokens]
  (let [tset (ctob/make-token-set
              :name set-name
              :tokens (into (d/ordered-map) (map (juxt :name identity)) tokens))]
    [:set (ctob/get-id tset) tset]))

(defn- write-ops
  [lib coll mode var-name type value attrs]
  (let [[kind set-name provider] (write-target lib coll mode var-name)
        p-token (:token provider)]
    (case kind
      :set
      (put-token-ops lib set-name var-name type value attrs)

      :new
      (when (some? (or (:type p-token) type))
        (let [token (ctob/make-token
                     (merge {:name        var-name
                             :type        (or (:type p-token) type)
                             :value       value
                             :description (or (:description p-token) "")}
                            attrs))
              ops   (into [(create-set-op set-name [token])]
                          (enable-set-ops lib coll mode set-name))
              lib'  (apply-ops lib ops)
              order (set-names lib')]
          ;; a new set lands at the end of its folder: if that is not after
          ;; the shared set giving the value, write in that set instead
          (if (and (some? provider)
                   (<= (index-in order set-name) (index-in order (:set-name provider))))
            (put-token-ops lib (:set-name provider) var-name type value attrs)
            ops))))))

;; --- Plans

(defn plan-set-value
  "Ops that give `var-name` (of `type`) the `value` in the mode
  `mode-id` of the collection `coll-id`."
  [lib coll-id mode-id var-name type value]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)
        mode (some-> coll (find-mode mode-id))]
    (when (and (some? coll) (some? mode) (some? value))
      (write-ops lib coll mode var-name type value nil))))

(defn plan-create-variable
  "Ops creating the variable `var-name` of `type` with `value` in every
  mode of the collection."
  [lib coll-id var-name type value]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)]
    (when (and (some? coll)
               (some? (normalize-variable-name var-name))
               (not (name-conflict? (map :name (collection-variables lib coll)) var-name nil)))
      (run-steps lib
                 (map (fn [mode-id]
                        (fn [lib]
                          (plan-set-value lib coll-id mode-id var-name type value)))
                      (map :id (:modes coll)))))))

(defn- holders
  "[[set token] ..] of the sets of `coll` that hold `var-name`."
  [lib coll var-name]
  (into []
        (keep (fn [set-name]
                (let [tset (ctob/get-set-by-name lib set-name)]
                  (when-let [token (some-> tset (ctob/get-token-by-name- var-name))]
                    [tset token]))))
        (collection-set-names lib coll)))

(defn plan-rename-variable
  "Ops renaming `old-name` to `new-name` in every set of the collection."
  [lib coll-id old-name new-name]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)]
    (when (and (some? coll)
               (some? new-name)
               (not= old-name new-name)
               (= new-name (normalize-variable-name new-name))
               (not (name-conflict? (map :name (collection-variables lib coll)) new-name old-name)))
      (let [ops (mapv (fn [[tset token]]
                        [:token (ctob/get-id tset) (:id token) (assoc token :name new-name)])
                      (holders lib coll old-name))]
        (when (seq ops) ops)))))

(defn plan-set-description
  "Ops setting the description of `var-name` in every set of the
  collection."
  [lib coll-id var-name description]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)]
    (when (some? coll)
      (into []
            (keep (fn [[tset token]]
                    (when (not= description (:description token))
                      [:token (ctob/get-id tset) (:id token) (assoc token :description (str description))])))
            (holders lib coll var-name)))))

(defn plan-delete-variables
  "Ops deleting the variables `names` from every set of the collection."
  [lib coll-id names]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)]
    (when (some? coll)
      (into []
            (mapcat (fn [var-name]
                      (map (fn [[tset token]]
                             [:token (ctob/get-id tset) (:id token) nil])
                           (holders lib coll var-name))))
            names))))

(defn plan-duplicate-variables
  "Ops copying the variables `names` (each value in each set) under
  unique `<name>-copy` names."
  [lib coll-id names]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)]
    (when (some? coll)
      (let [taken (map :name (collection-variables lib coll))]
        (first
         (reduce (fn [[ops taken] var-name]
                   (let [new-name (loop [n 1]
                                    (let [c (if (= n 1)
                                              (str var-name "-copy")
                                              (str var-name "-copy-" n))]
                                      (if (name-conflict? taken c nil) (recur (inc n)) c)))]
                     [(into ops
                            (map (fn [[tset token]]
                                   (let [copy (ctob/make-token
                                               (-> (datafy token)
                                                   (dissoc :id :modified-at)
                                                   (assoc :name new-name)))]
                                     [:token (ctob/get-id tset) (:id copy) copy])))
                            (holders lib coll var-name))
                      (conj (vec taken) new-name)]))
                 [[] taken]
                 names))))))

(defn plan-create-collection
  "Ops creating the collection `coll-name` with one mode `mode-name`
  (active) and its dedicated set."
  [lib coll-name mode-name]
  (let [lib       (lib* lib)
        coll-name (normalize-label coll-name)
        mode-name (normalize-label mode-name)]
    (when (and (some? coll-name)
               (some? mode-name)
               (not (some #(= coll-name (:group %)) (user-themes lib))))
      (let [set-name (unique-name (dedicated-set-name coll-name mode-name) (set-names lib) " ")
            tset     (ctob/make-token-set :name set-name)
            theme    (ctob/make-token-theme :group coll-name :name mode-name :sets #{set-name})
            ops      [[:set (ctob/get-id tset) tset]
                      [:theme (:id theme) theme]]]
        (conj ops [:active (activate-paths (apply-ops lib ops) (:id theme))])))))

(defn- materialize-ops
  "Turns the implicit collection into the collection `coll-name` with
  one mode `mode-name` enabling the same sets (moved out of the hidden
  theme), made active: the values in effect do not change."
  [lib coll-name mode-name]
  (let [coll      (find-collection lib implicit-id)
        coll-name (normalize-label coll-name)
        mode-name (normalize-label mode-name)
        sets      (:set-names (first (:modes coll)))]
    (when (and (some? coll)
               (some? coll-name)
               (some? mode-name)
               (not (some #(= coll-name (:group %)) (user-themes lib))))
      (let [new-set (when (empty? sets)
                      (ctob/make-token-set
                       :name (unique-name (dedicated-set-name coll-name mode-name) (set-names lib) " ")))
            sets    (if (some? new-set) [(ctob/get-name new-set)] sets)
            theme   (ctob/make-token-theme :group coll-name :name mode-name :sets (set sets))
            hidden  (ctob/get-hidden-theme lib)
            ops     (cond-> []
                      (some? new-set)
                      (conj [:set (ctob/get-id new-set) new-set])

                      (and (some? hidden) (seq (:sets hidden)))
                      (conj [:theme (:id hidden) (ctob/disable-sets hidden (set sets))])

                      :always
                      (conj [:theme (:id theme) theme]))]
        (conj ops [:active (activate-paths (apply-ops lib ops) (:id theme))])))))

(defn- materialized-collection
  "The collection the implicit one became after `materialize-ops`."
  [lib coll-name]
  (find-collection lib (normalize-label coll-name)))

(defn plan-rename-collection
  "Ops renaming the collection (its theme group) and its dedicated sets.
  The implicit collection becomes a real one (`implicit-mode-name` names
  its mode)."
  [lib coll-id new-name implicit-mode-name]
  (let [lib      (lib* lib)
        coll     (find-collection lib coll-id)
        new-name (normalize-label new-name)]
    (cond
      (or (nil? coll) (nil? new-name))
      nil

      (:implicit? coll)
      (materialize-ops lib new-name (or implicit-mode-name default-implicit-mode-name))

      (or (= new-name (:group coll))
          (some #(= new-name (:group %)) (user-themes lib)))
      nil

      :else
      (let [themes     (mapv :theme (:modes coll))
            theme-ids  (map :id themes)
            active     (ctob/get-active-theme-paths lib)
            theme-ops  (mapv (fn [theme]
                               [:theme (:id theme) (assoc theme :group new-name)])
                             themes)
            taken      (set (set-names lib))
            set-ops    (into []
                             (keep (fn [theme]
                                     (when-let [tset (dedicated-set lib theme theme-ids)]
                                       (let [target (dedicated-set-name new-name (:name theme))]
                                         (when-not (contains? taken target)
                                           [:set (ctob/get-id tset) (ctob/rename tset target)])))))
                             themes)
            active'    (reduce (fn [paths theme]
                                 (let [path (ctob/get-theme-path theme)]
                                   (if (contains? paths path)
                                     (-> paths
                                         (disj path)
                                         (conj (ctob/get-theme-path (assoc theme :group new-name))))
                                     paths)))
                               (set active)
                               themes)]
        (-> theme-ops
            (into set-ops)
            (conj [:active active']))))))

(defn plan-delete-collection
  "Ops deleting the collection's themes and their dedicated sets."
  [lib coll-id]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)]
    (when (and (some? coll) (not (:implicit? coll)))
      (let [themes    (mapv :theme (:modes coll))
            theme-ids (map :id themes)
            sets      (into [] (keep #(dedicated-set lib % theme-ids)) themes)
            paths     (into #{} (map ctob/get-theme-path) themes)
            active    (set (ctob/get-active-theme-paths lib))]
        ;; the active paths are set explicitly so that undo restores them
        (-> []
            (into (map (fn [theme] [:theme (:id theme) nil])) themes)
            (into (map (fn [tset] [:set (ctob/get-id tset) nil])) sets)
            (conj [:active (into #{} (remove paths) active)]))))))

(defn- add-mode-ops
  [lib coll mode-name source-mode-id]
  (let [mode-name (normalize-label mode-name)
        group     (:group coll)
        source    (or (find-mode coll source-mode-id) (first (:modes coll)))]
    (when (and (some? mode-name)
               (not (some #(= mode-name (:name %)) (:modes coll))))
      (let [variables (collection-variables lib coll)
            tokens    (into []
                            (keep (fn [{:keys [values]}]
                                    (when-let [token (or (get-in values [(:id source) :token])
                                                         (some (fn [mode] (get-in values [(:id mode) :token]))
                                                               (:modes coll)))]
                                      (ctob/make-token (-> (datafy token) (dissoc :id :modified-at))))))
                            variables)
            set-name  (unique-name (dedicated-set-name group mode-name) (set-names lib) " ")
            set-op    (create-set-op set-name tokens)
            theme     (ctob/make-token-theme :group group :name mode-name :sets #{set-name})]
        [set-op [:theme (:id theme) theme]]))))

(defn plan-add-mode
  "Ops adding the mode `mode-name` to the collection, with its own set
  seeded with the values of `source-mode-id` (the first mode when nil),
  so every variable has a value in it. Adding a mode to the implicit
  collection makes it a real one first (named `implicit-names`
  {:collection :mode})."
  [lib coll-id mode-name source-mode-id implicit-names]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)]
    (cond
      (nil? coll)
      nil

      (:implicit? coll)
      (let [coll-name (or (:collection implicit-names) default-implicit-collection-name)
            first-ops (materialize-ops lib coll-name (or (:mode implicit-names) default-implicit-mode-name))]
        (when (some? first-ops)
          (let [lib'  (apply-ops lib first-ops)
                coll' (materialized-collection lib' coll-name)
                more  (when (some? coll') (add-mode-ops lib' coll' mode-name nil))]
            (when (some? more)
              (into first-ops more)))))

      :else
      (add-mode-ops lib coll mode-name source-mode-id))))

(defn plan-rename-mode
  "Ops renaming the mode (its theme) and its dedicated set. The implicit
  mode makes the implicit collection a real one."
  [lib coll-id mode-id new-name implicit-names]
  (let [lib      (lib* lib)
        coll     (find-collection lib coll-id)
        mode     (some-> coll (find-mode mode-id))
        new-name (normalize-label new-name)]
    (cond
      (or (nil? mode) (nil? new-name))
      nil

      (:implicit? coll)
      (materialize-ops lib
                       (or (:collection implicit-names) default-implicit-collection-name)
                       new-name)

      (or (= new-name (:name mode))
          (some #(= new-name (:name %)) (:modes coll)))
      nil

      :else
      (let [theme   (:theme mode)
            theme'  (assoc theme :name new-name)
            path    (ctob/get-theme-path theme)
            active  (set (ctob/get-active-theme-paths lib))
            tset    (dedicated-set lib theme nil)
            target  (dedicated-set-name (:group theme) new-name)]
        (cond-> [[:theme (:id theme) theme']]
          (and (some? tset) (nil? (ctob/get-set-by-name lib target)))
          (conj [:set (ctob/get-id tset) (ctob/rename tset target)])

          (contains? active path)
          (conj [:active (-> active (disj path) (conj (ctob/get-theme-path theme')))]))))))

(defn plan-delete-mode
  "Ops deleting the mode (its theme) and its dedicated set. The last
  mode of a collection can not be deleted. When it was the active mode
  the first remaining one becomes active."
  [lib coll-id mode-id]
  (let [lib  (lib* lib)
        coll (find-collection lib coll-id)
        mode (some-> coll (find-mode mode-id))]
    (when (and (some? mode)
               (not (:implicit? coll))
               (> (count (:modes coll)) 1))
      (let [theme   (:theme mode)
            path    (ctob/get-theme-path theme)
            active  (set (ctob/get-active-theme-paths lib))
            tset    (dedicated-set lib theme nil)
            other   (d/seek #(not= (:id %) mode-id) (:modes coll))]
        (cond-> [[:theme (:id theme) nil]]
          (some? tset)
          (conj [:set (ctob/get-id tset) nil])

          (contains? active path)
          (conj [:active (-> active (disj path) (conj (ctob/get-theme-path (:theme other))))]))))))

;; --- Events

(defn- commit-plan
  "The events that commit `ops` (one undo step) and, when values in
  effect may have changed, re-propagate the tokens."
  [it state ops {:keys [propagate? undo-group]}]
  (if (empty? ops)
    (rx/empty)
    (let [data       (dsh/lookup-file-data state)
          changes    (-> (pcb/empty-changes it)
                         (pcb/with-library-data data)
                         (ops->changes ops)
                         (pcb/set-undo-group undo-group))
          propagate? (or propagate?
                         (some #(= :active (first %)) ops))]
      (rx/from (cond-> [(dch/commit-changes changes)]
                 propagate? (conj (dwtp/propagate-workspace-tokens)))))))

(defn- current-lib
  [state]
  (get (dsh/lookup-file-data state) :tokens-lib))

(defn set-variable-value
  [coll-id mode-id var-name type value]
  (ptk/reify ::set-variable-value
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-set-value (current-lib state) coll-id mode-id var-name type value)
                   {:propagate? true}))))

(defn create-variable
  [coll-id var-name type value]
  (ptk/reify ::create-variable
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-create-variable (current-lib state) coll-id var-name type value)
                   nil))))

(defn rename-variable
  "Renames the variable and, as Figma keeps the bindings, the aliases of
  it and the layers using it (in the same undo step)."
  [coll-id old-name new-name]
  (ptk/reify ::rename-variable
    ptk/WatchEvent
    (watch [it state _]
      (let [ops        (plan-rename-variable (current-lib state) coll-id old-name new-name)
            undo-group (uuid/next)]
        (if (seq ops)
          (rx/concat
           (commit-plan it state ops {:undo-group undo-group})
           (rx/of (dwtr/remap-tokens old-name new-name :undo-group undo-group)
                  (dwtp/propagate-workspace-tokens)))
          (rx/empty))))))

(defn set-variable-description
  [coll-id var-name description]
  (ptk/reify ::set-variable-description
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-set-description (current-lib state) coll-id var-name description)
                   nil))))

(defn delete-variables
  [coll-id names]
  (ptk/reify ::delete-variables
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-delete-variables (current-lib state) coll-id names)
                   nil))))

(defn duplicate-variables
  [coll-id names]
  (ptk/reify ::duplicate-variables
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-duplicate-variables (current-lib state) coll-id names)
                   nil))))

(defn create-collection
  [coll-name mode-name]
  (ptk/reify ::create-collection
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-create-collection (current-lib state) coll-name mode-name)
                   nil))))

(defn rename-collection
  [coll-id new-name implicit-mode-name]
  (ptk/reify ::rename-collection
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-rename-collection (current-lib state) coll-id new-name implicit-mode-name)
                   nil))))

(defn delete-collection
  [coll-id]
  (ptk/reify ::delete-collection
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-delete-collection (current-lib state) coll-id)
                   {:propagate? true}))))

(defn add-mode
  [coll-id mode-name source-mode-id implicit-names]
  (ptk/reify ::add-mode
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-add-mode (current-lib state) coll-id mode-name source-mode-id implicit-names)
                   nil))))

(defn rename-mode
  [coll-id mode-id new-name implicit-names]
  (ptk/reify ::rename-mode
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-rename-mode (current-lib state) coll-id mode-id new-name implicit-names)
                   nil))))

(defn delete-mode
  [coll-id mode-id]
  (ptk/reify ::delete-mode
    ptk/WatchEvent
    (watch [it state _]
      (commit-plan it state
                   (plan-delete-mode (current-lib state) coll-id mode-id)
                   nil))))
