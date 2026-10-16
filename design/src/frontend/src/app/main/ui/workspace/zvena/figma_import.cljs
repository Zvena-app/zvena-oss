;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.main.ui.workspace.zvena.figma-import
  "zvena: \"Import from Figma\". Two ways in:

  - a local .fig file (Figma: File > Save local copy…), read entirely in
    the browser by fig_file.js; its images are uploaded into this file;
  - a Figma file (or frame) link and a personal access token; Design's
    backend fetches the document through Figma's REST API (the token is
    used for this import only) and the image fills are copied.

  Either way a built-in plugin (figma_converter.js) builds pages and
  layers from the same REST-shaped document."
  (:require-macros [app.main.style :as stl])
  (:require
   ["./fig_file.js" :as fig-file]
   ["./fzstd.js" :as fzstd]
   [app.common.data :as d]
   [app.config :as cf]
   [app.main.data.modal :as modal]
   [app.main.data.uploads :as uploads]
   [app.main.refs :as refs]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.util.dom :as dom]
   [app.util.dom.dnd :as dnd]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]
   [shadow.resource :as rc]))

(def ^:private converter-code
  (rc/inline "app/main/ui/workspace/zvena/figma_converter.js"))

(defn parse-link
  "File key and optional node id from a Figma link (figma.com/file/…,
  /design/…, /proto/…, /board/…) or a bare file key."
  [link]
  (let [link (str/trim (or link ""))
        key  (or (second (re-find #"figma\.com/(?:file|design|proto|board)/([A-Za-z0-9]{10,64})" link))
                 (when (re-matches #"[A-Za-z0-9]{10,64}" link) link))
        node (some-> (re-find #"[?&]node-id=([0-9A-Za-z%:;_-]+)" link)
                     second
                     js/decodeURIComponent
                     (str/replace "-" ":"))]
    (when key {:file-key key :node-id node})))

(defn- image-refs
  "Every imageRef used by a visible paint in the tree."
  [^js root]
  (let [refs (volatile! #{})]
    (letfn [(paints [^js ps]
              (when (array? ps)
                (doseq [^js p ps]
                  (when (and (= "IMAGE" (.-type p)) (not (false? (.-visible p))) (.-imageRef p))
                    (vswap! refs conj (.-imageRef p))))))
            (walk [^js n]
              (when n
                (paints (.-fills n))
                (paints (.-strokes n))
                (when-let [kids (.-children n)]
                  (doseq [k kids] (walk k)))
                (when-let [nodes (.-nodes n)]
                  (doseq [k (js/Object.values nodes)] (walk (some-> ^js k .-document))))))]
      (walk (or (.-document root) root))
      @refs)))

(defn- error-message
  [cause]
  (case (:code (or (ex-data cause) cause))
    :zvena-figma-auth        (tr "zvena.figma.error-auth")
    :zvena-figma-not-found   (tr "zvena.figma.error-not-found")
    :zvena-figma-rate-limit  (tr "zvena.figma.error-rate-limit")
    :zvena-figma-unreachable (tr "zvena.figma.error-unreachable")
    :zvena-figma-bad-key     (tr "zvena.figma.error-link")
    (tr "zvena.figma.error-generic")))

;; zvena: .fig import

(defn- fig-error-message
  [cause]
  (case (fig-file/errorCode cause)
    "not-fig" (tr "zvena.figma-import.error-not-fig")
    "damaged" (tr "zvena.figma-import.error-damaged")
    "zstd"    (tr "zvena.figma-import.error-damaged")
    "browser" (tr "zvena.figma-import.error-browser")
    (tr "zvena.figma.error-generic")))

(defn- media-entry
  "What the converter needs of an uploaded media object."
  [mobj]
  #js {:id (str (:id mobj))
       :name (:name mobj)
       :width (:width mobj)
       :height (:height mobj)
       :mtype (:mtype mobj)})

(defn- upload-image
  "Uploads the bytes of one .fig image into the file (in chunks when it's
  big); emits the media object."
  [file-id ref bytes mtype]
  (let [blob (js/Blob. #js [bytes] #js {:type mtype})
        name (str "figma-" (subs ref 0 (min 12 (count ref))))]
    (if (>= (.-size blob) cf/upload-chunk-size)
      (->> (uploads/upload-blob-chunked blob)
           (rx/mapcat
            (fn [{:keys [session-id]}]
              (rp/cmd! :assemble-file-media-object
                       {:session-id session-id
                        :file-id file-id
                        :is-local true
                        :name name
                        :mtype mtype}))))
      (rp/cmd! :upload-file-media-object
               {:file-id file-id
                :is-local true
                :name name
                :content blob}))))

(defn- fig-images
  "Uploads the images a decoded .fig uses, four at a time; emits the
  map imageRef → media entry. An image that can't be read or stored is
  left out (the converter notes it)."
  [file-id ^js res on-progress]
  (let [refs       (vec (unchecked-get res "imageRefs"))
        read-image (unchecked-get res "readImage")]
    (->> (rx/from (partition-all 4 refs))
         (rx/mapcat
          (fn [batch]
            (apply rx/merge
                   (for [ref batch]
                     (->> (rx/from (read-image ref))
                          (rx/mapcat
                           (fn [bytes]
                             (if-let [mtype (fig-file/imageType bytes)]
                               (upload-image file-id ref bytes mtype)
                               (rx/throw (ex-info "unsupported image" {:ref ref})))))
                          (rx/map (fn [mobj] [ref mobj]))
                          (rx/catch (fn [_] (rx/of [ref nil])))
                          (rx/tap (fn [_] (on-progress))))))))
         (rx/reduce (fn [acc [ref mobj]]
                      (cond-> acc
                        (some? mobj)
                        (doto (unchecked-set ref (media-entry mobj)))))
                    #js {}))))

(mf/defc figma-import-dialog
  {::mf/register modal/components
   ::mf/register-as :zvena-figma-import}
  ;; zvena: `file` — a .fig dropped on the canvas, imported right away
  [{:keys [file]}]
  (let [file-id  (:id (mf/deref refs/file))
        state*   (mf/use-state {:stage :form :link "" :token ""})
        state    (deref state*)
        stage    (:stage state)
        input-ref (mf/use-ref nil)

        close
        (mf/use-fn #(st/emit! (modal/hide)))

        on-field
        (mf/use-fn
         (fn [event]
           (let [target (dom/get-target event)]
             (swap! state* assoc
                    (keyword (dom/get-data target "field"))
                    (dom/get-value target)
                    :error nil))))

        build!
        (mf/use-fn
         (fn [^js doc images warnings]
           (swap! state* assoc :stage :building :done 0 :total 0)
           (let [load-plugin (unchecked-get js/globalThis "ɵloadPlugin")
                 extensions  #js {:zvenaFigma
                                  #js {:doc doc
                                       :images images
                                       ;; zvena: notes of the .fig reader
                                       :warnings (or warnings #js [])
                                       :progress (fn [done total _]
                                                   (swap! state* assoc :done done :total total))
                                       :done (fn [^js summary]
                                               (swap! state* assoc
                                                      :stage :finished
                                                      :summary (js->clj summary :keywordize-keys true)))}}]
             (if (fn? load-plugin)
               (-> (load-plugin
                    #js {:pluginId "00000000-0000-0000-0000-000000000000"
                         :name "Figma import"
                         :description ""
                         :version 2
                         :host ""
                         :code converter-code
                         :permissions #js ["content:read" "content:write" "library:read" "library:write"]}
                    nil
                    extensions)
                   (.catch (fn [_]
                             (swap! state* assoc :stage :form :error (tr "zvena.figma.error-generic")))))
               (swap! state* assoc :stage :form :error (tr "zvena.figma.error-generic"))))))

        start
        (mf/use-fn
         (mf/deps state file-id build!)
         (fn [event]
           (dom/prevent-default event)
           (let [{:keys [file-key node-id]} (parse-link (:link state))
                 token (str/trim (:token state))]
             (cond
               (nil? file-key)
               (swap! state* assoc :error (tr "zvena.figma.error-link"))

               (< (count token) 10)
               (swap! state* assoc :error (tr "zvena.figma.error-token"))

               :else
               (do
                 (swap! state* assoc :stage :fetching :error nil)
                 (->> (rp/cmd! :zvena-figma-file (d/without-nils {:token token :file-key file-key :node-id node-id}))
                      (rx/mapcat
                       (fn [{:keys [document images]}]
                         (let [doc     (js/JSON.parse document)
                               urls    (or (some-> (js/JSON.parse images) .-meta .-images) #js {})
                               needed  (->> (image-refs doc)
                                            (filter #(unchecked-get urls %))
                                            (vec))]
                           (swap! state* assoc :stage :images :done 0 :total (count needed))
                           ;; four downloads at a time
                           (->> (rx/from (partition-all 4 needed))
                                (rx/mapcat
                                 (fn [batch]
                                   (apply rx/merge
                                    (for [ref batch]
                                      (->> (rp/cmd! :create-file-media-object-from-url
                                                    {:file-id file-id
                                                     :is-local true
                                                     :url (unchecked-get urls ref)
                                                     :name (str "figma-" (subs ref 0 (min 12 (count ref))))})
                                           (rx/map (fn [mobj] [ref mobj]))
                                           ;; a missing image doesn't stop the import
                                           (rx/catch (fn [_] (rx/of [ref nil])))
                                           (rx/tap (fn [_] (swap! state* update :done inc))))))))
                                (rx/reduce (fn [acc [ref mobj]]
                                             (cond-> acc
                                               (some? mobj)
                                               (doto (unchecked-set ref (media-entry mobj)))))
                                           #js {})
                                (rx/map (fn [imgs] [doc imgs]))))))
                      (rx/subs!
                       (fn [[doc imgs]] (build! doc imgs nil))
                       (fn [cause]
                         (swap! state* assoc :stage :form :error (error-message cause))))))))))

        ;; zvena: a .fig file, read in the browser
        on-fig-file
        (mf/use-fn
         (mf/deps file-id build!)
         (fn [^js fig]
           (when (some? fig)
             (swap! state* assoc :stage :reading :error nil :dragging false)
             (->> (rx/from (-> (.arrayBuffer fig)
                               (.then (fn [buf]
                                        (fig-file/decodeFig buf #js {:zstd fzstd/decompress})))))
                  (rx/mapcat
                   (fn [^js res]
                     (swap! state* assoc :stage :images :done 0
                            :total (count (unchecked-get res "imageRefs")))
                     (->> (fig-images file-id res #(swap! state* update :done inc))
                          (rx/map (fn [imgs] [res imgs])))))
                  (rx/subs!
                   (fn [[^js res imgs]]
                     (build! (unchecked-get res "doc") imgs (unchecked-get res "warnings")))
                   (fn [cause]
                     (swap! state* assoc :stage :form :error (fig-error-message cause))))))))

        on-choose
        (mf/use-fn #(dom/click (mf/ref-val input-ref)))

        on-file-input
        (mf/use-fn
         (mf/deps on-fig-file)
         (fn [event]
           (let [^js target (dom/get-target event)
                 fig        (some-> (.-files target) (aget 0))]
             (dom/set-value! target "")
             (on-fig-file fig))))

        on-drag-over
        (mf/use-fn
         (mf/deps stage)
         (fn [event]
           (when (dnd/has-type? event "Files")
             (dom/prevent-default event)
             (dom/stop-propagation event)
             (when (and (= stage :form) (not (:dragging @state*)))
               (swap! state* assoc :dragging true)))))

        on-drag-leave
        (mf/use-fn
         (fn [^js event]
           (let [^js target (.-currentTarget event)
                 related    (.-relatedTarget event)]
             (when-not (and (some? related) (.contains target related))
               (swap! state* assoc :dragging false)))))

        on-drop
        (mf/use-fn
         (mf/deps stage on-fig-file)
         (fn [event]
           (when (dnd/has-type? event "Files")
             (dom/prevent-default event)
             (dom/stop-propagation event)
             (swap! state* assoc :dragging false)
             (when (= stage :form)
               (on-fig-file (first (dnd/get-files event)))))))]

    ;; zvena: a .fig dropped on the canvas starts right away
    (mf/with-effect [file]
      (when (some? file)
        (on-fig-file file)))

    ;; zvena: a file can be dropped anywhere over the dialog
    [:div {:class (stl/css :modal-overlay)
           :on-drag-over on-drag-over
           :on-drag-leave on-drag-leave
           :on-drop on-drop}
     [:div {:class (stl/css :modal-container)}
      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2 :typography "headline-medium"} (tr "zvena.figma.title")]
       (when (contains? #{:form :finished} stage)
         [:> icon-button* {:variant "ghost"
                           :aria-label (tr "labels.close")
                           :on-click close
                           :icon i/close
                           :class (stl/css :modal-close-btn)}])]

      (case stage
        :form
        [:form {:class (stl/css :fields) :on-submit start}
         [:p {:class (stl/css :hint)} (tr "zvena.figma.intro")]

         ;; zvena: a local .fig file, no token needed
         [:div {:class (stl/css-case :drop-zone true
                                     :drop-zone-active (:dragging state))}
          [:span {:class (stl/css :drop-title)} (tr "zvena.figma-import.fig-title")]
          [:span {:class (stl/css :hint)} (tr "zvena.figma-import.fig-hint")]
          [:div {:class (stl/css :drop-row)}
           [:span {:class (stl/css :hint)} (tr "zvena.figma-import.fig-drop")]
           [:> button* {:variant "secondary"
                        :type "button"
                        :on-click on-choose}
            (tr "zvena.figma-import.fig-choose")]]
          [:input {:type "file"
                   :accept ".fig"
                   :ref input-ref
                   :class (stl/css :file-input)
                   :on-change on-file-input}]]

         [:p {:class (stl/css :separator)} (tr "zvena.figma-import.or-link")]

         [:label {:class (stl/css :field)}
          [:span (tr "zvena.figma.link")]
          [:input {:data-field "link"
                   :auto-focus true
                   :placeholder "https://www.figma.com/design/…"
                   :value (:link state)
                   :on-change on-field}]]
         [:label {:class (stl/css :field)}
          [:span (tr "zvena.figma.token")]
          [:input {:data-field "token"
                   :type "password"
                   :autoComplete "off"
                   :placeholder "figd_…"
                   :value (:token state)
                   :on-change on-field}]]
         [:p {:class (stl/css :hint)}
          (tr "zvena.figma.token-hint") " "
          [:a {:href "https://help.figma.com/hc/en-us/articles/8085703771159"
               :target "_blank"
               :rel "noopener noreferrer"}
           (tr "zvena.figma.token-how")]]
         (when-let [error (:error state)]
           [:p {:class (stl/css :error)} error])
         [:div {:class (stl/css :modal-footer)}
          [:> button* {:variant "secondary" :type "button" :on-click close} (tr "labels.cancel")]
          [:> button* {:variant "primary" :type "submit"} (tr "zvena.figma.import")]]]

        (:reading :fetching :images :building)
        [:div {:class (stl/css :progress)}
         [:p (case stage
               :reading  (tr "zvena.figma-import.reading")
               :fetching (tr "zvena.figma.fetching")
               :images   (tr "zvena.figma.images" (:done state 0) (:total state 0))
               :building (tr "zvena.figma.building" (:done state 0) (:total state 0)))]
         [:div {:class (stl/css :bar)}
          [:div {:class (stl/css :bar-fill)
                 :style {:width (str (if (pos? (:total state 0))
                                       (min 100 (* 100 (/ (:done state 0) (:total state 1))))
                                       5)
                                     "%")}}]]]

        :finished
        (let [{:keys [pages nodes components skipped warnings error]} (:summary state)]
          [:div {:class (stl/css :fields)}
           (if error
             [:p {:class (stl/css :error)} (str (tr "zvena.figma.error-generic") " " error)]
             [:p (tr "zvena.figma.finished" (or pages 0) (or nodes 0) (or components 0))])
           (when (pos? (or skipped 0))
             [:p {:class (stl/css :hint)} (tr "zvena.figma.skipped" skipped)])
           (when (seq warnings)
             [:details {:class (stl/css :warnings)}
              [:summary (tr "zvena.figma.warnings" (count warnings))]
              [:ul (for [[idx w] (map-indexed vector warnings)]
                     [:li {:key idx} w])]])
           [:div {:class (stl/css :modal-footer)}
            [:> button* {:variant "primary" :on-click close} (tr "labels.close")]]]))]]))
