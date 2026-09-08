-- Migration 059: reports.origin (task c655d243, item 4)
--
-- Records which surface created the report ('api', 'cli', 'dashboard', ...),
-- taken from the optional X-ClawBoard-Origin request header on POST and
-- validated (lowercase [a-z0-9_-]{1,32}) by the route layer. Default 'api'
-- covers both new header-less writes and all historical rows.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS origin VARCHAR(32) NOT NULL DEFAULT 'api';
