-- J12: sparse Hermes personality statuses with provenance and idempotency.
-- Forward-only and compatible with legacy Nim/Spark rows.
ALTER TABLE bot_status
  ADD COLUMN IF NOT EXISTS author TEXT,
  ADD COLUMN IF NOT EXISTS author_harness TEXT,
  ADD COLUMN IF NOT EXISTS source_receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS cadence_window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cadence_window_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS run_type TEXT,
  ADD COLUMN IF NOT EXISTS scheduler_tick_id TEXT,
  ADD COLUMN IF NOT EXISTS failure JSONB;

UPDATE bot_status
SET author = COALESCE(author, 'Nim'),
    author_harness = COALESCE(author_harness, 'openclaw'),
    run_type = COALESCE(run_type, 'legacy')
WHERE author IS NULL OR author_harness IS NULL OR run_type IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bot_status_idempotency_key_unique
  ON bot_status(idempotency_key);
CREATE INDEX IF NOT EXISTS bot_status_author_updated_idx
  ON bot_status(author_harness, updated_at DESC);

DO $$ BEGIN
  ALTER TABLE bot_status ADD CONSTRAINT bot_status_author_harness_valid
    CHECK (author_harness IN ('openclaw','hermes','spark','unknown')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE bot_status ADD CONSTRAINT bot_status_run_type_valid
    CHECK (run_type IN ('legacy','manual','scheduled','watchdog')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
