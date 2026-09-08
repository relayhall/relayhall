-- 111_telemetry_envelope_foundation.sql
-- RH-TW1a (card beac9c79) — the §2.2 schema deltas of TELEMETRY-DESIGN v1.4
-- `7d5c0cdc` (RATIFIED 2026-08-28), under owner decision D1 of run packet
-- `bb83d616`: EXTEND the migration-055 canonical session foundation IN PLACE.
-- There is no parallel session database (design §2.1.4).
--
-- Additive and idempotent, in the shape migration 055 established: every
-- object guard is `IF NOT EXISTS` / `IF EXISTS`, so replaying the file is
-- harmless (the 055 probe script asserts exactly that property, and
-- scripts/test-telemetry-envelope-migration.js asserts it for this file).
--
-- The four deltas, each bound to its design paragraph:
--
--   §2.2.1 attempt-optional events — envelope events are legitimately
--     unlinked at ingest (no known session/attempt), so `attempt_id` becomes
--     NULLABLE on `session_events` and `session_observations`. Existing rows
--     keep their binding; the foreign key, the ON DELETE RESTRICT and every
--     attempt-scoped index are untouched.
--
--   §2.2.2 kind vocabulary — the `event_kind` CHECK gains the envelope kinds
--     that have no existing home (`session, turn, model_call, agent_step,
--     metric, audit, health, feedback`). The three kinds that COINCIDE
--     (`tool_call`, `usage`, `error`) map onto the existing spellings and are
--     NOT duplicated. The taxonomy is never funnelled through `'other'`.
--
--   §2.2.3 org/key-grained accounting — `session_usage_receipts.attempt_id`
--     is NOT NULL, so accounting rollups that carry no session correlation
--     (the §9.2 required behaviour) have nowhere to land. This file adds the
--     key/org/day-grained receipt table ALONGSIDE the attempt-grained one.
--     Neither replaces the other; both feed reconciliation.
--
--   §2.2.4 per-stream sequence — `source_sequence` and `stream_generation`
--     already exist on `session_events` (055:206, 055:209). No schema change;
--     the §4.3 identity rule uses them, implemented in
--     backend/src/utils/telemetryEnvelopeIdentity.ts.
--
-- Plus the columns TW1c (`50e74c1d`) needs as COLUMNS, not JSONB, because a
-- projection cannot group by or index a JSONB probe at the volumes this plane
-- expects: the derived principal binding (`connector_id`, `account_id`,
-- `agent_id`), `source_product`, the Tier-0-safe opaque `session_ref`, the
-- `policy_tier` the row was stored under, its `schema_version`, and the
-- receiver clock `observed_at` alongside the existing source clock
-- `source_occurred_at` (design §4.4 — two clocks, never silently corrected).
--
-- POLICY TIER NOTE (sitting ruling TS-5, owner decision D9): Tier 0 is the
-- ONLY tier that TW1a accepts. The column admits 0/1/2 so that the later
-- waves need no further migration, but the ingest path refuses tiers 1 and 2
-- (backend/src/services/TelemetryPolicyEngine.ts) — the restriction is
-- enforced in code where it is falsifiable, not merely commented here.

-- ---------------------------------------------------------------------------
-- §2.2.1 — attempt-optional events
-- ---------------------------------------------------------------------------
ALTER TABLE session_events ALTER COLUMN attempt_id DROP NOT NULL;
ALTER TABLE session_observations ALTER COLUMN attempt_id DROP NOT NULL;

COMMENT ON COLUMN session_events.attempt_id IS
  'Canonical attempt binding, NULLABLE since 111: envelope events (design 7d5c0cdc §2.2.1) are first-class while unlinked; correlation may attach them later under the §9.1 owner-asserted merge rule.';

-- ---------------------------------------------------------------------------
-- §2.2.2 — kind vocabulary
-- ---------------------------------------------------------------------------
-- The 055 constraint is named by PostgreSQL's default naming
-- (`session_events_event_kind_check`); dropping it by that name and adding a
-- distinctly named successor keeps the replay idempotent and leaves an
-- unambiguous audit trail of which file owns the current vocabulary.
ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_event_kind_check;
ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_event_kind_envelope_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_event_kind_envelope_check
  CHECK (event_kind IN (
    -- migration 055 vocabulary, unchanged
    'message', 'tool_call', 'tool_result', 'usage', 'lifecycle', 'control', 'error', 'other',
    -- envelope kinds with no existing home (design §4.2); the coinciding
    -- kinds tool_call / usage / error are deliberately absent from this half
    'session', 'turn', 'model_call', 'agent_step', 'metric', 'audit', 'health', 'feedback'
  ));

-- ---------------------------------------------------------------------------
-- The envelope columns TW1b/TW1c consume (design §4.1, §4.3, §4.4, §10.1)
-- ---------------------------------------------------------------------------
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS connector_id UUID REFERENCES principals(id) ON DELETE RESTRICT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES principals(id) ON DELETE RESTRICT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES principals(id) ON DELETE RESTRICT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS source_product TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS session_ref TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS policy_tier SMALLINT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS schema_version TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ;

ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_policy_tier_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_policy_tier_check
  CHECK (policy_tier IS NULL OR policy_tier IN (0, 1, 2));

-- Every accepted envelope write has an owning Connector (design §4.1/§5.1:
-- direct Account -> Agent presenters are refused at ingest precisely so that
-- `connector_id` is TOTAL for envelope rows). Expressed as a table check over
-- the envelope discriminator rather than a NOT NULL, because the 055 rows
-- written by the hermes ingestion path carry no principal binding at all.
ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_envelope_binding_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_envelope_binding_check
  CHECK (
    schema_version IS NULL
    OR (connector_id IS NOT NULL AND account_id IS NOT NULL AND source_product IS NOT NULL
        AND policy_tier IS NOT NULL AND observed_at IS NOT NULL)
  );

COMMENT ON COLUMN session_events.connector_id IS
  'Owning Connector, DERIVED from the authenticated credential chain (design 7d5c0cdc §4.1) — never read from the payload.';
COMMENT ON COLUMN session_events.agent_id IS
  'Authoritative only for a Connector-descended Agent presenter (§4.1 R1-B3); NULL for Connector-authenticated writes, whose observed Agent claims are advisory observed-by-intermediary attributes.';
COMMENT ON COLUMN session_events.session_ref IS
  'Tier-0-safe OPAQUE session grouping key (keyed-HMAC pseudonym of the source conversation/session identifier) — the TW1c timeline grouping column.';
COMMENT ON COLUMN session_events.observed_at IS
  'Receiver clock (design §4.4). Always set for envelope rows; source_occurred_at stays the source clock and is never silently corrected.';

-- TW1c grouping/projection index: the Sessions timeline groups by
-- (connector_id, source_product, session_ref) and orders by the receiver
-- clock. Partial on the envelope discriminator so the 055 hermes rows do not
-- enter the index at all.
CREATE INDEX IF NOT EXISTS idx_session_events_envelope_grouping
  ON session_events (connector_id, source_product, session_ref, observed_at DESC)
  WHERE schema_version IS NOT NULL;

-- TW1c presence projection: latest activity per connector/product, evaluated
-- against the same 9-minute staleness window the shipped frames use
-- (TELEMETRY_STALE_MS; sitting ruling TS-8, design §10.1).
CREATE INDEX IF NOT EXISTS idx_session_events_envelope_presence
  ON session_events (connector_id, source_product, observed_at DESC)
  WHERE schema_version IS NOT NULL;

-- ---------------------------------------------------------------------------
-- §2.2.3 — org/key/day-grained accounting receipts
-- ---------------------------------------------------------------------------
-- ALONGSIDE session_usage_receipts (055:341), which stays attempt-grained and
-- untouched. Grain here is (account, connector, day, authority, scope, unit)
-- where scope is org or key — the granularity provider accounting feeds
-- actually guarantee (§9.2/§9.3). There is NO product column: review bc03054d
-- R3-F3 showed a bounded key class cannot tell a product name from a raw
-- customer identifier, so it was withdrawn rather than the claim narrowed, and
-- product grain arrives with TW3 and its registry binding. Nothing finer than
-- org/key can be expressed, which is
-- also what sitting ruling TS-9 requires of aggregates beyond the event-grain
-- retention bound.
CREATE TABLE IF NOT EXISTS session_accounting_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  connector_id UUID REFERENCES principals(id) ON DELETE RESTRICT,
  -- There is deliberately NO `source_product` column (review bc03054d, R3-F3).
  -- A bounded key class cannot tell a product name from a raw customer or
  -- member identifier: `CustomerSSN123456789` satisfied it, which falsified
  -- this table's own content-free claim. Rather than narrow the claim, the
  -- column is WITHDRAWN — it had no writer at TW1a, and a field with no writer
  -- is vacuous. §2.2.3 requires org/key/day grain and nothing finer, which is
  -- exactly what remains. TW3 adds product grain WITH the registry binding
  -- that makes a product key governed rather than reporter-shaped.
  usage_day DATE NOT NULL,
  authority TEXT NOT NULL CHECK (authority IN ('provider', 'gateway', 'derived', 'legacy')),
  -- CLOSED aggregate vocabulary (review bfac1dd5 finding F7). `scope TEXT`
  -- with no constraint was an open channel on an aggregate sink: a later pull
  -- connector could have written a per-user or per-session scope and made the
  -- table finer-grained than sitting ruling TS-9 allows ("aggregates beyond
  -- that carry no identity finer than org/key"). The vocabulary IS the grain.
  -- The product-grained scopes go with the column: a grain nothing can express
  -- is not a grain. §2.2.3's org/key/day is what this table now offers.
  scope TEXT NOT NULL CHECK (scope IN ('org', 'key')),
  unit TEXT NOT NULL CHECK (unit IN ('tokens', 'input_tokens', 'output_tokens', 'requests', 'cost')),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  currency TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- A receipt SUPERSEDES an earlier one; it never mutates it (§9.2). The
  -- superseded row stays readable, so drift stays computable.
  supersedes_receipt_id UUID REFERENCES session_accounting_receipts(receipt_id) ON DELETE RESTRICT,
  -- R2-F6: likewise `idempotency_key TEXT` was unconstrained. It is
  -- RECEIVER-DERIVED, so it can be pinned to a fixed-width domain-separated
  -- digest and nothing else — which makes it unable to carry content at all
  -- rather than merely unlikely to.
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^rhacct/1:[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (supersedes_receipt_id IS NULL OR supersedes_receipt_id <> receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_session_accounting_receipts_bucket
  ON session_accounting_receipts (account_id, connector_id, usage_day);

COMMENT ON TABLE session_accounting_receipts IS
  'Org/key/day-grained accounting receipts (design 7d5c0cdc §2.2.3) alongside the attempt-grained session_usage_receipts; immutable, superseding, and content-free BY CONSTRUCTION: every column is a UUID, a DATE, a NUMERIC, a value from a closed vocabulary, or a receiver-derived digest pinned to a fixed shape. There is deliberately no JSONB detail column, no unconstrained text column, and no reporter-shaped key column at all — an open channel here would let a later pull connector write content, or identity finer than org/key, into an aggregate sink (reviews bfac1dd5 F7 and 696bff8c R2-F6; sitting ruling TS-9).';
COMMENT ON COLUMN session_accounting_receipts.scope IS
  'Closed aggregate grain vocabulary. The grain IS the constraint: nothing finer than org/key/day can be expressed, because no column exists that could express it (review bc03054d R3-F3).';
COMMENT ON COLUMN session_accounting_receipts.supersedes_receipt_id IS
  'Reconciliation supersedes, never mutates (§9.2): the superseded receipt stays readable so drift remains computable at feed granularity.';
