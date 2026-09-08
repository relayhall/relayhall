-- Detached provenance. Ordinary work reads never depend on a Blueprint document.
DO $provenance$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['projects','phases','tasks','subtasks','reports'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS blueprint_key TEXT', relation_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS blueprint_version INTEGER', relation_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS blueprint_content_sha256 TEXT', relation_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS blueprint_identity_sha256 TEXT', relation_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS instantiation_id UUID', relation_name);
  END LOOP;
END
$provenance$;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS instantiated_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS instantiated_by_principal_id UUID REFERENCES principals(id);

-- Owner-approved separate workflow setup. Resolved profile options may contain
-- private supplied values and are never part of the ordinary receipt projection.
ALTER TABLE blueprint_instantiations ADD COLUMN IF NOT EXISTS execution_defaults JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS blueprint_setup_requests (
  caller UUID NOT NULL REFERENCES principals(id),
  instantiation_id UUID NOT NULL REFERENCES blueprint_instantiations(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(caller,instantiation_id,idempotency_key)
);

DO $setup_shape$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('blueprint_instantiations','execution_defaults','jsonb'),
    ('blueprint_setup_requests','caller','uuid'),
    ('blueprint_setup_requests','instantiation_id','uuid'),
    ('blueprint_setup_requests','idempotency_key','text'),
    ('blueprint_setup_requests','request_hash','text'),
    ('blueprint_setup_requests','response_snapshot','jsonb')
  ) AS expected(table_name,column_name,data_type)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema=current_schema()
      AND c.table_name=r.table_name AND c.column_name=r.column_name AND c.data_type=r.data_type AND c.is_nullable='NO') THEN
      RAISE EXCEPTION 'Blueprint setup schema mismatch: %.%',r.table_name,r.column_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='blueprint_instantiations'::regclass AND conname='blueprint_execution_defaults_array') THEN
    ALTER TABLE blueprint_instantiations ADD CONSTRAINT blueprint_execution_defaults_array CHECK (jsonb_typeof(execution_defaults)='array');
  END IF;
END
$setup_shape$;
CREATE OR REPLACE FUNCTION blueprint_execution_defaults_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.execution_defaults IS DISTINCT FROM OLD.execution_defaults THEN
    RAISE EXCEPTION 'Blueprint execution defaults are immutable';
  END IF;
  RETURN NEW;
END
$body$;
DROP TRIGGER IF EXISTS blueprint_execution_defaults_immutable_trigger ON blueprint_instantiations;
CREATE TRIGGER blueprint_execution_defaults_immutable_trigger BEFORE UPDATE OF execution_defaults ON blueprint_instantiations
  FOR EACH ROW EXECUTE FUNCTION blueprint_execution_defaults_immutable();
