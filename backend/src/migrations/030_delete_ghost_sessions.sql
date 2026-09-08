-- Migration 030: Delete ghost sessions and fix kind column (BUG-11)
--
-- 101 sessions with NULL kind, zero tokens, zero message_count, and no label
-- were created in a 16-second window on 2026-02-28 during the migration backfill.
-- These are empty skeleton entries that serve no purpose.
--
-- Criteria for deletion (all must be true):
--   - kind IS NULL
--   - input_tokens = 0
--   - output_tokens = 0
--   - message_count = 0
--   - label IS NULL
--   - started_at IS NULL
--
-- 2026-07-04 (task 475a54c9): wrapped in a conditional DO block — targets the
-- LEGACY sessions/session_messages tables which do not exist until 033 on a
-- from-scratch replay; no-ops safely when absent. The explicit BEGIN/COMMIT
-- was removed: migrate.ts already runs each file as a single implicit
-- transaction, and COMMIT is not allowed inside a DO block.
-- In normal operation this file is baseline-stamped and never executed.

DO $mig030$
DECLARE
  ghost_count INTEGER;
BEGIN
  IF to_regclass('public.sessions') IS NULL THEN
    RAISE NOTICE 'Migration 030: sessions not present (pre-033 replay) — no-op.';
    RETURN;
  END IF;

  -- Step 1: Count ghost sessions before deletion (for logging)
  SELECT COUNT(*) INTO ghost_count
  FROM sessions
  WHERE kind IS NULL
    AND COALESCE(input_tokens, 0) = 0
    AND COALESCE(output_tokens, 0) = 0
    AND COALESCE(message_count, 0) = 0
    AND label IS NULL
    AND started_at IS NULL;

  RAISE NOTICE 'BUG-11: Deleting % ghost sessions (NULL kind, zero data)', ghost_count;

  -- Step 2: Delete ghost sessions
  -- First remove any session_messages references (should be none for ghost sessions)
  IF to_regclass('public.session_messages') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM session_messages
      WHERE session_id IN (
        SELECT id FROM sessions
        WHERE kind IS NULL
          AND COALESCE(input_tokens, 0) = 0
          AND COALESCE(output_tokens, 0) = 0
          AND COALESCE(message_count, 0) = 0
          AND label IS NULL
          AND started_at IS NULL
      )
    $sql$;
  END IF;

  -- Then delete the ghost sessions themselves
  DELETE FROM sessions
  WHERE kind IS NULL
    AND COALESCE(input_tokens, 0) = 0
    AND COALESCE(output_tokens, 0) = 0
    AND COALESCE(message_count, 0) = 0
    AND label IS NULL
    AND started_at IS NULL;

  -- Step 3: Backfill any remaining NULL kinds to 'unknown' (safety net)
  UPDATE sessions SET kind = 'unknown' WHERE kind IS NULL;

  -- Step 4: Apply NOT NULL + DEFAULT on kind (safe now that NULLs are cleared)
  -- Drop old constraint first (may not exist), then add expanded one
  EXECUTE $sql$ ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_kind_check $sql$;
  EXECUTE $sql$
    ALTER TABLE sessions ADD CONSTRAINT sessions_kind_check
      CHECK (kind IN ('main', 'subagent', 'cron', 'heartbeat', 'isolated', 'acp', 'interactive', 'unknown'))
  $sql$;
  EXECUTE $sql$ ALTER TABLE sessions ALTER COLUMN kind SET NOT NULL $sql$;
  EXECUTE $sql$ ALTER TABLE sessions ALTER COLUMN kind SET DEFAULT 'unknown' $sql$;

  EXECUTE $sql$
    COMMENT ON COLUMN sessions.kind IS
      'Session type: main | subagent | cron | heartbeat | isolated | acp | interactive | unknown. NOT NULL.'
  $sql$;
END
$mig030$;
