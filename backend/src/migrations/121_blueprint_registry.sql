-- Blueprint v1.6 (ratified record 8af41017, A26 / AZ-A6).
-- The registry and retry ledger are independent of later lane migrations.
CREATE TABLE IF NOT EXISTS blueprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(key) BETWEEN 3 AND 64),
  published_version_id UUID,
  created_by_principal_id UUID NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS blueprint_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id UUID NOT NULL REFERENCES blueprints(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','retired')),
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  identity_sha256 TEXT NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
  author_principal_id UUID NOT NULL REFERENCES principals(id),
  status_note TEXT,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (blueprint_id, version),
  UNIQUE (blueprint_id, id)
);
DO $pointer$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='blueprints'::regclass AND conname='blueprints_published_version_fk') THEN
    ALTER TABLE blueprints ADD CONSTRAINT blueprints_published_version_fk
      FOREIGN KEY (id, published_version_id) REFERENCES blueprint_versions(blueprint_id, id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$pointer$;
CREATE TABLE IF NOT EXISTS blueprint_instantiations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id UUID NOT NULL REFERENCES blueprints(id),
  blueprint_version_id UUID NOT NULL REFERENCES blueprint_versions(id),
  root_project_id UUID NOT NULL REFERENCES projects(id),
  actor_principal_id UUID NOT NULL REFERENCES principals(id),
  parameter_values JSONB NOT NULL,
  parameter_projection JSONB NOT NULL,
  reference_outcomes JSONB NOT NULL,
  response_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS blueprint_instantiation_requests (
  caller UUID NOT NULL REFERENCES principals(id),
  blueprint_id UUID NOT NULL REFERENCES blueprints(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  blueprint_version_id UUID NOT NULL REFERENCES blueprint_versions(id),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_snapshot JSONB NOT NULL,
  instantiation_id UUID NOT NULL REFERENCES blueprint_instantiations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, blueprint_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS blueprint_instantiations_blueprint_created ON blueprint_instantiations(blueprint_id,created_at,id);
CREATE INDEX IF NOT EXISTS blueprint_instantiations_root ON blueprint_instantiations(root_project_id);

-- Submission freezes content until an explicit withdrawal/rejection to draft.
CREATE OR REPLACE FUNCTION blueprint_version_immutable_content() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.document IS DISTINCT FROM OLD.document
      OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
      OR NEW.identity_sha256 IS DISTINCT FROM OLD.identity_sha256
      OR NEW.author_principal_id IS DISTINCT FROM OLD.author_principal_id) THEN
    RAISE EXCEPTION 'Submitted Blueprint content is immutable';
  END IF;
  IF NEW.blueprint_id IS DISTINCT FROM OLD.blueprint_id OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'Blueprint version identity is immutable';
  END IF;
  RETURN NEW;
END
$body$;
DROP TRIGGER IF EXISTS blueprint_version_immutable_content_trigger ON blueprint_versions;
CREATE TRIGGER blueprint_version_immutable_content_trigger BEFORE UPDATE ON blueprint_versions
  FOR EACH ROW EXECUTE FUNCTION blueprint_version_immutable_content();

-- Repeatability guard: a pre-existing unrelated table is not successful setup.
DO $shape$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('blueprints','published_version_id','uuid'),
    ('blueprint_versions','document','jsonb'),
    ('blueprint_versions','version','integer'),
    ('blueprint_instantiations','parameter_values','jsonb'),
    ('blueprint_instantiation_requests','request_hash','text')
  ) AS expected(table_name,column_name,data_type)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema=current_schema()
      AND c.table_name=r.table_name AND c.column_name=r.column_name AND c.data_type=r.data_type) THEN
      RAISE EXCEPTION 'Blueprint schema mismatch: %.%',r.table_name,r.column_name;
    END IF;
  END LOOP;
END
$shape$;

-- The new capability object uses the existing grant/profile machinery.
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_resource_type_check;
ALTER TABLE grants ADD CONSTRAINT grants_resource_type_check CHECK (resource_type IN
  ('task','phase','project','report','skill','personality','service','plugin','surface','blueprint'));
ALTER TABLE access_profile_rules DROP CONSTRAINT IF EXISTS access_profile_rules_resource_type_check;
ALTER TABLE access_profile_rules ADD CONSTRAINT access_profile_rules_resource_type_check CHECK (resource_type IN
  ('task','phase','project','report','skill','personality','service','plugin','surface','blueprint'));
