-- Migration 015: Support multiple journal entries per day
-- Adds sequence column and changes unique constraint from date to (date, sequence)
--
-- 2026-07-04 (task 475a54c9): made idempotent so a from-scratch replay
-- against a database whose journal_entries already has the final shape
-- (e.g. created by database/init.sql) no-ops safely. In normal operation
-- this file is baseline-stamped and never executed (see BASELINE).

-- Add sequence column (default 1 for existing entries)
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS sequence INTEGER NOT NULL DEFAULT 1;

-- Drop old unique constraint on date
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_date_key;

-- Add new unique constraint on (date, sequence) — only if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'journal_entries_date_sequence_key'
      AND conrelid = 'journal_entries'::regclass
  ) THEN
    ALTER TABLE journal_entries
      ADD CONSTRAINT journal_entries_date_sequence_key UNIQUE (date, sequence);
  END IF;
END $$;

-- Update index to include sequence
DROP INDEX IF EXISTS idx_journal_entries_date;
CREATE INDEX IF NOT EXISTS idx_journal_entries_date_seq ON journal_entries(date DESC, sequence DESC);
