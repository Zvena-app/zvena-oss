-- zvena: Figma's library publishing with release notes. Every time the
-- owner of a shared library presses "Publish", one row records who
-- published, when, the description they wrote and a summary of what
-- changed since the previous publish (components, colors, typographies
-- added / changed / removed). `snapshot` holds the asset ids, names and
-- modification marks the next publish is compared with; only the latest
-- row of a file keeps it, older rows have it set to NULL.
--
-- Publishing is informational: library sync (file_library_sync) keeps
-- working exactly as before.
CREATE TABLE IF NOT EXISTS library_publish (
  id uuid PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES file(id) ON DELETE CASCADE DEFERRABLE,
  profile_id uuid NULL REFERENCES profile(id) ON DELETE SET NULL DEFERRABLE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revn bigint NOT NULL DEFAULT 0,
  description text NOT NULL DEFAULT '',
  summary jsonb NOT NULL,
  snapshot jsonb NULL
);

CREATE INDEX IF NOT EXISTS library_publish__file_id__created_at__idx
    ON library_publish (file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS library_publish__profile_id__idx
    ON library_publish (profile_id);
