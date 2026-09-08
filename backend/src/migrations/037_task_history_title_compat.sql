-- Migration 037: restore task_history.task_title for older DEV/PRD databases
-- Some live databases were created before task_title existed, but newer code
-- expects the column for dashboard activity feed inserts/selects.

ALTER TABLE task_history
  ADD COLUMN IF NOT EXISTS task_title VARCHAR(500);

UPDATE task_history th
SET task_title = t.title
FROM tasks t
WHERE th.task_title IS NULL
  AND t.id = th.task_id;
