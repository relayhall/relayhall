-- Migration 029: Extend sessions.kind to include 'cron', 'acp', 'interactive'
-- BUG-03: 'cron' was used by SessionIndexer but missing from CHECK constraint.
-- BUG-03: 'acp' and 'interactive' added for ACP-spawned sessions (ClawBoard-ACP integration).
-- BUG-11: Add NOT NULL DEFAULT 'unknown' on kind column.
--
-- 2026-07-04 (task 475a54c9): wrapped in a conditional DO block — the
-- sessions table this targets was the LEGACY one (out-of-band
-- database/migrations/021_sessions_table.sql); on a from-scratch replay
-- sessions does not exist until 033, so this now no-ops safely.
-- In normal operation it is baseline-stamped and never executed.

DO $mig029$
BEGIN
  IF to_regclass('public.sessions') IS NULL THEN
    RAISE NOTICE 'Migration 029: sessions not present (pre-033 replay) — no-op.';
    RETURN;
  END IF;

  -- Drop the old CHECK constraint if it exists (may not exist in production)
  EXECUTE $sql$ ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_kind_check $sql$;

  -- Add expanded CHECK constraint with all valid kinds
  EXECUTE $sql$
    ALTER TABLE sessions ADD CONSTRAINT sessions_kind_check
      CHECK (kind IN ('main', 'subagent', 'cron', 'heartbeat', 'isolated', 'acp', 'interactive', 'unknown'))
  $sql$;

  -- Backfill any existing NULL kinds to 'unknown' BEFORE applying NOT NULL (BUG-11 cleanup)
  EXECUTE $sql$ UPDATE sessions SET kind = 'unknown' WHERE kind IS NULL $sql$;

  -- Ensure kind has NOT NULL + DEFAULT so new rows can't get NULL kind
  EXECUTE $sql$ ALTER TABLE sessions ALTER COLUMN kind SET NOT NULL $sql$;
  EXECUTE $sql$ ALTER TABLE sessions ALTER COLUMN kind SET DEFAULT 'unknown' $sql$;

  EXECUTE $sql$
    COMMENT ON COLUMN sessions.kind IS
      'Session type: main | subagent | cron | heartbeat | isolated | acp | interactive | unknown'
  $sql$;
END
$mig029$;
