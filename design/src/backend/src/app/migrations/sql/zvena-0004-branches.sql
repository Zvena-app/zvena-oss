-- zvena: Figma's branching and merging. A branch is a copy of a file
-- (the "main" file) that lives in the same project, is hidden from the
-- project grid and is merged back into main later.
--
-- `base_snapshot_id` is a snapshot of main (file_change row with
-- created_by = 'system' and a far-future deleted_at) taken when the
-- branch was created or last updated from main: the merge base of the
-- 3-way comparison base / main / branch. `base_revn` is main's revn at
-- that moment ("Main file has changes" when main's revn is greater).
--
-- `media_map` (transit) maps the image ids of main to the ids of their
-- copies in the branch file (duplication gives the branch its own
-- file_media_object rows); shape ids are kept as they are.
--
-- Merged and archived branches keep their row (and their file, still
-- hidden) so "View branches" lists them. Deleting main deletes the rows.
CREATE TABLE IF NOT EXISTS file_branch (
  id uuid PRIMARY KEY,
  main_file_id uuid NOT NULL REFERENCES file(id) ON DELETE CASCADE DEFERRABLE,
  branch_file_id uuid NULL REFERENCES file(id) ON DELETE SET NULL DEFERRABLE,
  name text NOT NULL,
  created_by uuid NULL REFERENCES profile(id) ON DELETE SET NULL DEFERRABLE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  modified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  base_revn bigint NOT NULL DEFAULT 0,
  base_snapshot_id uuid NULL,
  media_map jsonb NULL,
  status text NOT NULL DEFAULT 'active',
  merged_at timestamptz NULL,
  merged_by uuid NULL REFERENCES profile(id) ON DELETE SET NULL DEFERRABLE,
  merge_snapshot_id uuid NULL,
  archived_at timestamptz NULL,
  archived_by uuid NULL REFERENCES profile(id) ON DELETE SET NULL DEFERRABLE,

  CONSTRAINT file_branch__status__check
    CHECK (status IN ('active', 'merged', 'archived'))
);

CREATE INDEX IF NOT EXISTS file_branch__main_file_id__idx
    ON file_branch (main_file_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS file_branch__branch_file_id__idx
    ON file_branch (branch_file_id);

CREATE INDEX IF NOT EXISTS file_branch__created_by__idx
    ON file_branch (created_by);

CREATE INDEX IF NOT EXISTS file_branch__merged_by__idx
    ON file_branch (merged_by);

CREATE INDEX IF NOT EXISTS file_branch__archived_by__idx
    ON file_branch (archived_by);
