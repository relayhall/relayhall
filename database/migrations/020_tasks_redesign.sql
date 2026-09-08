-- Migration 020: Tasks Schema Redesign
-- Replaces flat tasks.json structure with proper relational schema
-- Design only - backend code changes required separately

-- ============================================================================
-- PHASE 1: Drop existing constraints and tables that will be replaced
-- ============================================================================

-- Drop existing tasks table and recreate with new schema
-- task_history will be preserved and reconnected
DROP TABLE IF EXISTS tasks CASCADE;

-- ============================================================================
-- PHASE 2: Create new relational schema
-- ============================================================================

-- -----------------------------------------------------------------------------
-- tasks: Main task table
-- -----------------------------------------------------------------------------
-- Core task entity with metadata, status tracking, and execution configuration
-- Replaces tasks.json top-level task objects
-- Links to projects table for project context
CREATE TABLE tasks (
    -- Identity
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    
    -- Status & Priority
    status VARCHAR(50) NOT NULL DEFAULT 'todo' 
        CHECK (status IN ('ideas', 'todo', 'in-progress', 'stuck', 'review', 'completed', 'archived')),
    priority VARCHAR(50) DEFAULT 'normal'
        CHECK (priority IN ('urgent', 'high', 'normal', 'low', 'someday')),
    
    -- Project relationship
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    
    -- Execution configuration
    thinking_budget VARCHAR(20) DEFAULT 'medium'
        CHECK (thinking_budget IN ('low', 'medium', 'high', 'extended')),
    thinking_auto_estimated BOOLEAN DEFAULT false,
    model VARCHAR(100),  -- e.g., 'anthropic/claude-opus-4-5'
    execution_mode VARCHAR(50),  -- 'subagent', 'main', etc.
    auto_created BOOLEAN DEFAULT false,
    auto_start BOOLEAN DEFAULT true,
    
    -- Blocking & dependencies (tracked separately in task_dependencies)
    blocked_reason TEXT,  -- Why this task is stuck/blocked
    status_reason TEXT,   -- Additional context for current status
    
    -- Agent tracking
    active_agent VARCHAR(100),  -- Which agent is currently working on this
    completed_by VARCHAR(100),  -- Which agent/user completed this
    attempt_count INTEGER DEFAULT 0,  -- Number of execution attempts
    
    -- References to external context
    session_refs JSONB DEFAULT '[]'::jsonb,  -- Session IDs related to this task
    parent_id UUID,  -- For subtask relationship (if hierarchical tasks are needed)
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    archived_at TIMESTAMP WITH TIME ZONE,
    last_checked TIMESTAMP WITH TIME ZONE  -- For periodic health checks
);

-- Indexes for common queries
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX idx_tasks_auto_start ON tasks(auto_start, status) 
    WHERE auto_start = true AND status = 'todo';
CREATE INDEX idx_tasks_session_refs ON tasks USING GIN(session_refs);

-- Trigger for updated_at
CREATE TRIGGER update_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- -----------------------------------------------------------------------------
-- subtasks: Task breakdown into actionable steps
-- -----------------------------------------------------------------------------
-- Ordered list of subtasks for each task
-- Replaces tasks.json subtasks array
CREATE TABLE subtasks (
    id SERIAL PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    index INTEGER NOT NULL,  -- Order within the task (0-based)
    title TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'in_review', 'completed')),
    note TEXT,  -- Optional note/context for this subtask
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Ensure unique ordering within each task
    UNIQUE(task_id, index)
);

-- Indexes for subtask queries
CREATE INDEX idx_subtasks_task_id ON subtasks(task_id);
CREATE INDEX idx_subtasks_status ON subtasks(status);

-- Trigger for updated_at
CREATE TRIGGER update_subtasks_updated_at
    BEFORE UPDATE ON subtasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- -----------------------------------------------------------------------------
-- task_tags: Many-to-many relationship between tasks and tags
-- -----------------------------------------------------------------------------
-- Replaces tasks.json tags array
-- Enables efficient filtering by tag and tag analytics
CREATE TABLE task_tags (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag VARCHAR(100) NOT NULL,
    
    PRIMARY KEY (task_id, tag)
);

-- Index for filtering by tag
CREATE INDEX idx_task_tags_tag ON task_tags(tag);

-- -----------------------------------------------------------------------------
-- task_dependencies: Task dependency graph
-- -----------------------------------------------------------------------------
-- Replaces tasks.json blockedBy and dependsOn arrays
-- Enables dependency resolution and cycle detection
CREATE TABLE task_dependencies (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    
    PRIMARY KEY (task_id, depends_on_task_id),
    
    -- Prevent self-dependencies
    CHECK (task_id != depends_on_task_id)
);

-- Indexes for dependency queries
CREATE INDEX idx_task_dependencies_task_id ON task_dependencies(task_id);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);

-- -----------------------------------------------------------------------------
-- task_links: External links related to tasks
-- -----------------------------------------------------------------------------
-- Replaces tasks.json links array
-- Stores references to git repos, docs, issues, etc.
CREATE TABLE task_links (
    id SERIAL PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,  -- 'git', 'docs', 'issue', 'pr', etc.
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for querying links by task
CREATE INDEX idx_task_links_task_id ON task_links(task_id);

-- ============================================================================
-- PHASE 3: Reconnect task_history to new tasks table
-- ============================================================================

-- task_history table already exists and has good structure
-- Just need to ensure FK constraint is recreated
ALTER TABLE task_history
    ADD CONSTRAINT task_history_task_id_fkey 
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;

-- ============================================================================
-- SCHEMA OVERVIEW
-- ============================================================================

-- tasks (1) ──> (many) subtasks
--   │
--   ├──> (many) task_tags ──> tags (implicit via VARCHAR)
--   ├──> (many) task_dependencies ──> tasks (self-reference)
--   ├──> (many) task_links
--   ├──> (many) task_history (audit trail)
--   └──> (1) projects (optional)

-- This schema enables:
-- 1. Efficient querying by status, priority, project, tags
-- 2. Dependency tracking and cycle detection
-- 3. Full audit history via task_history
-- 4. Subtask progress tracking
-- 5. Link management for external resources
-- 6. Execution metadata for agent orchestration

COMMENT ON TABLE tasks IS 'Main task table - replaces tasks.json structure';
COMMENT ON TABLE subtasks IS 'Task breakdown into ordered steps';
COMMENT ON TABLE task_tags IS 'Many-to-many task-tag relationships';
COMMENT ON TABLE task_dependencies IS 'Task dependency graph (task depends on other tasks)';
COMMENT ON TABLE task_links IS 'External links related to tasks (git, docs, etc.)';

COMMENT ON COLUMN tasks.thinking_budget IS 'AI thinking level: low, medium, high, extended';
COMMENT ON COLUMN tasks.execution_mode IS 'How task should be executed: subagent, main, etc.';
COMMENT ON COLUMN tasks.session_refs IS 'JSONB array of session IDs related to this task';
COMMENT ON COLUMN tasks.blocked_reason IS 'Why this task is currently blocked/stuck';
COMMENT ON COLUMN subtasks.index IS 'Zero-based ordering of subtasks within parent task';
COMMENT ON COLUMN task_dependencies.depends_on_task_id IS 'Task A depends on Task B means A cannot start until B is completed';
