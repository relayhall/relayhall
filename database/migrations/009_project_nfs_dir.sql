-- Migration 009: Add nfs_dir column to projects table
-- Maps projects to NFS subdirectory for file storage
-- Date: 2026-02-01

ALTER TABLE projects ADD COLUMN IF NOT EXISTS nfs_dir VARCHAR(255);

-- Create index for lookups
CREATE INDEX IF NOT EXISTS idx_projects_nfs_dir ON projects(nfs_dir);

SELECT 'nfs_dir column added to projects' AS status;
