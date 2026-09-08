-- 047: forward-only hardening for databases that already recorded migration 045
ALTER TABLE journal_run_publications
  ADD COLUMN IF NOT EXISTS reflection_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS previous_entry JSONB,
  ADD COLUMN IF NOT EXISTS published_entry JSONB;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='journal_run_publications' AND column_name='previous_media') THEN
    ALTER TABLE journal_run_publications ALTER COLUMN previous_media DROP NOT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS journal_publication_approvals (
  idempotency_key CHAR(32) PRIMARY KEY,
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  request_fingerprint CHAR(64) NOT NULL,
  approval_fingerprint CHAR(64) NOT NULL,
  source_contract_sha256 CHAR(64) NOT NULL,
  reflection_sha256 CHAR(64) NOT NULL,
  approved_request JSONB NOT NULL,
  expected_entry JSONB NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS journal_mindscape_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  run_key CHAR(32) NOT NULL UNIQUE REFERENCES journal_run_publications(idempotency_key) ON DELETE RESTRICT,
  title TEXT,
  provider_url TEXT,
  media_path TEXT NOT NULL,
  media_sha256 CHAR(64) NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  selection_policy TEXT NOT NULL DEFAULT 'deterministic_random_pair',
  state TEXT NOT NULL DEFAULT 'attached' CHECK (state IN ('attached','rolled_back')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_one_active_publication_per_entry
  ON journal_run_publications(entry_id) WHERE state='published';
CREATE INDEX IF NOT EXISTS idx_journal_mindscape_private
  ON journal_mindscape_tracks(visibility,state,created_at DESC);

DO $$ BEGIN
  ALTER TABLE journal_run_publications
    ADD CONSTRAINT journal_run_publications_reflection_sha256_check
    CHECK (reflection_sha256 IS NULL OR reflection_sha256 ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
