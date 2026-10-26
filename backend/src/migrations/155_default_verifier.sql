-- Card 41e24358 (design ba22fd01, ratified E298) - the default Verifier per
-- Project and Phase; reserved in backend/src/migrations/RESERVED as slot 155
-- before this file was written.
--
-- A Project, and optionally each of its Phases, may name one principal that
-- new cards inherit as their Verifier. Creation resolves an explicit value
-- first, then the default of the Phase the card lands in, then the Project
-- default, then none (TaskManagerDB.createTask), and records where the value
-- came from in tasks.verifier_source.
--
-- ADDITIVE ONLY. Three nullable columns, two indexes, one trigger function,
-- two triggers and one CHECK; no row is written. NULL is "no default", which
-- is every Project and Phase when this file lands, so creation behaves as
-- before until a person sets a default on the owner plane
-- (PUT /projects/:id/default-verifier, PUT /phases/:id/default-verifier).
--
-- NO BACKFILL: existing cards keep verifier_source NULL (unknown) and no
-- Verifier is inferred for them; no default is seeded.
--
-- ON DELETE SET NULL: removing the principal row clears the default rather
-- than refusing the delete. Disabling or terminating a default principal
-- leaves the column as it is; the usable predicate (services/VerifierUsability)
-- then reports it, and no existing card is ever reassigned.
--
-- The trigger is the BACKSTOP under the route validation: a Group never acts
-- and is never a Verifier (AZ-A12 clause 3(c)), and a non-legacy Agent is
-- bound to one Task, so it can never be the default for future cards.
--
-- Fresh-replay doctrine: database/init.sql is untouched; every statement is
-- idempotent so re-running the file is a no-op.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_verifier_principal_id UUID;
ALTER TABLE phases ADD COLUMN IF NOT EXISTS default_verifier_principal_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verifier_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_default_verifier_fk') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_default_verifier_fk
      FOREIGN KEY (default_verifier_principal_id) REFERENCES principals(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phases_default_verifier_fk') THEN
    ALTER TABLE phases ADD CONSTRAINT phases_default_verifier_fk
      FOREIGN KEY (default_verifier_principal_id) REFERENCES principals(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_verifier_source_vocabulary') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_verifier_source_vocabulary CHECK (
      verifier_source IS NULL
      OR verifier_source IN ('explicit', 'inherited-phase', 'inherited-project', 'assigned')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_projects_default_verifier_principal
  ON projects (default_verifier_principal_id) WHERE default_verifier_principal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_phases_default_verifier_principal
  ON phases (default_verifier_principal_id) WHERE default_verifier_principal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION refuse_unfit_default_verifier() RETURNS trigger AS $$
DECLARE
  candidate RECORD;
BEGIN
  IF NEW.default_verifier_principal_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind, legacy_identity INTO candidate FROM principals WHERE id = NEW.default_verifier_principal_id;
  IF FOUND AND candidate.kind = 'group' THEN
    RAISE EXCEPTION 'a Group principal never acts (AZ-A12 clause 3c): %.default_verifier_principal_id cannot name one', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF FOUND AND candidate.kind = 'agent' AND NOT COALESCE(candidate.legacy_identity, FALSE) THEN
    RAISE EXCEPTION 'an Agent is bound to one Task: %.default_verifier_principal_id cannot name one', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_default_verifier_fit ON projects;
CREATE TRIGGER trg_projects_default_verifier_fit
  BEFORE INSERT OR UPDATE OF default_verifier_principal_id ON projects
  FOR EACH ROW EXECUTE FUNCTION refuse_unfit_default_verifier();

DROP TRIGGER IF EXISTS trg_phases_default_verifier_fit ON phases;
CREATE TRIGGER trg_phases_default_verifier_fit
  BEFORE INSERT OR UPDATE OF default_verifier_principal_id ON phases
  FOR EACH ROW EXECUTE FUNCTION refuse_unfit_default_verifier();

COMMENT ON COLUMN projects.default_verifier_principal_id IS
  'Card 41e24358: the Verifier new cards of this Project inherit when neither the request nor the landing Phase names one. Written only by PUT /projects/:id/default-verifier (a login session of root, an administrator or the person owner); never a Group or a non-legacy Agent.';
COMMENT ON COLUMN phases.default_verifier_principal_id IS
  'Card 41e24358: the Verifier new cards landing in this Phase inherit, ahead of the Project default. Written only by PUT /phases/:id/default-verifier; never a Group or a non-legacy Agent.';
COMMENT ON COLUMN tasks.verifier_source IS
  'Card 41e24358: where verifier_principal_id came from - explicit (named at creation), inherited-phase, inherited-project, or assigned (the roles route or a Blueprint). Server-written; NULL when no Verifier is set or the source is unknown (cards created before migration 155).';
