-- Migration 060: reports soft-delete tombstones (task c655d243, item 5)
--
-- DELETE /reports/:id now sets deleted_at instead of destroying the row;
-- list/get exclude tombstoned rows unless include_deleted=true. Real DELETE
-- survives only behind ?hard=true, restricted to the dashboard_user identity.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reports_deleted_at
    ON reports(deleted_at)
    WHERE deleted_at IS NOT NULL;
