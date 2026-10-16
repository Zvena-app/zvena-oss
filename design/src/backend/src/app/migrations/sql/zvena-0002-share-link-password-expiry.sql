-- zvena: Figma's link settings for share links. A link can be password
-- protected (argon2id hash, never sent to clients), expire at a moment in
-- time, and be limited to the file's team ("only people invited").
ALTER TABLE share_link
  ADD COLUMN IF NOT EXISTS password_hash text NULL,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS who_view text NOT NULL DEFAULT 'all';
