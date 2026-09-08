-- Migration 006: Journal Entries
-- Daily reflection journal with mood tracking and AI-generated art

CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL UNIQUE,
  mood VARCHAR(50),
  reflection_text TEXT NOT NULL,
  image_path VARCHAR(500),
  highlights TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(date DESC);
