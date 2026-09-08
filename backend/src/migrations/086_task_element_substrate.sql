-- 086_task_element_substrate.sql
-- RH-P2.11: additive Task-element target substrate. This migration does not
-- drop or rewrite any legacy Task surface; compatibility adapters switch only
-- after backfill and parity proofs pass.

-- ── Assignment: current roles, lease-facing arming state ───────────────────
CREATE TABLE IF NOT EXISTS task_assignments (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  claimant_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  shepherd_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  verifier_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  current_lease_id UUID REFERENCES task_execution_leases(id) ON DELETE SET NULL,
  armed BOOLEAN NOT NULL DEFAULT FALSE,
  parked_reason TEXT,
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (claimant_principal_id IS NULL OR verifier_principal_id IS NULL OR claimant_principal_id <> verifier_principal_id)
);

CREATE OR REPLACE FUNCTION validate_task_assignment_current_lease()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_lease_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_execution_leases lease
     WHERE lease.id = NEW.current_lease_id
       AND lease.task_id = NEW.task_id
       AND lease.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Current lease % is not active for Task %', NEW.current_lease_id, NEW.task_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_assignments_current_lease ON task_assignments;
CREATE TRIGGER trg_task_assignments_current_lease
BEFORE INSERT OR UPDATE OF task_id, current_lease_id ON task_assignments
FOR EACH ROW EXECUTE FUNCTION validate_task_assignment_current_lease();

INSERT INTO task_assignments (
  task_id, claimant_principal_id, shepherd_principal_id,
  verifier_principal_id, current_lease_id, armed, updated_at
)
SELECT tasks.id, tasks.owner_principal_id, tasks.shepherd_principal_id,
       verifier_principal_id, lease.id, COALESCE(auto_start, FALSE), COALESCE(tasks.updated_at, NOW())
FROM tasks
LEFT JOIN LATERAL (
  SELECT id FROM task_execution_leases
  WHERE task_id = tasks.id AND status = 'active'
  ORDER BY acquired_at DESC LIMIT 1
) lease ON TRUE
ON CONFLICT (task_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS ix_task_assignments_claimant ON task_assignments(claimant_principal_id);
CREATE INDEX IF NOT EXISTS ix_task_assignments_shepherd ON task_assignments(shepherd_principal_id);
CREATE INDEX IF NOT EXISTS ix_task_assignments_verifier ON task_assignments(verifier_principal_id);
CREATE INDEX IF NOT EXISTS ix_task_assignments_lease ON task_assignments(current_lease_id) WHERE current_lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_task_assignments_ready ON task_assignments(armed, task_id) WHERE armed;

-- Compatibility mirror: legacy writers remain authoritative for one release,
-- while every insert/update also keeps the new side-record current.
CREATE OR REPLACE FUNCTION mirror_task_assignment_compat()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO task_assignments (
    task_id, claimant_principal_id, shepherd_principal_id,
    verifier_principal_id, armed, updated_at
  ) VALUES (
    NEW.id, NEW.owner_principal_id, NEW.shepherd_principal_id,
    NEW.verifier_principal_id, COALESCE(NEW.auto_start, FALSE), COALESCE(NEW.updated_at, NOW())
  )
  ON CONFLICT (task_id) DO UPDATE SET
    claimant_principal_id = EXCLUDED.claimant_principal_id,
    shepherd_principal_id = EXCLUDED.shepherd_principal_id,
    verifier_principal_id = EXCLUDED.verifier_principal_id,
    armed = EXCLUDED.armed,
    revision = CASE
      WHEN (task_assignments.claimant_principal_id, task_assignments.shepherd_principal_id,
            task_assignments.verifier_principal_id, task_assignments.armed)
        IS DISTINCT FROM
           (EXCLUDED.claimant_principal_id, EXCLUDED.shepherd_principal_id,
            EXCLUDED.verifier_principal_id, EXCLUDED.armed)
      THEN gen_random_uuid() ELSE task_assignments.revision END,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_assignment_compat ON tasks;
CREATE TRIGGER trg_tasks_assignment_compat
AFTER INSERT OR UPDATE OF owner_principal_id, shepherd_principal_id,
  verifier_principal_id, auto_start, updated_at ON tasks
FOR EACH ROW EXECUTE FUNCTION mirror_task_assignment_compat();

CREATE OR REPLACE FUNCTION mirror_task_assignment_lease_compat()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' THEN
    UPDATE task_assignments
       SET current_lease_id = NEW.id, revision = gen_random_uuid(), updated_at = NOW()
     WHERE task_id = NEW.task_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'active' AND NEW.status <> 'active' THEN
      UPDATE task_assignments
         SET current_lease_id = NULL, revision = gen_random_uuid(), updated_at = NOW()
       WHERE task_id = NEW.task_id AND current_lease_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_execution_lease_assignment_compat ON task_execution_leases;
CREATE TRIGGER trg_task_execution_lease_assignment_compat
AFTER INSERT OR UPDATE OF status ON task_execution_leases
FOR EACH ROW EXECUTE FUNCTION mirror_task_assignment_lease_compat();

-- ── Execution profile: immutable descriptor/schema pin + declared values ──
CREATE TABLE IF NOT EXISTS task_execution_profiles (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE RESTRICT,
  descriptor_version INTEGER CHECK (descriptor_version IS NULL OR descriptor_version >= 1),
  options JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  secret_references JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(secret_references) = 'object'),
  legacy_profile JSONB,
  schema_status TEXT NOT NULL DEFAULT 'active' CHECK (schema_status IN ('active', 'deprecated', 'retired')),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (service_id IS NULL AND descriptor_version IS NULL) OR
    (service_id IS NOT NULL AND descriptor_version IS NOT NULL)
  )
);

INSERT INTO task_execution_profiles (
  task_id, service_id, descriptor_version, options, legacy_profile, updated_at
)
SELECT id, execution_service_id, execution_descriptor_version,
       CASE WHEN execution_service_id IS NOT NULL
                 AND jsonb_typeof(execution_profile->'options') = 'object'
            THEN execution_profile->'options'
            ELSE '{}'::jsonb END,
       CASE WHEN execution_profile IS NOT NULL AND execution_service_id IS NULL
            THEN execution_profile ELSE NULL END,
       COALESCE(updated_at, NOW())
FROM tasks
WHERE execution_profile IS NOT NULL OR execution_service_id IS NOT NULL
ON CONFLICT (task_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS ix_task_execution_profiles_service
  ON task_execution_profiles(service_id) WHERE service_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mirror_task_execution_profile_compat()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.execution_profile IS NULL AND NEW.execution_service_id IS NULL THEN
    DELETE FROM task_execution_profiles WHERE task_id = NEW.id;
    RETURN NEW;
  END IF;
  INSERT INTO task_execution_profiles (
    task_id, service_id, descriptor_version, options, legacy_profile, updated_at
  ) VALUES (
    NEW.id, NEW.execution_service_id, NEW.execution_descriptor_version,
    CASE WHEN NEW.execution_service_id IS NOT NULL
              AND jsonb_typeof(NEW.execution_profile->'options') = 'object'
         THEN NEW.execution_profile->'options' ELSE '{}'::jsonb END,
    CASE WHEN NEW.execution_profile IS NOT NULL AND NEW.execution_service_id IS NULL
         THEN NEW.execution_profile ELSE NULL END,
    COALESCE(NEW.updated_at, NOW())
  )
  ON CONFLICT (task_id) DO UPDATE SET
    service_id = EXCLUDED.service_id,
    descriptor_version = EXCLUDED.descriptor_version,
    options = EXCLUDED.options,
    legacy_profile = EXCLUDED.legacy_profile,
    revision = CASE
      WHEN (task_execution_profiles.service_id, task_execution_profiles.descriptor_version,
            task_execution_profiles.options, task_execution_profiles.legacy_profile)
        IS DISTINCT FROM
           (EXCLUDED.service_id, EXCLUDED.descriptor_version,
            EXCLUDED.options, EXCLUDED.legacy_profile)
      THEN gen_random_uuid() ELSE task_execution_profiles.revision END,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_execution_profile_compat ON tasks;
CREATE TRIGGER trg_tasks_execution_profile_compat
AFTER INSERT OR UPDATE OF execution_profile, execution_service_id,
  execution_descriptor_version, updated_at ON tasks
FOR EACH ROW EXECUTE FUNCTION mirror_task_execution_profile_compat();

-- ── Review side-record: task_review_attempts remains the attempt ledger ───
-- The composite key prevents a Task from pointing at another Task's attempt.
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_review_attempts_task_id_id
  ON task_review_attempts(task_id, id);

CREATE TABLE IF NOT EXISTS task_review_state (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  current_attempt_id UUID,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (task_id, current_attempt_id)
    REFERENCES task_review_attempts(task_id, id) ON DELETE SET NULL (current_attempt_id)
);

INSERT INTO task_review_state (task_id, current_attempt_id, retry_count, updated_at)
SELECT t.id, latest.id, COALESCE(t.attempt_count, 0), COALESCE(t.updated_at, NOW())
FROM tasks t
LEFT JOIN LATERAL (
  SELECT a.id FROM task_review_attempts a
  WHERE a.task_id = t.id ORDER BY a.attempt_no DESC LIMIT 1
) latest ON TRUE
ON CONFLICT (task_id) DO NOTHING;

CREATE OR REPLACE FUNCTION initialize_task_review_state()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO task_review_state (task_id, retry_count, updated_at)
  VALUES (NEW.id, COALESCE(NEW.attempt_count, 0), COALESCE(NEW.updated_at, NOW()))
  ON CONFLICT (task_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_review_state_init ON tasks;
CREATE TRIGGER trg_tasks_review_state_init
AFTER INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION initialize_task_review_state();

CREATE OR REPLACE FUNCTION mirror_task_review_attempt_state()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO task_review_state (task_id, current_attempt_id, retry_count, updated_at)
  VALUES (NEW.task_id, NEW.id, GREATEST(NEW.attempt_no - 1, 0), NOW())
  ON CONFLICT (task_id) DO UPDATE SET
    current_attempt_id = CASE
      WHEN NEW.attempt_no >= COALESCE((
        SELECT attempt_no FROM task_review_attempts
        WHERE id = task_review_state.current_attempt_id
      ), 0)
      THEN NEW.id ELSE task_review_state.current_attempt_id END,
    retry_count = GREATEST(task_review_state.retry_count, NEW.attempt_no - 1),
    revision = gen_random_uuid(),
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_review_attempt_state ON task_review_attempts;
CREATE TRIGGER trg_task_review_attempt_state
AFTER INSERT OR UPDATE OF status, verdict, findings, finished_at ON task_review_attempts
FOR EACH ROW EXECUTE FUNCTION mirror_task_review_attempt_state();

-- ── One immutable, ordered Task stream ────────────────────────────────────
-- Oversized entries normally promote to Reports. If a promotion rate/storage
-- cap is exhausted, the append still succeeds and the full bytes are held in
-- this owner-plane-only quarantine instead of being lost or returned as an
-- error to a one-shot worker.
CREATE TABLE IF NOT EXISTS task_stream_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  author_principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK (provenance IN ('authored', 'reported')),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK (reason IN ('rate-cap', 'storage-cap')),
  effective_visibility TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_stream_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_offset BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK (provenance IN ('system', 'authored', 'reported', 'legacy')),
  event_type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  author_principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT,
  author_handle TEXT,
  author_role TEXT CHECK (author_role IS NULL OR author_role IN ('claimant', 'shepherd', 'verifier', 'other')),
  outpost_service_id UUID REFERENCES services(id) ON DELETE RESTRICT,
  outpost_visibility_tier TEXT,
  referenced_entry_id UUID REFERENCES task_stream_entries(id) ON DELETE RESTRICT,
  report_id UUID REFERENCES reports(id) ON DELETE RESTRICT,
  quarantine_id UUID REFERENCES task_stream_quarantine(id) ON DELETE RESTRICT,
  auto_promoted BOOLEAN NOT NULL DEFAULT FALSE,
  safety_signal BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  legacy_source TEXT,
  legacy_source_id TEXT,
  redacted_at TIMESTAMPTZ,
  redacted_by_principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT,
  redaction_mode TEXT CHECK (redaction_mode IS NULL OR redaction_mode IN ('span', 'tombstone', 'author-erasure')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (legacy_source, legacy_source_id),
  CHECK ((provenance = 'reported') = (outpost_service_id IS NOT NULL)),
  CHECK (outpost_visibility_tier IS NULL OR outpost_visibility_tier IN ('assigned-only', 'unrestricted')),
  CHECK (NOT auto_promoted OR report_id IS NOT NULL OR quarantine_id IS NOT NULL),
  CHECK (report_id IS NULL OR quarantine_id IS NULL),
  CHECK ((redacted_at IS NULL) = (redaction_mode IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_task_stream_task_order
  ON task_stream_entries(task_id, stream_offset);
CREATE INDEX IF NOT EXISTS ix_task_stream_provenance
  ON task_stream_entries(task_id, provenance, stream_offset);
CREATE INDEX IF NOT EXISTS ix_task_stream_report
  ON task_stream_entries(report_id) WHERE report_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_stream_redactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_entry_id UUID NOT NULL REFERENCES task_stream_entries(id) ON DELETE RESTRICT,
  redacted_by_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('span', 'tombstone', 'author-erasure')),
  reason_category TEXT NOT NULL CHECK (reason_category IN ('secret-hygiene', 'personal-data', 'owner-order')),
  destroyed_bytes_hmac TEXT NOT NULL CHECK (destroyed_bytes_hmac ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION enforce_task_stream_immutability()
RETURNS TRIGGER AS $$
DECLARE
  actor UUID;
  mode_value TEXT;
  reason_value TEXT;
  fingerprint TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Task stream entries are append-only';
  END IF;
  actor := NULLIF(current_setting('relayhall.stream_redaction_actor', TRUE), '')::uuid;
  mode_value := NULLIF(current_setting('relayhall.stream_redaction_mode', TRUE), '');
  reason_value := NULLIF(current_setting('relayhall.stream_redaction_reason', TRUE), '');
  fingerprint := NULLIF(current_setting('relayhall.stream_redaction_hmac', TRUE), '');
  IF actor IS NULL OR mode_value IS NULL OR reason_value IS NULL OR fingerprint IS NULL THEN
    RAISE EXCEPTION 'Task stream entries are immutable outside attributed redaction';
  END IF;
  IF mode_value NOT IN ('span', 'tombstone', 'author-erasure')
     OR reason_value NOT IN ('secret-hygiene', 'personal-data', 'owner-order')
     OR fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid Task stream redaction context';
  END IF;
  IF OLD.redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Task stream entry is already redacted';
  END IF;
  IF (NEW.id, NEW.stream_offset, NEW.task_id, NEW.provenance, NEW.event_type,
      NEW.outpost_service_id, NEW.outpost_visibility_tier, NEW.referenced_entry_id,
      NEW.report_id, NEW.quarantine_id, NEW.auto_promoted, NEW.safety_signal, NEW.metadata,
      NEW.legacy_source, NEW.legacy_source_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.stream_offset, OLD.task_id, OLD.provenance, OLD.event_type,
      OLD.outpost_service_id, OLD.outpost_visibility_tier, OLD.referenced_entry_id,
      OLD.report_id, OLD.quarantine_id, OLD.auto_promoted, OLD.safety_signal, OLD.metadata,
      OLD.legacy_source, OLD.legacy_source_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Redaction may change content/author display only';
  END IF;
  IF mode_value IN ('span', 'tombstone') AND
     (NEW.author_principal_id, NEW.author_handle, NEW.author_role)
       IS DISTINCT FROM
     (OLD.author_principal_id, OLD.author_handle, OLD.author_role) THEN
    RAISE EXCEPTION 'Content redaction may not alter author attribution';
  END IF;
  IF mode_value = 'author-erasure' AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'Author erasure may not alter entry content';
  END IF;
  NEW.redacted_at := NOW();
  NEW.redacted_by_principal_id := actor;
  NEW.redaction_mode := mode_value;
  INSERT INTO task_stream_redactions (
    stream_entry_id, redacted_by_principal_id, mode, reason_category, destroyed_bytes_hmac
  ) VALUES (OLD.id, actor, mode_value, reason_value, fingerprint);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_stream_immutable ON task_stream_entries;
CREATE TRIGGER trg_task_stream_immutable
BEFORE UPDATE OR DELETE ON task_stream_entries
FOR EACH ROW EXECUTE FUNCTION enforce_task_stream_immutability();

-- Legacy imports never assert server observation. Their original table/id is
-- retained so replay is idempotent and provenance remains inspectable.
WITH legacy_entries AS (
  SELECT h.task_id, h.event_type,
         concat_ws(E'\n', NULLIF(h.note, ''),
           CASE WHEN h.old_value IS NOT NULL THEN 'old=' || h.old_value END,
           CASE WHEN h.new_value IS NOT NULL THEN 'new=' || h.new_value END) AS content,
         h.actor_principal_id AS author_principal_id, NULL::TEXT AS author_handle,
         jsonb_build_object('taskTitle', h.task_title) AS metadata,
         'task_history'::TEXT AS legacy_source, h.id::text AS legacy_source_id,
         COALESCE(h.created_at, NOW()) AS created_at
    FROM task_history h
  UNION ALL
  SELECT e.task_id, e.event_type,
         concat_ws(E'\n', NULLIF(e.title, ''), NULLIF(e.description, '')) AS content,
         e.actor_principal_id, e.actor AS author_handle,
         COALESCE(e.metadata, '{}'::jsonb) || jsonb_build_object(
           'legacySessionKey', e.session_key, 'legacyHarness', e.harness
         ) AS metadata,
         'task_timeline_events'::TEXT AS legacy_source, e.id::text AS legacy_source_id,
         e.created_at
    FROM task_timeline_events e
)
INSERT INTO task_stream_entries (
  task_id, provenance, event_type, content, author_principal_id,
  author_handle, metadata, legacy_source, legacy_source_id, created_at
)
SELECT task_id, 'legacy', event_type, content, author_principal_id,
       author_handle, metadata, legacy_source, legacy_source_id, created_at
FROM legacy_entries
ORDER BY created_at, legacy_source, legacy_source_id
ON CONFLICT (legacy_source, legacy_source_id) DO NOTHING;

CREATE OR REPLACE VIEW task_history_view AS
SELECT * FROM task_stream_entries WHERE provenance = 'system';

CREATE OR REPLACE VIEW task_handover_view AS
SELECT * FROM task_stream_entries
WHERE provenance = 'authored' AND author_role IN ('claimant', 'shepherd', 'verifier');

CREATE OR REPLACE VIEW task_timeline_view AS
SELECT * FROM task_stream_entries;

-- Auto-promoted Reports remain visibly distinguishable and retain the exact
-- visibility inputs used by the stream read intersection rule.
ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS auto_promoted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source_task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_stream_entry_id UUID REFERENCES task_stream_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_outpost_visibility_tier TEXT CHECK (
    source_outpost_visibility_tier IS NULL OR source_outpost_visibility_tier IN ('assigned-only', 'unrestricted')
  );

-- ── Outpost-reported session observations ────────────────────────────────
CREATE TABLE IF NOT EXISTS task_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  outpost_service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  external_session_id TEXT NOT NULL,
  visibility_tier TEXT NOT NULL DEFAULT 'unrestricted' CHECK (visibility_tier IN ('assigned-only', 'unrestricted')),
  state TEXT NOT NULL DEFAULT 'reported' CHECK (state IN ('reported', 'active', 'ended', 'failed')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (outpost_service_id, external_session_id)
);
CREATE INDEX IF NOT EXISTS ix_task_observations_task ON task_observations(task_id, reported_at DESC);

-- Canonical attempt links historically point at display order. Pin their
-- stable Subtask identity as well, then keep the positional compatibility
-- column synchronized for older readers during the one-release window.
ALTER TABLE task_attempt_links
  ADD COLUMN IF NOT EXISTS subtask_id INTEGER REFERENCES subtasks(id) ON DELETE RESTRICT;
ALTER TABLE task_attempt_ownership
  ADD COLUMN IF NOT EXISTS subtask_id INTEGER REFERENCES subtasks(id) ON DELETE RESTRICT;

-- Stable-id mirror triggers must be allowed to carry positional compatibility
-- references through an in-transaction reorder before the final positions are
-- checked at commit.
ALTER TABLE task_attempt_links
  ALTER CONSTRAINT task_attempt_links_task_id_subtask_index_fkey
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE task_attempt_ownership
  ALTER CONSTRAINT task_attempt_ownership_task_id_subtask_index_fkey
  DEFERRABLE INITIALLY IMMEDIATE;

UPDATE task_attempt_links link
SET subtask_id = subtask.id
FROM subtasks subtask
WHERE link.task_id = subtask.task_id
  AND link.subtask_index = subtask.index
  AND link.subtask_id IS NULL;

UPDATE task_attempt_ownership ownership
SET subtask_id = subtask.id
FROM subtasks subtask
WHERE ownership.task_id = subtask.task_id
  AND ownership.subtask_index = subtask.index
  AND ownership.subtask_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_task_attempt_links_subtask_id ON task_attempt_links(subtask_id);
CREATE INDEX IF NOT EXISTS ix_task_attempt_ownership_subtask_id ON task_attempt_ownership(subtask_id);

CREATE OR REPLACE FUNCTION resolve_attempt_link_subtask_compat()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.subtask_index IS DISTINCT FROM OLD.subtask_index THEN
    IF NEW.subtask_index IS NULL THEN
      NEW.subtask_id := NULL;
    ELSE
      SELECT id INTO NEW.subtask_id
      FROM subtasks
      WHERE task_id = NEW.task_id AND index = NEW.subtask_index;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Subtask display index % does not belong to Task %', NEW.subtask_index, NEW.task_id;
      END IF;
    END IF;
  ELSIF NEW.subtask_id IS NOT NULL THEN
    SELECT index INTO NEW.subtask_index
    FROM subtasks
    WHERE task_id = NEW.task_id AND id = NEW.subtask_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stable Subtask % does not belong to Task %', NEW.subtask_id, NEW.task_id;
    END IF;
  ELSIF NEW.subtask_index IS NULL THEN
    NEW.subtask_id := NULL;
  ELSE
    SELECT id INTO NEW.subtask_id
    FROM subtasks
    WHERE task_id = NEW.task_id AND index = NEW.subtask_index;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Subtask display index % does not belong to Task %', NEW.subtask_index, NEW.task_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_attempt_links_subtask_compat ON task_attempt_links;
CREATE TRIGGER trg_task_attempt_links_subtask_compat
BEFORE INSERT OR UPDATE OF task_id, subtask_index, subtask_id ON task_attempt_links
FOR EACH ROW EXECUTE FUNCTION resolve_attempt_link_subtask_compat();

DROP TRIGGER IF EXISTS trg_task_attempt_ownership_subtask_compat ON task_attempt_ownership;
CREATE TRIGGER trg_task_attempt_ownership_subtask_compat
BEFORE INSERT OR UPDATE OF task_id, subtask_index, subtask_id ON task_attempt_ownership
FOR EACH ROW EXECUTE FUNCTION resolve_attempt_link_subtask_compat();

CREATE OR REPLACE FUNCTION mirror_stable_subtask_display_index()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE task_attempt_links SET subtask_index = NEW.index WHERE subtask_id = NEW.id;
  UPDATE task_attempt_ownership SET subtask_index = NEW.index WHERE subtask_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subtasks_attempt_display_index_compat ON subtasks;
CREATE TRIGGER trg_subtasks_attempt_display_index_compat
AFTER UPDATE OF index ON subtasks
FOR EACH ROW WHEN (OLD.index IS DISTINCT FROM NEW.index)
EXECUTE FUNCTION mirror_stable_subtask_display_index();

-- ── Typed Task References; legacy task_links remains during compatibility ─
CREATE TABLE IF NOT EXISTS task_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('repository','environment','workspace','reference','report','task','skill','phase','session')
    OR kind ~ '^plugin:[a-z0-9][a-z0-9._-]{1,63}:[a-z0-9][a-z0-9._-]{1,63}$'
  ),
  target_id UUID,
  target_uri TEXT,
  label TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_by_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  original_task_link_id INTEGER UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (target_id IS NOT NULL OR NULLIF(target_uri, '') IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_task_references_task ON task_references(task_id, created_at, id);
CREATE INDEX IF NOT EXISTS ix_task_references_target ON task_references(kind, target_id) WHERE target_id IS NOT NULL;

INSERT INTO task_references (
  task_id, kind, target_id, target_uri, label, metadata,
  original_task_link_id, created_at
)
SELECT l.task_id,
       CASE l.type
         WHEN 'git' THEN 'repository'
         WHEN 'doc' THEN 'reference'
         WHEN 'report' THEN 'report'
         WHEN 'session' THEN 'session'
         WHEN 'tool' THEN 'skill'
         ELSE 'reference'
       END,
       CASE
         WHEN l.type = 'report' AND l.url ~* '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
         THEN substring(l.url from '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})')::uuid
         ELSE NULL
       END,
       l.url, l.title,
       jsonb_build_object('legacyKind', l.type, 'migration', '086'),
       l.id, COALESCE(l.created_at, NOW())
FROM task_links l
ON CONFLICT (original_task_link_id) DO NOTHING;

-- Legacy TaskLink writers remain live for one release. Mirror their mutations
-- into the typed sibling contract so compatibility writes cannot drift.
CREATE OR REPLACE FUNCTION mirror_task_link_reference_compat()
RETURNS TRIGGER AS $$
DECLARE
  mapped_kind TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM task_references WHERE original_task_link_id = OLD.id;
    RETURN OLD;
  END IF;
  mapped_kind := CASE NEW.type
    WHEN 'git' THEN 'repository'
    WHEN 'doc' THEN 'reference'
    WHEN 'report' THEN 'report'
    WHEN 'session' THEN 'session'
    WHEN 'tool' THEN 'skill'
    ELSE 'reference'
  END;
  INSERT INTO task_references (
    task_id, kind, target_id, target_uri, label, metadata,
    original_task_link_id, created_at
  ) VALUES (
    NEW.task_id, mapped_kind,
    CASE
      WHEN NEW.type = 'report' AND NEW.url ~* '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
      THEN substring(NEW.url from '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})')::uuid
      ELSE NULL
    END,
    NEW.url, NEW.title,
    jsonb_build_object('legacyKind', NEW.type, 'compatibilityMirror', TRUE),
    NEW.id, COALESCE(NEW.created_at, NOW())
  )
  ON CONFLICT (original_task_link_id) DO UPDATE SET
    task_id = EXCLUDED.task_id,
    kind = EXCLUDED.kind,
    target_id = EXCLUDED.target_id,
    target_uri = EXCLUDED.target_uri,
    label = EXCLUDED.label,
    metadata = EXCLUDED.metadata;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_links_reference_compat ON task_links;
CREATE TRIGGER trg_task_links_reference_compat
AFTER INSERT OR UPDATE OR DELETE ON task_links
FOR EACH ROW EXECUTE FUNCTION mirror_task_link_reference_compat();

-- R6 prevention control: human-only API/UI owns mutation; agents receive no
-- route or scope for it. Deployment-wide default remains environment-owned.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS task_stream_masking_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- The design's only destructive cleanup is permitted only after the database
-- itself proves the dormant table is empty. A populated estate fails closed.
DO $$
BEGIN
  IF to_regclass('public.thoughts') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM thoughts LIMIT 1) THEN
      RAISE EXCEPTION '086 refuses to drop non-empty thoughts table';
    END IF;
    DROP TABLE thoughts;
  END IF;
END $$;

COMMENT ON TABLE task_assignments IS 'RH-P2.11 Task Assignment side-record: current claimant, Shepherd, Verifier and arming state.';
COMMENT ON TABLE task_execution_profiles IS 'RH-P2.11 connector/schema pin and declared option/secret-reference names; never secret bytes.';
COMMENT ON TABLE task_review_state IS 'RH-P2.11 current Review pointer; task_review_attempts remains the immutable attempt ledger.';
COMMENT ON TABLE task_stream_entries IS 'RH-P2.11 single ordered Task stream. Append-only except attributed root-only redaction.';
COMMENT ON TABLE task_observations IS 'RH-P2.11 Outpost-reported Task session observations.';
COMMENT ON TABLE task_references IS 'RH-P2.11 typed sibling Reference contract. Dependencies remain separate.';
COMMENT ON COLUMN subtasks.id IS 'Stable Subtask addressing key. Legacy per-Task index remains display order and compatibility addressing for one release.';
