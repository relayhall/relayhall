-- 045: reviewed Hermes journal publication contract
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'narrative',
  ADD COLUMN IF NOT EXISTS content_author TEXT,
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS song_path TEXT,
  ADD COLUMN IF NOT EXISTS song_url TEXT,
  ADD COLUMN IF NOT EXISTS song_title TEXT;

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN ('narrative','operational'));

CREATE TABLE IF NOT EXISTS journal_publication_approvals (
  idempotency_key CHAR(32) PRIMARY KEY CHECK (idempotency_key ~ '^[0-9a-f]{32}$'),
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  request_fingerprint CHAR(64) NOT NULL,
  approval_fingerprint CHAR(64) NOT NULL,
  source_contract_sha256 CHAR(64) NOT NULL,
  reflection_sha256 CHAR(64) NOT NULL,
  approved_request JSONB NOT NULL,
  expected_entry JSONB NOT NULL,
  approved_by TEXT NOT NULL CHECK (approved_by <> 'service_account'),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS journal_run_publications (
  idempotency_key CHAR(32) PRIMARY KEY REFERENCES journal_publication_approvals(idempotency_key),
  run_id UUID NOT NULL UNIQUE,
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('new_entry','historical_media_repair')),
  executor TEXT NOT NULL CHECK (executor='Hermes'),
  content_author TEXT NOT NULL,
  approval_fingerprint CHAR(64) NOT NULL,
  source_contract_sha256 CHAR(64) NOT NULL,
  reflection_sha256 CHAR(64) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('published','rolled_back')),
  previous_entry JSONB NOT NULL,
  published_entry JSONB NOT NULL,
  published_media JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_active_publication_entry ON journal_run_publications(entry_id) WHERE state='published';
CREATE INDEX IF NOT EXISTS idx_journal_run_publications_entry ON journal_run_publications(entry_id,published_at DESC);

CREATE TABLE IF NOT EXISTS journal_mindscape_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE CASCADE,
  run_key CHAR(32) NOT NULL UNIQUE REFERENCES journal_run_publications(idempotency_key),
  title TEXT,
  provider_url TEXT,
  media_path TEXT NOT NULL,
  media_sha256 CHAR(64) NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility='private'),
  selection_policy TEXT NOT NULL DEFAULT 'automatic_validated_keeper',
  state TEXT NOT NULL DEFAULT 'attached' CHECK (state IN ('attached','rolled_back')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE journal_publication_approvals IS 'Human-authenticated immutable publication contracts.';
COMMENT ON TABLE journal_run_publications IS 'Idempotent approval-bound Hermes Journal publication ledger.';
COMMENT ON TABLE journal_mindscape_tracks IS 'Private internal Daily Mindscape collection; public exposure unsupported.';
