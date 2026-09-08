-- Migration 031: Add acp_session_key field to tasks table
-- Supports interactive ACP agent spawning (Phase 2: ACP integration)
-- acp_session_key stores the OpenClaw ACP session key for tasks spawned with --interactive

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS acp_session_key VARCHAR(255);

-- Index for fast lookup when SubAgentTaskUpdater checks session completions
CREATE INDEX IF NOT EXISTS idx_tasks_acp_session_key
  ON tasks(acp_session_key)
  WHERE acp_session_key IS NOT NULL;

-- Also extend executionMode to allow 'interactive' value
-- (The CHECK constraint on execution_mode is handled in application code; no DB enum to update)

COMMENT ON COLUMN tasks.acp_session_key IS
  'OpenClaw ACP session key for interactive agent sessions (set when executionMode=interactive)';
