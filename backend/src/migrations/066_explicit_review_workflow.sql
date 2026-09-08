-- RelayHall canonical review workflow.
--
-- Task status `review` already exists in the historical schema. This forward
-- migration makes the subtask vocabulary owner-facing and unambiguous by
-- replacing the legacy `blocked` value with `stuck`, while retaining
-- blocked_reason as the explanatory field. Existing history and identifiers
-- remain intact.

UPDATE subtasks
SET status = 'stuck', updated_at = COALESCE(updated_at, NOW())
WHERE status = 'blocked';

ALTER TABLE subtasks
  DROP CONSTRAINT IF EXISTS subtasks_status_check;

ALTER TABLE subtasks
  ADD CONSTRAINT subtasks_status_check
  CHECK (status IN ('empty', 'in_progress', 'review', 'completed', 'stuck', 'skipped'));
