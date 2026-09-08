-- Migration 023: Reports/Notes system
-- Markdown documents for investigation reports, audit results, progress summaries, architecture notes

CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    summary VARCHAR(500),
    tags TEXT[] DEFAULT '{}',
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    task_ids UUID[] DEFAULT '{}',
    author VARCHAR(100) DEFAULT 'nim',
    pinned BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_tags ON reports USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_reports_project_id ON reports(project_id);
CREATE INDEX IF NOT EXISTS idx_reports_pinned ON reports(pinned) WHERE pinned = true;
