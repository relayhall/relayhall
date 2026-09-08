-- 052_hardened_orchestration.sql
-- Authoritative task claims, bounded reviewer attempts, and receipt-backed
-- notification delivery. Additive and intentionally non-destructive.

CREATE TABLE IF NOT EXISTS task_execution_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  harness TEXT NOT NULL CHECK (harness IN ('hermes', 'openclaw')),
  session_key TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired', 'failed')),
  claimed_task_updated_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  failure_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_execution_leases_active_task
  ON task_execution_leases(task_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_execution_leases_active_resource
  ON task_execution_leases(resource_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_task_execution_leases_expiry
  ON task_execution_leases(status, expires_at);

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

CREATE TABLE IF NOT EXISTS task_review_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'passed', 'rejected', 'escalated', 'timed_out', 'cancelled')),
  task_snapshot_updated_at TIMESTAMPTZ NOT NULL,
  review_slice_version SMALLINT NOT NULL DEFAULT 1
    CHECK (review_slice_version IN (0, 1)),
  review_slice_hash TEXT NOT NULL CHECK (review_slice_hash ~ '^[0-9a-f]{64}$'),
  review_slice JSONB NOT NULL
    CHECK (jsonb_typeof(review_slice) = 'array' AND jsonb_array_length(review_slice) > 0)
    CHECK (task_review_slice_matches_version(review_slice_version, review_slice)),
  implementation_receipt_hash TEXT NOT NULL
    CHECK (implementation_receipt_hash ~ '^[0-9a-f]{64}$'),
  implementation_session_key TEXT,
  reviewer_session_key TEXT,
  implementation_commit TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  verdict JSONB,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE(task_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_task_review_attempts_pending
  ON task_review_attempts(status, deadline_at);

CREATE TABLE IF NOT EXISTS task_notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  destination TEXT NOT NULL,
  transport TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  receipt JSONB,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_task_notification_deliveries_retry
  ON task_notification_deliveries(status, next_attempt_at);

COMMENT ON TABLE task_execution_leases IS
  'Authoritative compare-and-set task/worktree/resource claims for orchestration.';
COMMENT ON TABLE task_review_attempts IS
  'Immutable attempt identities and bounded independent reviewer verdicts.';
COMMENT ON TABLE task_notification_deliveries IS
  'Receipt-backed notification delivery; failures remain retryable.';
