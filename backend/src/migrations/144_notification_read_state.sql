-- 144_notification_read_state.sql — per-Account notification read state for
-- the notification centre (card b1e3b16d, hub lane L2; lane
-- claude-hub-l2-l4-notification-read-state; reserved in
-- backend/src/migrations/RESERVED before this file was written, ruling
-- 0464ad54 section 2).
--
-- WHY. The bell and the notification history used to read a 50-row JSON file
-- with ONE `read` flag shared by everyone (NotificationManager), so one person
-- marking an item read marked it read for every Account, and "mark all read"
-- marked rows the caller could not even see. The history now comes from the
-- ledgers the board already keeps (feed_events for task moves, stuck notices
-- and review requests; approval_events; skill_version_events), and the only
-- NEW state is what each principal has read. This file adds exactly that and
-- nothing else; it depends on no other lane's schema.
--
-- TWO TABLES.
--  * notification_reads: one row per item a principal marked read. The item
--    key names the ledger row: `feed:<cursor>`, `approval-event:<uuid>` or
--    `skill-event:<uuid>`. Keys never carry content.
--  * notification_read_marks: a high-water mark per principal, written by an
--    UNFILTERED "mark all read". The feed side is a CURSOR, not a time: only
--    the BIGSERIAL cursor follows commit order (FeedEventService header), so a
--    time mark could skip a row that committed late. approval_events and
--    skill_version_events have no commit-ordered key, so their side is a time.
--
-- FIRST DEPLOY. Without a seed every existing Account would see the whole
-- readable board history as unread at once. The backfill below gives every
-- existing principal a mark at the current feed head and the current time, so
-- history is listed but nothing old is unread. A principal created later has
-- no mark and reads as unread only what happened after its own created_at.
--
-- Replay-safe: IF NOT EXISTS everywhere and ON CONFLICT DO NOTHING on the
-- backfill, so re-running this file is a no-op.

CREATE TABLE IF NOT EXISTS notification_reads (
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  item_key     TEXT NOT NULL,
  read_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, item_key),
  CONSTRAINT notification_reads_item_key_shape CHECK (
    item_key ~ '^(feed:[0-9]{1,19}|approval-event:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|skill-event:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  )
);

CREATE TABLE IF NOT EXISTS notification_read_marks (
  principal_id    UUID PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  -- Every feed row with cursor <= feed_cursor is read for this principal.
  feed_cursor     BIGINT NOT NULL DEFAULT 0 CHECK (feed_cursor >= 0),
  -- Every approval or skill ledger row that occurred at or before this time
  -- is read for this principal.
  others_through  TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO notification_read_marks (principal_id, feed_cursor, others_through)
SELECT p.id, COALESCE((SELECT max(fe.cursor) FROM feed_events fe), 0), now()
  FROM principals p
ON CONFLICT (principal_id) DO NOTHING;
