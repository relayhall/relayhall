-- 143_assignment_grant_expiry.sql — AZ-A10 clause 6, the expiry of the grant
-- rows an execution assignment writes (card 785e1eed P2-B slice 1, lane
-- claude-p2b-shortenable-expiry; reserved in backend/src/migrations/RESERVED
-- before this file was written, ruling 0464ad54 §2).
--
-- AZ-A10 was RATIFIED on 2026-10-10 (E43). Its clause 6, for a Connector or a
-- human assignee: "default `expires_at` = materialization + 3 months. The
-- assigning act may set any later date, or `unlimited` (`expires_at` NULL) ...
-- Three months is the DEFAULT, not a floor: an earlier date is admitted (E43
-- Q4: "shortenable by the owner")". E62 reads "the owner" as whoever performs
-- the assigning act.
--
-- Clause 6 also says that a row every task shares through these links takes
-- "the maximum over its live links, NULL dominating". The row's own
-- grants.expires_at (078, unchanged) cannot remember which task asked for
-- which date, so each link records the date ITS assignment set, and the row
-- is recomputed from its links whenever one is added, re-dated or removed.
--
-- NULL means "until the task or the assignment ends", which is exactly what
-- every link written before this migration already meant: nothing is
-- backfilled, and no stored row changes meaning. The default applies to
-- assignments made from now on.
--
-- Only the auto-grant arm carries a date. A warrant-carried assignment keeps
-- the warrant's own lifecycle (§6.2), and its profile-assignment links stay
-- NULL. No constraint on `grants` is added or changed (the R-7 controls pin
-- every grants CHECK by name), and the link table's existing CHECKs and
-- UNIQUE are untouched.
--
-- Replay-safe: re-running this file on a migrated database is a no-op.

ALTER TABLE access_vehicle_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE access_vehicle_links DROP CONSTRAINT IF EXISTS access_vehicle_links_expiry_shape;
ALTER TABLE access_vehicle_links ADD CONSTRAINT access_vehicle_links_expiry_shape
  CHECK (expires_at IS NULL OR (vehicle_kind = 'auto-grant' AND target_kind = 'grant'));

COMMENT ON COLUMN access_vehicle_links.expires_at IS
  'AZ-A10 clause 6 (ratified 2026-10-10; E43 Q4; E62): the date the assigning act set for this task''s link to the row. Default: materialization + 3 months. Any earlier or later date may be set by whoever performs the assigning act. NULL = unlimited, i.e. until the task or the assignment ends (every pre-143 link). For a row this machinery created, the grant row''s expires_at is the maximum over its links, NULL dominating; an owner-plane row is never re-dated.';
