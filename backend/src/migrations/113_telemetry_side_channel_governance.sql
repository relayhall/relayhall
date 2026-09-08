-- 113_telemetry_side_channel_governance.sql
-- RH-TW1a candidate C (card beac9c79) — design 7d5c0cdc §6.5, the side-channel
-- governance the red team asked for (B1-B3/B9): the tier model must govern
-- EVERY content-bearing store, not only the canonical event path.
--
-- Three stores, one rule each, and each rule is a CHECK rather than a comment,
-- because a governance invariant that lives in a service is one refactor away
-- from being untrue:
--
--   §6.5.1 governed raw store — "Raw vendor payloads pass the source's policy
--     tier BEFORE content-addressing: for Tier 0/1 sources, raw_ref stores the
--     REDACTED raw payload only ... Blob keys are connector-namespaced — a blob
--     is never shared across sources/policies, so per-source deletion is
--     well-defined; retention receipts cover raw blobs."
--
--   §6.5.2 quarantine — "Quarantined payloads are Tier-0-stripped before
--     persistence ... with a mandatory short retention and scoped access.
--     Per-connector quarantine quota with drop-and-count past threshold and a
--     per-connector quarantine-rate health alarm — one connector can neither
--     exhaust nor blind the quarantine plane."
--
--   TS-9 retention (ratification sitting 7e7eeca3) — identity-bound Tier 0/1
--     metadata is retained at EVENT GRAIN for a 90-day default; aggregates
--     beyond that carry no identity finer than org/key; both bounds are
--     deployment-configurable and documented.
--
-- The §6.5.3 audit-plane statement changes NO ledger and therefore appears in
-- docs/ and in the evidence report, not here. Owner decision D5: "state, do not
-- change; plus the no-payload-bytes control."

-- ─────────────────────────────────────────────────────────────────────────────
-- §6.5.1 · The governed raw store
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT IS ACTUALLY STORED. At TW1a every source is Tier 0 (TS-5), so this table
-- holds the REDACTED record and nothing else — the same bytes the event row
-- carries, content-addressed so repeated reports of an identical payload cost
-- one copy. The fidelity loss is the point, and it is visible: redaction_counts
-- travels with the blob, so an operator can see how much of the original the
-- policy removed without ever being able to read what was removed.
--
-- WHY THE KEY IS A CHECK AND NOT A CONVENTION. "Connector-namespaced" is the
-- property that makes per-source deletion well-defined. If the namespace were
-- merely how the service happens to build the string, a later caller could
-- write a key naming another connector's blob and deletion for one source
-- would silently take another's evidence with it. The key is therefore
-- DERIVED from the row's own connector_id by a CHECK: a row whose key does not
-- name its owner cannot be written at all.

CREATE TABLE IF NOT EXISTS telemetry_raw_blobs (
  blob_key TEXT PRIMARY KEY,
  connector_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  policy_tier SMALLINT NOT NULL CHECK (policy_tier IN (0, 1, 2)),
  -- 'redacted' is the only class TW1a can write. The Tier-2 class exists so the
  -- CHECK below can say what it forbids; the encrypted content store that would
  -- hold it is TW5 scope and is NOT created here.
  payload_class TEXT NOT NULL CHECK (payload_class IN ('telemetry_raw_redacted', 'telemetry_raw_governed')),
  payload JSONB NOT NULL,
  redaction_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  first_stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_referenced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- The namespace, enforced. `rhraw/1:<connector>:<sha256 of the redacted
  -- payload>` — a key can only ever name the connector that owns the row.
  CONSTRAINT telemetry_raw_blobs_key_is_namespaced
    CHECK (blob_key = 'rhraw/1:' || connector_id::text || ':' || content_hash),
  -- §6.5.1, the whole of it: a Tier 0 or Tier 1 source may hold a REDACTED
  -- payload and nothing else. A true original is a Tier-2 artefact and belongs
  -- in the keyset-encrypted store TW5 builds.
  CONSTRAINT telemetry_raw_blobs_tier01_is_redacted
    CHECK (policy_tier = 2 OR payload_class = 'telemetry_raw_redacted')
);

CREATE INDEX IF NOT EXISTS idx_telemetry_raw_blobs_sweep
  ON telemetry_raw_blobs (expires_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_raw_blobs_owner
  ON telemetry_raw_blobs (connector_id, first_stored_at DESC);

COMMENT ON TABLE telemetry_raw_blobs IS
  'Governed raw store (design 7d5c0cdc §6.5.1). Tier 0/1 sources store the REDACTED payload only; keys are connector-namespaced by CHECK so per-source deletion is well-defined, and retention receipts cover these blobs.';
COMMENT ON COLUMN telemetry_raw_blobs.blob_key IS
  'rhraw/1:<connector_id>:<sha256 of the redacted payload>. Derived from the row by CHECK — a key that names another connector cannot be written.';
COMMENT ON COLUMN telemetry_raw_blobs.redaction_counts IS
  'What the policy removed, carried with the blob so fidelity loss is visible without the removed content being readable.';

-- The receiver-assigned pointer. `source.raw_ref` is REFUSED from reporters by
-- the candidate-A validator precisely so that it can mean this and only this.
-- ON DELETE SET NULL, not RESTRICT: retention erases blobs on their own
-- schedule and the event metadata outlives them, which is exactly the
-- "provable deletion that does not orphan or mutate Tier-0/1 history" of §6.3.
ALTER TABLE session_events
  ADD COLUMN IF NOT EXISTS raw_ref TEXT;

-- The guard is scoped to THIS session_events, not to the constraint name.
-- `pg_constraint.conname` is not unique across schemas, so a bare name test
-- reports "already there" for a constraint that belongs to a different schema
-- entirely — and the migration then silently skips creating the foreign key
-- here. `'session_events'::regclass` resolves through search_path, so the
-- question asked is the one meant: does THIS table already carry it?
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'session_events'::regclass
       AND conname = 'session_events_raw_ref_fkey'
  ) THEN
    ALTER TABLE session_events
      ADD CONSTRAINT session_events_raw_ref_fkey
      FOREIGN KEY (raw_ref) REFERENCES telemetry_raw_blobs (blob_key) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_session_events_raw_ref
  ON session_events (raw_ref) WHERE raw_ref IS NOT NULL;

COMMENT ON COLUMN session_events.raw_ref IS
  'Receiver-assigned pointer into telemetry_raw_blobs (§6.5.1). Reporters may not supply it — the validator refuses source.raw_ref outright.';
COMMENT ON INDEX idx_session_events_raw_ref IS
  'How the retention sweep asks whether any event still points at a blob. A maintained reference COUNT was considered and rejected: the ingest write path is ONE statement, and a duplicate event would over-count a counter maintained inside it, so the truth is derived from this index instead and cannot drift.';

-- ─────────────────────────────────────────────────────────────────────────────
-- §6.5.2 · Quarantine — a connector key, a quota, and a rate the operator sees
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Migration 055 already has session_quarantine with occurrence_count, and it is
-- the right table: fail-closed evidence without raw secret-bearing payloads is
-- exactly what a Tier-0-stripped quarantine row is. What it lacks is an OWNER.
-- Without one the plane is both exhaustible (one noisy connector fills it) and
-- blindable (its rows drown everyone else's), which is the pair §6.5.2 names.
--
-- The columns are nullable because 055's own rows predate the envelope plane
-- and have no connector; a NOT NULL here would rewrite their history.

ALTER TABLE session_quarantine
  ADD COLUMN IF NOT EXISTS connector_id UUID REFERENCES principals(id) ON DELETE RESTRICT;
ALTER TABLE session_quarantine
  ADD COLUMN IF NOT EXISTS policy_tier SMALLINT;
ALTER TABLE session_quarantine
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE session_quarantine DROP CONSTRAINT IF EXISTS session_quarantine_policy_tier_check;
ALTER TABLE session_quarantine ADD CONSTRAINT session_quarantine_policy_tier_check
  CHECK (policy_tier IS NULL OR policy_tier IN (0, 1, 2));

-- A quarantine row written by the envelope plane MUST carry its owner and its
-- expiry — "mandatory short retention" is not a default one can forget to pass.
-- 055's own rows are exempt by being NULL on both, which is what identifies them.
ALTER TABLE session_quarantine DROP CONSTRAINT IF EXISTS session_quarantine_envelope_governance_check;
ALTER TABLE session_quarantine ADD CONSTRAINT session_quarantine_envelope_governance_check
  CHECK (
    (connector_id IS NULL AND policy_tier IS NULL AND expires_at IS NULL)
    OR (connector_id IS NOT NULL AND policy_tier IS NOT NULL AND expires_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_session_quarantine_owner
  ON session_quarantine (connector_id, first_observed_at DESC) WHERE connector_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_quarantine_sweep
  ON session_quarantine (expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN session_quarantine.connector_id IS
  'The owning Connector (§6.5.2). NULL identifies a pre-envelope row written by migration 055''s own ingest path.';
COMMENT ON COLUMN session_quarantine.expires_at IS
  'Mandatory short retention (§6.5.2) — enforced by CHECK for every envelope-plane row, not left to a caller default.';

-- The budget. One row per connector per window; the window is advanced by the
-- same conditional upsert that spends it, so the quota holds across workers for
-- the same reason the receiver limit does (migration 112).
CREATE TABLE IF NOT EXISTS telemetry_quarantine_budget (
  connector_id UUID PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Quarantine WRITES admitted in the current window, capped by the
  -- deployment quota. A new row and a repeat that bumps an occurrence count
  -- both count: both are load on the plane, and the quota exists to bound
  -- load rather than to count distinct rows.
  stored_count INTEGER NOT NULL DEFAULT 0 CHECK (stored_count >= 0),
  -- Rows refused past the threshold. DROP-AND-COUNT: the evidence that a
  -- connector is flooding must survive the flood, so the count is never reset
  -- to zero by a window roll — it is lifetime, and the alarm reads the rate.
  dropped_total BIGINT NOT NULL DEFAULT 0 CHECK (dropped_total >= 0),
  -- The quarantined term of the health alarm. The ACCEPTED term is not kept
  -- here: it is counted from session_events, because a running total would
  -- have to be incremented on the accept path — a hot-path write that a
  -- duplicate or an aborted insert could desynchronise — and a rate computed
  -- from a drifting denominator is worse than no alarm at all.
  quarantined_total BIGINT NOT NULL DEFAULT 0 CHECK (quarantined_total >= 0),
  last_dropped_at TIMESTAMPTZ,
  last_quarantined_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_telemetry_quarantine_budget_alarm
  ON telemetry_quarantine_budget (last_quarantined_at DESC NULLS LAST);

COMMENT ON TABLE telemetry_quarantine_budget IS
  'Per-connector quarantine quota and health-alarm terms (design 7d5c0cdc §6.5.2). One connector can neither exhaust the plane (stored_count is capped per window) nor blind it (dropped_total is lifetime and never reset).';
COMMENT ON COLUMN telemetry_quarantine_budget.dropped_total IS
  'Lifetime drop-and-count past the threshold. Never reset by a window roll: the evidence of a flood must outlive the flood.';

-- ─────────────────────────────────────────────────────────────────────────────
-- TS-9 · Retention, at event grain, with receipts that cover the raw blobs
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 055's session_retention_receipts is the ledger and is NOT changed: it already
-- carries payload_class, which is the hook the packet names. What TW1a adds is
-- the class vocabulary the telemetry sweep writes under, and an index that lets
-- an auditor ask "what was erased for this class, and when".

CREATE INDEX IF NOT EXISTS idx_session_retention_receipts_class
  ON session_retention_receipts (payload_class, executed_at DESC);

COMMENT ON COLUMN session_retention_receipts.payload_class IS
  'What was expired. The telemetry plane writes telemetry_event_metadata, telemetry_raw_blob and telemetry_quarantine (TS-9); migration 055''s own classes are unchanged.';
