-- 048: preserve exactly-once private Mindscape attachment on databases upgraded through old 045/047 shapes
-- Fail closed if historical duplicates exist; operators must investigate rather than silently choose a keeper.
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_mindscape_track_entry
  ON journal_mindscape_tracks(entry_id);
