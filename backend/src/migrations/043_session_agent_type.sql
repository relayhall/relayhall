-- ---------------------------------------------------------------------------
-- 043_session_agent_type.sql — Persona analytics: sessions.agent_type_id
--
-- SCHEMA FINDING: sessions.agent_type_id ALREADY EXISTS — it was added by
-- 034_agent_types.sql (UUID NULL, FK to agent_types ON DELETE SET NULL,
-- idx_sessions_agent_type_id). Nothing ever WROTE to it, so it is NULL for
-- every row. The ALTER/CREATE below are defensive IF NOT EXISTS no-ops for
-- databases that somehow predate 034; the real work here is the backfill.
--
-- BACKFILL: for every session linkable to a task that has an agent type
-- (persona), copy the task's agent_type_id onto the session row.
-- Link keys considered on tasks:
--   * acp_session_key
--   * completed_by->>'sessionKey'
--   * active_agent->>'sessionKey'
--   * session_refs (jsonb array of session keys)
-- Alias expansion (mirrors runtime stamping in SessionIngester):
--   * cron:<jobId>            <-> agent:main:cron:<jobId>
--   * ...:run:<runId> children of a matched cron parent (via LIKE)
--   * hermes:<source>:<id> keys are stored literally in session_refs and
--     match directly.
-- Best-effort: only rows with agent_type_id IS NULL are touched, and when
-- several personas ran a session key the most recently updated task wins.
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_type_id UUID;
CREATE INDEX IF NOT EXISTS idx_sessions_agent_type_id ON sessions(agent_type_id);

-- Prod predates the jsonb conversion of completed_by/active_agent (plain text,
-- some legacy rows hold bare labels, not JSON) — parse defensively.
CREATE OR REPLACE FUNCTION pg_temp.try_jsonb(v text) RETURNS jsonb AS $$
BEGIN
  RETURN v::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$ LANGUAGE plpgsql;

WITH task_links AS (
  SELECT t.agent_type_id, t.updated_at, l.key
    FROM tasks t
    CROSS JOIN LATERAL (
      SELECT t.acp_session_key AS key
      UNION
      SELECT pg_temp.try_jsonb(t.completed_by::text)->>'sessionKey'
      UNION
      SELECT pg_temp.try_jsonb(t.active_agent::text)->>'sessionKey'
      UNION
      SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(t.session_refs) = 'array'
                    THEN t.session_refs
                    ELSE '[]'::jsonb END)
    ) AS l(key)
   WHERE t.agent_type_id IS NOT NULL
     AND l.key IS NOT NULL
     AND l.key <> ''
     AND l.key <> 'pending'
),
expanded AS (
  SELECT agent_type_id, updated_at, key FROM task_links
  UNION
  SELECT agent_type_id, updated_at, 'agent:main:' || key
    FROM task_links WHERE key LIKE 'cron:%'
  UNION
  SELECT agent_type_id, updated_at, substring(key FROM 12)
    FROM task_links WHERE key LIKE 'agent:main:cron:%'
),
best AS (
  SELECT DISTINCT ON (key) key, agent_type_id
    FROM expanded
   ORDER BY key, updated_at DESC NULLS LAST
)
UPDATE sessions s
   SET agent_type_id = b.agent_type_id,
       updated_at = NOW()
  FROM best b
 WHERE s.agent_type_id IS NULL
   AND (s.session_key = b.key OR s.session_key LIKE b.key || ':run:%');
