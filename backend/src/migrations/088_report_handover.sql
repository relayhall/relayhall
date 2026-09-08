-- Migration 088: optional structured handover on Report (RH-P2.9).
--
-- The application owns the bounded v1 schema. The database enforces the
-- durable top-level invariant so direct writers cannot store a scalar or
-- array where every REST/CLI/MCP/Brief consumer expects an object.

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS handover JSONB;

ALTER TABLE reports
  DROP CONSTRAINT IF EXISTS reports_handover_object_check;

ALTER TABLE reports
  ADD CONSTRAINT reports_handover_object_check
  CHECK (handover IS NULL OR jsonb_typeof(handover) = 'object');

COMMENT ON COLUMN reports.handover IS
  'Optional normalized v1 handover: decisions, assumptions, alternatives_rejected, unresolved_questions.';
