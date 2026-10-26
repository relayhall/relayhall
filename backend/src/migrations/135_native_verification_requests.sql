-- Same-Task verification, separate from implementation assignment/claim.
-- No registry rows, credentials, grants or descriptor publications are seeded.
CREATE TABLE IF NOT EXISTS task_native_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id),
  descriptor_version INTEGER NOT NULL,
  verifier_principal_id UUID NOT NULL REFERENCES principals(id),
  requested_by_principal_id UUID NOT NULL REFERENCES principals(id),
  request_key UUID NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'verification' CHECK (purpose = 'verification'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','attested','passed','rejected','uncertain','expired','cancelled')),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  review_scope JSONB NOT NULL,
  criteria JSONB NOT NULL CHECK (jsonb_typeof(criteria) = 'array'),
  report_ids UUID[] NOT NULL,
  lease_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  request_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  review_attempt_id UUID REFERENCES task_review_attempts(id),
  verdict JSONB,
  reconciliation JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  session_expires_at TIMESTAMPTZ,
  FOREIGN KEY(service_id, descriptor_version) REFERENCES service_descriptor_versions(service_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_native_reviews_one_active
  ON task_native_reviews(task_id) WHERE state IN ('pending','leased','attested');
CREATE INDEX IF NOT EXISTS task_native_reviews_pull ON task_native_reviews(service_id, state, created_at);

-- No raw provider IDs, prompts or provider output in the correlation plane.
CREATE TABLE IF NOT EXISTS task_native_review_sessions (
  review_id UUID NOT NULL REFERENCES task_native_reviews(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES principals(id),
  account_id UUID NOT NULL REFERENCES principals(id),
  source_product TEXT NOT NULL,
  session_ref TEXT NOT NULL CHECK (session_ref ~ '^rhp_'),
  pepper_id TEXT NOT NULL,
  attested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(review_id, pepper_id)
);

-- Inserts are protected by the Task FK's key-share lock. Existing child
-- updates/deletes of these child rows serialize with the Task
-- review transaction. Report targets use migration 134; arbitrary reference
-- targets are not locked or treated as bound Report evidence. Nonblocking locks avoid inverse child/Task deadlocks.
CREATE OR REPLACE FUNCTION lock_native_review_task_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_uuid UUID;
BEGIN
  FOR task_uuid IN SELECT DISTINCT value FROM unnest(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.task_id ELSE NULL END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.task_id ELSE NULL END]) value WHERE value IS NOT NULL ORDER BY value
  LOOP
    IF NOT pg_try_advisory_xact_lock_shared(1397653301, hashtext(task_uuid::text)) THEN
      RAISE EXCEPTION 'Task review evidence is busy' USING ERRCODE = 'PZ001';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS native_review_input_lock ON subtasks;
CREATE TRIGGER native_review_input_lock BEFORE INSERT OR UPDATE OR DELETE ON subtasks
  FOR EACH ROW EXECUTE FUNCTION lock_native_review_task_input();
DROP TRIGGER IF EXISTS native_review_input_lock ON task_references;
CREATE TRIGGER native_review_input_lock BEFORE INSERT OR UPDATE OR DELETE ON task_references
  FOR EACH ROW EXECUTE FUNCTION lock_native_review_task_input();
DROP TRIGGER IF EXISTS native_review_input_lock ON task_dependencies;
CREATE TRIGGER native_review_input_lock BEFORE INSERT OR UPDATE OR DELETE ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION lock_native_review_task_input();

-- Native scope v3 leaves legacy v0/v1/v2 meanings unchanged.
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
    WHEN slice_version = 2 THEN jsonb_array_length(slice) = 1 AND COALESCE(bool_and(
      item ?& ARRAY['kind','taskId','taskSnapshotUpdatedAt','evidenceReceipt','reportDigest']
      AND item->>'kind' = 'flat_task_review'
      AND (item->>'evidenceReceipt') ~ '^[0-9a-f]{64}$'
      AND (item->>'reportDigest') ~ '^[0-9a-f]{64}$'
    ), FALSE)
    WHEN slice_version = 3 THEN jsonb_array_length(slice) = 1 AND COALESCE(bool_and(
      item->>'kind' = 'native_review'
      AND item ?& ARRAY['scope','subtaskDigest','reportDigest']
      AND (item->>'subtaskDigest') ~ '^[0-9a-f]{64}$'
      AND (item->>'reportDigest') ~ '^[0-9a-f]{64}$'
      AND item->'scope'->>'kind' IN ('task_final','subtask_slice','terminal_slice_and_task')
      AND jsonb_typeof(item->'scope'->'subtaskIds') = 'array'
      AND item->'scope'->>'includesTaskCriteria' = CASE WHEN item->'scope'->>'kind' = 'subtask_slice' THEN 'false' ELSE 'true' END
    ), FALSE)
    ELSE FALSE
  END
  FROM jsonb_array_elements(slice) AS elements(item)
$$;

ALTER TABLE task_review_attempts
  DROP CONSTRAINT IF EXISTS task_review_attempts_review_slice_version_check;
ALTER TABLE task_review_attempts
  ADD CONSTRAINT task_review_attempts_review_slice_version_check
    CHECK (review_slice_version IN (0, 1, 2, 3)) NOT VALID;
ALTER TABLE task_review_attempts
  DROP CONSTRAINT IF EXISTS task_review_attempts_review_slice_version_supported;
ALTER TABLE task_review_attempts
  ADD CONSTRAINT task_review_attempts_review_slice_version_supported
    CHECK (review_slice_version IN (0, 1, 2, 3)) NOT VALID;
ALTER TABLE task_review_attempts
  VALIDATE CONSTRAINT task_review_attempts_review_slice_version_check,
  VALIDATE CONSTRAINT task_review_attempts_review_slice_version_supported,
  VALIDATE CONSTRAINT task_review_attempts_review_slice_schema;
