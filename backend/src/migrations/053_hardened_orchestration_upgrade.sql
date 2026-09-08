-- 053_hardened_orchestration_upgrade.sql
-- Forward-only repair for databases that recorded the original 051/052 before
-- review attempt identity fields and bounded max_retries were introduced.
-- Version 0 is reserved for synthetic legacy slices; version 1 is the canonical
-- reviewed-subtask schema written by TaskReviewerService.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION task_review_slice_matches_version(slice_version SMALLINT, slice JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(slice) <> 'array' OR jsonb_array_length(slice) = 0 THEN FALSE
    WHEN slice_version = 0 THEN COALESCE(bool_and(
      item ?& ARRAY['kind','attempt_id','task_id','attempt_no','task_snapshot_updated_at']
      AND item->>'kind' = 'legacy_review_attempt'
    ), FALSE)
    WHEN slice_version = 1 THEN COALESCE(bool_and(
      item ?& ARRAY['subtaskId','index','title','status','updatedAt','evidenceReceipt']
      AND jsonb_typeof(item->'index') = 'number'
    ), FALSE)
    ELSE FALSE
  END
  FROM jsonb_array_elements(slice) AS elements(item)
$$;

ALTER TABLE task_review_attempts
  ADD COLUMN IF NOT EXISTS review_slice_version SMALLINT,
  ADD COLUMN IF NOT EXISTS review_slice_hash TEXT,
  ADD COLUMN IF NOT EXISTS review_slice JSONB,
  ADD COLUMN IF NOT EXISTS implementation_receipt_hash TEXT;

UPDATE task_review_attempts
   SET review_slice = jsonb_build_array(
     jsonb_build_object(
       'kind', 'legacy_review_attempt',
       'attempt_id', id,
       'task_id', task_id,
       'attempt_no', attempt_no,
       'task_snapshot_updated_at', task_snapshot_updated_at
     )
   )
 WHERE review_slice IS NULL;

-- Legacy synthetic records are explicitly version 0; they must never claim the
-- canonical reviewed-subtask v1 contract.
UPDATE task_review_attempts
   SET review_slice_version = 0
 WHERE review_slice_version IS NULL;

UPDATE task_review_attempts
   SET review_slice_hash = encode(digest(convert_to(review_slice::text, 'UTF8'), 'sha256'), 'hex')
 WHERE review_slice_hash IS NULL;

UPDATE task_review_attempts
   SET implementation_receipt_hash = encode(
     digest(convert_to(jsonb_build_object(
       'kind', 'legacy_implementation_receipt',
       'attempt_id', id,
       'task_id', task_id,
       'attempt_no', attempt_no,
       'implementation_session_key', implementation_session_key,
       'implementation_commit', implementation_commit,
       'evidence', evidence
     )::text, 'UTF8'), 'sha256'), 'hex')
 WHERE implementation_receipt_hash IS NULL;

ALTER TABLE task_review_attempts
  ALTER COLUMN review_slice_version SET DEFAULT 1,
  ALTER COLUMN review_slice_version SET NOT NULL,
  ALTER COLUMN review_slice_hash SET NOT NULL,
  ALTER COLUMN review_slice SET NOT NULL,
  ALTER COLUMN implementation_receipt_hash SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE task_review_attempts ADD CONSTRAINT task_review_attempts_review_slice_version_supported
    CHECK (review_slice_version IN (0, 1)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE task_review_attempts ADD CONSTRAINT task_review_attempts_review_slice_hash_sha256
    CHECK (review_slice_hash ~ '^[0-9a-f]{64}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE task_review_attempts ADD CONSTRAINT task_review_attempts_review_slice_nonempty_array
    CHECK (jsonb_typeof(review_slice) = 'array' AND jsonb_array_length(review_slice) > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE task_review_attempts ADD CONSTRAINT task_review_attempts_review_slice_schema
    CHECK (task_review_slice_matches_version(review_slice_version, review_slice)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE task_review_attempts ADD CONSTRAINT task_review_attempts_implementation_receipt_hash_sha256
    CHECK (implementation_receipt_hash ~ '^[0-9a-f]{64}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE task_review_attempts
  VALIDATE CONSTRAINT task_review_attempts_review_slice_version_supported,
  VALIDATE CONSTRAINT task_review_attempts_review_slice_hash_sha256,
  VALIDATE CONSTRAINT task_review_attempts_review_slice_nonempty_array,
  VALIDATE CONSTRAINT task_review_attempts_review_slice_schema,
  VALIDATE CONSTRAINT task_review_attempts_implementation_receipt_hash_sha256;

UPDATE tasks SET max_retries = 3 WHERE max_retries IS NULL;
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_max_retries_bounded
    CHECK (max_retries BETWEEN 1 AND 10) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE tasks
  ALTER COLUMN max_retries SET DEFAULT 3,
  ALTER COLUMN max_retries SET NOT NULL,
  VALIDATE CONSTRAINT tasks_max_retries_bounded;

COMMENT ON COLUMN task_review_attempts.review_slice_version IS
  'Review-slice schema identity: v0 synthetic legacy marker, v1 canonical reviewed-subtask records.';
COMMENT ON COLUMN task_review_attempts.review_slice_hash IS
  'SHA-256 identity of the immutable versioned review slice.';
COMMENT ON COLUMN task_review_attempts.review_slice IS
  'Immutable versioned review slice bound to this attempt.';
COMMENT ON COLUMN task_review_attempts.implementation_receipt_hash IS
  'SHA-256 identity of implementation evidence bound to this attempt.';
