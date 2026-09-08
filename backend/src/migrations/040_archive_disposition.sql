-- Migration 040: archive disposition for dependency referential integrity (task af900dd2)
--
-- Records WHY a task ended up archived:
--   'completed' - the work was actually done (task was completed at archive
--                 time, or every subtask ended completed/skipped)
--   'abandoned' - archived without the work being finished
--
-- Dependency semantics (single source of truth: dependencyBlocks() /
-- dependencySatisfied() in backend/src/services/TaskManagerDB.ts):
--   * a dependency SATISFIES when completed, or archived with
--     archive_disposition = 'completed'
--   * archived-abandoned or missing dependencies do NOT block; they are
--     surfaced by `clawboard doctor` instead.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS archive_disposition TEXT
  CHECK (archive_disposition IS NULL OR archive_disposition IN ('completed', 'abandoned'));

-- Backfill existing archived rows with the same heuristic the backend applies
-- at archive time (computeArchiveDisposition): completed_at set => the task
-- reached completed before archiving; otherwise all subtasks done counts too.
UPDATE tasks t
SET archive_disposition = CASE
  WHEN t.completed_at IS NOT NULL THEN 'completed'
  WHEN EXISTS (SELECT 1 FROM subtasks s WHERE s.task_id = t.id)
   AND NOT EXISTS (
     SELECT 1 FROM subtasks s
     WHERE s.task_id = t.id
       AND s.status NOT IN ('completed', 'skipped')
   ) THEN 'completed'
  ELSE 'abandoned'
END
WHERE t.status = 'archived'
  AND t.archive_disposition IS NULL;
