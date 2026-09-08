-- 054_task_notification_payload.sql
-- Forward repair for receipt-backed task notifications. CREATE IF NOT EXISTS
-- intentionally repairs historical ledgers where 052 was recorded but its table
-- was absent; the payload stores only the minimal non-secret retry material.

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

ALTER TABLE task_notification_deliveries
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE task_notification_deliveries
  DROP CONSTRAINT IF EXISTS task_notification_deliveries_payload_object;
ALTER TABLE task_notification_deliveries
  ADD CONSTRAINT task_notification_deliveries_payload_object
  CHECK (jsonb_typeof(payload) = 'object');

CREATE INDEX IF NOT EXISTS idx_task_notification_deliveries_retry
  ON task_notification_deliveries(status, next_attempt_at);
