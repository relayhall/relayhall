-- Migration 008: Add category column to project_links
-- Phase 5 Fix: Link categories were not being persisted

-- Add category column to project_links table
ALTER TABLE project_links ADD COLUMN IF NOT EXISTS category VARCHAR(50);

-- Add check constraint for valid categories
-- Categories: repository, environment, documentation, research, reference, tool
ALTER TABLE project_links DROP CONSTRAINT IF EXISTS project_links_category_check;
ALTER TABLE project_links ADD CONSTRAINT project_links_category_check 
    CHECK (category IS NULL OR category IN ('repository', 'environment', 'documentation', 'research', 'reference', 'tool'));

-- Update type constraint to include all valid types (project, dashboard, notebooklm, file)
ALTER TABLE project_links DROP CONSTRAINT IF EXISTS project_links_type_check;
ALTER TABLE project_links ADD CONSTRAINT project_links_type_check 
    CHECK (type IN ('git', 'doc', 'url', 'api', 'project', 'dashboard', 'notebooklm', 'file'));

-- Create index on category for filtering
CREATE INDEX IF NOT EXISTS idx_project_links_category ON project_links(category);

-- Add comment for documentation
COMMENT ON COLUMN project_links.category IS 'Link category: repository, environment, documentation, research, reference, tool';

SELECT 'Link categories migration complete' AS status;
