-- Migration 056: reports.content_hash (task c655d243, reports hardening item 1)
--
-- Server-computed sha256 hex digest of `content`, maintained by backend code
-- (ReportManager) on INSERT/UPDATE — deliberately NOT a trigger, so the hash
-- algorithm lives in one place (the application) and stays portable.
-- This migration only adds the column and backfills existing rows; pgcrypto's
-- digest() is used one-off here so the backfill matches Node's
-- crypto.createHash('sha256').update(content, 'utf8').digest('hex').

ALTER TABLE reports ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);

CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE reports
SET content_hash = encode(digest(content, 'sha256'), 'hex')
WHERE content_hash IS NULL;
