-- 035_cleanup_empty_run_sessions.sql
-- Clean up orphaned :run: child sessions that were never populated by the SessionIngester.
-- These accumulate when cron parent sessions spawn :run: sub-sessions that have no
-- corresponding JSONL transcript. The SessionIngester now falls back to the parent's
-- transcript for :run: children, so future records will have data. This migration
-- removes historical empty stubs.
--
-- Safety criteria: only deletes where ALL of the following are true:
--   • session_key contains ':run:' (is a child execution session)
--   • message_count = 0 (no messages were ever indexed)
--   • started_at IS NULL (no timestamp from transcript)
--   • status is not 'active' (don't touch live sessions)

DELETE FROM sessions
WHERE session_key LIKE '%:run:%'
  AND message_count = 0
  AND started_at IS NULL
  AND status != 'active';
