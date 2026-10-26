-- Protocol v2 is opt-in. Existing native executions retain protocol v1.
CREATE TABLE task_native_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id),
  actor_principal_id UUID NOT NULL REFERENCES principals(id),
  credential_id UUID NOT NULL REFERENCES principal_credentials(id),
  service_id UUID NOT NULL REFERENCES services(id),
  descriptor_version INTEGER NOT NULL CHECK(descriptor_version>0),
  reserved_epoch BIGINT NOT NULL CHECK(reserved_epoch>0),
  reserved_owner UUID,
  request_key UUID NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  task_digest TEXT NOT NULL CHECK(task_digest ~ '^[0-9a-f]{64}$'),
  source_digest TEXT NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
  input_digest TEXT NOT NULL CHECK(input_digest ~ '^[0-9a-f]{64}$'),
  predecessor_execution_id UUID REFERENCES task_native_executions(id),
  review_attempt_id UUID REFERENCES task_review_attempts(id),
  worker_instance_id UUID NOT NULL,
  worker_token_hash TEXT NOT NULL CHECK(worker_token_hash ~ '^[0-9a-f]{64}$'),
  claim_epoch BIGINT,
  claimed_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','consumed','finished')),
  execution_id UUID UNIQUE REFERENCES task_native_executions(id),
  bound_epoch BIGINT,
  consume_digest TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  publication_intent JSONB,
  CHECK(expires_at>created_at),
  CHECK((predecessor_execution_id IS NULL)=(review_attempt_id IS NULL)),
  CHECK((state='reserved' AND execution_id IS NULL AND consumed_at IS NULL AND consume_digest IS NULL AND bound_epoch IS NULL)
    OR(state IN('consumed','finished') AND execution_id IS NOT NULL AND consumed_at IS NOT NULL AND consume_digest ~ '^[0-9a-f]{64}$' AND bound_epoch>0))
);
CREATE UNIQUE INDEX task_native_generation_root ON task_native_generations(deployment_id,task_id) WHERE predecessor_execution_id IS NULL;
CREATE UNIQUE INDEX task_native_generation_successor ON task_native_generations(deployment_id,predecessor_execution_id) WHERE predecessor_execution_id IS NOT NULL;
CREATE UNIQUE INDEX task_native_generation_rejection ON task_native_generations(deployment_id,review_attempt_id) WHERE review_attempt_id IS NOT NULL;
CREATE TABLE task_native_import_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL,
  store_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id),
  snapshot_digest TEXT NOT NULL CHECK(snapshot_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest TEXT NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
  manifest JSONB NOT NULL,
  imported_by UUID NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(deployment_id,store_id,task_id)
);
-- No cutover/activation verb exists in this migration. Quarantine is a barrier.
CREATE FUNCTION preserve_native_generation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native generation evidence cannot be deleted' USING ERRCODE='PZ001'; END IF;
  IF ROW(NEW.id,NEW.deployment_id,NEW.task_id,NEW.actor_principal_id,NEW.credential_id,NEW.service_id,NEW.descriptor_version,
    NEW.reserved_epoch,NEW.reserved_owner,NEW.request_key,NEW.request_digest,NEW.task_digest,NEW.source_digest,NEW.input_digest,
    NEW.predecessor_execution_id,NEW.review_attempt_id,NEW.worker_instance_id,NEW.worker_token_hash,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.deployment_id,OLD.task_id,OLD.actor_principal_id,OLD.credential_id,OLD.service_id,OLD.descriptor_version,
    OLD.reserved_epoch,OLD.reserved_owner,OLD.request_key,OLD.request_digest,OLD.task_digest,OLD.source_digest,OLD.input_digest,
    OLD.predecessor_execution_id,OLD.review_attempt_id,OLD.worker_instance_id,OLD.worker_token_hash,OLD.created_at,OLD.expires_at)
    OR (OLD.state IN('consumed','finished') AND ROW(NEW.execution_id,NEW.bound_epoch,NEW.consume_digest,NEW.consumed_at)
      IS DISTINCT FROM ROW(OLD.execution_id,OLD.bound_epoch,OLD.consume_digest,OLD.consumed_at))
    OR (OLD.claimed_at IS NOT NULL AND ROW(NEW.claim_epoch,NEW.claimed_at) IS DISTINCT FROM ROW(OLD.claim_epoch,OLD.claimed_at))
    OR (OLD.publication_intent IS NOT NULL AND NEW.publication_intent IS DISTINCT FROM OLD.publication_intent)
    OR (OLD.state='finished' AND NEW.state<>'finished') OR (OLD.state='consumed' AND NEW.state='reserved')
  THEN RAISE EXCEPTION 'Native generation evidence is immutable' USING ERRCODE='PZ001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_native_generation_evidence BEFORE UPDATE OR DELETE ON task_native_generations
  FOR EACH ROW EXECUTE FUNCTION preserve_native_generation_evidence();
CREATE FUNCTION preserve_native_import_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Original quarantine evidence is immutable' USING ERRCODE='PZ001'; END $$;
CREATE TRIGGER preserve_native_import_quarantine BEFORE UPDATE OR DELETE ON task_native_import_quarantine
  FOR EACH ROW EXECUTE FUNCTION preserve_native_import_quarantine();
