-- Migration 017: Add voice_path to journal_entries
-- Support for narrated journal entries

ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS voice_path VARCHAR(500);
