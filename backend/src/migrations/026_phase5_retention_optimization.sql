-- Migration: 026_phase5_retention_optimization.sql
-- Phase 5: Retention policy, optimization indexes, materialized views
--
-- 2026-07-04 (task 475a54c9): wrapped in a conditional DO block. This
-- migration was written against the LEGACY sessions/session_messages tables
-- (created out-of-band by database/migrations/021_sessions_table.sql, which
-- migrate.ts never read). On a from-scratch replay those tables do not exist
-- until 033_sessions_redesign.sql, so this file now no-ops safely when its
-- targets are absent. In normal operation it is baseline-stamped and never
-- executed (see BASELINE). Original statements preserved inside EXECUTE.

DO $mig026$
BEGIN
  IF to_regclass('public.sessions') IS NULL
     OR to_regclass('public.session_messages') IS NULL THEN
    RAISE NOTICE 'Migration 026: sessions/session_messages not present (pre-033 replay) — no-op.';
    RETURN;
  END IF;

  -- 1. Add retention-related columns to sessions table
  EXECUTE $sql$
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS backfilled BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS messages_purged BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS messages_purged_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS retention_summary JSONB DEFAULT NULL
  $sql$;

  EXECUTE $sql$ COMMENT ON COLUMN sessions.backfilled IS 'True when messages were bulk-ingested from historical JSONL' $sql$;
  EXECUTE $sql$ COMMENT ON COLUMN sessions.messages_purged IS 'True when message content was purged per retention policy' $sql$;
  EXECUTE $sql$ COMMENT ON COLUMN sessions.retention_summary IS 'Summary preserved after message purge: first/last 5 messages + token totals' $sql$;

  -- 2. BRIN index on created_at for time-range queries
  EXECUTE $sql$ DROP INDEX IF EXISTS idx_session_messages_created_at $sql$;
  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_session_messages_created_at_brin
      ON session_messages USING BRIN (created_at)
      WITH (pages_per_range = 128)
  $sql$;
  EXECUTE $sql$
    COMMENT ON INDEX idx_session_messages_created_at_brin
      IS 'BRIN index for time-range queries on append-only session_messages. Replaces B-tree.'
  $sql$;

  -- 3. Partitioning readiness view
  EXECUTE $sql$
    CREATE OR REPLACE VIEW session_messages_row_count AS
    SELECT
      s.relname AS table_name,
      n_live_tup AS estimated_row_count,
      pg_size_pretty(pg_total_relation_size(t.oid)) AS total_size,
      CASE
        WHEN n_live_tup > 1000000 THEN 'PARTITION_RECOMMENDED'
        ELSE 'OK'
      END AS partition_recommendation
    FROM pg_stat_user_tables s
    JOIN pg_class t ON t.relname = s.relname AND t.relkind = 'r'
    WHERE s.relname = 'session_messages'
  $sql$;

  -- 4. Materialized view: session summary statistics
  EXECUTE $sql$ DROP MATERIALIZED VIEW IF EXISTS session_summary_stats $sql$;

  EXECUTE $sql$
    CREATE MATERIALIZED VIEW session_summary_stats AS
    SELECT
      s.id                                          AS session_id,
      s.session_key,
      s.label,
      s.model,
      s.kind,
      s.status,
      s.started_at,
      s.ended_at,
      s.last_activity_at,
      s.message_count,
      s.tool_call_count,
      s.input_tokens,
      s.output_tokens,
      s.thinking_tokens,
      s.total_cost_usd,
      EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_activity_at) - s.started_at))::INTEGER AS duration_seconds,
      COUNT(m.id) AS stored_message_count,
      COUNT(m.id) FILTER (WHERE m.role = 'tool') AS tool_result_count,
      COUNT(m.id) FILTER (WHERE m.role = 'assistant') AS assistant_message_count,
      COUNT(m.id) FILTER (WHERE m.role = 'user') AS user_message_count,
      ROUND(AVG(m.tokens_out) FILTER (WHERE m.role = 'assistant'))::INTEGER AS avg_tokens_per_reply,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.metadata->>'model'), NULL) AS models_used,
      s.backfilled,
      s.messages_purged,
      s.created_at
    FROM sessions s
    LEFT JOIN session_messages m ON m.session_id = s.id
    GROUP BY
      s.id, s.session_key, s.label, s.model, s.kind, s.status,
      s.started_at, s.ended_at, s.last_activity_at,
      s.message_count, s.tool_call_count,
      s.input_tokens, s.output_tokens, s.thinking_tokens, s.total_cost_usd,
      s.backfilled, s.messages_purged, s.created_at
  $sql$;

  EXECUTE $sql$ CREATE UNIQUE INDEX IF NOT EXISTS idx_sss_session_id ON session_summary_stats (session_id) $sql$;
  EXECUTE $sql$ CREATE INDEX IF NOT EXISTS idx_sss_session_key ON session_summary_stats (session_key) $sql$;
  EXECUTE $sql$ CREATE INDEX IF NOT EXISTS idx_sss_model ON session_summary_stats (model) $sql$;
  EXECUTE $sql$ CREATE INDEX IF NOT EXISTS idx_sss_kind ON session_summary_stats (kind) $sql$;
  EXECUTE $sql$ CREATE INDEX IF NOT EXISTS idx_sss_started_at ON session_summary_stats (started_at DESC) $sql$;

  EXECUTE $sql$
    COMMENT ON MATERIALIZED VIEW session_summary_stats
      IS 'Pre-computed session stats. Refresh via: REFRESH MATERIALIZED VIEW CONCURRENTLY session_summary_stats'
  $sql$;

  -- 5. Aggregate stats view
  EXECUTE $sql$
    CREATE OR REPLACE VIEW session_aggregate_stats AS
    SELECT
      COUNT(*) AS total_sessions,
      COUNT(*) FILTER (WHERE status = 'running') AS active_sessions,
      SUM(message_count) AS total_messages,
      SUM(tool_call_count) AS total_tool_calls,
      SUM(input_tokens + output_tokens + thinking_tokens) AS total_tokens,
      SUM(total_cost_usd) AS total_cost_usd,
      MIN(started_at) AS oldest_session,
      MAX(last_activity_at) AS newest_session,
      COUNT(*) FILTER (WHERE backfilled = TRUE) AS backfilled_sessions,
      COUNT(*) FILTER (WHERE messages_purged = TRUE) AS purged_sessions
    FROM sessions
  $sql$;
END
$mig026$;
