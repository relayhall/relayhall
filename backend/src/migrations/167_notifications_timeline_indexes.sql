-- 167_notifications_timeline_indexes.sql — the four indexes the Timeline reads
-- (Notifications and Timeline, Slice A; card 5854f0d6, owner ruling E394, choice
-- C8: the feed_events spine plus four indexes, no new table and no materialized
-- view unless a measured page exceeds 300 ms at p95). Reserved in
-- backend/src/migrations/RESERVED in the same commit.
--
-- Indexes only: no table, column, constraint or row changes, and nothing a
-- later migration redefines. Every statement is replay-safe (IF NOT EXISTS), so
-- re-running this file against a database that already has it changes nothing.
-- database/init.sql is untouched.
--
-- What each one serves (GET /notifications/timeline, TimelineService):
--
--   ix_feed_events_name_cursor   the type filter: a single feed name is an index
--                                range read in cursor order; a multi-type
--                                `name = ANY(...)` filter is a bitmap scan plus
--                                a sort, which the design accepts.
--   ix_feed_events_occurred      the date filter: a range on occurred_at, then
--                                the cursor keyset (occurred_at is the
--                                transaction start time, not commit order, so
--                                the date is never converted to a cursor).
--   ix_feed_events_actor_cursor  the person filter (actor_principal_id), only
--                                for rows that name an actor: rows the board
--                                writes itself carry none and never match.
--   ix_approval_events_occurred  the approval arm's time window
--                                (occurred_at < before AND occurred_at >= floor).
--
-- The project filter reuses ix_feed_events_project (091) and the unfiltered
-- page reads the primary key backwards.

CREATE INDEX IF NOT EXISTS ix_feed_events_name_cursor
  ON feed_events (name, cursor DESC);

CREATE INDEX IF NOT EXISTS ix_feed_events_occurred
  ON feed_events (occurred_at, cursor);

CREATE INDEX IF NOT EXISTS ix_feed_events_actor_cursor
  ON feed_events (actor_principal_id, cursor)
  WHERE actor_principal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_approval_events_occurred
  ON approval_events (occurred_at DESC, id);
