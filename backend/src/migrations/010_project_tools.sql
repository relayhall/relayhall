-- Migration 010: Create project_tools junction table
-- Links tools to projects with optional override instructions

CREATE TABLE IF NOT EXISTS project_tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    override_instructions TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, tool_id)
);

-- Indexes for lookups
CREATE INDEX IF NOT EXISTS idx_project_tools_project_id ON project_tools(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tools_tool_id ON project_tools(tool_id);

COMMENT ON TABLE project_tools IS 'Junction table linking tools to projects with optional instruction overrides';
COMMENT ON COLUMN project_tools.override_instructions IS 'When set, replaces the tool base usage_instructions for this project';

SELECT 'Project tools junction table migration complete' AS status;
