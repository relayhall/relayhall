-- Migration 058: reports.author_actor_id (task c655d243, item 3)
--
-- Verified authorship: the authenticated identity (req.userId — e.g.
-- 'dashboard_user', 'service_account', 'journal_publisher') is recorded
-- server-side on POST. The free-form client-supplied `author` column remains
-- but is now surfaced as author_unverified in API responses; the API rejects
-- any attempt to set author_actor_id from the request body.
-- Historical rows stay NULL — no verified identity existed at write time,
-- and inventing one would be provenance laundering.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS author_actor_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_reports_author_actor_id
    ON reports(author_actor_id)
    WHERE author_actor_id IS NOT NULL;
