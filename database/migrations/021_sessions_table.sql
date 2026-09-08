-- Migration 021: Sessions metadata table
-- Indexes session transcripts for fast search and analytics

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_key VARCHAR(255) UNIQUE,
    label VARCHAR(255),
    model VARCHAR(100),
    kind VARCHAR(50) DEFAULT 'main' CHECK (kind IN ('main', 'subagent', 'isolated', 'heartbeat', 'unknown')),
    status VARCHAR(50) DEFAULT 'unknown' CHECK (status IN ('running', 'completed', 'failed', 'idle', 'unknown')),
    parent_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens BIGINT DEFAULT 0,
    output_tokens BIGINT DEFAULT 0,
    thinking_tokens BIGINT DEFAULT 0,
    cache_read_tokens BIGINT DEFAULT 0,
    total_cost_usd NUMERIC(10,6) DEFAULT 0,
    transcript_path VARCHAR(500),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_sessions_session_key ON sessions(session_key);
CREATE INDEX idx_sessions_kind ON sessions(kind);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_model ON sessions(model);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at DESC);
CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX idx_sessions_task_id ON sessions(task_id);
CREATE INDEX idx_sessions_label ON sessions(label);

CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE sessions IS 'Session metadata indexed from JSONL transcripts';
