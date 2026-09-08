-- Migration 061: reports.visibility (task c655d243, item 6)
--
-- Schema + read/write plumbing only. Enforcement (who may read which
-- visibility class) is a knowledge-fabric-side concern and is deliberately
-- NOT implemented here — every caller still sees every non-deleted report.
-- Values are free-form labels validated by the route layer
-- (lowercase [a-z0-9_-]{1,32}); 'default' covers all historical rows.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'default';
