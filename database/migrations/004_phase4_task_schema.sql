-- Phase 4: Enhanced Task Schema
-- Migration 004: Add new columns for Work Orchestration System
-- Date: 2026-01-30

-- Add new status values ('ideas', 'stuck', 'completed' instead of 'blocked', 'done')
-- Note: PostgreSQL doesn't easily allow ALTER TYPE, so we'll keep status as VARCHAR

-- Add new columns to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_created BOOLEAN DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_start BOOLEAN DEFAULT TRUE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_checked TIMESTAMP WITH TIME ZONE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS session_refs JSONB DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS links JSONB DEFAULT '[]';

-- Update subtasks column to store objects instead of just IDs
-- Old: subtasks JSONB DEFAULT '[]' (array of strings)
-- New: subtasks JSONB DEFAULT '[]' (array of {id, text, completed, completedAt, sessionRef})
-- This is backward compatible - we just store richer data now

-- Add index for auto_start queries (agents checking for tasks to pick up)
CREATE INDEX IF NOT EXISTS idx_tasks_auto_start ON tasks(auto_start, status) WHERE auto_start = TRUE AND status = 'todo';

-- Add index for session_refs (JSONB GIN index for containment queries)
CREATE INDEX IF NOT EXISTS idx_tasks_session_refs ON tasks USING GIN (session_refs);

-- Add index for links (JSONB GIN index)
CREATE INDEX IF NOT EXISTS idx_tasks_links ON tasks USING GIN (links);

-- Update existing tasks to have default values
UPDATE tasks SET auto_created = FALSE WHERE auto_created IS NULL;
UPDATE tasks SET auto_start = TRUE WHERE auto_start IS NULL AND status != 'ideas';
UPDATE tasks SET auto_start = FALSE WHERE auto_start IS NULL AND status = 'ideas';
UPDATE tasks SET session_refs = '[]' WHERE session_refs IS NULL;
UPDATE tasks SET links = '[]' WHERE links IS NULL;

-- Migrate old 'blocked' status to 'stuck'
UPDATE tasks SET status = 'stuck' WHERE status = 'blocked';

-- Migrate old 'done' status to 'completed'
UPDATE tasks SET status = 'completed' WHERE status = 'done';

-- Set completed_at for existing completed tasks if not already set
UPDATE tasks 
SET completed_at = updated_at 
WHERE status = 'completed' AND completed_at IS NULL;

-- Set archived_at for existing archived tasks if not already set
UPDATE tasks 
SET archived_at = updated_at 
WHERE status = 'archived' AND archived_at IS NULL;

-- Migration complete
SELECT 'Phase 4 task schema migration complete' AS status;
