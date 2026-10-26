-- Card b13e5ac9 (owner ruling D34(b); Charter v5 §6.1) — the per-Project
-- "inbox phase".
--
-- Charter §6.1: "Each project keeps one inbox phase ... Every new card lands
-- there with status Ideas, whether a human or an agent creates it." This is
-- the setting that names that Phase. A Task created WITHOUT an explicit
-- phaseId in a Project that has one lands in it; a Task that lands in it
-- without an explicit status is created as Ideas (TaskManagerDB.createTask).
-- An explicit phaseId or status in the request still wins (§6.2).
--
-- ADDITIVE ONLY. One nullable column and one constraint; no row is written.
-- NULL is "this Project has no inbox phase", which is every Project on every
-- deployment when this file lands, so creation behaves exactly as before
-- until an owner sets the value (PATCH /projects/:id). No deployment's inbox
-- is seeded here: a deployment's Phases are its own content and never ship as
-- repo bytes (the 075/076/078/079 rule). Existing Tasks are not touched — the
-- setting decides where NEW Tasks land, never where old ones are.
--
-- THE INBOX PHASE MUST BELONG TO THIS PROJECT, structurally, exactly as a
-- Task's Phase must belong to the Task's Project (079): the composite key
-- (inbox_phase_id, id) -> phases(id, project_id) makes it a database fact.
-- MATCH SIMPLE skips the check when inbox_phase_id is NULL, which is the
-- unset state; `id` is the primary key and is never NULL.
--
-- NO ACTION, not SET NULL and not RESTRICT: deleting the Phase a Project
-- names as its inbox is refused rather than silently clearing the setting
-- (PhaseService.remove answers 409 PHASE_IS_INBOX before the database has to),
-- and NO ACTION is checked at the END of the statement, so deleting the
-- Project itself — which cascades to its Phases — still succeeds: the
-- referencing row is gone by the time the check runs.
--
-- Fresh-replay doctrine: database/init.sql is untouched; every statement is
-- idempotent so re-running the file is a no-op.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS inbox_phase_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_inbox_phase_fk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_inbox_phase_fk
      FOREIGN KEY (inbox_phase_id, id) REFERENCES phases(id, project_id)
      ON DELETE NO ACTION;
  END IF;
END $$;

COMMENT ON COLUMN projects.inbox_phase_id IS
  'The Project''s inbox phase (card b13e5ac9, Charter v5 §6.1). A Task created without an explicit phaseId lands here; one that lands here without an explicit status is created as Ideas. NULL = no inbox phase: creation behaves as it did before 141. Bound to this Project by projects_inbox_phase_fk; never seeded by a migration.';
