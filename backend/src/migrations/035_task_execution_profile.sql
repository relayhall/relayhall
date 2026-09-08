-- Migration 035: Add execution_profile JSONB to tasks
-- Stores structured spawn/access policy for tasks while keeping legacy fields
-- (execution_mode, tags, model, etc.) for backward compatibility during rollout.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS execution_profile JSONB;

CREATE INDEX IF NOT EXISTS idx_tasks_execution_profile
  ON tasks USING GIN (execution_profile)
  WHERE execution_profile IS NOT NULL;

COMMENT ON COLUMN tasks.execution_profile IS
  'Structured execution profile for agent spawn policy: mode, accessProfile, requiredCapabilities, override rules, notes.';
