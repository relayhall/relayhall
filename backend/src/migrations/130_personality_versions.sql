-- Reserved130: immutable Personality content history. The first recorded
-- version contains the actual current row; no pre-adoption history is invented.
LOCK TABLE personalities IN ACCESS EXCLUSIVE MODE;
ALTER TABLE personalities ADD COLUMN IF NOT EXISTS current_version integer;

CREATE OR REPLACE FUNCTION personality_content_snapshot(p public.personalities)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('slug',p.slug,'name',p.name,'description',p.description,
    'category',p.category,'color',p.color,'content',p.content,'source_file',p.source_file,
    'is_custom',p.is_custom,'source',p.source)
$$;

CREATE TABLE IF NOT EXISTS personality_versions (
  personality_id uuid NOT NULL REFERENCES personalities(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'
    AND snapshot ?& ARRAY['slug','name','description','category','color','content','source_file','is_custom','source']
    AND snapshot - ARRAY['slug','name','description','category','color','content','source_file','is_custom','source'] = '{}'::jsonb),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (personality_id, version)
);

-- The WHERE clause makes explicit replay a no-op, including after history has
-- advanced. The migration's table lock excludes writers during adoption.
INSERT INTO personality_versions(personality_id,version,snapshot)
SELECT p.id,1,personality_content_snapshot(p) FROM personalities p
WHERE p.current_version IS NULL AND NOT EXISTS
  (SELECT 1 FROM personality_versions v WHERE v.personality_id=p.id);
UPDATE personalities SET current_version=1 WHERE current_version IS NULL;
ALTER TABLE personalities ALTER COLUMN current_version SET DEFAULT 1;
ALTER TABLE personalities ALTER COLUMN current_version SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='personalities'::regclass AND conname='personality_current_version_positive') THEN
    ALTER TABLE personalities ADD CONSTRAINT personality_current_version_positive CHECK(current_version>0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='personalities'::regclass AND conname='personality_current_version_identity') THEN
    ALTER TABLE personalities ADD CONSTRAINT personality_current_version_identity
      FOREIGN KEY(id,current_version) REFERENCES personality_versions(personality_id,version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION personality_prepare_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.current_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Personality creation requires initial version one';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.current_version IS DISTINCT FROM OLD.current_version THEN
      RAISE EXCEPTION 'Personality identity and version pointer are maintained by the database';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.personality_versions v
      WHERE v.personality_id=OLD.id AND v.version=OLD.current_version
        AND v.snapshot=personality_content_snapshot(OLD)) THEN
      RAISE EXCEPTION 'Personality current snapshot is inconsistent';
    END IF;
    -- UPDATE already holds the parent tuple lock. A waiting writer observes
    -- the committed predecessor and increments that version, never MAX()+1.
    IF personality_content_snapshot(NEW) IS DISTINCT FROM personality_content_snapshot(OLD) THEN
      IF OLD.current_version=2147483647 THEN
        RAISE EXCEPTION 'Personality version sequence exhausted';
      END IF;
      NEW.current_version := OLD.current_version+1;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION personality_append_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    INSERT INTO public.personality_versions(personality_id,version,snapshot)
      VALUES(NEW.id,NEW.current_version,personality_content_snapshot(NEW));
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION personality_guard_history()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Only the nested append caused by the parent row trigger may insert.
  -- Database owners able to disable triggers/alter schema are outside this
  -- DML boundary, just as for the existing immutable profile/feed substrates.
  IF TG_OP='INSERT' AND pg_trigger_depth()=2 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Personality version history is immutable';
END $$;

DROP TRIGGER IF EXISTS personality_version_prepare ON personalities;
CREATE TRIGGER personality_version_prepare BEFORE INSERT OR UPDATE ON personalities
  FOR EACH ROW EXECUTE FUNCTION personality_prepare_version();
DROP TRIGGER IF EXISTS personality_version_append ON personalities;
CREATE TRIGGER personality_version_append AFTER INSERT OR UPDATE ON personalities
  FOR EACH ROW EXECUTE FUNCTION personality_append_version();
DROP TRIGGER IF EXISTS personality_versions_immutable ON personality_versions;
CREATE TRIGGER personality_versions_immutable BEFORE INSERT OR UPDATE OR DELETE ON personality_versions
  FOR EACH ROW EXECUTE FUNCTION personality_guard_history();
DROP TRIGGER IF EXISTS personality_versions_no_truncate ON personality_versions;
CREATE TRIGGER personality_versions_no_truncate BEFORE TRUNCATE ON personality_versions
  FOR EACH STATEMENT EXECUTE FUNCTION personality_guard_history();
