-- RelayHall unified lifecycle state tokens (task 9e434871, RH-VOCAB.6, D-12).
--
-- One shared kebab-case state vocabulary for tasks and subtasks: the subtask
-- spelling `in_progress` becomes `in-progress`, matching the task vocabulary
-- that has always been kebab-case. The request-only `blocked` alias for
-- `stuck` is removed at the API surface in the same change; stored `blocked`
-- values were already converted by migration 066.
--
-- Following the 066 precedent, existing history rows are left byte-intact:
-- task_history.old_value/new_value and task_timeline_events metadata keep any
-- historical `in_progress` (and pre-066 `blocked`) strings as a faithful
-- record of what happened at the time.
--
-- The per-object subsets of the ratified lifecycle matrix (b94dd86e §4.1)
-- land here per amendment A11 (owner-ruled 2026-08-08, options record in
-- report 7bdb51c0): Projects tighten to active·archived with the declared
-- data mapping (A11.1), and Reports gain the status column that represents
-- archived per §4.4 — distinct from the deleted_at soft-delete tombstone
-- (A11.2). Phase has no storage yet, so the Phase subset binds nothing here.

UPDATE subtasks
SET status = 'in-progress', updated_at = COALESCE(updated_at, NOW())
WHERE status = 'in_progress';

ALTER TABLE subtasks
  DROP CONSTRAINT IF EXISTS subtasks_status_check;

ALTER TABLE subtasks
  ADD CONSTRAINT subtasks_status_check
  CHECK (status IN ('empty', 'in-progress', 'review', 'completed', 'stuck', 'skipped'));

-- A11.1: Project subset. paused is not finished, so it stays visible;
-- completed is finished and filed. History rows keep the old words.
UPDATE projects SET status = 'active', updated_at = COALESCE(updated_at, NOW())
WHERE status = 'paused';

UPDATE projects SET status = 'archived', updated_at = COALESCE(updated_at, NOW())
WHERE status = 'completed';

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_status_check
  CHECK (status IN ('active', 'archived'));

-- A11.2: Report archived-representation. Archived reports are read-only,
-- excluded from default lists and still linkable; deleted_at remains the
-- separate soft-delete tombstone from migration 060.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

ALTER TABLE reports
  DROP CONSTRAINT IF EXISTS reports_status_check;

ALTER TABLE reports
  ADD CONSTRAINT reports_status_check
  CHECK (status IN ('active', 'archived'));
