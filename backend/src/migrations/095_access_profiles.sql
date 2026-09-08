-- 095_access_profiles.sql
-- RH-P3.AZ-S2 (card 559393f5): Access profiles (AUTHZ design 4d961e37 §4;
-- vocabulary amendment A17.4 — the retired word, redefined by declaration:
-- a named, versioned, reusable bundle of object authority, selectors →
-- verbs).
--
-- Storage model (AZ-11, fixed post-red-team): versions are IMMUTABLE
-- (trigger-enforced, rules included); exactly ONE published version per
-- profile via access_profiles.published_version_id — deliberately a plain
-- FK pointer, NOT a partial unique index (the ux_pcred fail-open lesson).
-- Assignments store profile_id ONLY; the evaluator joins through
-- published_version_id, so there is no per-assignment version pointer, no
-- re-point operation, and no swap-vs-insert race — T14 holds by
-- construction. A profile whose published_version_id is NULL yields EMPTY
-- authority and may not be assigned (T35, service-enforced).
--
-- Selector forms (§4): 'exact' (pinned id list), 'all-of-type' (INCLUDING
-- future objects), 'all-except' (all-of-type minus a pinned exclusion
-- list; future objects included, exclusions stay).
--
-- Assignees: principal | group. Group assignees resolve by the SAME
-- membership join as the group grant arm (094). The AZ-S2 sequencing
-- guard — parented principals refused until AZ-S3's cap machinery — is
-- service-enforced, not schema, because S3 ENABLES it without a migration.
--
-- Provenance: access_profile_events is APPEND-ONLY (trigger-enforced like
-- audit_events); every profile/version/publish/assignment transition
-- writes one row in the same transaction.
--
-- Fresh-replay doctrine: database/init.sql untouched; idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS access_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  published_version_id UUID,
  created_by_principal_id UUID REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT access_profiles_name_nonempty CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_access_profiles_name_ci
  ON access_profiles (lower(name));

CREATE TABLE IF NOT EXISTS access_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES access_profiles(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  created_by_principal_id UUID REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, version_number)
);

-- The published pointer targets a real version of SOME profile; that it
-- belongs to the SAME profile is trigger-enforced below (a plain FK cannot
-- express the pairing).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_access_profiles_published_version'
  ) THEN
    ALTER TABLE access_profiles
      ADD CONSTRAINT fk_access_profiles_published_version
      FOREIGN KEY (published_version_id) REFERENCES access_profile_versions(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS access_profile_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES access_profile_versions(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK (resource_type IN
    ('task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin')),
  selector_form TEXT NOT NULL CHECK (selector_form IN ('exact', 'all-of-type', 'all-except')),
  selector_ids UUID[] NOT NULL DEFAULT '{}',
  verbs TEXT[] NOT NULL,
  CONSTRAINT access_profile_rules_verbs_shape CHECK (
    array_length(verbs, 1) >= 1
    AND verbs <@ ARRAY['read', 'write', 'use', 'invoke', 'admin']
  ),
  CONSTRAINT access_profile_rules_selector_shape CHECK (
    (selector_form = 'all-of-type' AND selector_ids = '{}')
    OR (selector_form <> 'all-of-type' AND array_length(selector_ids, 1) >= 1)
  )
);

CREATE INDEX IF NOT EXISTS ix_access_profile_rules_version
  ON access_profile_rules(version_id, resource_type);

CREATE TABLE IF NOT EXISTS access_profile_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES access_profiles(id) ON DELETE RESTRICT,
  assignee_type TEXT NOT NULL CHECK (assignee_type IN ('principal', 'group')),
  assignee_id UUID NOT NULL,
  assigned_by_principal_id UUID REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, assignee_type, assignee_id)
);

CREATE INDEX IF NOT EXISTS ix_access_profile_assignments_assignee
  ON access_profile_assignments(assignee_type, assignee_id);

CREATE TABLE IF NOT EXISTS access_profile_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  profile_id UUID NOT NULL,
  version_id UUID,
  -- Event names follow the ratified <singular>.<past-tense> dotted rule
  -- (vocabulary b94dd86e par.6; review 6e5b58e0 round-1 repair): the acting
  -- object is the profile, except version creation where the version itself
  -- is the created object.
  action TEXT NOT NULL CHECK (action IN
    ('profile.created', 'profile.updated', 'profile.deleted', 'version.created',
     'profile.published', 'profile.assigned', 'profile.unassigned')),
  actor_principal_id UUID,
  actor_handle TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS ix_access_profile_events_profile
  ON access_profile_events(profile_id, occurred_at DESC);

-- Versions (and their rules) are immutable once written (AZ-11): rollback
-- is REPUBLISHING prior content as a NEW version, never editing history.
CREATE OR REPLACE FUNCTION reject_access_profile_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'access profile versions are immutable (AZ-11): republish prior content as a new version'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apv_immutable ON access_profile_versions;
CREATE TRIGGER trg_apv_immutable
  BEFORE UPDATE OR DELETE ON access_profile_versions
  FOR EACH ROW EXECUTE FUNCTION reject_access_profile_version_mutation();

DROP TRIGGER IF EXISTS trg_apr_immutable ON access_profile_rules;
CREATE TRIGGER trg_apr_immutable
  BEFORE UPDATE OR DELETE ON access_profile_rules
  FOR EACH ROW EXECUTE FUNCTION reject_access_profile_version_mutation();

-- The published pointer must name a version OF THIS profile.
CREATE OR REPLACE FUNCTION enforce_published_version_pairing() RETURNS trigger AS $$
DECLARE
  version_profile UUID;
BEGIN
  IF NEW.published_version_id IS NOT NULL THEN
    SELECT profile_id INTO version_profile
      FROM access_profile_versions WHERE id = NEW.published_version_id;
    IF version_profile IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'published_version_id must name a version of this profile'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ap_published_pairing ON access_profiles;
CREATE TRIGGER trg_ap_published_pairing
  BEFORE INSERT OR UPDATE ON access_profiles
  FOR EACH ROW EXECUTE FUNCTION enforce_published_version_pairing();

-- Provenance is append-only (the audit_events pattern).
CREATE OR REPLACE FUNCTION reject_access_profile_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'access_profile_events is append-only'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ape_append_only ON access_profile_events;
CREATE TRIGGER trg_ape_append_only
  BEFORE UPDATE OR DELETE ON access_profile_events
  FOR EACH ROW EXECUTE FUNCTION reject_access_profile_event_mutation();

COMMENT ON TABLE access_profiles IS
  'Access profiles (AZ-S2, design 4d961e37 §4, A17.4): named, versioned, reusable bundles of object authority. ONE published version per profile via published_version_id; NULL = unpublished = empty authority, unassignable (T35).';
COMMENT ON TABLE access_profile_versions IS
  'Immutable profile versions (AZ-11, trigger-enforced): rollback = republish prior content as a NEW version.';
COMMENT ON TABLE access_profile_rules IS
  'Selector → verbs rules of one immutable version: exact (pinned ids), all-of-type (future-inclusive), all-except (future-inclusive minus pinned exclusions).';
COMMENT ON TABLE access_profile_assignments IS
  'Profile assignments (profile_id only — the evaluator joins through published_version_id, T14 by construction). assignee_type principal|group; parented principals refused at the service until AZ-S3.';
COMMENT ON TABLE access_profile_events IS
  'Append-only provenance for profiles, versions, publishes and assignments (AZ-S2; trigger-enforced).';
