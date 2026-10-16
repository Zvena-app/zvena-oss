-- zvena: Figma's library analytics. Every insert of a library component
-- into a file and every detachment of one of its copies is recorded by
-- the editor where it happened, so the library's analytics can show
-- inserts and detachments over time. Instance counts are computed from
-- the files themselves and are not stored.
CREATE TABLE IF NOT EXISTS library_event (
  id uuid PRIMARY KEY,
  library_file_id uuid NOT NULL REFERENCES file(id) ON DELETE CASCADE DEFERRABLE,
  file_id uuid NOT NULL REFERENCES file(id) ON DELETE CASCADE DEFERRABLE,
  component_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('insert', 'detach')),
  profile_id uuid NULL REFERENCES profile(id) ON DELETE SET NULL DEFERRABLE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS library_event__library_file_id__created_at__idx
    ON library_event (library_file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS library_event__file_id__idx
    ON library_event (file_id);

CREATE INDEX IF NOT EXISTS library_event__profile_id__idx
    ON library_event (profile_id);
