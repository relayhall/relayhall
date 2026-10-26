-- 169_notification_action_seen.sql — the per-caller SEEN mark on "Needs your
-- action" items (Action Center, card 5854f0d6; owner rulings E453 and E455,
-- which amends the Notifications and Timeline design's section 3.2 and choice
-- C2 by adding a seen mark). Reserved in backend/src/migrations/RESERVED in the
-- same commit.
--
-- WHAT IT HOLDS. An action item is still DERIVED at read time and still leaves
-- the list only when it is resolved: there is no queue table, no dismiss and no
-- snooze. This table records only that a principal has SEEN an item, as one row
-- per (principal, item key) carrying the item's `since` at the moment it was
-- marked. The item reads as seen while its current `since` equals the stored
-- one; a new occurrence of the same key (the Task went back to Review, a new
-- stuck episode) has a new `since`, so it reads as unseen again with no write.
-- The bell counts only the unseen items.
--
-- The item key is the one GET /notifications/actions returns
-- (`<kind>:<id>`); it never carries content. A row is written only by
-- POST /notifications/actions/seen, for a key that is in the CALLER'S OWN
-- current action list (a key the caller cannot see is ignored), so a mark never
-- widens what anyone sees. Like the read marks of migration 144, a row is the
-- principal's own and carries the time it was written (seen_at).
--
-- Replay-safe: IF NOT EXISTS, so re-running this file changes nothing.
-- database/init.sql is untouched.

CREATE TABLE IF NOT EXISTS notification_action_seen (
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  item_key     TEXT NOT NULL,
  -- The item's `since` when it was marked: the occurrence that was seen.
  since        TIMESTAMPTZ NOT NULL,
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, item_key),
  CONSTRAINT notification_action_seen_item_key_shape CHECK (
    item_key ~ '^(decision|verify|stuck|skill):[0-9A-Za-z._-]{1,128}$'
  )
);
