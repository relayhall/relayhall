-- 082_task_authorization_roles.sql
-- RH-P2.5 (task 803f3b1f): server-written Task roles consumed by the shared
-- authorization predicate. tasks.owner_principal_id is the claimant
-- identifier (owner-facing label: Assignee); this migration adds Shepherd and
-- Verifier without introducing a duplicate claimant column.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS shepherd_principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS verifier_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;

-- Every existing Task names a Shepherd: creator first, then current Assignee,
-- then the neutral deployment-owner seed established by the identity
-- substrate. Verifier is intentionally not inferred from historical state.
UPDATE tasks
SET shepherd_principal_id = COALESCE(
  creator_principal_id,
  owner_principal_id,
  (SELECT id FROM principals WHERE handle = 'dashboard_user')
)
WHERE shepherd_principal_id IS NULL;

ALTER TABLE tasks ALTER COLUMN shepherd_principal_id SET NOT NULL;

-- Internal/request-less Task creation still receives a Shepherd. Authenticated
-- creates replace this fallback with their creator in the post-insert
-- attribution stamp; callers can never supply the column.
CREATE OR REPLACE FUNCTION set_task_shepherd_fallback()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.shepherd_principal_id IS NULL THEN
    NEW.shepherd_principal_id := COALESCE(
      NEW.creator_principal_id,
      NEW.owner_principal_id,
      (SELECT id FROM principals WHERE handle = 'dashboard_user')
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_shepherd_fallback ON tasks;
CREATE TRIGGER trg_tasks_shepherd_fallback
BEFORE INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION set_task_shepherd_fallback();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_claimant_verifier_separation'
      AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_claimant_verifier_separation
      CHECK (
        owner_principal_id IS NULL OR
        verifier_principal_id IS NULL OR
        owner_principal_id <> verifier_principal_id
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_tasks_shepherd_principal ON tasks(shepherd_principal_id);
CREATE INDEX IF NOT EXISTS ix_tasks_verifier_principal ON tasks(verifier_principal_id);

COMMENT ON COLUMN tasks.owner_principal_id IS
  'Server-written claimant identifier (owner-facing label: Assignee). Consulted by the RH-P2.5 shared authorization predicate; never caller-writable.';
COMMENT ON COLUMN tasks.shepherd_principal_id IS
  'Server-written Shepherd task role (RH-P2.5): force-release, reassign and park authority. Every Task names one; inherited/fallback assignment is server-owned.';
COMMENT ON COLUMN tasks.verifier_principal_id IS
  'Server-written Verifier task role (RH-P2.5): completion judgment authority. Must differ from the claimant; never caller-writable.';
