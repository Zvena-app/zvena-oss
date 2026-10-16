;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) zvena

(ns app.zvena.teams
  "zvena: teams are zvena.app's workspaces. Their members and roles are set
  by zvena (app.zvena.management/sync-team); Design's own team commands
  (create, invite, change roles, leave, delete…) refuse to run while the
  `zvena` flag is on, so the two never drift apart.

  zvena's roles map onto Penpot's: owner → owner, editor → editor,
  commenter → viewer, viewer → viewer that may not comment (a row in
  zvena_member_flags; Penpot's viewers can comment by default)."
  (:require
   [app.common.exceptions :as ex]
   [app.config :as cf]
   [app.db :as db]))

(defn enabled?
  []
  (contains? cf/flags :zvena))

(def ^:private sql:schema
  "CREATE TABLE IF NOT EXISTS zvena_member_flags (
     team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     profile_id uuid NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
     can_comment boolean NOT NULL DEFAULT true,
     PRIMARY KEY (team_id, profile_id))")

(def ^:private schema-ready (atom false))

(defn ensure-schema!
  "zvena's own table, created on first use (idempotent; outside Penpot's
  migration list so upstream migrations keep their numbering, and never
  before Penpot's own tables exist)."
  [cfg]
  (when-not @schema-ready
    (db/exec-one! cfg [sql:schema])
    (reset! schema-ready true)))

(defn check-managed!
  "Refuses a team change made inside Design: zvena.app manages teams."
  []
  (when (enabled?)
    (ex/raise :type :restriction
              :code :zvena-teams-managed
              :hint "teams are managed on zvena.app")))

(def ^:private sql:can-comment
  "SELECT f.can_comment
     FROM zvena_member_flags AS f
     JOIN project AS p ON (p.team_id = f.team_id)
     JOIN file AS fl ON (fl.project_id = p.id)
    WHERE fl.id = ? AND f.profile_id = ?")

(defn check-can-comment!
  "A zvena viewer (a Penpot viewer marked can_comment = false in the file's
  team) may read comments but not write them."
  [cfg profile-id file-id]
  (when (and (enabled?) profile-id)
    (ensure-schema! cfg)
    (when-let [row (db/exec-one! cfg [sql:can-comment file-id profile-id])]
      (when (false? (:can-comment row))
        (ex/raise :type :restriction
                  :code :zvena-read-only
                  :hint "viewers cannot comment")))))

(defn set-can-comment!
  [conn team-id profile-id can-comment]
  (ensure-schema! conn)
  (db/exec-one! conn ["INSERT INTO zvena_member_flags (team_id, profile_id, can_comment) VALUES (?, ?, ?)
                       ON CONFLICT (team_id, profile_id) DO UPDATE SET can_comment = excluded.can_comment"
                      team-id profile-id (boolean can-comment)]))
