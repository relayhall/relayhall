-- Migration 039: durable task timeline events for session/orchestration history

CREATE TABLE IF NOT EXISTS task_timeline_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  session_key TEXT,
  actor VARCHAR(64),
  harness VARCHAR(32),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_timeline_events_task_created
  ON task_timeline_events(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_timeline_events_session_key
  ON task_timeline_events(session_key)
  WHERE session_key IS NOT NULL;
