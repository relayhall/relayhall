-- Migration 036: Add long-form prompt metadata to tasks
-- Stores explicit definition-of-done and constraints so prompt generation can round-trip
-- them through the PostgreSQL-backed task model.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS definition_of_done JSONB,
  ADD COLUMN IF NOT EXISTS constraints JSONB;

COMMENT ON COLUMN tasks.definition_of_done IS
  'Explicit definition of done / acceptance criteria for agent prompts. Supports string or array payloads.';

COMMENT ON COLUMN tasks.constraints IS
  'Explicit task constraints / guardrails for agent prompts. Supports string or array payloads.';
