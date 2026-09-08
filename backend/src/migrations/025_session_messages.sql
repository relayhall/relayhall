-- Migration: 025_session_messages.sql
-- Session messages table for storing agent/user message history and tool calls
-- Designed for high write throughput with appropriate indexes

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Session messages table
CREATE TABLE IF NOT EXISTS session_messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID NOT NULL,
  session_key     VARCHAR(255),
  ordinal         INTEGER,
  role            VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         TEXT,
  tool_name       VARCHAR(100),
  tool_call_id    VARCHAR(100),
  thinking        TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB
);

-- Index: ordered message retrieval by session
CREATE INDEX IF NOT EXISTS idx_session_messages_session_ordinal
  ON session_messages (session_id, ordinal);

-- Index: direct lookup by session_key (avoids join)
CREATE INDEX IF NOT EXISTS idx_session_messages_session_key
  ON session_messages (session_key);

-- Index: recent messages across all sessions
CREATE INDEX IF NOT EXISTS idx_session_messages_created_at
  ON session_messages (created_at DESC);

-- Partial index: tool call queries only
CREATE INDEX IF NOT EXISTS idx_session_messages_tool_role
  ON session_messages (session_id, created_at)
  WHERE role = 'tool';

COMMENT ON TABLE session_messages IS 'Stores agent/user messages and tool calls per session. Designed for high write throughput.';
COMMENT ON COLUMN session_messages.session_key IS 'Denormalized session key for fast lookup without join';
COMMENT ON COLUMN session_messages.ordinal IS 'Message order within session';
COMMENT ON COLUMN session_messages.tool_call_id IS 'Correlates tool calls with their results';
COMMENT ON COLUMN session_messages.thinking IS 'Extended thinking content (Claude extended thinking)';
COMMENT ON COLUMN session_messages.metadata IS 'Flexible JSONB: model, cache hits, finish_reason, etc.';
