-- RH-AZ.PROJ-a (card b363a38c) — Task inherits Project visibility.
--
-- Owner ruling 44ee41f2 made Project visibility inherited by default and made
-- restriction an EXPLICIT exceptional policy, never a side effect of adding a
-- grant. Migration 085 gave the Phase that policy. This migration gives the
-- Task the same one, on the same terms, because the owner's 2026-09-02 ruling
-- (run packet 16896595 §3 decision 3) chose UNION semantics: a Task is visible
-- if its OWN visibility allows OR the live Task -> Phase -> Project chain
-- allows. `restricted_access` is the per-Task opt-out of the INHERITED arm —
-- exactly the word 085 ratified, with exactly 085's meaning. A Task's own
-- `visibility` is an explicit act by its owner and is never suppressed by it.
--
-- `tasks` is a HOT table (5s updater). Migration 063 prescribes the shape for
-- it: add the column BARE, and express any constraint as NOT VALID + VALIDATE.
-- A bare boolean with a DEFAULT FALSE takes no table rewrite on PostgreSQL 11+
-- and no long-held lock, so no separate VALIDATE step is owed here.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS restricted_access BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS task_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  actor_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  previous_restricted BOOLEAN NOT NULL,
  restricted BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (previous_restricted <> restricted)
);

CREATE INDEX IF NOT EXISTS ix_task_access_events_task_time
  ON task_access_events(task_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION ledger_task_access_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_id UUID;
  change_reason TEXT;
BEGIN
  IF NEW.restricted_access IS NOT DISTINCT FROM OLD.restricted_access THEN
    RETURN NEW;
  END IF;
  actor_id := NULLIF(current_setting('relayhall.task_access_actor', TRUE), '')::UUID;
  change_reason := NULLIF(current_setting('relayhall.task_access_reason', TRUE), '');
  IF actor_id IS NULL OR change_reason IS NULL THEN
    RAISE EXCEPTION 'Task restricted-access changes require attributed audit context';
  END IF;
  INSERT INTO task_access_events
    (task_id, actor_principal_id, previous_restricted, restricted, reason)
  VALUES (NEW.id, actor_id, OLD.restricted_access, NEW.restricted_access, change_reason);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tasks_restricted_access_ledger ON tasks;
CREATE TRIGGER tasks_restricted_access_ledger
BEFORE UPDATE OF restricted_access ON tasks
FOR EACH ROW EXECUTE FUNCTION ledger_task_access_change();

CREATE OR REPLACE FUNCTION reject_task_access_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_access_events is append-only';
END $$;

DROP TRIGGER IF EXISTS task_access_events_append_only ON task_access_events;
CREATE TRIGGER task_access_events_append_only
BEFORE UPDATE OR DELETE ON task_access_events
FOR EACH ROW EXECUTE FUNCTION reject_task_access_event_mutation();

COMMENT ON COLUMN tasks.restricted_access IS
  'Explicit exceptional confidentiality/blind-test mode. FALSE inherits Project visibility through the Task-Phase-Project chain. The Task own visibility column is unaffected by it, and grants are always additive and never toggle this field.';
COMMENT ON TABLE tasks IS
  'The unit of work. Its own visibility column is an explicit act by its owner; in addition a Task inherits the visibility of the LIVE Project it belongs to, through its Phase, unless that Phase or the Task itself carries restricted_access (owner ruling 44ee41f2, run packet 16896595 decision 3).';
COMMENT ON TABLE task_access_events IS
  'Append-only attribution ledger for privileged Task restricted-access changes (owner ruling 44ee41f2, run packet 16896595 decision 3).';
