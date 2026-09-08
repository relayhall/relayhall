-- Migration 032: Add discord_thread_id field to tasks table
-- Supports Phase 3: Discord thread auto-creation for interactive tasks
-- discord_thread_id stores the Discord thread ID for interactive agent sessions

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS discord_thread_id VARCHAR(255);

-- Index for fast lookup by thread ID (used when routing Discord messages to tasks)
CREATE INDEX IF NOT EXISTS idx_tasks_discord_thread_id
  ON tasks(discord_thread_id)
  WHERE discord_thread_id IS NOT NULL;

COMMENT ON COLUMN tasks.discord_thread_id IS
  'Discord thread ID created for interactive agent sessions (Phase 3: thread auto-creation)';
