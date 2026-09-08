-- Migration: 027_session_messages_dedup.sql
-- BUG-07b: Deduplicate existing rows (289K → ~13K)
-- BUG-07a: Add unique constraint to prevent future duplication on backend restart
--
-- Why this specific key: (session_key, ordinal, role, COALESCE(tool_call_id, ''))
--   - Each JSONL line produces unique (session_key, ordinal) for user/assistant rows
--   - Tool call rows share the same ordinal as the assistant turn but have unique tool_call_id
--   - Tool result rows have their own ordinal and unique tool_call_id
--   - Using COALESCE(tool_call_id, '') avoids NULL-is-distinct issues in PostgreSQL UNIQUE
--   - WHERE clause limits to rows where we can actually deduplicate (non-NULL key + ordinal)
--
-- 2026-07-04 (task 475a54c9): two fixes for from-scratch replay:
--   1. PG16 has no min(uuid) aggregate — the original MIN(id) failed with
--      "function min(uuid) does not exist". Replaced with
--      (ARRAY_AGG(id ORDER BY created_at, id))[1], keeping the earliest row.
--   2. Wrapped in a conditional DO block: session_messages does not exist
--      until 033 on a from-scratch replay (it was created by the legacy
--      out-of-band database/migrations/021_sessions_table.sql chain).
-- In normal operation this file is baseline-stamped and never executed.

DO $mig027$
BEGIN
  IF to_regclass('public.session_messages') IS NULL THEN
    RAISE NOTICE 'Migration 027: session_messages not present (pre-033 replay) — no-op.';
    RETURN;
  END IF;

  -- Step 1 (BUG-07b): Remove duplicate rows, keeping only the earliest row
  -- per logical message identity. (uuid supports ORDER BY even though PG
  -- lacks a min(uuid) aggregate — created_at is the primary tiebreaker.)
  EXECUTE $sql$
    DELETE FROM session_messages
    WHERE id NOT IN (
      SELECT (ARRAY_AGG(id ORDER BY created_at ASC, id ASC))[1]
      FROM session_messages
      GROUP BY session_key, ordinal, role, COALESCE(tool_call_id, '')
    )
  $sql$;

  -- Step 2 (BUG-07a): Add a functional unique index to prevent future duplicates.
  -- Rows with NULL ordinal or NULL session_key are excluded (cannot be deduplicated).
  EXECUTE $sql$
    CREATE UNIQUE INDEX IF NOT EXISTS uq_session_messages_dedup
      ON session_messages (session_key, ordinal, role, COALESCE(tool_call_id, ''))
      WHERE ordinal IS NOT NULL AND session_key IS NOT NULL
  $sql$;

  EXECUTE $sql$
    COMMENT ON INDEX uq_session_messages_dedup IS
      'Prevents duplicate inserts when TranscriptIngester re-reads a file from offset 0. '
      'Covers: (session_key, ordinal, role, tool_call_id) with NULL tool_call_id treated as empty string.'
  $sql$;
END
$mig027$;
