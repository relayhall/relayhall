-- 170_task_verification_none.sql — the per-Task verification mode `none`
-- (universal harness connector design, section 6.8 "Verification modes";
-- owner ruling E462, choice C10 = B; slice S4b). Reserved in
-- backend/src/migrations/RESERVED in the same commit.
--
-- WHAT IT HOLDS. A Task's verification mode is `human`, `service` or `none`.
-- `human` and `service` are DERIVED from the Verifier's principal kind and are
-- never stored, so they can never disagree with the Verifier. `none` is the
-- only stored choice: `verification_none`. A `none` Task has no Verifier
-- (CHECK below) and its finish completes it directly (POST /tasks/{id}/finish).
--
-- The setter is stored server-side with the basis it acted under, so finish
-- can re-run the chain guard between the setter and the implementing chain
-- (VERIFICATION_NONE_SELF_SET). Adding a Verifier clears `none` in the same
-- UPDATE and stamps `verification_none_cleared_at`; once cleared, `none` can
-- never be set again on that Task (CHECK below).
--
-- The chain guard G(Task) walks principals by parent and finds the Agents
-- bound to a Task; two indexes keep those walks off a sequential scan.
--
-- Replay-safe: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS and constraints added only when
-- absent, so re-running this file changes nothing. Every existing row reads
-- `verification_none = false`, which is what every Task was before.
-- database/init.sql is untouched.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_none BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_none_set_by UUID REFERENCES principals(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_none_basis TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_none_set_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_none_cleared_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_principals_parent_principal ON principals(parent_principal_id)
  WHERE parent_principal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_principals_bound_task ON principals(bound_task_id)
  WHERE bound_task_id IS NOT NULL;

DO $$
BEGIN
  -- `none` implies no Verifier: the two can never be stored together.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_verification_none_without_verifier') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_verification_none_without_verifier
      CHECK (NOT verification_none OR verifier_principal_id IS NULL);
  END IF;
  -- A `none` Task always names who set it, when, and under which basis.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_verification_none_setter') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_verification_none_setter
      CHECK (NOT verification_none
        OR (verification_none_set_by IS NOT NULL AND verification_none_set_at IS NOT NULL
          AND verification_none_basis IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_verification_none_basis') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_verification_none_basis
      CHECK (verification_none_basis IS NULL
        OR verification_none_basis IN ('account-control', 'role-authority'));
  END IF;
  -- Once cleared, never again.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_verification_none_once') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_verification_none_once
      CHECK (NOT verification_none OR verification_none_cleared_at IS NULL);
  END IF;
END $$;
