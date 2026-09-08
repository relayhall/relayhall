-- =============================================================================
-- Migration 034: Agent Types table + agentType fields on tasks + sessions
-- =============================================================================
--
-- Adds a first-class agent_types entity that stores persona definitions
-- from the agency-agents repository. Tasks and sessions can optionally
-- reference an agent type.
-- =============================================================================

-- Agent types table (synced from markdown repo files on startup)
CREATE TABLE IF NOT EXISTS agent_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(128) UNIQUE NOT NULL,   -- e.g. "engineering-backend-architect"
  name        VARCHAR(256) NOT NULL,           -- e.g. "Backend Architect"
  description TEXT,
  category    VARCHAR(64),                     -- e.g. "engineering"
  color       VARCHAR(32),                     -- e.g. "blue"
  content     TEXT,                            -- full markdown content of persona file
  source_file VARCHAR(512),                    -- relative path in agency-agents repo
  is_custom   BOOLEAN NOT NULL DEFAULT false,  -- true for deployment-defined entries
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add agentType to tasks table
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS agent_type_id UUID REFERENCES agent_types(id) ON DELETE SET NULL;

-- Add agentType to sessions table
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS agent_type_id UUID REFERENCES agent_types(id) ON DELETE SET NULL;

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_tasks_agent_type_id    ON tasks(agent_type_id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_type_id ON sessions(agent_type_id);
CREATE INDEX IF NOT EXISTS idx_agent_types_slug        ON agent_types(slug);
CREATE INDEX IF NOT EXISTS idx_agent_types_category    ON agent_types(category);
