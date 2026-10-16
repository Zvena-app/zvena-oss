;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns common-tests.types.shape-zvena-vars-test
  "zvena: Figma variables in prototypes (expressions, token values and
  the Set variable / Conditional interactions)."
  (:require
   [app.common.schema :as sm]
   [app.common.types.shape.interactions :as ctsi]
   [app.common.types.shape.zvena-vars :as ctsv]
   [app.common.uuid :as uuid]
   [clojure.test :as t]))

(def ^:private values
  {"count" 3
   "price" 2.5
   "name"  "Ann"
   "flag"  true
   "brand" "#FF0000"})

(t/deftest tokenize
  (t/is (= [[:var "count"] [:op "+"] [:num 1.0]]
           (update-in (ctsv/tokenize "{count} + 1") [2 1] double)))
  (t/is (= [[:str "a b"] [:op "=="] [:str "c"]]
           (ctsv/tokenize "\"a b\" == 'c'")))
  (t/is (= [[:word "not"] [:color "#fff"]]
           (ctsv/tokenize "NOT #fff")))
  (t/is (thrown? #?(:clj Exception :cljs :default) (ctsv/tokenize "1 @ 2")))
  (t/is (thrown? #?(:clj Exception :cljs :default) (ctsv/tokenize "{count")))
  (t/is (thrown? #?(:clj Exception :cljs :default) (ctsv/tokenize "\"open"))))

(t/deftest parse
  (t/is (= [:add [:var "a"] [:mul [:var "b"] [:var "c"]]]
           (ctsv/parse "{a} + {b} * {c}")))
  (t/is (= [:not [:eq [:var "a"] [:var "b"]]]
           (ctsv/parse "not {a} == {b}")))
  (t/is (= [:or [:and [:var "a"] [:var "b"]] [:var "c"]]
           (ctsv/parse "{a} and {b} or {c}")))
  (t/is (nil? (ctsv/parse* "1 +")))
  (t/is (nil? (ctsv/parse* "(1")))
  (t/is (nil? (ctsv/parse* "hello")))
  (t/is (nil? (ctsv/parse* ""))))

(t/deftest numbers
  (t/is (== 4 (ctsv/eval-for-type "{count} + 1" :number values)))
  (t/is (== 8 (ctsv/eval-for-type "({count} + 1) * 2" :number values)))
  (t/is (== 2.5 (ctsv/eval-for-type "10 / 4" :number values)))
  (t/is (== 3 (ctsv/eval-for-type "7 % 4" :number values)))
  (t/is (== -3 (ctsv/eval-for-type "-{count}" :number values)))
  (t/is (== 5 (ctsv/eval-for-type "{price} * 2" :number values)))
  (t/is (nil? (ctsv/eval-for-type "10 / 0" :number values)))
  (t/is (nil? (ctsv/eval-for-type "{name} * 2" :number values)))
  (t/is (nil? (ctsv/eval-for-type "{missing} + 1" :number values)))
  (t/is (nil? (ctsv/eval-for-type "" :number values))))

(t/deftest strings
  (t/is (= "Hi Ann" (ctsv/eval-for-type "\"Hi \" + {name}" :string values)))
  (t/is (= "Hello Ann!" (ctsv/eval-for-type "Hello {name}!" :string values)))
  (t/is (= "Hello world" (ctsv/eval-for-type "Hello world" :string values)))
  (t/is (= "3.10" (ctsv/eval-for-type "3.10" :string values)))
  (t/is (= "3" (ctsv/eval-for-type "{count}" :string values)))
  (t/is (= "Count: 4" (ctsv/eval-for-type "\"Count: \" + ({count} + 1)" :string values)))
  (t/is (= "" (ctsv/eval-for-type "" :string values))))

(t/deftest boolean-expressions
  (t/is (false? (ctsv/eval-for-type "not {flag}" :boolean values)))
  (t/is (true? (ctsv/eval-for-type "{count} > 2" :boolean values)))
  (t/is (true? (ctsv/eval-for-type "{count} >= 3 and {name} == \"Ann\"" :boolean values)))
  (t/is (true? (ctsv/eval-for-type "!{flag} || {count} = 3" :boolean values)))
  (t/is (false? (ctsv/eval-for-type "{count} != 3" :boolean values)))
  (t/is (true? (ctsv/eval-for-type "true" :boolean values)))
  (t/is (false? (ctsv/eval-for-type "FALSE" :boolean values)))
  (t/is (nil? (ctsv/eval-for-type "maybe" :boolean values))))

(t/deftest colors
  (t/is (= "#00FF00" (ctsv/eval-for-type "#00FF00" :color values)))
  (t/is (= "#FF0000" (ctsv/eval-for-type "{brand}" :color values)))
  (t/is (= "red" (ctsv/eval-for-type "red" :color values)))
  (t/is (true? (ctsv/eval-condition "{brand} == #ff0000" values))))

(t/deftest conditions
  (t/is (true? (ctsv/eval-condition "{count} == 3" values)))
  (t/is (false? (ctsv/eval-condition "{count} < 3" values)))
  (t/is (true? (ctsv/eval-condition "{flag}" values)))
  (t/is (false? (ctsv/eval-condition "" values)))
  (t/is (false? (ctsv/eval-condition nil values)))
  (t/is (false? (ctsv/eval-condition "{missing} > 1" values)))
  (t/is (false? (ctsv/eval-condition "1 +" values))))

(t/deftest expression-errors
  (t/is (nil? (ctsv/expression-error "{count} + 1" :number values)))
  (t/is (nil? (ctsv/expression-error "" :number values)))
  (t/is (= :unknown-variable (ctsv/expression-error "{missing} + 1" :number values)))
  (t/is (= :invalid (ctsv/expression-error "1 +" :number values)))
  (t/is (= :invalid (ctsv/expression-error "1 +" nil values)))
  (t/is (nil? (ctsv/expression-error "Hello" :string values))))

(t/deftest helpers
  (t/is (= #{"a" "b.c"} (ctsv/references "{a} + { b.c }")))
  (t/is (= "3" (ctsv/format-value 3.0)))
  (t/is (= "2.5" (ctsv/format-value 2.5)))
  (t/is (= "true" (ctsv/format-value true)))
  (t/is (= "Hi Ann {x}" (ctsv/interpolate "Hi {name} {x}" values)))
  (t/is (= "count" (ctsv/get-binding {:plugin-data {:zvena {"var-text" "count"}}} :text)))
  (t/is (nil? (ctsv/get-binding {:plugin-data {:zvena {"var-text" ""}}} :text))))

(t/deftest resolve-token-values
  (let [tokens {"a"     {:name "a" :type :number :value "2"}
                "b"     {:name "b" :type :number :value "{a} * 3"}
                "name"  {:name "name" :type :string :value "Bob"}
                "s"     {:name "s" :type :string :value "Hi {name}"}
                "f"     {:name "f" :type :boolean :value "false"}
                "brand" {:name "brand" :type :color :value "#abc"}
                "c"     {:name "c" :type :color :value "{brand}"}
                "cyc1"  {:name "cyc1" :type :number :value "{cyc2}"}
                "cyc2"  {:name "cyc2" :type :number :value "{cyc1}"}
                "dim"   {:name "dim" :type :dimensions :value "16px"}
                "x"     {:name "x" :type :number :value "{dim} / 2"}}
        result (ctsv/resolve-token-values tokens)]
    (t/is (== 2 (get result "a")))
    (t/is (== 6 (get result "b")))
    (t/is (= "Hi Bob" (get result "s")))
    (t/is (false? (get result "f")))
    (t/is (= "#abc" (get result "c")))
    (t/is (== 8 (get result "x")))
    (t/is (not (contains? result "cyc1")))
    (t/is (not (contains? result "cyc2")))
    (t/is (not (contains? result "dim")))))

(t/deftest set-variable-interaction
  (let [interaction (-> ctsi/default-interaction
                        (ctsi/set-action-type :set-variable)
                        (ctsi/set-variable "count")
                        (ctsi/set-value-expr "{count} + 1"))]
    (t/is (some? (ctsi/check-interaction interaction)))
    (t/is (nil? (:destination interaction)))
    (t/is (= "count" (:variable interaction)))
    (t/is (not (ctsi/has-destination interaction)))
    (t/is (not (ctsi/has-animation? interaction)))))

(t/deftest conditional-interaction
  (let [dest-a      (uuid/next)
        dest-b      (uuid/next)
        interaction (-> ctsi/default-interaction
                        (ctsi/set-action-type :conditional)
                        (ctsi/set-condition "{count} > 1"))
        nested      (-> (ctsi/branch-action interaction nil)
                        (ctsi/set-destination dest-a))
        interaction (-> interaction
                        (ctsi/add-branch-action :then-actions nested)
                        (ctsi/add-else))]

    (t/is (some? (ctsi/check-interaction interaction)))
    (t/is (= [] (:else-actions interaction)))
    (t/is (= :click (get-in interaction [:then-actions 0 :event-type])))

    (t/testing "the actions of a branch are remapped as the interactions"
      (let [remapped (first (ctsi/remap-interactions [interaction] {dest-a dest-b} {}))]
        (t/is (= dest-b (get-in remapped [:then-actions 0 :destination])))))

    (t/testing "branch actions are updated and removed"
      (let [updated (ctsi/update-branch-action interaction :then-actions 0
                                               #(ctsi/set-action-type % :prev-screen))]
        (t/is (= :prev-screen (get-in updated [:then-actions 0 :action-type])))
        (t/is (some? (ctsi/check-interaction updated))))
      (t/is (empty? (:then-actions (ctsi/remove-branch-action interaction :then-actions 0))))
      (t/is (not (contains? (ctsi/remove-else interaction) :else-actions))))

    (t/testing "nested conditionals validate"
      (let [inner (-> (ctsi/branch-action interaction nil)
                      (ctsi/set-action-type :conditional)
                      (ctsi/set-condition "{flag}"))
            outer (ctsi/add-branch-action interaction :else-actions inner)]
        (t/is (some? (ctsi/check-interaction outer)))))

    (t/testing "json roundtrip keeps the nested actions"
      (let [encode (sm/encoder ctsi/schema:interaction (sm/json-transformer))
            decode (sm/decoder ctsi/schema:interaction (sm/json-transformer))]
        (t/is (= interaction (decode (encode interaction))))))

    (t/testing "an invalid nested action does not validate"
      (let [broken (assoc-in interaction [:then-actions 0 :action-type] :unknown)]
        (t/is (thrown? #?(:clj Exception :cljs :default)
                       (ctsi/check-interaction broken)))))))
