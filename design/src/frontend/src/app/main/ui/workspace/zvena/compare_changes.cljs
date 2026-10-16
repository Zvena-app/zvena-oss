;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.compare-changes
  "zvena: Dev Mode's \"Compare changes\" (Figma). A frame as it is now
  next to the same frame in a saved version of the file (autosaves
  included), and the list of what changed: layers added and removed, and
  for the others every changed property (size, position inside the
  frame, fills, strokes, radius, effects, auto layout, text and type).
  The version is only read (get-file-snapshot): nothing is restored."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.math :as mth]
   [app.common.time :as ct]
   [app.common.types.text :as txt]
   [app.common.uuid :as uuid]
   [app.main.data.modal :as modal]
   [app.main.features :as features]
   [app.main.refs :as refs]
   [app.main.render :as render]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

;; --- Property formatting

(defn- fmt-num
  [v]
  (when (number? v)
    (let [r (mth/precision v 2)]
      (if (== r (mth/round r)) (str (long r)) (str r)))))

(defn- fmt-color
  [color opacity]
  (when (string? color)
    (cond-> (str/upper (str/replace color "#" ""))
      (and (number? opacity) (< opacity 1))
      (str " " (fmt-num (* 100 opacity)) "%"))))

(defn- fmt-fill
  [fill]
  (cond
    (some? (:fill-color-gradient fill)) (tr "zvena.compare.gradient")
    (some? (:fill-image fill))          (tr "zvena.compare.image")
    :else (fmt-color (:fill-color fill) (:fill-opacity fill))))

(defn- fmt-fills
  [fills]
  (let [items (keep fmt-fill (into [] fills))]
    (when (seq items) (str/join ", " items))))

(defn- fmt-strokes
  [strokes]
  (let [items (keep (fn [s]
                      (let [c (if (some? (:stroke-color-gradient s))
                                (tr "zvena.compare.gradient")
                                (fmt-color (:stroke-color s) (:stroke-opacity s)))]
                        (when (some? c)
                          (str c " · " (fmt-num (:stroke-width s))
                               (when-let [a (:stroke-alignment s)] (str " · " (d/name a)))))))
                    strokes)]
    (when (seq items) (str/join ", " items))))

(defn- fmt-radius
  [{:keys [r1 r2 r3 r4]}]
  (let [rs [r1 r2 r3 r4]]
    (when (some number? rs)
      (if (apply = rs)
        (fmt-num r1)
        (str/join " " (map #(or (fmt-num %) "0") rs))))))

(defn- fmt-shadows
  [shadows]
  (let [items (keep (fn [s]
                      (when-not (:hidden s)
                        (str (if (= :inner-shadow (:style s))
                               (tr "zvena.compare.inner-shadow")
                               (tr "zvena.compare.drop-shadow"))
                             " " (fmt-num (:offset-x s)) "," (fmt-num (:offset-y s))
                             " " (fmt-num (:blur s))
                             " " (fmt-color (dm/get-in s [:color :color])
                                            (dm/get-in s [:color :opacity])))))
                    shadows)]
    (when (seq items) (str/join ", " items))))

(defn- fmt-padding
  [{:keys [p1 p2 p3 p4]}]
  (when (some number? [p1 p2 p3 p4])
    (str/join " " (map #(or (fmt-num %) "0") [p1 p2 p3 p4]))))

(defn- first-text-style
  [shape]
  (when (= :text (:type shape))
    (d/seek :text (txt/node-seq (:content shape)))))

(defn- props
  "The comparable properties of `shape`, positions relative to `root`."
  [shape root]
  (let [style (first-text-style shape)]
    [[:name     (tr "zvena.compare.name") (:name shape)]
     [:x        "X" (fmt-num (- (:x shape) (:x root)))]
     [:y        "Y" (fmt-num (- (:y shape) (:y root)))]
     [:width    (tr "zvena.compare.width") (fmt-num (:width shape))]
     [:height   (tr "zvena.compare.height") (fmt-num (:height shape))]
     [:rotation (tr "zvena.compare.rotation") (fmt-num (or (:rotation shape) 0))]
     [:opacity  (tr "zvena.compare.opacity") (fmt-num (* 100 (or (:opacity shape) 1)))]
     [:hidden   (tr "zvena.compare.visible") (if (:hidden shape) (tr "zvena.compare.no") (tr "zvena.compare.yes"))]
     [:fills    (tr "zvena.compare.fill") (fmt-fills (:fills shape))]
     [:strokes  (tr "zvena.compare.stroke") (fmt-strokes (:strokes shape))]
     [:radius   (tr "zvena.compare.radius") (fmt-radius shape)]
     [:shadow   (tr "zvena.compare.effects") (fmt-shadows (:shadow shape))]
     [:blur     (tr "zvena.compare.blur") (when-let [b (:blur shape)]
                                             (when-not (:hidden b) (fmt-num (:value b))))]
     [:layout   (tr "zvena.compare.auto-layout")
      (when-let [l (:layout shape)]
        (str (d/name l)
             (when-let [dir (:layout-flex-dir shape)] (str " · " (d/name dir)))))]
     [:gap      (tr "zvena.compare.gap")
      (when (:layout shape)
        (let [{:keys [row-gap column-gap]} (:layout-gap shape)]
          (str (or (fmt-num column-gap) "0") " " (or (fmt-num row-gap) "0"))))]
     [:padding  (tr "zvena.compare.padding") (when (:layout shape) (fmt-padding (:layout-padding shape)))]
     [:text     (tr "zvena.compare.text") (when (= :text (:type shape))
                                             (txt/content->text (:content shape)))]
     [:font     (tr "zvena.compare.font")
      (when (some? style)
        (str/join " · " (remove str/blank? [(:font-family style) (str (:font-weight style))
                                             (:font-size style)
                                             (some-> (:line-height style) str)])))]
     [:text-color (tr "zvena.compare.text-color")
      (when (some? style) (fmt-fills (:fills style)))]]))

(defn- shape-changes
  [before now root-before root-now]
  (let [pb (props before root-before)
        pn (props now root-now)]
    (into []
          (keep (fn [[[k label vb] [_ _ vn]]]
                  (when (not= vb vn)
                    {:prop k :label label :before vb :after vn})))
          (map vector pb pn))))

(defn compare-frame
  "Rows describing how the frame `frame-id` changed from `before` to
  `now` (both page objects maps): {:kind :added|:removed|:changed}."
  [before now frame-id]
  (let [root-b  (get before frame-id)
        root-n  (get now frame-id)
        ids-b   (if (some? root-b) (cfh/get-children-ids-with-self before frame-id) [])
        ids-n   (if (some? root-n) (cfh/get-children-ids-with-self now frame-id) [])
        set-b   (set ids-b)
        ;; layers in the order they have now, then the removed ones
        ids     (concat ids-n (remove (set ids-n) ids-b))]
    (into []
          (keep (fn [id]
                  (let [b (when (contains? set-b id) (get before id))
                        n (get now id)
                        n (when (some (partial = id) ids-n) n)]
                    (cond
                      (and (nil? b) (some? n))
                      {:id id :kind :added :name (:name n) :type (:type n)}

                      (and (some? b) (nil? n))
                      {:id id :kind :removed :name (:name b) :type (:type b)}

                      (and (some? b) (some? n))
                      (let [changes (shape-changes b n root-b root-n)]
                        (when (seq changes)
                          {:id id :kind :changed :name (:name n) :type (:type n)
                           :changes changes}))))))
          ids)))

;; --- Dialog

(defn- version-label
  [{:keys [label created-at created-by]}]
  (let [date (some-> created-at (ct/format-inst :localized-date-time))]
    (if (or (= "system" created-by) (str/blank? label) (str/starts-with? (str label) "internal/"))
      (tr "zvena.compare.autosave" date)
      (str label " · " date))))

(mf/defc frame-preview*
  {::mf/private true}
  [{:keys [objects frame-id title]}]
  [:div {:class (stl/css :pane)}
   [:div {:class (stl/css :pane-title)} title]
   [:div {:class (stl/css :pane-canvas)}
    (if (some? (get objects frame-id))
      [:& render/object-svg {:objects objects :object-id frame-id}]
      [:span {:class (stl/css :pane-empty)} (tr "zvena.compare.not-in-version")])]])

(mf/defc change-row*
  {::mf/private true}
  [{:keys [row]}]
  (let [{:keys [kind name changes]} row]
    [:li {:class (stl/css :change)}
     [:div {:class (stl/css :change-head)}
      [:span {:class (stl/css-case :badge true
                                   :badge-added (= kind :added)
                                   :badge-removed (= kind :removed)
                                   :badge-changed (= kind :changed))}
       (case kind
         :added   (tr "zvena.compare.added")
         :removed (tr "zvena.compare.removed")
         (tr "zvena.compare.changed"))]
      [:span {:class (stl/css :change-name) :title name} name]]
     (when (seq changes)
       [:table {:class (stl/css :props)}
        [:tbody
         (for [{:keys [prop label before after]} changes]
           [:tr {:key (d/name prop)}
            [:th label]
            [:td {:class (stl/css :before)} (or before "–")]
            [:td {:class (stl/css :arrow)} "→"]
            [:td {:class (stl/css :after)} (or after "–")]])]])]))

(mf/defc compare-changes-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-compare-changes}
  [{:keys [file-id page-id frame-id]}]
  (let [objects-now (mf/deref refs/workspace-page-objects)
        frame       (get objects-now frame-id)
        versions*   (mf/use-state nil)
        versions    (deref versions*)
        selected*   (mf/use-state nil)
        selected    (deref selected*)
        snapshot*   (mf/use-state {:status :idle})
        snapshot    (deref snapshot*)
        objects-before (dm/get-in snapshot [:file :data :pages-index page-id :objects])

        rows (mf/with-memo [objects-before objects-now frame-id]
               (when (some? objects-before)
                 (compare-frame objects-before objects-now frame-id)))

        close (mf/use-fn #(st/emit! (modal/hide)))

        on-overlay-click
        (mf/use-fn
         (mf/deps close)
         (fn [event]
           (when (= (dom/get-target event) (dom/get-current-target event))
             (close))))

        on-version
        (mf/use-fn
         (fn [event]
           (reset! selected* (some-> (dom/get-target event) dom/get-value uuid/parse))))]

    ;; versions of the file, newest first
    (mf/with-effect [file-id]
      (let [sub (->> (rp/cmd! :get-file-snapshots {:file-id file-id})
                     (rx/subs! (fn [items]
                                 (let [items (->> items
                                                  (sort-by :created-at)
                                                  (reverse)
                                                  (vec))]
                                   (reset! versions* items)
                                   (when-let [v (first items)]
                                     (reset! selected* (:id v)))))
                               (fn [_] (reset! versions* []))))]
        #(rx/dispose! sub)))

    ;; the selected version's data
    (mf/with-effect [file-id selected]
      (when (some? selected)
        (reset! snapshot* {:status :loading})
        (let [state    @st/state
              features (features/get-enabled-features state (:current-team-id state))
              sub      (->> (rp/cmd! :get-file-snapshot {:file-id file-id
                                                         :id selected
                                                         :features features})
                            (rx/subs! (fn [file] (reset! snapshot* {:status :loaded :file file}))
                                      (fn [_] (reset! snapshot* {:status :error}))))]
          #(rx/dispose! sub))))

    [:div {:class (stl/css :modal-overlay)
           :on-click on-overlay-click
           :data-testid "zvena-compare-changes"}
     [:div {:class (stl/css :modal-container)
            :role "dialog"
            :aria-label (tr "zvena.compare.title")}
      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2 :typography "headline-medium"}
        (tr "zvena.compare.title")]
       [:span {:class (stl/css :frame-name)} (:name frame)]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "labels.close")
                         :on-click close
                         :icon i/close
                         :class (stl/css :modal-close-btn)}]]

      (cond
        (nil? versions)
        [:div {:class (stl/css :empty)} (tr "zvena.compare.loading")]

        (empty? versions)
        [:div {:class (stl/css :empty)} (tr "zvena.compare.no-versions")]

        :else
        [:*
         [:label {:class (stl/css :version-row)}
          [:span (tr "zvena.compare.compare-with")]
          [:select {:class (stl/css :version-select)
                    :value (str selected)
                    :on-change on-version}
           (for [v versions]
             [:option {:key (str (:id v)) :value (str (:id v))}
              (version-label v)])]]

         [:div {:class (stl/css :body)}
          [:div {:class (stl/css :panes)}
           (case (:status snapshot)
             :loaded
             [:> frame-preview* {:objects objects-before
                                 :frame-id frame-id
                                 :title (tr "zvena.compare.before")}]
             :error
             [:div {:class (stl/css :pane :pane-empty)} (tr "zvena.compare.load-error")]
             [:div {:class (stl/css :pane :pane-empty)} (tr "zvena.compare.loading")])
           [:> frame-preview* {:objects objects-now
                               :frame-id frame-id
                               :title (tr "zvena.compare.now")}]]

          [:div {:class (stl/css :changes)}
           [:div {:class (stl/css :changes-title)}
            (if (some? rows)
              (tr "zvena.compare.n-changes" (count rows))
              (tr "zvena.compare.changes"))]
           (cond
             (nil? rows) nil
             (empty? rows) [:div {:class (stl/css :empty)} (tr "zvena.compare.no-changes")]
             :else
             [:ul {:class (stl/css :change-list)}
              (for [row rows]
                [:> change-row* {:key (dm/str (:id row)) :row row}])])]]])]]))

(defn open-compare
  [file-id page-id frame-id]
  (modal/show :zvena-compare-changes {:file-id file-id :page-id page-id :frame-id frame-id}))
