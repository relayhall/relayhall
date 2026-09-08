-- 091_feed_events.sql
-- RH-P3.C1 (strategy 4e40f06f §2.6): the cursor event feed's append-only
-- ledger. "Give me everything that changed since cursor X" over work objects;
-- the feed is AUTHORITATIVE — webhooks (C2) will be a latency optimization
-- over it, and every consumer reconciles by cursor, so a missed ping is late
-- work, never lost work.
--
-- CURSOR SEMANTICS. `cursor` is a BIGSERIAL, and serial ordering alone is NOT
-- commit ordering: two concurrent transactions can take ids 100 and 101 and
-- commit in the other order, so a reader who already served past 101 would
-- MISS 100 forever — fatal for an authoritative feed. Emission therefore
-- takes `pg_advisory_xact_lock(hashtext('feed_events'))` before inserting
-- (FeedEventService), serializing event-appending transactions so cursor
-- order IS commit order. The cost is a short critical section per writing
-- transaction, acceptable at board scale (human/agent write rates) and
-- documented here so a future high-throughput deployment knows exactly which
-- assumption to revisit.
--
-- CONTENT RULES. Events carry identity and ownership metadata, never object
-- content (the ID-only doctrine: authority always travels in the pull).
-- Deletion tombstones and ACL-change events are CONTENT-FREE by CHECK
-- constraint, not convention. The ownership metadata columns are retained on
-- the event row itself so the feed endpoint can authorize delivery of a
-- tombstone AFTER the object row is gone ("delivered only to parties
-- entitled to the object either before or after the change").
--
-- The scoped-consumer semantics (per-consumer delivered-set tracking,
-- visibility-gain re-emission) stay NAMED in the strategy contract and are
-- deliberately not implemented in v1 (C5 ruling: privileged partitioning
-- ingester only).

CREATE TABLE feed_events (
  cursor BIGSERIAL PRIMARY KEY,
  -- Vocabulary §6: events are <singular>.<past-tense>, dotted, on every
  -- transport: task.created, report.updated, skill.deleted, task.acl_changed.
  name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  object_type TEXT NOT NULL CHECK (object_type IN
    ('task', 'phase', 'project', 'report', 'skill', 'personality')),
  object_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  actor_handle TEXT,
  -- Ownership/permission metadata (strategy §2.6.1: "every item carries its
  -- ownership and permission metadata"), denormalized AT EMISSION TIME so
  -- authorization outlives the object row (tombstones) and so ingesters can
  -- shelve content into the right vault without a second read.
  project_id UUID,
  owner_principal_id UUID,
  -- Emission-time record that the object was visible to every authenticated
  -- reader (e.g. a global Skill) — what lets its content-free tombstone reach
  -- the audience that could see it while it lived (review df7c1d83, F4).
  globally_visible BOOLEAN NOT NULL DEFAULT false,
  -- Light, content-free extras (e.g. {"status":"in-progress"} on a lifecycle
  -- event). NEVER titles, descriptions, notes, or report bodies.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  -- The contract's content-free rule, enforced structurally: a tombstone or
  -- ACL change may carry NOTHING beyond identity and ownership metadata.
  CONSTRAINT feed_events_tombstones_content_free CHECK (
    (name NOT LIKE '%.deleted' AND name NOT LIKE '%.acl_changed')
    OR payload = '{}'::jsonb
  )
);

-- Pagination is the primary read: WHERE cursor > $1 ORDER BY cursor LIMIT n.
-- The PK serves it. Per-object history and ingester shelving get their own.
CREATE INDEX ix_feed_events_object ON feed_events (object_type, object_id, cursor);
CREATE INDEX ix_feed_events_project ON feed_events (project_id, cursor) WHERE project_id IS NOT NULL;

-- Append-only, the 087 pattern: the ledger is history, not state.
CREATE OR REPLACE FUNCTION reject_feed_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'feed_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feed_events_no_update_delete ON feed_events;
CREATE TRIGGER trg_feed_events_no_update_delete
BEFORE UPDATE OR DELETE ON feed_events
FOR EACH ROW EXECUTE FUNCTION reject_feed_event_mutation();

DROP TRIGGER IF EXISTS trg_feed_events_no_truncate ON feed_events;
CREATE TRIGGER trg_feed_events_no_truncate
BEFORE TRUNCATE ON feed_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_feed_event_mutation();

ALTER TABLE feed_events ENABLE ALWAYS TRIGGER trg_feed_events_no_update_delete;
ALTER TABLE feed_events ENABLE ALWAYS TRIGGER trg_feed_events_no_truncate;

COMMENT ON TABLE feed_events IS
  'RH-P3.C1 cursor event feed ledger (strategy 4e40f06f §2.6). Append-only; cursor order is commit order via advisory-lock-serialized emission; tombstones and ACL-change events are content-free by constraint; ownership metadata denormalized at emission so authorization outlives the object.';
COMMENT ON COLUMN feed_events.cursor IS
  'The feed cursor. Monotone in COMMIT order (emission serialized by pg_advisory_xact_lock), so "everything after cursor X" can never silently skip a concurrently-committing event.';
