-- 038_task_reviewer_fields.sql
-- Stores reviewer inputs/history needed by the automated QA gate.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS success_criteria JSONB,
  ADD COLUMN IF NOT EXISTS review_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3
    CHECK (max_retries BETWEEN 1 AND 10);

COMMENT ON COLUMN tasks.success_criteria IS
  'Explicit automated reviewer success criteria / acceptance checklist. Supports string or array payloads.';

COMMENT ON COLUMN tasks.review_history IS
  'Structured automated reviewer audit trail including findings, evidence, and pass/reject/escalate outcomes.';

COMMENT ON COLUMN tasks.max_retries IS
  'Maximum automated reviewer rejection cycles before escalating to a human/operator.';
