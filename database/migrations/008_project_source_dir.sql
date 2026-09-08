-- Migration 008: Add source_dir to projects
-- For context API to read project source trees
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_dir VARCHAR(255);

SELECT 'source_dir column added to projects' AS status;
