-- Ordinary execution participation is separate from verification and canonical attempts.
CREATE TABLE task_native_assignment_epochs (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  epoch BIGINT NOT NULL DEFAULT 1 CHECK (epoch > 0)
);
INSERT INTO task_native_assignment_epochs(task_id) SELECT id FROM tasks;

CREATE TABLE task_native_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assignment_epoch BIGINT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'implementation' CHECK (purpose='implementation'),
  actor_principal_id UUID NOT NULL REFERENCES principals(id),
  connector_id UUID NOT NULL REFERENCES principals(id),
  account_id UUID NOT NULL REFERENCES principals(id),
  agent_id UUID REFERENCES principals(id),
  service_id UUID NOT NULL REFERENCES services(id),
  descriptor_version INTEGER NOT NULL,
  source_product TEXT NOT NULL,
  dispatch_key UUID NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  run_ordinal INTEGER NOT NULL CHECK (run_ordinal>0),
  state TEXT NOT NULL DEFAULT 'opened' CHECK (state IN ('opened','launch_authorized','running','uncertain','closed','cancelled','ownership_lost','stopped_unresolved')),
  lease_hash TEXT NOT NULL CHECK (lease_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  hard_deadline TIMESTAMPTZ NOT NULL,
  launch_key UUID,
  launch_authorized_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  session_expires_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('completed','failed','cancelled')),
  report_id UUID REFERENCES reports(id),
  close_digest TEXT,
  reconciliation JSONB,
  UNIQUE(task_id,run_ordinal)
);
-- Ownership loss cannot permit another provider until the old tree is reconciled.
CREATE UNIQUE INDEX task_native_execution_one_active ON task_native_executions(task_id)
  WHERE state IN ('opened','launch_authorized','running','uncertain','ownership_lost');
CREATE TABLE task_native_execution_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES task_native_executions(id) ON DELETE CASCADE,
  slot_id UUID NOT NULL,
  parent_slot_id UUID,
  relationship TEXT NOT NULL CHECK (relationship IN ('primary','resumed','child')),
  connector_id UUID NOT NULL REFERENCES principals(id),
  account_id UUID NOT NULL REFERENCES principals(id),
  source_product TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  pepper_id TEXT NOT NULL,
  attestation_kind TEXT NOT NULL DEFAULT 'native_init_observed' CHECK(attestation_kind='native_init_observed'),
  attested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(execution_id,slot_id,pepper_id),
  CHECK(parent_slot_id IS DISTINCT FROM slot_id)
);
CREATE INDEX task_native_execution_sessions_expiry ON task_native_execution_sessions(expires_at);

CREATE FUNCTION native_execution_assignment_epoch() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO task_native_assignment_epochs(task_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
  ELSIF ROW(NEW.owner_principal_id,NEW.execution_service_id,NEW.execution_descriptor_version,NEW.execution_profile,NEW.execution_warrant_id)
    IS DISTINCT FROM ROW(OLD.owner_principal_id,OLD.execution_service_id,OLD.execution_descriptor_version,OLD.execution_profile,OLD.execution_warrant_id) THEN
    UPDATE task_native_assignment_epochs SET epoch=epoch+1 WHERE task_id=NEW.id;
    UPDATE task_native_executions SET state='ownership_lost'
      WHERE task_id=NEW.id AND state IN ('opened','launch_authorized','running','uncertain');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_execution_assignment_epoch AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION native_execution_assignment_epoch();
COMMENT ON TABLE task_native_execution_sessions IS 'TS-9 pseudonymized participation only; no raw native IDs, transcript, inferred attempts or exclusive Task usage.';
