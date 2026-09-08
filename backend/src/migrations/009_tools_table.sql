-- Migration 009: Create tools table for Tools Management System
-- Phase 2: Backend & DB Migration

-- Tools registry table
CREATE TABLE IF NOT EXISTS tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    category VARCHAR(100),
    description TEXT,
    usage_instructions TEXT,
    config JSONB DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    is_global BOOLEAN DEFAULT FALSE,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name);
CREATE INDEX IF NOT EXISTS idx_tools_category ON tools(category);
CREATE INDEX IF NOT EXISTS idx_tools_tags ON tools USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_tools_is_global ON tools(is_global);

-- Comments
COMMENT ON TABLE tools IS 'Registry of tools available to agents and projects';
COMMENT ON COLUMN tools.config IS 'JSONB config - encrypted at app level for sensitive values';
COMMENT ON COLUMN tools.tags IS 'Array of tags for filtering and categorization';
COMMENT ON COLUMN tools.is_global IS 'Global tools are available to all projects';
COMMENT ON COLUMN tools.version IS 'Auto-incremented on each update';

SELECT 'Tools table migration complete' AS status;
