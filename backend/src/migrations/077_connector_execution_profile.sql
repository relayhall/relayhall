-- 077_connector_execution_profile.sql
-- RH-P2.2 (task a44b9b06): connector-first execution profiles (vocabulary
-- D-15; strategy §2.1; RH-DESIGN.5 R5).
--
-- An execution profile names a Connector and carries ONLY options that
-- Connector declared in its pinned capability-descriptor version. The pin
-- gets typed columns for referential integrity; the connector-owned option
-- values live in the existing execution_profile JSONB, which the board
-- validates against the pinned descriptor but never interprets (§2.1).
--
-- Deliberately NOT rewritten: existing execution_profile values (the legacy
-- mode/harness/accessProfile shape). Stored legacy bytes are held, reported
-- and never dropped (the house compatibility rule); reads surface them as a
-- separate legacy view and the orchestration-lease harness binding keeps
-- reading them until the RH-P3.1 pickup protocol replaces that contract.
--
-- ON DELETE RESTRICT: a Service that tasks still pin cannot be hard-deleted
-- (§4.4 makes delete the restricted, never-routine path; retirement is the
-- ordinary end of life and leaves pins resolving per R5).
--
-- Fresh-replay doctrine: database/init.sql is untouched; this file is
-- idempotent (IF NOT EXISTS / IF EXISTS guards) so re-running it is a no-op.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS execution_service_id UUID REFERENCES services(id) ON DELETE RESTRICT;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS execution_descriptor_version INTEGER CHECK (
    execution_descriptor_version IS NULL OR execution_descriptor_version >= 1
  );

CREATE INDEX IF NOT EXISTS idx_tasks_execution_service
  ON tasks(execution_service_id) WHERE execution_service_id IS NOT NULL;

COMMENT ON COLUMN tasks.execution_service_id IS
  'Connector-first execution profile (RH-P2.2, D-15): the registered Service this task''s profile targets. NULL = basic profile (model/thinking only) or legacy-only blob.';
COMMENT ON COLUMN tasks.execution_descriptor_version IS
  'The immutable capability-descriptor version the profile options were validated against (§2.1 pinning; retired pins fail dispatch closed per RH-DESIGN.5 R5).';
