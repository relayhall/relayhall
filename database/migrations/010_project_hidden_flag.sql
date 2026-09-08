-- Project Lifecycle Management: Add hidden flag
-- Migration 010: Add is_hidden column to projects table
-- Date: 2026-02-07
-- Task: e2fd9efa-9326-48ab-a2fc-19eb4f430f20

-- Add hidden flag to projects (separate from archive status)
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Create index for filtering hidden projects
CREATE INDEX IF NOT EXISTS idx_projects_is_hidden ON projects(is_hidden);

-- Update status constraint to include 'paused' (referenced in TypeScript but not in DB)
ALTER TABLE projects 
DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE projects 
ADD CONSTRAINT projects_status_check 
CHECK (status IN ('active', 'paused', 'archived', 'completed'));

-- Migration complete
SELECT 'Project hidden flag migration complete' AS status;
