-- 161_mcp_action_log.sql — the per-session MCP action log (card ab8f78e9;
-- owner rulings E91 and E89 (c)). Reserved in backend/src/migrations/RESERVED
-- as slot 161 in the same commit as this file (ruling 0464ad54 section 2).
--
-- One row = one ADMITTED MCP tools/call made inside a live MCP-derived session
-- (card 35b73092): which tool ran, which object it named, how it ended, how
-- long the handler took and when. NEVER its arguments or any free text: the
-- table has no column that could hold either, and every text column is held
-- to a closed vocabulary or a fixed grammar by a CHECK below.
--
--   session_ref   the session's pseudonym, the same value its envelope rows in
--                 session_events carry (the telemetry pseudonym grammar).
--   connector_id  the Connector the session belongs to, and
--   account_id    the Account it was written under, and
--   agent_id      the Agent, when the caller is a Connector-descended Agent —
--                 all three exactly as the session's own envelope rows carry
--                 them (derived from the caller's authenticated chain).
--   tool_name     the registry name of the tool (the writer admits only names
--                 the MCP registry holds; this CHECK holds the grammar).
--   target_type   one of five object kinds, read from ONE per-tool allowlisted
--   target_id     argument whose value is a complete UUID; both NULL when the
--                 tool or its arguments name no allowlisted object.
--   outcome       ok | error.
--   error_code    NULL for ok; for error, one closed code (never a message).
--   duration_ms   the handler's duration, 0 .. 86 400 000.
--   observed_at   when the board recorded the call.
--
-- Retention: TelemetryRetentionService sweeps this table hourly as class
-- mcp_action_log, with a receipt in session_retention_receipts, at the same
-- bound as the session's own event metadata (RELAYHALL_TELEMETRY_RETENTION_DAYS,
-- default 90 days, E89 (c)).
--
-- One table, two indexes and two comments, one implicit transaction, no COMMIT. Every
-- statement is replay-safe. database/init.sql is untouched.
CREATE TABLE IF NOT EXISTS mcp_action_log (
  id BIGSERIAL PRIMARY KEY,
  session_ref TEXT NOT NULL,
  connector_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  agent_id UUID REFERENCES principals(id) ON DELETE RESTRICT,
  tool_name TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  outcome TEXT NOT NULL,
  error_code TEXT,
  duration_ms INTEGER NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_action_log_session_ref_shape CHECK (session_ref ~ '^rhp_[A-Za-z0-9_-]{27}$'),
  CONSTRAINT mcp_action_log_tool_name_shape CHECK (tool_name ~ '^relayhall_[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT mcp_action_log_target_type_check
    CHECK (target_type IS NULL OR target_type IN ('task', 'report', 'phase', 'project', 'skill')),
  CONSTRAINT mcp_action_log_target_pair CHECK ((target_type IS NULL) = (target_id IS NULL)),
  CONSTRAINT mcp_action_log_outcome_check CHECK (outcome IN ('ok', 'error')),
  CONSTRAINT mcp_action_log_error_code_check CHECK (error_code IS NULL OR error_code IN (
    'tool_refused', 'bad_request', 'unauthenticated', 'forbidden', 'not_found', 'conflict',
    'rate_limited', 'rejected', 'unavailable', 'server_error', 'internal')),
  CONSTRAINT mcp_action_log_outcome_code_pair CHECK ((outcome = 'ok') = (error_code IS NULL)),
  CONSTRAINT mcp_action_log_duration_bound CHECK (duration_ms BETWEEN 0 AND 86400000)
);

-- The session timeline's read: one session's rows, newest first.
CREATE INDEX IF NOT EXISTS idx_mcp_action_log_session
  ON mcp_action_log (connector_id, session_ref, observed_at DESC, id DESC);
-- The retention sweep's read.
CREATE INDEX IF NOT EXISTS idx_mcp_action_log_observed
  ON mcp_action_log (observed_at);

COMMENT ON TABLE mcp_action_log IS
  'Card ab8f78e9 (E91, E89 (c)): one row per admitted MCP tools/call inside a live MCP-derived session — tool, allowlisted target, outcome with a closed code, duration, time. Never arguments or free text. Swept with a receipt as class mcp_action_log at the telemetry event retention bound (default 90 days).';
COMMENT ON COLUMN mcp_action_log.target_id IS
  'Read only from the per-tool allowlisted argument (McpActionLog.MCP_ACTION_TARGET_ARGUMENTS) and only when it is a complete UUID; NULL otherwise.';
