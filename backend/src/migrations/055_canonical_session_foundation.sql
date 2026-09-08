-- 055_canonical_session_foundation.sql
-- Canonical dual-harness execution-attempt, identity, event and persistence
-- foundation. Additive only; legacy sessions/session_messages remain untouched.

CREATE TABLE IF NOT EXISTS session_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version TEXT NOT NULL DEFAULT '1.0.0-draft.1',
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  harness TEXT NOT NULL CHECK (harness IN ('hermes', 'openclaw', 'unknown')),
  runtime_kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_observed_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  identity_confidence TEXT NOT NULL CHECK (identity_confidence IN ('authoritative', 'correlated', 'ambiguous', 'quarantined')),
  identity_reason TEXT NOT NULL,
  superseded_by_attempt_id UUID REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  created_by_adapter TEXT NOT NULL,
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK (superseded_by_attempt_id IS NULL OR superseded_by_attempt_id <> attempt_id)
);

CREATE TABLE IF NOT EXISTS session_aliases (
  alias_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  alias_value TEXT NOT NULL,
  normalization_version INTEGER NOT NULL DEFAULT 1 CHECK (normalization_version > 0),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  authority TEXT NOT NULL CHECK (authority IN ('source_authoritative', 'source_reported', 'derived', 'legacy')),
  evidence_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_instance, alias_kind, alias_value, normalization_version),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS idx_session_aliases_attempt ON session_aliases(attempt_id);

CREATE TABLE IF NOT EXISTS session_identity_collisions (
  collision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  alias_value_hash TEXT NOT NULL CHECK (alias_value_hash ~ '^[0-9a-f]{64}$'),
  normalization_version INTEGER NOT NULL CHECK (normalization_version > 0),
  existing_attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  claimant_attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_same_attempt', 'resolved_distinct', 'invalid_source')),
  reason_code TEXT NOT NULL,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  resolver TEXT,
  resolved_at TIMESTAMPTZ,
  UNIQUE (source, source_instance, alias_kind, alias_value_hash, normalization_version, existing_attempt_id, claimant_attempt_id),
  CHECK (existing_attempt_id <> claimant_attempt_id)
);

CREATE TABLE IF NOT EXISTS session_identity_decision_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  normalization_version INTEGER NOT NULL CHECK (normalization_version > 0),
  input_alias_hashes JSONB NOT NULL CHECK (jsonb_typeof(input_alias_hashes) = 'array'),
  attempt_id UUID REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  collision_id UUID REFERENCES session_identity_collisions(collision_id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((attempt_id IS NOT NULL)::integer + (collision_id IS NOT NULL)::integer = 1)
);

CREATE TABLE IF NOT EXISTS session_attempt_edges (
  edge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  child_attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  relationship TEXT NOT NULL CHECK (relationship IN ('spawned', 'delegated', 'resumed_from', 'retried_from', 'replaced', 'observed_parent')),
  authority TEXT NOT NULL CHECK (authority IN ('source_authoritative', 'task_orchestrator', 'derived', 'legacy')),
  evidence_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalidated_at TIMESTAMPTZ,
  UNIQUE (parent_attempt_id, child_attempt_id, relationship, evidence_ref),
  CHECK (parent_attempt_id <> child_attempt_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_attempt_edges_execution_parent
  ON session_attempt_edges(child_attempt_id)
  WHERE invalidated_at IS NULL AND relationship IN ('spawned', 'delegated');

CREATE OR REPLACE FUNCTION prevent_session_attempt_edge_cycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invalidated_at IS NOT NULL OR NEW.relationship NOT IN ('spawned', 'delegated') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    WITH RECURSIVE descendants(attempt_id) AS (
      SELECT NEW.child_attempt_id
      UNION
      SELECT e.child_attempt_id
      FROM session_attempt_edges e
      JOIN descendants d ON e.parent_attempt_id = d.attempt_id
      WHERE e.invalidated_at IS NULL AND e.relationship IN ('spawned', 'delegated')
    )
    SELECT 1 FROM descendants WHERE attempt_id = NEW.parent_attempt_id
  ) THEN
    RAISE EXCEPTION 'session attempt execution edge would create a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_prevent_session_attempt_edge_cycle ON session_attempt_edges;
CREATE TRIGGER trg_prevent_session_attempt_edge_cycle
  BEFORE INSERT OR UPDATE OF parent_attempt_id, child_attempt_id, relationship, invalidated_at
  ON session_attempt_edges FOR EACH ROW EXECUTE FUNCTION prevent_session_attempt_edge_cycle();

CREATE TABLE IF NOT EXISTS task_attempt_links (
  link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  subtask_index INTEGER,
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('implementation', 'review', 'orchestration', 'research', 'monitor', 'notification', 'unknown')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  link_state TEXT NOT NULL CHECK (link_state IN ('claimed', 'bound', 'released', 'superseded', 'unresolved')),
  source TEXT NOT NULL CHECK (source IN ('task_spawn', 'runtime_callback', 'operator', 'backfill', 'legacy_field')),
  evidence_ref TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  UNIQUE (task_id, attempt_id, role),
  UNIQUE (task_id, role, attempt_number),
  FOREIGN KEY (task_id, subtask_index) REFERENCES subtasks(task_id, index) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS task_attempt_ownership (
  ownership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  subtask_index INTEGER,
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('writer', 'reviewer', 'read_only')),
  lease_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  evidence_ref TEXT NOT NULL,
  FOREIGN KEY (task_id, subtask_index) REFERENCES subtasks(task_id, index) ON DELETE RESTRICT,
  CHECK (expires_at > acquired_at),
  CHECK (released_at IS NULL OR released_at >= acquired_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_attempt_ownership_writer
  ON task_attempt_ownership(task_id, COALESCE(subtask_index, -1))
  WHERE ownership_kind = 'writer' AND released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_attempt_ownership_fence
  ON task_attempt_ownership(task_id, COALESCE(subtask_index, -1), fencing_token);

CREATE TABLE IF NOT EXISTS attempt_project_links (
  link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  source TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalidated_at TIMESTAMPTZ,
  UNIQUE (attempt_id, project_id, role, source, evidence_ref)
);

CREATE TABLE IF NOT EXISTS attempt_persona_links (
  link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  agent_type_id UUID NOT NULL REFERENCES agent_types(id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  evidence_ref TEXT NOT NULL,
  UNIQUE (attempt_id, agent_type_id, source, valid_from),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE TABLE IF NOT EXISTS session_observations (
  observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  observation_kind TEXT NOT NULL,
  source_occurred_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provenance JSONB NOT NULL,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_session_observations_attempt_time ON session_observations(attempt_id, ingested_at);

CREATE TABLE IF NOT EXISTS session_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  stream_generation TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('message', 'tool_call', 'tool_result', 'usage', 'lifecycle', 'control', 'error', 'other')),
  source_event_id TEXT,
  source_sequence NUMERIC,
  source_occurred_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  redaction_policy_version TEXT NOT NULL,
  correlation_id TEXT,
  parent_event_id UUID REFERENCES session_events(event_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_session_events_attempt_order
  ON session_events(attempt_id, source_occurred_at, source_sequence, ingested_at, event_id);

CREATE TABLE IF NOT EXISTS session_ingestion_cursors (
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  stream_generation TEXT NOT NULL,
  cursor_position NUMERIC NOT NULL CHECK (cursor_position >= 0),
  cursor_value TEXT NOT NULL,
  source_checksum TEXT NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, source_instance, stream_generation)
);
COMMENT ON TABLE session_ingestion_cursors IS 'Monotonic source scan receipts committed atomically with canonical events.';

CREATE TABLE IF NOT EXISTS session_event_gaps (
  gap_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  stream_generation TEXT NOT NULL,
  gap_kind TEXT NOT NULL,
  expected_from TEXT,
  expected_to TEXT,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution_receipt JSONB,
  UNIQUE (source, source_instance, stream_generation, gap_kind, expected_from, expected_to)
);

CREATE TABLE IF NOT EXISTS session_quarantine (
  quarantine_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  source_key_hash TEXT NOT NULL CHECK (source_key_hash ~ '^[0-9a-f]{64}$'),
  payload_hash TEXT CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  resolved_at TIMESTAMPTZ,
  UNIQUE (source, source_instance, reason_code, source_key_hash, payload_hash)
);

CREATE TABLE IF NOT EXISTS session_projections (
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  projection_version TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  runtime_state TEXT NOT NULL,
  availability TEXT NOT NULL,
  freshness TEXT NOT NULL,
  confidence TEXT NOT NULL,
  transcript_completeness TEXT NOT NULL,
  task_disposition TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_provenance JSONB NOT NULL,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (attempt_id, projection_version)
);

CREATE TABLE IF NOT EXISTS session_projection_cursors (
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  stream_generation TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  contiguous_cursor TEXT,
  gap_version BIGINT NOT NULL DEFAULT 0 CHECK (gap_version >= 0),
  lease_owner TEXT,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  fencing_token BIGINT NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  checksum TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, source_instance, stream_generation, projection_version)
);

CREATE TABLE IF NOT EXISTS session_adapter_health (
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'unavailable', 'unauthorized', 'unknown')),
  reason_code TEXT,
  last_source_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL,
  safe_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source, source_instance)
);

CREATE TABLE IF NOT EXISTS session_commands (
  command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  command_kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  expected_projection_revision BIGINT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'delivering', 'delivered', 'confirmed', 'failed', 'expired')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  safe_result JSONB
);

CREATE TABLE IF NOT EXISTS session_command_deliveries (
  delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL REFERENCES session_commands(command_id) ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  transport TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'acknowledged', 'confirmed', 'failed', 'timed_out')),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  evidence_ref TEXT,
  safe_error_code TEXT,
  UNIQUE (command_id, attempt_no),
  UNIQUE (command_id, fencing_token)
);

CREATE TABLE IF NOT EXISTS session_usage_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  authority TEXT NOT NULL CHECK (authority IN ('provider', 'gateway', 'derived', 'legacy')),
  scope TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  includes_children BOOLEAN NOT NULL DEFAULT FALSE,
  source_event_id UUID REFERENCES session_events(event_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  observed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS session_projection_outbox (
  outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  projection_version TEXT NOT NULL,
  projection_revision BIGINT NOT NULL CHECK (projection_revision >= 0),
  event_kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  UNIQUE (attempt_id, projection_version, projection_revision, event_kind)
);
CREATE INDEX IF NOT EXISTS idx_session_projection_outbox_pending
  ON session_projection_outbox(created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS session_backfill_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  algorithm_version TEXT NOT NULL,
  source TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  source_window JSONB NOT NULL,
  source_window_hash TEXT NOT NULL CHECK (source_window_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  lease_owner TEXT,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  cursor JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (algorithm_version, source, source_instance, source_window_hash)
);

CREATE TABLE IF NOT EXISTS session_backfill_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES session_backfill_runs(run_id) ON DELETE RESTRICT,
  batch_key TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  output_checksum TEXT NOT NULL,
  scanned_count BIGINT NOT NULL CHECK (scanned_count >= 0),
  inserted_count BIGINT NOT NULL CHECK (inserted_count >= 0),
  duplicate_count BIGINT NOT NULL CHECK (duplicate_count >= 0),
  quarantined_count BIGINT NOT NULL CHECK (quarantined_count >= 0),
  gap_count BIGINT NOT NULL CHECK (gap_count >= 0),
  cursor_after JSONB NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, batch_key),
  CHECK (inserted_count + duplicate_count + quarantined_count + gap_count <= scanned_count)
);

CREATE TABLE IF NOT EXISTS session_retention_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version TEXT NOT NULL,
  attempt_id UUID REFERENCES session_attempts(attempt_id) ON DELETE RESTRICT,
  payload_class TEXT NOT NULL,
  source_event_id UUID REFERENCES session_events(event_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('expired', 'erased', 'tombstoned', 'protected')),
  copies_examined INTEGER NOT NULL CHECK (copies_examined >= 0),
  copies_removed INTEGER NOT NULL CHECK (copies_removed >= 0),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (copies_removed <= copies_examined)
);

COMMENT ON TABLE session_attempts IS 'Canonical execution attempts; legacy session rows remain source evidence.';
COMMENT ON TABLE session_events IS 'Immutable redacted dual-harness event envelope with exact replay identity.';
COMMENT ON TABLE task_attempt_ownership IS 'Fenced current ownership; existence does not imply liveness.';
COMMENT ON TABLE session_quarantine IS 'Fail-closed poison/collision evidence without raw secret-bearing payloads.';
