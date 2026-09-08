-- Migration: 028_ingester_state.sql
-- BUG-07c: Persist TranscriptIngester byte offsets across backend restarts.
--
-- Without this, every restart re-reads JSONL files from byte 0 and re-inserts
-- all messages. The ON CONFLICT DO NOTHING (migration 027) is the safety net,
-- but persisting offsets avoids the redundant I/O entirely.

CREATE TABLE IF NOT EXISTS transcript_ingester_state (
  session_key  VARCHAR(255) PRIMARY KEY,
  bytes_read   BIGINT       NOT NULL DEFAULT 0,
  line_count   INTEGER      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE transcript_ingester_state IS
  'Persists TranscriptIngester byte offsets so live watchers resume from last position after restart.';

COMMENT ON COLUMN transcript_ingester_state.bytes_read IS
  'Byte offset in the JSONL file up to which we have already ingested.';

COMMENT ON COLUMN transcript_ingester_state.line_count IS
  'Number of JSONL lines read so far (used as base ordinal for new messages).';
