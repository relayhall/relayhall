-- 090_lifecycle_policy_decisions.sql
-- RH-P2.13: generic lifecycle-policy evaluator seam. This is contract and
-- evidence storage only; no deployment-specific rule package is installed here.

CREATE TABLE lifecycle_policy_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
  subject_kind TEXT NOT NULL CHECK (subject_kind ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  subject_revision TEXT CHECK (subject_revision IS NULL OR length(subject_revision) BETWEEN 1 AND 256),
  environment TEXT NOT NULL CHECK (environment ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
  mode TEXT NOT NULL CHECK (mode IN ('observe', 'enforce')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'warn', 'deny')),
  effective_decision TEXT NOT NULL CHECK (effective_decision IN ('allow', 'deny')),
  evaluator_id TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  control_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reason_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  remediation TEXT CHECK (remediation IS NULL OR length(remediation) <= 1000),
  exception_id UUID,
  exception_owner TEXT CHECK (exception_owner IS NULL OR length(exception_owner) BETWEEN 1 AND 256),
  exception_expires_at TIMESTAMPTZ,
  exception_disposition TEXT NOT NULL DEFAULT 'none'
    CHECK (exception_disposition IN ('none', 'applied', 'expired', 'invalid')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 4096),
  CHECK ((exception_id IS NULL) = (exception_owner IS NULL)),
  CHECK ((exception_id IS NULL) = (exception_expires_at IS NULL)),
  CHECK (cardinality(control_ids) <= 32),
  CHECK (cardinality(reason_ids) <= 32)
);

CREATE INDEX ix_lifecycle_policy_decisions_order
  ON lifecycle_policy_decisions (occurred_at DESC, id DESC);
CREATE INDEX ix_lifecycle_policy_decisions_subject
  ON lifecycle_policy_decisions (subject_kind, subject_id, occurred_at DESC, id DESC);
CREATE INDEX ix_lifecycle_policy_decisions_control_ids
  ON lifecycle_policy_decisions USING GIN (control_ids);

CREATE OR REPLACE FUNCTION reject_lifecycle_policy_decision_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'lifecycle_policy_decisions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lifecycle_policy_decisions_no_update_delete
BEFORE UPDATE OR DELETE ON lifecycle_policy_decisions
FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_policy_decision_mutation();

CREATE TRIGGER trg_lifecycle_policy_decisions_no_truncate
BEFORE TRUNCATE ON lifecycle_policy_decisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_lifecycle_policy_decision_mutation();

ALTER TABLE lifecycle_policy_decisions ENABLE ALWAYS TRIGGER trg_lifecycle_policy_decisions_no_update_delete;
ALTER TABLE lifecycle_policy_decisions ENABLE ALWAYS TRIGGER trg_lifecycle_policy_decisions_no_truncate;

COMMENT ON TABLE lifecycle_policy_decisions IS
  'Append-only RH-P2.13 policy decision evidence. Inputs and credentials are deliberately not stored.';
