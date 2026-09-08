-- RH-P2.10: immutable Agent-Skills versions, provenance, review gate and pins.
-- Stacked after 082_skills_revision.sql; renumber if integration order changes.

CREATE TABLE skill_versions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id                 UUID NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  version                  INTEGER NOT NULL CHECK (version > 0),
  skill_md                 TEXT NOT NULL CHECK (octet_length(skill_md) <= 524288),
  content_sha256           TEXT GENERATED ALWAYS AS
                             (encode(digest(skill_md, 'sha256'), 'hex')) STORED,
  description              TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1024),
  category                 VARCHAR(100),
  tags                     TEXT[] NOT NULL DEFAULT '{}',
  config                   JSONB NOT NULL DEFAULT '{}',
  provenance               VARCHAR(24) NOT NULL CHECK
                             (provenance IN ('human-authored', 'imported', 'agent-drafted')),
  source_uri               TEXT,
  created_by_principal_id  UUID REFERENCES principals(id) ON DELETE RESTRICT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version),
  UNIQUE (skill_id, id),
  CHECK (provenance <> 'imported' OR nullif(btrim(source_uri), '') IS NOT NULL)
);

CREATE INDEX ix_skill_versions_skill_created
  ON skill_versions(skill_id, version DESC);
CREATE INDEX ix_skill_versions_digest ON skill_versions(content_sha256);

CREATE TABLE skill_version_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence            BIGSERIAL UNIQUE,
  skill_version_id    UUID NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  status              VARCHAR(16) NOT NULL CHECK
                        (status IN ('draft', 'review', 'published', 'retired')),
  actor_principal_id  UUID REFERENCES principals(id) ON DELETE RESTRICT,
  note                TEXT CHECK (note IS NULL OR char_length(note) <= 4000),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_skill_version_events_current
  ON skill_version_events(skill_version_id, sequence DESC);

-- Convert the curated 072 rows into exact native SKILL.md version-1 artifacts.
-- JSON string quoting is valid YAML and prevents descriptions becoming syntax.
INSERT INTO skill_versions (
  skill_id, version, skill_md, description, category, tags, config,
  provenance, source_uri, created_by_principal_id, created_at
)
SELECT
  id,
  1,
  '---' || E'\n' ||
  'name: ' || name || E'\n' ||
  'description: ' || to_json(COALESCE(NULLIF(btrim(description), ''), name))::text || E'\n' ||
  'metadata:' || E'\n' ||
  '  relayhall-category: ' || to_json(COALESCE(category, 'uncategorized'))::text || E'\n' ||
  '---' || E'\n\n' || COALESCE(usage_instructions, ''),
  COALESCE(NULLIF(btrim(description), ''), name),
  category,
  COALESCE(tags, '{}'),
  COALESCE(config, '{}'),
  'imported',
  'relayhall:migration:083',
  NULL,
  created_at
FROM skills;

INSERT INTO skill_version_events (skill_version_id, status, actor_principal_id, note, created_at)
SELECT id, 'published', NULL, 'Converted from the owner-reviewed curated 072 registry seed', created_at
FROM skill_versions;

ALTER TABLE skills ADD COLUMN current_published_version_id UUID;

UPDATE skills s
SET current_published_version_id = v.id
FROM skill_versions v
WHERE v.skill_id = s.id AND v.version = 1;

ALTER TABLE skills
  ADD CONSTRAINT skills_current_version_same_skill_fk
    FOREIGN KEY (id, current_published_version_id)
    REFERENCES skill_versions(skill_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT skills_global_requires_published_ck
    CHECK (NOT is_global OR current_published_version_id IS NOT NULL);

ALTER TABLE project_skills ADD COLUMN skill_version_id UUID;

UPDATE project_skills ps
SET skill_version_id = s.current_published_version_id
FROM skills s
WHERE s.id = ps.skill_id;

ALTER TABLE project_skills
  ALTER COLUMN skill_version_id SET NOT NULL,
  ADD CONSTRAINT project_skills_version_same_skill_fk
    FOREIGN KEY (skill_id, skill_version_id)
    REFERENCES skill_versions(skill_id, id) ON DELETE RESTRICT;

ALTER TABLE project_skills DROP COLUMN override_instructions;

-- The catalog holds identity and audience selection only. Payload moves to
-- immutable version rows; the old integer counter is retired.
ALTER TABLE skills
  DROP COLUMN category,
  DROP COLUMN description,
  DROP COLUMN usage_instructions,
  DROP COLUMN config,
  DROP COLUMN tags,
  DROP COLUMN version;

COMMENT ON TABLE skill_versions IS
  'Immutable Agent-Skills SKILL.md payloads with per-version provenance';
COMMENT ON TABLE skill_version_events IS
  'Append-only registry lifecycle events; latest event is current status';
COMMENT ON COLUMN project_skills.skill_version_id IS
  'Exact immutable Skill Version pin; retirement never invalidates existing pins';

CREATE VIEW skill_version_state AS
SELECT DISTINCT ON (v.id)
  v.*,
  e.status,
  e.actor_principal_id AS status_actor_principal_id,
  e.note AS status_note,
  e.created_at AS status_changed_at
FROM skill_versions v
JOIN skill_version_events e ON e.skill_version_id = v.id
ORDER BY v.id, e.sequence DESC;

CREATE OR REPLACE FUNCTION relayhall_reject_skill_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Skill Versions and their lifecycle events are append-only'
    USING ERRCODE = '55000';
END $$;

CREATE TRIGGER skill_versions_immutable
BEFORE UPDATE OR DELETE ON skill_versions
FOR EACH ROW EXECUTE FUNCTION relayhall_reject_skill_version_mutation();

CREATE TRIGGER skill_version_events_immutable
BEFORE UPDATE OR DELETE ON skill_version_events
FOR EACH ROW EXECUTE FUNCTION relayhall_reject_skill_version_mutation();

CREATE OR REPLACE FUNCTION relayhall_validate_new_skill_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_kind TEXT;
  expected_version INTEGER;
BEGIN
  IF NEW.created_by_principal_id IS NULL THEN
    RAISE EXCEPTION 'A Skill Version creator Principal is required' USING ERRCODE = '23514';
  END IF;

  SELECT kind INTO actor_kind FROM principals WHERE id = NEW.created_by_principal_id;
  IF actor_kind IS NULL THEN
    RAISE EXCEPTION 'Unknown Skill Version creator Principal' USING ERRCODE = '23503';
  END IF;
  IF NEW.provenance = 'human-authored' AND actor_kind <> 'human' THEN
    RAISE EXCEPTION 'human-authored provenance requires a human Principal' USING ERRCODE = '23514';
  END IF;
  IF NEW.provenance = 'agent-drafted' AND actor_kind NOT IN ('agent', 'service') THEN
    RAISE EXCEPTION 'agent-drafted provenance requires an agent or service Principal' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.skill_id::text));
  SELECT COALESCE(max(version), 0) + 1 INTO expected_version
  FROM skill_versions WHERE skill_id = NEW.skill_id;
  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION 'Skill Version must be the next contiguous version (%)', expected_version
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skill_versions_validate_insert
BEFORE INSERT ON skill_versions
FOR EACH ROW EXECUTE FUNCTION relayhall_validate_new_skill_version();

CREATE OR REPLACE FUNCTION relayhall_validate_skill_version_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_status TEXT;
  creator_id UUID;
  actor_kind TEXT;
  parent_skill_id UUID;
BEGIN
  IF NEW.actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'A lifecycle actor Principal is required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.skill_version_id::text));
  SELECT e.status INTO previous_status
  FROM skill_version_events e
  WHERE e.skill_version_id = NEW.skill_version_id
  ORDER BY e.sequence DESC
  LIMIT 1;

  IF previous_status IS NULL AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'A Skill Version lifecycle must begin in draft' USING ERRCODE = '23514';
  ELSIF previous_status = 'draft' AND NEW.status NOT IN ('review', 'retired') THEN
    RAISE EXCEPTION 'Illegal Skill Version transition draft -> %', NEW.status USING ERRCODE = '23514';
  ELSIF previous_status = 'review' AND NEW.status NOT IN ('draft', 'published', 'retired') THEN
    RAISE EXCEPTION 'Illegal Skill Version transition review -> %', NEW.status USING ERRCODE = '23514';
  ELSIF previous_status = 'published' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'Illegal Skill Version transition published -> %', NEW.status USING ERRCODE = '23514';
  ELSIF previous_status = 'retired' THEN
    RAISE EXCEPTION 'A retired Skill Version is terminal' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'published' THEN
    SELECT v.created_by_principal_id, v.skill_id
      INTO creator_id, parent_skill_id
    FROM skill_versions v WHERE v.id = NEW.skill_version_id;
    SELECT kind INTO actor_kind FROM principals WHERE id = NEW.actor_principal_id;
    IF actor_kind <> 'human' THEN
      RAISE EXCEPTION 'Publishing a Skill Version requires a human Principal' USING ERRCODE = '23514';
    END IF;
    IF creator_id = NEW.actor_principal_id THEN
      RAISE EXCEPTION 'A Skill Version creator cannot publish their own Version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skill_version_events_validate_insert
BEFORE INSERT ON skill_version_events
FOR EACH ROW EXECUTE FUNCTION relayhall_validate_skill_version_event();

CREATE OR REPLACE FUNCTION relayhall_apply_skill_version_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_skill_id UUID;
BEGIN
  SELECT skill_id INTO parent_skill_id FROM skill_versions WHERE id = NEW.skill_version_id;
  IF NEW.status = 'published' THEN
    UPDATE skills
    SET current_published_version_id = NEW.skill_version_id,
        revision = gen_random_uuid(),
        updated_at = now()
    WHERE id = parent_skill_id;
  ELSIF NEW.status = 'retired' THEN
    UPDATE skills
    SET current_published_version_id = NULL,
        is_global = FALSE,
        revision = gen_random_uuid(),
        updated_at = now()
    WHERE id = parent_skill_id AND current_published_version_id = NEW.skill_version_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skill_version_events_apply
AFTER INSERT ON skill_version_events
FOR EACH ROW EXECUTE FUNCTION relayhall_apply_skill_version_event();

-- A new or changed consumer pin may target only a currently published
-- Version. Retirement never updates existing rows, so historical exact pins
-- continue resolving exactly as contracted.
CREATE OR REPLACE FUNCTION relayhall_validate_project_skill_pin()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_status TEXT;
BEGIN
  SELECT status INTO target_status
  FROM skill_version_state
  WHERE id = NEW.skill_version_id AND skill_id = NEW.skill_id;
  IF target_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'A new Project Skill pin requires a published Skill Version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER project_skills_published_pin
BEFORE INSERT OR UPDATE OF skill_id, skill_version_id ON project_skills
FOR EACH ROW EXECUTE FUNCTION relayhall_validate_project_skill_pin();

CREATE OR REPLACE FUNCTION relayhall_prevent_skill_rename()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'A Skill name is immutable after creation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skills_name_immutable
BEFORE UPDATE OF name ON skills
FOR EACH ROW EXECUTE FUNCTION relayhall_prevent_skill_rename();
