-- zvena: Figma's comment reactions (one row per person, emoji and comment)
CREATE TABLE IF NOT EXISTS comment_reaction (
  comment_id uuid NOT NULL REFERENCES comment(id) ON DELETE CASCADE DEFERRABLE,
  profile_id uuid NOT NULL REFERENCES profile(id) ON DELETE CASCADE DEFERRABLE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, profile_id, emoji)
);

CREATE INDEX IF NOT EXISTS comment_reaction__profile_id__idx
    ON comment_reaction (profile_id);
