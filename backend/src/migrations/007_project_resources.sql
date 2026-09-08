-- Migration 007: Project Resources & Tool Instructions
-- Phase 1 Hub Redesign: Structured project resources and tool instructions

-- Add resources JSONB column to projects table
-- Contains: repositories, environments, localPaths, notebooks
ALTER TABLE projects ADD COLUMN IF NOT EXISTS resources JSONB DEFAULT NULL;

-- Add tool_instructions JSONB column to projects table
-- Contains: notebookLM, filesBrowsing, gitWorkflow, testing, deployment
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tool_instructions JSONB DEFAULT NULL;

-- Create indexes for efficient JSONB queries
CREATE INDEX IF NOT EXISTS idx_projects_resources ON projects USING GIN (resources);
CREATE INDEX IF NOT EXISTS idx_projects_tool_instructions ON projects USING GIN (tool_instructions);

-- Add comment to document the structure
COMMENT ON COLUMN projects.resources IS 'Structured project resources: repositories, environments, localPaths, notebooks (JSONB)';
COMMENT ON COLUMN projects.tool_instructions IS 'Tool-specific instructions for agents: notebookLM, filesBrowsing, gitWorkflow, testing, deployment (JSONB)';

-- Example of resources structure (for documentation):
-- {
--   "repositories": {
--     "main": "https://git.example.com/...",
--     "additional": ["https://..."]
--   },
--   "environments": {
--     "production": "https://...",
--     "development": "https://...",
--     "staging": "https://..."
--   },
--   "localPaths": {
--     "nfsRoot": "/mnt/nfs/projects/...",
--     "ssdBuild": "/opt/projects/...",
--     "dockerCompose": "/path/to/docker-compose.yml"
--   },
--   "notebooks": {
--     "documentation": {
--       "id": "notebook-uuid",
--       "url": "https://notebooklm.google.com/...",
--       "description": "What this notebook contains",
--       "queryTips": ["How to ask questions..."]
--     },
--     "research": {...}
--   }
-- }

-- Example of tool_instructions structure:
-- {
--   "notebookLM": "Instructions for querying NotebookLM...",
--   "filesBrowsing": "How to navigate project files...",
--   "gitWorkflow": "Branch strategy and commit conventions...",
--   "testing": "How to run tests...",
--   "deployment": "Deployment instructions..."
-- }
